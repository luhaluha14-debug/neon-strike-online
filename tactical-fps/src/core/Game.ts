import * as THREE from 'three';
import { BotSquad, type SquadMember } from '../ai/BotSquad';
import { preloadAgentModels } from '../ai/AgentModel';
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
import { BuyMenu } from '../ui/BuyMenu';
import { BuyLoadout, LOADOUT_RULES, type BuyResult } from '../game/Economy';
import { CATALOG } from '../weapons/catalog';
import { loadGltfScene } from '../weapons/view/GltfWeaponView';
import { createWeaponView, loadWeaponView, preloadWeaponViews } from '../weapons/view/WeaponView';
import type { MenuWeapon } from '../ui/MainMenu';
import { renderWeaponThumbnails } from '../ui/weaponThumbnails';
import type { WeaponDefinition, WeaponViewSpec } from '../weapons/WeaponDefinition';
import { ViewModelLayer } from '../weapons/view/ViewModelLayer';
import type { Weapon } from '../weapons/Weapon';
import { AR_01, DEFAULT_LOADOUT, SR_01, WEAPONS } from '../weapons/weapons';
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
  /** Team match buy menu ("작전 준비") and the player's gear for the current round. */
  private readonly buyMenu: BuyMenu;
  readonly buyLoadout = new BuyLoadout();
  /**
   * The buy menu is open: the pointer lock is released for the mouse, yet
   * the simulation keeps running (the buy clock counts down; everyone is
   * frozen in the prep phase anyway) and no game input gets through.
   */
  buyMenuOpen = false;
  /** Team match: number key (0 = "1") of each entry of the player's loadout; null outside the team match. */
  private playerSlotKeys: number[] | null = null;
  /** Looking through a weapon scope this frame (derived every frame from button, weapon and state). */
  scoped = false;
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
      if (page === 'loadout') this.renderThumbnails();
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
    this.buyMenu = new BuyMenu(this.hud.root, {
      onBuy: (id) => void this.buy(id),
      onReady: () => this.confirmReady(),
      onClose: () => this.closeBuyMenu(true),
    });
    // A failed re-lock after the buy menu (no click to grant it) falls back to the normal pause menu.
    document.addEventListener('pointerlockerror', () => {
      if (!this.input.active && !this.buyMenuOpen && this.hasStarted) {
        this.hud.setPaused(true);
        this.hud.setReady('일시정지됨');
      }
    });
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
      } else if (e.code === 'KeyB' && !e.repeat && this.teamMatch?.buyOpen) {
        // B toggles the buy menu during the prep phase (closing re-captures the mouse).
        if (this.buyMenuOpen) this.closeBuyMenu(true);
        else if (this.input.active) this.openBuyMenu();
      } else if (e.code === 'Escape' && this.buyMenuOpen) {
        // Esc: leave the buy menu for the normal pause menu.
        this.closeBuyMenu(false);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') this.scoreboardHeld = false;
    });
  }

  async start(): Promise<void> {
    // Weapon GLBs download alongside the map; the game is ready once both are in.
    // Every weapon model (the team match buy menu can issue any of them).
    this.weaponModels = preloadWeaponViews(Object.values(WEAPONS).map((d) => d.view));
    // Bot character models (small): in before the first match is set up.
    this.agentModels = preloadAgentModels();
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
    await Promise.all([this.weaponModels, this.agentModels]);
    this.showWeaponModel(this.weapons.weapon.def.view);
    this.updateLoadoutHud();
    this.weapons.events = {
      onEquip: (weapon, slot) => {
        this.showWeaponModel(weapon.def.view);
        this.weaponAudio.onEquip(weapon);
        this.updateLoadoutHud(slot);
      },
      onShot: (result, _origin, dir, weapon, pellet) => {
        // Rounds resolved in later ticks of the same frame keep their real spacing.
        if (this.frameShotTick < 0) this.frameShotTick = this.tickInFrame;
        const delay = (this.tickInFrame - this.frameShotTick) / SIM_CONFIG.tickRate;
        // A shotgun round: one blast, one kick; every pellet keeps its own hit, tracer and impact.
        // (No pellet index = a single-bullet round.)
        if (!pellet) {
          this.weaponAudio.onShot(weapon, result, delay, this.camera);
          this.viewModel.onShot(weapon.def.category);
        }
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
    // Team match: weapons come from the buy menu, not from the menu's Weapons page.
    this.hud.setWeaponOptionsEnabled(!this.teamMatch);
    this.hud.setReady(this.hasStarted ? '일시정지됨' : '준비 완료');

    this.hud.setHealth(this.player.health);
    this.updateWeaponHud();
    return true;
  }

  /**
   * Puts the player at a spawn, alive. `keepWeapons` (team match survivor):
   * the weapons keep their magazines and reserves; otherwise every weapon is
   * refilled.
   */
  respawn(keepWeapons = false): void {
    if (!this.map || !this.player) return;
    const spawn = this.teamMatch ? this.teamSpawns?.blue[0] : this.squad ? this.deathmatchSpawn() : this.safeSpawn(this.map);
    this.spawnPoint = spawn ?? null;
    const pos = spawn ? spawn.position.clone() : this.map.playBounds.getCenter(new THREE.Vector3());
    // Spawn empties sit slightly above the floor; drop onto it from a little higher.
    pos.y += 0.1;
    this.player.teleport(pos, spawn?.yaw ?? 0);
    if (keepWeapons) this.weapons?.clearTransient();
    else this.weapons?.resetForRespawn();
    this.body.reset();
    // A team match survivor keeps the armour left on the vest (LOADOUT_RULES).
    this.combat?.reset(keepWeapons && LOADOUT_RULES.keepOnSurvive.armor);
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
      const squad = new BotSquad(map, this.nav, hitscan, team ? TEAM_ROSTER : this.matchSettings.bots, [AR_01], Math.random, this.matchSettings.botLook);
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
    this.hud.menu.setBotOptionsVisible(dm || team);
    if (!this.loadingMap) this.hud.setWeaponOptionsEnabled(!team);
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
  private startRound(carryOver = false): void {
    const squad = this.squad;
    const spawns = this.teamSpawns;
    if (!squad || !spawns) return;
    this.closeBuyMenu(false, true);
    // Gear between rounds (LOADOUT_RULES): a survivor keeps weapons (with their ammo);
    // otherwise, and at the start of a match, back to the default issue. Money always carries over.
    const kept = this.buyLoadout.carryOver(carryOver && !!this.combat?.alive);
    if (kept) this.playerSlotKeys = this.buyLoadout.weapons().map((e) => e.slotKey);
    else this.applyBuyLoadout();
    this.buyMenu.clearFeedback();
    this.respawn(kept);
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
    this.closeBuyMenu(false, true);
    // Leaving the team match: back to the standard loadout of the other modes.
    if (this.playerSlotKeys) {
      this.playerSlotKeys = null;
      this.weapons?.setLoadout(DEFAULT_LOADOUT);
    }
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
    this.hud.menu.bindSelect(
      'bot-look',
      [
        { value: 'procedural', label: '기본 (애니메이션)' },
        { value: 'agents', label: '요원 모델 (정적 포즈)' },
      ] as const,
      ms.botLook,
      (look) => {
        ms.botLook = look;
        save();
        this.restartMatch();
      },
    );
    this.hud.menu.setMatchOptionsVisible(this.mode === 'deathmatch');
    this.hud.menu.setTeamOptionsVisible(this.mode === 'team');
    this.hud.menu.setBotOptionsVisible(this.mode !== 'training');
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
    if (this.buyMenuOpen) {
      // Buy menu: nothing reaches the game, including look / clicks that slipped in
      // around the moment the pointer lock was released.
      Object.assign(this.inputState, createInputState());
      this.input.clearLatches();
    }
    const combat = this.combat;
    if (combat && !combat.alive) {
      // Dead: the view stays where it fell; mouse movement is dropped.
      this.inputState.lookYaw = 0;
      this.inputState.lookPitch = 0;
    }
    // Scope (SR-01): right button held with the weapon ready, playing, alive; look slowed while zoomed.
    const held = this.weapons?.weapon;
    const scope = held?.def.scope;
    this.scoped =
      !!scope &&
      !!held &&
      this.inputState.aim &&
      this.input.active &&
      !this.buyMenuOpen &&
      (!combat || combat.alive) &&
      held.status === 'ready' &&
      held.timeSinceShot >= held.fireInterval * 0.85;
    if (this.scoped && scope) {
      this.inputState.lookYaw *= scope.sensitivity;
      this.inputState.lookPitch *= scope.sensitivity;
    }
    const fov = this.scoped && scope ? scopedFov(CAMERA_CONFIG.fov, scope.zoom) : CAMERA_CONFIG.fov;
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.hud.setScoped(this.scoped);
    const lookYaw = this.inputState.lookYaw;
    const lookPitch = this.inputState.lookPitch;
    this.weapons?.onLookInput(lookPitch);
    player.applyLook(this.inputState);

    // The buy menu releases the mouse but the round clock keeps running behind it.
    if (this.input.active || this.buyMenuOpen) {
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
          if (tm.update(tick, this.teamAlive()) === 'round-start') this.startRound(true);
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
    this.updateBuyPhase();
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
    // No weapon in hand while dead; none while looking through the scope.
    if (!dead && !this.scoped) this.viewModel.render(this.renderer);
    this.hud.setHealth(player.health);
    this.hud.setArmor(this.combat?.armor ?? 0);
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
  /** Download of the bot character GLBs (settles even if one fails). */
  private agentModels: Promise<void> = Promise.resolve();

  /** Translates this frame's player input into a device-independent weapon command. */
  private weaponCommand(): WeaponCommand {
    const i = this.inputState;
    let equipSlot = i.equipSlot;
    // Team match: 1 primary, 2 secondary, 3 knife, whatever was bought (a key with nothing behind it does nothing).
    if (equipSlot >= 0 && this.playerSlotKeys) equipSlot = this.playerSlotKeys.indexOf(equipSlot);
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
    if (locked && this.buyMenuOpen) {
      // Captured again some other way: the buy menu is done.
      this.buyMenuOpen = false;
      this.buyMenu.hide();
    }
    // Releasing the mouse for the buy menu is not a pause.
    this.hud.setPaused(!locked && !this.buyMenuOpen);
    if (locked) {
      this.accumulator = 0;
      if (!this.hasStarted) {
        this.hasStarted = true;
        this.hud.setResumeMode(true);
      }
    } else if (this.player && !this.buyMenuOpen) {
      this.hud.setReady('일시정지됨');
    }
  }

  // --- Team match buy phase ------------------------------------------------------

  /**
   * Buys a catalog item for the player. Only in the prep phase of a team
   * match, while alive; money and gear change together or not at all, and
   * the result is issued to the real weapon system at once.
   */
  buy(id: string): BuyResult {
    const tm = this.teamMatch;
    const eco = tm?.economy;
    if (!tm || !eco || !tm.buyOpen || !this.combat?.alive) {
      const r: BuyResult = { ok: false, item: null, reason: 'phase', message: '지금은 구매할 수 없습니다 (작전 준비 중에만 가능)', spent: 0 };
      this.buyMenu.feedback(r.message, false);
      return r;
    }
    const r = this.buyLoadout.buy(id, eco, 'local', { armor: this.combat.armor });
    this.buyMenu.feedback(r.message, r.ok);
    if (r.ok && r.armor !== undefined) this.combat.armor = r.armor;
    else if (r.ok && r.item?.weapon) this.applyBuyLoadout(r.item.id);
    return r;
  }

  /** Issues the bought gear to the player's WeaponSystem; draws `draw` (catalog id) or the best weapon held. */
  private applyBuyLoadout(draw?: string): void {
    if (!this.weapons) return;
    const entries = this.buyLoadout.weapons();
    this.playerSlotKeys = entries.map((e) => e.slotKey);
    const idx = draw ? entries.findIndex((e) => e.item.id === draw) : 0;
    this.weapons.setLoadout(
      entries.map((e) => e.item.weapon!),
      Math.max(idx, 0),
    );
  }

  /** "출격 확정": the round goes live on the next tick for everyone at once. */
  confirmReady(): void {
    this.teamMatch?.ready();
    this.closeBuyMenu(true);
  }

  openBuyMenu(): void {
    const tm = this.teamMatch;
    if (!tm?.buyOpen || !this.combat?.alive || this.buyMenuOpen) return;
    this.renderThumbnails();
    this.buyMenuOpen = true;
    this.updateBuyMenu();
    this.buyMenu.show();
    this.scoreboardHeld = false;
    if (this.input.active) document.exitPointerLock();
  }

  /**
   * Closes the buy menu. `relock`: capture the mouse again (works from a
   * click or key press; if the browser refuses, the pause menu shows and the
   * game waits). Otherwise (Esc) the pause menu shows. `silent`: just hide.
   */
  closeBuyMenu(relock: boolean, silent = false): void {
    if (!this.buyMenuOpen) return;
    this.buyMenuOpen = false;
    this.buyMenu.hide();
    this.accumulator = 0;
    if (silent || this.input.active) return;
    if (relock) this.input.requestLock();
    else {
      this.hud.setPaused(true);
      this.hud.setReady('일시정지됨');
    }
  }

  /**
   * Per frame: close the buy menu when buying ends (buy time up, the round
   * went live, the match changed) and refresh it while open. It is opened
   * with B (not automatically: closing it on time-out cannot re-capture the
   * mouse without a click, so the game would wait on the pause menu).
   */
  private updateBuyPhase(): void {
    const tm = this.teamMatch;
    if (this.buyMenuOpen && !(tm?.buyOpen && this.combat?.alive)) this.closeBuyMenu(true);
    if (this.buyMenuOpen) this.updateBuyMenu();
  }

  private updateBuyMenu(): void {
    const tm = this.teamMatch;
    if (!tm?.economy) return;
    this.buyMenu.update({ timeLeft: tm.phaseLeft, money: tm.economy.money('local'), loadout: this.buyLoadout, armor: this.combat?.armor ?? 0 });
  }

  /** HUD slot strip; in the team match the numbers are the keys (1 primary, 2 secondary, 3 knife). */
  private updateLoadoutHud(slot = this.weapons?.slot ?? 0): void {
    if (!this.weapons) return;
    this.hud.setLoadout(
      this.weapons.loadout.map((w) => w.def.displayName),
      slot,
      this.playerSlotKeys?.map((k) => k + 1),
    );
  }

  /**
   * Weapon images for the menu's Weapons page and the buy menu: rendered
   * once, on first need. The buy menu also shows the models of weapons that
   * are not implemented yet (catalog previews), once their GLB has loaded.
   */
  private renderThumbnails(): void {
    if (this.thumbnailsDone) return;
    this.thumbnailsDone = true;
    const env = this.viewModel.scene.environment;
    void renderWeaponThumbnails(this.renderer, env, DEFAULT_LOADOUT, (id, url) => {
      this.hud.menu.setWeaponThumbnail(id, url);
      this.buyMenu.setThumbnail(id, url);
    })
      .then(async () => {
        // Buy-menu-only weapons (not in the standard loadout), once their GLB is in.
        const extra = CATALOG.flatMap((i) => (i.weapon && !DEFAULT_LOADOUT.includes(i.weapon) ? [i.weapon] : []));
        await this.weaponModels;
        await renderWeaponThumbnails(this.renderer, env, extra, (id, url) => this.buyMenu.setThumbnail(id, url));
        // Locked weapons that already have a model (catalog previews).
        const previews = CATALOG.filter((i) => i.preview?.kind === 'gltf');
        const ready = await Promise.all(
          previews.map((i) =>
            loadGltfScene((i.preview as { url: string }).url).then(
              () => true,
              (err) => (console.warn(`[buy] ${i.id} model unavailable, keeping the icon`, err), false),
            ),
          ),
        );
        const loaded = previews.filter((_, k) => ready[k]).map((i) => ({ id: i.id, view: i.preview! }));
        await renderWeaponThumbnails(this.renderer, env, loaded, (id, url) => this.buyMenu.setThumbnail(id, url));
      })
      .catch((err) => console.warn('[menu] weapon thumbnails unavailable', err));
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

/** Vertical field of view (degrees) that magnifies `base` by `zoom`. */
function scopedFov(base: number, zoom: number): number {
  return (2 * Math.atan(Math.tan((base * Math.PI) / 360) / zoom) * 180) / Math.PI;
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
