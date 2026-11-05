import * as THREE from 'three';

// Shop signs and painted markings, drawn once into one canvas per map (one
// texture, one material, one draw call for all of them). Real Korean words a
// street in Seoul actually shows (pharmacy, opticians, estate agent, snack bar,
// laundry, clinic…), as generic small-business names — no invented glyphs, no
// real brands. Drawn with the system's Korean font (Malgun Gothic / Apple SD
// Gothic Neo / Noto Sans KR…), so they read naturally on every machine.

const FONT = `"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", "Noto Sans CJK KR", "Nanum Gothic", "WenQuanYi Zen Hei", sans-serif`;

/** A horizontal shop sign: name, small line under it, colours. */
interface ShopSign {
  name: string;
  sub: string;
  bg: string;
  fg: string;
}

export const SHOP_SIGNS: readonly ShopSign[] = [
  { name: '행복약국', sub: '처방조제 · 02-735-1124', bg: '#1d5fa8', fg: '#ffffff' },
  { name: '서울안경원', sub: '시력검사 · 콘택트렌즈', bg: '#f2f2ee', fg: '#1d3f8a' },
  { name: '24시 편의점', sub: '도시락 · 택배 · 생활용품', bg: '#2f8f4e', fg: '#ffffff' },
  { name: '한빛부동산', sub: '매매 · 전세 · 월세 상담', bg: '#7a1f2b', fg: '#fff3d6' },
  { name: '맛나분식', sub: '김밥 · 떡볶이 · 라면', bg: '#f0c419', fg: '#3a2410' },
  { name: '다온카페', sub: 'COFFEE & BAKERY', bg: '#3d2b22', fg: '#f3e6d2' },
  { name: '청솔세탁소', sub: '수선 · 드라이클리닝', bg: '#e9eef2', fg: '#1d5b72' },
  { name: '중앙정형외과', sub: '물리치료 · 도수치료', bg: '#ffffff', fg: '#0c6a4a' },
  { name: '새마을식당', sub: '백반 · 김치찌개', bg: '#b3261e', fg: '#ffffff' },
  { name: '미래공인중개사', sub: '사무실 · 상가 임대', bg: '#20304a', fg: '#ffd56b' },
  { name: '하나미용실', sub: '커트 · 펌 · 염색', bg: '#f6d3dc', fg: '#6b1f3a' },
  { name: '명동칼국수', sub: '손칼국수 · 만두', bg: '#efe7d6', fg: '#4a2a14' },
  { name: '우리치킨', sub: '포장 · 배달', bg: '#e8681e', fg: '#ffffff' },
  { name: '제일문구', sub: '사무용품 · 복사', bg: '#ffffff', fg: '#b3261e' },
  { name: '종로한의원', sub: '침 · 뜸 · 한약', bg: '#5a4632', fg: '#f5e9d0' },
  { name: '푸른꽃집', sub: '꽃바구니 · 화분', bg: '#e6f2e0', fg: '#2c6b2f' },
];

/** Vertical signs mounted on building corners (upper floors). */
export const VERTICAL_SIGNS: readonly { text: string; bg: string; fg: string }[] = [
  { text: '영어학원', bg: '#ffffff', fg: '#1d3f8a' },
  { text: '연세치과', bg: '#1d6fb8', fg: '#ffffff' },
  { text: '노래연습장', bg: '#3a1f5c', fg: '#ffe066' },
  { text: '피트니스', bg: '#202020', fg: '#ff6a2a' },
  { text: '수학교습소', bg: '#f4f4f0', fg: '#2f6b2f' },
  { text: '내과의원', bg: '#ffffff', fg: '#0c6a8a' },
  { text: '당구장', bg: '#0f5a3a', fg: '#ffffff' },
  { text: '독서실', bg: '#f2e4c4', fg: '#3a2a14' },
];

/** Painted warehouse markings (stencil style). */
export const STENCILS: readonly string[] = ['A', 'B', 'A동', 'B동', '적재 구역', '출입 금지', '지게차 주의', 'LOADING 03', '01', '02', '03', '04', '05', '06', '보행자 통로', '하역장'];

export interface Atlas {
  texture: THREE.CanvasTexture;
  /** UV rectangles [u0, v0, u1, v1] (three's v up). */
  shop: readonly (readonly [number, number, number, number])[];
  vertical: readonly (readonly [number, number, number, number])[];
  stencil: readonly (readonly [number, number, number, number])[];
}

const W = 1024;
const H = 1024;
const SHOP_W = 512;
const SHOP_H = 96;
const VERT_W = 64;
const VERT_H = 256;
const ST_W = 256;
const ST_H = 64;

let cached: Atlas | null = null;

/** The atlas (made once per page; shared by both maps). Null without a DOM (Node tests). */
export function signAtlas(): Atlas | null {
  if (cached) return cached;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, W, H);
  const uv = (x: number, y: number, w: number, h: number) => [x / W, 1 - (y + h) / H, (x + w) / W, 1 - y / H] as const;

  // Shop signs: 2 columns x 8 rows (top 768 px).
  const shop = SHOP_SIGNS.map((s, i) => {
    const x = (i % 2) * SHOP_W;
    const y = Math.floor(i / 2) * SHOP_H;
    g.fillStyle = s.bg;
    g.fillRect(x, y, SHOP_W, SHOP_H);
    // A thin inner frame, as on real fascia boards.
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 4;
    g.strokeRect(x + 3, y + 3, SHOP_W - 6, SHOP_H - 6);
    g.fillStyle = s.fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold 50px ${FONT}`;
    fit(g, s.name, SHOP_W - 40);
    g.fillText(s.name, x + SHOP_W / 2, y + 40);
    g.font = `20px ${FONT}`;
    g.globalAlpha = 0.85;
    g.fillText(s.sub, x + SHOP_W / 2, y + 78);
    g.globalAlpha = 1;
    return uv(x, y, SHOP_W, SHOP_H);
  });

  // Vertical signs: 8 across, one row (y 768..1024 is shared with stencils: left half).
  const vertical = VERTICAL_SIGNS.map((s, i) => {
    const x = i * VERT_W;
    const y = 768;
    g.fillStyle = s.bg;
    g.fillRect(x, y, VERT_W, VERT_H);
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = 3;
    g.strokeRect(x + 2, y + 2, VERT_W - 4, VERT_H - 4);
    g.fillStyle = s.fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const chars = [...s.text];
    const step = Math.min(46, (VERT_H - 20) / chars.length);
    g.font = `bold ${Math.floor(step * 0.85)}px ${FONT}`;
    chars.forEach((ch, k) => g.fillText(ch, x + VERT_W / 2, y + 10 + step * (k + 0.5) + (VERT_H - 20 - step * chars.length) / 2));
    return uv(x, y, VERT_W, VERT_H);
  });

  // Stencils: right half of the bottom band, 2 x 8, painted on a transparent-looking grey (multiplied by the surface).
  const stencil = STENCILS.map((t, i) => {
    const x = 512 + (i % 2) * ST_W;
    const y = 768 + Math.floor(i / 2) * (ST_H / 2);
    // Half-height cells: 256 x 32 each.
    const h = ST_H / 2;
    g.fillStyle = '#d9b42a';
    g.fillRect(x, y, ST_W, h);
    g.fillStyle = '#1b1b1b';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold 26px ${FONT}`;
    fit(g, t, ST_W - 16);
    g.fillText(t, x + ST_W / 2, y + h / 2 + 1);
    return uv(x, y, ST_W, h);
  });

  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  cached = { texture, shop, vertical, stencil };
  return cached;
}

/** Shrinks the current font until `text` fits `width`. */
function fit(g: CanvasRenderingContext2D, text: string, width: number): void {
  let size = parseInt(g.font, 10) || 40;
  while (g.measureText(text).width > width && size > 10) {
    size -= 2;
    g.font = g.font.replace(/\d+px/, `${size}px`);
  }
}

/** UV rectangles of the shop interior views (4 across). */
export const INTERIOR_UV: readonly (readonly [number, number, number, number])[] = [0, 1, 2, 3].map((i) => [i / 4, 0, (i + 1) / 4, 1] as const);

let interior: THREE.CanvasTexture | null = null;

/**
 * What a shop window shows from the street: a lit room with shelves (convenience store, pharmacy),
 * tables (café / restaurant) or a counter and desks (estate agent, clinic). Soft and slightly
 * blurred, as seen through glass. Four views side by side; null without a DOM.
 */
export function shopInterior(): THREE.CanvasTexture | null {
  if (interior) return interior;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const g = c.getContext('2d');
  if (!g) return null;
  const room = (x: number, warm: string, floor: string) => {
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, warm);
    grad.addColorStop(0.62, '#b9b2a2');
    grad.addColorStop(0.63, floor);
    grad.addColorStop(1, '#6d665c');
    g.fillStyle = grad;
    g.fillRect(x, 0, 256, 256);
    // Ceiling lights.
    g.fillStyle = 'rgba(255,252,240,0.95)';
    for (let k = 0; k < 3; k++) g.fillRect(x + 30 + k * 80, 10, 50, 7);
  };
  // 0: convenience store / pharmacy shelves.
  room(0, '#efeee6', '#8e877a');
  const goods = ['#d9443a', '#3a78c8', '#f0c419', '#48a35a', '#e8e8e8', '#f08a2a'];
  for (let sx = 0; sx < 3; sx++) {
    const x = 18 + sx * 80;
    g.fillStyle = '#d8d8d4';
    g.fillRect(x, 60, 60, 120);
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 6; k++) {
        g.fillStyle = goods[(sx * 7 + row * 3 + k) % goods.length];
        g.fillRect(x + 3 + k * 9.5, 66 + row * 28, 7, 18);
      }
      g.fillStyle = '#9a9a96';
      g.fillRect(x, 86 + row * 28, 60, 3);
    }
  }
  // 1: café: warm light, tables and a counter.
  room(256, '#f3dfbf', '#7a5a3c');
  g.fillStyle = '#5a3a24';
  g.fillRect(256 + 140, 120, 110, 50);
  g.fillStyle = '#3a2a20';
  for (let k = 0; k < 3; k++) {
    g.fillRect(256 + 20 + k * 40, 150, 30, 6);
    g.fillRect(256 + 33 + k * 40, 156, 4, 24);
  }
  g.fillStyle = 'rgba(255,230,190,0.9)';
  for (let k = 0; k < 3; k++) {
    g.beginPath();
    g.arc(256 + 50 + k * 70, 40, 9, 0, Math.PI * 2);
    g.fill();
  }
  // 2: office / estate agent: desks, chairs, wall posters.
  room(512, '#e8ece9', '#8a8f8c');
  g.fillStyle = '#ffffff';
  for (let k = 0; k < 5; k++) g.fillRect(512 + 16 + k * 48, 50, 36, 46);
  g.fillStyle = '#6b6e70';
  for (let k = 0; k < 3; k++) {
    g.fillRect(512 + 20 + k * 80, 140, 64, 8);
    g.fillRect(512 + 26 + k * 80, 148, 6, 30);
    g.fillRect(512 + 70 + k * 80, 148, 6, 30);
  }
  // 3: restaurant / clinic waiting room: benches and a bright counter.
  room(768, '#f4f1ea', '#958d80');
  g.fillStyle = '#c94a3a';
  g.fillRect(768 + 20, 150, 120, 26);
  g.fillStyle = '#f9f9f6';
  g.fillRect(768 + 160, 110, 80, 70);
  g.fillStyle = '#3d6f8f';
  g.fillRect(768 + 165, 60, 70, 30);
  // Seen through glass: a little soft.
  g.filter = 'blur(1.2px)';
  g.drawImage(c, 0, 0);
  g.filter = 'none';
  interior = new THREE.CanvasTexture(c);
  interior.colorSpace = THREE.SRGBColorSpace;
  return interior;
}
