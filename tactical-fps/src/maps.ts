// Map registry. Each Blender map gets one entry describing how its nodes are
// classified by name prefix. Add a map: drop the GLB in public/maps/ and add
// an entry here; it then appears in the start screen map selector.

export interface MapEnvironment {
  fogNear: number;
  fogFar: number;
  /** Camera far plane (m). Large maps with distant scenery need more. */
  viewDistance: number;
}

export interface MapDefinition {
  id: string;
  /** Shown in the map selector. */
  name: string;
  /** Path relative to the Vite `public/` folder. */
  url: string;

  /** Template/helper objects (instancing sources, default cube): hidden and never collide. */
  hiddenPrefixes: readonly string[];
  /** Visible but not solid: decals, scatter, cables, signage, distant scenery. */
  nonCollidingPrefixes: readonly string[];
  /**
   * Invisible player-clip walls: block movement but not bullets and are not
   * rendered. Their combined box also defines the playable area (shadows).
   */
  playerClipPrefixes: readonly string[];
  /** Gameplay volume markers (spawn / plant areas): hidden by default, shown with F3. */
  zoneMarkerPrefix: string;
  attackSpawnPrefix: string;
  defenseSpawnPrefix: string;

  /** Anything that falls below this height is respawned. */
  killPlaneY: number;
  environment: MapEnvironment;
}

export const MAPS: readonly MapDefinition[] = [
  {
    id: 'seoul',
    name: 'MAP 02 · 서울',
    url: '/maps/seoul.glb',
    // TPL_/CG_TPL are instancing sources parked at the origin (on the bridge).
    hiddenPrefixes: ['TPL_', 'CG_TPL', 'Cube'],
    nonCollidingPrefixes: [
      // Distant scenery outside the boundary walls.
      'Backdrop_',
      'Facade_Backdrop_',
      'Far_',
      'Skyline_',
      'Mountain_',
      'Namsan_Backdrop',
      // Soft vegetation along the stream: visible, but walk/shoot through it.
      'Cheonggye_Reeds',
      'Tree_Weeping',
      // Flat paint / decals.
      'Road_Markings',
      'BombSite_A_Ground_',
      'BombSite_B_Ground_',
    ],
    playerClipPrefixes: ['Boundary_'],
    zoneMarkerPrefix: 'Zone_',
    attackSpawnPrefix: 'ATK_SpawnPoint_',
    defenseSpawnPrefix: 'DEF_SpawnPoint_',
    killPlaneY: -20,
    environment: { fogNear: 120, fogFar: 650, viewDistance: 900 },
  },
  {
    id: 'warehouse',
    name: 'MAP 01 · 창고 지구',
    url: '/maps/Untitled.glb',
    hiddenPrefixes: ['Tpl_', 'Cube'],
    nonCollidingPrefixes: [
      'Ground_Pebble_',
      'Ground_Dirt_',
      'Ground_Joints_',
      'Ground_WallBase_',
      'Deco_Cables_',
      'Deco_Manholes',
      'Sign_Letter_',
      'Bldg_Site_Sign_Boards',
    ],
    playerClipPrefixes: [],
    zoneMarkerPrefix: 'Zone_',
    attackSpawnPrefix: 'ATK_SpawnPoint_',
    defenseSpawnPrefix: 'DEF_SpawnPoint_',
    killPlaneY: -20,
    environment: { fogNear: 60, fogFar: 180, viewDistance: 400 },
  },
];

export const DEFAULT_MAP_ID = MAPS[0].id;

export function findMap(id: string | null | undefined): MapDefinition {
  return MAPS.find((m) => m.id === id) ?? MAPS.find((m) => m.id === DEFAULT_MAP_ID)!;
}
