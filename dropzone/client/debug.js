/* =========================================================================
   Developer tools (DEV builds only — server sends BUILD.dev=false in release,
   and this module is then never activated).
     F3 overlay  F4 collision boxes  F2 show players/items on map
     F6 god mode  F7 infinite ammo  F8 teleport to crosshair  F9 give weapons
     F10 kill all bots  (zone skip button in the overlay)
   ========================================================================= */

export class DevTools {
  constructor(app) {
    this.app = app;
    this.visible = false;
    this.flags = { boxes: false, map: false, god: false, ammo: false };
    this.el = document.getElementById('debug');
    this.el.innerHTML = '<span></span><div class="dbtn"></div>';
    this.txt = this.el.firstChild;
    const bar = this.el.lastChild;
    const btn = (label, fn, flag) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = (e) => { e.stopPropagation(); fn(); if (flag) b.classList.toggle('on', this.flags[flag]); };
      bar.appendChild(b);
      return b;
    };
    btn('BOX', () => this.toggleBoxes(), 'boxes');
    btn('MAP', () => { this.flags.map = !this.flags.map; }, 'map');
    btn('GOD', () => this.cheat('god'), 'god');
    btn('AMMO', () => this.cheat('ammo'), 'ammo');
    btn('TP', () => this.teleport());
    btn('GIVE', () => this.give());
    btn('ZONE▶', () => this.run('zone'));
    btn('SUPPLY', () => this.run('supply'));
    btn('CAR', () => this.run('vehicle', ['sedan', 'suv', 'moto', 'buggy'][(this.carI = ((this.carI || 0) + 1) % 4)]));
    btn('KILL BOTS', () => this.run('killbots'));
    this.fpsAcc = 0; this.frames = 0; this.fps = 0; this.worst = 0; this.worstShown = 0;
  }

  get session() { return this.app.session; }
  // cheats only touch a local match: online, the server is the authority
  run(what, arg) { const s = this.session; if (s && !s.online) s.match.cheat(s.me.id, what, arg); }
  cheat(what) { this.flags[what] = !this.flags[what]; this.run(what); }
  toggleBoxes() { this.flags.boxes = !this.flags.boxes; this.app.worldView.toggleDebugBoxes(this.flags.boxes); }
  teleport() { const s = this.session; if (!s || !s.lastAimPoint) return; const a = s.lastAimPoint; this.run('tp', { x: a.x, y: a.y + 0.5, z: a.z }); }
  give() { for (const k of ['kestrel', 'wasp', 'hornet', 'ammo_light', 'ammo_pistol', 'ammo_light', 'bandage', 'medkit']) this.run('give', k); }

  handleKeys(input) {
    if (input.consume('devF3')) { this.visible = !this.visible; this.el.classList.toggle('hide', !this.visible); }
    if (input.consume('devF4')) this.toggleBoxes();
    if (input.consume('devF2')) this.flags.map = !this.flags.map;
    if (input.consume('devF6')) this.cheat('god');
    if (input.consume('devF7')) this.cheat('ammo');
    if (input.consume('devF8')) this.teleport();
    if (input.consume('devF9')) this.give();
    if (input.consume('devF10')) this.run('killbots');
    const bs = this.el.querySelectorAll('.dbtn button');
    if (bs.length) { bs[0].classList.toggle('on', this.flags.boxes); bs[1].classList.toggle('on', this.flags.map); bs[2].classList.toggle('on', this.flags.god); bs[3].classList.toggle('on', this.flags.ammo); }
  }

  frame(dt) {
    this.fpsAcc += dt; this.frames++;
    this.worst = Math.max(this.worst, dt);
    if (this.fpsAcc >= 0.5) { this.fps = this.frames / this.fpsAcc; this.fpsAcc = 0; this.frames = 0; this.worstShown = this.worst; this.worst = 0; }
    if (!this.visible) return;
    const s = this.session, r = this.app.renderer;
    if (!s) return;
    const p = s.me, m = s.match, z = m.zone;
    const info = r.info;
    const bots = m.players.filter((o) => o.isBot);
    const states = {};
    for (const b of bots) if (b.alive && b.brain) states[b.brain.state] = (states[b.brain.state] || 0) + 1;
    this.txt.textContent = [
      `FPS ${this.fps.toFixed(0)}  worst ${(this.worstShown * 1000).toFixed(1)}ms  sim ${(s.simMs).toFixed(2)}ms/tick`,
      s.online ? `PING ${Math.round(s.net.ping)} ms   TICK 60 Hz  #${m.tick}   NET: ONLINE (server authority)  snaps ${s.snaps.length}  unacked ${s.history.length}  corr ${(s.predErr || 0).toFixed(3)}m`
        : `PING — (offline)   TICK 60 Hz  #${m.tick}   NET: OFFLINE (local authority)`,
      `draw ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(1)}k  geo ${info.memory.geometries}  tex ${info.memory.textures}`,
      `pos ${p.body.pos.x.toFixed(1)}, ${p.body.pos.y.toFixed(1)}, ${p.body.pos.z.toFixed(1)}  ${p.body.stance}${p.body.onGround ? '' : ' AIR'}  v ${p.body.moveSpeed.toFixed(2)}`,
      `yaw ${(s.rig.yaw * 57.3).toFixed(1)}  pitch ${(s.rig.pitch * 57.3).toFixed(1)}  spread ${m.spreadDeg(p, m.weaponOf(p)).toFixed(2)}°`,
      `zone p${z.phase} ${z.stage} ${z.timer.toFixed(1)}s  cur(${z.cur.x.toFixed(0)},${z.cur.z.toFixed(0)} r${z.cur.r.toFixed(0)}) dps ${z.dps}`,
      `bots ${bots.filter((b) => b.alive).length}/${bots.length}  ${Object.entries(states).map(([k, v]) => k + ':' + v).join(' ')}`,
      `items ${m.items.length}  bullets ${m.bullets.length}  quality ${this.app.settings.quality}`,
      `F2 map  F4 boxes  F6 god  F7 ammo  F8 tp  F9 give  F10 kill bots`
    ].join('\n');
  }
}
