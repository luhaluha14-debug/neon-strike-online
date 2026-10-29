import type { RoomInfo, RoomMode } from '../net/Protocol';
import type { MainMenu, MenuPage } from './MainMenu';
import './lobby.css';

export type LobbyMode = 'deathmatch' | 'team' | 'training';

/** What the lobby needs from the game (Game implements it). */
export interface LobbyGame {
  readonly mode: LobbyMode;
  readonly mapName: string;
}

/** What the lobby needs from the multiplayer page (MultiplayerPanel implements it). */
export interface LobbyRoomSource {
  readonly room: RoomInfo | null;
  onRoomChange(listener: (room: RoomInfo | null) => void): void;
  onNotice(listener: (text: string) => void): void;
  leave(): void;
}

type LobbyAction = 'resume' | 'play' | 'multi' | 'arsenal' | 'training' | 'settings';

const ITEMS: readonly { id: LobbyAction; label: string; desc: string }[] = [
  { id: 'resume', label: 'RESUME', desc: '진행 중인 경기로 돌아갑니다' },
  { id: 'play', label: 'PLAY', desc: '5대5 라운드전 · 봇 데스매치' },
  { id: 'multi', label: 'MULTIPLAYER', desc: '빠른 참가 · 방 만들기 · 코드 참가 · 방 목록' },
  { id: 'arsenal', label: 'ARSENAL', desc: '시작 무기 선택 (스킨은 보관함 탭)' },
  { id: 'training', label: 'TRAINING', desc: '훈련장 — 표적 사격' },
  { id: 'settings', label: 'SETTINGS', desc: '그래픽 · 사운드 · 인터페이스 · 조작' },
];

const MODES: readonly { id: Exclude<LobbyMode, 'training'>; title: string; tag: string; desc: string }[] = [
  { id: 'team', title: '5대5 라운드전', tag: '팀전', desc: 'BLUE(나 + 아군 봇 4) 대 RED(봇 5). C4 폭파 또는 전멸전, 라운드 경제와 구매 메뉴.' },
  { id: 'deathmatch', title: '봇 데스매치', tag: '개인전', desc: '모두가 적. 제한 시간 또는 목표 킬을 먼저 채우면 끝납니다.' },
];

const ROOM_MODE: Record<RoomMode, string> = { deathmatch: '데스매치', team: '5대5 라운드전' };

/**
 * The GRID lobby: the first screen, drawn inside the menu overlay. Every
 * item opens something that already exists — a menu page, the mode select,
 * the 플레이 / 계속하기 button, the multiplayer room — so the lobby holds no
 * game state of its own. Its listeners are added once (constructor).
 */
export class Lobby {
  readonly root: HTMLElement;
  private room: RoomInfo | null = null;

  constructor(
    private readonly menu: MainMenu,
    private readonly game: LobbyGame,
    rooms: LobbyRoomSource,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'lobby';
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', 'GRID 로비');
    this.root.innerHTML = `
      <div class="lobby-scrim" aria-hidden="true"></div>
      <div class="lobby-main">
        <header class="lobby-brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <div>
            <h1 class="lobby-title">GRID</h1>
            <div class="lobby-sub eyebrow">전술 작전 · 5대5</div>
          </div>
        </header>
        <div class="lobby-room" hidden>
          <div class="lobby-room-info">
            <span class="eyebrow">온라인 방</span>
            <b class="lobby-room-code"></b>
            <span class="lobby-room-meta muted"></span>
          </div>
          <div class="lobby-room-actions">
            <button type="button" class="btn btn-primary lobby-room-play">경기 입장</button>
            <button type="button" class="btn lobby-room-view">방 정보</button>
            <button type="button" class="btn lobby-room-leave">방 나가기</button>
          </div>
        </div>
        <nav class="lobby-nav" aria-label="로비 메뉴">
          ${ITEMS.map(
            (it) => `
            <button type="button" class="lobby-item" data-lobby="${it.id}"${it.id === 'resume' ? ' hidden' : ''}>
              <span class="lobby-item-label">${it.label}</span>
              <span class="lobby-item-desc">${it.desc}</span>
            </button>`,
          ).join('')}
        </nav>
        <section class="lobby-play" hidden aria-label="모드 선택">
          <div class="lobby-play-head">
            <button type="button" class="btn lobby-back">◂ 뒤로</button>
            <h2 class="section-title">작전 선택</h2>
          </div>
          <div class="lobby-modes">
            ${MODES.map(
              (m) => `
              <button type="button" class="lobby-mode" data-play-mode="${m.id}">
                <span class="eyebrow">${m.tag}</span>
                <span class="lobby-mode-title">${m.title}</span>
                <span class="lobby-mode-desc muted">${m.desc}</span>
                <span class="lobby-mode-current">현재 선택</span>
              </button>`,
            ).join('')}
          </div>
          <p class="field-hint">맵과 경기 규칙은 다음 화면에서 고르고 플레이를 누르면 시작합니다.</p>
        </section>
        <p class="lobby-notice" role="alert" hidden></p>
      </div>
      <footer class="lobby-footer">
        <span class="lobby-status" aria-live="polite"></span>
        <span class="lobby-map muted"></span>
      </footer>`;
    menu.root.appendChild(this.root);

    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.lobby-item')) b.addEventListener('click', () => this.act(b.dataset.lobby as LobbyAction));
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.lobby-mode')) b.addEventListener('click', () => this.pickMode(b.dataset.playMode as Exclude<LobbyMode, 'training'>));
    this.q('.lobby-back').addEventListener('click', () => this.showPlay(false));
    this.q('.lobby-room-play').addEventListener('click', () => menu.play());
    this.q('.lobby-room-view').addEventListener('click', () => menu.showMenu('multi'));
    this.q('.lobby-room-leave').addEventListener('click', () => rooms.leave());
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.q('.lobby-play').hidden) {
        e.stopPropagation();
        this.showPlay(false);
      }
    });
    menu.onStateChange(() => this.render());
    menu.onViewChange((v) => {
      if (v === 'lobby') {
        this.showPlay(false);
        this.render();
      }
    });
    rooms.onRoomChange((room) => {
      this.room = room;
      this.render();
    });
    rooms.onNotice((text) => this.notice(text));
    this.render();
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.root.querySelector<T>(sel)!;
  }

  private act(a: LobbyAction): void {
    this.notice('');
    const open = (page: MenuPage) => this.menu.showMenu(page);
    switch (a) {
      case 'resume':
        this.menu.play();
        break;
      case 'play':
        this.showPlay(true);
        break;
      case 'multi':
        open('multi');
        break;
      case 'arsenal':
        open('loadout');
        break;
      case 'training':
        this.menu.selectValue('mode', 'training');
        open('play');
        break;
      case 'settings':
        open('settings');
        break;
    }
  }

  private pickMode(mode: Exclude<LobbyMode, 'training'>): void {
    // The Play page's own mode select: same save and restart as picking it there.
    this.menu.selectValue('mode', mode);
    this.menu.showMenu('play');
  }

  private showPlay(on: boolean): void {
    this.q('.lobby-play').hidden = !on;
    this.q('.lobby-nav').hidden = on;
    if (on) {
      for (const b of this.root.querySelectorAll<HTMLElement>('.lobby-mode')) b.classList.toggle('current', b.dataset.playMode === this.game.mode);
      this.root.querySelector<HTMLButtonElement>(`.lobby-mode[data-play-mode="${this.game.mode === 'deathmatch' ? 'deathmatch' : 'team'}"]`)?.focus();
    }
  }

  private notice(text: string): void {
    const el = this.q('.lobby-notice');
    el.textContent = text;
    el.hidden = !text;
  }

  /** Ready / paused / loading state, the room, the status line: all read from their owners. */
  private render(): void {
    const ready = this.menu.isReady;
    const paused = this.menu.isPaused;
    const room = this.room;
    const resume = this.q<HTMLButtonElement>('[data-lobby="resume"]');
    resume.hidden = !paused || !!room;
    resume.disabled = !ready;
    // In a room the room decides the mode: single-player modes wait until it is left.
    for (const id of ['play', 'training'] as const) {
      const b = this.q<HTMLButtonElement>(`[data-lobby="${id}"]`);
      b.disabled = !!room;
      b.title = room ? '온라인 방에 있는 동안은 방의 모드로 플레이합니다. 방을 나가면 선택할 수 있습니다.' : '';
    }
    this.q('.lobby-room').hidden = !room;
    if (room) {
      this.q('.lobby-room-code').textContent = room.code;
      this.q('.lobby-room-meta').textContent = `${ROOM_MODE[room.mode]} · ${room.members.length}/${room.capacity}명`;
      const play = this.q<HTMLButtonElement>('.lobby-room-play');
      play.textContent = paused ? '계속하기' : '경기 입장';
      play.disabled = !ready;
    }
    const { text, error } = this.menu.statusLine;
    const status = this.q('.lobby-status');
    status.textContent = this.menu.loadingShown ? '맵 불러오는 중…' : text;
    status.classList.toggle('error', error);
    this.q('.lobby-map').textContent = `배경: ${this.game.mapName}`;
  }
}
