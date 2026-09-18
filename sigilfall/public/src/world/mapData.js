/* =============================================================================
   arena definitions.  pure data, imported by the client renderer, the collision
   world and the server, so everyone judges the same geometry.

   design rules every arena follows
     - point symmetric around the centre, so both teams get the same fight
     - a raised centre worth contesting, plus two flanking routes
     - waist high cover in the open, full cover near the lanes
     - walkable steps rise at most 0.47 so players step up without jumping
   ========================================================================== */

/* ---- small builders ------------------------------------------------------ */

/* the unclimbable arena shell around a floor of +-sx by +-sz */
function shell(sx, sz, h) {
  return [
    [0, -(sz + 0.7), sx * 2 + 6, 2.6, h, 's', 'shell'],
    [0, sz + 0.7, sx * 2 + 6, 2.6, h, 's', 'shell'],
    [-(sx + 0.7), 0, 2.6, sz * 2 + 6, h, 's', 'shell'],
    [sx + 0.7, 0, 2.6, sz * 2 + 6, h, 's', 'shell']
  ];
}

/* a flight of steps climbing to `top`, marching outward from (x, z) */
function stair(x, z, axis, dir, top, count, width, mat) {
  const out = [], depth = 1.25;
  for (let i = 0; i < count; i++) {
    const h = (top * (count - i)) / count;
    const off = (i + 0.5) * depth;
    const px = axis === 'x' ? x + dir * off : x;
    const pz = axis === 'z' ? z + dir * off : z;
    out.push([px, pz, axis === 'x' ? depth : width, axis === 'x' ? width : depth, h, 'f', mat]);
  }
  return out;
}

/* the list plus its point mirrored copy; pieces on the centre stay single */
function mirror(list) {
  const out = list.slice();
  for (const b of list) {
    if (b[0] === 0 && b[1] === 0) continue;
    out.push([-b[0], -b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
  }
  return out;
}
function mirrorPoints(list) { return list.map((p) => [-p[0], -p[1]]); }

export const MAPS = {};

/* =============================================================================
   1. 폐사원  RUINED SHRINE
   a collapsed mountain temple.  wide stone centre, covered side halls, and a
   pair of roof runs that overlook the middle.
   ========================================================================== */
{
  const sx = 30, sz = 30;
  const half = [
    /* side hall: roof you can fight from, entrances at both ends */
    [-21, -11, 13, 2.0, 3.4, 's', 'stone'],
    [-21, -21, 13, 2.0, 3.4, 's', 'stone'],
    [-27.4, -16, 1.8, 8.0, 3.4, 's', 'stone'],
    [-21, -16, 13, 10, 3.2, 'f', 'roof'],
    ...stair(-14.0, -16, 'x', 1, 3.2, 7, 5.0, 'stone'),
    /* shrine gate posts flanking the lane into the centre */
    [-9.5, -14.5, 1.5, 1.5, 4.6, 's', 'pillar'],
    [-3.0, -14.5, 1.5, 1.5, 4.6, 's', 'pillar'],
    [-6.25, -14.5, 8.0, 1.0, 0.9, 'n', 'beam', 4.6],
    /* waist high rubble in the open */
    [-13.5, -6.5, 3.6, 1.1, 1.15, 's', 'rubble'],
    [-19.0, -3.0, 1.1, 4.2, 1.15, 's', 'rubble'],
    [-24.0, -8.0, 3.0, 3.0, 2.3, 's', 'crate'],
    /* broken outer wall making a flank corridor */
    [-26.5, 4.0, 3.5, 12.0, 2.7, 's', 'stone'],
    [-20.0, 9.5, 5.0, 1.4, 1.9, 's', 'rubble'],
    /* corner watch stone */
    [-26.0, -26.0, 4.0, 4.0, 4.4, 's', 'pillar']
  ];
  MAPS.shrine = {
    id: 'shrine', name: '폐사원', latin: 'RUINED SHRINE', sub: '중형 · 밸런스',
    desc: '무너진 산사. 넓은 석조 중앙단과 양쪽 회랑 지붕이 시야를 나눈다.',
    sx, sz, viewFar: 150,
    theme: {
      sky: 0x1b2027, fog: 0x232a33, fogNear: 30, fogFar: 132,
      hemiSky: 0x8fa3ba, hemiGround: 0x3b332a, hemiI: 0.78,
      sun: 0xffe2bb, sunI: 0.8, sunDir: [-0.45, 0.82, 0.35],
      ambient: 0x3a4454, ambientI: 0.5,
      ground: 0x4b463c, grid: 0x635c4c, accent: 0xc8632f
    },
    mats: {
      shell: 0x2a2f36, stone: 0x585349, roof: 0x4a3f36, pillar: 0x6b6355,
      rubble: 0x4f4a41, crate: 0x54432c, beam: 0x7a3626, altar: 0x6e6452,
      ward: 0xb5603a
    },
    boxes: [
      ...shell(sx, sz, 10),
      /* central altar terrace with stairs on four sides */
      [0, 0, 17, 17, 1.4, 'f', 'altar'],
      ...stair(8.5, 0, 'x', 1, 1.4, 3, 6.5, 'altar'),
      ...stair(-8.5, 0, 'x', -1, 1.4, 3, 6.5, 'altar'),
      ...stair(0, 8.5, 'z', 1, 1.4, 3, 6.5, 'altar'),
      ...stair(0, -8.5, 'z', -1, 1.4, 3, 6.5, 'altar'),
      /* altar core: tall cover in the middle, low cover on the corners */
      [0, 0, 3.4, 3.4, 3.0, 's', 'ward'],
      [-5.2, -5.2, 2.2, 2.2, 2.6, 's', 'pillar'],
      [5.2, 5.2, 2.2, 2.2, 2.6, 's', 'pillar'],
      [5.2, -5.2, 3.6, 1.0, 1.15, 's', 'rubble'],
      [-5.2, 5.2, 3.6, 1.0, 1.15, 's', 'rubble'],
      ...mirror(half)
    ],
    spawnsA: [[-6, -25.5], [0, -26.5], [6, -25.5], [-16, -24.0], [16, -24.0]],
    spawnsB: mirrorPoints([[-6, -25.5], [0, -26.5], [6, -25.5], [-16, -24.0], [16, -24.0]]),
    ffaSpots: [[-28, -23], [28, -23], [-28, 23], [28, 23], [0, -26], [0, 26], [-21, 3], [21, -3]]
  };
}

/* =============================================================================
   2. 야시장  NIGHT MARKET
   a shuttered city street.  stall rows for close fights, a service catwalk that
   runs over the middle, and a truck lane that flanks the whole thing.
   ========================================================================== */
{
  const sx = 28, sz = 32;
  const half = [
    /* stall row lining the street */
    [-11.5, -7.0, 5.2, 2.4, 2.2, 's', 'stall'],
    [-11.5, -13.0, 5.2, 2.4, 2.2, 's', 'stall'],
    [-11.5, -19.5, 5.2, 2.4, 2.2, 's', 'stall'],
    [-15.0, -10.0, 1.2, 3.4, 1.15, 's', 'crate'],
    [-15.0, -16.5, 1.2, 3.4, 1.15, 's', 'crate'],
    /* shop fronts closing the outer lane */
    [-24.5, -14.0, 7.0, 16.0, 4.4, 's', 'block'],
    [-24.5, -25.0, 7.0, 6.0, 3.0, 's', 'block'],
    /* loading dock: crates you climb to reach the catwalk */
    [-19.5, -25.5, 3.0, 3.0, 1.2, 'f', 'crate'],
    [-19.5, -22.5, 3.0, 3.0, 2.4, 'f', 'crate'],
    [-19.5, -19.5, 3.0, 3.0, 3.6, 'f', 'crate'],
    /* catwalk: raised deck over the side lane, you can walk beneath it */
    [-19.0, -10.0, 4.0, 16.0, 0.4, 'f', 'steel', 3.6],
    [-19.0, -2.0, 4.0, 4.0, 0.4, 'f', 'steel', 3.6],
    [-17.1, -10.0, 0.2, 16.0, 1.0, 'c', 'rail', 4.0],
    /* street cover near the centre */
    [-6.0, -4.5, 3.2, 1.2, 1.15, 's', 'barrier'],
    [-8.5, -18.0, 2.6, 2.6, 2.8, 's', 'truck'],
    [-3.0, -24.0, 6.0, 2.6, 2.4, 's', 'truck']
  ];
  MAPS.market = {
    id: 'market', name: '야시장', latin: 'NIGHT MARKET', sub: '중형 · 근접 유리',
    desc: '셔터 내린 도심 상가. 좁은 노점 골목과 머리 위 정비 통로가 교차한다.',
    sx, sz, viewFar: 140,
    theme: {
      sky: 0x14161c, fog: 0x1a1d24, fogNear: 24, fogFar: 118,
      hemiSky: 0x7688a6, hemiGround: 0x2e2824, hemiI: 0.72,
      sun: 0xd2e2ff, sunI: 0.6, sunDir: [0.35, 0.78, -0.5],
      ambient: 0x38415a, ambientI: 0.58,
      ground: 0x3f4147, grid: 0x565a63, accent: 0xd8622c
    },
    mats: {
      shell: 0x1e2128, block: 0x35373d, stall: 0x5b3a30, crate: 0x4a3c29,
      steel: 0x484c55, rail: 0x5c616b, barrier: 0x6a5a34, truck: 0x3f4a52,
      pillar: 0x43464d, sign: 0xb8532a
    },
    boxes: [
      ...shell(sx, sz, 11),
      /* centre crossing: a low island with two stair sides */
      [0, 0, 11, 11, 1.0, 'f', 'block'],
      ...stair(5.5, 0, 'x', 1, 1.0, 2, 5.0, 'block'),
      ...stair(-5.5, 0, 'x', -1, 1.0, 2, 5.0, 'block'),
      [0, 0, 2.6, 2.6, 3.2, 's', 'pillar'],
      [-3.4, 3.4, 2.8, 1.0, 1.15, 's', 'barrier'],
      [3.4, -3.4, 2.8, 1.0, 1.15, 's', 'barrier'],
      [0, -7.5, 5.0, 1.2, 1.15, 's', 'barrier'],
      [0, 7.5, 5.0, 1.2, 1.15, 's', 'barrier'],
      ...mirror(half)
    ],
    spawnsA: [[-8, -28.5], [0, -29.5], [8, -28.5], [-20, -29.0], [17, -28.0]],
    spawnsB: mirrorPoints([[-8, -28.5], [0, -29.5], [8, -28.5], [-20, -29.0], [17, -28.0]]),
    ffaSpots: [[-26, -30], [26, -30], [-26, 30], [26, 30], [0, -29], [0, 29], [-12, 0], [12, 0]]
  };
}

/* =============================================================================
   3. 수몰지  SUNKEN WARD
   a drowned containment block.  the flooded floor is the low ground, dry
   walkways ring it, and two pump towers give the long sight lines.
   ========================================================================== */
{
  const sx = 27, sz = 27;
  const half = [
    /* dry ring walkway */
    [-21.0, -4.0, 8.0, 26.0, 1.1, 'f', 'deck'],
    ...stair(-16.5, -14.0, 'x', 1, 1.1, 2, 7.0, 'deck'),
    /* pump tower: two levels, stairs up the back */
    [-20.0, -19.5, 9.0, 9.0, 2.6, 'f', 'tower'],
    [-20.0, -19.5, 4.4, 4.4, 5.0, 's', 'tower'],
    ...stair(-15.0, -19.5, 'x', 1, 2.6, 4, 4.0, 'deck'),
    [-24.0, -14.6, 5.0, 1.0, 1.15, 's', 'rail'],
    /* broken partition walls in the flooded middle */
    [-9.0, -9.5, 1.2, 9.0, 3.2, 's', 'wall'],
    [-9.0, -16.0, 1.2, 3.0, 1.15, 's', 'rubble'],
    [-4.0, -19.0, 7.0, 1.2, 2.4, 's', 'wall'],
    [-12.5, -2.0, 4.0, 1.2, 1.15, 's', 'rubble'],
    /* pipes: cover you can vault, and a short high route */
    [-6.0, -6.0, 2.4, 2.4, 2.0, 'f', 'pipe'],
    [-2.5, -11.0, 2.2, 2.2, 1.2, 'f', 'pipe']
  ];
  MAPS.sunken = {
    id: 'sunken', name: '수몰지', latin: 'SUNKEN WARD', sub: '소형 · 고속 교전',
    desc: '물에 잠긴 봉인 구역. 젖은 바닥은 훤히 뚫려 있고, 마른 통로가 그 위를 감는다.',
    sx, sz, viewFar: 128,
    theme: {
      sky: 0x121a1e, fog: 0x18242a, fogNear: 20, fogFar: 106,
      hemiSky: 0x6e9dae, hemiGround: 0x293433, hemiI: 0.76,
      sun: 0xc6e4ef, sunI: 0.66, sunDir: [0.2, 0.85, 0.48],
      ambient: 0x31454e, ambientI: 0.58,
      ground: 0x364644, grid: 0x4a5e5a, accent: 0x2f9a9a,
      water: 0x1d3a3c
    },
    mats: {
      shell: 0x1c2428, deck: 0x3d4a4c, tower: 0x46514f, wall: 0x404846,
      rubble: 0x39413f, pipe: 0x55514a, rail: 0x5a6462, core: 0x2f7f86
    },
    boxes: [
      ...shell(sx, sz, 9.5),
      /* the containment core: contested high ground with two ramps */
      [0, 0, 9, 9, 2.0, 'f', 'tower'],
      ...stair(4.5, 0, 'x', 1, 2.0, 4, 4.4, 'deck'),
      ...stair(-4.5, 0, 'x', -1, 2.0, 4, 4.4, 'deck'),
      [0, 0, 2.4, 2.4, 3.4, 's', 'core'],
      [0, -3.2, 4.0, 1.0, 1.15, 's', 'rail'],
      [0, 3.2, 4.0, 1.0, 1.15, 's', 'rail'],
      ...mirror(half)
    ],
    spawnsA: [[-6, -24.0], [2, -24.5], [-14, -24.5], [10, -23.0], [-21, -25.0]],
    spawnsB: mirrorPoints([[-6, -24.0], [2, -24.5], [-14, -24.5], [10, -23.0], [-21, -25.0]]),
    ffaSpots: [[-25, -25], [25, -25], [-25, 25], [25, 25], [0, -24], [0, 24], [-23, 4], [23, -4]]
  };
}

export const MAP_LIST = Object.keys(MAPS);
export function getMap(id) { return MAPS[id] || MAPS[MAP_LIST[0]]; }
