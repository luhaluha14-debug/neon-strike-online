import { formatKd, type CombatStats } from '../game/CombatStats';

// The player's own combat record on a results screen (deathmatch and team
// match alike): one row of the five numbers under the result line, with the
// mode. Fills the existing results panel; it does not replace it.

export function fillCombatResults(el: HTMLElement, s: CombatStats | null | undefined, mode: string): void {
  el.hidden = !s;
  if (!s) return;
  const cell = (k: string, v: string, cls: string) => `<div class="cr-cell ${cls}"><span class="cr-k">${k}</span><b class="cr-v">${v}</b></div>`;
  el.innerHTML =
    `<div class="cr-mode">${mode} · 내 전투 기록</div><div class="cr-row">` +
    cell('KILLS', String(s.kills), 'cr-kills') +
    cell('DEATHS', String(s.deaths), 'cr-deaths') +
    cell('K/D', formatKd(s.kills, s.deaths), 'cr-kd') +
    cell('HEADSHOTS', String(s.headshots), 'cr-hs') +
    cell('DAMAGE', String(s.damage), 'cr-dmg') +
    '</div>';
}
