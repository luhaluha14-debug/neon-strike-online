/* =========================================================================
   HUD: health, ammo, weapon slots, compass, minimap / full map, kill feed,
   crosshair, hit markers, damage direction, prompts, inventory panel.
   DOM writes are diffed (only touched when values change).
   ========================================================================= */
import { WEAPONS, AMMO } from '../shared/weapons.js';
import { ITEMS, invWeight } from '../shared/items.js';
import { MAX_HP } from '../shared/game.js';
import { DEG } from '../shared/util.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor() {
    this.el = {};
    for (const id of ['hud', 'crosshair', 'hitmark', 'dmgDirs', 'stormTint', 'hurtTint', 'compassStrip', 'aliveN', 'killN', 'minimap', 'zoneTxt', 'feed', 'banner', 'prompt',
      'useBar', 'useFill', 'useTxt', 'stance', 'hpFill', 'hpLag', 'hpNum', 'magN', 'resN', 'wName', 'slots', 'reloadRing', 'debug', 'inv', 'invGround', 'invBag', 'invSlots',
      'invWeight', 'invWFill', 'bigmap', 'bigmapCv']) this.el[id] = $(id);
    this.cache = {};
    this.mm = this.el.minimap.getContext('2d');
    this.hitT = 0; this.hurtA = 0; this.bannerT = 0; this.hpLag = 100;
    this.dirs = [];
    this.buildCompass();
    this.ring = this.el.reloadRing.querySelector('circle');
  }

  set(key, el, prop, v) {
    if (this.cache[key] === v) return;
    this.cache[key] = v;
    if (prop === 'text') el.textContent = v;
    else if (prop === 'html') el.innerHTML = v;
    else el.style[prop] = v;
  }

  show(on) { this.el.hud.classList.toggle('hide', !on); }

  buildCompass() {
    // strip covering 0..720 deg so we can wrap smoothly; 1 deg = 3 px
    const s = this.el.compassStrip;
    let h = '';
    const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let d = 0; d < 720; d += 15) {
      const a = d % 360;
      if (names[a] !== undefined) h += `<span class="c" style="left:${d * 3}px">${names[a]}</span>`;
      else h += `<span style="left:${d * 3}px">${a}</span>`;
      h += `<span class="t" style="left:${d * 3 + 22.5}px"></span>`;
    }
    s.innerHTML = h + '<span class="z" id="compZone">◆</span><span class="z" id="compMark" style="color:#ffd24a">▼</span>';
    this.compZone = document.getElementById('compZone');
    this.compMark = document.getElementById('compMark');
  }

  /** heading in degrees: 0 = north (-Z), 90 = east (+X) */
  static heading(yaw) { let h = (-yaw / DEG) % 360; if (h < 0) h += 360; return h; }

  update(dt, g) {
    const p = g.me, m = g.match, w = m.weaponOf(p), slot = m.slotOf(p);
    // ---- health ----
    const hp = Math.max(0, p.hp);
    this.hpLag += (hp - this.hpLag) * Math.min(1, dt * (this.hpLag > hp ? 2.5 : 20));
    this.set('hp', this.el.hpFill, 'width', (hp / MAX_HP * 100).toFixed(1) + '%');
    this.set('hpl', this.el.hpLag, 'width', (this.hpLag / MAX_HP * 100).toFixed(1) + '%');
    this.set('hpn', this.el.hpNum, 'text', String(Math.ceil(hp)));
    const low = hp < 30;
    if (this.cache.low !== low) { this.cache.low = low; this.el.hpFill.classList.toggle('low', low); }
    // ---- weapon ----
    const reserve = w.ammo ? (p.inv.items['ammo_' + w.ammo] || 0) : 0;
    this.set('mag', this.el.magN, 'text', w.cat === 'melee' ? '—' : String(slot.mag));
    this.set('res', this.el.resN, 'text', w.cat === 'melee' ? '' : '/ ' + reserve);
    const lowMag = w.cat !== 'melee' && slot.mag <= Math.ceil(w.mag * 0.2);
    if (this.cache.lowMag !== lowMag) { this.cache.lowMag = lowMag; this.el.magN.classList.toggle('low', lowMag); }
    this.set('wn', this.el.wName, 'text', w.name + (w.ammo ? '  ·  ' + AMMO[w.ammo].short : '') + (w.mode === 'semi' ? '  ·  단발' : w.cat === 'melee' ? '' : '  ·  연사'));
    const slotsHtml = [0, 1, 2, 3].map((i) => {
      const s = p.slots[i];
      return `<div class="${p.cur === i ? 'on' : ''}"><i>${i + 1}</i>${s ? WEAPONS[s.id].name.split(' ')[0] : '—'}</div>`;
    }).join('');
    this.set('slots', this.el.slots, 'html', slotsHtml);
    const st = { stand: '서기', crouch: '앉기', prone: '엎드림' }[p.body.stance] + (p.body.sprinting ? ' · 달리기' : '');
    this.set('stance', this.el.stance, 'text', st);
    // reload ring
    if (p.reloading) {
      const t = 1 - p.reloadT / Math.max(0.01, p.reloadTotal);
      this.el.reloadRing.style.opacity = 1;
      this.ring.style.strokeDashoffset = (100.5 * (1 - t)).toFixed(1);
    } else if (this.el.reloadRing.style.opacity !== '0') this.el.reloadRing.style.opacity = 0;
    // item use bar
    if (p.using) {
      this.set('use', this.el.useBar, 'opacity', '1');
      this.el.useFill.style.width = (p.using.t / p.using.dur * 100).toFixed(1) + '%';
      this.set('useTxt', this.el.useTxt, 'text', ITEMS[p.using.key].name + ' 사용 중… ' + Math.max(0, p.using.dur - p.using.t).toFixed(1) + 's');
    } else this.set('use', this.el.useBar, 'opacity', '0');
    // counters
    this.set('alive', this.el.aliveN, 'text', String(m.aliveCount()));
    this.set('kills', this.el.killN, 'text', String(p.kills));
    // zone text
    const z = m.zone;
    let zt;
    if (m.plane && !m.plane.left && !m.plane.done) zt = '수송기 비행 중 · 자기장 대기';
    else if (z.stage === 'wait') zt = `자기장 축소까지 ${Math.ceil(z.timer)}s`;
    else if (z.stage === 'shrink') zt = `자기장 축소 중 ${Math.ceil(z.timer)}s`;
    else zt = '최종 구역';
    const out = z.distOutside(p.body.pos.x, p.body.pos.z);
    if (out > 0) zt += ` · 안전구역까지 ${Math.ceil(out)}m`;
    this.set('zone', this.el.zoneTxt, 'text', zt);
    this.set('storm', this.el.stormTint, 'opacity', p.inStorm && p.alive ? '1' : '0');
    // ---- crosshair spread ----
    const spreadDeg = m.spreadDeg(p, w);
    const px = Math.max(3, Math.tan(spreadDeg * DEG) / Math.tan((g.camera.fov * DEG) / 2) * (innerHeight / 2));
    const gap = Math.round(px);
    const ch = this.el.crosshair;
    if (this.cache.gap !== gap) {
      this.cache.gap = gap;
      const [u, d, l, r] = ch.children;
      u.style.top = (-gap - 8) + 'px'; d.style.top = gap + 'px'; l.style.left = (-gap - 8) + 'px'; r.style.left = gap + 'px';
    }
    const adsCls = g.adsBlend > 0.6 && w.cat !== 'shotgun';
    if (this.cache.ads !== adsCls) { this.cache.ads = adsCls; ch.classList.toggle('ads', adsCls); }
    const hideCh = !p.alive || (p.body.sprinting && g.view === 'fps');
    if (this.cache.hideCh !== hideCh) { this.cache.hideCh = hideCh; ch.classList.toggle('hideAll', hideCh); }
    // hit marker
    if (this.hitT > 0) { this.hitT -= dt; this.el.hitmark.style.opacity = Math.max(0, this.hitT / 0.25).toFixed(2); }
    // hurt vignette + damage directions
    this.hurtA = Math.max(0, this.hurtA - dt * 1.4);
    const lowA = hp < 25 && p.alive ? 0.35 + Math.sin(performance.now() * 0.006) * 0.12 : 0;
    this.el.hurtTint.style.opacity = Math.max(this.hurtA, lowA).toFixed(2);
    for (let i = this.dirs.length - 1; i >= 0; i--) {
      const d = this.dirs[i];
      d.t -= dt;
      if (d.t <= 0) { d.el.remove(); this.dirs.splice(i, 1); continue; }
      const ang = Math.atan2(d.x - p.body.pos.x, -(d.z - p.body.pos.z)) - (-g.rig.yaw);
      d.el.style.transform = `rotate(${ang}rad)`;
      d.el.style.opacity = Math.min(1, d.t).toFixed(2);
    }
    // banner
    if (this.bannerT > 0) { this.bannerT -= dt; if (this.bannerT <= 0) this.el.banner.classList.remove('show'); }
    // compass
    const hd = HUD.heading(g.rig.yaw + g.rig.freeYaw);
    const W = this.el.compassStrip.parentElement.clientWidth;
    this.el.compassStrip.style.transform = `translateX(${(W / 2 - (hd + 360) * 3).toFixed(1)}px)`;
    // zone marker on compass: direction to next zone centre
    const zc = z.stage === 'done' ? z.cur : z.next;
    const zh = HUD.heading(Math.atan2(-(zc.x - p.body.pos.x), -(zc.z - p.body.pos.z)));
    let rel = ((zh - hd + 540) % 360) - 180;
    this.compZone.style.left = ((hd + 360 + rel) * 3) + 'px';
    this.compZone.style.opacity = out > -10 ? 1 : 0.35;
    if (g.marker) {
      const mh = HUD.heading(Math.atan2(-(g.marker.x - p.body.pos.x), -(g.marker.z - p.body.pos.z)));
      const mrel = ((mh - hd + 540) % 360) - 180;
      this.compMark.style.left = ((hd + 360 + mrel) * 3) + 'px';
      this.compMark.style.display = '';
    } else this.compMark.style.display = 'none';
    this.drawMinimap(g);
  }

  hit(head, kill) {
    this.hitT = kill ? 0.45 : 0.25;
    const hm = this.el.hitmark;
    hm.classList.toggle('kill', kill); hm.classList.toggle('head', head && !kill);
    hm.style.opacity = 1;
  }
  hurt(dmg, from) {
    this.hurtA = Math.min(0.8, this.hurtA + dmg / 40);
    if (from) {
      const el = document.createElement('div'); el.className = 'dd';
      this.el.dmgDirs.appendChild(el);
      this.dirs.push({ el, x: from.x, z: from.z, t: 1.6 });
      if (this.dirs.length > 6) { this.dirs[0].el.remove(); this.dirs.shift(); }
    }
  }
  banner(txt, cls = '', t = 2.6) {
    const b = this.el.banner;
    b.textContent = txt; b.className = 'show ' + cls; this.bannerT = t;
  }
  feed(html) {
    const d = document.createElement('div'); d.innerHTML = html;
    this.el.feed.prepend(d);
    while (this.el.feed.children.length > 5) this.el.feed.lastChild.remove();
    setTimeout(() => d.remove(), 7000);
  }
  prompt(html) {
    if (this.cache.prompt === html) return;
    this.cache.prompt = html;
    this.el.prompt.innerHTML = html || '';
    this.el.prompt.classList.toggle('show', !!html);
  }
  debug(text) { if (this.cache.dbg !== text) { this.cache.dbg = text; this.el.debug.firstChild ? this.el.debug.firstChild.textContent = text : this.el.debug.append(text); } }

  /* ---------------- minimap ---------------- */
  drawMinimap(g) {
    const cv = this.el.minimap, ctx = this.mm;
    const S = cv.width, p = g.me, m = g.match;
    const range = 70;                                  // metres from centre to edge
    const k = (S / 2) / range;
    const cx = p.body.pos.x, cz = p.body.pos.z;
    const heading = g.rig.yaw + g.rig.freeYaw;
    ctx.save();
    ctx.clearRect(0, 0, S, S);
    ctx.translate(S / 2, S / 2);
    // rotate so that "up" is where the player looks
    ctx.rotate(heading);
    const map = g.mapImage;
    if (map) {
      const half = g.world.half, sc = map.width / (half * 2);
      ctx.drawImage(map, (cx + half) * sc - range * 1.5 * sc, (cz + half) * sc - range * 1.5 * sc, range * 3 * sc, range * 3 * sc,
        -range * 1.5 * k, -range * 1.5 * k, range * 3 * k, range * 3 * k);
    }
    this.drawZone(ctx, m.zone, (x, z) => [(x - cx) * k, (z - cz) * k], k);
    this.drawRoute(ctx, g, (x, z) => [(x - cx) * k, (z - cz) * k]);
    // dead / alive markers of recent gunfire (sound cue)
    for (const e of g.recentShots) {
      const a = 1 - (g.time - e.t) / 3;
      if (a <= 0) continue;
      ctx.fillStyle = `rgba(255,120,60,${a.toFixed(2)})`;
      ctx.beginPath(); ctx.arc((e.x - cx) * k, (e.z - cz) * k, 4, 0, 6.28); ctx.fill();
    }
    ctx.restore();
    // player arrow (always pointing up)
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.fillStyle = '#f2a33a'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(6, 7); ctx.lineTo(0, 3); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    // north marker
    ctx.save(); ctx.translate(S / 2, S / 2); ctx.rotate(heading);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('N', 0, -S / 2 + 14); ctx.restore();
  }

  drawZone(ctx, z, tp, k) {
    const [x0, y0] = tp(z.cur.x, z.cur.z);
    // storm outside current circle
    ctx.save();
    ctx.beginPath(); ctx.rect(-4000, -4000, 8000, 8000); ctx.arc(x0, y0, z.cur.r * k, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(40,90,220,0.35)'; ctx.fill('evenodd');
    ctx.beginPath(); ctx.arc(x0, y0, z.cur.r * k, 0, Math.PI * 2); ctx.strokeStyle = '#3d8cff'; ctx.lineWidth = 2; ctx.stroke();
    if (z.stage !== 'done') {
      const [x1, y1] = tp(z.next.x, z.next.z);
      ctx.beginPath(); ctx.arc(x1, y1, Math.max(1, z.next.r * k), 0, Math.PI * 2); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
  }

  /** plane route + plane + destination marker */
  drawRoute(ctx, g, tp, big = false) {
    const pl = g.match.plane;
    if (pl && !pl.done && (g.me.air === 'plane' || !pl.left)) {
      const [ax, ay] = tp(pl.ax, pl.az), [bx, by] = tp(pl.bx, pl.bz);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = big ? 2 : 1.5; ctx.setLineDash([7, 6]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
      const [px, py] = tp(pl.x, pl.z);
      ctx.translate(px, py); ctx.rotate(-pl.yaw);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
      const s = big ? 1.4 : 1;
      ctx.beginPath(); ctx.moveTo(0, -9 * s); ctx.lineTo(2 * s, -2 * s); ctx.lineTo(9 * s, 1 * s); ctx.lineTo(2 * s, 2 * s); ctx.lineTo(1.5 * s, 7 * s); ctx.lineTo(4 * s, 9 * s);
      ctx.lineTo(-4 * s, 9 * s); ctx.lineTo(-1.5 * s, 7 * s); ctx.lineTo(-2 * s, 2 * s); ctx.lineTo(-9 * s, 1 * s); ctx.lineTo(-2 * s, -2 * s); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    if (g.marker) {
      const [x, y] = tp(g.marker.x, g.marker.z);
      ctx.save();
      ctx.fillStyle = '#ffd24a'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
      const s = big ? 1.4 : 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 5 * s, y - 9 * s); ctx.arc(x, y - 11 * s, 5.5 * s, Math.PI * 0.8, Math.PI * 0.2); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }

  /* ---------------- full map ---------------- */
  drawBigMap(g) {
    const cv = this.el.bigmapCv, ctx = cv.getContext('2d');
    const S = cv.width, half = g.world.half, k = S / (half * 2);
    const tp = (x, z) => [(x + half) * k, (z + half) * k];
    ctx.clearRect(0, 0, S, S);
    if (g.mapImage) ctx.drawImage(g.mapImage, 0, 0, S, S);
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) { const v = (S / 8) * i; ctx.beginPath(); ctx.moveTo(v, 0); ctx.lineTo(v, S); ctx.moveTo(0, v); ctx.lineTo(S, v); ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = '12px sans-serif';
    for (let i = 0; i < 8; i++) { ctx.fillText(String.fromCharCode(65 + i), (S / 8) * i + 4, 14); ctx.fillText(String(i + 1), 4, (S / 8) * i + 28); }
    ctx.save(); this.drawZone(ctx, g.match.zone, tp, k); ctx.restore();
    this.drawRoute(ctx, g, tp, true);
    ctx.textAlign = 'center';
    for (const L of g.world.locations) {
      const [x, y] = tp(L.x, L.z);
      ctx.font = 'bold 14px sans-serif'; ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(L.name, x + 1, y + 1);
      ctx.fillStyle = '#fff'; ctx.fillText(L.name, x, y);
    }
    const p = g.me;
    const [px, py] = tp(p.body.pos.x, p.body.pos.z);
    ctx.save(); ctx.translate(px, py); ctx.rotate(-g.rig.yaw);
    ctx.fillStyle = '#f2a33a'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(8, 9); ctx.lineTo(0, 4); ctx.lineTo(-8, 9); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    if (g.showAllOnMap) {
      for (const o of g.match.players) {
        if (o === p || !o.alive) continue;
        const [x, y] = tp(o.body.pos.x, o.body.pos.z);
        ctx.fillStyle = '#ff5a4a'; ctx.beginPath(); ctx.arc(x, y, 4, 0, 6.28); ctx.fill();
      }
      for (const it of g.match.items) { const [x, y] = tp(it.x, it.z); ctx.fillStyle = 'rgba(255,230,120,.8)'; ctx.fillRect(x - 1, y - 1, 2, 2); }
    }
  }

  /* ---------------- inventory ---------------- */
  renderInventory(g) {
    const p = g.me, m = g.match;
    const near = m.items.filter((it) => Math.hypot(it.x - p.body.pos.x, it.z - p.body.pos.z) < 3.2 && Math.abs(it.y - p.body.pos.y) < 2.2);
    const itemRow = (key, count, extra, attrs) => {
      const it = ITEMS[key] || { name: key, color: '#888' };
      return `<div class="it" ${attrs}><i style="background:${it.color}"></i><span>${it.name}</span><em>${extra || ''}${count > 1 ? ' ×' + count : ''}</em></div>`;
    };
    this.el.invGround.innerHTML = near.length ? near.map((it) => itemRow(it.key, it.count, ITEMS[it.key].kind === 'weapon' ? WEAPONS[it.key].catName : '', `data-g="${it.id}"`)).join('') : '<div class="it empty"><span>주변에 아이템 없음</span></div>';
    const keys = Object.keys(p.inv.items);
    this.el.invBag.innerHTML = keys.length ? keys.map((k) => itemRow(k, p.inv.items[k], ITEMS[k].kind === 'heal' ? '사용 ' + ITEMS[k].useTime + 's' : '', `data-b="${k}"`)).join('') : '<div class="it empty"><span>비어 있음</span></div>';
    this.el.invSlots.innerHTML = [0, 1, 2].map((i) => {
      const s = p.slots[i];
      if (!s) return `<div class="it empty"><span>${i + 1}. —</span></div>`;
      const w = WEAPONS[s.id];
      return `<div class="it" data-s="${i}"><i style="background:${w.ammo ? AMMO[w.ammo].color : '#ccc'}"></i><span>${i + 1}. ${w.name}</span><em>${w.catName} · ${s.mag}/${w.mag}</em></div>`;
    }).join('');
    const wt = invWeight(p.inv);
    this.el.invWeight.textContent = `${wt.toFixed(0)} / ${p.inv.capacity}`;
    this.el.invWFill.style.width = Math.min(100, wt / p.inv.capacity * 100) + '%';
  }
}
