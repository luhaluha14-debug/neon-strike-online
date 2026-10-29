import { NetError, NetSession, listRooms, relayAvailable } from '../net/NetSession';
import { NAME_MAX, cleanName, mpErrorMessage, validCode, type RoomInfo, type RoomMode, type RoomSummary } from '../net/Protocol';
import type { LobbyRoomSource } from './Lobby';
import type { MainMenu } from './MainMenu';
import './mp.css';

const NAME_KEY = 'tactical-fps.mp.name';
const MODE_LABEL: Record<RoomMode, string> = { deathmatch: '데스매치 (개인전)', team: '5대5 라운드전 (팀전)' };
const TEAM_LABEL = { blue: 'BLUE', red: 'RED' } as const;

/** What the lobby needs from the game. */
export interface MultiplayerGame {
  readonly mapId: string;
  readonly mapName: string;
  /** Display name of a map id (room list). */
  mapNameOf(id: string): string;
  /** Team match: the team a room member plays (null: not known yet / deathmatch). */
  teamOf(memberId: string): 'blue' | 'red' | null;
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
          </select>
        </label>
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
        <p class="field-hint">빈 자리는 봇이 채웁니다. 방장의 브라우저가 경기를 진행하며, 방장이 나가면 다른 사람이 이어받고 경기는 새로 시작합니다. 맵은 방장이 고른 맵입니다.</p>
      </div>
      <div class="mp-room" hidden>
        <div class="mp-room-head">
          <div><span class="field-label">방 코드</span> <b class="mp-room-code"></b></div>
          <div class="mp-room-mode muted"></div>
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
      <span class="mp-room-row-info">${MODE_LABEL[r.mode]} · ${escape(this.game.mapNameOf(r.map))}</span>
      <span class="mp-room-row-count${full ? ' full' : ''}">${r.players}/${r.capacity}명</span>
      <button type="button" class="btn mp-room-join" data-code="${escape(r.code)}"${full ? ' disabled' : ''}>${full ? '가득 참' : '참가'}</button>
    </li>`;
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.el.querySelector<T>(sel)!;
  }

  private async checkServer(): Promise<void> {
    if (this.session?.room) return;
    const line = this.q('.mp-server');
    line.textContent = '서버 확인 중…';
    const ok = await relayAvailable();
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
    this.setBusy(true, '연결 중…');
    try {
      const s = this.session ?? new NetSession();
      this.session = s;
      if (!s.connected) await s.connect(name);
      const room = how === 'quick' ? await s.quick(mode, this.game.mapId) : how === 'create' ? await s.create(mode, this.game.mapId) : await s.join(code!);
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
      this.q('.mp-members').innerHTML = room.members
        .map((m) => {
          const team = room.mode === 'team' ? this.game.teamOf(m.id) : null;
          return `<li class="${m.id === me ? 'me' : ''}"${team ? ` data-team="${team}"` : ''}>${team ? `<span class="mp-team ${team}">${TEAM_LABEL[team]}</span> ` : ''}${escape(m.name)}${m.id === room.hostId ? ' <span class="mp-host">방장</span>' : ''}${m.id === me ? ' <span class="muted">(나)</span>' : ''}</li>`;
        })
        .join('');
    }
    this.offerRejoin();
    for (const l of this.roomListeners) l(this.current);
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
