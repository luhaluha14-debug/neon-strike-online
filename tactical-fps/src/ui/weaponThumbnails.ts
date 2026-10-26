import * as THREE from 'three';
import type { WeaponViewSpec } from '../weapons/WeaponDefinition';
import { createWeaponView, type WeaponView } from '../weapons/view/WeaponView';

const W = 224;
const H = 112;
const SCALE = 2; // render at 2x for crisp cards on HiDPI screens

/**
 * Side-view snapshots of the existing first-person weapon models for the
 * menu's weapon cards. Uses the game's own renderer and environment map
 * (no second WebGL context), renders into a small offscreen target, and
 * yields between weapons so the menu never stalls. Side effect worth having:
 * shaders of weapons not yet equipped get compiled before their first use.
 */
export async function renderWeaponThumbnails(
  renderer: THREE.WebGLRenderer,
  environment: THREE.Texture | null,
  weapons: readonly { id: string; view: WeaponViewSpec }[],
  onThumbnail: (id: string, url: string) => void,
  /** Optional: dress each view before its picture is taken (skin previews); may return a cleanup. */
  decorate?: (id: string, view: WeaponView) => (() => void) | void,
): Promise<void> {
  const w = W * SCALE;
  const h = H * SCALE;
  // Half-float keeps dark gunmetal free of banding before tone mapping on the CPU;
  // GPUs that can't read half-float back fall back to 8-bit.
  let half = true;
  let target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
  let pixels: Uint16Array | Uint8Array = new Uint16Array(w * h * 4);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(w, h);

  const scene = new THREE.Scene();
  scene.environment = environment;
  scene.environmentIntensity = 0.6;
  scene.add(new THREE.HemisphereLight(0xdfe6ee, 0x3a342c, 1.4));
  const key = new THREE.DirectionalLight(0xfff1dc, 2.2);
  key.position.set(1, 1.2, 0.6);
  scene.add(key);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();

  try {
    for (const weapon of weapons) {
      await nextTask();
      const view = createWeaponView(weapon.view);
      const cleanup = decorate?.(weapon.id, view);
      try {
        scene.add(view.object);
        view.object.updateMatrixWorld(true);
        box.setFromObject(view.object, true);
        box.getSize(size);
        box.getCenter(center);
        // Right-side profile (camera on +X looking at -X): barrel / blade points left.
        camera.position.set(center.x + 2, center.y, center.z);
        camera.lookAt(center);
        const aspect = W / H;
        const halfH = Math.max(size.y / 2, size.z / 2 / aspect) * 1.08;
        camera.top = halfH;
        camera.bottom = -halfH;
        camera.left = -halfH * aspect;
        camera.right = halfH * aspect;
        camera.updateProjectionMatrix();

        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(scene, camera);
        renderer.setRenderTarget(prevTarget);
        // Async readback: no GPU pipeline stall on the main thread.
        try {
          await renderer.readRenderTargetPixelsAsync(target, 0, 0, w, h, pixels);
        } catch (err) {
          if (!half) throw err;
          half = false;
          target.dispose();
          target = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, samples: 4 });
          pixels = new Uint8Array(w * h * 4);
          renderer.setRenderTarget(target);
          renderer.clear();
          renderer.render(scene, camera);
          renderer.setRenderTarget(prevTarget);
          await renderer.readRenderTargetPixelsAsync(target, 0, 0, w, h, pixels);
        }
        encode(pixels, image.data, w, h);
        ctx.putImageData(image, 0, 0);
        onThumbnail(weapon.id, canvas.toDataURL('image/png'));
      } finally {
        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(prevClear, prevAlpha);
        scene.remove(view.object);
        cleanup?.();
        view.dispose();
      }
    }
  } finally {
    target.dispose();
  }
}

/**
 * Linear half-float → display RGBA8: the same ACES filmic curve and sRGB
 * encoding the main renderer applies on screen (render targets skip both),
 * flipped vertically (GL rows start at the bottom).
 */
function encode(src: Uint16Array | Uint8Array, dst: Uint8ClampedArray, w: number, h: number): void {
  const half = src instanceof Uint16Array ? THREE.DataUtils.fromHalfFloat : (v: number) => v / 255;
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4;
    const dstRow = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = srcRow + x * 4;
      const o = dstRow + x * 4;
      const a = Math.min(Math.max(half(src[i + 3]), 0), 1);
      if (a <= 0) {
        dst[o + 3] = 0;
        continue;
      }
      // Premultiplied → straight colour before the curve.
      let r = half(src[i]) / a;
      let g = half(src[i + 1]) / a;
      let b = half(src[i + 2]) / a;
      // ACES filmic (as three.js ACESFilmicToneMapping, exposure 1).
      r /= 0.6;
      g /= 0.6;
      b /= 0.6;
      const ir = 0.59719 * r + 0.35458 * g + 0.04823 * b;
      const ig = 0.076 * r + 0.90834 * g + 0.01566 * b;
      const ib = 0.0284 * r + 0.13383 * g + 0.83777 * b;
      const fr = rrtOdt(ir);
      const fg = rrtOdt(ig);
      const fb = rrtOdt(ib);
      r = 1.60475 * fr - 0.53108 * fg - 0.07367 * fb;
      g = -0.10208 * fr + 1.10813 * fg - 0.00605 * fb;
      b = -0.00327 * fr - 0.07276 * fg + 1.07602 * fb;
      dst[o] = srgb(r);
      dst[o + 1] = srgb(g);
      dst[o + 2] = srgb(b);
      dst[o + 3] = Math.round(a * 255);
    }
  }
}

function rrtOdt(v: number): number {
  return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
}

function srgb(c: number): number {
  const v = Math.min(Math.max(c, 0), 1);
  return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
}

function nextTask(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
