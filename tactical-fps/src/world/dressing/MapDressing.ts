import * as THREE from 'three';
import { PropKit, seeded, type MaterialSpec } from './PropKit';
import { INTERIOR_UV, shopInterior, signAtlas, SHOP_SIGNS, STENCILS, VERTICAL_SIGNS } from './SignAtlas';

// Map dressing: the detail the Blender maps don't have, built in code at load
// from the map's own layout (its node boxes), deterministic (seeded), so every
// client and every load gets exactly the same dressing. The map files are not
// touched. Everything goes through the normal map pipeline afterwards: merged
// per material, collision (solid layer), surface kinds (impacts, sounds),
// sky light, shadows, the bots' nav grid.
//
// Placement rules (tactics first):
//   - on walls: flush details, a few cm proud; anything at head height is thin
//   - on the ground: only against walls, never on spawns, bomb sites, ramps,
//     doors or within reach of existing cover; never narrowing a passage
//   - overhead (roofed passages, facades above 2.6 m): structure, lights, cable

export interface DressingResult {
  meshes: THREE.Mesh[];
  parts: number;
  /** Ground props that collide (racks, pallets, drums, poles…), for checks. */
  floorProps: THREE.Box3[];
}

type V3 = [number, number, number];

/** A box from the layout, by node name. */
interface Named {
  name: string;
  box: THREE.Box3;
}

/** Collects node boxes by name (world space) from the loaded GLB scene. */
function layout(scene: THREE.Object3D): Named[] {
  const out: Named[] = [];
  scene.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh || !o.name) return;
    out.push({ name: o.name, box: new THREE.Box3().setFromObject(o) });
  });
  return out;
}

/** A vertical wall face: where it is, which way it looks, how wide and tall. */
interface Face {
  axis: 'x' | 'z';
  /** Outward normal sign along `axis`. */
  dir: 1 | -1;
  /** Plane coordinate along `axis`. */
  plane: number;
  /** Extent along the face (the other horizontal axis). */
  from: number;
  to: number;
  base: number;
  top: number;
  kind: string;
  name: string;
}

function facesOf(n: Named, kind: string): Face[] {
  const b = n.box;
  const base = Math.max(b.min.y, 0);
  const f = (axis: 'x' | 'z', dir: 1 | -1): Face => ({
    axis,
    dir,
    plane: axis === 'x' ? (dir > 0 ? b.max.x : b.min.x) : dir > 0 ? b.max.z : b.min.z,
    from: axis === 'x' ? b.min.z : b.min.x,
    to: axis === 'x' ? b.max.z : b.max.x,
    base,
    top: b.max.y,
    kind,
    name: n.name,
  });
  return [f('x', 1), f('x', -1), f('z', 1), f('z', -1)];
}

/** World point on face `f`: `s` along it, `y` up, `out` metres in front of it. */
function onFace(f: Face, s: number, y: number, out: number): V3 {
  const p = f.plane + f.dir * out;
  return f.axis === 'x' ? [p, y, s] : [s, y, p];
}

/** Rotation (Y) that turns a part's local +Z to face out of `f`. */
function faceYaw(f: Face): number {
  if (f.axis === 'z') return f.dir > 0 ? 0 : Math.PI;
  return f.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
}

/** Size along / up / out of the face, turned into a box size in world axes. */
function faceSize(f: Face, along: number, up: number, out: number): V3 {
  return f.axis === 'x' ? [out, up, along] : [along, up, out];
}

const inXZ = (b: THREE.Box3, x: number, z: number, m = 0) => x >= b.min.x - m && x <= b.max.x + m && z >= b.min.z - m && z <= b.max.z + m;

/**
 * Builds the dressing for a map id (null: no dressing for that map). `lowDetail` (low graphics
 * quality) leaves out the visual-only layer (cables, awnings, painted lines, grates); everything that
 * collides is the same at every quality and on every client (multiplayer: one collision world).
 */
export function dressMap(mapId: string, scene: THREE.Object3D, lowDetail = false): DressingResult | null {
  scene.updateMatrixWorld(true);
  if (mapId === 'seoul') return dressSeoul(layout(scene), lowDetail);
  if (mapId === 'warehouse') return dressWarehouse(layout(scene), lowDetail);
  return null;
}

// ---------------------------------------------------------------- Seoul ----

const SEOUL_MATS: Record<string, MaterialSpec> = {
  DR_Shopfront_Glass: { color: 0x26323a, roughness: 0.08, metalness: 0.6 },
  // What a shop window shows: a lit interior (self-lit a little, as shops are in daylight).
  DR_Shopwindow_Lampglass: { color: 0xffffff, roughness: 0.25, emissive: 0xffffff, emissiveIntensity: 0.32 },
  DR_Window_Glass: { color: 0x3a4a56, roughness: 0.08, metalness: 0.6 },
  DR_Alu_Frame: { color: 0x8d9296, roughness: 0.45, metalness: 0.7 },
  DR_Frame_Dark: { color: 0x2c2f33, roughness: 0.5, metalness: 0.5 },
  DR_Concrete_Band: { color: 0xb9b4aa, roughness: 0.85 },
  DR_Stone_Pilaster: { color: 0xc8c0b0, roughness: 0.8 },
  DR_Sign_Atlas: { color: 0xffffff, roughness: 0.55 },
  DR_Sign_Back_Paint: { color: 0x3a3d40, roughness: 0.6 },
  DR_AC_Casing_Metal: { color: 0xdcdcd6, roughness: 0.6, metalness: 0.2 },
  DR_AC_Fan_Grate: { color: 0x2b2b2b, roughness: 0.6, metalness: 0.4 },
  DR_Downpipe_Pvc: { color: 0x8e8f8c, roughness: 0.55 },
  DR_Steel_Bracket: { color: 0x4a4c4e, roughness: 0.5, metalness: 0.7 },
  DR_Utility_Mast_Concrete: { color: 0xa8a49b, roughness: 0.85 },
  DR_Cable_Black: { color: 0x151515, roughness: 0.7 },
  DR_Transformer_Metal: { color: 0x6f7a73, roughness: 0.55, metalness: 0.3 },
  DR_Awning_Fabric_Paint: { color: 0x8a2f2a, roughness: 0.9, side: THREE.DoubleSide },
  DR_Awning_Stripe_Paint: { color: 0xe9e4d8, roughness: 0.9, side: THREE.DoubleSide },
  DR_Drain_Grate_Iron: { color: 0x2a2826, roughness: 0.7, metalness: 0.6 },
  DR_Manhole_Iron: { color: 0x34312d, roughness: 0.75, metalness: 0.5 },
  DR_Rooftop_Tank_Paint: { color: 0xc9c4b7, roughness: 0.7, metalness: 0.2 },
  DR_Roof_Vent_Steel: { color: 0x9a9c9e, roughness: 0.5, metalness: 0.7 },
  DR_Parapet_Coping: { color: 0x9c978d, roughness: 0.8 },
  DR_Traffic_Sign_Paint: { color: 0x1d5fa8, roughness: 0.5 },
  DR_Traffic_Sign_Pole_Steel: { color: 0x8a8d90, roughness: 0.45, metalness: 0.8 },
};

/** Play floors a facade can face (streets, plazas), by name. */
const SEOUL_STREET = /^Floor_(?!Cheonggye|Palace|Namsan)/;

function dressSeoul(nodes: Named[], low: boolean): DressingResult {
  const atlas = signAtlas();
  const mats = { ...SEOUL_MATS };
  if (atlas) mats.DR_Sign_Atlas = { ...mats.DR_Sign_Atlas, map: atlas.texture };
  const inside = shopInterior();
  if (inside) mats.DR_Shopwindow_Lampglass = { ...mats.DR_Shopwindow_Lampglass, map: inside, emissiveMap: inside };
  const kit = new PropKit(mats);
  const rand = seeded(0x5e01);
  const floors = nodes.filter((n) => SEOUL_STREET.test(n.name) && n.box.max.y > -0.5 && n.box.max.y < 0.5);
  const blocks = nodes.filter((n) => /^Block_(office|brick|glass|stone)/.test(n.name));
  const solids = nodes.filter((n) => /^(Block_|Cover_|Jamsil_|Gwanghwamun_Stone|Palace_Walls|Yeouido_Public)/.test(n.name));
  const keepOut = nodes.filter((n) => /^(Cover_|Zone_|BombSite_|ATK_Spawn|DEF_Spawn)/.test(n.name)).map((n) => n.box);
  const floorProps: THREE.Box3[] = [];

  /** Is there street right in front of face `f` at `s` (and nothing solid there)? */
  const streetAt = (f: Face, s: number, out = 1.2) => {
    const [x, , z] = onFace(f, s, 0, out);
    if (!floors.some((n) => inXZ(n.box, x, z))) return false;
    return !solids.some((n) => n.box.min.y < 2 && inXZ(n.box, x, z, -0.05));
  };

  let signIndex = 0;
  let vertIndex = 0;
  const poleLines: { f: Face; s: number }[][] = [];

  for (const b of blocks) {
    const kind = b.name.split('_')[1];
    // The map's own facade layer (windows, frames, mullions, pilasters, cornice, blank sign boards)
    // stays as designed: on those blocks only what it lacks is added.
    const ownFacade = nodes.some((n) => n.name === `Facade_${b.name}`);
    for (const f of facesOf(b, kind)) {
      const width = f.to - f.from;
      if (width < 3 || f.top - f.base < 6) continue;
      const bays = Math.max(1, Math.round(width / 3.4));
      const bay = width / bays;
      // Which bays look onto the street.
      const open = Array.from({ length: bays }, (_, i) => streetAt(f, f.from + bay * (i + 0.5)));
      if (!open.some(Boolean)) continue;
      const yaw = faceYaw(f);
      const storeys = Math.max(1, Math.floor((f.top - f.base - 4.2) / 3.5));

      // Floor bands and a coping on top (whole face: the building reads as floors, not a box).
      if (kind !== 'glass' && !ownFacade) {
        for (let k = 1; k <= storeys; k++) {
          const y = f.base + 4.2 + (k - 1) * 3.5 - 0.15;
          kit.box('DR_Concrete_Band', { at: onFace(f, (f.from + f.to) / 2, y, 0.05), size: faceSize(f, width, 0.22, 0.1) });
        }
        kit.box('DR_Parapet_Coping', { at: onFace(f, (f.from + f.to) / 2, f.top - 0.12, 0.06), size: faceSize(f, width + 0.12, 0.24, 0.12) });
      }

      for (let i = 0; i < bays; i++) {
        const s = f.from + bay * (i + 0.5);
        const street = open[i];
        // Ground floor: storefronts on streets (glass, aluminium frame, transom, fascia sign).
        if (street && kind !== 'glass' && kind !== 'stone') {
          const w = bay - 0.5;
          // The window: the room behind it (or plain dark glass without a DOM).
          if (inside) kit.plane('DR_Shopwindow_Lampglass', { at: onFace(f, s, f.base + 1.45, 0.03), size: [w, 2.7, 1], rot: [0, faceYaw(f), 0] }, 'solid', INTERIOR_UV[(signIndex + i) % 4]);
          else kit.box('DR_Shopfront_Glass', { at: onFace(f, s, f.base + 1.45, 0.02), size: faceSize(f, w, 2.7, 0.04) });
          kit.box('DR_Alu_Frame', { at: onFace(f, s, f.base + 2.86, 0.05), size: faceSize(f, w + 0.12, 0.12, 0.1) });
          kit.box('DR_Alu_Frame', { at: onFace(f, s, f.base + 0.06, 0.05), size: faceSize(f, w + 0.12, 0.12, 0.1) });
          for (const e of [-1, 1]) kit.box('DR_Alu_Frame', { at: onFace(f, s + (e * (w + 0.06)) / 2, f.base + 1.45, 0.05), size: faceSize(f, 0.1, 2.9, 0.1) });
          // A door in every other storefront: a centre mullion and a push bar.
          if (i % 2 === 0) {
            kit.box('DR_Alu_Frame', { at: onFace(f, s, f.base + 1.4, 0.05), size: faceSize(f, 0.08, 2.7, 0.08) });
            kit.box('DR_Steel_Bracket', { at: onFace(f, s - 0.25, f.base + 1.05, 0.07), size: faceSize(f, 0.03, 0.6, 0.04) });
          }
          // Fascia sign board above (a real shop name from the atlas).
          const uv = atlas?.shop[signIndex++ % SHOP_SIGNS.length];
          kit.box('DR_Sign_Back_Paint', { at: onFace(f, s, f.base + 3.45, 0.07), size: faceSize(f, w + 0.1, 0.9, 0.12) });
          if (uv) kit.plane('DR_Sign_Atlas', { at: onFace(f, s, f.base + 3.45, 0.135), size: [w - 0.1, 0.78, 1], rot: [0, yaw, 0] }, 'solid', uv);
          // Some shops roll out an awning (fabric: visual only).
          if (rand() < 0.35) {
            const d = 0.85;
            const [ax, ay, az] = onFace(f, s, f.base + 2.95 - 0.18, d / 2);
            kit.box(rand() < 0.5 ? 'DR_Awning_Fabric_Paint' : 'DR_Awning_Stripe_Paint', { at: [ax, ay, az], size: [w, 0.04, d], rot: [0.35, yaw, 0] }, 'detail');
          }
        }
        // Upper floors.
        for (let k = 0; k < storeys; k++) {
          const y0 = f.base + 4.2 + k * 3.5;
          if (kind === 'glass') continue;
          // Outdoor AC units hung on the wall between floors (brackets to the wall).
          if (street && rand() < 0.3 && kind !== 'stone') {
            const ay = y0 + 0.3;
            const ax = s + (rand() - 0.5) * 0.6 + bay * 0.3;
            kit.box('DR_AC_Casing_Metal', { at: onFace(f, ax, ay, 0.22), size: faceSize(f, 0.82, 0.58, 0.3) });
            kit.box('DR_AC_Fan_Grate', { at: onFace(f, ax + 0.12, ay, 0.375), size: faceSize(f, 0.42, 0.42, 0.02) });
            kit.box('DR_Steel_Bracket', { at: onFace(f, ax, ay - 0.33, 0.2), size: faceSize(f, 0.8, 0.04, 0.4) });
          }
          if (ownFacade) continue;
          if (kind === 'stone') {
            // Government stone: deep pilasters between tall windows.
            kit.box('DR_Window_Glass', { at: onFace(f, s, y0 + 1.5, 0.02), size: faceSize(f, bay * 0.55, 2.3, 0.04) });
            continue;
          }
          const ww = Math.min(bay * 0.62, 2.0);
          const wy = y0 + 1.55;
          kit.box('DR_Window_Glass', { at: onFace(f, s, wy, 0.02), size: faceSize(f, ww, 1.6, 0.04) });
          const fr = kind === 'brick' ? 'DR_Frame_Dark' : 'DR_Alu_Frame';
          kit.box(fr, { at: onFace(f, s, wy + 0.83, 0.04), size: faceSize(f, ww + 0.12, 0.07, 0.08) });
          kit.box(fr, { at: onFace(f, s, wy - 0.83, 0.04), size: faceSize(f, ww + 0.12, 0.07, 0.08) });
          for (const e of [-1, 1]) kit.box(fr, { at: onFace(f, s + (e * (ww + 0.06)) / 2, wy, 0.04), size: faceSize(f, 0.07, 1.7, 0.08) });
          kit.box(fr, { at: onFace(f, s, wy, 0.04), size: faceSize(f, 0.05, 1.6, 0.06) });
          kit.box('DR_Concrete_Band', { at: onFace(f, s, wy - 0.92, 0.07), size: faceSize(f, ww + 0.25, 0.08, 0.14) });
        }
      }

      if (kind === 'glass' && !ownFacade) {
        // Curtain wall: mullions every 1.5 m and a transom each floor.
        const n = Math.max(1, Math.round(width / 1.5));
        for (let i = 0; i <= n; i++) {
          const s = f.from + (width * i) / n;
          kit.box('DR_Frame_Dark', { at: onFace(f, s, (f.base + f.top) / 2, 0.05), size: faceSize(f, 0.09, f.top - f.base, 0.12) });
        }
        for (let y = f.base + 3.6; y < f.top - 0.5; y += 3.6) kit.box('DR_Frame_Dark', { at: onFace(f, (f.from + f.to) / 2, y, 0.05), size: faceSize(f, width, 0.14, 0.12) });
        // Lobby entrance canopy-line at street level.
        kit.box('DR_Alu_Frame', { at: onFace(f, (f.from + f.to) / 2, f.base + 3.3, 0.08), size: faceSize(f, width, 0.25, 0.16) });
      }
      if (kind === 'stone' && !ownFacade) {
        for (let i = 0; i <= bays; i++) {
          const s = f.from + bay * i;
          kit.box('DR_Stone_Pilaster', { at: onFace(f, s, (f.base + f.top) / 2, 0.15), size: faceSize(f, 0.55, f.top - f.base, 0.3) });
        }
        kit.box('DR_Stone_Pilaster', { at: onFace(f, (f.from + f.to) / 2, f.top - 0.4, 0.25), size: faceSize(f, width + 0.6, 0.6, 0.5) });
      }

      // A rain pipe down one corner, vertical signs on the upper floors of shop buildings.
      if (kind === 'office' || kind === 'brick') {
        const cs = f.dir > 0 ? f.to - 0.25 : f.from + 0.25;
        kit.cylinder('DR_Downpipe_Pvc', { at: onFace(f, cs, (f.base + f.top) / 2, 0.12), size: [0.11, f.top - f.base, 0.11] }, 6);
        if (open[0] || open[bays - 1]) {
          const vs = open[0] ? f.from + 0.9 : f.to - 0.9;
          const uv = atlas?.vertical[vertIndex++ % VERTICAL_SIGNS.length];
          const h = Math.min(4.6, f.top - f.base - 5.2);
          if (uv && h > 2) {
            const y = f.base + 4.4 + h / 2;
            kit.box('DR_Sign_Back_Paint', { at: onFace(f, vs, y, 0.1), size: faceSize(f, 0.9, h + 0.1, 0.16) });
            kit.plane('DR_Sign_Atlas', { at: onFace(f, vs, y, 0.185), size: [0.8, h, 1], rot: [0, yaw, 0] }, 'solid', uv);
          }
        }
        // Utility poles in front of street faces (collected; placed once per line below).
        const line: { f: Face; s: number }[] = [];
        for (let s = f.from + 2; s < f.to - 1.5; s += 13) if (streetAt(f, s, 1.2) && streetAt(f, s, 0.6)) line.push({ f, s });
        if (line.length) poleLines.push(line);
      }

      // Rooftop: plant on top (out of reach, seen from the street and from the towers).
      if (kind !== 'glass' && width > 6) {
        const [rx, ry, rz] = onFace(f, f.from + width * (0.3 + rand() * 0.4), f.top, -2.2);
        kit.box('DR_AC_Casing_Metal', { at: [rx, ry + 0.55, rz], size: [1.4, 1.1, 1.0], rot: [0, yaw, 0] });
        kit.box('DR_AC_Fan_Grate', { at: [rx, ry + 1.11, rz], size: [0.9, 0.02, 0.7], rot: [0, yaw, 0] });
        if (rand() < 0.5) {
          const [tx, , tz] = onFace(f, f.from + width * 0.2, f.top, -3.5);
          kit.cylinder('DR_Rooftop_Tank_Paint', { at: [tx, f.top + 0.95, tz], size: [1.6, 1.9, 1.6] }, 10);
        } else {
          const [tx, , tz] = onFace(f, f.from + width * 0.75, f.top, -1.6);
          kit.box('DR_Roof_Vent_Steel', { at: [tx, f.top + 0.45, tz], size: [0.7, 0.9, 0.7] });
        }
      }
    }
  }

  // Utility poles with cables (the overhead tangle of a Seoul back street), 0.75 m off the facade.
  for (const line of poleLines) {
    const tops: THREE.Vector3[] = [];
    for (const { f, s } of line) {
      const [x, , z] = onFace(f, s, 0, 0.75);
      const box = new THREE.Box3(new THREE.Vector3(x - 0.2, 0, z - 0.2), new THREE.Vector3(x + 0.2, 10, z + 0.2));
      if (keepOut.some((k) => k.intersectsBox(box.clone().expandByScalar(0.8)))) continue;
      kit.cylinder('DR_Utility_Mast_Concrete', { at: [x, 4.75, z], size: [0.34, 9.5, 0.34] }, 10);
      floorProps.push(box);
      const yaw = faceYaw(f) + Math.PI / 2;
      kit.box('DR_Steel_Bracket', { at: [x, 8.6, z], size: [1.6, 0.1, 0.1], rot: [0, yaw, 0] });
      if (rand() < 0.4) kit.cylinder('DR_Transformer_Metal', { at: [x, 7.3, z], size: [0.55, 1.0, 0.55] }, 10);
      // Some poles carry a road sign (a blue plate on a bracket, facing the street).
      if (rand() < 0.35) {
        const [px, , pz] = onFace(f, s, 0, 0.98);
        kit.box('DR_Traffic_Sign_Pole_Steel', { at: [(x + px) / 2, 2.75, (z + pz) / 2], size: faceSize(f, 0.05, 0.05, 0.3) });
        kit.box('DR_Traffic_Sign_Paint', { at: [px, 2.75, pz], size: faceSize(f, 0.6, 0.6, 0.03) });
      }
      tops.push(new THREE.Vector3(x, 8.6, z));
    }
    for (let i = 1; i < tops.length; i++) for (const dy of [0, -0.35, 0.25]) sagging(kit, tops[i - 1].clone().setY(tops[i - 1].y + dy), tops[i].clone().setY(tops[i].y + dy), 0.45);
  }

  // Street: drain grates along the kerbs of roads and manholes in the lanes (flat, visual).
  {
    for (const n of floors.filter((f) => /Street|Road|Avenue/.test(f.name))) {
      const b = n.box;
      const alongX = b.max.x - b.min.x > b.max.z - b.min.z;
      const len = alongX ? b.max.x - b.min.x : b.max.z - b.min.z;
      for (let t = 4; t < len - 2; t += 9) {
        for (const edge of [0, 1]) {
          const x = alongX ? b.min.x + t : edge ? b.max.x - 0.45 : b.min.x + 0.45;
          const z = alongX ? (edge ? b.max.z - 0.45 : b.min.z + 0.45) : b.min.z + t;
          if (keepOut.some((k) => inXZ(k, x, z, 0.6))) continue;
          kit.box('DR_Drain_Grate_Iron', { at: [x, b.max.y + 0.01, z], size: alongX ? [0.9, 0.02, 0.45] : [0.45, 0.02, 0.9] }, 'detail');
        }
        if (t % 27 === 13) {
          const x = alongX ? b.min.x + t + 2 : (b.min.x + b.max.x) / 2 + 1.2;
          const z = alongX ? (b.min.z + b.max.z) / 2 - 1.2 : b.min.z + t + 2;
          if (!keepOut.some((k) => inXZ(k, x, z, 0.8))) kit.cylinder('DR_Manhole_Iron', { at: [x, b.max.y + 0.01, z], size: [0.7, 0.02, 0.7] }, 16, 'detail');
        }
      }
    }
  }

  return { meshes: kit.build(low), parts: kit.parts, floorProps };
}

/** A cable hanging between two points (a few straight pieces along a sag). */
function sagging(kit: PropKit, a: THREE.Vector3, b: THREE.Vector3, sag: number): void {
  const n = 6;
  let prev = a.clone();
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const p = a.clone().lerp(b, t);
    p.y -= sag * 4 * t * (1 - t);
    kit.tube('DR_Cable_Black', prev, p, 0.012, 'detail', 4);
    prev = p;
  }
}

// ------------------------------------------------------------ Warehouse ----

const YARD_MATS: Record<string, MaterialSpec> = {
  DR_Portal_Column_Metal: { color: 0x4f5a62, roughness: 0.55, metalness: 0.5 },
  DR_Portal_Girt_Metal: { color: 0x5b636a, roughness: 0.55, metalness: 0.5 },
  DR_Galvanized_Steel: { color: 0xa3a7a9, roughness: 0.42, metalness: 0.85 },
  DR_Pipe_Red_Metal: { color: 0x8c2a22, roughness: 0.5, metalness: 0.5 },
  DR_Pipe_Steel_Grey: { color: 0x7d8286, roughness: 0.45, metalness: 0.7 },
  DR_Wire_Tray_Steel: { color: 0x8b8f92, roughness: 0.5, metalness: 0.75 },
  DR_Cable_Black: { color: 0x141414, roughness: 0.7 },
  DR_Lamp_Housing_Metal: { color: 0x3b3f42, roughness: 0.5, metalness: 0.5 },
  DR_Lamp_Glass_Warm: { color: 0xfff1d0, roughness: 0.3 },
  DR_Rack_Upright_Metal: { color: 0x2f5ea0, roughness: 0.5, metalness: 0.4 },
  DR_Rack_Beam_Orange_Metal: { color: 0xd8641e, roughness: 0.5, metalness: 0.4 },
  DR_Pallet_Wood: { color: 0x9a7a52, roughness: 0.85 },
  DR_Carton_Cardboard: { color: 0xb08d5f, roughness: 0.9 },
  DR_Wrap_Plastic: { color: 0xcfd3d4, roughness: 0.35 },
  DR_Drum_Blue_Metal: { color: 0x234f8a, roughness: 0.5, metalness: 0.5 },
  DR_Drum_Grey_Metal: { color: 0x6c7276, roughness: 0.5, metalness: 0.6 },
  DR_Floor_Line_Paint_Yellow: { color: 0xd8b02a, roughness: 0.6 },
  DR_Hatch_Paint_Yellow: { color: 0xd8b02a, roughness: 0.6 },
  DR_Kick_Plate_Paint_Yellow: { color: 0xd1a826, roughness: 0.6, metalness: 0.2 },
  DR_Sign_Atlas: { color: 0xffffff, roughness: 0.55 },
  DR_Cart_Green_Metal: { color: 0x2b6a3e, roughness: 0.5, metalness: 0.5 },
  DR_Cart_Tire_Rubber: { color: 0x1a1a1a, roughness: 0.85 },
  DR_Vent_Louver_Steel: { color: 0x8a8e90, roughness: 0.5, metalness: 0.7 },
  DR_Conduit_Steel: { color: 0x9da1a3, roughness: 0.45, metalness: 0.8 },
};

function dressWarehouse(nodes: Named[], low: boolean): DressingResult {
  const atlas = signAtlas();
  const mats = { ...YARD_MATS };
  if (atlas) mats.DR_Sign_Atlas = { ...mats.DR_Sign_Atlas, map: atlas.texture };
  const kit = new PropKit(mats);
  const rand = seeded(0xa11ce);
  const floors = nodes.filter((n) => /^Floor_/.test(n.name) && n.box.max.y > -0.3 && n.box.max.y < 0.3);
  const walls = nodes.filter((n) => /^Wall_(Block|Perimeter)_/.test(n.name));
  const solids = nodes.filter((n) => /^(Wall_|Cover_|Prop_|Elev_|Platform_|Ramp_|Bldg_FireEscape|Bldg_B_LoadingDock)/.test(n.name));
  // Ground props never here: spawns, sites, cover and its surroundings, ramps / docks, doors.
  const keepOut = nodes
    .filter((n) => /^(Cover_|Prop_|Elev_|Platform_|Ramp_|Zone_|ATK_Spawn|DEF_Spawn|Wall_(A|B)_Door|Wall_DEF_Entrance|Wall_Lintel|Bldg_.*Door|Deco_Manholes|Bldg_FireEscape)/.test(n.name))
    .map((n) => n.box.clone().expandByScalar(n.name.startsWith('Cover_') ? 2.2 : 1.2));
  const floorProps: THREE.Box3[] = [];

  /** The floor in front of face `f` at `s` (`out` m from it), if any and if nothing solid stands there. */
  const yardAt = (f: Face, s: number, out: number) => {
    const [x, , z] = onFace(f, s, 0, out);
    const fl = floors.find((n) => inXZ(n.box, x, z));
    if (!fl) return null;
    if (solids.some((n) => n.box.min.y < 1.6 && n.box.max.y > 0.1 && inXZ(n.box, x, z, 0.05))) return null;
    return fl;
  };
  /** Width of open floor in front of `f` at `s` (how far until a wall / solid), up to 12 m. */
  const clearance = (f: Face, s: number) => {
    let d = 0.4;
    while (d < 12 && yardAt(f, s, d)) d += 0.4;
    return d;
  };
  const free = (box: THREE.Box3) => !keepOut.some((k) => k.intersectsBox(box));

  let stencilIndex = 0;
  for (const w of walls) {
    const perimeter = w.name.startsWith('Wall_Perimeter');
    for (const f of facesOf(w, perimeter ? 'perimeter' : 'block')) {
      const width = f.to - f.from;
      if (width < 2.5) continue;
      const along: number[] = [];
      for (let s = f.from + 0.5; s <= f.to - 0.5; s += 0.5) if (yardAt(f, s, 0.6)) along.push(s);
      if (along.length < 4) continue;
      const yaw = faceYaw(f);
      const top = Math.min(f.top, perimeter ? 5 : f.top);
      const runs = contiguous(along, 0.5);

      for (const [s0, s1] of runs) {
        const len = s1 - s0;
        if (len < 1.5) continue;
        const mid = (s0 + s1) / 2;
        // Steel portal frame: slim columns every 4 m (only where the floor in front is wide: never
        // narrowing an alley), a girt at 2.45 m and under the eaves.
        const cols = Math.max(1, Math.round(len / 4));
        for (let i = 0; i <= cols; i++) {
          const s = s0 + (len * i) / cols;
          if (clearance(f, Math.min(Math.max(s, s0 + 0.3), s1 - 0.3)) < 4.5) continue;
          kit.box('DR_Portal_Column_Metal', { at: onFace(f, s, top / 2, 0.05), size: faceSize(f, 0.2, top, 0.1) });
          kit.box('DR_Portal_Column_Metal', { at: onFace(f, s, top / 2, 0.105), size: faceSize(f, 0.26, top, 0.02) });
        }
        kit.box('DR_Portal_Girt_Metal', { at: onFace(f, mid, 2.45, 0.06), size: faceSize(f, len, 0.12, 0.12) });
        kit.box('DR_Portal_Girt_Metal', { at: onFace(f, mid, top - 0.25, 0.08), size: faceSize(f, len, 0.3, 0.16) });
        // Yellow kick plate along the base (forklift scuffs), visual.
        kit.box('DR_Kick_Plate_Paint_Yellow', { at: onFace(f, mid, 0.15, 0.012), size: faceSize(f, len, 0.3, 0.02) }, 'detail');
        // Pedestrian line painted on the floor 0.9 m off the wall.
        const [lx, , lz] = onFace(f, mid, 0, 0.9);
        kit.box('DR_Floor_Line_Paint_Yellow', { at: [lx, 0.008, lz], size: f.axis === 'x' ? [0.1, 0.012, len] : [len, 0.012, 0.1] }, 'detail');
        // Conduit and a pipe run under the eaves, with brackets.
        {
          const a = new THREE.Vector3(...onFace(f, s0, top - 0.7, 0.22));
          const b = new THREE.Vector3(...onFace(f, s1, top - 0.7, 0.22));
          kit.tube(perimeter ? 'DR_Pipe_Steel_Grey' : 'DR_Pipe_Red_Metal', a, b, 0.07, 'solid', 8);
          kit.tube('DR_Conduit_Steel', a.clone().setY(top - 1.0), b.clone().setY(top - 1.0), 0.025, 'detail', 5);
          for (let s = s0 + 1; s < s1; s += 2.5) kit.box('DR_Galvanized_Steel', { at: onFace(f, s, top - 0.82, 0.12), size: faceSize(f, 0.05, 0.4, 0.24) });
        }
        // Industrial wall lamps every 8 m above the girt.
        for (let s = s0 + 2; s < s1 - 1; s += 8) {
          kit.box('DR_Lamp_Housing_Metal', { at: onFace(f, s, 3.4, 0.2), size: faceSize(f, 0.5, 0.18, 0.4) });
          kit.box('DR_Lamp_Glass_Warm', { at: onFace(f, s, 3.29, 0.22), size: faceSize(f, 0.42, 0.04, 0.32) });
          kit.box('DR_Lamp_Housing_Metal', { at: onFace(f, s, 3.55, 0.08), size: faceSize(f, 0.08, 0.3, 0.16) });
        }
        // Wall stencils (zone names / numbers) on long runs, plates at 2 m.
        if (atlas && len > 5) {
          const uv = atlas.stencil[stencilIndex++ % STENCILS.length];
          kit.box('DR_Kick_Plate_Paint_Yellow', { at: onFace(f, s0 + 1.8, 1.95, 0.02), size: faceSize(f, 1.7, 0.42, 0.03) });
          kit.plane('DR_Sign_Atlas', { at: onFace(f, s0 + 1.8, 1.95, 0.037), size: [1.6, 0.36, 1], rot: [0, yaw, 0] }, 'solid', uv);
        }
        // Louvred vents on the building blocks.
        if (!perimeter && len > 6) {
          kit.box('DR_Vent_Louver_Steel', { at: onFace(f, s1 - 1.5, Math.min(top - 1.4, 4.2), 0.05), size: faceSize(f, 1.0, 0.8, 0.1) });
          for (let k = 0; k < 4; k++) kit.box('DR_Lamp_Housing_Metal', { at: onFace(f, s1 - 1.5, Math.min(top - 1.4, 4.2) - 0.3 + k * 0.2, 0.11), size: faceSize(f, 0.95, 0.03, 0.03) });
        }

        // Ground props against the wall where the floor in front is wide (never narrowing a passage).
        let s = s0 + 1.2;
        while (s < s1 - 1.2) {
          const room = clearance(f, s);
          const pick = rand();
          if (room >= 6.5 && perimeter && pick < 0.45 && s + 2.8 < s1) {
            // Pallet rack bay: 2.7 m long, 1.0 m deep, 2.6 m tall, two beam levels with loads.
            const box = rackBox(f, s + 1.35);
            if (free(box) && clearance(f, s + 2.6) >= 6.5) {
              palletRack(kit, f, s + 1.35, rand);
              floorProps.push(box);
              // Leave a clear 1.3 m+ gap to whatever comes next (no slot to get wedged in).
              s += 4.7;
              continue;
            }
          } else if (room >= 6.5 && pick < 0.7) {
            const [x, , z] = onFace(f, s, 0, 0.6);
            const box = new THREE.Box3(new THREE.Vector3(x - 0.65, 0, z - 0.65), new THREE.Vector3(x + 0.65, 1.2, z + 0.65));
            if (free(box)) {
              if (pick < 0.58) palletStack(kit, x, z, faceYaw(f), rand);
              else drums(kit, x, z, rand);
              floorProps.push(box);
              s += 2.4;
              continue;
            }
          } else if (room >= 6.5 && pick < 0.76) {
            const [x, , z] = onFace(f, s, 0, 0.55);
            const box = new THREE.Box3(new THREE.Vector3(x - 0.7, 0, z - 0.7), new THREE.Vector3(x + 0.7, 1.1, z + 0.7));
            if (free(box)) {
              palletJack(kit, x, z, faceYaw(f) + Math.PI / 2);
              floorProps.push(box);
              s += 2.4;
              continue;
            }
          }
          s += 1.6;
        }
      }
    }
  }

  // Roofed passages: steel joists under the slab, a cable tray, pipes and hanging lamps.
  for (const roof of nodes.filter((n) => /^Wall_Roof_/.test(n.name))) {
    const b = roof.box;
    const alongX = b.max.x - b.min.x > b.max.z - b.min.z;
    const y = b.min.y;
    const len = alongX ? b.max.x - b.min.x : b.max.z - b.min.z;
    const span = alongX ? b.max.z - b.min.z : b.max.x - b.min.x;
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    for (let t = 0.4; t <= len - 0.4; t += 1.2) {
      const x = alongX ? b.min.x + t : cx;
      const z = alongX ? cz : b.min.z + t;
      kit.box('DR_Portal_Girt_Metal', { at: [x, y - 0.11, z], size: alongX ? [0.1, 0.22, span] : [span, 0.22, 0.1] });
    }
    for (const off of [-0.3, 0.3]) {
      const a = new THREE.Vector3(alongX ? b.min.x : cx + off * span, y - 0.3, alongX ? cz + off * span : b.min.z);
      const e = new THREE.Vector3(alongX ? b.max.x : cx + off * span, y - 0.3, alongX ? cz + off * span : b.max.z);
      if (off < 0) kit.box('DR_Wire_Tray_Steel', { at: a.clone().lerp(e, 0.5).toArray() as V3, size: alongX ? [len, 0.08, 0.35] : [0.35, 0.08, len] });
      else kit.tube('DR_Pipe_Red_Metal', a, e, 0.06, 'solid', 8);
    }
    for (let t = len / 4; t < len; t += len / 2) {
      const x = alongX ? b.min.x + t : cx;
      const z = alongX ? cz : b.min.z + t;
      kit.tube('DR_Cable_Black', new THREE.Vector3(x, y - 0.22, z), new THREE.Vector3(x, y - 0.55, z), 0.01, 'detail', 4);
      kit.cylinder('DR_Lamp_Housing_Metal', { at: [x, y - 0.62, z], size: [0.45, 0.16, 0.45] }, 12);
      kit.cylinder('DR_Lamp_Glass_Warm', { at: [x, y - 0.71, z], size: [0.36, 0.03, 0.36] }, 12, 'detail');
    }
  }

  // Loading area at the B dock: hatched no-parking box in front of it.
  for (const dock of nodes.filter((n) => n.name === 'Elev_B_LoadingDock' || n.name === 'Platform_B_Raised')) {
    const b = dock.box;
    const z0 = b.max.z + 0.4;
    for (let x = b.min.x + 0.5; x < b.max.x - 0.5; x += 0.9) {
      kit.box('DR_Hatch_Paint_Yellow', { at: [x, 0.009, z0 + 1.2], size: [0.12, 0.012, 2.6], rot: [0, 0.6, 0] }, 'detail');
    }
    kit.box('DR_Floor_Line_Paint_Yellow', { at: [(b.min.x + b.max.x) / 2, 0.009, z0], size: [b.max.x - b.min.x, 0.012, 0.12] }, 'detail');
    kit.box('DR_Floor_Line_Paint_Yellow', { at: [(b.min.x + b.max.x) / 2, 0.009, z0 + 2.6], size: [b.max.x - b.min.x, 0.012, 0.12] }, 'detail');
    break;
  }

  return { meshes: kit.build(low), parts: kit.parts, floorProps };
}

/** Runs of consecutive samples (spacing `step`) as [start, end]. */
function contiguous(xs: number[], step: number): [number, number][] {
  const out: [number, number][] = [];
  let a = xs[0];
  let p = xs[0];
  for (let i = 1; i <= xs.length; i++) {
    if (i === xs.length || xs[i] - p > step * 1.5) {
      out.push([a - step / 2, p + step / 2]);
      if (i < xs.length) a = xs[i];
    }
    if (i < xs.length) p = xs[i];
  }
  return out;
}

function rackBox(f: Face, s: number): THREE.Box3 {
  const a = onFace(f, s - 1.35, 0, 0.05);
  const b = onFace(f, s + 1.35, 2.6, 1.1);
  return new THREE.Box3(new THREE.Vector3(Math.min(a[0], b[0]), 0, Math.min(a[2], b[2])), new THREE.Vector3(Math.max(a[0], b[0]), 2.6, Math.max(a[2], b[2])));
}

/** One bay of selective pallet racking against wall `f`, centred at `s`. */
function palletRack(kit: PropKit, f: Face, s: number, rand: () => number): void {
  const yaw = faceYaw(f);
  for (const e of [-1.32, 1.32]) {
    for (const d of [0.12, 1.02]) kit.box('DR_Rack_Upright_Metal', { at: onFace(f, s + e, 1.3, d), size: faceSize(f, 0.08, 2.6, 0.08) });
    // Cross bracing of the frame.
    kit.beam('DR_Rack_Upright_Metal', new THREE.Vector3(...onFace(f, s + e, 0.3, 0.14)), new THREE.Vector3(...onFace(f, s + e, 1.3, 1.0)), 0.03, 0.03);
    kit.beam('DR_Rack_Upright_Metal', new THREE.Vector3(...onFace(f, s + e, 1.3, 0.14)), new THREE.Vector3(...onFace(f, s + e, 2.3, 1.0)), 0.03, 0.03);
  }
  for (const y of [1.25, 2.45]) {
    for (const d of [0.12, 1.02]) kit.box('DR_Rack_Beam_Orange_Metal', { at: onFace(f, s, y, d), size: faceSize(f, 2.64, 0.11, 0.05) });
  }
  // Loads: on the floor and on both levels (pallet + cartons or a wrapped load).
  for (const [y, i] of [[0, 0], [1.31, 1], [2.51, 2]] as const) {
    for (const e of [-0.66, 0.66]) {
      if (i > 0 && rand() < 0.25) continue;
      const [x, , z] = onFace(f, s + e, 0, 0.58);
      pallet(kit, x, y, z, yaw);
      const h = 0.5 + rand() * (i === 2 ? 0.0 : 0.45);
      kit.box(rand() < 0.5 ? 'DR_Carton_Cardboard' : 'DR_Wrap_Plastic', { at: [x, y + 0.15 + h / 2, z], size: [1.05, h, 0.8], rot: [0, yaw, 0] });
    }
  }
}

/** A Euro pallet (1.2 x 0.8 m, 0.144 m tall) at floor height `y`. */
function pallet(kit: PropKit, x: number, y: number, z: number, yaw: number): void {
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const local = (lx: number, lz: number): V3 => [x + lx * c + lz * sn, 0, z - lx * sn + lz * c];
  for (const lz of [-0.33, 0, 0.33]) {
    const [px, , pz] = local(0, lz);
    kit.box('DR_Pallet_Wood', { at: [px, y + 0.05, pz], size: [1.2, 0.1, 0.1], rot: [0, yaw, 0] });
  }
  for (let i = 0; i < 5; i++) {
    const [px, , pz] = local(-0.5 + i * 0.25, 0);
    kit.box('DR_Pallet_Wood', { at: [px, y + 0.122, pz], size: [0.14, 0.022, 0.8], rot: [0, yaw, 0] });
  }
}

function palletStack(kit: PropKit, x: number, z: number, yaw: number, rand: () => number): void {
  const n = 3 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) pallet(kit, x + (rand() - 0.5) * 0.06, i * 0.144, z + (rand() - 0.5) * 0.06, yaw + (rand() - 0.5) * 0.08);
}

/** Two to four empty 200 l drums (0.58 m across, 0.88 m tall). */
function drums(kit: PropKit, x: number, z: number, rand: () => number): void {
  const spots: [number, number][] = [[-0.32, -0.32], [0.32, -0.3], [-0.3, 0.32], [0.33, 0.33]];
  const n = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    const [dx, dz] = spots[i];
    const mat = rand() < 0.6 ? 'DR_Drum_Blue_Metal' : 'DR_Drum_Grey_Metal';
    kit.cylinder(mat, { at: [x + dx, 0.44, z + dz], size: [0.58, 0.88, 0.58] }, 14);
    for (const y of [0.3, 0.6]) kit.cylinder('DR_Drum_Grey_Metal', { at: [x + dx, y, z + dz], size: [0.6, 0.03, 0.6] }, 14, 'detail');
  }
}

/** A hand pallet truck: forks, the pump body and the handle. */
function palletJack(kit: PropKit, x: number, z: number, yaw: number): void {
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const at = (lx: number, y: number, lz: number): V3 => [x + lx * c + lz * sn, y, z - lx * sn + lz * c];
  for (const lz of [-0.2, 0.2]) kit.box('DR_Cart_Green_Metal', { at: at(0.1, 0.06, lz), size: [1.15, 0.08, 0.16], rot: [0, yaw, 0] });
  kit.box('DR_Cart_Green_Metal', { at: at(-0.55, 0.3, 0), size: [0.25, 0.45, 0.55], rot: [0, yaw, 0] });
  kit.beam('DR_Cart_Green_Metal', new THREE.Vector3(...at(-0.6, 0.45, 0)), new THREE.Vector3(...at(-0.95, 1.15, 0)), 0.04, 0.04);
  kit.box('DR_Cart_Green_Metal', { at: at(-0.95, 1.15, 0), size: [0.05, 0.05, 0.4], rot: [0, yaw, 0] });
  for (const lz of [-0.2, 0.2]) kit.cylinder('DR_Cart_Tire_Rubber', { at: at(0.6, 0.04, lz), size: [0.08, 0.1, 0.08], rot: [Math.PI / 2, yaw, 0] }, 8);
}
