import * as THREE from 'three';
import { BotSquad, type SquadMember } from '../ai/BotSquad';
import type { Bot, Combatant } from '../ai/Bot';
import { NavGrid } from '../ai/NavGrid';
import { HitscanSystem } from '../combat/HitscanSystem';
import { TrainingRange } from '../combat/TrainingRange';
import { CAMERA_CONFIG, PLAYER_CONFIG, QUALITY_PRESETS, SIM_CONFIG, type QualityLevel } from '../config';
import { AudioEngine } from '../audio/AudioEngine';
import { WeaponAudio } from '../audio/WeaponAudio';
import { BloodEffects } from '../fx/BloodEffects';
import { CombatEffects } from '../fx/CombatEffects';
import { ImpactEffects } from '../fx/ImpactEffects';
import { createInputState } from '../input/InputState';
import { loadControls, saveControls } from '../input/Controls';
import { KeyboardMouseInput } from '../input/KeyboardMouseInput';
import { FirstPersonBody, type BodyState } from '../player/FirstPersonBody';
import { PlayerController } from '../player/PlayerController';
import { PlayerCombat, RESPAWN_DELAY, type PlayerDamageEvent } from '../player/PlayerCombat';
import { Match, BOT_COUNT_OPTIONS, KILL_TARGET_OPTIONS, TIME_LIMIT_OPTIONS, type GameMode } from '../game/Match';
import { loadMatchSettings, parseMode, saveMatchSettings, type MatchSettings } from '../game/MatchSettings';
import { DEFAULT_TEAM_MATCH, otherTeam, ROUND_TIME_OPTIONS, ROUNDS_TO_WIN_OPTIONS, TeamMatch, TEAMS, type Team } from '../game/TeamMatch';
import { Hud } from '../ui/Hud';
import { MatchHud } from '../ui/MatchHud';
import { TeamHud } from '../ui/TeamHud';
import { createWeaponView, loadWeaponView, preloadWeaponViews } from '../weapons/view/WeaponView';
import type { MenuWeapon } from '../ui/MainMenu';
import { renderWeaponThumbnails } from '../ui/weaponThumbnails';
import type { WeaponDefinition, WeaponViewSpec } from '../weapons/WeaponDefinition';
import { ViewModelLayer } from '../weapons/view/ViewModelLayer';
import type { Weapon } from '../weapons/Weapon';
import { AR_01, DEFAULT_LOADOUT, SR_01 } from '../weapons/weapons';
import { WeaponSystem, type WeaponCommand } from '../weapons/WeaponSystem';
import type { WeaponAnimState } from '../weapons/view/WeaponView';
import { findMap, MAPS, type MapDefinition } from '../maps';
import { disposeMap, loadMap, type LoadedMap, type SpawnPoint } from '../world/MapLoader';
import { createSkyEnvironment, HORIZON_COLOR, SkyDome } from '../world/Sky';
import { enhanceMapMaterials } from '../world/SurfaceMaterials';
import { FRAME_LIMIT_OPTIONS, FrameLoop, type FrameLimit } from './FrameLoop';

const QUALITY_OPTIONS: readonly { value: QualityLevel; label: string }[] = [
  { value: 'low', label: '낮음 (성능 우선)' },
  { value: 'medium', label: '중간' },
  { value: 'high', label: '높음' },
];
const VOLUME_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 0, label: '끄기' },
  { value: 0.25, label: '25%' },
  { value: 0.5, label: '50%' },
  { value: 0.75, label: '75%' },
  { value: 1, label: '100%' },
];
import { saveSettings, type Settings } from './Settings';

const _muzzleWorld = new THREE.Vector3();
const _specEye = new THREE.Vector3();
const _specDir = new THREE.Vector3();

/** Team match roster: the player leads BLUE with 4 bots; RED is 5 bots. */
const TEAM_ROSTER: readonly SquadMember[] = [
  ...['Alpha', 'Bravo', 'Charlie', 'Delta'].map((name) => ({ name, team: 'blue' })),
  ...['Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'].map((name) => ({ name, team: 'red' })),
];
/** Seconds after dying before the team match camera switches to a living teammate. */
const SPECTATE_AFTER = 1.5;

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly hud: Hud;
  readonly quality: QualityLevel;
  mapDef: MapDefinition;
  readonly settings: Settings;

  map: LoadedMap | null = null;
  player: PlayerController | null = null;
  hitscan: HitscanSystem | null = null;
  weapons: WeaponSystem | null = null;
  /** Training dummies of the current map. */
  trainingRange: TrainingRange | null = null;
  /** The local player's health, death and respawn timer (bullets reach it through the hitscan). */
  combat: PlayerCombat | null = null;
  /** Spawn point used by the last (re)spawn. */
  spawnPoint: SpawnPoint | null = null;
  /** Last training-target hit, shown in the F3 overlay. */
  private lastHit = '';
  /** 'deathmatch' (bots, match rules), 'team' (5v5 rounds) or 'training' (dummies). `?mode=` overrides the saved choice. */
  mode: GameMode;
  readonly matchSettings: MatchSettings;
  /** Walkable grid of the current map (built when bots need it). */
  nav: NavGrid | null = null;
  squad: BotSquad | null = null;
  match: Match | null = null;
  /** 5v5 round match (team mode only). */
  teamMatch: TeamMatch | null = null;
  /** Team match spawn spots per team (index 0 of BLUE is the player's), built once per map. */
  teamSpawns: Record<Team, SpawnPoint[]> | null = null;
  private readonly matchHud: MatchHud;
  private readonly teamHud: TeamHud;
  /** Team match: which living teammate a dead player watches, and the fire button's last state (to cycle). */
  private spectateIndex = 0;
  private spectateFireHeld = false;
  private scoreboardHeld = false;
  /** The player as bots see it. */
  private readonly playerCombatant: Combatant;
  readonly impacts = new ImpactEffects();
  /** Blood mist, droplets and wall spatter on body hits. */
  readonly blood = new BloodEffects();
  /** Tracers and world muzzle flashes (cosmetic). */
  readonly fx = new CombatEffects();
  readonly viewModel: ViewModelLayer;
  /** Local player's legs and waist, visible when looking down. */
  readonly body = new FirstPersonBody();
  private readonly bodyState: BodyState = {
    feet: new THREE.Vector3(),
    yaw: 0,
    eyeHeight: 0,
    velocity: new THREE.Vector3(),
    grounded: true,
  };
  readonly audio: AudioEngine;
  private readonly weaponAudio: WeaponAudio;
  /** Index of the simulation tick being run inside the current frame. */
  private tickInFrame = 0;
  /** Tick of the first sound-producing shot in this frame (-1 = none yet). */
  private frameShotTick = -1;

  private readonly input: KeyboardMouseInput;
  private readonly inputState = createInputState();
  /** What a dead player "presses": nothing. */
  private readonly deadInput = createInputState();
  private readonly timer = new THREE.Timer();
  private readonly loop = new FrameLoop((now) => this.frame(now));
  private loadingMap = false;
  private readonly sun: THREE.DirectionalLight;
  private readonly sky: SkyDome;
  private readonly skyEnv: THREE.Texture;
  private accumulator = 0;
  private readonly prevPos = new THREE.Vector3();
  private prevEyeHeight = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private fps = 0;

  constructor(container: HTMLElement, quality: QualityLevel, settings: Settings) {
    this.quality = quality;
    this.settings = settings;
    this.matchSettings = loadMatchSettings();
    this.mode = parseMode(new URLSearchParams(location.search).get('mode')) ?? this.matchSettings.mode;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const game = this;
    this.playerCombatant = {
      id: 'local',
      get alive() {
        return game.combat?.alive ?? false;
      },
      get position() {
        return game.player!.position;
      },
      get height() {
        return game.player!.height;
      },
      get team() {
        return game.combat?.team;
      },
    };
    const mapDef = findMap(settings.mapId);
    this.mapDef = mapDef;
    const preset = QUALITY_PRESETS[quality];

    this.renderer = new THREE.WebGLRenderer({ antialias: preset.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = preset.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // The map is static: shadows are rendered once after load, not every frame.
    this.renderer.shadowMap.autoUpdate = false;
    // World + view-model are drawn in two passes; clear manually once per frame.
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      CAMERA_CONFIG.fov,
      window.innerWidth / window.innerHeight,
      CAMERA_CONFIG.near,
      mapDef.environment.viewDistance,
    );
    this.camera.rotation.order = 'YXZ';
    this.viewModel = new ViewModelLayer(window.innerWidth / window.innerHeight);
    this.viewModel.initEnvironment(this.renderer);
    this.showWeaponModel(DEFAULT_LOADOUT[0].view);
    this.scene.add(this.impacts.group);
    this.scene.add(this.blood.group);
    this.scene.add(this.fx.group);
    this.scene.add(this.body.object);
    // Sounds are synthesised in the background while the map downloads.
    this.audio = new AudioEngine(settings.volume, { srFireInterval: 60 / SR_01.fireRate });
    this.weaponAudio = new WeaponAudio(this.audio);

    // Overcast late-afternoon look: gradient sky, sky reflections / ambient
    // from an environment map, a weaker sky fill and one warm key light.
    this.scene.background = HORIZON_COLOR.clone();
    this.scene.fog = new THREE.Fog(HORIZON_COLOR.clone(), mapDef.environment.fogNear, mapDef.environment.fogFar);
    const sunDir = new THREE.Vector3(28, 45, 18).normalize();
    this.sky = new SkyDome(sunDir);
    this.scene.add(this.sky.mesh);
    // Bound per material (reflective surfaces only), not as scene.environment.
    this.skyEnv = createSkyEnvironment(this.renderer, sunDir);
    this.scene.add(new THREE.HemisphereLight(0xc9d4de, 0x4a4238, 1.25));
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
    this.sun.position.copy(sunDir).multiplyScalar(55);
    this.sun.castShadow = preset.shadows;
    this.sun.shadow.mapSize.setScalar(preset.shadowMapSize);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.hud = new Hud(document.body);
    // Maps switch in place, so every map shares the same page link.
    this.hud.setMapOptions(MAPS, mapDef.id, (id) => void this.switchMap(id));
    this.hud.setFrameLimitOptions(FRAME_LIMIT_OPTIONS, settings.frameLimit, (limit) => this.setFrameLimit(limit));
    this.hud.setQualityOptions(QUALITY_OPTIONS, quality, (q) => {
      // The renderer's antialiasing is fixed at creation, so apply by reloading (same link).
      this.settings.quality = q;
      saveSettings(this.settings);
      location.reload();
    });
    this.loop.setLimit(settings.frameLimit);
    // Weapons page: picking a card equips that loadout slot through the normal weapon system.
    this.hud.setWeaponOptions(DEFAULT_LOADOUT.map(menuWeapon), (slot) => this.weapons?.equipSlot(slot));
    this.hud.setWeaponOptionsEnabled(false);
    this.hud.menu.bindSelect('volume', VOLUME_OPTIONS, settings.volume, (v) => {
      this.settings.volume = v;
      saveSettings(this.settings);
      this.audio.setVolume(v);
    });
    // Same action as F3.
    this.hud.menu.bindToggle('stats', false, (on) => this.setStatsShown(on));
    // Weapon card images: rendered once, the first time the Weapons page is opened,
    // so the work happens in the menu on demand and never during play.
    this.hud.menu.onPageShown((page) => {
      if (page !== 'loadout' || this.thumbnailsDone) return;
      this.thumbnailsDone = true;
      void renderWeaponThumbnails(this.renderer, this.viewModel.scene.environment, DEFAULT_LOADOUT, (id, url) =>
        this.hud.menu.setWeaponThumbnail(id, url),
      ).catch((err) => console.warn('[menu] weapon thumbnails unavailable', err));
    });
    this.input = new KeyboardMouseInput(this.renderer.domElement, (locked) => this.onLockChange(locked));
    // Controls page: sensitivity + key bindings, applied immediately, stored apart from the settings record.
    const controls = loadControls();
    this.input.sensitivity = controls.sensitivity;
    this.input.bindings = controls.bindings;
    this.hud.menu.setControls(controls, (c) => {
      this.input.sensitivity = c.sensitivity;
      this.input.bindings = c.bindings;
      saveControls(c);
    });
    this.hud.onStart(() => this.input.requestLock());
    this.matchHud = new MatchHud(
      this.hud.root,
      () => {
        this.restartMatch();
        this.input.requestLock();
      },
      () => this.restartMatch(),
    );
    this.teamHud = new TeamHud(
      this.hud.root,
      () => {
        this.restartMatch();
        this.input.requestLock();
      },
      () => this.restartMatch(),
    );
    this.bindMatchOptions();
    this.renderer.domElement.addEventListener('click', () => {
      if (this.player && !this.loadingMap && !this.input.active) this.input.requestLock();
    });

    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.setStatsShown(!this.hud.statsVisible);
      } else if (e.code === 'F4' && this.input.active && this.combat?.alive !== false && this.mode === 'training') {
        e.preventDefault();
        this.respawn();
      } else if (e.code === 'Tab') {
        e.preventDefault();
        this.scoreboardHeld = true;
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') this.scoreboardHeld = false;
    });
  }

  async start(): Promise<void> {
    // Weapon GLBs download alongside the map; the game is ready once both are in.
    this.weaponModels = preloadWeaponViews(DEFAULT_LOADOUT.map((d) => d.view));
    if (!(await this.loadMapInto(this.mapDef))) return;
    this.timer.connect(document);
    this.loop.start();
  }

  /** Swaps the current map for another one without reloading the page. */
  async switchMap(id: string): Promise<void> {
    const def = findMap(id);
    if (this.loadingMap || def.id === this.mapDef.id) return;
    if (document.pointerLockElement) document.exitPointerLock();
    this.teardownMode();
    this.nav = null;
    this.teamSpawns = null;
    if (this.combat) this.hitscan?.unregister(this.combat);
    this.combat = null;
    this.spawnPoint = null;
    this.lastHit = '';
    if (this.map) disposeMap(this.map);
    this.map = null;
    this.player = null;
    this.hitscan = null;
    this.weapons = null;
    this.impacts.clear();
    this.blood.clear();
    this.blood.setWorld(null);
    this.mapDef = def;
    this.settings.mapId = def.id;
    saveSettings(this.settings);
    await this.loadMapInto(def);
  }

  setFrameLimit(limit: FrameLimit): void {
    this.settings.frameLimit = limit;
    saveSettings(this.settings);
    this.loop.setLimit(limit);
  }

  /** Performance overlay + gameplay zone markers (F3 or the settings toggle). */
  setStatsShown(show: boolean): void {
    this.hud.setStatsVisible(show);
    if (this.map) this.map.zoneMarkers.visible = show;
  }

  private async loadMapInto(def: MapDefinition): Promise<boolean> {
    this.loadingMap = true;
    this.hud.setMapSelectEnabled(false);
    this.hud.setWeaponOptionsEnabled(false);
    // Real download progress when the server reports a size; otherwise an indeterminate bar.
    this.hud.setLoading('다운로드 중', def.name, null);
    let map: LoadedMap;
    try {
      map = await loadMap(
        def,
        (r) => this.hud.setLoading('다운로드 중', def.name, r),
        () => this.hud.setLoading('맵 데이터 준비 중 (충돌 · 조명)', def.name, null),
      );
    } catch (err) {
      console.error(err);
      this.hud.setError(`맵을 불러오지 못했습니다: ${def.url}`);
      this.loadingMap = false;
      this.hud.setMapSelectEnabled(true);
      return false;
    }
    this.map = map;
    const surfaces = enhanceMapMaterials(map.root, this.quality, this.skyEnv);
    console.info(`[map:${def.id}] surfaces`, surfaces);
    this.scene.add(map.root);
    const env = def.environment;
    const fog = this.scene.fog as THREE.Fog;
    fog.near = env.fogNear;
    fog.far = env.fogFar;
    this.camera.far = env.viewDistance;
    this.camera.updateProjectionMatrix();
    this.fitShadowToMap(map.playBounds);

    this.player = new PlayerController(map.collision);
    this.hitscan = new HitscanSystem(map.collision);
    this.blood.setWorld(map.collision);
    this.weapons = new WeaponSystem(DEFAULT_LOADOUT, this.player, this.hitscan);
    this.combat = new PlayerCombat(this.player);
    this.combat.onDamage = (e) => this.onPlayerDamaged(e);
    this.hitscan.register(this.combat);
    await this.weaponModels;
    this.showWeaponModel(this.weapons.weapon.def.view);
    this.hud.setLoadout(this.weapons.loadout.map((w) => w.def.displayName), this.weapons.slot);
    this.weapons.events = {
      onEquip: (weapon, slot) => {
        this.showWeaponModel(weapon.def.view);
        this.weaponAudio.onEquip(weapon);
        this.hud.setLoadout(this.weapons!.loadout.map((w) => w.def.displayName), slot);
      },
      onShot: (result, _origin, dir, weapon) => {
        // Rounds resolved in later ticks of the same frame keep their real spacing.
        if (this.frameShotTick < 0) this.frameShotTick = this.tickInFrame;
        const delay = (this.tickInFrame - this.frameShotTick) / SIM_CONFIG.tickRate;
        this.weaponAudio.onShot(weapon, result, delay, this.camera);
        this.viewModel.onShot(weapon.def.category);
        if (weapon.def.category !== 'melee' && this.viewModel.muzzleInWorld(this.camera, _muzzleWorld)) {
          this.fx.tracer(_muzzleWorld, result.kind === 'miss' ? result.end : result.point);
        }
        // Holes and dust only on the map: a decal would float in the air once a dummy falls.
        if (result.kind === 'world') this.impacts.spawn(result.point, result.normal);
        if (result.kind === 'target') {
          const kill = !result.target.alive;
          this.blood.spawn(result.point, dir, result.zone === 'head');
          this.hud.showHitMarker(result.zone === 'head', kill);
          this.lastHit = `${result.zone} ${result.damage} @ ${result.distance.toFixed(1)} m${kill ? '  KILL' : ''}`;
        }
        if (import.meta.env.DEV && this.debugShots) console.debug('[shot]', result.kind, 'distance' in result ? result.distance.toFixed(2) : '');
      },
      onDryFire: () => this.weaponAudio.onDryFire(this.weapons!.weapon),
      onReloadEnd: () => this.weaponAudio.onReloadEnd(this.weapons!.weapon),
    };
    this.setupMode();
    this.beginMode();

    // Compile shaders and bake the static shadow map before the first frame.
    this.renderer.compile(this.scene, this.camera);
    this.renderer.compile(this.viewModel.scene, this.viewModel.camera);
    this.renderer.shadowMap.needsUpdate = true;

    const s = map.stats;
    console.info(
      `[map:${def.id}] ${s.sourceMeshes} meshes -> ${s.drawCalls} batches, ${s.triangles} tris, collider ${s.colliderTriangles} tris, ` +
        `${map.attackSpawns.length} ATK / ${map.defenseSpawns.length} DEF spawns`,
    );
    this.loadingMap = false;
    this.hud.setMapSelectEnabled(true);
    this.hud.setWeaponOptionsEnabled(true);
    this.hud.setReady(this.hasStarted ? '일시정지됨' : '준비 완료');

    this.hud.setHealth(this.player.health);
    this.updateWeaponHud();
    return true;
  }

  respawn(): void {
    if (!this.map || !this.player) return;
    const spawn = this.teamMatch ? this.teamSpawns?.blue[0] : this.squad ? this.deathmatchSpawn() : this.safeSpawn(this.map);
    this.spawnPoint = spawn ?? null;
    const pos = spawn ? spawn.position.clone() : this.map.playBounds.getCenter(new THREE.Vector3());
    // Spawn empties sit slightly above the floor; drop onto it from a little higher.
    pos.y += 0.1;
    this.player.teleport(pos, spawn?.yaw ?? 0);
    this.weapons?.resetForRespawn();
    this.body.reset();
    this.combat?.reset();
    this.hud.setDeath(null, RESPAWN_DELAY);
    this.trainingRange?.reset();
    this.impacts.clear();
    this.blood.clear();
    this.fx.clear();
    this.prevPos.copy(this.player.position);
    this.prevEyeHeight = this.player.eyeHeight;
  }

  /** Builds what the current mode needs on the loaded map: dummies, or bots + a fresh match. */
  private setupMode(): void {
    const map = this.map;
    const hitscan = this.hitscan;
    if (!map || !hitscan) return;
    this.teardownMode();
    const dm = this.mode === 'deathmatch';
    const team = this.mode === 'team';
    if (!dm && !team) {
      this.trainingRange = new TrainingRange(map, this.homeSpawn(map), hitscan);
      this.scene.add(this.trainingRange.group);
    } else {
      // Built once per map and reused by every match and round.
      this.nav ??= new NavGrid(map);
      console.info(`[bots] nav grid ${this.nav.walkable.length} cells in ${this.nav.buildMs.toFixed(0)} ms`);
      const squad = new BotSquad(map, this.nav, hitscan, team ? TEAM_ROSTER : this.matchSettings.bots, [AR_01]);
      // Team match: deaths last until the round ends.
      squad.respawns = !team;
      squad.events = {
        onShot: (_bot, result, origin, dir, weapon, muzzle) => {
          this.weaponAudio.onRemoteShot(weapon, origin, result, this.camera);
          this.fx.flash(muzzle, dir);
          this.fx.tracer(muzzle, result.kind === 'miss' ? result.end : result.point);
          if (result.kind === 'world') this.impacts.spawn(result.point, result.normal);
          else if (result.kind === 'target') this.blood.spawn(result.point, dir, result.zone === 'head');
        },
        onDamage: (bot, e) => {
          if (!e.killed) return;
          this.match?.recordKill(e.sourceId, bot.id, e.weaponId, e.zone === 'head');
          this.teamMatch?.recordKill(e.sourceId, bot.id, e.weaponId, e.zone === 'head');
        },
      };
      this.squad = squad;
      this.scene.add(squad.group);
      if (team) {
        // The player is BLUE; with friendly fire off, rounds pass through teammates.
        hitscan.friendlyFire = false;
        if (this.combat) this.combat.team = 'blue';
        if (this.weapons) this.weapons.team = 'blue';
        this.teamSpawns ??= this.buildTeamSpawns(map, this.nav);
        const ms = this.matchSettings;
        this.teamMatch = new TeamMatch({ ...DEFAULT_TEAM_MATCH, roundsToWin: ms.roundsToWin, roundTime: ms.roundTime }, [
          { id: 'local', name: 'YOU', team: 'blue', isPlayer: true },
          ...squad.bots.map((b) => ({ id: b.id, name: b.name, team: b.team as Team, isPlayer: false })),
        ]);
      } else {
        this.match = new Match(this.matchSettings, [{ id: 'local', name: 'YOU', isPlayer: true }, ...squad.bots.map((b) => ({ id: b.id, name: b.name, isPlayer: false }))]);
      }
    }
    this.matchHud.setVisible(dm);
    this.matchHud.hideResults();
    this.teamHud.setVisible(team);
    this.teamHud.hideResults();
    this.hud.setDeathNote(null);
    this.hud.menu.setMatchOptionsVisible(dm);
    this.hud.menu.setTeamOptionsVisible(team);
  }

  /** Places everyone for the mode just set up: a first round (team), or spread out (deathmatch). */
  private beginMode(): void {
    if (this.teamMatch) {
      this.startRound();
      return;
    }
    this.respawn();
    this.squad?.spawnAll([this.player!.position]);
  }

  /**
   * Team match round start: every combatant back at its team's spawn, alive
   * at full health with full ammo and no AI memory; effects cleared. The
   * hitscan is instant and nothing is scheduled for later, so nothing from
   * the previous round can land in this one.
   */
  private startRound(): void {
    const squad = this.squad;
    const spawns = this.teamSpawns;
    if (!squad || !spawns) return;
    this.respawn();
    const next: Record<Team, number> = { blue: 1, red: 0 };
    const centre = (t: Team) => spawns[t].reduce((a, s) => a.add(s.position), new THREE.Vector3()).multiplyScalar(1 / spawns[t].length);
    const roam: Record<Team, THREE.Vector3> = { blue: centre('red'), red: centre('blue') };
    for (const b of squad.bots) {
      const t = b.team as Team;
      const s = spawns[t][next[t]++ % spawns[t].length];
      squad.spawnAt(b, s.position, s.yaw);
      b.roamTarget = roam[t];
    }
    this.spectateIndex = 0;
    this.hud.setDeathNote(null);
  }

  /** Living combatants per team (the player counts for BLUE). */
  teamAlive(): Record<Team, number> {
    const n: Record<Team, number> = { blue: 0, red: 0 };
    if (this.combat?.alive) n.blue++;
    for (const b of this.squad?.bots ?? []) if (b.alive && b.team) n[b.team as Team]++;
    return n;
  }

  /**
   * TeamMatchConfig.teamSize spawn spots per team: BLUE on the map's attack
   * spawns, RED on the defence spawns (the two ends of the map), each spot
   * checked to fit a standing capsule and to be on the walk grid. Missing
   * spots are filled from walkable cells near that team's others. Everyone
   * faces the enemy side.
   */
  private buildTeamSpawns(map: LoadedMap, nav: NavGrid): Record<Team, SpawnPoint[]> {
    const size = DEFAULT_TEAM_MATCH.teamSize;
    const lists: Record<Team, THREE.Vector3[]> = { blue: [], red: [] };
    const source: Record<Team, SpawnPoint[]> = { blue: map.attackSpawns, red: map.defenseSpawns };
    for (const t of TEAMS) {
      for (const s of source[t]) if (this.spawnFits(map, s.position) && nav.nearestWalkable(s.position) >= 0) lists[t].push(s.position.clone());
    }
    for (const t of TEAMS) {
      const list = lists[t];
      // A side with no usable spawn starts on a walkable cell far from the other side.
      if (list.length === 0) {
        const other = lists[otherTeam(t)][0];
        let best = -1;
        let bestD = -1;
        for (let k = 0; k < 64; k++) {
          const c = nav.randomCell();
          if (c < 0) break;
          const d = other ? nav.center(c).distanceTo(other) : 0;
          if (d > bestD) {
            bestD = d;
            best = c;
          }
        }
        if (best >= 0) list.push(nav.center(best));
      }
      const anchor = list[0];
      for (let k = 0; list.length < size && anchor && k < 4000; k++) {
        const c = nav.randomCell();
        if (c < 0) break;
        const p = nav.center(c);
        if (p.distanceTo(anchor) < 10 && list.every((q) => q.distanceTo(p) > 1.2) && this.spawnFits(map, p)) list.push(p);
      }
    }
    const centre = (t: Team) => lists[t].reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / Math.max(lists[t].length, 1));
    const out = { blue: [] as SpawnPoint[], red: [] as SpawnPoint[] };
    for (const t of TEAMS) {
      const target = centre(otherTeam(t));
      out[t] = lists[t].slice(0, size).map((p) => ({ position: p, yaw: Math.atan2(-(target.x - p.x), -(target.z - p.z)) }));
    }
    return out;
  }

  /** A standing capsule fits at this spawn (feet 0.1 m above it, as respawn places it). */
  private spawnFits(map: LoadedMap, pos: THREE.Vector3): boolean {
    const r = PLAYER_CONFIG.radius;
    const feet = pos.y + 0.1;
    const seg = new THREE.Line3(new THREE.Vector3(pos.x, feet + r + 0.05, pos.z), new THREE.Vector3(pos.x, feet + PLAYER_CONFIG.standHeight - r, pos.z));
    return !map.collision.capsuleOverlaps(seg, r - 0.02);
  }

  private teardownMode(): void {
    this.trainingRange?.dispose();
    this.trainingRange = null;
    this.squad?.dispose();
    this.squad = null;
    this.match = null;
    this.teamMatch = null;
    // Free-for-all and training: no teams, friendly fire rules do not apply.
    if (this.hitscan) this.hitscan.friendlyFire = true;
    if (this.combat) this.combat.team = undefined;
    if (this.weapons) this.weapons.team = undefined;
  }

  /** New match on the same map: fresh scores, everyone respawned. */
  restartMatch(): void {
    if (!this.map) return;
    this.setupMode();
    this.beginMode();
    this.accumulator = 0;
  }

  /** Deathmatch spawn: a walkable spot far from the living bots. */
  private deathmatchSpawn(): SpawnPoint | undefined {
    const nav = this.nav;
    const map = this.map;
    if (!nav || !map) return undefined;
    const bots = this.squad?.bots.filter((b) => b.alive).map((b) => b.position) ?? [];
    let best: THREE.Vector3 | null = null;
    let bestScore = -Infinity;
    for (let k = 0; k < 32; k++) {
      const c = nav.randomCell();
      if (c < 0) break;
      const p = nav.center(c);
      let near = 60;
      for (const b of bots) near = Math.min(near, Math.hypot(b.x - p.x, b.z - p.z));
      if (near > bestScore) {
        bestScore = near;
        best = p;
      }
    }
    if (!best) return this.safeSpawn(map);
    const centre = map.playBounds.getCenter(new THREE.Vector3());
    return { position: best, yaw: Math.atan2(-(centre.x - best.x), -(centre.z - best.z)) };
  }

  /** Mode and match rules on the Play page (saved apart from the settings record). */
  private bindMatchOptions(): void {
    const ms = this.matchSettings;
    const save = () => saveMatchSettings({ ...ms, mode: this.mode });
    this.hud.menu.bindSelect(
      'mode',
      [
        { value: 'deathmatch', label: '봇 데스매치 (개인전)' },
        { value: 'team', label: '5대5 라운드전 (팀전)' },
        { value: 'training', label: '훈련장 (표적)' },
      ] as const,
      this.mode,
      (m) => {
        this.mode = m;
        save();
        this.restartMatch();
      },
    );
    this.hud.menu.bindSelect('bots', BOT_COUNT_OPTIONS.map((n) => ({ value: n, label: `${n}명` })), ms.bots, (n) => {
      ms.bots = n;
      save();
      this.restartMatch();
    });
    this.hud.menu.bindSelect('time-limit', TIME_LIMIT_OPTIONS.map((n) => ({ value: n, label: `${n / 60}분` })), ms.timeLimit, (n) => {
      ms.timeLimit = n;
      save();
      this.restartMatch();
    });
    this.hud.menu.bindSelect('kill-target', KILL_TARGET_OPTIONS.map((n) => ({ value: n, label: `${n}킬` })), ms.killTarget, (n) => {
      ms.killTarget = n;
      save();
      this.restartMatch();
    });
    this.hud.menu.bindSelect('rounds-to-win', ROUNDS_TO_WIN_OPTIONS.map((n) => ({ value: n, label: `${n}승` })), ms.roundsToWin, (n) => {
      ms.roundsToWin = n;
      save();
      this.restartMatch();
    });
    this.hud.menu.bindSelect('round-time', ROUND_TIME_OPTIONS.map((n) => ({ value: n, label: n % 60 ? `${n}초` : `${n / 60}분` })), ms.roundTime, (n) => {
      ms.roundTime = n;
      save();
      this.restartMatch();
    });
    this.hud.menu.setMatchOptionsVisible(this.mode === 'deathmatch');
    this.hud.menu.setTeamOptionsVisible(this.mode === 'team');
  }

  /** The spawn point the player (re)spawns at; training targets are laid out in front of it. */
  private homeSpawn(map: LoadedMap): SpawnPoint | undefined {
    const spawns = map.attackSpawns.length ? map.attackSpawns : map.defenseSpawns;
    return spawns[Math.floor(spawns.length / 2)];
  }

  /**
   * The home spawn if the player fits there, else the first spawn point of the
   * current map whose standing capsule is free of the map geometry.
   */
  private safeSpawn(map: LoadedMap): SpawnPoint | undefined {
    const home = this.homeSpawn(map);
    const r = PLAYER_CONFIG.radius;
    const seg = new THREE.Line3();
    for (const s of [home, ...map.attackSpawns, ...map.defenseSpawns]) {
      if (!s) continue;
      const feet = s.position.y + 0.1;
      seg.start.set(s.position.x, feet + r + 0.05, s.position.z);
      seg.end.set(s.position.x, feet + PLAYER_CONFIG.standHeight - r, s.position.z);
      if (!map.collision.capsuleOverlaps(seg, r - 0.02)) return s;
    }
    return home;
  }

  /** Hit feedback for the local player: HUD flash + direction of the shot. */
  private onPlayerDamaged(e: PlayerDamageEvent): void {
    const p = this.player;
    if (!p) return;
    // Screen angle of where the shot came from: 0 = ahead, +PI/2 = right.
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    const sx = -e.direction.x;
    const sz = -e.direction.z;
    const angle = Math.atan2(sx * -fz + sz * fx, sx * fx + sz * fz);
    this.hud.showDamage(e.amount, angle);
    if (e.killed) {
      this.audio.stopGroup('foley');
      this.match?.recordKill(e.sourceId, 'local', e.weaponId, e.zone === 'head');
      this.teamMatch?.recordKill(e.sourceId, 'local', e.weaponId, e.zone === 'head');
    }
  }

  private frame(timestamp: number): void {
    this.timer.update(timestamp);
    const frameTime = Math.min(this.timer.getDelta(), SIM_CONFIG.maxFrameTime);
    const player = this.player;
    if (!player) {
      // Between maps: keep the screen alive behind the loading panel.
      this.renderer.clear();
      return;
    }

    this.input.poll(this.inputState);
    const combat = this.combat;
    if (combat && !combat.alive) {
      // Dead: the view stays where it fell; mouse movement is dropped.
      this.inputState.lookYaw = 0;
      this.inputState.lookPitch = 0;
    }
    const lookYaw = this.inputState.lookYaw;
    const lookPitch = this.inputState.lookPitch;
    this.weapons?.onLookInput(lookPitch);
    player.applyLook(this.inputState);

    if (this.input.active) {
      const tick = 1 / SIM_CONFIG.tickRate;
      this.accumulator += frameTime;
      let ticks = 0;
      const command = this.weaponCommand();
      this.frameShotTick = -1;
      while (this.accumulator >= tick) {
        this.tickInFrame = ticks;
        ticks++;
        this.prevPos.copy(player.position);
        this.prevEyeHeight = player.eyeHeight;
        const alive = !combat || combat.alive;
        const tm = this.teamMatch;
        // Team match: frozen at the spawn before a round, no shooting unless the round is live.
        const frozen = tm?.phase === 'prep';
        const live = !tm || tm.phase === 'live';
        // A dead player still falls (gravity, collision) but neither moves nor shoots.
        player.step(alive && !frozen ? this.inputState : this.deadInput, tick);
        if (alive) this.weapons?.step(live ? command : { ...command, fire: false }, tick);
        combat?.step(tick);
        this.trainingRange?.step(tick);
        if (this.match && !this.match.over) {
          this.squad?.step(tick, this.playerCombatant);
          this.match.update(tick);
        }
        if (tm) {
          if (tm.phase === 'live') this.squad?.step(tick, this.playerCombatant);
          else this.squad?.hold(tick);
          if (tm.update(tick, this.teamAlive()) === 'round-start') this.startRound();
        }
        // Switch requests are one-shot: apply them on the first tick only.
        command.equipSlot = -1;
        command.equipLast = false;
        this.accumulator -= tick;
      }
      if (ticks > 0) this.input.clearLatches();
      // Team match: no respawn during a round (the next round brings everyone back).
      const fellOut = player.position.y < this.mapDef.killPlaneY && (!this.teamMatch || !!combat?.alive);
      if ((combat?.respawnDue && !this.teamMatch) || fellOut) this.respawn();
      // Match over: freeze, release the mouse, show the results.
      if (this.match?.over && !this.matchHud.resultsShown) {
        this.matchHud.showResults(this.match);
        document.exitPointerLock();
      }
      if (this.teamMatch?.over && !this.teamHud.resultsShown) {
        this.teamHud.showResults(this.teamMatch);
        document.exitPointerLock();
      }
    }
    const dead = !!combat && !combat.alive;

    // Interpolate between the last two ticks for smooth motion at any refresh rate.
    const alpha = this.input.active ? this.accumulator * SIM_CONFIG.tickRate : 1;
    let eye = THREE.MathUtils.lerp(this.prevEyeHeight, player.eyeHeight, alpha);
    let roll = 0;
    if (dead) {
      // Death view: the camera slumps to the ground and tilts over 0.6 s.
      const k = THREE.MathUtils.smoothstep(combat!.deadTime, 0, 0.6);
      eye = THREE.MathUtils.lerp(eye, 0.35, k);
      roll = 0.35 * k;
    }
    this.camera.position.lerpVectors(this.prevPos, player.position, alpha);
    this.camera.position.y += eye;
    this.camera.rotation.set(player.pitch, player.yaw, roll);
    if (dead && this.teamMatch) this.spectate(combat!.deadTime);
    this.body.object.visible = !dead;
    this.updateBody(frameTime, eye);

    const w = this.weapons?.weapon;
    this.weaponAudio.update(w);
    this.impacts.update(frameTime);
    this.blood.update(frameTime, this.camera);
    this.squad?.updateVisuals(frameTime);
    this.fx.update(frameTime, this.camera);
    if (this.match) this.matchHud.update(this.match, this.scoreboardHeld && this.input.active);
    if (this.teamMatch) this.teamHud.update(this.teamMatch, this.teamAlive(), this.scoreboardHeld && this.input.active);
    this.viewModel.update(
      frameTime,
      {
        lookYaw,
        lookPitch,
        speed01: Math.hypot(player.velocity.x, player.velocity.z) / PLAYER_CONFIG.runSpeed,
        grounded: player.grounded,
        crouching: player.crouching,
      },
      this.animState(w),
    );

    this.sky.follow(this.camera);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    // No weapon in hand while dead.
    if (!dead) this.viewModel.render(this.renderer);
    this.hud.setHealth(player.health);
    if (this.teamMatch) this.hud.setDeath(dead ? 0 : null, 1);
    else this.hud.setDeath(dead ? combat!.respawnIn : null, RESPAWN_DELAY);
    this.updateWeaponHud();
    this.updateStats(frameTime);
  }

  /**
   * Team match, dead player: after a moment the camera follows a living
   * teammate from just behind its shoulder (fire cycles teammates), so the
   * rest of the round can be watched. With no teammate left the death view stays.
   */
  private spectate(deadTime: number): void {
    const fire = this.inputState.fire;
    const pressed = fire && !this.spectateFireHeld;
    this.spectateFireHeld = fire;
    const allies = (this.squad?.bots ?? []).filter((b) => b.alive && b.team === this.combat?.team);
    if (deadTime < SPECTATE_AFTER || allies.length === 0 || !this.map) {
      this.hud.setDeathNote(allies.length ? '사망 — 라운드가 끝나면 다시 시작합니다' : '사망 — 남은 아군 없음');
      return;
    }
    if (pressed) this.spectateIndex++;
    const b: Bot = allies[this.spectateIndex % allies.length];
    const c = b.controller;
    _specEye.set(c.position.x, c.position.y + c.eyeHeight, c.position.z);
    // Back along the bot's view and a little up, stopping short of walls.
    _specDir.set(Math.sin(c.yaw) * Math.cos(c.pitch), 0.25, Math.cos(c.yaw) * Math.cos(c.pitch)).normalize();
    const hit = this.map.collision.raycast(_specEye, _specDir, 2.4);
    this.camera.position.copy(_specEye).addScaledVector(_specDir, hit === null ? 2.4 : Math.max(hit - 0.2, 0.1));
    this.camera.rotation.set(c.pitch * 0.6 - 0.12, c.yaw, 0);
    this.hud.setDeathNote(`관전 중: ${b.name} — 클릭으로 아군 전환`);
  }

  /** Poses the lower body from the interpolated camera (same smoothing as the view). */
  private updateBody(dt: number, eyeHeight: number): void {
    const player = this.player;
    if (!player) return;
    const s = this.bodyState;
    s.feet.set(this.camera.position.x, this.camera.position.y - eyeHeight, this.camera.position.z);
    s.yaw = player.yaw;
    s.eyeHeight = eyeHeight;
    s.velocity.copy(player.velocity);
    s.grounded = player.grounded;
    this.body.update(dt, s);
  }

  /**
   * Shows a weapon model in the first-person hands at its configured pose.
   * GLB models show their procedural fallback until the file has loaded.
   */
  private showWeaponModel(spec: WeaponViewSpec): void {
    this.shownSpec = spec;
    this.viewModel.setView(createWeaponView(spec), spec.pose);
    loadWeaponView(spec)
      ?.then((view) => {
        if (this.shownSpec === spec) this.viewModel.setView(view, spec.pose);
        else view.dispose();
      })
      .catch((err) => console.warn('[weapon] could not load GLB model, keeping the placeholder', err));
  }

  private shownSpec: WeaponViewSpec | null = null;
  /** Download of the loadout's weapon GLBs (settles even if one fails). */
  private weaponModels: Promise<void> = Promise.resolve();

  /** Translates this frame's player input into a device-independent weapon command. */
  private weaponCommand(): WeaponCommand {
    const i = this.inputState;
    let equipSlot = i.equipSlot;
    if (equipSlot < 0 && i.equipCycle !== 0 && this.weapons) {
      const n = this.weapons.loadout.length;
      equipSlot = (this.weapons.slot + i.equipCycle + n) % n;
    }
    return { fire: i.fire, reload: i.reload, equipSlot, equipLast: i.equipLast, inspect: i.inspect };
  }

  private animState(w: Weapon | undefined): WeaponAnimState {
    if (!w) return { category: 'rifle', equip: 1, reload: null, sinceShot: Infinity, fireInterval: 1, inspect: null };
    return {
      category: w.def.category,
      equip: w.equipProgress,
      reload: w.status === 'reloading' ? w.reloadProgress : null,
      sinceShot: w.timeSinceShot,
      fireInterval: w.fireInterval,
      inspect: this.weapons?.inspectProgress ?? null,
    };
  }

  /** Dev aid: `game.debugShots = true` in the console logs every shot result. */
  debugShots = false;

  private updateWeaponHud(): void {
    const w = this.weapons?.weapon;
    if (!w) return;
    this.hud.setWeapon(
      w.def.displayName,
      w.usesAmmo ? w.magazine : null,
      w.def.magazineSize,
      w.reserve,
      w.status === 'reloading' ? w.reloadProgress : null,
    );
  }

  private updateStats(dt: number): void {
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime < 0.5) return;
    this.fps = this.fpsFrames / this.fpsTime;
    this.fpsFrames = 0;
    this.fpsTime = 0;
    if (!this.hud.statsVisible || !this.player) return;
    const p = this.player;
    const info = this.renderer.info.render;
    this.hud.setStats(
      `${this.fps.toFixed(0)} fps (limit ${this.loop.frameLimit})  ·  ${info.calls} draws  ·  ${(info.triangles / 1000).toFixed(0)}k tris  ·  ${this.quality}  ·  ${this.mapDef.id}\n` +
        `pos ${p.position.x.toFixed(2)} ${p.position.y.toFixed(2)} ${p.position.z.toFixed(2)}  ` +
        `spd ${Math.hypot(p.velocity.x, p.velocity.z).toFixed(2)}  ${p.grounded ? 'ground' : 'air'}${p.crouching ? ' crouch' : ''}` +
        (this.lastHit ? `\nlast hit ${this.lastHit}` : ''),
    );
  }

  private fitShadowToMap(bounds: THREE.Box3): void {
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const half = Math.max(size.x, size.z) * 0.6;
    const dir = this.sun.position.clone().normalize();
    this.sun.target.position.copy(center);
    // Far enough back that tall buildings sit inside the shadow camera.
    const back = Math.max(size.y, 40) + 60;
    this.sun.position.copy(center).addScaledVector(dir, back);
    const cam = this.sun.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = back * 2 + half;
    cam.updateProjectionMatrix();
    this.sun.target.updateMatrixWorld();
  }

  private onLockChange(locked: boolean): void {
    this.hud.setPaused(!locked);
    if (locked) {
      this.accumulator = 0;
      if (!this.hasStarted) {
        this.hasStarted = true;
        this.hud.setResumeMode(true);
      }
    } else if (this.player) {
      this.hud.setReady('일시정지됨');
    }
  }

  private hasStarted = false;
  private thumbnailsDone = false;

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.viewModel.setAspect(this.camera.aspect);
  };
}

/** Weapon card data straight from the weapon definition (no invented stats). */
function menuWeapon(def: WeaponDefinition, slot: number): MenuWeapon {
  const stats =
    def.magazineSize > 0
      ? [
          { label: '탄약', value: `${def.magazineSize} / ${def.reserveAmmo}` },
          { label: '연사', value: `${def.fireRate} RPM` },
          { label: '피해', value: String(def.damage.base) },
        ]
      : [
          { label: '사거리', value: `${def.damage.maxRange} m` },
          { label: '피해', value: String(def.damage.base) },
        ];
  return { slot, id: def.id, name: def.displayName, category: def.category, stats };
}
