import { NetError, NetSession, listRooms, relayAvailable } from '../net/NetSession';
import {
  NAME_MAX,
  PARTY_CODE_LENGTH,
  PARTY_MAX,
  PLATFORM_LABEL,
  POOL_LABEL,
  cleanName,
  groupPool,
  mpErrorMessage,
  poolAllows,
  validCode,
  validPartyCode,
  type MatchPool,
  type MemberInfo,
  type PartyInfo,
  type Platform,
  type RoomInfo,
  type RoomMode,
  type RoomSummary,
} from '../net/Protocol';
import type { LobbyRoomSource } from './Lobby';
import type { MainMenu } from './MainMenu';
import './mp.css';

const NAME_KEY = 'tactical-fps.mp.name';
/** The matching pool last chosen (Phase 28), kept on this browser. */
const POOL_KEY = 'tactical-fps.mp.pool';
/** A relay that did not answer is asked once more after this long. */
const RECHECK_MS = 5000;
const MODE_LABEL: Record<RoomMode, string> = { deathmatch: '데스매치 (개인전)', team: '5대5 라운드전 (팀전)', duel: '1대1 대전 (2명)' };
const TEAM_LABEL = { blue: 'BLUE', red: 'RED' } as const;

/** What the lobby needs from the game. */
export interface MultiplayerGame {
  readonly mapId: string;
  readonly mapName: string;
  /** Display name of a map id (room list). */
  mapNameOf(id: string): string;
  /** Team match: the team a room member plays (null: not known yet / deathmatch). */
  teamOf(memberId: string): 'blue' | 'red' | null;
  /** The host's match is under way (changing the bot setting restarts it: asked first). */
  readonly netMatchInProgress: boolean;
  /** The platform this player plays on now (the controls in use: touch = mobile). */
  readonly platform: Platform;
  /** Called when the controls change between PC and touch (set by this panel). */
  onPlatformChange: (() => void) | null;
  startMultiplayer(session: NetSession): Promise<void>;
  /** 'moved': the party leader took this player into another room (the relay already moved it: nothing is sent). */
  leaveMultiplayer(reason?: 'closed' | 'left' | 'moved'): void;
  onNetRoom: ((room: RoomInfo) => void) | null;
  onNetEnded: ((reason: 'closed' | 'left' | 'moved') => void) | null;
}

/**
 * The 멀티플레이 page: nickname, mode, quick join / new room / join by
 * code / the relay's room list, then the room (code to share, players,
 * host, teams) and leaving it. The match itself starts with the usual 플레이
 * button. The lobby follows the room through onRoomChange / onNotice.
 */
export class MultiplayerPanel implements LobbyRoomSource {
  private readonly el: HTMLElement;
  private session: NetSession | null = null;
  private busy = false;
  private current: RoomInfo | null = null;
  /** The last room's code: offered again when the connection drops. */
  private lastCode: string | null = null;
  private roomListeners: ((room: RoomInfo | null) => void)[] = [];
  private noticeListeners: ((text: string) => void)[] = [];
  private statusListeners: ((ok: boolean) => void)[] = [];
  private checks = 0;
  /** The bot setting the open confirmation would switch to (null: no confirmation open). */
  private confirmFor: boolean | null = null;
  /** A bot setting sent to the relay and not answered yet (the switch waits for the room's answer). */
  private sentBots: boolean | null = null;
  private sentTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    menu: MainMenu,
    private readonly game: MultiplayerGame,
  ) {
    this.el = menu.pageElement('multi');
    this.el.innerHTML = `
      <h2 class="section-title">멀티플레이</h2>
      <p class="page-note mp-server" aria-live="polite">서버 확인 중…</p>
      <div class="mp-lobby">
        <label class="field">
          <span class="field-label">닉네임</span>
          <input class="mp-input mp-name" maxlength="${NAME_MAX}" autocomplete="nickname" spellcheck="false" />
        </label>
        <label class="field">
          <span class="field-label">모드</span>
          <select class="select mp-mode">
            <option value="deathmatch">${MODE_LABEL.deathmatch}</option>
            <option value="team">${MODE_LABEL.team}</option>
            <option value="duel">${MODE_LABEL.duel}</option>
          </select>
        </label>
        <label class="field mp-bots-field">
          <span class="field-label">봇</span>
          <select class="select mp-bots">
            <option value="on">허용 — 빈 자리를 봇이 채움</option>
            <option value="off">비허용 — 사람만</option>
          </select>
        </label>
        <p class="field-hint mp-bots-duel" hidden>1대1은 봇 없이 두 사람만 경기합니다.</p>
        <label class="field">
          <span class="field-label">매칭</span>
          <select class="select mp-pool">
            <option value="mixed">${POOL_LABEL.mixed}</option>
            <option value="mobile">${POOL_LABEL.mobile}</option>
            <option value="pc">${POOL_LABEL.pc}</option>
          </select>
          <span class="field-hint mp-pool-hint"></span>
        </label>
        <div class="mp-party">
          <div class="mp-party-head">
            <span class="field-label">파티</span>
            <span class="mp-platform-me muted"></span>
          </div>
          <div class="mp-party-none">
            <button type="button" class="btn mp-party-create">파티 만들기</button>
            <input class="mp-input mp-party-code" maxlength="${PARTY_CODE_LENGTH}" placeholder="파티 코드" autocomplete="off" spellcheck="false" aria-label="파티 코드" />
            <button type="button" class="btn mp-party-join">파티 참가</button>
          </div>
          <div class="mp-party-in" hidden>
            <div><span class="field-label">파티 코드</span> <b class="mp-party-code-shown"></b> <span class="mp-party-count muted"></span></div>
            <ol class="mp-party-members"></ol>
            <p class="field-hint mp-party-note"></p>
            <button type="button" class="btn mp-party-leave">파티 나가기</button>
          </div>
        </div>
        <div class="mp-actions">
          <button type="button" class="btn btn-primary mp-quick">빠른 참가</button>
          <button type="button" class="btn mp-create">방 만들기</button>
        </div>
        <div class="mp-join">
          <input class="mp-input mp-code" maxlength="5" placeholder="방 코드" autocomplete="off" spellcheck="false" aria-label="방 코드" />
          <button type="button" class="btn mp-join-btn">코드로 참가</button>
        </div>
        <div class="mp-list">
          <div class="mp-list-head">
            <span class="field-label">방 목록</span>
            <button type="button" class="btn mp-refresh">새로고침</button>
          </div>
          <ul class="mp-rooms"></ul>
          <p class="field-hint mp-list-note"></p>
        </div>
        <p class="field-hint">매칭: 기본은 PC와 모바일이 함께하는 통합 매칭이고, 모바일 전용 · PC 전용을 고를 수 있습니다(플랫폼은 지금 쓰는 조작 방식: 터치 = 모바일). 전용 방에는 방 코드로도 다른 플랫폼이 들어갈 수 없습니다. 파티는 파티장이 방을 고르면 모두 함께 들어가고, PC와 모바일이 섞인 파티는 통합 매칭으로 들어갑니다. 무기 피해·체력·연사·판정·가격·이동은 플랫폼과 관계없이 같습니다.</p>
        <p class="field-hint">봇을 허용한 방은 빈 자리를 봇이 채웁니다(새 방을 만들 때의 설정, 빠른 참가로 들어간 방은 그 방의 설정). 방장의 브라우저가 경기를 진행하며, 방장이 나가면 다른 사람이 이어받고 경기는 새로 시작합니다. 맵은 방장이 고른 맵입니다.</p>
      </div>
      <div class="mp-room" hidden>
        <div class="mp-room-head">
          <div><span class="field-label">방 코드</span> <b class="mp-room-code"></b></div>
          <div class="mp-room-mode muted"></div>
          <div class="mp-room-pool muted"></div>
        </div>
        <div class="mp-room-bots">
          <span class="mp-room-bots-text"></span>
          <button type="button" class="btn mp-bots-toggle" hidden></button>
        </div>
        <div class="mp-confirm" role="alertdialog" aria-labelledby="mp-confirm-text" hidden>
          <p class="mp-confirm-text" id="mp-confirm-text"></p>
          <div class="mp-confirm-actions">
            <button type="button" class="btn mp-confirm-cancel">취소</button>
            <button type="button" class="btn btn-primary mp-confirm-ok">확인 — 다시 시작</button>
          </div>
        </div>
        <ol class="mp-members"></ol>
        <p class="field-hint mp-room-hint">아래 플레이 버튼으로 경기에 들어갑니다. 친구에게 방 코드를 알려 주세요.</p>
        <button type="button" class="btn mp-leave">방 나가기</button>
      </div>
      <p class="mp-error" role="alert"></p>
      <button type="button" class="btn mp-rejoin" hidden></button>`;
    const nameInput = this.q<HTMLInputElement>('.mp-name');
    try {
      nameInput.value = localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      /* storage blocked */
    }
    const pool = this.q<HTMLSelectElement>('.mp-pool');
    try {
      const saved = localStorage.getItem(POOL_KEY);
      if (saved === 'mixed' || saved === 'pc' || saved === 'mobile') pool.value = saved;
    } catch {
      /* storage blocked */
    }
    pool.addEventListener('change', () => {
      try {
        localStorage.setItem(POOL_KEY, pool.value);
      } catch {
        /* storage blocked */
      }
      this.syncPool();
    });
    this.q('.mp-party-create').addEventListener('click', () => void this.party('create'));
    this.q('.mp-party-join').addEventListener('click', () => void this.party('join'));
    this.q('.mp-party-code').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e as KeyboardEvent).key === 'Enter') void this.party('join');
    });
    this.q('.mp-party-leave').addEventListener('click', () => this.session?.leaveParty());
    game.onPlatformChange = () => {
      // Outside a room the relay hears the new platform now (the party's view follows); in a room it counts from the next one.
      this.session?.setPlatform(game.platform);
      this.syncPool();
    };
    this.q('.mp-quick').addEventListener('click', () => void this.enter('quick'));
    this.q('.mp-create').addEventListener('click', () => void this.enter('create'));
    this.q('.mp-join-btn').addEventListener('click', () => void this.enter('join'));
    this.q('.mp-code').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e as KeyboardEvent).key === 'Enter') void this.enter('join');
    });
    nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    this.q('.mp-leave').addEventListener('click', () => this.leave());
    this.q('.mp-mode').addEventListener('change', () => this.syncBotsField());
    this.syncBotsField();
    // Host only (the relay refuses anyone else): the room's answer updates the view. During a match the
    // change starts it over, so it is asked first; one question at a time, one request at a time.
    this.q('.mp-bots-toggle').addEventListener('click', () => {
      const room = this.current;
      if (!this.canSwitchBots(room) || this.confirmFor !== null || this.sentBots !== null) return;
      const want = room!.bots === false;
      if (this.game.netMatchInProgress) this.openConfirm(want);
      else this.sendBots(want);
    });
    this.q('.mp-confirm-ok').addEventListener('click', () => {
      const want = this.confirmFor;
      this.closeConfirm();
      if (want === null || !this.canSwitchBots(this.current) || (this.current!.bots !== false) === want) return;
      this.sendBots(want);
    });
    this.q('.mp-confirm-cancel').addEventListener('click', () => this.closeConfirm());
    this.q('.mp-confirm').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e as KeyboardEvent).key === 'Escape') this.closeConfirm();
    });
    this.q('.mp-refresh').addEventListener('click', () => void this.refreshRooms());
    this.q('.mp-rooms').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.mp-room-join');
      if (b?.dataset.code) void this.enter('join', b.dataset.code);
    });
    this.q('.mp-rejoin').addEventListener('click', () => {
      if (this.lastCode) void this.enter('join', this.lastCode);
    });
    game.onNetRoom = (room) => this.showRoom(room);
    game.onNetEnded = (reason) => {
      // Moved by the party leader: the next room is on its way (onPulled).
      if (reason === 'moved') return;
      this.showRoom(null);
      if (reason === 'closed') {
        // The relay dropped (server restart, network): the room may still be there with the others.
        this.session = null;
        this.showParty(null);
        const msg = `${mpErrorMessage('closed')} 싱글플레이로 돌아왔습니다.`;
        this.error(msg);
        this.offerRejoin();
        this.tell(msg);
      }
    };
    this.syncPool();
    menu.onPageShown((page) => {
      if (page === 'multi') {
        this.syncPool();
        void this.checkServer();
        if (!this.current) void this.refreshRooms();
      }
    });
  }

  get room(): RoomInfo | null {
    return this.current;
  }

  onRoomChange(listener: (room: RoomInfo | null) => void): void {
    this.roomListeners.push(listener);
  }

  onNotice(listener: (text: string) => void): void {
    this.noticeListeners.push(listener);
  }

  /** Leaves the room (back to single player; the connection stays for the next room). */
  leave(): void {
    this.lastCode = null;
    this.offerRejoin();
    this.game.leaveMultiplayer('left');
  }

  private tell(text: string): void {
    for (const l of this.noticeListeners) l(text);
  }

  private offerRejoin(): void {
    const b = this.q<HTMLButtonElement>('.mp-rejoin');
    b.hidden = !this.lastCode || !!this.current;
    b.textContent = this.lastCode ? `같은 방(${this.lastCode})에 다시 참가` : '';
  }

  /** The relay's rooms, with a 참가 button each (a full room: none). */
  private async refreshRooms(): Promise<void> {
    const list = this.q('.mp-rooms');
    const note = this.q('.mp-list-note');
    const refresh = this.q<HTMLButtonElement>('.mp-refresh');
    refresh.disabled = true;
    note.textContent = '방 목록 불러오는 중…';
    const rooms = await listRooms();
    refresh.disabled = false;
    if (!rooms) {
      list.replaceChildren();
      note.textContent = '방 목록을 받지 못했습니다 (서버 응답 없음, 또는 방 목록을 지원하지 않는 서버). 빠른 참가와 코드 참가는 그대로 쓸 수 있습니다.';
      return;
    }
    note.textContent = rooms.length ? '' : '열린 방이 없습니다. 방을 만들거나 빠른 참가를 누르세요.';
    list.innerHTML = rooms.map((r) => this.roomRow(r)).join('');
  }

  private roomRow(r: RoomSummary): string {
    const full = r.players >= r.capacity;
    const pool = r.pool ?? 'mixed';
    // A PC / mobile only room the group (this player, or its whole party) cannot enter: no join button.
    const shut = !this.groupPlatforms().every((p) => poolAllows(pool, p));
    const label = full ? '가득 참' : shut ? `${pool === 'pc' ? 'PC' : '모바일'} 전용` : '참가';
    return `<li class="mp-room-row" data-pool="${pool}">
      <b class="mp-room-row-code">${escape(r.code)}</b>
      <span class="mp-room-row-info">${MODE_LABEL[r.mode]} · ${escape(this.game.mapNameOf(r.map))}${r.mode !== 'duel' && r.bots === false ? ' · 봇 없음' : ''}</span>
      <span class="mp-room-row-pool">${POOL_LABEL[pool]}</span>
      <span class="mp-room-row-count${full ? ' full' : ''}">${r.players}/${r.capacity}명</span>
      <button type="button" class="btn mp-room-join" data-code="${escape(r.code)}"${full || shut ? ' disabled' : ''}>${label}</button>
    </li>`;
  }

  /** The platforms that would go into a room: this player's, or its whole party's. */
  private groupPlatforms(): Platform[] {
    const p = this.session?.party;
    if (p) return p.members.map((m) => (m.id === this.session?.id ? this.game.platform : (m.platform ?? 'pc')));
    return [this.game.platform];
  }

  /** The pool chosen, and what the group will really get (a mixed party: always mixed; a pool not for this platform: refused). */
  private syncPool(): void {
    const sel = this.q<HTMLSelectElement>('.mp-pool');
    const want = sel.value as MatchPool;
    const platforms = this.groupPlatforms();
    const got = groupPool(want, platforms);
    const hint = this.q('.mp-pool-hint');
    const me = this.game.platform;
    this.q('.mp-platform-me').textContent = `내 플랫폼: ${PLATFORM_LABEL[me]}`;
    if (new Set(platforms).size > 1) hint.textContent = 'PC와 모바일이 함께 있는 파티: 통합 매칭으로 들어갑니다.';
    else if (!got) hint.textContent = `${PLATFORM_LABEL[me]} 조작으로는 ${POOL_LABEL[want]} 매칭에 들어갈 수 없습니다. 통합 매칭을 고르거나 조작 방식을 바꾸세요.`;
    else hint.textContent = want === 'mixed' ? 'PC와 모바일 플레이어가 함께 매칭됩니다.' : `${PLATFORM_LABEL[me]} 플레이어끼리만 매칭됩니다.`;
    hint.classList.toggle('warn', !got);
  }

  /** Forms a party or joins one by its code (a connection to the relay first). */
  private async party(how: 'create' | 'join'): Promise<void> {
    if (this.busy) return;
    this.error('');
    const name = cleanName(this.q<HTMLInputElement>('.mp-name').value);
    if (!name) return this.error(mpErrorMessage('name'));
    const code = how === 'join' ? validPartyCode(this.q<HTMLInputElement>('.mp-party-code').value) : null;
    if (how === 'join' && !code) return this.error(`파티 코드는 ${PARTY_CODE_LENGTH}자입니다 (영문·숫자).`);
    this.setBusy(true, '연결 중…');
    try {
      const s = await this.connected(name);
      const party = how === 'create' ? await s.createParty() : await s.joinParty(code!);
      this.showParty(party);
    } catch (err) {
      this.error(mpErrorMessage(err instanceof NetError ? err.code : 'network'));
    } finally {
      this.setBusy(false);
      this.showParty(this.session?.party ?? null);
    }
  }

  /** The session, connected and signed in (with this player's platform), the party and pull hooks set. */
  private async connected(name: string): Promise<NetSession> {
    const s = this.session ?? new NetSession();
    this.session = s;
    s.onParty = (party) => this.showParty(party);
    s.onPulled = (room) => void this.pulled(room);
    if (!s.connected) await s.connect(name, undefined, undefined, this.game.platform);
    else s.setPlatform(this.game.platform);
    return s;
  }

  /** The party leader took this player into a room: into the match there (out of the one it was in first). */
  private async pulled(room: RoomInfo): Promise<void> {
    const s = this.session;
    if (!s) return;
    if (this.current) this.game.leaveMultiplayer('moved');
    this.showRoom(room);
    this.tell(`파티장과 함께 방 ${room.code}에 들어갔습니다.`);
    await this.game.startMultiplayer(s);
  }

  private showParty(party: PartyInfo | null): void {
    const me = this.session?.id;
    this.q('.mp-party-none').hidden = !!party;
    this.q('.mp-party-in').hidden = !party;
    const leader = !party || party.leaderId === me;
    // In a party only the leader picks the room.
    for (const sel of ['.mp-quick', '.mp-create', '.mp-join-btn']) this.q<HTMLButtonElement>(sel).disabled = this.busy || !leader;
    if (party) {
      this.q('.mp-party-code-shown').textContent = party.code;
      this.q('.mp-party-count').textContent = `${party.members.length}/${PARTY_MAX}명`;
      this.q('.mp-party-members').innerHTML = party.members.map((m) => memberRow(m, party.leaderId, me, '파티장')).join('');
      this.q('.mp-party-note').textContent = leader
        ? '파티장입니다. 빠른 참가 · 방 만들기 · 코드 참가를 누르면 파티 전원이 함께 들어갑니다.'
        : '파티장이 방을 고르면 함께 들어갑니다 (방 선택은 파티장만).';
    }
    this.syncPool();
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.el.querySelector<T>(sel)!;
  }

  onServerStatus(listener: (ok: boolean) => void): void {
    this.statusListeners.push(listener);
  }

  /** Is the relay up? Shown on this page and (through onServerStatus) in the lobby. */
  async checkServer(retry = true): Promise<void> {
    if (this.session?.room || this.busy) return;
    const line = this.q('.mp-server');
    line.textContent = '서버 확인 중…';
    // Checks can overlap (lobby at start, this page when opened): only the latest one's answer counts.
    const seq = ++this.checks;
    const ok = await relayAvailable(8000);
    if (seq !== this.checks || this.busy) return;
    // No answer can be a busy moment (a slow machine, a waking free server): ask once more shortly.
    if (!ok && retry)
      setTimeout(() => {
        if (seq === this.checks) void this.checkServer(false);
      }, RECHECK_MS);
    for (const l of this.statusListeners) l(ok);
    line.textContent = ok ? '멀티플레이 서버 연결 가능' : '서버 응답 없음 — 무료 서버는 깨어나는 데 1분 정도 걸릴 수 있습니다. 참가를 누르면 기다렸다가 연결합니다.';
    line.classList.toggle('ok', ok);
  }

  private async enter(how: 'quick' | 'create' | 'join', codeArg?: string): Promise<void> {
    if (this.busy) return;
    this.error('');
    const name = cleanName(this.q<HTMLInputElement>('.mp-name').value);
    if (!name) return this.error(mpErrorMessage('name'));
    const code = how === 'join' ? validCode(codeArg ?? this.q<HTMLInputElement>('.mp-code').value) : null;
    if (how === 'join' && !code) return this.error('방 코드는 5자입니다 (영문·숫자).');
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      /* storage blocked */
    }
    const mode = this.q<HTMLSelectElement>('.mp-mode').value as RoomMode;
    const bots = mode !== 'duel' && this.q<HTMLSelectElement>('.mp-bots').value !== 'off';
    const pool = this.q<HTMLSelectElement>('.mp-pool').value as MatchPool;
    this.setBusy(true, '연결 중…');
    try {
      const s = await this.connected(name);
      const room = how === 'quick' ? await s.quick(mode, this.game.mapId, bots, pool) : how === 'create' ? await s.create(mode, this.game.mapId, bots, pool) : await s.join(code!);
      this.showRoom(room);
      this.q('.mp-server').textContent = '멀티플레이 서버에 연결됨';
      await this.game.startMultiplayer(s);
    } catch (err) {
      const code = err instanceof NetError ? err.code : 'network';
      this.error(mpErrorMessage(code));
      if (code === 'not_found' && how === 'join' && codeArg === this.lastCode) {
        this.lastCode = null;
        this.offerRejoin();
      }
      if (code === 'not_found' || code === 'full') void this.refreshRooms();
      // No room and no party to keep the connection for: closed.
      if (this.session && !this.session.room && !this.session.party) {
        this.session.close();
        this.session = null;
      }
    } finally {
      this.setBusy(false);
    }
  }

  private showRoom(room: RoomInfo | null): void {
    const before = this.current;
    // An answer to the request in flight, or another room / no room: nothing is waited for any more.
    if (this.sentBots !== null && (!room || room.code !== before?.code || (room.bots !== false) === this.sentBots)) this.settleBots();
    // The question no longer applies: not the host now, out of the room, or the setting already is what was asked.
    if (this.confirmFor !== null && (!this.canSwitchBots(room) || room!.code !== before?.code || (room!.bots !== false) === this.confirmFor)) this.closeConfirm();
    this.current = room ? { ...room, members: [...room.members] } : null;
    const inRoom = !!room;
    this.q('.mp-lobby').hidden = inRoom;
    this.q('.mp-room').hidden = !inRoom;
    if (room) {
      this.lastCode = room.code;
      this.error('');
      const me = this.session?.id;
      // The previous host left: someone else runs the match now, and it starts over.
      if (before && before.code === room.code && before.hostId !== room.hostId) {
        const host = room.members.find((m) => m.id === room.hostId);
        this.tell(`방장이 나가 ${host?.id === me ? '내가' : `${host?.name ?? '다른 사람'}님이`} 방장이 되었습니다. 경기가 처음부터 다시 시작됩니다.`);
      }
      this.q('.mp-room-code').textContent = room.code;
      this.q('.mp-room-mode').textContent = `${MODE_LABEL[room.mode]} · ${this.game.mapName} · ${room.members.length}/${room.capacity}명`;
      const pcs = room.members.filter((m) => m.platform === 'pc').length;
      const phones = room.members.filter((m) => m.platform === 'mobile').length;
      this.q('.mp-room-pool').textContent = `매칭: ${POOL_LABEL[room.pool ?? 'mixed']} · PC ${pcs} · 모바일 ${phones}`;
      this.showBots(room, room.hostId === me);
      this.q('.mp-members').innerHTML = room.members
        .map((m) => {
          const team = room.mode === 'team' || room.mode === 'duel' ? this.game.teamOf(m.id) : null;
          return `<li class="${m.id === me ? 'me' : ''}"${team ? ` data-team="${team}"` : ''} data-platform="${m.platform ?? ''}">${team ? `<span class="mp-team ${team}">${TEAM_LABEL[team]}</span> ` : ''}${escape(m.name)}${platformBadge(m)}${m.id === room.hostId ? ' <span class="mp-host">방장</span>' : ''}${m.id === me ? ' <span class="muted">(나)</span>' : ''}</li>`;
        })
        .join('');
    }
    this.offerRejoin();
    for (const l of this.roomListeners) l(this.current);
  }

  /** This player hosts `room`, a deathmatch / team room: the bot setting is its to change. */
  private canSwitchBots(room: RoomInfo | null): boolean {
    return !!room && !!this.session && room.hostId === this.session.id && room.mode !== 'duel';
  }

  /** Asks before restarting the match: 확인 switches (and restarts), 취소 leaves the setting and the match as they are. */
  private openConfirm(want: boolean): void {
    this.confirmFor = want;
    this.q('.mp-confirm-text').textContent = want
      ? '경기 중입니다. 봇을 켜면 빈 자리를 봇이 채우고 경기가 처음부터 다시 시작됩니다. 바꿀까요?'
      : '경기 중입니다. 봇을 끄면 빈 자리의 봇이 빠지고 경기가 처음부터 다시 시작됩니다. 바꿀까요?';
    this.q('.mp-confirm').hidden = false;
    this.q<HTMLButtonElement>('.mp-bots-toggle').disabled = true;
    this.q<HTMLButtonElement>('.mp-confirm-cancel').focus();
  }

  private closeConfirm(): void {
    this.confirmFor = null;
    this.q('.mp-confirm').hidden = true;
    this.q<HTMLButtonElement>('.mp-bots-toggle').disabled = this.sentBots !== null;
  }

  /** One request to the relay; the switch stays off until the room comes back with it (or a few seconds pass). */
  private sendBots(want: boolean): void {
    const s = this.session;
    if (!s) return;
    this.sentBots = want;
    this.q<HTMLButtonElement>('.mp-bots-toggle').disabled = true;
    if (this.sentTimer) clearTimeout(this.sentTimer);
    this.sentTimer = setTimeout(() => this.settleBots(), 5000);
    s.setBots(want);
  }

  /** The relay answered (or never will): the switch is usable again. */
  private settleBots(): void {
    this.sentBots = null;
    if (this.sentTimer) clearTimeout(this.sentTimer);
    this.sentTimer = null;
    this.q<HTMLButtonElement>('.mp-bots-toggle').disabled = this.confirmFor !== null;
  }

  /** The bot choice before entering a room: none for 1대1. */
  private syncBotsField(): void {
    const duel = this.q<HTMLSelectElement>('.mp-mode').value === 'duel';
    this.q('.mp-bots-field').hidden = duel;
    this.q('.mp-bots-duel').hidden = !duel;
  }

  /** The room's bot setting, as the relay has it; the host can switch it (1대1: always none, nothing to switch). */
  private showBots(room: RoomInfo, host: boolean): void {
    const box = this.q('.mp-room-bots');
    const text = this.q('.mp-room-bots-text');
    const toggle = this.q<HTMLButtonElement>('.mp-bots-toggle');
    const on = room.mode !== 'duel' && room.bots !== false;
    box.dataset.bots = room.mode === 'duel' ? 'duel' : on ? 'on' : 'off';
    text.textContent = room.mode === 'duel' ? '봇: 없음 (1대1은 두 사람만)' : on ? '봇: 허용 — 빈 자리를 봇이 채웁니다' : '봇: 비허용 — 사람만 경기합니다';
    toggle.hidden = !host || room.mode === 'duel';
    toggle.textContent = on ? '봇 끄기' : '봇 켜기';
    if (room.mode !== 'duel' && !host) text.textContent += ' (방장만 바꿀 수 있음)';
  }

  private setBusy(on: boolean, note = ''): void {
    this.busy = on;
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.mp-lobby button')) b.disabled = on;
    if (on) this.q('.mp-server').textContent = note;
    // A party member waits for its leader: the room buttons stay off.
    else if (this.session?.party) this.showParty(this.session.party);
  }

  private error(msg: string): void {
    this.q('.mp-error').textContent = msg;
  }
}

function platformBadge(m: MemberInfo): string {
  // After the name (the name stays the text right after the team mark).
  return m.platform ? ` <span class="mp-platform ${m.platform}">${PLATFORM_LABEL[m.platform]}</span>` : '';
}

function memberRow(m: MemberInfo, leaderId: string, me: string | null | undefined, leaderLabel: string): string {
  return `<li class="${m.id === me ? 'me' : ''}" data-platform="${m.platform ?? ''}">${escape(m.name)}${platformBadge(m)}${m.id === leaderId ? ` <span class="mp-host">${leaderLabel}</span>` : ''}${m.id === me ? ' <span class="muted">(나)</span>' : ''}</li>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
