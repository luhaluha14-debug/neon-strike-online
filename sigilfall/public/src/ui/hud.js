/* =============================================================================
   the in-match interface: vitals, ability state, damage numbers, kill feed,
   minimap, scoreboard and the reaction feedback (hit markers, hurt direction).
   it reads the game each frame and never writes to it.
   ========================================================================== */
import { $, el } from './screens.js';
import { clamp, damp } from '../core/math.js';
import { settings } from '../core/settings.js';
import { abilityOf } from '../characters/roster.js';
import { RULES } from '../game/rules.js';

const SLOTS = [['q', 'Q'], ['a1', '1'], ['a2', '2'], ['ult', 'E']];
const V3 = () => new window.THREE.Vector3();

export class Hud {
  constructor(game) {
    this.game = game;
    this.root = $('hud');
    this.dmgLayer = $('dmgLayer');
    this.numbers = [];
    this.dirMarks = [];
    this.hpShown = 1;
    this.hpGhost = 1;
    this.markerT = 0;
    this.bannerT = 0;
    this.v = V3();
    this.buildAbilities();
    this.buildCrosshair();
    this.miniCtx = $('minimap').querySelector('canvas').getContext('2d');
    this.lastMini = 0;
    this.boardOpen = false;
    $('scoreMode').textContent = game.mode.latin.split(' ')[0];
    $('vitName').textContent = game.player.char.latin;
    $('vitRole').textContent = game.player.char.role;
    $('minimap').classList.toggle('hide', !settings.get('minimap'));
    $('fps').classList.toggle('hide', !settings.get('showFps'));
  }

  show(on) { this.root.classList.toggle('on', on); }

  dispose() {
    this.dmgLayer.innerHTML = '';
    $('killfeed').innerHTML = '';
    $('statusbar').innerHTML = '';
    $('banner').innerHTML = '';
    $('board').classList.add('hide');
    $('respawn').classList.add('hide');
  }

  /* ---------------------------------------------------------- build */
  buildAbilities() {
    const wrap = $('abilities');
    wrap.innerHTML = '';
    this.abEls = {};
    for (const [slot, key] of SLOTS) {
      const spec = abilityOf(this.game.player.charId, slot);
      const d = el('div', 'ab' + (slot === 'ult' ? ' ult' : ''));
      d.appendChild(el('span', 'k', key));
      if (slot === 'ult') d.appendChild(el('div', 'ultfill'));
      d.appendChild(el('span', 'ic', spec.icon || '◆'));
      d.appendChild(el('span', 'nm', spec.name));
      d.appendChild(el('div', 'cdmask'));
      d.appendChild(el('div', 'cdnum mono', ''));
      wrap.appendChild(d);
      this.abEls[slot] = {
        root: d, mask: d.querySelector('.cdmask'), num: d.querySelector('.cdnum'),
        fill: d.querySelector('.ultfill'), spec
      };
    }
  }

  buildCrosshair() {
    const style = settings.get('crosshairStyle');
    const col = settings.get('crosshairColor');
    const size = clamp(settings.get('crosshairSize'), 0.5, 2);
    const gap = 5 * size, len = 7 * size, th = 2;
    const put = (id, x, y, w, h) => {
      const e = $(id);
      e.style.background = col;
      e.style.width = w + 'px'; e.style.height = h + 'px';
      e.style.left = (22 + x) + 'px'; e.style.top = (22 + y) + 'px';
      e.style.display = style === 'dot' ? 'none' : 'block';
    };
    put('chT', -th / 2, -gap - len, th, len);
    put('chB', -th / 2, gap, th, len);
    put('chL', -gap - len, -th / 2, len, th);
    put('chR', gap, -th / 2, len, th);
    const dot = $('chDot');
    dot.style.background = col;
    dot.style.display = style === 'cross' ? 'none' : 'block';
  }

  /* ---------------------------------------------------------- events */
  onSpawn() {
    $('respawn').classList.add('hide');
    this.hpShown = 1; this.hpGhost = 1;
  }

  onDeath(attacker) {
    $('respawn').classList.remove('hide');
    $('respawnBy').textContent = attacker && attacker !== this.game.player ? attacker.name + ' 에게 당함' : '';
  }

  onHurt(attacker, dmg) {
    if (!attacker) return;
    const g = this.game, p = g.player;
    const ang = Math.atan2(attacker.pos.x - p.pos.x, attacker.pos.z - p.pos.z);
    const rel = ang - p.yaw;
    const mark = el('div', 'hitdir');
    mark.appendChild(el('b'));
    mark.style.transform = `rotate(${-rel}rad)`;
    mark.style.opacity = String(clamp(dmg / 45, 0.35, 1));
    $('dirLayer').appendChild(mark);
    this.dirMarks.push({ el: mark, t: 0 });
  }

  onKill(streak) {
    if (streak >= 2) this.banner(streak >= 4 ? '무쌍' : streak === 3 ? '삼연격' : '연격', 0.9, 'x' + streak);
  }

  hitMarker(head, kill) {
    const m = $('hitmark');
    m.classList.toggle('kill', !!kill);
    if (!settings.get('hitMarkers')) return;
    m.style.opacity = '1';
    m.style.transform = 'translate(-50%,-50%) scale(' + (kill ? 1.25 : head ? 1.1 : 0.9) + ')';
    this.markerT = kill ? 0.35 : 0.18;
  }

  showDamage(victim, dmg, head) {
    if (!settings.get('damageNumbers')) return;
    const n = el('div', 'dmg ' + (head ? 'head' : 'norm'), String(Math.round(dmg)));
    this.dmgLayer.appendChild(n);
    this.numbers.push({
      el: n, t: 0, life: 0.85,
      x: victim.pos.x, y: victim.centerY + 0.5, z: victim.pos.z,
      ox: (Math.random() - 0.5) * 26, rise: 42 + Math.random() * 20
    });
    if (this.numbers.length > 24) {
      const old = this.numbers.shift();
      old.el.remove();
    }
  }

  killFeed(attacker, victim) {
    const row = el('div', 'kf');
    const me = this.game.player;
    const a = el('span', attacker === me ? 'me' : '', attacker ? attacker.name : '월드');
    const v = el('span', victim === me ? 'me' : '', victim.name);
    row.appendChild(a);
    row.appendChild(el('span', 'vs', '▸'));
    row.appendChild(v);
    const feed = $('killfeed');
    feed.appendChild(row);
    setTimeout(() => row.remove(), 5000);
    while (feed.children.length > 5) feed.firstChild.remove();
  }

  banner(text, dur = 1, sub = '') {
    const b = $('banner');
    b.innerHTML = '';
    b.appendChild(el('div', 'big', text));
    if (sub) b.appendChild(el('div', 'small', sub));
    this.bannerT = dur;
    b.style.opacity = '1';
  }

  warn(text) { this.banner(text, 0.5); }
  flashHeal() { this.healT = 0.3; }

  /* ---------------------------------------------------------- frame */
  update(realDt) {
    const g = this.game, p = g.player, now = g.now;
    const dt = realDt || 0.016;

    /* vitals */
    const hpFrac = p.alive ? clamp(p.hp / p.maxHp, 0, 1) : 0;
    this.hpShown = damp(this.hpShown, hpFrac, 18, dt);
    this.hpGhost = this.hpGhost < hpFrac ? hpFrac : damp(this.hpGhost, hpFrac, 3.2, dt);
    $('hpfill').style.transform = `scaleX(${this.hpShown})`;
    $('hpghost').style.transform = `scaleX(${this.hpGhost})`;
    $('hptext').textContent = Math.max(0, Math.ceil(p.hp));
    $('energyfill').style.transform = `scaleX(${clamp(p.energy / p.maxEnergy, 0, 1)})`;
    $('lowhp').style.boxShadow = `inset 0 0 130px rgba(150,20,20,${p.alive ? clamp(0.62 - hpFrac, 0, 0.55) : 0})`;

    /* brand stacks */
    const stacks = p.stackCount(now);
    const sw = $('stacks');
    if (sw.children.length !== 5 && p.char.primary.kind === 'melee') {
      sw.innerHTML = '';
      for (let i = 0; i < 5; i++) sw.appendChild(el('i'));
    } else if (p.char.primary.kind !== 'melee' && sw.children.length) sw.innerHTML = '';
    for (let i = 0; i < sw.children.length; i++) sw.children[i].classList.toggle('on', i < stacks);

    /* abilities */
    for (const [slot] of SLOTS) {
      const a = this.abEls[slot];
      if (slot === 'ult') {
        const frac = clamp(p.ult / RULES.ult.max, 0, 1);
        a.fill.style.height = (frac * 100) + '%';
        a.root.classList.toggle('full', frac >= 1 && !p.ultActive);
        a.num.style.opacity = p.ultActive ? '0.9' : '0';
        a.num.textContent = p.ultActive ? Math.ceil(p.ultEndsAt - now) : '';
        continue;
      }
      const left = g.abilities.cooldownLeft(p, slot);
      const total = a.spec.cd || 1;
      a.mask.style.transform = `scaleY(${clamp(left / total, 0, 1)})`;
      a.root.classList.toggle('cool', left > 0.05);
      a.num.textContent = left > 0.05 ? (left < 1 ? left.toFixed(1) : Math.ceil(left)) : '';
      const poor = (a.spec.cost && p.energy < a.spec.cost) || (a.spec.hpCost && p.hp <= a.spec.hpCost + 5);
      a.root.classList.toggle('no', !!poor);
    }

    /* score */
    if (g.mode.ffa) {
      const mine = g.scores[p.team] || 0;
      let best = 0;
      for (const [t, s] of Object.entries(g.scores)) if (t !== p.team) best = Math.max(best, s);
      $('scoreA').textContent = mine;
      $('scoreB').textContent = best;
    } else {
      $('scoreA').textContent = g.scores[p.team] || 0;
      let other = 0;
      for (const [t, s] of Object.entries(g.scores)) if (t !== p.team) other = Math.max(other, s);
      $('scoreB').textContent = other;
    }
    $('timer').textContent = '목표 ' + g.mode.target;

    /* respawn counter */
    if (!p.alive && g.state === 'live') {
      $('respawn').classList.remove('hide');
      $('respawnN').textContent = Math.max(0, Math.ceil(p.respawnAt - now));
    } else if (p.alive) $('respawn').classList.add('hide');

    /* hit marker fade */
    if (this.markerT > 0) {
      this.markerT -= dt;
      if (this.markerT <= 0) $('hitmark').style.opacity = '0';
    }

    /* banner fade */
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) $('banner').style.opacity = '0';
    }

    /* floating damage numbers */
    const cam = g.engine.camera, W = window.innerWidth, H = window.innerHeight;
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      n.t += dt;
      if (n.t >= n.life) { n.el.remove(); this.numbers.splice(i, 1); continue; }
      this.v.set(n.x, n.y, n.z).project(cam);
      const k = n.t / n.life;
      if (this.v.z > 1) { n.el.style.opacity = '0'; continue; }
      const sx = (this.v.x * 0.5 + 0.5) * W + n.ox;
      const sy = (-this.v.y * 0.5 + 0.5) * H - k * n.rise;
      n.el.style.transform = `translate(${sx}px,${sy}px) scale(${1 + (1 - k) * 0.25})`;
      n.el.style.opacity = String(1 - k * k);
    }

    /* hurt direction marks */
    for (let i = this.dirMarks.length - 1; i >= 0; i--) {
      const m = this.dirMarks[i];
      m.t += dt;
      if (m.t > 1.1) { m.el.remove(); this.dirMarks.splice(i, 1); continue; }
      m.el.style.opacity = String(clamp(1 - m.t / 1.1, 0, 1));
    }

    /* status chips */
    this.updateStatus(now);

    /* domain tint */
    const inside = g.domains.playerInside;
    const edge = $('domainEdge');
    if (inside) {
      edge.style.opacity = '1';
      const col = new window.THREE.Color(inside.d.spec.color);
      edge.style.boxShadow = `inset 0 0 170px rgba(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0},${inside.enemy ? 0.5 : 0.32})`;
    } else edge.style.opacity = '0';

    /* crosshair spread while moving, hidden while aiming a scope */
    const ch = $('crosshair');
    const spread = clamp(Math.hypot(p.vel.x, p.vel.z) / 14, 0, 1) * 6 + (p.ads ? -3 : 0);
    ch.style.transform = `translate(-50%,-50%) scale(${1 + spread * 0.06})`;
    ch.style.opacity = p.alive ? '1' : '0.25';

    /* aim assist tag */
    const assist = g.controller?.assist;
    $('autoaimTag').classList.toggle('on', !!(assist && assist.target && settings.get('aimAssist') && g.input.lastDevice === 'touch'));

    /* minimap, a few times a second is plenty */
    if (settings.get('minimap') && now - this.lastMini > 0.06) {
      this.lastMini = now;
      this.drawMini();
    }

    /* scoreboard */
    const wantBoard = g.input.isDown('scoreboard');
    if (wantBoard !== this.boardOpen) {
      this.boardOpen = wantBoard;
      $('board').classList.toggle('hide', !wantBoard);
      if (wantBoard) this.drawBoard();
    }

    if (settings.get('showFps')) {
      $('fps').classList.remove('hide');
      $('fps').textContent = g.engine.fps + ' FPS';
    }
    if (g.net) {
      const el2 = $('netstat');
      el2.classList.remove('hide');
      el2.textContent = g.net.pingMs + 'ms' + (g.net.healthy ? '' : ' · 재연결 중');
      el2.style.color = g.net.healthy ? '' : '#ff8a7a';
    }
  }

  updateStatus(now) {
    const p = this.game.player;
    const bar = $('statusbar');
    const want = [];
    if (now < p.slowUntil) want.push(['둔화', true]);
    if (now < p.markedUntil) want.push(['표식', true]);
    if (p.hasBuff('focus', now)) want.push(['집속', false]);
    if (now < p.parryUntil) want.push(['반격 자세', false]);
    if (p.ultActive) want.push(['영역 전개', false]);
    if (p.hasBuff('refocus', now)) want.push(['재집중', false]);
    const key = want.map((w) => w[0]).join('|');
    if (key === this._statusKey) return;
    this._statusKey = key;
    bar.innerHTML = '';
    for (const [text, bad] of want) bar.appendChild(el('div', 'status' + (bad ? ' bad' : ''), text));
  }

  drawMini() {
    const g = this.game, ctx = this.miniCtx, m = g.mapDef;
    const S = 300, scale = S / (Math.max(m.sx, m.sz) * 2 + 4);
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(12,16,20,.55)';
    ctx.fillRect(0, 0, S, S);
    const toX = (x) => S / 2 + x * scale;
    const toZ = (z) => S / 2 + z * scale;

    ctx.fillStyle = 'rgba(150,160,175,.24)';
    for (const b of m.boxes) {
      if (b[6] === 'shell' || b[5] === 'n') continue;
      ctx.fillRect(toX(b[0] - b[2] / 2), toZ(b[1] - b[3] / 2), b[2] * scale, b[3] * scale);
    }

    for (const z of g.zones.list) {
      ctx.beginPath();
      ctx.fillStyle = 'rgba(200,120,60,.2)';
      ctx.arc(toX(z.x), toZ(z.z), z.radius * scale, 0, 7);
      ctx.fill();
    }
    for (const d of g.domains.list) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(180,120,240,.55)';
      ctx.lineWidth = 2;
      ctx.arc(toX(d.x), toZ(d.z), d.radius * scale, 0, 7);
      ctx.stroke();
    }

    const p = g.player;
    for (const f of g.fighters) {
      if (!f.alive || f === p) continue;
      const enemy = g.isEnemy(p, f);
      const known = !enemy || g.now < f.markedUntil || g.canSee(p, f.pos.x, f.centerY, f.pos.z);
      if (enemy && !known) continue;
      ctx.beginPath();
      ctx.fillStyle = enemy ? '#e4633a' : '#5b9bea';
      ctx.arc(toX(f.pos.x), toZ(f.pos.z), 4.5, 0, 7);
      ctx.fill();
    }
    // the player, drawn as a view cone
    ctx.save();
    ctx.translate(toX(p.pos.x), toZ(p.pos.z));
    ctx.rotate(-p.yaw);
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(6, 6); ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fillStyle = '#f0e9dc';
    ctx.fill();
    ctx.restore();
  }

  drawBoard() {
    const g = this.game;
    const rows = g.fighters.slice().sort((a, b) => b.stats.kills - a.stats.kills || b.stats.damage - a.stats.damage);
    const html = ['<table><thead><tr><th>이름</th><th>술사</th><th>K</th><th>D</th><th>피해</th><th>명중</th></tr></thead><tbody>'];
    for (const f of rows) {
      const acc = f.stats.shots ? Math.round((f.stats.hits / f.stats.shots) * 100) : 0;
      html.push(`<tr class="${f.team === g.player.team ? 'a' : 'b'}${f === g.player ? ' me' : ''}">` +
        `<td>${escapeHtml(f.name)}</td><td>${f.char.latin}</td><td>${f.stats.kills}</td>` +
        `<td>${f.stats.deaths}</td><td>${Math.round(f.stats.damage)}</td><td>${acc}%</td></tr>`);
    }
    html.push('</tbody></table>');
    $('board').innerHTML = html.join('');
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
