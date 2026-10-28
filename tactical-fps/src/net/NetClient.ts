import * as THREE from 'three';
import type { GrenadeKind } from '../combat/Grenades';
import type { PlayerCombat } from '../player/PlayerCombat';
import type { PlayerController } from '../player/PlayerController';
import { isToClient, r2, r3, v3, type ToClient, type ToHost } from './GameMessages';
import type { BombStateMsg, MatchState, TeamMatchState } from './Mirror';
import type { NetSession } from './NetSession';
import { INTERP_DELAY, Puppets } from './Puppets';

// A room member's side of a multiplayer match (not the host): the game runs
// this player's own character (movement, weapon, view) as in single player
// and reports it to the host; everyone else is drawn from the host's
// snapshots (Puppets), and the match, health, deaths, spawns and money are
// what the host says. Damage is never worked out here.

const STATE_RATE = 30;

/** What NetClient needs from the game (Game implements it). */
export interface ClientGame {
  readonly player: PlayerController | null;
  readonly combat: PlayerCombat | null;
  /** Weapon in hand (catalog / weapon id). */
  readonly netWeaponId: string;
  readonly netAiming: boolean;
  readonly netUse: boolean;
  /** The host's mode / map: switch to it (loads the map if needed); resolves when ready to play. */
  netMode(mode: 'deathmatch' | 'team', map: string): Promise<void>;
  netYou(id: string, team: string | null): void;
  netMatch(m: MatchState | TeamMatchState, bomb: BombStateMsg | null): void;
  netSpawn(m: Extract<ToClient, { k: 'spawn' }>): void;
  netHurt(m: Extract<ToClient, { k: 'hurt' }>): void;
  netFx(m: Extract<ToClient, { k: 'fx' }>, muzzle: THREE.Vector3 | null, mine: boolean): void;
  netHit(m: Extract<ToClient, { k: 'hit' }>): void;
  netThrow(m: Extract<ToClient, { k: 'throw' }>): void;
  netBuy(m: Extract<ToClient, { k: 'buy' }>): void;
  netBoom(m: Extract<ToClient, { k: 'boom' }>): void;
  netRestart(): void;
}

const _muzzle = new THREE.Vector3();

export class NetClient {
  /** This player's character id in the host's match (null until the host assigns one). */
  myId: string | null = null;
  team: string | null = null;
  private spawnSeq = 0;
  private stateTimer = 0;
  /** Host clock − local clock, estimated from snapshots (the fastest arrivals). */
  private offset: number | null = null;
  private modeKey = '';
  private buyN = 0;
  readonly puppets: Puppets;

  constructor(
    private readonly game: ClientGame,
    private readonly session: NetSession,
    look: 'procedural' | 'agents',
  ) {
    this.puppets = new Puppets(look);
  }

  /** Local clock (s). */
  private local(): number {
    return performance.now() / 1000;
  }

  /** Host time this screen shows the others at (snapshot time − interpolation delay). */
  renderTime(): number {
    return this.local() + (this.offset ?? 0) - INTERP_DELAY;
  }

  /** Game id of a wire id: this player's character is 'local'. */
  id(wire: string): string {
    return wire === this.myId ? 'local' : wire;
  }

  /** A message from the host. */
  receive(d: unknown): void {
    if (!isToClient(d)) return;
    switch (d.k) {
      case 'mode': {
        // The same mode again (host restart): the host gives this player its character itself.
        const key = `${d.mode}|${d.map}`;
        if (key === this.modeKey) return;
        this.modeKey = key;
        this.myId = null;
        void this.game.netMode(d.mode, d.map).then(() => this.send({ k: 'hi' }));
        break;
      }
      case 'you':
        this.myId = d.id;
        this.team = d.team;
        this.game.netYou(d.id, d.team);
        break;
      case 'snap': {
        const sample = d.t - this.local();
        // The fastest snapshot shows the clock difference best; drift slowly toward later ones.
        this.offset = this.offset === null || sample > this.offset ? sample : this.offset + (sample - this.offset) * 0.002;
        this.puppets.push(d.t, d.e, this.myId);
        const me = this.myId ? d.e.find((e) => e[0] === this.myId) : undefined;
        if (me && this.game.combat) this.game.combat.setFromHost(me[10], me[11], (me[9] & 1) !== 0, me[12]);
        break;
      }
      case 'match':
        this.game.netMatch(d.m, d.bomb);
        break;
      case 'spawn':
        this.spawnSeq = d.sp;
        this.game.netSpawn(d);
        break;
      case 'hurt':
        this.game.netHurt(d);
        break;
      case 'fx': {
        const mine = d.by === this.myId;
        this.game.netFx(d, mine ? null : this.puppets.muzzle(d.by, _muzzle), mine);
        break;
      }
      case 'hit':
        this.game.netHit(d);
        break;
      case 'throw':
        this.game.netThrow(d);
        break;
      case 'buy':
        if (d.n === this.buyN) this.game.netBuy(d);
        break;
      case 'boom':
        this.game.netBoom(d);
        break;
      case 'restart':
        this.puppets.clear();
        this.game.netRestart();
        break;
      default:
        break;
    }
  }

  /** The host changed: wait for the new host's mode, then say hi again. */
  hostChanged(): void {
    this.myId = null;
    this.modeKey = '';
    this.puppets.clear();
  }

  /** Per frame: bodies of the others, and this player's report to the host. */
  update(dt: number): void {
    this.puppets.update(dt, this.renderTime());
    this.stateTimer -= dt;
    if (this.stateTimer > 0 || !this.myId) return;
    this.stateTimer = 1 / STATE_RATE;
    const p = this.game.player;
    if (!p || !this.game.combat?.alive) return;
    this.send({
      k: 'st',
      sp: this.spawnSeq,
      p: v3(p.position),
      v: v3(p.velocity),
      yaw: r3(p.yaw),
      pitch: r3(p.pitch),
      h: r2(p.height),
      g: p.grounded ? 1 : 0,
      crouch: p.crouching ? 1 : 0,
      aim: this.game.netAiming ? 1 : 0,
      use: this.game.netUse ? 1 : 0,
      w: this.game.netWeaponId,
    });
  }

  /** A round this player fired (one per pellet): the host resolves it. */
  shot(weaponId: string, origin: THREE.Vector3, dir: THREE.Vector3): void {
    if (!this.myId) return;
    this.send({ k: 'shot', w: weaponId, o: v3(origin), d: [r3(dir.x), r3(dir.y), r3(dir.z)], rt: r3(this.renderTime()) });
  }

  buy(id: string): void {
    this.send({ k: 'buy', id, n: ++this.buyN });
  }

  throwGrenade(kind: GrenadeKind, eye: THREE.Vector3, dir: THREE.Vector3, carry: THREE.Vector3): void {
    this.send({ k: 'throw', kind, eye: v3(eye), dir: [r3(dir.x), r3(dir.y), r3(dir.z)], carry: v3(carry) });
  }

  dispose(): void {
    this.puppets.dispose();
  }

  private send(m: ToHost): void {
    this.session.send(m);
  }
}
