import type { PlayerController } from '../player/PlayerController';

// Host side: where everyone was a moment ago. A remote player aims at what
// its screen showed (the others as the host saw them ~RTT/2 + the
// interpolation delay earlier); before resolving that player's round, the
// host puts every other combatant back where it was at that time, fires,
// and restores them.

/** How far back a round may be resolved (s): older views get the oldest kept positions. */
export const MAX_REWIND = 0.3;
const KEEP = 0.6;
/** Moving further than this between two ticks is a teleport (m). */
const TELEPORT = 3;

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  h: number;
}

export class LagCompensation {
  private readonly tracks = new Map<string, { controller: PlayerController; samples: Sample[] }>();

  /** Records `controller` (combatant `id`) at host time `t`. */
  record(id: string, controller: PlayerController, t: number): void {
    let track = this.tracks.get(id);
    if (!track || track.controller !== controller) {
      track = { controller, samples: [] };
      this.tracks.set(id, track);
    }
    const s = track.samples;
    const p = controller.position;
    const last = s.at(-1);
    // A jump (respawn / teleport): nobody saw it travel, so its old places are no longer where it was.
    if (last && Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) > TELEPORT) s.length = 0;
    s.push({ t, x: p.x, y: p.y, z: p.z, h: controller.height });
    while (s.length > 2 && s[0].t < t - KEEP) s.shift();
  }

  forget(id: string): void {
    this.tracks.delete(id);
  }

  clear(): void {
    this.tracks.clear();
  }

  /**
   * Runs `fn` with every tracked combatant except `except` moved back to
   * host time `at` (clamped to MAX_REWIND before `now`), then puts them back.
   */
  rewind<T>(at: number, now: number, except: string, fn: () => T): T {
    const when = Math.min(now, Math.max(at, now - MAX_REWIND));
    const restore: (() => void)[] = [];
    for (const [id, track] of this.tracks) {
      if (id === except || track.samples.length === 0) continue;
      const p = sampleAt(track.samples, when);
      const c = track.controller;
      const old = { x: c.position.x, y: c.position.y, z: c.position.z, h: c.height };
      c.position.set(p.x, p.y, p.z);
      c.height = p.h;
      restore.push(() => {
        c.position.set(old.x, old.y, old.z);
        c.height = old.h;
      });
    }
    try {
      return fn();
    } finally {
      for (const r of restore) r();
    }
  }
}

function sampleAt(s: readonly Sample[], t: number): Sample {
  if (t <= s[0].t) return s[0];
  const last = s[s.length - 1];
  if (t >= last.t) return last;
  for (let i = s.length - 1; i > 0; i--) {
    const a = s[i - 1];
    const b = s[i];
    if (a.t <= t && t <= b.t) {
      const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, h: a.h + (b.h - a.h) * k };
    }
  }
  return last;
}
