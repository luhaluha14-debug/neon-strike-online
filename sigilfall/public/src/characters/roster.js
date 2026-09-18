/* =============================================================================
   the roster.  every character is plain data; the combat runtime reads these
   fields and never needs to know which character it is running.  adding a new
   fighter means adding an entry here plus, at most, one behaviour hook in
   combat/abilityKinds.js.

   slots      lmb  primary        rmb  secondary
              q    movement       a1   sorcery        a2   heavy sorcery
              ult  domain (E)

   kinds      projectile | hitscan | melee | dash | blink | zone | buff
              summon | parry | ads | charge | domain
   ========================================================================== */

/* loadout: one charm per character.  they are small, readable trades, never a
   second set of abilities, and the four fields below are the only things any
   charm may touch - the server applies the same numbers. */
export const CHARMS = {
  none: {
    id: 'none', name: '무각', latin: 'PLAIN', icon: '○',
    desc: '보정 없음. 기본 수치 그대로 싸운다.', mods: {}
  },
  swift: {
    id: 'swift', name: '질주 부적', latin: 'SWIFT', icon: '⋙',
    desc: '이동 속도 +6%, 이동기(Q) 쿨다운 -1초.',
    mods: { speed: 1.06, cdQ: -1 }
  },
  vigor: {
    id: 'vigor', name: '항력 부적', latin: 'VIGOR', icon: '❰',
    desc: '최대 체력 +12%, 받는 피해 -4%.',
    mods: { hp: 1.12, taken: 0.96 }
  },
  flux: {
    id: 'flux', name: '순환 부적', latin: 'FLUX', icon: '∿',
    desc: '주력 회복 +30%, 술식 쿨다운 -8%.',
    mods: { regen: 1.3, cdMul: 0.92 }
  },
  rite: {
    id: 'rite', name: '의식 부적', latin: 'RITE', icon: '✦',
    desc: '궁극기 충전 +18%, 영역 지속 +0.8초.',
    mods: { ultGain: 1.18, domainDur: 0.8 }
  }
};
export const CHARM_LIST = Object.keys(CHARMS);
export function getCharm(id) { return CHARMS[id] || CHARMS.none; }

export const ENERGY_REFOCUS = { dur: 0.85, cd: 1.1, name: '재집중', latin: 'REFOCUS' };

export const CHARACTERS = {

  /* ------------------------------------------------------------------ RIFT */
  rift: {
    id: 'rift', name: '하란', latin: 'RIFT', role: '공간 조작',
    blurb: '공간을 접어 거리를 지운다. 사거리를 무시하고 파고드는 사냥꾼.',
    hp: 180, speed: 6.7, accel: 62, airAccel: 15, radius: 0.42, jump: 7.6,
    color: 0x5f6bc4, accent: 0xa9b6ff, trim: 0x2b3060,
    energy: { max: 100, regen: 17, delay: 0.55 },
    difficulty: 2,

    primary: {
      id: 'shard', icon: '✧', name: '공간 파편', latin: 'SPACE SHARD', kind: 'projectile',
      dmg: 26, head: 1.7, rpm: 250, cost: 8, speed: 74, range: 92, radius: 0.3,
      splash: { radius: 1.6, dmg: 9 }, falloff: [48, 84, 0.72], gravity: 0,
      color: 0x9fb0ff, spread: 0.008, desc: '접힌 공간 조각을 쏜다. 착탄 시 작게 터진다.'
    },
    secondary: {
      id: 'condense', icon: '◉', name: '응축', latin: 'CONDENSE', kind: 'charge',
      dmg: 42, dmgMax: 96, head: 1.6, chargeTime: 0.95, cost: 24, speed: 118,
      range: 120, radius: 0.34, pierce: 3, cd: 0.35, color: 0xc9d4ff,
      desc: '누르는 동안 압축, 놓으면 관통탄. 오래 모을수록 강하다.'
    },
    q: {
      id: 'shortcut', icon: '⇥', name: '단락 도약', latin: 'SHORTCUT', kind: 'blink',
      cd: 7, dist: 8.5, iframe: 0.18, cost: 0, color: 0xa9b6ff,
      desc: '조준 방향 8.5m 앞으로 즉시 이동. 도약 직후 짧게 무적.'
    },
    a1: {
      id: 'lure', icon: '◎', name: '인력 결계', latin: 'LURE WELL', kind: 'zone',
      cd: 9, dmg: 18, tickDmg: 0, radius: 6.2, dur: 1.5, speed: 34, range: 40,
      pull: 13, color: 0x7a86e0, castTime: 0.12,
      desc: '착탄 지점으로 적을 1.5초간 끌어당긴다.'
    },
    a2: {
      id: 'cleave', icon: '⟋', name: '공간 절단', latin: 'RIFT CLEAVE', kind: 'hitscan',
      cd: 11, dmg: 72, head: 1.3, range: 24, width: 1.3, pierce: 99,
      castTime: 0.18, recover: 0.22, color: 0xd6dcff,
      desc: '전방 24m를 한 번에 갈라 모든 적을 관통한다.'
    },
    ult: {
      id: 'collapse', icon: '◈', name: '함몰 좌표', latin: 'COLLAPSE FIELD', kind: 'domain',
      castTime: 0.55, radius: 15, dur: 7, follow: false, color: 0x6a5bd0,
      inside: { enemySlow: 0.68, enemyTick: 9, ownCdRate: 2.0, ownDmgMul: 1.2 },
      finish: { dmg: 62, radius: 15 },
      desc: '영역 안의 적은 느려지고 계속 무너진다. 끝날 때 중심으로 함몰 폭발.'
    }
  },

  /* ----------------------------------------------------------------- BRAND */
  brand: {
    id: 'brand', name: '서결', latin: 'BRAND', role: '저주 근접',
    blurb: '맞을수록 뜨거워지는 주먹. 붙으면 놓지 않는다.',
    hp: 235, speed: 7.5, accel: 74, airAccel: 17, radius: 0.44, jump: 8.0,
    color: 0xb2482e, accent: 0xff9a5c, trim: 0x4a1d13,
    energy: { max: 100, regen: 26, delay: 0.35 },
    difficulty: 1,

    primary: {
      id: 'lash', icon: '✊', name: '저주 연격', latin: 'CURSE LASH', kind: 'melee',
      dmg: 33, head: 1.25, rpm: 190, cost: 0, range: 3.1, arc: 0.78,
      comboEvery: 3, comboMul: 1.6, stackGain: 1, color: 0xff8a4a,
      desc: '짧은 부채꼴 강타. 3연타마다 강화 타격이 나가고 각인이 쌓인다.'
    },
    secondary: {
      id: 'counter', icon: '⊘', name: '반격 자세', latin: 'COUNTER', kind: 'parry',
      window: 0.42, cd: 5.5, refund: 3.2, dmg: 46, range: 3.6, stackGain: 2,
      color: 0xffc06a,
      desc: '0.42초간 정면 피해를 막는다. 막아내면 즉시 반격하고 각인 2개.'
    },
    q: {
      id: 'surge', icon: '➤', name: '쇄도', latin: 'SURGE', kind: 'dash',
      cd: 6, dist: 12, speed: 26, dmg: 42, radius: 1.8, knock: 9,
      cost: 0, color: 0xff7a3c,
      desc: '전방으로 돌진하며 닿는 적을 밀어낸다.'
    },
    a1: {
      id: 'burst', icon: '✶', name: '충격 각인', latin: 'BRAND BURST', kind: 'hitscan',
      cd: 8, dmg: 52, head: 1.1, range: 8, width: 3.2, pierce: 99,
      castTime: 0.14, recover: 0.2, slow: { mul: 0.72, dur: 1.4 }, color: 0xff6a2c,
      desc: '전방 8m를 각인으로 찍어누른다. 맞은 적은 잠시 느려진다.'
    },
    a2: {
      id: 'focus', icon: '❖', name: '집속', latin: 'FOCUS', kind: 'buff',
      cd: 12, dur: 2.6, color: 0xffd08a,
      buff: { meleeMul: 2.2, lifesteal: 0.3, consumeOnHit: true },
      desc: '2.6초 안의 첫 근접 타격이 2.2배가 되고 피해량만큼 회복한다.'
    },
    ult: {
      id: 'clash', icon: '⬢', name: '격돌 영역', latin: 'CLASH DOMAIN', kind: 'domain',
      castTime: 0.45, radius: 11.5, dur: 6.5, follow: true, color: 0xd1502a,
      inside: { enemySlow: 0.8, ownSpeedMul: 1.2, ownMeleeMul: 1.55, lifesteal: 0.3, revealEnemies: true },
      finish: { dmg: 40, radius: 11.5 },
      desc: '자신을 따라다니는 투기장. 안에서는 근접이 훨씬 아프고 피를 빤다.'
    }
  },

  /* ---------------------------------------------------------------- WARDEN */
  warden: {
    id: 'warden', name: '무이', latin: 'WARDEN', role: '사역 소환',
    blurb: '혼자 싸우지 않는다. 표식을 찍고 사역물을 풀어 놓는다.',
    hp: 195, speed: 6.4, accel: 58, airAccel: 14, radius: 0.42, jump: 7.4,
    color: 0x3f7f6a, accent: 0x7fe0b4, trim: 0x17352c,
    energy: { max: 100, regen: 19, delay: 0.5 },
    difficulty: 3,

    primary: {
      id: 'spiritshot', icon: '✺', name: '주령탄', latin: 'SPIRIT SHOT', kind: 'projectile',
      dmg: 21, head: 1.8, rpm: 330, cost: 6, speed: 62, range: 80, radius: 0.26,
      falloff: [40, 74, 0.7], homing: 2.6, homingMarked: 7.5, color: 0x7fe0b4,
      spread: 0.012, desc: '느슨하게 유도되는 주령 탄환. 표식이 찍힌 적에게 강하게 휜다.'
    },
    secondary: {
      id: 'mark', icon: '⌖', name: '표식', latin: 'SIGIL MARK', kind: 'hitscan',
      dmg: 12, head: 1.0, range: 70, width: 0.9, cd: 1.9, pierce: 1,
      mark: { dur: 5.5, dmgTaken: 1.14, reveal: true }, color: 0xb6ffe2,
      desc: '적에게 표식. 표식 대상은 받는 피해가 늘고 아군에게 위치가 보인다.'
    },
    q: {
      id: 'shade', icon: '≡', name: '잔영 보', latin: 'SHADE STEP', kind: 'dash',
      cd: 7, dist: 9.5, speed: 22, dmg: 0, decoy: { hp: 40, dur: 3.2 }, color: 0x9ff0cc,
      desc: '미끄러지듯 이동하며 잔영을 남긴다. 잔영은 적의 주의를 끈다.'
    },
    a1: {
      id: 'hound', icon: '⌁', name: '사냥개 소환', latin: 'HOUND', kind: 'summon',
      cd: 10, count: 1, summon: { hp: 95, speed: 9.2, dmg: 17, rate: 0.75, dur: 13, range: 2.2 },
      color: 0x64c8a2, castTime: 0.2,
      desc: '가장 가까운 적을 물어뜯는 사역물을 푼다. 표식 대상을 우선한다.'
    },
    a2: {
      id: 'stake', icon: '⊗', name: '결계 말뚝', latin: 'WARD STAKE', kind: 'zone',
      cd: 13, dmg: 14, tickDmg: 13, radius: 5.2, dur: 6, speed: 40, range: 45,
      slow: { mul: 0.76 }, color: 0x4fb98f, castTime: 0.12,
      desc: '결계를 박아 6초간 지역을 봉쇄한다. 안의 적은 느려지고 계속 닳는다.'
    },
    ult: {
      id: 'legion', icon: '⁂', name: '군세 영역', latin: 'LEGION DOMAIN', kind: 'domain',
      castTime: 0.6, radius: 14, dur: 7, follow: false, color: 0x2f9f7c,
      inside: { enemyTick: 5, enemyEnergyLock: true, ownRateMul: 1.25, summonBoost: 1.35 },
      spawn: { count: 3, hp: 70, speed: 8.6, dmg: 13, rate: 0.7, dur: 7, range: 2.2 },
      finish: { dmg: 30, radius: 14 },
      desc: '영역에 사역물 셋이 풀린다. 안의 적은 주력을 회복하지 못한다.'
    }
  },

  /* ------------------------------------------------------------------ VEIN */
  vein: {
    id: 'vein', name: '연하', latin: 'VEIN', role: '혈술 저격',
    blurb: '자기 피를 태워 쏜다. 거리를 두면 가장 위험하다.',
    hp: 170, speed: 6.9, accel: 60, airAccel: 15, radius: 0.41, jump: 7.6,
    color: 0x8f2b42, accent: 0xff6b84, trim: 0x3a0f1c,
    energy: { max: 100, regen: 15, delay: 0.6 },
    difficulty: 2,

    primary: {
      id: 'bolt', icon: '➹', name: '혈탄', latin: 'BLOOD BOLT', kind: 'projectile',
      dmg: 31, head: 2.0, rpm: 155, cost: 10, speed: 112, range: 110, radius: 0.24,
      pierce: 1, falloff: [60, 100, 0.85], color: 0xff6b84, spread: 0.004,
      desc: '빠르고 곧게 나가는 혈탄. 한 명을 관통한다.'
    },
    secondary: {
      id: 'sight', icon: '◎', name: '정밀 조준', latin: 'BLOOD SIGHT', kind: 'ads',
      zoom: 1.75, dmgMul: 1.3, moveMul: 0.62, spreadMul: 0.25, color: 0xff9aae,
      desc: '숨을 죽이고 조준한다. 피해가 오르고 탄이 흔들리지 않는다.'
    },
    q: {
      id: 'bloodstep', icon: '⇝', name: '혈보', latin: 'BLOOD STEP', kind: 'dash',
      cd: 5, dist: 10.5, speed: 24, hpCost: 12, refund: { hp: 26, window: 3.2 },
      color: 0xff7d92,
      desc: '체력을 태워 미끄러진다. 3.2초 안에 적중하면 더 많이 돌려받는다.'
    },
    a1: {
      id: 'lance', icon: '↟', name: '관통 창', latin: 'CRIMSON LANCE', kind: 'hitscan',
      cd: 8, dmg: 76, head: 1.35, range: 60, width: 0.85, pierce: 99, hpCost: 14,
      castTime: 0.16, recover: 0.24, color: 0xff4f6e,
      desc: '체력을 대가로 직선을 꿰뚫는 혈창을 던진다.'
    },
    a2: {
      id: 'rain', icon: '❉', name: '혈우', latin: 'BLOOD RAIN', kind: 'zone',
      cd: 12, dmg: 22, tickDmg: 17, radius: 6, dur: 4.5, speed: 26, range: 42,
      gravity: 16, drain: 0.32, color: 0xd84a66, castTime: 0.15,
      desc: '머리 위로 피를 흩뿌린다. 그 아래에서 입힌 피해의 일부를 회복한다.'
    },
    ult: {
      id: 'scarlet', icon: '✜', name: '적하 영역', latin: 'SCARLET DOMAIN', kind: 'domain',
      castTime: 0.5, radius: 13, dur: 7, follow: false, color: 0xb02744,
      inside: { enemyTick: 12, ownLifesteal: 0.45, ownPierce: true, lanceCd: 3, lanceFree: true },
      finish: { dmg: 45, radius: 13 },
      desc: '영역 안의 적은 계속 피를 흘리고, 그 피가 전부 시전자에게 돌아온다.'
    }
  }
};

export const CHARACTER_LIST = Object.keys(CHARACTERS);
export function getCharacter(id) { return CHARACTERS[id] || CHARACTERS[CHARACTER_LIST[0]]; }

/* every ability of a character in slot order, for HUD and cooldown bookkeeping */
export const ABILITY_SLOTS = ['q', 'a1', 'a2', 'ult'];
export function abilityOf(charId, slot) {
  const c = getCharacter(charId);
  return slot === 'lmb' ? c.primary : slot === 'rmb' ? c.secondary : c[slot];
}
