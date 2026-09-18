/* =============================================================================
   turns a map definition into meshes.  boxes are drawn with one instanced mesh
   per material, so a whole arena costs a handful of draw calls even on a phone.
   ========================================================================== */
import { settings } from '../core/settings.js';

const THREE = window.THREE;
let BOX = null, PLANE = null;

function sharedBox() {
  if (!BOX) { BOX = new THREE.BoxGeometry(1, 1, 1); BOX.userData.shared = true; }
  return BOX;
}
function sharedPlane() {
  if (!PLANE) { PLANE = new THREE.PlaneGeometry(1, 1); PLANE.userData.shared = true; }
  return PLANE;
}

export function buildArena(map) {
  const T = map.theme, group = new THREE.Group();
  group.name = 'arena';
  const q = settings.preset;
  const shadows = !!settings.get('shadows');

  /* ---- atmosphere ---- */
  const env = {
    background: new THREE.Color(T.sky),
    fog: new THREE.Fog(T.fog, T.fogNear, Math.round(T.fogFar * (q.drawDistance || 1)))
  };

  const hemi = new THREE.HemisphereLight(T.hemiSky, T.hemiGround, T.hemiI);
  hemi.position.set(0, 40, 0);
  group.add(hemi);
  group.add(new THREE.AmbientLight(T.ambient, T.ambientI));

  const sun = new THREE.DirectionalLight(T.sun, T.sunI);
  const d = T.sunDir || [-0.4, 0.85, 0.35];
  const reach = Math.max(map.sx, map.sz);
  sun.position.set(d[0] * reach * 1.6, d[1] * reach * 1.6, d[2] * reach * 1.6);
  sun.target.position.set(0, 0, 0);
  group.add(sun); group.add(sun.target);
  if (shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
    const c = sun.shadow.camera;
    c.left = -reach * 1.15; c.right = reach * 1.15;
    c.top = reach * 1.15; c.bottom = -reach * 1.15;
    c.near = 1; c.far = reach * 4;
    sun.shadow.bias = -0.0016;
    sun.shadow.normalBias = 0.03;
  }

  /* ---- floor ---- */
  const floorMat = new THREE.MeshLambertMaterial({ color: T.ground });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(map.sx * 2 + 8, map.sz * 2 + 8), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.01;
  floor.receiveShadow = shadows;
  group.add(floor);

  // faint seam grid keeps distances readable without shouting
  const g = [], step = 4;
  for (let x = -map.sx; x <= map.sx; x += step) g.push(x, 0.015, -map.sz, x, 0.015, map.sz);
  for (let z = -map.sz; z <= map.sz; z += step) g.push(-map.sx, 0.015, z, map.sx, 0.015, z);
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(g, 3));
  group.add(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({
    color: T.grid, transparent: true, opacity: 0.3
  })));

  /* ---- boxes, batched per material ---- */
  const byMat = new Map();
  for (const b of map.boxes) {
    if (b[5] === 'n' && b[6] === 'beam') { /* decor beams still render */ }
    const key = b[6] || 'stone';
    if (!byMat.has(key)) byMat.set(key, []);
    byMat.get(key).push(b);
  }
  const dummy = new THREE.Object3D();
  for (const [key, list] of byMat) {
    const color = (map.mats && map.mats[key]) || 0x555555;
    const mat = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.InstancedMesh(sharedBox(), mat, list.length);
    mesh.castShadow = shadows && key !== 'shell';
    mesh.receiveShadow = shadows;
    for (let i = 0; i < list.length; i++) {
      const b = list[i], y0 = b[7] || 0;
      dummy.position.set(b[0], y0 + b[4] / 2, b[1]);
      dummy.scale.set(b[2], b[4], b[3]);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  /* ---- edge trim on climbable surfaces: reads as "you can stand here" ---- */
  const trims = map.boxes.filter((b) => b[5] === 'f' && b[4] >= 0.3);
  if (trims.length) {
    const trimMat = new THREE.MeshBasicMaterial({ color: T.accent, transparent: true, opacity: 0.32 });
    const mesh = new THREE.InstancedMesh(sharedBox(), trimMat, trims.length);
    for (let i = 0; i < trims.length; i++) {
      const b = trims[i], y0 = b[7] || 0;
      dummy.position.set(b[0], y0 + b[4] + 0.015, b[1]);
      dummy.scale.set(b[2] * 0.995, 0.03, b[3] * 0.995);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  /* ---- team side markers so you always know which way is home ---- */
  const markMat = (hex) => new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.35 });
  for (const [sign, hex] of [[-1, 0x4f7fd6], [1, 0xd0653a]]) {
    const strip = new THREE.Mesh(sharedPlane(), markMat(hex));
    strip.scale.set(map.sx * 1.4, 2.6, 1);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(0, 0.03, sign * (map.sz - 2.4));
    group.add(strip);
  }

  /* ---- per map flourishes, cheap and mood setting ---- */
  decorate(map, group, q);

  return { group, env, sun };
}

function decorate(map, group, q) {
  const T = map.theme;
  const detail = q.effects >= 0.8;

  if (map.id === 'sunken') {
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(map.sx * 2, map.sz * 2),
      new THREE.MeshLambertMaterial({ color: T.water || 0x1d3a3c, transparent: true, opacity: 0.55 })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.12;
    group.add(water);
    group.userData.water = water;
  }

  if (map.id === 'shrine') {
    // hanging paper banners along the centre lane
    const mat = new THREE.MeshLambertMaterial({ color: 0xa8402a, side: THREE.DoubleSide });
    for (let i = -1; i <= 1; i += 2) {
      for (let j = -1; j <= 1; j += 2) {
        const ban = new THREE.Mesh(sharedPlane(), mat);
        ban.scale.set(1.1, 3.2, 1);
        ban.position.set(i * 6.3, 3.2, j * 14.4);
        group.add(ban);
      }
    }
  }

  if (map.id === 'market' && detail) {
    const signMat = new THREE.MeshBasicMaterial({ color: (map.mats && map.mats.sign) || 0xb8532a });
    for (const [x, z] of [[-24.5, -6], [24.5, 6], [-24.5, -22], [24.5, 22]]) {
      const s = new THREE.Mesh(sharedBox(), signMat);
      s.scale.set(0.3, 2.6, 4.2);
      s.position.set(x + (x < 0 ? 3.6 : -3.6), 3.4, z);
      group.add(s);
    }
  }

  // a couple of warm practical lights, high quality only
  if (q.effects >= 1) {
    for (const [x, z] of [[0, 0], [-map.sx * 0.6, map.sz * 0.6], [map.sx * 0.6, -map.sz * 0.6]]) {
      const l = new THREE.PointLight(T.accent, 0.55, 26, 2);
      l.position.set(x, 5.2, z);
      group.add(l);
    }
  }
}
