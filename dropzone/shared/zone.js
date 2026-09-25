/* =========================================================================
   Safe zone ("the storm wall").  Server authoritative; clients only render.
   ========================================================================= */

export const ZONE_PHASES = [
  { wait: 70, shrink: 45, r: 92, dps: 1 },
  { wait: 50, shrink: 35, r: 55, dps: 2 },
  { wait: 40, shrink: 30, r: 30, dps: 4 },
  { wait: 30, shrink: 25, r: 14, dps: 7 },
  { wait: 22, shrink: 20, r: 5, dps: 11 },
  { wait: 15, shrink: 18, r: 0, dps: 18 }
];

export class Zone {
  constructor(rng, limit, phases = ZONE_PHASES) {
    this.rng = rng;
    this.limit = limit;
    this.phases = phases;
    this.phase = 0;
    this.stage = 'wait';           // wait | shrink | done
    this.timer = phases[0].wait;
    this.cur = { x: 0, z: 0, r: limit * 1.5 };
    this.from = { ...this.cur };
    this.next = this.pickNext(this.cur, phases[0].r);
  }

  pickNext(c, r) {
    const room = Math.max(0, c.r - r);
    for (let tries = 0; tries < 30; tries++) {
      const a = this.rng.next() * Math.PI * 2, d = Math.sqrt(this.rng.next()) * room;
      const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
      const lim = this.limit - Math.min(r, this.limit * 0.5) - 6;
      if (Math.abs(x) <= lim && Math.abs(z) <= lim) return { x, z, r };
    }
    const lim = this.limit - r - 6;
    return { x: Math.max(-lim, Math.min(lim, c.x)), z: Math.max(-lim, Math.min(lim, c.z)), r };
  }

  get dps() { return this.phases[Math.min(this.phase, this.phases.length - 1)].dps; }

  update(dt) {
    if (this.stage === 'done') return null;
    this.timer -= dt;
    let ev = null;
    if (this.stage === 'wait') {
      if (this.timer <= 0) {
        this.stage = 'shrink';
        this.timer = this.phases[this.phase].shrink;
        this.from = { ...this.cur };
        ev = 'shrink';
      }
    } else if (this.stage === 'shrink') {
      const P = this.phases[this.phase];
      const t = 1 - Math.max(0, this.timer) / P.shrink;
      this.cur.x = this.from.x + (this.next.x - this.from.x) * t;
      this.cur.z = this.from.z + (this.next.z - this.from.z) * t;
      this.cur.r = this.from.r + (this.next.r - this.from.r) * t;
      if (this.timer <= 0) {
        this.cur = { ...this.next };
        this.phase++;
        if (this.phase >= this.phases.length) { this.stage = 'done'; this.timer = 0; ev = 'final'; }
        else {
          this.stage = 'wait';
          this.timer = this.phases[this.phase].wait;
          this.next = this.pickNext(this.cur, this.phases[this.phase].r);
          ev = 'wait';
        }
      }
    }
    return ev;
  }

  isInside(x, z, margin = 0) {
    const dx = x - this.cur.x, dz = z - this.cur.z;
    return dx * dx + dz * dz <= Math.max(0, this.cur.r - margin) ** 2;
  }
  distOutside(x, z) { return Math.hypot(x - this.cur.x, z - this.cur.z) - this.cur.r; }

  snapshot() {
    return { phase: this.phase, stage: this.stage, timer: this.timer, cur: { ...this.cur }, next: { ...this.next }, dps: this.dps };
  }
}
