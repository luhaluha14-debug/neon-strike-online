// Rigs the one-piece weapon GLBs (PIS-01, SG-01, SMG-01) for first-person
// animation: the Blender "Separate > By loose parts" + "Set origin" + export
// step, as a script (no Blender needed, same result every run).
//
//   node tools/rig-weapons.mjs                writes public/weapons/<id>_rig.glb
//   node tools/rig-weapons.mjs --out <dir>    writes them to <dir> instead (tests: the same bytes)
//
// Phase 24 weapons (AR-02, SMG-02, DMR-01, PIS-02, LMG-01) come from Blender
// with every part already its own node, so they need no splitting. Two of them
// lack a piece the first-person animation shows (AUGMENTS below): the P220's
// magazine body inside the grip (only its base plate is modelled) and the
// M249's belt from the pouch to the feed tray. Those files are copied node for
// node and buffer for buffer, and only the new nodes are appended.
//
// The source files (public/weapons/<id>.glb) are read, never changed. Each
// model was built in Blender from separate pieces joined into one mesh, so
// every piece is still a loose part of the vertex data. The moving pieces are
// picked by material and bounds (with the exact count asserted, so a changed
// source fails loudly instead of rigging the wrong piece), moved into child
// nodes named for the game (Slide, Trigger, Magazine, Pump, PumpBolt,
// ChargingHandle, Shell) with their own origin, and the rest stays in the
// root node, which keeps the source's name and transform. Vertices, normals
// and materials are copied as they are; only two small pieces are added that
// the sources do not have: the pistol magazine's body (hidden inside the grip
// until it drops out) and the shotgun shell loaded through the port.
//
// File axes (before weapons.ts `fit.rotation`): +X toward the stock (the
// muzzle is at -X), +Y up, +Z the weapon's left side.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../public/weapons/', import.meta.url));

/** Weapon rigs: moving parts (selected loose parts + pivot) and generated pieces. */
const RIGS = {
  pis01: {
    parts: [
      {
        // Slide body, top rib, front / rear sights and the rear serrations (metal + dark steel); the barrel crown at the muzzle stays.
        name: 'Slide',
        pivot: [0, 0.0575, 0],
        count: 17,
        pick: (m, b) => m !== 'SMG_Polymer' && b.min[1] >= 0.0455 && b.min[0] > -0.0966,
      },
      {
        // Trigger blade and its safety tab, inside the guard.
        name: 'Trigger',
        pivot: [0.0105, 0.027, 0],
        count: 2,
        pick: (m, b) => m !== 'SMG_Polymer' && b.max[2] <= 0.0045 && b.min[0] >= 0.006 && b.max[0] <= 0.015 && b.min[1] >= 0.009 && b.max[1] <= 0.0285,
      },
      {
        // Magazine base plate under the grip; the body is added below (the source has none).
        name: 'Magazine',
        pivot: [0.067, -0.048, 0],
        count: 1,
        pick: (m, b) => m === 'SMG_Metal' && b.max[1] <= -0.047,
        // The magazine body inside the raked grip: a slanted box, 6 mm inside the grip walls.
        add: [{ kind: 'slantedBox', material: 'SMG_Metal', bottom: [0.049, 0.085, -0.0478], top: [0.032, 0.064, 0.022], halfWidth: 0.0105 }],
      },
    ],
  },
  sg01: {
    parts: [
      {
        // Pump fore-end: body, top, grip ribs (polymer) and its steel front cap.
        name: 'Pump',
        pivot: [-0.06, 0.04, 0],
        count: 8,
        pick: (m, b) =>
          (m === 'SMG_Polymer' && b.min[0] >= -0.162 && b.max[0] <= 0.047) || (m === 'SMG_Metal' && b.min[0] >= -0.1785 && b.max[0] <= -0.1595 && b.min[1] >= 0.02),
      },
      {
        // The bolt face seen through the ejection port: travels with the pump.
        name: 'PumpBolt',
        pivot: [0.13, 0.06, 0.018],
        count: 1,
        pick: (m) => m === 'SMG_Barrel',
      },
    ],
    // A 12-gauge shell (hull + brass head), at the loading port under the receiver; shown only while loading.
    extra: [{ name: 'Shell', position: [0.1, -0.012, 0], add: [{ kind: 'shell', length: 0.062, radius: 0.0093, head: 0.012 }] }],
  },
  smg01: {
    parts: [
      {
        // Curved magazine: body, base and its four ribs, raked forward.
        name: 'Magazine',
        pivot: [-0.06, 0.045, 0],
        count: 6,
        pick: (m, b) => m === 'SMG_Metal' && b.min[0] >= -0.1095 && b.max[0] <= -0.0165 && b.min[1] >= -0.1505 && b.max[1] <= 0.0455,
      },
      {
        // Cocking handle knob and stem in the slot on the left of the tube.
        name: 'ChargingHandle',
        pivot: [-0.195, 0.15, 0.02],
        count: 2,
        pick: (m, b) => m === 'SMG_Metal' && b.min[2] >= 0.0125 && b.min[0] >= -0.2035 && b.max[0] <= -0.1845,
      },
    ],
  },
};

/** Materials for generated pieces that the sources do not have. */
const NEW_MATERIALS = {
  Belt_Brass: { name: 'Belt_Brass', pbrMetallicRoughness: { baseColorFactor: [0.7, 0.5, 0.22, 1], metallicFactor: 0.9, roughnessFactor: 0.38 } },
  Belt_Link: { name: 'Belt_Link', pbrMetallicRoughness: { baseColorFactor: [0.035, 0.035, 0.035, 1], metallicFactor: 0.7, roughnessFactor: 0.45 } },
  Shell_Hull: { name: 'Shell_Hull', pbrMetallicRoughness: { baseColorFactor: [0.45, 0.07, 0.05, 1], metallicFactor: 0, roughnessFactor: 0.55 } },
  Shell_Brass: { name: 'Shell_Brass', pbrMetallicRoughness: { baseColorFactor: [0.72, 0.52, 0.24, 1], metallicFactor: 0.9, roughnessFactor: 0.35 } },
};

// ---- GLB in ------------------------------------------------------------------------------------

function readGlb(file) {
  const b = readFileSync(file);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString());
  const binStart = 20 + jsonLen + 8;
  const read = (i) => {
    const a = json.accessors[i];
    const v = json.bufferViews[a.bufferView];
    const off = binStart + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type] * a.count;
    if (a.componentType === 5126) return Float32Array.from({ length: n }, (_, k) => b.readFloatLE(off + k * 4));
    if (a.componentType === 5123) return Uint32Array.from({ length: n }, (_, k) => b.readUInt16LE(off + k * 2));
    if (a.componentType === 5125) return Uint32Array.from({ length: n }, (_, k) => b.readUInt32LE(off + k * 4));
    throw new Error(`accessor ${i}: component type ${a.componentType}`);
  };
  return { json, read };
}

/** Loose parts of a primitive: triangles grouped by shared vertex indices, with bounds. */
function looseParts(pos, idx) {
  const parent = Array.from({ length: pos.length / 3 }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(idx[t]);
    parent[find(idx[t + 1])] = a;
    parent[find(idx[t + 2])] = a;
  }
  const parts = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(idx[t]);
    let p = parts.get(r);
    if (!p) parts.set(r, (p = { tris: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    p.tris.push(t);
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k];
      for (let d = 0; d < 3; d++) {
        p.min[d] = Math.min(p.min[d], pos[v * 3 + d]);
        p.max[d] = Math.max(p.max[d], pos[v * 3 + d]);
      }
    }
  }
  return [...parts.values()];
}

// ---- generated pieces ----------------------------------------------------------------------------

/** Flat-shaded quads → triangles (each face its own 4 vertices, normal from the winding). */
function quadsToMesh(quads) {
  const pos = [];
  const nor = [];
  const idx = [];
  for (const q of quads) {
    const [a, b, c] = q;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n) || 1;
    const base = pos.length / 3;
    for (const v of q) {
      pos.push(...v);
      nor.push(n[0] / l, n[1] / l, n[2] / l);
    }
    if (q.length === 4) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else idx.push(base, base + 1, base + 2);
  }
  return { pos, nor, idx };
}

/** A box whose bottom and top faces are offset along X (a magazine in a raked grip). */
function slantedBox({ bottom: [bx0, bx1, by], top: [tx0, tx1, ty], halfWidth: h }) {
  const v = (x, y, z) => [x, y, z];
  const B = [v(bx0, by, -h), v(bx1, by, -h), v(bx1, by, h), v(bx0, by, h)];
  const T = [v(tx0, ty, -h), v(tx1, ty, -h), v(tx1, ty, h), v(tx0, ty, h)];
  return quadsToMesh([
    [B[0], B[1], B[2], B[3]],
    [T[3], T[2], T[1], T[0]],
    [B[0], T[0], T[1], B[1]],
    [B[1], T[1], T[2], B[2]],
    [B[2], T[2], T[3], B[3]],
    [B[3], T[3], T[0], B[0]],
  ]);
}

/** A shotgun shell along X (head toward +X, the stock): hull and brass head as two meshes, 10 sides. */
function shell({ length, radius, head }) {
  const sides = 10;
  const ring = (x, r) => Array.from({ length: sides }, (_, i) => [x, Math.cos((i / sides) * Math.PI * 2) * r, Math.sin((i / sides) * Math.PI * 2) * r]);
  const tube = (x0, x1, r0, r1, capFront, capBack) => {
    const a = ring(x0, r0);
    const b = ring(x1, r1);
    const q = [];
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      q.push([a[i], a[j], b[j], b[i]]);
    }
    if (capFront) for (let i = 1; i < sides - 1; i++) q.push([a[0], a[i + 1], a[i]]);
    if (capBack) for (let i = 1; i < sides - 1; i++) q.push([b[0], b[i], b[i + 1]]);
    return quadsToMesh(q);
  };
  const x0 = -length / 2;
  const x1 = length / 2;
  return [
    { material: 'Shell_Hull', ...tube(x0, x1 - head, radius * 0.97, radius * 0.97, true, false) },
    { material: 'Shell_Brass', ...tube(x1 - head, x1, radius, radius * 1.04, false, true) },
  ];
}

// ---- rig -------------------------------------------------------------------------------------------

function rig(id) {
  const spec = RIGS[id];
  const { json, read } = readGlb(`${DIR}${id}.glb`);
  if (json.nodes.length !== 1 || json.meshes.length !== 1) throw new Error(`${id}: expected one node with one mesh`);
  const node = json.nodes[0];
  const materials = json.materials.map((m) => ({ ...m }));
  const matIndex = (name) => {
    let i = materials.findIndex((m) => m.name === name);
    if (i < 0) i = materials.push({ ...NEW_MATERIALS[name] }) - 1;
    return i;
  };

  // Source primitives with their loose parts; every triangle starts in the body.
  const prims = json.meshes[0].primitives.map((p) => {
    const pos = read(p.attributes.POSITION);
    const nor = read(p.attributes.NORMAL);
    const idx = read(p.indices);
    return { material: p.material, pos, nor, idx, parts: looseParts(pos, idx), owner: new Int32Array(idx.length / 3).fill(-1) };
  });

  const report = [];
  spec.parts.forEach((part, pi) => {
    let found = 0;
    for (const p of prims) {
      const m = materials[p.material].name;
      for (const lp of p.parts) {
        if (!part.pick(m, lp)) continue;
        found++;
        for (const t of lp.tris) {
          if (p.owner[t / 3] !== -1) throw new Error(`${id}: a triangle picked by two parts`);
          p.owner[t / 3] = pi;
        }
      }
    }
    if (found !== part.count) throw new Error(`${id} ${part.name}: picked ${found} loose parts, expected ${part.count}`);
    report.push(`${part.name} ${found}`);
  });

  /** Mesh primitives from the triangles owned by `who` (-1 = body), positions relative to `pivot`. */
  const primitivesOf = (who, pivot) => {
    const out = [];
    for (const p of prims) {
      const remap = new Map();
      const pos = [];
      const nor = [];
      const idx = [];
      for (let t = 0; t < p.owner.length; t++) {
        if (p.owner[t] !== who) continue;
        for (let k = 0; k < 3; k++) {
          const v = p.idx[t * 3 + k];
          let n = remap.get(v);
          if (n === undefined) {
            n = remap.size;
            remap.set(v, n);
            pos.push(p.pos[v * 3] - pivot[0], p.pos[v * 3 + 1] - pivot[1], p.pos[v * 3 + 2] - pivot[2]);
            nor.push(p.nor[v * 3], p.nor[v * 3 + 1], p.nor[v * 3 + 2]);
          }
          idx.push(n);
        }
      }
      if (idx.length) out.push({ material: p.material, pos, nor, idx });
    }
    return out;
  };
  /** Generated geometry, positions relative to `pivot`. */
  const generated = (adds, pivot) =>
    (adds ?? []).flatMap((a) => {
      const meshes = a.kind === 'slantedBox' ? [{ material: a.material, ...slantedBox(a) }] : shell(a);
      return meshes.map((g) => ({
        material: matIndex(g.material),
        pos: g.pos.map((v, i) => v - pivot[i % 3]),
        nor: g.nor,
        idx: g.idx,
      }));
    });

  // ---- write ----
  const chunks = [];
  let byteLength = 0;
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const addView = (data, target) => {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      byteLength += pad;
    }
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target });
    chunks.push(bytes);
    byteLength += bytes.length;
    return bufferViews.length - 1;
  };
  const addMesh = (name, list) => {
    // One primitive per material (a draw call each): pieces of the same material are merged.
    const byMat = new Map();
    for (const g of list) {
      const m = byMat.get(g.material);
      if (!m) byMat.set(g.material, { material: g.material, pos: [...g.pos], nor: [...g.nor], idx: [...g.idx] });
      else {
        const base = m.pos.length / 3;
        m.pos.push(...g.pos);
        m.nor.push(...g.nor);
        m.idx.push(...g.idx.map((i) => i + base));
      }
    }
    const primitives = [...byMat.values()];
    meshes.push({
      name,
      primitives: primitives.map((g) => {
        const pos = Float32Array.from(g.pos);
        const min = [0, 1, 2].map((d) => Math.min(...g.pos.filter((_, i) => i % 3 === d)));
        const max = [0, 1, 2].map((d) => Math.max(...g.pos.filter((_, i) => i % 3 === d)));
        const big = g.pos.length / 3 > 65535;
        accessors.push({ bufferView: addView(pos, 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
        accessors.push({ bufferView: addView(Float32Array.from(g.nor), 34962), componentType: 5126, count: g.nor.length / 3, type: 'VEC3' });
        accessors.push({ bufferView: addView(big ? Uint32Array.from(g.idx) : Uint16Array.from(g.idx), 34963), componentType: big ? 5125 : 5123, count: g.idx.length, type: 'SCALAR' });
        return { attributes: { POSITION: accessors.length - 3, NORMAL: accessors.length - 2 }, indices: accessors.length - 1, material: g.material };
      }),
    });
    return meshes.length - 1;
  };

  const nodes = [{ ...node, mesh: addMesh(json.meshes[0].name, primitivesOf(-1, [0, 0, 0])), children: [] }];
  spec.parts.forEach((part, pi) => {
    const mesh = addMesh(part.name, [...primitivesOf(pi, part.pivot), ...generated(part.add, part.pivot)]);
    nodes[0].children.push(nodes.push({ name: part.name, translation: part.pivot, mesh }) - 1);
  });
  for (const x of spec.extra ?? []) {
    const mesh = addMesh(x.name, generated(x.add, [0, 0, 0]));
    nodes[0].children.push(nodes.push({ name: x.name, translation: x.position, mesh }) - 1);
    report.push(`${x.name} (added)`);
  }

  const out = {
    asset: { version: '2.0', generator: `GRID tools/rig-weapons.mjs from ${id}.glb (${json.asset.generator})` },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0] }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };
  const bin = Buffer.concat(chunks, byteLength);
  const jsonBuf = Buffer.from(JSON.stringify(out));
  const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
  const binPad = Buffer.alloc((4 - (bin.length % 4)) % 4);
  const jsonChunk = Buffer.concat([jsonBuf, jsonPad]);
  const binChunk = Buffer.concat([bin, binPad]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const ch = (len, type) => {
    const c = Buffer.alloc(8);
    c.writeUInt32LE(len, 0);
    c.writeUInt32LE(type, 4);
    return c;
  };
  const glb = Buffer.concat([header, ch(jsonChunk.length, 0x4e4f534a), jsonChunk, ch(binChunk.length, 0x004e4942), binChunk]);
  writeFileSync(`${OUT}${id}_rig.glb`, glb);
  const src = readFileSync(`${DIR}${id}.glb`).length;
  console.log(`${id}_rig.glb  ${glb.length} bytes (source ${src})  parts: ${report.join(', ')}`);
}

// ---- augment (parted Blender files: copy everything, append missing pieces) ---------------------

/**
 * Pieces added to a parted file (file axes: muzzle at +X, +Y up, +Z the right side). Each becomes a
 * child node of the file's root with its vertices in the root's space (translation 0), so weapons.ts
 * can gather it with the file's own nodes (`fit.magazine`).
 */
const AUGMENTS = {
  pis02: { pieces: [
    {
      // Double-stack 9 mm magazine body inside the grip frame (the file models only its base plate), following
      // the grip's rake (back edge -0.108 at the bottom, -0.088 at the top) 2-3 mm inside the panels.
      name: 'P_MagBody',
      add: [{ kind: 'slantedBox', material: 'RifleMetal', bottom: [-0.1, -0.064, -0.077], top: [-0.085, -0.05, 0.022], halfWidth: 0.0095 }],
    },
  ] },
  lmg01: { pieces: [
    {
      // 5.56 belt: six linked rounds rising from the pouch mouth (top y -0.068) up the left side to the feed
      // tray (left of the receiver, y ~0), bullets toward the muzzle.
      name: 'G_Belt',
      add: Array.from({ length: 6 }, (_, i) => {
        const y = -0.064 + i * 0.0115;
        const z = -0.03 + (i >= 4 ? (i - 3) * 0.004 : 0);
        return [
          { kind: 'slantedBox', material: 'Belt_Brass', bottom: [0.012, 0.057, y - 0.0045], top: [0.012, 0.057, y + 0.0045], halfWidth: 0.0045, z },
          { kind: 'slantedBox', material: 'Belt_Link', bottom: [0.024, 0.042, y - 0.0052], top: [0.024, 0.042, y + 0.0052], halfWidth: 0.0052, z },
        ];
      }).flat(),
    },
  ] },
  // M110: no piece missing, but the file's tan (linear 0.42 / 0.29 / 0.16, a light coyote that reads as
  // plastic in game) darkened to flat dark earth (sRGB ~#8a7352); the scope's tan and the metal stay.
  dmr01: {
    pieces: [],
    materials: {
      FDE_Tan: { baseColorFactor: [0.24, 0.17, 0.09, 1] },
      FDE_Polymer: { baseColorFactor: [0.21, 0.15, 0.08, 1], roughnessFactor: 0.75 },
    },
  },
};

function augment(id) {
  const file = `${DIR}${id}.glb`;
  const b = readFileSync(file);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString());
  const binLen = b.readUInt32LE(20 + jsonLen);
  const srcBin = b.subarray(20 + jsonLen + 8, 20 + jsonLen + 8 + binLen);
  const rootIndex = json.scenes[json.scene ?? 0].nodes[0];
  const root = json.nodes[rootIndex];
  const materials = json.materials;
  const matIndex = (name) => {
    let i = materials.findIndex((m) => m.name === name);
    if (i < 0) i = materials.push({ ...NEW_MATERIALS[name] }) - 1;
    return i;
  };
  const chunks = [srcBin];
  let byteLength = srcBin.length;
  const addView = (data, target) => {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      byteLength += pad;
    }
    json.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target });
    chunks.push(bytes);
    byteLength += bytes.length;
    return json.bufferViews.length - 1;
  };
  const report = [];
  const spec = AUGMENTS[id];
  for (const [name, pbr] of Object.entries(spec.materials ?? {})) {
    const m = materials.find((x) => x.name === name);
    if (!m) throw new Error(`${id}: no material ${name}`);
    m.pbrMetallicRoughness = { ...m.pbrMetallicRoughness, ...pbr };
    report.push(`${name} recoloured`);
  }
  for (const piece of spec.pieces) {
    const byMat = new Map();
    for (const a of piece.add) {
      const g = slantedBox(a);
      const dz = a.z ?? 0;
      const pos = g.pos.map((v, i) => (i % 3 === 2 ? v + dz : v));
      const m = matIndex(a.material);
      const acc = byMat.get(m) ?? { pos: [], nor: [], idx: [] };
      const base = acc.pos.length / 3;
      acc.pos.push(...pos);
      acc.nor.push(...g.nor);
      acc.idx.push(...g.idx.map((i) => i + base));
      byMat.set(m, acc);
    }
    const primitives = [...byMat.entries()].map(([material, g]) => {
      const min = [0, 1, 2].map((d) => Math.min(...g.pos.filter((_, i) => i % 3 === d)));
      const max = [0, 1, 2].map((d) => Math.max(...g.pos.filter((_, i) => i % 3 === d)));
      json.accessors.push({ bufferView: addView(Float32Array.from(g.pos), 34962), componentType: 5126, count: g.pos.length / 3, type: 'VEC3', min, max });
      json.accessors.push({ bufferView: addView(Float32Array.from(g.nor), 34962), componentType: 5126, count: g.nor.length / 3, type: 'VEC3' });
      json.accessors.push({ bufferView: addView(Uint16Array.from(g.idx), 34963), componentType: 5123, count: g.idx.length, type: 'SCALAR' });
      const n = json.accessors.length;
      return { attributes: { POSITION: n - 3, NORMAL: n - 2 }, indices: n - 1, material };
    });
    json.meshes.push({ name: piece.name, primitives });
    json.nodes.push({ name: piece.name, mesh: json.meshes.length - 1 });
    root.children = [...(root.children ?? []), json.nodes.length - 1];
    report.push(`${piece.name} (added, ${piece.add.length} pieces)`);
  }
  json.buffers = [{ byteLength }];
  json.asset = { ...json.asset, generator: `GRID tools/rig-weapons.mjs from ${id}.glb (${json.asset.generator})` };
  const bin = Buffer.concat(chunks, byteLength);
  const glb = writeGlb(json, bin);
  writeFileSync(`${OUT}${id}_rig.glb`, glb);
  console.log(`${id}_rig.glb  ${glb.length} bytes (source ${b.length})  nodes kept: ${json.nodes.length - spec.pieces.length}  ${report.join(', ')}`);
}

function writeGlb(json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json));
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const binChunk = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const ch = (len, type) => {
    const c = Buffer.alloc(8);
    c.writeUInt32LE(len, 0);
    c.writeUInt32LE(type, 4);
    return c;
  };
  return Buffer.concat([header, ch(jsonChunk.length, 0x4e4f534a), jsonChunk, ch(binChunk.length, 0x004e4942), binChunk]);
}

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const OUT = outAt >= 0 ? args.splice(outAt, 2)[1].replace(/\/?$/, '/') : DIR;
for (const id of args.length ? args : [...Object.keys(RIGS), ...Object.keys(AUGMENTS)]) {
  if (AUGMENTS[id]) augment(id);
  else rig(id);
}
