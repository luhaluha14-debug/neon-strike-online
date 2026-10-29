// What each skin asset looks like: realistic surface finishes (colour,
// metalness, roughness) for the existing models. No geometry, no textures
// (the GLB files ship without UVs on most parts), so a skin can never change
// a model's shape, hands, animation or hit boxes.

/** One surface finish. Colours are sRGB hex. */
export interface Finish {
  color: number;
  metalness?: number;
  roughness?: number;
}

/** Weapon / knife: finishes per part role (see WEAPON_MATERIAL_ROLES). Missing roles keep the factory look. */
export interface WeaponLook {
  kind: 'weapon';
  body?: Finish;
  accent?: Finish;
  metal?: Finish;
}

/** Gloves (first-person hands). */
export interface ArmsLook {
  kind: 'arms';
  glove: Finish;
  pad: Finish;
}

/** The player's own uniform: first-person sleeves, legs and jacket. */
export interface OutfitLook {
  kind: 'outfit';
  sleeve: Finish;
  cuff: Finish;
  pants: Finish;
  jacket: Finish;
  gear: Finish;
  boot: Finish;
}

export type SkinLook = WeaponLook | ArmsLook | OutfitLook;

/**
 * Which file materials of each weapon model a weapon look recolours, by role.
 * Names are the materials inside the GLB files (public/weapons). Materials not
 * listed (glass, rubber, edge highlights) always keep their look.
 */
export const WEAPON_MATERIAL_ROLES: Record<string, Partial<Record<'body' | 'accent' | 'metal', readonly string[]>>> = {
  ar01: { body: ['M4_Polymer', 'M4_RailCover', 'M4_Gunmetal'], accent: ['M4_Magazine'], metal: ['M4_Barrel', 'M4_Steel'] },
  sr01: { body: ['Stock_Olive'], accent: ['Parkerized_Black', 'Scope_Anodized'], metal: ['Barrel_Bronze', 'Bare_Steel'] },
  smg01: { body: ['SMG_Polymer'], accent: ['SMG_Metal'], metal: ['SMG_Barrel'] },
  sg01: { body: ['SMG_Polymer'], accent: ['SMG_Metal'], metal: ['SMG_Barrel'] },
  pis01: { body: ['SMG_Polymer'], accent: ['SMG_Metal'], metal: ['SMG_Barrel'] },
  karambit: { body: ['Grip_DarkRubber'], accent: ['Guard_DarkMetal'], metal: ['Blade_DarkSteel', 'Blade_GrindSteel'] },
};

const cerakote = (color: number): Finish => ({ color, metalness: 0.15, roughness: 0.62 });
const polymer = (color: number): Finish => ({ color, metalness: 0.0, roughness: 0.72 });
const steel = (color: number, roughness = 0.4): Finish => ({ color, metalness: 0.85, roughness });
const fabric = (color: number): Finish => ({ color, roughness: 0.92 });

export const SKIN_LOOKS: Record<string, SkinLook> = {
  // AR-01
  'finish:ar01.fde': { kind: 'weapon', body: cerakote(0x8a7553), accent: polymer(0x2a2622) },
  'finish:ar01.ranger': { kind: 'weapon', body: cerakote(0x4a5240), accent: polymer(0x1c1d1b) },
  'finish:ar01.tungsten': { kind: 'weapon', body: cerakote(0x45484b), accent: polymer(0x151617) },
  'finish:ar01.urban': { kind: 'weapon', body: cerakote(0x575b5e), accent: polymer(0x101112), metal: steel(0x2a2c2e, 0.5) },
  // SR-01
  'finish:sr01.olive': { kind: 'weapon', body: polymer(0x4b4f36), accent: cerakote(0x1d1e1c) },
  'finish:sr01.winter': { kind: 'weapon', body: polymer(0xd9dbd6), accent: cerakote(0x6b6e70), metal: steel(0x8d9194, 0.45) },
  'finish:sr01.walnut': { kind: 'weapon', body: { color: 0x5a3a24, metalness: 0, roughness: 0.55 }, accent: steel(0x1b1e24, 0.35), metal: steel(0x1f2228, 0.3) },
  // SMG-01 / SG-01 / PIS-01
  'finish:smg01.fde': { kind: 'weapon', body: polymer(0x8a7553), accent: cerakote(0x1a1b1d) },
  'finish:smg01.gray': { kind: 'weapon', body: polymer(0x5f6164), accent: cerakote(0x26282a) },
  'finish:sg01.od': { kind: 'weapon', body: polymer(0x4b4f36), accent: cerakote(0x1a1b1d) },
  'finish:sg01.patina': { kind: 'weapon', body: polymer(0x1a1b1d), accent: steel(0x6e5a3a, 0.5) },
  'finish:pis01.fde': { kind: 'weapon', body: polymer(0x8a7553), accent: cerakote(0x1a1b1d) },
  'finish:pis01.two_tone': { kind: 'weapon', body: polymer(0x161718), accent: steel(0x9da1a5, 0.35) },
  // Knife
  'finish:karambit.satin': { kind: 'weapon', body: polymer(0x55585c), metal: steel(0xa9adb2, 0.3) },
  'finish:karambit.oxide': { kind: 'weapon', body: polymer(0x4b4f36), metal: steel(0x202224, 0.55), accent: cerakote(0x1a1b1d) },
  'finish:karambit.bronze': { kind: 'weapon', body: polymer(0x7a6448), accent: steel(0x8b6a3e, 0.4) },
  // Gloves
  'arms:gloves.coyote': { kind: 'arms', glove: { color: 0x6f5a42, roughness: 0.78 }, pad: { color: 0x8a7553, roughness: 0.55 } },
  'arms:gloves.ranger': { kind: 'arms', glove: { color: 0x434a3a, roughness: 0.78 }, pad: { color: 0x1f2022, roughness: 0.55 } },
  'arms:gloves.winter': { kind: 'arms', glove: { color: 0x9a9d9f, roughness: 0.8 }, pad: { color: 0x2a2b2d, roughness: 0.55 } },
  'arms:gloves.leather': { kind: 'arms', glove: { color: 0x1d1e20, roughness: 0.7 }, pad: { color: 0x5c3f2a, roughness: 0.6 } },
  // Characters
  'outfit:character.urban': { kind: 'outfit', sleeve: fabric(0x5b5f63), cuff: fabric(0x3a3d40), pants: fabric(0x5b5f63), jacket: fabric(0x4c4f53), gear: fabric(0x2c2e30), boot: fabric(0x26272a) },
  'outfit:character.arid': { kind: 'outfit', sleeve: fabric(0x8a7a5c), cuff: fabric(0x6f5a42), pants: fabric(0x8a7a5c), jacket: fabric(0x7a6c52), gear: fabric(0x6f5a42), boot: fabric(0x5a4632) },
  'outfit:character.navy': { kind: 'outfit', sleeve: fabric(0x2c3442), cuff: fabric(0x1d2330), pants: fabric(0x2c3442), jacket: fabric(0x252c38), gear: fabric(0x1d1f22), boot: fabric(0x1a1b1d) },
  'outfit:character.winter': { kind: 'outfit', sleeve: fabric(0xc9ccc8), cuff: fabric(0x8d9092), pants: fabric(0xc9ccc8), jacket: fabric(0xb8bbb7), gear: fabric(0x6b6e70), boot: fabric(0x4a4c4e) },
};

/** The look of an asset of the expected kind, or null (unknown / default / failed asset → the factory look). */
export function lookOf<K extends SkinLook['kind']>(assetId: string | undefined, kind: K): Extract<SkinLook, { kind: K }> | null {
  const look = assetId ? SKIN_LOOKS[assetId] : undefined;
  return look && look.kind === kind ? (look as Extract<SkinLook, { kind: K }>) : null;
}
