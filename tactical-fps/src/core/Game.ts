import * as THREE from 'three';
import { HitscanSystem } from '../combat/HitscanSystem';
import { CAMERA_CONFIG, PLAYER_CONFIG, QUALITY_PRESETS, SIM_CONFIG, type QualityLevel } from '../config';
import { ImpactEffects } from '../fx/ImpactEffects';
import { createInputState } from '../input/InputState';
import { KeyboardMouseInput } from '../input/KeyboardMouseInput';
import { PlayerController } from '../player/PlayerController';
import { Hud } from '../ui/Hud';
import { createWeaponView } from '../weapons/view/WeaponView';
import { ViewModelLayer } from '../weapons/view/ViewModelLayer';
import { AR_01 } from '../weapons/weapons';
import { WeaponSystem } from '../weapons/WeaponSystem';
import { findMap, MAPS, type MapDefinition } from '../maps';
import { disposeMap, loadMap, type LoadedMap } from '../world/MapLoader';
import { FRAME_LIMIT_OPTIONS, FrameLoop, type FrameLimit } from './FrameLoop';

const QUALITY_OPTIONS: readonly { value: QualityLevel; label: string }[] = [
  { value: 'low', label: '낮음 (성능 우선)' },
  { value: 'medium', label: '중간' },
  { value: 'high', label: '높음' },
];
import { saveSettings, type Settings } from './Settings';

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
  readonly impacts = new ImpactEffects();
  readonly viewModel: ViewModelLayer;

  private readonly input: KeyboardMouseInput;
  private readonly inputState = createInputState();
  private readonly timer = new THREE.Timer();
  private readonly loop = new FrameLoop((now) => this.frame(now));
  private loadingMap = false;
  private readonly sun: THREE.DirectionalLight;
  private accumulator = 0;
  private readonly prevPos = new THREE.Vector3();
  private prevEyeHeight = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private fps = 0;

  constructor(container: HTMLElement, quality: QualityLevel, settings: Settings) {
    this.quality = quality;
    this.settings = settings;
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
    this.viewModel.setView(createWeaponView(AR_01.view));
    this.scene.add(this.impacts.group);

    // Overcast late-afternoon look: soft sky fill + one warm key light.
    const skyColor = new THREE.Color(0x9fb0bf);
    this.scene.background = skyColor;
    this.scene.fog = new THREE.Fog(skyColor, mapDef.environment.fogNear, mapDef.environment.fogFar);
    this.scene.add(new THREE.HemisphereLight(0xc9d4de, 0x4a4238, 1.35));
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
    this.sun.position.set(28, 45, 18);
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
    this.input = new KeyboardMouseInput(this.renderer.domElement, (locked) => this.onLockChange(locked));
    this.hud.onStart(() => this.input.requestLock());
    this.renderer.domElement.addEventListener('click', () => {
      if (this.player && !this.loadingMap && !this.input.active) this.input.requestLock();
    });

    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        const show = !this.hud.statsVisible;
        this.hud.setStatsVisible(show);
        if (this.map) this.map.zoneMarkers.visible = show;
      } else if (e.code === 'F4' && this.input.active) {
        e.preventDefault();
        this.respawn();
      }
    });
  }

  async start(): Promise<void> {
    if (!(await this.loadMapInto(this.mapDef))) return;
    this.timer.connect(document);
    this.loop.start();
  }

  /** Swaps the current map for another one without reloading the page. */
  async switchMap(id: string): Promise<void> {
    const def = findMap(id);
    if (this.loadingMap || def.id === this.mapDef.id) return;
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.map) disposeMap(this.map);
    this.map = null;
    this.player = null;
    this.hitscan = null;
    this.weapons = null;
    this.impacts.clear();
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

  private async loadMapInto(def: MapDefinition): Promise<boolean> {
    this.loadingMap = true;
    this.hud.setMapSelectEnabled(false);
    this.hud.setLoading('맵 불러오는 중… 0%');
    let map: LoadedMap;
    try {
      map = await loadMap(def, (r) => this.hud.setLoading(`맵 불러오는 중… ${Math.round(r * 100)}%`));
    } catch (err) {
      console.error(err);
      this.hud.setError(`맵을 불러오지 못했습니다: ${def.url}`);
      this.loadingMap = false;
      this.hud.setMapSelectEnabled(true);
      return false;
    }
    this.map = map;
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
    this.weapons = new WeaponSystem(AR_01, this.player, this.hitscan);
    this.weapons.events = {
      onShot: (result) => {
        this.viewModel.onShot();
        if (result.kind !== 'miss') this.impacts.spawn(result.point, result.normal);
        if (import.meta.env.DEV && this.debugShots) console.debug('[shot]', result.kind, 'distance' in result ? result.distance.toFixed(2) : '');
      },
    };
    this.respawn();

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
    this.hud.setReady();
    this.hud.setHealth(this.player.health);
    this.updateWeaponHud();
    return true;
  }

  respawn(): void {
    if (!this.map || !this.player) return;
    const spawns = this.map.attackSpawns.length ? this.map.attackSpawns : this.map.defenseSpawns;
    const spawn = spawns[Math.floor(spawns.length / 2)];
    const pos = spawn ? spawn.position.clone() : this.map.playBounds.getCenter(new THREE.Vector3());
    // Spawn empties sit slightly above the floor; drop onto it from a little higher.
    pos.y += 0.1;
    this.player.teleport(pos, spawn?.yaw ?? 0);
    this.weapons?.resetForRespawn();
    this.impacts.clear();
    this.prevPos.copy(this.player.position);
    this.prevEyeHeight = this.player.eyeHeight;
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
    const lookYaw = this.inputState.lookYaw;
    const lookPitch = this.inputState.lookPitch;
    this.weapons?.onLookInput(lookPitch);
    player.applyLook(this.inputState);

    if (this.input.active) {
      const tick = 1 / SIM_CONFIG.tickRate;
      this.accumulator += frameTime;
      let ticks = 0;
      while (this.accumulator >= tick) {
        ticks++;
        this.prevPos.copy(player.position);
        this.prevEyeHeight = player.eyeHeight;
        player.step(this.inputState, tick);
        this.weapons?.step(this.inputState, tick);
        this.accumulator -= tick;
      }
      if (ticks > 0) this.input.clearLatches();
      if (player.position.y < this.mapDef.killPlaneY) this.respawn();
    }

    // Interpolate between the last two ticks for smooth motion at any refresh rate.
    const alpha = this.input.active ? this.accumulator * SIM_CONFIG.tickRate : 1;
    const eye = THREE.MathUtils.lerp(this.prevEyeHeight, player.eyeHeight, alpha);
    this.camera.position.lerpVectors(this.prevPos, player.position, alpha);
    this.camera.position.y += eye;
    this.camera.rotation.set(player.pitch, player.yaw, 0);

    const w = this.weapons?.weapon;
    this.impacts.update(frameTime);
    this.viewModel.update(frameTime, {
      lookYaw,
      lookPitch,
      speed01: Math.hypot(player.velocity.x, player.velocity.z) / PLAYER_CONFIG.runSpeed,
      grounded: player.grounded,
      crouching: player.crouching,
      reloadProgress: w && w.status === 'reloading' ? w.reloadProgress : null,
    });

    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.viewModel.render(this.renderer);
    this.hud.setHealth(player.health);
    this.updateWeaponHud();
    this.updateStats(frameTime);
  }

  /** Dev aid: `game.debugShots = true` in the console logs every shot result. */
  debugShots = false;

  private updateWeaponHud(): void {
    const w = this.weapons?.weapon;
    if (!w) return;
    this.hud.setWeapon(w.def.displayName, w.magazine, w.def.magazineSize, w.reserve, w.status === 'reloading' ? w.reloadProgress : null);
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
        `spd ${Math.hypot(p.velocity.x, p.velocity.z).toFixed(2)}  ${p.grounded ? 'ground' : 'air'}${p.crouching ? ' crouch' : ''}`,
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
    } else if (this.player) {
      this.hud.setReady('일시정지됨');
    }
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.viewModel.setAspect(this.camera.aspect);
  };
}
