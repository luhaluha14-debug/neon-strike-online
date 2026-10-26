import { RARITIES, SKIN_CATEGORIES, type SkinCategory, type SkinDef } from './types';

// GRID skin catalog: every product the shop can show. Prices and names live
// here and nowhere else (the shop and the purchase check read them from the
// catalog; a client request never carries a price). Looks are realistic
// finishes (cerakote, anodizing, parkerizing, fabric colours) keyed by
// `assetId` in skins/SkinLooks.ts.

/** Weapons a weapon skin may target (ids from weapons/weapons.ts). */
export const SKIN_WEAPON_TARGETS = ['ar01', 'sr01', 'smg01', 'sg01', 'pis01'] as const;
/** The knife's weapon id. */
export const KNIFE_TARGET = 'karambit';
/** Gloves and characters belong to the player. */
export const PLAYER_TARGET = 'player';

/** Display name of a target. */
export const TARGET_NAME: Record<string, string> = {
  ar01: 'AR-01',
  sr01: 'SR-01',
  smg01: 'SMG-01',
  sg01: 'SG-01',
  pis01: 'PIS-01',
  karambit: 'M9 총검',
  player: '플레이어',
};

function weapon(skinId: string, target: string, name: string, description: string, price: number, rarity: SkinDef['rarity'], preview: number[]): SkinDef {
  return { skinId, name, description, category: 'weapon', targets: [target], price, rarity, assetId: `finish:${skinId}`, preview, onSale: true, isDefault: false, tradable: true };
}

function factory(category: SkinCategory, target: string, name: string, preview: number[]): SkinDef {
  return {
    // Player slots share the target, so their ids carry the category (gloves.default, character.default).
    skinId: target === PLAYER_TARGET ? `${category}.default` : `${target}.default`,
    name,
    description: '기본 지급 외형입니다.',
    category,
    targets: [target],
    price: 0,
    rarity: 'standard',
    assetId: 'default',
    preview,
    onSale: false,
    isDefault: true,
    tradable: false,
  };
}

export const SKIN_CATALOG: readonly SkinDef[] = [
  // Default looks (always available, not sold).
  factory('weapon', 'ar01', 'AR-01 기본', [0x1a1b1d, 0x5a5c60]),
  factory('weapon', 'sr01', 'SR-01 기본', [0x1a1b1d, 0xd8d8d0]),
  factory('weapon', 'smg01', 'SMG-01 기본', [0x1d1e20, 0x2a2b2d]),
  factory('weapon', 'sg01', 'SG-01 기본', [0x1d1e20, 0x2a2b2d]),
  factory('weapon', 'pis01', 'PIS-01 기본', [0x1d1e20, 0x2a2b2d]),
  factory('knife', KNIFE_TARGET, 'M9 총검 기본', [0x1d1e20, 0xb7bcc2]),
  factory('gloves', PLAYER_TARGET, '전술 장갑 기본', [0x1f2022, 0x34363a]),
  factory('character', PLAYER_TARGET, '전투복 기본', [0x3b3f34, 0x575c4a]),

  // AR-01
  weapon('ar01.fde', 'ar01', 'FDE 세라코트', '사막 지형용 플랫 다크 어스 세라코트. 총열과 금속 부품은 원래 색.', 400, 'common', [0x8a7553, 0x1a1b1d]),
  weapon('ar01.ranger', 'ar01', '레인저 그린', '숲 지형용 레인저 그린 세라코트 투톤.', 400, 'common', [0x4a5240, 0x1a1b1d]),
  weapon('ar01.tungsten', 'ar01', '텅스텐 그레이', '도심용 무광 텅스텐 그레이 세라코트, 탄창은 검정.', 650, 'uncommon', [0x5c5f62, 0x151617]),
  weapon('ar01.urban', 'ar01', '어반 투톤', '스나이퍼 그레이 몸체와 검정 레일 커버.', 900, 'rare', [0x7d8184, 0x101112]),
  // SR-01
  weapon('sr01.olive', 'sr01', 'OD 그린 스톡', '올리브 드랩 스톡과 파커라이징 강철.', 500, 'common', [0x4b4f36, 0x1a1b1d]),
  weapon('sr01.winter', 'sr01', '윈터 화이트', '설원 위장용 흰색 스톡과 회색 강철.', 900, 'rare', [0xd9dbd6, 0x6b6e70]),
  weapon('sr01.walnut', 'sr01', '월넛 스톡', '어두운 호두나무 색 스톡과 블루드 스틸.', 1200, 'epic', [0x5a3a24, 0x1b1e24]),
  // SMG-01 / SG-01 / PIS-01
  weapon('smg01.fde', 'smg01', 'FDE 폴리머', '사막색 폴리머와 검정 금속.', 350, 'common', [0x8a7553, 0x1a1b1d]),
  weapon('smg01.gray', 'smg01', '울프 그레이', '회색 폴리머와 건메탈.', 550, 'uncommon', [0x5f6164, 0x26282a]),
  weapon('sg01.od', 'sg01', 'OD 그린', '올리브 폴리머 부품과 검정 리시버.', 350, 'common', [0x4b4f36, 0x1a1b1d]),
  weapon('sg01.patina', 'sg01', '브론즈 파티나', '청동빛 리시버와 검정 폴리머.', 750, 'rare', [0x6e5a3a, 0x1a1b1d]),
  weapon('pis01.fde', 'pis01', 'FDE 프레임', '사막색 프레임과 검정 슬라이드.', 250, 'common', [0x8a7553, 0x1a1b1d]),
  weapon('pis01.two_tone', 'pis01', '스테인리스 투톤', '무광 스테인리스 슬라이드와 검정 프레임.', 600, 'uncommon', [0x9da1a5, 0x161718]),

  // Knife (M9 총검)
  {
    skinId: 'karambit.satin',
    name: '새틴 스틸',
    description: '새틴 마감 칼날과 회색 손잡이.',
    category: 'knife',
    targets: [KNIFE_TARGET],
    price: 700,
    rarity: 'uncommon',
    assetId: 'finish:karambit.satin',
    preview: [0xa9adb2, 0x55585c],
    onSale: true,
    isDefault: false,
    tradable: true,
  },
  {
    skinId: 'karambit.oxide',
    name: '블랙 옥사이드',
    description: '흑착색 칼날과 OD 그린 손잡이.',
    category: 'knife',
    targets: [KNIFE_TARGET],
    price: 950,
    rarity: 'rare',
    assetId: 'finish:karambit.oxide',
    preview: [0x202224, 0x4b4f36],
    onSale: true,
    isDefault: false,
    tradable: true,
  },
  {
    skinId: 'karambit.bronze',
    name: '브론즈 가드',
    description: '청동 가드와 코요테 브라운 손잡이.',
    category: 'knife',
    targets: [KNIFE_TARGET],
    price: 1400,
    rarity: 'epic',
    assetId: 'finish:karambit.bronze',
    preview: [0x8b6a3e, 0x7a6448],
    onSale: true,
    isDefault: false,
    tradable: true,
  },

  // Gloves
  ...(
    [
      ['gloves.coyote', '코요테 브라운', '코요테 브라운 셸과 탄 패드.', 300, 'common', [0x6f5a42, 0x8a7553]],
      ['gloves.ranger', '레인저 그린', '레인저 그린 셸과 검정 패드.', 300, 'common', [0x434a3a, 0x1f2022]],
      ['gloves.winter', '윈터 그레이', '밝은 회색 셸과 검정 패드(설원용).', 550, 'uncommon', [0x9a9d9f, 0x2a2b2d]],
      ['gloves.leather', '레더 브라운', '갈색 가죽 손바닥과 검정 셸.', 800, 'rare', [0x1d1e20, 0x5c3f2a]],
    ] as const
  ).map(
    ([skinId, name, description, price, rarity, preview]): SkinDef => ({
      skinId,
      name,
      description,
      category: 'gloves',
      targets: [PLAYER_TARGET],
      price,
      rarity,
      assetId: `arms:${skinId}`,
      preview,
      onSale: true,
      isDefault: false,
      tradable: true,
    }),
  ),

  // Characters (the player's own uniform: sleeves in first person, legs and jacket)
  ...(
    [
      ['character.urban', '어반 그레이', '도심용 회색 전투복과 검정 장비.', 600, 'uncommon', [0x5b5f63, 0x2c2e30]],
      ['character.arid', '아리드 탄', '건조 지형용 탄 전투복과 코요테 장비.', 600, 'uncommon', [0x8a7a5c, 0x6f5a42]],
      ['character.navy', '네이비 택티컬', '진청색 전술복과 검정 장비.', 900, 'rare', [0x2c3442, 0x1d1f22]],
      ['character.winter', '윈터 오버화이트', '설원용 밝은 회백색 덧옷과 회색 장비.', 1300, 'epic', [0xc9ccc8, 0x6b6e70]],
    ] as const
  ).map(
    ([skinId, name, description, price, rarity, preview]): SkinDef => ({
      skinId,
      name,
      description,
      category: 'character',
      targets: [PLAYER_TARGET],
      price,
      rarity,
      assetId: `outfit:${skinId}`,
      preview,
      onSale: true,
      isDefault: false,
      tradable: true,
    }),
  ),
];

const BY_ID = new Map(SKIN_CATALOG.map((s) => [s.skinId, s]));

export function findSkin(skinId: string): SkinDef | undefined {
  return BY_ID.get(skinId);
}

/** Loadout slot of a category + target (`weapon:ar01`, `gloves:player`, …). */
export function slotKey(category: SkinCategory, target: string): string {
  return `${category}:${target}`;
}

/** Every slot the loadout can hold. */
export function allSlots(catalog: readonly SkinDef[] = SKIN_CATALOG): string[] {
  return [...new Set(catalog.filter((s) => s.isDefault).flatMap((s) => s.targets.map((t) => slotKey(s.category, t))))];
}

/** The default skin of a slot. */
export function defaultSkin(category: SkinCategory, target: string, catalog: readonly SkinDef[] = SKIN_CATALOG): SkinDef | undefined {
  return catalog.find((s) => s.isDefault && s.category === category && s.targets.includes(target));
}

/**
 * Checks a catalog: unique ids, whole non-negative prices, known category /
 * rarity / targets, defaults free and not sold, one default per slot.
 * Returns the problems found (empty = valid).
 */
export function validateCatalog(catalog: readonly SkinDef[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const defaults = new Set<string>();
  const known: Record<SkinCategory, readonly string[]> = {
    weapon: SKIN_WEAPON_TARGETS,
    knife: [KNIFE_TARGET],
    gloves: [PLAYER_TARGET],
    character: [PLAYER_TARGET],
  };
  for (const s of catalog) {
    if (!s.skinId || ids.has(s.skinId)) problems.push(`duplicate or empty id: ${s.skinId}`);
    ids.add(s.skinId);
    if (!SKIN_CATEGORIES.includes(s.category)) problems.push(`${s.skinId}: unknown category ${s.category}`);
    if (!RARITIES.includes(s.rarity)) problems.push(`${s.skinId}: unknown rarity ${s.rarity}`);
    if (!Number.isInteger(s.price) || s.price < 0) problems.push(`${s.skinId}: invalid price ${s.price}`);
    if (s.targets.length === 0 || s.targets.some((t) => !known[s.category]?.includes(t))) problems.push(`${s.skinId}: invalid targets ${s.targets.join(',')}`);
    if (!s.name || !s.assetId) problems.push(`${s.skinId}: missing name or asset`);
    if (s.isDefault) {
      if (s.price !== 0 || s.onSale || s.tradable) problems.push(`${s.skinId}: a default skin must be free, not sold, not tradable`);
      for (const t of s.targets) {
        const slot = slotKey(s.category, t);
        if (defaults.has(slot)) problems.push(`${s.skinId}: second default for ${slot}`);
        defaults.add(slot);
      }
    }
  }
  return problems;
}
