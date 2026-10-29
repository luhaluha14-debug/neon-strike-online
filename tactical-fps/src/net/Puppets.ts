import * as THREE from 'three';
import { AgentModel } from '../ai/AgentModel';
import { BotKit, BotModel, type BotBody, type BotPose } from '../ai/BotModel';
import type { BotLook } from '../ai/BotSquad';
import type { EntityState } from './GameMessages';

// A multiplayer client's view of everyone else: the bodies of the other
// players and of the host's bots, drawn where the host's snapshots put them,
// INTERP_DELAY behind (smooth between two snapshots instead of jumping).

export const INTERP_DELAY = 0.1;
const KEEP = 1;

interface Sample {
  t: number;
  e: EntityState;
}

export interface Puppet {
  readonly id: string;
  team: string;
  readonly model: BotBody;
  readonly samples: Sample[];
  /** Interpolated state of the last update. */
  readonly position: THREE.Vector3;
  yaw: number;
  pitch: number;
  height: number;
  alive: boolean;
}

const _pose: BotPose = {
  feet: new THREE.Vector3(),
  yaw: 0,
  pitch: 0,
  velocity: new THREE.Vector3(),
  grounded: true,
  aiming: false,
  alive: true,
  deadTime: 0,
};

export class Puppets {
  readonly group = new THREE.Group();
  readonly all = new Map<string, Puppet>();
  private readonly kits = new Map<string, BotKit>();

  constructor(private readonly look: BotLook) {
    this.group.name = 'NetPuppets';
  }

  /** A snapshot from the host at host time `t` (`me`: this player's own id, not drawn). */
  push(t: number, entities: readonly EntityState[], me: string | null): void {
    const seen = new Set<string>();
    for (const e of entities) {
      const id = e[0];
      if (id === me) continue;
      seen.add(id);
      let p = this.all.get(id);
      if (p && p.team !== e[13]) {
        this.remove(id);
        p = undefined;
      }
      p ??= this.add(id, e[13]);
      const last = p.samples.at(-1);
      if (last && last.t >= t) continue;
      p.samples.push({ t, e });
      while (p.samples.length > 2 && p.samples[0].t < t - KEEP) p.samples.shift();
    }
    for (const id of [...this.all.keys()]) if (!seen.has(id)) this.remove(id);
  }

  /** Poses every body at host time `at`. */
  update(dt: number, at: number): void {
    for (const p of this.all.values()) {
      const s = p.samples;
      if (!s.length) continue;
      let a = s[0];
      let b = s[0];
      for (let i = s.length - 1; i >= 0; i--) {
        if (s[i].t <= at) {
          a = s[i];
          b = s[Math.min(i + 1, s.length - 1)];
          break;
        }
      }
      const k = b.t > a.t ? THREE.MathUtils.clamp((at - a.t) / (b.t - a.t), 0, 1) : 1;
      const ea = a.e;
      const eb = b.e;
      p.position.set(lerp(ea[1], eb[1], k), lerp(ea[2], eb[2], k), lerp(ea[3], eb[3], k));
      p.yaw = lerpAngle(ea[4], eb[4], k);
      p.pitch = lerp(ea[5], eb[5], k);
      p.height = lerp(ea[6], eb[6], k);
      const flags = eb[9];
      p.alive = (flags & 1) !== 0;
      _pose.feet.copy(p.position);
      _pose.yaw = p.yaw;
      _pose.pitch = p.pitch;
      _pose.velocity.set(lerp(ea[7], eb[7], k), 0, lerp(ea[8], eb[8], k));
      _pose.grounded = (flags & 2) !== 0;
      _pose.aiming = (flags & 4) !== 0 && p.alive;
      _pose.alive = p.alive;
      _pose.deadTime = eb[12];
      p.model.update(dt, _pose);
    }
  }

  /** World position of a body's muzzle (tracer start), or null. */
  muzzle(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const p = this.all.get(id);
    if (!p) return null;
    p.model.object.updateMatrixWorld(true);
    return p.model.muzzle.getWorldPosition(out);
  }

  clear(): void {
    for (const id of [...this.all.keys()]) this.remove(id);
  }

  dispose(): void {
    this.clear();
    for (const k of this.kits.values()) k.dispose();
    this.kits.clear();
    this.group.removeFromParent();
  }

  private add(id: string, team: string): Puppet {
    let kit = this.kits.get(team);
    if (!kit) {
      kit = new BotKit(team || undefined);
      this.kits.set(team, kit);
    }
    const model: BotBody = (this.look === 'agents' && AgentModel.create(team || undefined, kit)) || new BotModel(kit);
    model.object.name = id;
    this.group.add(model.object);
    const p: Puppet = { id, team, model, samples: [], position: new THREE.Vector3(), yaw: 0, pitch: 0, height: 1.8, alive: true };
    this.all.set(id, p);
    return p;
  }

  private remove(id: string): void {
    const p = this.all.get(id);
    if (!p) return;
    p.model.object.removeFromParent();
    p.model.dispose();
    this.all.delete(id);
  }
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
