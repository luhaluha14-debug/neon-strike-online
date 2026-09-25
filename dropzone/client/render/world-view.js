/* =========================================================================
   Static world rendering: terrain, merged buildings, instanced vegetation,
   sky, lights, and the safe-zone wall.
   Draw calls are kept low by merging all static boxes into a few chunked
   meshes (one material, vertex colours) — important for mobile.
   ========================================================================= */
import * as THREE from 'three';
import { roadDist } from '../../shared/mapgen.js';

const CHUNK = 64;

/* ---------- shared grain texture (adds surface detail for free) ---------- */
let grainTex = null;
export function grainTexture() {
  if (grainTex) return grainTex;
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < S * S; i++) {
    const v = 214 + rnd() * 41;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // a few soft streaks / stains
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(0,0,0,${0.02 + rnd() * 0.04})`;
    g.fillRect(rnd() * S, rnd() * S, 2 + rnd() * 30, 1 + rnd() * 3);
  }
  grainTex = new THREE.CanvasTexture(c);
  grainTex.wrapS = grainTex.wrapT = THREE.RepeatWrapping;
  grainTex.colorSpace = THREE.SRGBColorSpace;
  grainTex.anisotropy = 4;
  return grainTex;
}

export function makeMat(q, opts = {}) {
  const base = { vertexColors: true, ...opts };
  if (q.material === 'standard') return new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.02, ...base });
  return new THREE.MeshLambertMaterial(base);
}

/* ---------- merged box geometry builder ---------- */
export class BoxBatch {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.uv = []; this.idx = []; }
  get count() { return this.pos.length / 3; }
  /** add a box; color THREE.Color; opts.ao darkens bottom vertices; opts.skipBottom */
  add(minX, minY, minZ, maxX, maxY, maxZ, color, opts = {}) {
    const faces = [
      // normal, 4 corners (ccw from outside)
      [[1, 0, 0], [[maxX, minY, maxZ], [maxX, minY, minZ], [maxX, maxY, minZ], [maxX, maxY, maxZ]]],
      [[-1, 0, 0], [[minX, minY, minZ], [minX, minY, maxZ], [minX, maxY, maxZ], [minX, maxY, minZ]]],
      [[0, 1, 0], [[minX, maxY, maxZ], [maxX, maxY, maxZ], [maxX, maxY, minZ], [minX, maxY, minZ]]],
      [[0, -1, 0], [[minX, minY, minZ], [maxX, minY, minZ], [maxX, minY, maxZ], [minX, minY, maxZ]]],
      [[0, 0, 1], [[minX, minY, maxZ], [maxX, minY, maxZ], [maxX, maxY, maxZ], [minX, maxY, maxZ]]],
      [[0, 0, -1], [[maxX, minY, minZ], [minX, minY, minZ], [minX, maxY, minZ], [maxX, maxY, minZ]]]
    ];
    const h = maxY - minY;
    const ao = opts.ao !== false && h > 0.6;
    for (let f = 0; f < 6; f++) {
      if (f === 3 && opts.skipBottom) continue;
      const [n, vs] = faces[f];
      const b = this.count;
      for (const v of vs) {
        this.pos.push(v[0], v[1], v[2]);
        this.nrm.push(n[0], n[1], n[2]);
        let k = 1;
        if (ao && v[1] === minY && f !== 2 && f !== 3) k = 0.72;
        if (f === 2) k *= 1.04;
        this.col.push(color.r * k, color.g * k, color.b * k);
        // world-space planar uv (0.5 repeats / m)
        if (n[0] !== 0) this.uv.push(v[2] * 0.5, v[1] * 0.5);
        else if (n[1] !== 0) this.uv.push(v[0] * 0.5, v[2] * 0.5);
        else this.uv.push(v[0] * 0.5, v[1] * 0.5);
      }
      this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/* ---------- small deterministic hash for colour jitter ---------- */
function jitter(i) { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x); }

export class WorldView {
  constructor(scene, world, q) {
    this.scene = scene;
    this.world = world;
    this.q = q;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.buildSky();
    this.buildLights();
    this.buildTerrain();
    this.buildStatic();
    this.buildProps();
    this.buildZone();
    this.debugGroup = null;
  }

  buildSky() {
    const q = this.q;
    const horizon = new THREE.Color(0xb9c7cf), top = new THREE.Color(0x5e89b5);
    this.scene.background = horizon.clone();
    this.scene.fog = new THREE.Fog(0xaebdc6, q.viewDist * 0.35, q.viewDist);
    const geo = new THREE.SphereGeometry(900, 24, 12);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: top }, bottom: { value: horizon }, sun: { value: new THREE.Vector3(0.45, 0.62, 0.35).normalize() } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform vec3 sun; varying vec3 vP;
        void main(){ float h = max(vP.y, 0.0); vec3 c = mix(bottom, top, pow(h, 0.55));
          float s = max(dot(normalize(vP), sun), 0.0); c += vec3(1.0,0.9,0.7) * pow(s, 90.0) * 0.9 + vec3(1.0,0.85,0.6) * pow(s, 6.0) * 0.12;
          gl_FragColor = vec4(c, 1.0); }`
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  buildLights() {
    const q = this.q;
    this.hemi = new THREE.HemisphereLight(0xcfe0ee, 0x5a5440, q.material === 'standard' ? 1.25 : 1.5);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1dc, q.material === 'standard' ? 2.3 : 1.7);
    this.sunDir = new THREE.Vector3(0.45, 0.62, 0.35).normalize();
    this.sun.position.copy(this.sunDir).multiplyScalar(120);
    if (q.shadows > 0) {
      this.sun.castShadow = true;
      const ext = [0, 40, 60, 80][q.shadows];
      const sc = this.sun.shadow.camera;
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 320;
      this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.03;
    }
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
  }

  buildTerrain() {
    const T = this.world.terrain, q = this.q;
    const per = CHUNK / T.cell;
    const chunks = Math.ceil((T.n - 1) / per);
    const mat = makeMat(q, { map: grainTexture() });
    this.terrainMat = mat;
    const grassA = new THREE.Color(0x5d7a3a), grassB = new THREE.Color(0x71843f), dirt = new THREE.Color(0x7d6a4c), rock = new THREE.Color(0x85827a), road = new THREE.Color(0x4d4a45), roadEdge = new THREE.Color(0x6e654f), pad = new THREE.Color(0x6f6a55);
    const tmp = new THREE.Color();
    // flats (settlements) get a worn ground colour
    const flats = this.world.locations;
    for (let cj = 0; cj < chunks; cj++) {
      for (let ci = 0; ci < chunks; ci++) {
        const i0 = ci * per, j0 = cj * per;
        const i1 = Math.min(T.n - 1, i0 + per), j1 = Math.min(T.n - 1, j0 + per);
        const nx = i1 - i0 + 1, nz = j1 - j0 + 1;
        const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
        let k = 0;
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const x = -T.half + i * T.cell, z = -T.half + j * T.cell, y = T.h[j * T.n + i];
            pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
            uv[k * 2] = x * 0.25; uv[k * 2 + 1] = z * 0.25;
            const n = jitter(i * 7.1 + j * 3.3);
            const n2 = Math.sin(x * 0.05 + Math.sin(z * 0.07) * 2) * 0.5 + 0.5;
            tmp.copy(grassA).lerp(grassB, n2 * 0.8 + n * 0.2);
            const slope = T.slopeAt(x, z);
            if (slope < 0.9) tmp.lerp(dirt, Math.min(1, (0.9 - slope) * 5));
            if (slope < 0.74) tmp.lerp(rock, Math.min(1, (0.74 - slope) * 6));
            for (const f of flats) {
              const d = Math.hypot(x - f.x, z - f.z);
              if (d < 30) tmp.lerp(pad, (1 - d / 30) * 0.35);
            }
            const rd = roadDist(this.world, x, z);
            if (rd < 0) tmp.copy(road).multiplyScalar(0.95 + n * 0.1);
            else if (rd < 1.4) tmp.lerp(roadEdge, 1 - rd / 1.4);
            col[k * 3] = tmp.r; col[k * 3 + 1] = tmp.g; col[k * 3 + 2] = tmp.b;
            k++;
          }
        }
        const idx = [];
        for (let j = 0; j < nz - 1; j++) {
          for (let i = 0; i < nx - 1; i++) {
            const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
            idx.push(a, c, b, d, b, c);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        g.setIndex(idx);
        g.computeVertexNormals();
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, mat);
        m.receiveShadow = q.shadows > 0;
        m.matrixAutoUpdate = false;
        this.group.add(m);
      }
    }
    // out of bounds ground plane so the horizon is never empty
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshLambertMaterial({ color: 0x5c7239 }));
    outer.rotation.x = -Math.PI / 2; outer.position.y = T.minH - 0.5;
    this.group.add(outer);
  }

  buildStatic() {
    const W = this.world, q = this.q;
    const half = W.half;
    const n = Math.ceil((half * 2) / CHUNK);
    const batches = new Map();
    const col = new THREE.Color();
    for (const b of W.boxes) {
      if (b.hidden) continue;
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      const ci = Math.min(n - 1, Math.max(0, Math.floor((cx + half) / CHUNK)));
      const cj = Math.min(n - 1, Math.max(0, Math.floor((cz + half) / CHUNK)));
      const key = cj * n + ci;
      if (!batches.has(key)) batches.set(key, new BoxBatch());
      col.setHex(b.color);
      const jv = 0.92 + jitter(b.id) * 0.14;
      col.multiplyScalar(jv);
      batches.get(key).add(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, col, { skipBottom: b.kind === 'floor' && b.minY < W.groundAt(cx, cz) });
    }
    const mat = makeMat(q, { map: grainTexture() });
    this.staticMat = mat;
    this.staticMeshes = [];
    for (const bb of batches.values()) {
      const m = new THREE.Mesh(bb.build(), mat);
      m.castShadow = q.shadows > 0;
      m.receiveShadow = q.shadows > 0;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      this.staticMeshes.push(m);
    }
  }

  buildProps() {
    const W = this.world, q = this.q;
    const keep = (i) => q.props >= 1 || jitter(i + 0.5) < q.props;
    const trees = W.props.filter((p, i) => p.type === 'tree' && (keep(i) || true));
    const bushes = W.props.filter((p, i) => p.type === 'bush' && keep(i));
    const rocks = W.props.filter((p) => p.type === 'rock');
    const mat = new THREE.MeshLambertMaterial({ vertexColors: false });
    const dummy = new THREE.Object3D();
    const c = new THREE.Color();

    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 1, 6);
    trunkGeo.translate(0, 0.5, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x5a4331 }), trees.length);
    const pines = trees.filter((t) => t.kind === 'pine'), oaks = trees.filter((t) => t.kind !== 'pine');
    const pineGeo = mergeGeos([
      new THREE.ConeGeometry(2.2, 4.6, 7).translate(0, 3.2, 0),
      new THREE.ConeGeometry(1.7, 3.8, 7).translate(0, 5.4, 0),
      new THREE.ConeGeometry(1.1, 2.8, 7).translate(0, 7.3, 0)
    ]);
    const oakGeo = mergeGeos([
      new THREE.IcosahedronGeometry(2.6, 0).scale(1, 0.85, 1).translate(0, 4.6, 0),
      new THREE.IcosahedronGeometry(1.8, 0).translate(1.2, 5.8, 0.6),
      new THREE.IcosahedronGeometry(1.7, 0).translate(-1.1, 5.4, -0.8)
    ]);
    const pineMesh = new THREE.InstancedMesh(pineGeo, mat.clone(), pines.length);
    const oakMesh = new THREE.InstancedMesh(oakGeo, mat.clone(), oaks.length);
    trees.forEach((t, i) => {
      dummy.position.set(t.x, t.y - 0.2, t.z);
      dummy.rotation.set(0, jitter(i) * 6.28, 0);
      dummy.scale.set(t.s, t.h * (t.kind === 'pine' ? 0.5 : 0.42), t.s);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
    });
    const place = (mesh, list, colA, colB) => {
      list.forEach((t, i) => {
        dummy.position.set(t.x, t.y - 0.3, t.z);
        dummy.rotation.set(0, jitter(i * 3.7) * 6.28, 0);
        const s = t.s * t.h / 10;
        dummy.scale.set(s * 1.05, s, s * 1.05);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        c.setHex(colA).lerp(new THREE.Color(colB), jitter(i * 1.3));
        mesh.setColorAt(i, c);
      });
    };
    place(pineMesh, pines, 0x2f4a2a, 0x3d5a2e);
    place(oakMesh, oaks, 0x4c6a2c, 0x62772f);
    const bushGeo = new THREE.IcosahedronGeometry(1, 1).scale(1, 0.62, 1);
    const bushMesh = new THREE.InstancedMesh(bushGeo, mat.clone(), bushes.length);
    bushes.forEach((b, i) => {
      dummy.position.set(b.x, b.y + b.r * 0.35, b.z);
      dummy.rotation.set(0, jitter(i) * 6, 0);
      dummy.scale.set(b.r, b.r * 1.15, b.r);
      dummy.updateMatrix();
      bushMesh.setMatrixAt(i, dummy.matrix);
      c.setHex(0x4a6b2e).lerp(new THREE.Color(0x6c7d36), jitter(i * 2.1));
      bushMesh.setColorAt(i, c);
    });
    const rockGeo = new THREE.DodecahedronGeometry(1, 0).scale(1, 0.75, 1);
    const rockMesh = new THREE.InstancedMesh(rockGeo, mat.clone(), rocks.length);
    rocks.forEach((r, i) => {
      dummy.position.set(r.x, r.y + r.s * 0.3, r.z);
      dummy.rotation.set(jitter(i) * 0.5, r.rot, jitter(i * 2) * 0.4);
      dummy.scale.set(r.s * 1.05, r.s * 0.95, r.s * 0.95);
      dummy.updateMatrix();
      rockMesh.setMatrixAt(i, dummy.matrix);
      c.setHex(0x8a877e).multiplyScalar(0.85 + jitter(i * 5) * 0.25);
      rockMesh.setColorAt(i, c);
    });
    for (const m of [trunks, pineMesh, oakMesh, bushMesh, rockMesh]) {
      m.castShadow = q.shadows > 1 && m !== bushMesh;
      m.receiveShadow = q.shadows > 0;
      m.computeBoundingSphere();
      this.group.add(m);
    }
    this.bushMesh = bushMesh;
  }

  buildZone() {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 128, 1, true);
    geo.translate(0, 0.5, 0);
    this.zoneMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      uniforms: { time: { value: 0 }, color: { value: new THREE.Color(0x3d7dff) } },
      vertexShader: 'varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: `uniform float time; uniform vec3 color; varying vec2 vUv; varying vec3 vW;
        void main(){ float band = 0.5 + 0.5 * sin(vW.y * 0.9 - time * 2.0 + vUv.x * 60.0);
          float fade = smoothstep(0.5, 0.18, vUv.y);
          // the wall matters up close; far away it should not paint the whole sky
          float d = distance(cameraPosition.xz, vW.xz);
          float near = mix(0.22, 1.0, smoothstep(220.0, 40.0, d));
          float a = (0.16 + band * 0.14) * fade * near;
          gl_FragColor = vec4(color * (0.8 + band * 0.5), a); }`
    });
    this.zoneWall = new THREE.Mesh(geo, this.zoneMat);
    this.zoneWall.frustumCulled = false;
    this.zoneWall.renderOrder = 5;
    this.scene.add(this.zoneWall);
  }

  update(dt, camPos, zone) {
    this.sky.position.copy(camPos);
    // keep the shadow frustum centred on the camera
    if (this.sun.castShadow) {
      const snap = 2;
      const tx = Math.round(camPos.x / snap) * snap, tz = Math.round(camPos.z / snap) * snap;
      this.sun.target.position.set(tx, 0, tz);
      this.sun.position.set(tx + this.sunDir.x * 150, this.sunDir.y * 150, tz + this.sunDir.z * 150);
    }
    this.zoneMat.uniforms.time.value += dt;
    if (zone) {
      const r = Math.max(0.5, zone.cur.r);
      this.zoneWall.position.set(zone.cur.x, -30, zone.cur.z);
      this.zoneWall.scale.set(r, 200, r);
      this.zoneWall.visible = true;
    }
  }

  /** dev: show collision boxes as wireframes */
  toggleDebugBoxes(on) {
    if (this.debugGroup) { this.scene.remove(this.debugGroup); this.debugGroup = null; }
    if (!on) return;
    const pos = [];
    for (const b of this.world.boxes) {
      if (b.kind === 'bound') continue;
      const x0 = b.minX, x1 = b.maxX, y0 = b.minY, y1 = b.maxY, z0 = b.minZ, z1 = b.maxZ;
      const e = [[x0, y0, z0, x1, y0, z0], [x1, y0, z0, x1, y0, z1], [x1, y0, z1, x0, y0, z1], [x0, y0, z1, x0, y0, z0],
        [x0, y1, z0, x1, y1, z0], [x1, y1, z0, x1, y1, z1], [x1, y1, z1, x0, y1, z1], [x0, y1, z1, x0, y1, z0],
        [x0, y0, z0, x0, y1, z0], [x1, y0, z0, x1, y1, z0], [x1, y0, z1, x1, y1, z1], [x0, y0, z1, x0, y1, z1]];
      for (const s of e) pos.push(...s);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.debugGroup = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x00ff88, depthTest: false, transparent: true, opacity: 0.5 }));
    this.debugGroup.renderOrder = 50;
    this.scene.add(this.debugGroup);
  }
}

/** merge simple non-indexed/indexed geometries that share attributes position/normal */
export function mergeGeos(geos) {
  const pos = [], nrm = [], idx = [];
  let base = 0;
  for (let g of geos) {
    if (g.index) g = g.toNonIndexed();
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i++) { pos.push(p[i]); nrm.push(n[i]); }
    const cnt = p.length / 3;
    for (let i = 0; i < cnt; i++) idx.push(base + i);
    base += cnt;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}
