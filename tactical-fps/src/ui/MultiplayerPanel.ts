import { NetError, NetSession, listRooms, relayAvailable } from '../net/NetSession';
import { NAME_MAX, cleanName, mpErrorMessage, validCode, type RoomInfo, type RoomMode, type RoomSummary } from '../net/Protocol';
import type { LobbyRoomSource } from './Lobby';
import type { MainMenu } from './MainMenu';
import './mp.css';

const NAME_KEY = 'tactical-fps.mp.name';
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
  startMultiplayer(session: NetSession): Promise<void>;
  leaveMultiplayer(reason?: 'closed' | 'left'): void;
  onNetRoom: ((room: RoomInfo) => void) | null;
  onNetEnded: ((reason: 'closed' | 'left') => void) | null;
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
        <p class="field-hint">봇을 허용한 방은 빈 자리를 봇이 채웁니다(새 방을 만들 때의 설정, 빠른 참가로 들어간 방은 그 방의 설정). 방장의 브라우저가 경기를 진행하며, 방장이 나가면 다른 사람이 이어받고 경기는 새로 시작합니다. 맵은 방장이 고른 맵입니다.</p>
      </div>
      <div class="mp-room" hidden>
        <div class="mp-room-head">
          <div><span class="field-label">방 코드</span> <b class="mp-room-code"></b></div>
          <div class="mp-room-mode muted"></div>
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
      this.showRoom(null);
      if (reason === 'closed') {
        // The relay dropped (server restart, network): the room may still be there with the others.
        this.session = null;
        const msg = `${mpErrorMessage('closed')} 싱글플레이로 돌아왔습니다.`;
        this.error(msg);
        this.offerRejoin();
        this.tell(msg);
      }
    };
    menu.onPageShown((page) => {
      if (page === 'multi') {
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
    return `<li class="mp-room-row">
      <b class="mp-room-row-code">${escape(r.code)}</b>
      <span class="mp-room-row-info">${MODE_LABEL[r.mode]} · ${escape(this.game.mapNameOf(r.map))}${r.mode !== 'duel' && r.bots === false ? ' · 봇 없음' : ''}</span>
      <span class="mp-room-row-count${full ? ' full' : ''}">${r.players}/${r.capacity}명</span>
      <button type="button" class="btn mp-room-join" data-code="${escape(r.code)}"${full ? ' disabled' : ''}>${full ? '가득 참' : '참가'}</button>
    </li>`;
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
    this.setBusy(true, '연결 중…');
    try {
      const s = this.session ?? new NetSession();
      this.session = s;
      if (!s.connected) await s.connect(name);
      const room = how === 'quick' ? await s.quick(mode, this.game.mapId, bots) : how === 'create' ? await s.create(mode, this.game.mapId, bots) : await s.join(code!);
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
      if (this.session && !this.session.room) {
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
      this.showBots(room, room.hostId === me);
      this.q('.mp-members').innerHTML = room.members
        .map((m) => {
          const team = room.mode === 'team' || room.mode === 'duel' ? this.game.teamOf(m.id) : null;
          return `<li class="${m.id === me ? 'me' : ''}"${team ? ` data-team="${team}"` : ''}>${team ? `<span class="mp-team ${team}">${TEAM_LABEL[team]}</span> ` : ''}${escape(m.name)}${m.id === room.hostId ? ' <span class="mp-host">방장</span>' : ''}${m.id === me ? ' <span class="muted">(나)</span>' : ''}</li>`;
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
  }

  private error(msg: string): void {
    this.q('.mp-error').textContent = msg;
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
