import type { KillEvent } from '../game/Match';
import { TEAM_NAME, type Team, type TeamMatch, type TeamScoreLine } from '../game/TeamMatch';
import './match.css';

const FEED_SECONDS = 6;
const WEAPON_SHORT: Record<string, string> = { ar01: 'AR-01', sr01: 'SR-01', karambit: 'M9' };

/**
 * Team match overlay (same look as the deathmatch MatchHud): round wins per
 * team, round number and clock, survivors per team, the round banner
 * (prep / round won / draw), kill feed, a two-team Tab scoreboard and the
 * final results with the per-round history. DOM is only touched when a
 * shown value changes.
 */
export class TeamHud {
  readonly root: HTMLDivElement;
  private readonly winsBlue: HTMLElement;
  private readonly winsRed: HTMLElement;
  private readonly round: HTMLElement;
  private readonly time: HTMLElement;
  private readonly aliveBlue: HTMLElement;
  private readonly aliveRed: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly board: HTMLElement;
  private readonly results: HTMLElement;
  private last = '';
  private bannerKey = '';
  private feedKey = -1;
  private boardKey = '';

  constructor(parent: HTMLElement, onRestart: () => void, onMenu: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'match-hud team-hud';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="match-bar team-bar" role="status">
        <span class="tb-side blue"><span class="tb-name">BLUE</span><b class="tb-wins tb-wins-blue">0</b></span>
        <span class="tb-mid"><span class="tb-round">라운드 1</span><span class="mb-time tb-time">2:00</span></span>
        <span class="tb-side red"><b class="tb-wins tb-wins-red">0</b><span class="tb-name">RED</span></span>
      </div>
      <div class="team-alive" aria-label="생존 인원">
        <span class="ta blue">생존 <b class="ta-blue">5</b></span>
        <span class="ta red">생존 <b class="ta-red">5</b></span>
      </div>
      <div class="round-banner" role="status" hidden></div>
      <ol class="killfeed" aria-live="polite"></ol>
      <div class="scoreboard team-board" hidden></div>
      <div class="results" hidden>
        <div class="results-panel">
          <div class="results-title"></div>
          <div class="results-sub"></div>
          <ol class="round-history"></ol>
          <div class="results-teams"></div>
          <div class="results-actions">
            <button type="button" class="btn btn-primary results-restart">다시 시작</button>
            <button type="button" class="btn results-menu">메뉴</button>
          </div>
        </div>
      </div>`;
    parent.appendChild(this.root);
    const q = (s: string) => this.root.querySelector<HTMLElement>(s)!;
    this.winsBlue = q('.tb-wins-blue');
    this.winsRed = q('.tb-wins-red');
    this.round = q('.tb-round');
    this.time = q('.tb-time');
    this.aliveBlue = q('.ta-blue');
    this.aliveRed = q('.ta-red');
    this.banner = q('.round-banner');
    this.feed = q('.killfeed');
    this.board = q('.scoreboard');
    this.results = q('.results');
    q('.results-restart').addEventListener('click', onRestart);
    q('.results-menu').addEventListener('click', onMenu);
  }

  setVisible(on: boolean): void {
    this.root.hidden = !on;
  }

  get resultsShown(): boolean {
    return !this.results.hidden;
  }

  /** Per frame while a team match exists. `alive`: living combatants per team. */
  update(m: TeamMatch, alive: Record<Team, number>, showBoard: boolean): void {
    // The clock shows the prep countdown before a round, the round clock otherwise.
    const t = Math.ceil(m.phase === 'prep' ? m.phaseLeft : m.roundTimeLeft);
    const key = `${m.roundWins.blue}|${m.roundWins.red}|${m.round}|${t}|${alive.blue}|${alive.red}|${m.phase}`;
    if (key !== this.last) {
      this.last = key;
      this.winsBlue.textContent = String(m.roundWins.blue);
      this.winsRed.textContent = String(m.roundWins.red);
      this.round.textContent = `라운드 ${m.round}`;
      this.time.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      this.time.classList.toggle('low', m.phase === 'live' && t <= 15);
      this.aliveBlue.textContent = String(alive.blue);
      this.aliveRed.textContent = String(alive.red);
    }
    this.setBanner(m);
    const recent = m.feed.filter((k) => m.elapsed - k.at < FEED_SECONDS).slice(-5);
    const feedKey = recent.length * 100000 + (recent.at(-1)?.at ?? 0);
    if (feedKey !== this.feedKey) {
      this.feedKey = feedKey;
      this.feed.replaceChildren(...recent.map((k) => this.feedItem(m, k)));
    }
    this.board.hidden = !showBoard || m.over;
    if (!this.board.hidden) {
      const bk = boardKey(m);
      if (bk !== this.boardKey) {
        this.boardKey = bk;
        this.board.innerHTML = teamTables(m);
      }
    }
  }

  showResults(m: TeamMatch): void {
    const winner = m.winner;
    const won = winner === m.teamOf('local');
    this.results.hidden = false;
    this.results.classList.toggle('won', won);
    this.results.querySelector('.results-title')!.textContent = winner ? `${TEAM_NAME[winner]} 승리` : '경기 종료';
    this.results.querySelector('.results-sub')!.textContent = `${won ? '승리' : '패배'} · BLUE ${m.roundWins.blue} : ${m.roundWins.red} RED · ${m.history.length}라운드`;
    this.results.querySelector('.round-history')!.innerHTML = m.history
      .map((r) => {
        const cls = r.winner ?? 'draw';
        const label = r.winner ? TEAM_NAME[r.winner] : '무승부';
        const why = r.reason === 'elimination' ? '전멸' : '시간';
        return `<li class="rh ${cls}" title="라운드 ${r.round}: ${label} (${why}, 생존 ${r.alive.blue}:${r.alive.red})"><span class="rh-n">${r.round}</span><span class="rh-w">${label}</span><span class="rh-why">${why}</span></li>`;
      })
      .join('');
    this.results.querySelector('.results-teams')!.innerHTML = teamTables(m);
    this.boardKey = '';
  }

  hideResults(): void {
    this.results.hidden = true;
  }

  private setBanner(m: TeamMatch): void {
    let text = '';
    let cls = '';
    if (m.phase === 'prep') {
      text = `라운드 ${m.round} — 준비`;
      cls = 'prep';
    } else if (m.phase === 'result' && m.lastRound) {
      const r = m.lastRound;
      text = r.winner ? `${TEAM_NAME[r.winner]} 라운드 승리${r.reason === 'time' ? ' (시간 종료)' : ''}` : `무승부${r.reason === 'time' ? ' (시간 종료)' : ''}`;
      cls = r.winner ?? 'draw';
    }
    const key = `${cls}|${text}`;
    if (key === this.bannerKey) return;
    this.bannerKey = key;
    this.banner.hidden = !text;
    this.banner.textContent = text;
    this.banner.className = `round-banner ${cls}`;
  }

  private feedItem(m: TeamMatch, k: KillEvent): HTMLLIElement {
    const li = document.createElement('li');
    const killer = m.scores.get(k.killer);
    const victim = m.scores.get(k.victim);
    li.className = killer?.isPlayer && k.killer !== k.victim ? 'mine' : victim?.isPlayer ? 'me-died' : '';
    const name = (s: TeamScoreLine | undefined, id: string) => `<span class="${s?.isPlayer ? 'me ' : ''}t-${s?.team ?? ''}">${m.name(id)}</span>`;
    li.innerHTML =
      k.killer === k.victim || !killer
        ? `${name(victim, k.victim)} <span class="kf-w">사망</span>`
        : `${name(killer, k.killer)} <span class="kf-w">${WEAPON_SHORT[k.weaponId] ?? k.weaponId}${k.head ? ' · HS' : ''}</span> ${name(victim, k.victim)}`;
    return li;
  }
}

function boardKey(m: TeamMatch): string {
  return [...m.scores.values()].map((r) => `${r.id}:${r.kills}:${r.deaths}`).join('|');
}

/** Both teams' tables (team, name, kills, deaths). */
function teamTables(m: TeamMatch): string {
  return (['blue', 'red'] as const)
    .map(
      (team) =>
        `<table class="score-table team-table ${team}"><thead><tr><th colspan="2">${TEAM_NAME[team]} · ${m.roundWins[team]}</th><th>킬</th><th>데스</th></tr></thead><tbody>` +
        m
          .lines(team)
          .map((r, i) => `<tr class="${r.isPlayer ? 'me' : ''}" data-id="${r.id}" data-team="${team}"><td>${i + 1}</td><td>${r.name}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`)
          .join('') +
        '</tbody></table>',
    )
    .join('');
}
