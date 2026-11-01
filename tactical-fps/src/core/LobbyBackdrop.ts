import * as THREE from 'three';
import { AGENT_MODEL_URLS, AgentModel } from '../ai/AgentModel';
import { BotKit } from '../ai/BotModel';
import { loadedGltfScene } from '../weapons/view/GltfWeaponView';
import type { LobbyShotDef } from '../maps';
import type { LoadedMap } from '../world/MapLoader';

// The lobby's background: the loaded map seen from its own camera (the
// map's hand-set shot from maps.ts, else one picked from its spawns), with the operator model
// (the existing BLUE character file) standing in the foreground. Nothing is
// downloaded for it: the map is the one the game has loaded and the
// character file is the one the bots already preload. The picture does not
// move, so it is drawn only when something changed (shown, resized, a new
// map, the character ready) instead of every frame; the game camera is
// never touched, so entering the game shows exactly what it showed before.

const EYE = 2.1;
const PITCH = -0.07;
const FOV = 50;
/** Directions tried around each spawn, and how far a view is measured. */
const DIRECTIONS = 24;
const VIEW_RANGE = 90;
/** The figure: distance in front of the camera and sideways offset (to the right third of the picture). */
const FIGURE_AHEAD = 5.6;
const FIGURE_SIDE = 1.7;

export interface LobbyShot {
  position: THREE.Vector3;
  yaw: number;
  pitch: number;
  /** Where the figure stands (y: found on the ground) and faces. */
  figure: THREE.Vector3;
  figureYaw: number;
}

/** The figure for an automatic shot: ahead of the camera, to the right, turned three-quarters toward it. */
function autoFigure(position: THREE.Vector3, yaw: number): Pick<LobbyShot, 'figure' | 'figureYaw'> {
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  return { figure: position.clone().addScaledVector(fwd, FIGURE_AHEAD).addScaledVector(right, FIGURE_SIDE), figureYaw: yaw + Math.PI - 0.55 };
}

/** A map's hand-set shot (maps.ts). */
export function lobbyShotFromDef(def: LobbyShotDef): LobbyShot {
  const [x, y, z] = def.camera;
  return { position: new THREE.Vector3(x, y, z), yaw: def.yaw, pitch: def.pitch, figure: new THREE.Vector3(def.figure[0], y, def.figure[1]), figureYaw: def.figureYaw };
}

/**
 * Establishing shot: from the spawns, the direction with the longest open
 * view at a little above eye height (streets and the scenery beyond rather
 * than a wall), leaning toward the middle of the play area.
 */
export function pickLobbyShot(map: Pick<LoadedMap, 'collision' | 'playBounds' | 'attackSpawns' | 'defenseSpawns'>): LobbyShot {
  const spawns = [...map.attackSpawns, ...map.defenseSpawns];
  const centre = map.playBounds.getCenter(new THREE.Vector3());
  if (spawns.length === 0) spawns.push({ position: new THREE.Vector3(centre.x, map.playBounds.min.y, centre.z), yaw: 0 });
  const dir = new THREE.Vector3();
  const eye = new THREE.Vector3();
  let best = { position: spawns[0].position.clone().setY(spawns[0].position.y + EYE), yaw: 0 };
  let bestScore = -Infinity;
  for (const s of spawns) {
    eye.copy(s.position).setY(s.position.y + EYE);
    const toCentre = Math.atan2(-(centre.x - eye.x), -(centre.z - eye.z));
    for (let k = 0; k < DIRECTIONS; k++) {
      const yaw = (k / DIRECTIONS) * Math.PI * 2;
      dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      const open = map.collision.raycast(eye, dir, VIEW_RANGE) ?? VIEW_RANGE;
      // The view must also be clear where the figure stands (a little to the right).
      const side = map.collision.raycast(eye, dir.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, -0.3), FIGURE_AHEAD + 1.5) ?? VIEW_RANGE;
      if (side < FIGURE_AHEAD + 1) continue;
      const lean = Math.cos(yaw - toCentre);
      const score = Math.min(open, VIEW_RANGE) + 12 * lean;
      if (score > bestScore) {
        bestScore = score;
        best = { position: eye.clone(), yaw };
      }
    }
  }
  return { ...best, pitch: PITCH, ...autoFigure(best.position, best.yaw) };
}

export class LobbyBackdrop {
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 2000);
  private figure: AgentModel | null = null;
  private kit: BotKit | null = null;
  private shown = false;
  private dirty = true;
  /** Scene draws made for the lobby (tests / stats). */
  renders = 0;
  /** Where the current shot came from: the map's own ('map') or picked from the spawns ('auto'). */
  source: 'map' | 'auto' | null = null;

  constructor(private readonly scene: THREE.Scene) {}

  /**
   * A map finished loading: its shot replaces the previous map's entirely
   * (camera, view, figure), so nothing of the last picture carries over.
   */
  setMap(map: LoadedMap, def?: LobbyShotDef): void {
    const shot = def ? lobbyShotFromDef(def) : pickLobbyShot(map);
    this.source = def ? 'map' : 'auto';
    this.map = map;
    this.def = def;
    this.camera.position.copy(shot.position);
    this.camera.rotation.set(shot.pitch, shot.yaw, 0, 'YXZ');
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.placeFigure(map, shot);
    this.dirty = true;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    // Narrow (portrait / small laptop) screens: a wider view so the figure stays in the picture.
    this.camera.fov = aspect < 1.2 ? 64 : FOV;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /** Lobby shown or hidden; the figure only exists in the picture while it is. */
  setShown(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    if (this.figure) this.figure.object.visible = on;
    this.dirty = true;
  }

  get isShown(): boolean {
    return this.shown;
  }

  /** Something in the picture changed: draw again on the next frame. */
  invalidate(): void {
    this.dirty = true;
  }

  /** Draws the lobby picture if it changed. `hide`: objects kept out of it (the first-person body). */
  render(renderer: THREE.WebGLRenderer, follow: (camera: THREE.PerspectiveCamera) => void, hide: THREE.Object3D[]): void {
    if (!this.dirty) return;
    this.dirty = false;
    const was = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    follow(this.camera);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    hide.forEach((o, i) => (o.visible = was[i]));
    this.renders++;
  }

  private map: LoadedMap | null = null;
  private def: LobbyShotDef | undefined;

  private placeFigure(map: LoadedMap, shot: LobbyShot): void {
    const template = loadedGltfScene(AGENT_MODEL_URLS.blue);
    if (!template) return; // not loaded (yet / failed): the map alone
    if (!this.figure) {
      this.kit = new BotKit();
      this.figure = new AgentModel(template, this.kit);
      this.figure.object.name = 'LobbyFigure';
      this.scene.add(this.figure.object);
    }
    const at = shot.figure.clone().setY(shot.position.y);
    const ground = map.collision.raycast(at, new THREE.Vector3(0, -1, 0), EYE + 4);
    const feet = at.clone().setY(ground === null ? shot.position.y - EYE : at.y - ground);
    const yaw = shot.figureYaw;
    this.figure.reset();
    this.figure.update(0, { feet, yaw, pitch: 0, velocity: new THREE.Vector3(), grounded: true, aiming: false, alive: true, deadTime: 0 });
    this.figure.object.visible = this.shown;
  }

  /** The figure appears once its file has loaded (it is preloaded with the bots' models). */
  figureReady(): void {
    if (this.figure || !this.map) return;
    this.setMap(this.map, this.def);
  }
}
