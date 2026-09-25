/* =========================================================================
   Persistent settings (localStorage) + graphics presets + key bindings.
   ========================================================================= */

const KEY = 'dropzone.settings.v1';

export const ACTIONS = [
  ['forward', '앞으로'], ['back', '뒤로'], ['left', '왼쪽'], ['right', '오른쪽'],
  ['sprint', '달리기'], ['walk', '걷기'], ['jump', '점프'], ['crouch', '앉기'], ['prone', '엎드리기'],
  ['fire', '발사'], ['ads', '조준'], ['reload', '재장전'], ['interact', '줍기 / 상호작용'],
  ['slot1', '무기 1'], ['slot2', '무기 2'], ['slot3', '보조무기'], ['slot4', '근접'], ['slot5', '투척물(예정)'],
  ['heal', '빠른 회복'], ['inventory', '인벤토리'], ['map', '지도'], ['view', '1인칭/3인칭 전환'], ['freelook', '자유 시점']
];

export const DEFAULT_KEYS = {
  forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  sprint: ['ShiftLeft'], walk: ['ControlLeft'], jump: ['Space'], crouch: ['KeyC'], prone: ['KeyZ'],
  fire: ['Mouse0'], ads: ['Mouse2'], reload: ['KeyR'], interact: ['KeyF'],
  slot1: ['Digit1'], slot2: ['Digit2'], slot3: ['Digit3'], slot4: ['Digit4'], slot5: ['Digit5'],
  heal: ['KeyH'], inventory: ['Tab'], map: ['KeyM'], view: ['KeyV'], freelook: ['AltLeft']
};

/** graphics presets: Low / Medium / High / Ultra */
export const QUALITY = {
  low: { pixelRatio: 0.7, shadows: 0, shadowSize: 0, viewDist: 170, antialias: false, effects: 0, props: 0.5, lodScale: 0.6, material: 'lambert' },
  medium: { pixelRatio: 1.0, shadows: 1, shadowSize: 1024, viewDist: 240, antialias: false, effects: 1, props: 0.8, lodScale: 0.8, material: 'lambert' },
  high: { pixelRatio: 1.0, shadows: 2, shadowSize: 2048, viewDist: 320, antialias: true, effects: 2, props: 1, lodScale: 1, material: 'standard' },
  ultra: { pixelRatio: 1.5, shadows: 3, shadowSize: 4096, viewDist: 420, antialias: true, effects: 2, props: 1, lodScale: 1.3, material: 'standard' }
};

export function defaults(touch) {
  return {
    name: 'PLAYER', bots: 24, difficulty: 'normal', view: 'tps',
    // controls
    sens: 1.0, adsSens: 0.8, invertY: false, adsHold: true, crouchHold: false, fov: 80,
    keys: JSON.parse(JSON.stringify(DEFAULT_KEYS)),
    // graphics
    quality: touch ? 'low' : 'high', shadows: null, antialias: null, effects: null, viewDist: null, renderScale: null,
    fpsCap: touch ? 60 : 0,
    // audio
    volume: 0.7,
    // gameplay
    autoPickup: true,
    // touch
    touchSens: 1.0, uiScale: 1.0, btnScale: 1.0, btnOpacity: 0.8, autoFire: false, aimAssist: true, gyro: false, gyroSens: 1.0, vibrate: true,
    layout: null
  };
}

export function loadSettings(touch) {
  const d = defaults(touch);
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      Object.assign(d, s);
      d.keys = Object.assign(JSON.parse(JSON.stringify(DEFAULT_KEYS)), s.keys || {});
    }
  } catch { /* private mode / blocked storage: use defaults */ }
  return d;
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/** effective graphics config: preset + per-option overrides */
export function gfx(s) {
  const q = Object.assign({}, QUALITY[s.quality] || QUALITY.medium);
  if (s.shadows !== null && s.shadows !== undefined) q.shadows = s.shadows;
  if (q.shadows > 0 && !q.shadowSize) q.shadowSize = [0, 1024, 2048, 4096][q.shadows];
  if (s.antialias !== null && s.antialias !== undefined) q.antialias = s.antialias;
  if (s.effects !== null && s.effects !== undefined) q.effects = s.effects;
  if (s.viewDist) q.viewDist = s.viewDist;
  if (s.renderScale) q.pixelRatio = s.renderScale;
  return q;
}

export function keyLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Mouse')) return ['마우스 왼쪽', '마우스 휠', '마우스 오른쪽', '마우스 4', '마우스 5'][+code.slice(5)] || code;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code.replace('Left', ' L').replace('Right', ' R');
}
