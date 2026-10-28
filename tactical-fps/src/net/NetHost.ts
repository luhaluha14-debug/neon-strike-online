import * as THREE from 'three';
import type { Bot, RemoteControl } from '../ai/Bot';
import type { BotSquad } from '../ai/BotSquad';
import type { HitscanResult, HitscanSystem } from '../combat/HitscanSystem';
import type { GrenadeSystem } from '../combat/Grenades';
import { PLAYER_CONFIG } from '../config';
import type { BombObjective } from '../game/BombObjective';
import { BuyLoadout, LOADOUT_RULES } from '../game/Economy';
import type { Match } from '../game/Match';
import type { TeamMatch } from '../game/TeamMatch';
import type { PlayerCombat, PlayerDamageEvent } from '../player/PlayerCombat';
import type { PlayerController } from '../player/PlayerController';
import type { WeaponDefinition } from '../weapons/WeaponDefinition';
import { DEFAULT_LOADOUT, WEAPONS } from '../weapons/weapons';
import { r2, r3, v3, validV3, isToHost, type EntityState, type ToClient, type ToHost, type V3 } from './GameMessages';
import { LagCompensation } from './LagCompensation';
import { bombState, matchState, teamMatchState } from './Mirror';
import type { NetSession } from './NetSession';

// The room host's side of a multiplayer match. The host's game runs the
// whole match as in single player; each other member plays one of its bots
// (Bot.remote): the member's browser moves that character and reports it,
// the host checks the report is plausible, resolves the member's shots
// against everyone as the member saw them (lag compensation), takes care
// of its purchases, grenades and spawns, and sends everyone the state of
// all combatants and of the match.

/** Snapshots and match state per second. */
const SNAP_RATE = 20;
const MATCH_RATE = 4;
/** Horizontal speed a member's character may move at (m/s, run speed with slack); faster reports are refused and the member put back. */
const MAX_SPEED = 9;
/** Rounds a member may fire at once beyond its weapon's rate (bunched network delivery). */
const SHOT_BURST = 8;
/** A shot's origin must be this close to the character's eye on the host (m). */
const MAX_ORIGIN_OFFSET = 3;

/** What NetHost needs from the game (Game implements it). */
export interface HostGame {
  readonly mode: string;
  readonly squad: BotSquad | null;
  readonly match: Match | null;
  readonly teamMatch: TeamMatch | null;
  readonly bomb: BombObjective | null;
  readonly hitscan: HitscanSystem | null;
  readonly grenades: GrenadeSystem | null;
  readonly player: PlayerController | null;
  readonly combat: PlayerCombat | null;
  readonly mapId: string;
  /** The host player is aiming down the sights (body pose on the others' screens). */
  readonly netAiming: boolean;
  /** A round fired by a remote player, resolved here: the host's own effects for it. */
  showNetShot(bot: Bot, weapon: WeaponDefinition, origin: THREE.Vector3, dir: THREE.Vector3, result: HitscanResult): void;
}

class RemotePlayer implements RemoteControl {
  bot: Bot | null = null;
  botName = '';
  aiming = false;
  spawnSeq = 0;
  latest: Extract<ToHost, { k: 'st' }> | null = null;
  /** The host just put the character somewhere (spawn / correction): reports start from there. */
  placed(): void {
    this.acceptedAt = performance.now();
  }

  /** The report already on the character (applied once). */
  private applied: Extract<ToHost, { k: 'st' }> | null = null;
  /** The member's report is too far off: put it back where the host has it. */
  correct = false;
  readonly buy = new BuyLoadout();
  /** Rounds that may still be fired right now (refills at the weapon's rate). */
  shotTokens = SHOT_BURST;
  shotTime = 0;
  /** Armour kept across the coming round start (team match survivor). */
  keepArmor: number | null = null;
  roundSpawn = false;

  constructor(
    readonly id: string,
    public name: string,
  ) {}

  /**
   * Real time (ms) a report was last accepted: how far the character may have moved since. Real time,
   * not simulated: a slow or stalled host must not refuse a member's honest movement.
   */
  private acceptedAt = performance.now();

  apply(bot: Bot): void {
    const s = this.latest;
    if (!s) return;
    const c = bot.controller;
    // No faster than a running player (with slack for timing); any fall is fine, climbing only a jump's worth.
    const horizontal = Math.hypot(s.p[0] - c.position.x, s.p[2] - c.position.z);
    const up = s.p[1] - c.position.y;
    const now = performance.now();
    const reach = (MAX_SPEED * (now - this.acceptedAt)) / 1000;
    if (horizontal > 1 + reach || up > 1.5 + reach) {
      this.correct = true;
      this.latest = null;
      return;
    }
    if (s === this.applied) return;
    this.applied = s;
    this.acceptedAt = now;
    c.position.set(s.p[0], s.p[1], s.p[2]);
    c.velocity.set(s.v[0], s.v[1], s.v[2]);
    c.yaw = s.yaw;
    c.pitch = THREE.MathUtils.clamp(s.pitch, -1.6, 1.6);
    c.height = THREE.MathUtils.clamp(s.h, PLAYER_CONFIG.crouchHeight, PLAYER_CONFIG.standHeight);
    c.crouching = s.crouch === 1;
    c.grounded = s.g === 1;
    this.aiming = s.aim === 1;
    bot.useKey = s.use === 1;
  }
}

export class NetHost {
  readonly members = new Map<string, RemotePlayer>();
  private readonly lag = new LagCompensation();
  /** Remote rounds by outcome: miss / world / target, or why they were refused (F3, tests). */
  readonly shotStats: Record<string, number> = {};
  private snapTimer = 0;
  private matchTimer = 0;
  private lastMatchKey = '';
  private stopped = false;
  private readonly epoch = performance.now();

  constructor(
    private readonly game: HostGame,
    private readonly session: NetSession,
  ) {}

  /** Host clock (s). */
  now(): number {
    return (performance.now() - this.epoch) / 1000;
  }

  /** Wire id of a game id (the host's own player is its member id). */
  wire(id: string): string {
    return id === 'local' ? (this.session.id ?? 'host') : id;
  }

  private nameOf = (id: string, name: string): string => (id === 'local' ? this.session.name || name : name);

  /** Tells every member the room's mode / map (they load it and say 'hi'). */
  announce(to?: string): void {
    const mode = this.game.mode === 'team' ? 'team' : 'deathmatch';
    this.send({ k: 'mode', mode, map: this.game.mapId }, to);
  }

  /** A message from a member. */
  receive(from: string, d: unknown): void {
    if (this.stopped || !isToHost(d)) return;
    let rp = this.members.get(from);
    if (d.k === 'hi') {
      const info = this.session.room?.members.find((m) => m.id === from);
      if (!info) return;
      if (!rp) {
        rp = new RemotePlayer(from, info.name);
        this.members.set(from, rp);
      }
      this.possess(rp);
      return;
    }
    if (!rp?.bot) return;
    switch (d.k) {
      case 'st':
        if (d.sp === rp.spawnSeq && validV3(d.p) && validV3(d.v, 100) && [d.yaw, d.pitch, d.h].every(Number.isFinite)) rp.latest = d;
        break;
      case 'shot':
        this.shot(rp, d);
        break;
      case 'buy':
        this.buy(rp, d);
        break;
      case 'throw':
        this.throwGrenade(rp, d);
        break;
      default:
        break;
    }
  }

  /** A member left the room: its character goes back to the AI. */
  memberGone(id: string): void {
    const rp = this.members.get(id);
    if (!rp) return;
    this.members.delete(id);
    this.release(rp);
  }

  /** The game set up a new match (start, restart): everyone gets a character again. */
  onSetup(): void {
    this.lag.clear();
    this.send({ k: 'restart' });
    this.announce();
    for (const rp of this.members.values()) {
      rp.bot = null;
      rp.buy.reset();
      rp.latest = null;
      this.possess(rp);
    }
  }

  /** Team match round start (before everyone respawns): who keeps what (LOADOUT_RULES). */
  onRoundStart(carryOver: boolean, swapped: boolean): void {
    for (const rp of this.members.values()) {
      const bot = rp.bot;
      if (!bot) continue;
      const survived = carryOver && !swapped && bot.alive;
      rp.buy.carryOver(survived);
      rp.keepArmor = survived && LOADOUT_RULES.keepOnSurvive.armor ? bot.combat.armor : null;
      rp.roundSpawn = true;
    }
  }

  /** After every simulation tick: positions for lag compensation, corrections. */
  afterTick(): void {
    const t = this.now();
    if (this.game.player) this.lag.record('local', this.game.player, t);
    for (const b of this.game.squad?.bots ?? []) this.lag.record(b.id, b.controller, t);
    for (const rp of this.members.values()) {
      if (rp.correct && rp.bot) {
        rp.correct = false;
        this.sendSpawn(rp);
      }
    }
  }

  /** Per frame: snapshots and match state at their rates. */
  update(dt: number): void {
    if (this.stopped || !this.session.room || this.session.room.members.length < 2) return;
    this.snapTimer -= dt;
    if (this.snapTimer <= 0) {
      this.snapTimer += 1 / SNAP_RATE;
      if (this.snapTimer < 0) this.snapTimer = 1 / SNAP_RATE;
      this.send({ k: 'snap', t: r3(this.now()), e: this.entities() });
    }
    this.matchTimer -= dt;
    const key = this.matchKey();
    if (this.matchTimer <= 0 || key !== this.lastMatchKey) {
      this.matchTimer = 1 / MATCH_RATE;
      this.lastMatchKey = key;
      this.sendMatch();
    }
  }

  /** A round fired by the host or a bot: everyone shows it. */
  broadcastShot(byId: string, weaponId: string, origin: THREE.Vector3, result: HitscanResult): void {
    if (!this.session.room || this.session.room.members.length < 2) return;
    this.send(fxMessage(this.wire(byId), weaponId, origin, result));
  }

  /** A character took damage: its member sees where it came from. */
  onBotDamaged(bot: Bot, e: PlayerDamageEvent): void {
    const rp = bot.remote instanceof RemotePlayer ? bot.remote : null;
    if (!rp) return;
    this.send(
      { k: 'hurt', amount: e.amount, d: v3(e.direction), killed: e.killed, by: this.wire(e.sourceId), w: e.weaponId, head: e.zone === 'head' },
      rp.id,
    );
  }

  /** A grenade thrown by the host or a bot. */
  broadcastThrow(byId: string, kind: 'flash' | 'smoke', eye: THREE.Vector3, dir: THREE.Vector3, carry: THREE.Vector3, except?: string): void {
    const msg: ToClient = { k: 'throw', by: this.wire(byId), kind, eye: v3(eye), dir: [r3(dir.x), r3(dir.y), r3(dir.z)], carry: v3(carry) };
    for (const rp of this.members.values()) if (rp.id !== except) this.send(msg, rp.id);
  }

  boom(at: THREE.Vector3): void {
    this.send({ k: 'boom', p: v3(at) });
  }

  /** Back to single player: every character to the AI. */
  stop(): void {
    this.stopped = true;
    for (const rp of this.members.values()) this.release(rp);
    this.members.clear();
    this.lag.clear();
  }

  // --- internals -----------------------------------------------------------------------

  private send(msg: ToClient, to?: string): void {
    this.session.send(msg, to);
  }

  /** Gives `rp` a character: a bot nobody plays, on the team with fewer humans (team match). */
  private possess(rp: RemotePlayer): void {
    const squad = this.game.squad;
    if (!squad) return;
    if (!rp.bot) {
      const free = squad.bots.filter((b) => !b.remote);
      let pick = free[0];
      if (this.game.teamMatch) {
        const humans = { blue: 1, red: 0 };
        for (const o of this.members.values()) if (o.bot?.team === 'blue' || o.bot?.team === 'red') humans[o.bot.team]++;
        const want = humans.red < humans.blue ? 'red' : 'blue';
        pick = free.find((b) => b.team === want) ?? free[0];
      }
      if (!pick) return; // room full beyond the roster (cannot happen with ROOM_CAPACITY)
      rp.bot = pick;
      rp.botName = pick.name;
      pick.remote = rp;
      pick.order = null;
      pick.name = rp.name;
      this.rename(pick.id, rp.name);
      pick.onSpawn = () => this.onSpawned(rp);
    }
    const bot = rp.bot;
    this.send({ k: 'you', id: bot.id, team: bot.team ?? null }, rp.id);
    this.sendSpawn(rp);
    this.sendMatch(rp.id);
  }

  private release(rp: RemotePlayer): void {
    const bot = rp.bot;
    if (!bot) return;
    bot.remote = null;
    bot.onSpawn = null;
    bot.useKey = false;
    bot.name = rp.botName;
    this.rename(bot.id, rp.botName);
    this.lag.forget(bot.id);
    rp.bot = null;
  }

  private rename(id: string, name: string): void {
    const s = this.game.match?.scores.get(id) ?? this.game.teamMatch?.scores.get(id);
    if (s) s.name = name;
  }

  private onSpawned(rp: RemotePlayer): void {
    const bot = rp.bot;
    if (!bot) return;
    if (rp.keepArmor !== null) bot.combat.armor = rp.keepArmor;
    rp.keepArmor = null;
    const round = rp.roundSpawn;
    rp.roundSpawn = false;
    this.sendSpawn(rp, round);
  }

  private sendSpawn(rp: RemotePlayer, round = false): void {
    const bot = rp.bot;
    if (!bot) return;
    rp.spawnSeq++;
    rp.latest = null;
    rp.placed();
    const team = !!this.game.teamMatch;
    this.send(
      {
        k: 'spawn',
        sp: rp.spawnSeq,
        p: v3(bot.position),
        yaw: r3(bot.controller.yaw),
        alive: bot.alive,
        hp: bot.combat.health,
        armor: bot.combat.armor,
        loadout: team ? rp.buy.weapons().map((e) => e.item.id) : null,
        grenades: team ? { ...rp.buy.grenades } : null,
        round,
      },
      rp.id,
    );
  }

  private sendMatch(to?: string): void {
    const m = this.game.match;
    const tm = this.game.teamMatch;
    const ms = tm ? teamMatchState(tm, (id) => this.wire(id), this.nameOf) : m ? matchState(m, (id) => this.wire(id), this.nameOf) : null;
    if (!ms) return;
    const bomb = this.game.bomb ? bombState(this.game.bomb, (id) => this.wire(id)) : null;
    this.send({ k: 'match', t: r3(this.now()), m: ms, bomb }, to);
  }

  /** Changes worth sending at once (phase, round, scores, bomb). */
  private matchKey(): string {
    const tm = this.game.teamMatch;
    const m = this.game.match;
    const b = this.game.bomb;
    return [tm?.phase, tm?.round, tm?.feed.length, m?.feed.length, m?.over, b?.state, b?.carrier, b?.planting?.id, b?.defusing?.id].join('|');
  }

  private entities(): EntityState[] {
    const out: EntityState[] = [];
    const p = this.game.player;
    const c = this.game.combat;
    if (p && c) out.push(entity(this.wire('local'), p, c, this.game.netAiming, c.team ?? ''));
    for (const b of this.game.squad?.bots ?? []) {
      out.push(entity(b.id, b.controller, b.combat, (b.remote ? b.remote.aiming : b.mode === 'engage') && b.alive, b.team ?? ''));
    }
    return out;
  }

  private shot(rp: RemotePlayer, m: Extract<ToHost, { k: 'shot' }>): void {
    const bot = rp.bot!;
    const hitscan = this.game.hitscan;
    const def = WEAPONS[m.w];
    const refuse = (why: string) => void (this.shotStats[why] = (this.shotStats[why] ?? 0) + 1);
    if (!hitscan || !def || !bot.alive || !validV3(m.o) || !validV3(m.d, 2) || !Number.isFinite(m.rt)) return refuse('invalid');
    const tm = this.game.teamMatch;
    if ((tm && tm.phase !== 'live') || this.game.match?.over) return refuse('phase');
    const allowed = tm ? rp.buy.weapons().some((e) => e.item.weapon?.id === def.id) : DEFAULT_LOADOUT.some((w) => w.id === def.id);
    if (!allowed) return refuse('weapon');
    // No faster than the weapon fires on average (a shotgun round is several pellets). Rounds may
    // arrive bunched (network), so a short burst is allowed: a bucket of SHOT_BURST rounds.
    const now = this.now();
    const pellets = def.pellets?.count ?? 1;
    const perSecond = (def.fireRate / 60) * pellets;
    const cap = SHOT_BURST * pellets;
    rp.shotTokens = Math.min(cap, rp.shotTokens + (now - rp.shotTime) * perSecond * 1.1);
    rp.shotTime = now;
    if (rp.shotTokens < 1) return refuse('rate');
    rp.shotTokens -= 1;
    const origin = new THREE.Vector3(...m.o);
    const eye = new THREE.Vector3(bot.position.x, bot.position.y + bot.controller.eyeHeight, bot.position.z);
    if (origin.distanceTo(eye) > MAX_ORIGIN_OFFSET) return refuse('origin');
    const dir = new THREE.Vector3(...m.d);
    if (dir.lengthSq() < 0.5) return refuse('invalid');
    dir.normalize();
    const result = this.lag.rewind(m.rt, now, bot.id, () =>
      hitscan.fire({ origin, direction: dir, damage: def.damage, sourceId: bot.id, weaponId: def.id, team: bot.team }),
    );
    refuse(result.kind);
    this.game.showNetShot(bot, def, origin, dir, result);
    this.send(fxMessage(bot.id, def.id, origin, result));
    if (result.kind === 'target') this.send({ k: 'hit', head: result.zone === 'head', kill: !result.target.alive }, rp.id);
  }

  private buy(rp: RemotePlayer, m: Extract<ToHost, { k: 'buy' }>): void {
    const bot = rp.bot!;
    const tm = this.game.teamMatch;
    const eco = tm?.economy;
    const reply = (ok: boolean, message: string) =>
      this.send({ k: 'buy', n: m.n, ok, message, loadout: rp.buy.weapons().map((e) => e.item.id), grenades: { ...rp.buy.grenades }, armor: bot.combat.armor }, rp.id);
    if (!tm || !eco || !tm.buyOpen || !bot.alive || typeof m.id !== 'string') return reply(false, '지금은 구매할 수 없습니다 (작전 준비 중에만 가능)');
    const r = rp.buy.buy(m.id, eco, bot.id, { armor: bot.combat.armor });
    if (r.ok && r.armor !== undefined) bot.combat.armor = r.armor;
    reply(r.ok, r.message);
  }

  private throwGrenade(rp: RemotePlayer, m: Extract<ToHost, { k: 'throw' }>): void {
    const bot = rp.bot!;
    const g = this.game.grenades;
    const tm = this.game.teamMatch;
    if (!g || !tm || tm.phase !== 'live' || !bot.alive || (m.kind !== 'flash' && m.kind !== 'smoke')) return;
    if (!validV3(m.eye) || !validV3(m.dir, 2) || !validV3(m.carry, 100)) return;
    const eye = new THREE.Vector3(...m.eye);
    const botEye = new THREE.Vector3(bot.position.x, bot.position.y + bot.controller.eyeHeight, bot.position.z);
    if (eye.distanceTo(botEye) > MAX_ORIGIN_OFFSET || !rp.buy.useGrenade(m.kind)) return;
    const dir = new THREE.Vector3(...m.dir).normalize();
    const carry = new THREE.Vector3(...m.carry);
    g.throw(m.kind, bot.id, eye, dir, carry);
    this.broadcastThrow(bot.id, m.kind, eye, dir, carry, rp.id);
  }
}

function entity(id: string, c: PlayerController, combat: PlayerCombat, aiming: boolean, team: string): EntityState {
  const flags = (combat.alive ? 1 : 0) | (c.grounded ? 2 : 0) | (aiming ? 4 : 0) | (c.crouching ? 8 : 0);
  return [id, r2(c.position.x), r2(c.position.y), r2(c.position.z), r3(c.yaw), r3(c.pitch), r2(c.height), r2(c.velocity.x), r2(c.velocity.z), flags, Math.round(combat.health), Math.round(combat.armor), r2(combat.deadTime), team];
}

function fxMessage(by: string, weaponId: string, origin: THREE.Vector3, result: HitscanResult): ToClient {
  const end = result.kind === 'miss' ? result.end : result.point;
  const n: V3 | null = result.kind === 'miss' ? null : v3(result.normal);
  return { k: 'fx', by, w: weaponId, o: v3(origin), e: v3(end), kind: result.kind, n, head: result.kind === 'target' && result.zone === 'head' };
}
