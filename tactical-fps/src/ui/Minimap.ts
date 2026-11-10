import { Cell, LAYOUT_CELL, type MinimapLayout } from '../world/MinimapLayout';
import './minimap.css';

// Tactical minimap (PC and phones): north up (screen up = world -Z), the
// player in the middle with an arrow for where it faces, the map's own
// layout (walls / buildings, low cover, open and indoor floor), bomb sites,
// teammates, and enemies only as the game lets the player know them (seen
// by the player right now, or for a moment where last seen: see
// Game.updateMinimap). The layout is drawn once per map into an image; a
// frame is one image copy and a few dots, a dozen or so times a second.

export const MINIMAP_ZOOMS = [24, 40, 70] as const;
const PX_PER_CELL = 3;
const COLORS: Record<number, string> = {
  [Cell.Floor]: 'rgba(196, 201, 206, 0.55)',
  [Cell.Indoor]: 'rgba(150, 158, 166, 0.6)',
  [Cell.Cover]: 'rgba(92, 98, 104, 0.85)',
  [Cell.Wall]: 'rgba(24, 27, 30, 0.95)',
};

export interface MinimapDot {
  x: number;
  z: number;
  /** 0..1 (an enemy fading out where it was last seen). */
  alpha: number;
}

export class Minimap {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private layer: HTMLCanvasElement | null = null;
  private layout: MinimapLayout | null = null;
  /** Half the width of the area shown (m). */
  half: number = MINIMAP_ZOOMS[1];
  private size = 0;
  private cx = 0;
  private cz = 0;
  private scale = 1;
  /** Drawn this frame (tests): enemy dots and ally dots. */
  readonly drawn = { enemies: 0, allies: 0 };

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'minimap';
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');
    this.canvas = document.createElement('canvas');
    this.root.appendChild(this.canvas);
    const zoom = document.createElement('span');
    zoom.className = 'minimap-zoom';
    this.root.appendChild(zoom);
    parent.appendChild(this.root);
    this.ctx = this.canvas.getContext('2d')!;
    this.showZoom();
  }

  /** A new map's layout (null: no map). */
  setLayout(l: MinimapLayout | null): void {
    this.layout = l;
    this.layer = null;
    if (!l) return;
    const c = document.createElement('canvas');
    c.width = l.nx * PX_PER_CELL;
    c.height = l.nz * PX_PER_CELL;
    const g = c.getContext('2d')!;
    for (const kind of [Cell.Floor, Cell.Indoor, Cell.Cover, Cell.Wall]) {
      g.fillStyle = COLORS[kind];
      for (let iz = 0; iz < l.nz; iz++)
        for (let ix = 0; ix < l.nx; ix++) if (l.cells[ix + iz * l.nx] === kind) g.fillRect(ix * PX_PER_CELL, iz * PX_PER_CELL, PX_PER_CELL, PX_PER_CELL);
    }
    this.layer = c;
  }

  setVisible(on: boolean): void {
    this.root.hidden = !on;
  }

  /** Next zoom level (closer, closer, then the wide view again). */
  cycleZoom(): void {
    const i = MINIMAP_ZOOMS.indexOf(this.half as (typeof MINIMAP_ZOOMS)[number]);
    this.half = MINIMAP_ZOOMS[(i + MINIMAP_ZOOMS.length - 1) % MINIMAP_ZOOMS.length];
    this.showZoom();
  }

  private showZoom(): void {
    this.root.querySelector('.minimap-zoom')!.textContent = `${this.half * 2} m`;
  }

  /** Canvas pixel of a world position in the last frame drawn (tests: the map and the world line up). */
  worldToMap(x: number, z: number): { x: number; y: number } {
    return { x: (x - this.cx) * this.scale + this.size / 2, y: (z - this.cz) * this.scale + this.size / 2 };
  }

  /** Draws one frame around the player at (x, z) facing `yaw`. Allocates nothing. */
  draw(x: number, z: number, yaw: number, allies: readonly MinimapDot[], allyCount: number, enemies: readonly MinimapDot[], enemyCount: number): void {
    const l = this.layout;
    if (!l || this.root.hidden) return;
    const css = this.root.clientWidth;
    const px = Math.max(1, Math.round(css * Math.min(2, window.devicePixelRatio || 1)));
    if (this.canvas.width !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
    const W = px;
    this.size = W;
    this.cx = x;
    this.cz = z;
    this.scale = W / (2 * this.half);
    const s = this.scale;
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, W);
    g.fillStyle = 'rgba(12, 14, 16, 0.55)';
    g.fillRect(0, 0, W, W);
    if (this.layer) {
      const cell = LAYOUT_CELL * s;
      g.imageSmoothingEnabled = false;
      g.drawImage(this.layer, (l.minX - x) * s + W / 2, (l.minZ - z) * s + W / 2, l.nx * cell, l.nz * cell);
    }
    // Bomb sites.
    g.lineWidth = Math.max(1, W / 120);
    g.font = `700 ${Math.round(W / 9)}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const site of l.sites) {
      const sx = (site.x - x) * s + W / 2;
      const sy = (site.z - z) * s + W / 2;
      g.strokeStyle = 'rgba(232, 160, 68, 0.9)';
      g.strokeRect(sx - site.hx * s, sy - site.hz * s, site.hx * 2 * s, site.hz * 2 * s);
      g.fillStyle = 'rgba(232, 160, 68, 0.95)';
      g.fillText(site.name, sx, sy);
    }
    const dot = (d: MinimapDot, color: string, r: number) => {
      const dx = (d.x - x) * s + W / 2;
      const dy = (d.z - z) * s + W / 2;
      if (dx < -r || dy < -r || dx > W + r || dy > W + r) return false;
      g.globalAlpha = d.alpha;
      g.fillStyle = color;
      g.beginPath();
      g.arc(dx, dy, r, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
      return true;
    };
    const r = Math.max(2, W / 40);
    let a = 0;
    for (let i = 0; i < allyCount; i++) if (dot(allies[i], 'rgba(106, 162, 255, 1)', r)) a++;
    let e = 0;
    for (let i = 0; i < enemyCount; i++) if (dot(enemies[i], 'rgba(255, 92, 80, 1)', r)) e++;
    this.drawn.allies = a;
    this.drawn.enemies = e;
    // The player: an arrow where it faces (forward = -sin yaw, -cos yaw in x / z).
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const L = W / 14;
    g.fillStyle = '#f2f2f0';
    g.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    g.lineWidth = Math.max(1, W / 160);
    g.beginPath();
    g.moveTo(W / 2 + fx * L, W / 2 + fz * L);
    g.lineTo(W / 2 - fx * L * 0.6 - fz * L * 0.6, W / 2 - fz * L * 0.6 + fx * L * 0.6);
    g.lineTo(W / 2 - fx * L * 0.25, W / 2 - fz * L * 0.25);
    g.lineTo(W / 2 - fx * L * 0.6 + fz * L * 0.6, W / 2 - fz * L * 0.6 - fx * L * 0.6);
    g.closePath();
    g.fill();
    g.stroke();
  }
}
