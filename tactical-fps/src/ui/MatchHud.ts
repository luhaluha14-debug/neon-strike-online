import type { KillEvent, Match } from '../game/Match';
import './match.css';

const FEED_SECONDS = 6;
const WEAPON_SHORT: Record<string, string> = { ar01: 'AR-01', sr01: 'SR-01', karambit: 'M9' };

/**
 * Deathmatch overlay: timer / kills / rank bar, kill feed, Tab scoreboard and
 * the end-of-match results with "다시 시작". DOM is only touched when a shown
 * value changes.
 */
export class MatchHud {
  readonly root: HTMLDivElement;
  private readonly time: HTMLElement;
  private readonly kills: HTMLElement;
  private readonly rank: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly board: HTMLElement;
  private readonly results: HTMLElement;
  private last = '';
  private feedCount = -1;
  private boardKey = '';

  constructor(parent: HTMLElement, onRestart: () => void, onMenu: () => void, onLobby: () => void = onMenu) {
    this.root = document.createElement('div');
    this.root.className = 'match-hud';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="match-bar" role="status">
        <span class="mb-time">10:00</span>
        <span class="mb-sep"></span>
        <span class="mb-kills"><b>0</b> / 30 킬</span>
        <span class="mb-sep"></span>
        <span class="mb-rank">1위</span>
      </div>
      <ol class="killfeed" aria-live="polite"></ol>
      <div class="scoreboard" hidden><table class="score-table"></table></div>
      <div class="results" hidden>
        <div class="results-panel">
          <div class="results-title"></div>
          <div class="results-sub"></div>
          <div class="results-reward" aria-live="polite"></div>
          <table class="score-table results-table"></table>
          <div class="results-actions">
            <button type="button" class="btn btn-primary results-restart">다시 시작</button>
            <button type="button" class="btn results-menu">메뉴</button>
            <button type="button" class="btn results-lobby">로비</button>
          </div>
        </div>
      </div>`;
    parent.appendChild(this.root);
    const q = (s: string) => this.root.querySelector<HTMLElement>(s)!;
    this.time = q('.mb-time');
    this.kills = q('.mb-kills');
    this.rank = q('.mb-rank');
    this.feed = q('.killfeed');
    this.board = q('.scoreboard');
    this.results = q('.results');
    q('.results-restart').addEventListener('click', onRestart);
    q('.results-menu').addEventListener('click', onMenu);
    q('.results-lobby').addEventListener('click', onLobby);
  }

  setVisible(on: boolean): void {
    this.root.hidden = !on;
  }

  get resultsShown(): boolean {
    return !this.results.hidden;
  }

  /** Per frame while a match exists. */
  update(m: Match, showBoard: boolean): void {
    const me = m.ranking.findIndex((s) => s.isPlayer);
    const meLine = m.ranking[me];
    const t = Math.ceil(m.timeLeft);
    const key = `${t}|${meLine?.kills}|${me}|${m.config.killTarget}`;
    if (key !== this.last) {
      this.last = key;
      this.time.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      this.time.classList.toggle('low', t <= 30);
      this.kills.innerHTML = `<b>${meLine?.kills ?? 0}</b> / ${m.config.killTarget} 킬`;
      this.rank.textContent = `${me + 1}위 / ${m.scores.size}`;
    }
    // Kill feed: recent kills only.
    const recent = m.feed.filter((k) => m.elapsed - k.at < FEED_SECONDS).slice(-5);
    const feedKey = recent.length * 100000 + (recent.at(-1)?.at ?? 0);
    if (feedKey !== this.feedCount) {
      this.feedCount = feedKey;
      this.feed.replaceChildren(...recent.map((k) => this.feedItem(m, k)));
    }
    this.board.hidden = !showBoard || m.over;
    if (!this.board.hidden) this.fillTable(this.board.querySelector('table')!, m);
  }

  showResults(m: Match): void {
    const won = m.playerWon;
    this.results.hidden = false;
    this.results.classList.toggle('won', won);
    this.results.querySelector('.results-reward')!.textContent = '';
    this.results.querySelector('.results-title')!.textContent = won ? '승리' : '패배';
    const me = m.ranking.findIndex((s) => s.isPlayer) + 1;
    const why = m.endReason === 'kills' ? `${m.config.killTarget}킬 달성` : '시간 종료';
    this.results.querySelector('.results-sub')!.textContent = `${why} · ${me}위 / ${m.scores.size}`;
    this.boardKey = '';
    this.fillTable(this.results.querySelector('table')!, m);
  }

  /** GRID credit line under the result (set once the economy has answered). */
  showReward(text: string): void {
    this.results.querySelector('.results-reward')!.textContent = text;
  }

  /** A room member cannot restart the host's match: its 다시 시작 waits for the host. */
  setRestartEnabled(on: boolean): void {
    const b = this.results.querySelector<HTMLButtonElement>('.results-restart')!;
    b.disabled = !on;
    b.title = on ? '' : '방장이 다음 경기를 시작합니다.';
  }

  hideResults(): void {
    this.results.hidden = true;
  }

  private feedItem(m: Match, k: KillEvent): HTMLLIElement {
    const li = document.createElement('li');
    const killer = m.scores.get(k.killer);
    const victim = m.scores.get(k.victim);
    li.className = killer?.isPlayer ? 'mine' : victim?.isPlayer ? 'me-died' : '';
    const name = (s: string, isMe?: boolean) => `<span class="${isMe ? 'me' : ''}">${s}</span>`;
    li.innerHTML =
      k.killer === k.victim || !killer
        ? `${name(m.name(k.victim), victim?.isPlayer)} <span class="kf-w">사망</span>`
        : `${name(killer.name, killer.isPlayer)} <span class="kf-w">${WEAPON_SHORT[k.weaponId] ?? k.weaponId}${k.head ? ' · HS' : ''}</span> ${name(m.name(k.victim), victim?.isPlayer)}`;
    return li;
  }

  private fillTable(table: HTMLTableElement, m: Match): void {
    const rows = m.ranking;
    const key = rows.map((r) => `${r.id}:${r.kills}:${r.deaths}`).join('|');
    if (table === this.board.querySelector('table') && key === this.boardKey) return;
    if (table === this.board.querySelector('table')) this.boardKey = key;
    table.innerHTML =
      '<thead><tr><th>#</th><th>이름</th><th>킬</th><th>데스</th></tr></thead><tbody>' +
      rows.map((r, i) => `<tr class="${r.isPlayer ? 'me' : ''}"><td>${i + 1}</td><td>${r.name}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`).join('') +
      '</tbody>';
  }
}
