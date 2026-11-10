import { TEAM_NAME, type RoundPlayer, type RoundResult, type RoundStats, type Team, type TeamMatch } from '../game/TeamMatch';

// "라운드 기록" on the team match results screen (inside the existing panel):
// one summary row per round with the round's result for the player's team
// and the player's own K / D / HS / DAMAGE in it; choosing a round shows that
// round in detail (how it ended, how long it took, the C4 in a bomb round,
// and every player's numbers in that round, BLUE and RED apart). Built from
// the match's round records only (the host's, in a room); nothing is counted
// here. Rounds exist only in team matches, so deathmatch and training never
// show it.

const REASON: Record<RoundResult['reason'], string> = { elimination: '전멸', time: '시간 종료', bomb: 'C4 폭파', defuse: 'C4 해체' };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function clock(seconds: number | undefined): string {
  if (seconds === undefined) return '—';
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The player's own entry in a round: its seat, played by its current controller (as its match record). */
function mine(st: RoundStats | undefined, gen: number): RoundPlayer | null {
  return st?.players.find((p) => p[0] === 'local' && p[3] === gen) ?? null;
}

/** The record of round `r` (none from an older host). */
export function statsOf(m: TeamMatch, r: RoundResult): RoundStats | undefined {
  return m.roundStats.find((x) => x.round === r.round);
}

/** Win / loss / draw of a round for `team`. */
export function roundOutcome(r: RoundResult, team: Team | null): '승리' | '패배' | '무승부' {
  if (!r.winner) return '무승부';
  return r.winner === team ? '승리' : '패배';
}

/** The C4 in a bomb round, in words (null outside the bomb objective, or from an older host). */
export function bombLine(r: RoundResult, st: RoundStats | undefined): string | null {
  const b = st?.bomb;
  if (!b) return null;
  if (!b.planted) return r.reason === 'time' ? 'C4 미설치 · 시간 종료(방어 성공)' : 'C4 미설치';
  const by = b.plantedBy ? ` (${esc(b.plantedBy)})` : '';
  if (r.reason === 'bomb') return `C4 설치${by} → 폭파(공격 성공)`;
  if (r.reason === 'defuse') return `C4 설치${by} → 해체${b.defusedBy ? ` (${esc(b.defusedBy)})` : ''}(방어 성공)`;
  return `C4 설치${by} → 방어팀 전멸`;
}

export class RoundRecords {
  readonly root: HTMLElement;
  private readonly body: HTMLTableSectionElement;
  private readonly detail: HTMLElement;
  private match: TeamMatch | null = null;
  private selected = -1;

  constructor() {
    this.root = document.createElement('section');
    this.root.className = 'round-records';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="rr-title">라운드 기록 <span class="rr-hint">라운드를 누르면 상세 기록</span></div>
      <table class="rr-table">
        <thead><tr><th>라운드</th><th>결과</th><th>K</th><th>D</th><th>HS</th><th>DAMAGE</th></tr></thead>
        <tbody></tbody>
      </table>
      <div class="rr-detail" hidden></div>`;
    this.body = this.root.querySelector('tbody')!;
    this.detail = this.root.querySelector('.rr-detail')!;
    this.body.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('tr[data-i]');
      if (row) this.select(Number(row.dataset.i));
    });
  }

  /** Fills the section for a finished team match (hidden when it has no decided round). */
  show(m: TeamMatch): void {
    this.match = m;
    this.selected = -1;
    this.detail.hidden = true;
    this.root.hidden = m.history.length === 0;
    const me = m.scores.get('local');
    const team = me?.team ?? null;
    const gen = me?.gen ?? 0;
    this.body.innerHTML = m.history
      .map((r, i) => {
        const p = mine(statsOf(m, r), gen);
        const out = roundOutcome(r, p?.[2] ?? team);
        const cls = out === '승리' ? 'win' : out === '패배' ? 'loss' : 'draw';
        const n = (v: number | undefined) => (p ? String(v) : '—');
        return (
          `<tr data-i="${i}" class="${cls}"><td><button type="button" class="rr-pick" aria-expanded="false">${r.round}</button></td>` +
          `<td class="rr-out">${out}</td><td>${n(p?.[4])}</td><td>${n(p?.[5])}</td><td>${n(p?.[6])}</td><td>${n(p?.[7])}</td></tr>`
        );
      })
      .join('');
  }

  /** Shows round `i` in detail (again on the same one: closes it). */
  select(i: number): void {
    const m = this.match;
    const r = m?.history[i];
    if (!m || !r) return;
    this.selected = this.selected === i ? -1 : i;
    for (const tr of this.body.querySelectorAll<HTMLElement>('tr')) {
      const on = Number(tr.dataset.i) === this.selected;
      tr.classList.toggle('sel', on);
      tr.querySelector('.rr-pick')?.setAttribute('aria-expanded', String(on));
    }
    this.detail.hidden = this.selected < 0;
    if (this.selected < 0) return;
    const gen = m.scores.get('local')?.gen ?? 0;
    const st = statsOf(m, r);
    const head = `라운드 ${r.round} · ${r.winner ? `${TEAM_NAME[r.winner]} 승리` : '무승부'} · ${REASON[r.reason]} · ${clock(st?.duration)}`;
    const sides = r.attackers ? `공격 ${TEAM_NAME[r.attackers]} · 방어 ${TEAM_NAME[r.attackers === 'blue' ? 'red' : 'blue']}` : '';
    const bomb = bombLine(r, st);
    const table = (team: Team) => {
      const rows = (st?.players ?? []).filter((p) => p[2] === team).sort((a, b) => b[4] - a[4] || b[7] - a[7] || a[5] - b[5]);
      return (
        `<table class="score-table team-table rr-team ${team}"><thead><tr><th>${TEAM_NAME[team]}${r.winner === team ? ' · 승리' : ''}</th><th>K</th><th>D</th><th>HS</th><th>DMG</th></tr></thead><tbody>` +
        (rows.length
          ? rows
              .map((p) => `<tr class="${p[0] === 'local' && p[3] === gen ? 'me' : ''}"><td>${esc(p[1])}</td><td>${p[4]}</td><td>${p[5]}</td><td>${p[6]}</td><td>${p[7]}</td></tr>`)
              .join('')
          : '<tr><td colspan="5" class="rr-none">기록 없음</td></tr>') +
        '</tbody></table>'
      );
    };
    this.detail.innerHTML =
      `<div class="rr-head">${head}</div>` +
      (sides ? `<div class="rr-line">${sides}</div>` : '') +
      (bomb ? `<div class="rr-line rr-bomb">${bomb}</div>` : '') +
      `<div class="rr-alive">생존 BLUE ${r.alive.blue} : ${r.alive.red} RED</div>` +
      (st ? `<div class="rr-teams">${table('blue')}${table('red')}</div>` : '<div class="rr-line">이 라운드의 선수별 기록이 없습니다.</div>');
  }
}

