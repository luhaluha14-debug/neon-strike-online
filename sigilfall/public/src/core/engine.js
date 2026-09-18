/* =============================================================================
   renderer, camera and the frame loop.  keeps quality settings, resolution
   scaling and the frame budget in one place so the rest of the game only ever
   asks for "the scene" and "the camera".
   ========================================================================== */
import { clamp } from './math.js';
import { settings } from './settings.js';

const THREE = window.THREE;

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const preset = settings.preset;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: preset.antialias && !settings.device.isMobile,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false
    });
    this.renderer.setClearColor(0x0c0f13, 1);
    this.renderer.shadowMap.enabled = !!settings.get('shadows');
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.autoClear = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.get('fov'), 1, 0.06, 400);
    this.camera.rotation.order = 'YXZ';
    this.uiCamera = null;

    this.clock = { last: 0, elapsed: 0 };
    this.frame = 0;
    this.fps = 0;
    this._fpsAcc = 0; this._fpsFrames = 0;
    this.updaters = [];
    this.running = false;
    this._raf = 0;
    this._accum = 0;

    this.onResize = this.onResize.bind(this);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', () => setTimeout(this.onResize, 120));
    this.onResize();
    settings.onChange((k) => {
      if (k === 'fov') { this.camera.fov = settings.get('fov'); this.camera.updateProjectionMatrix(); }
      if (k === 'renderScale' || k === 'quality') this.onResize();
      if (k === 'shadows' || k === 'quality') this.renderer.shadowMap.enabled = !!settings.get('shadows');
    });
  }

  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    const scale = clamp(settings.get('renderScale') || 1, 0.5, 1);
    const dprCap = settings.device.isMobile ? 2 : 2.2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap) * scale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.width = w; this.height = h;
  }

  add(fn) { this.updaters.push(fn); return fn; }
  remove(fn) {
    const i = this.updaters.indexOf(fn);
    if (i >= 0) this.updaters.splice(i, 1);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      const cap = settings.get('fpsCap') | 0;
      let dt = (now - this.clock.last) / 1000;
      if (cap > 0) {
        const budget = 1 / cap - 0.0015;
        if (dt < budget) return;                 // skip: we are ahead of the cap
      }
      this.clock.last = now;
      dt = clamp(dt, 0.0005, 0.1);               // a long stall must not teleport anybody
      this.clock.elapsed += dt;
      this.frame++;
      this._fpsAcc += dt; this._fpsFrames++;
      if (this._fpsAcc >= 0.5) {
        this.fps = Math.round(this._fpsFrames / this._fpsAcc);
        this._fpsAcc = 0; this._fpsFrames = 0;
      }
      for (let i = 0; i < this.updaters.length; i++) this.updaters[i](dt, this.clock.elapsed);
      this.renderer.render(this.scene, this.camera);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  /* drop everything a match added, leaving the renderer alive for the next one */
  clearScene() {
    const s = this.scene;
    for (let i = s.children.length - 1; i >= 0; i--) {
      const c = s.children[i];
      s.remove(c);
      disposeTree(c);
    }
    s.background = null;
    s.fog = null;
  }
}

export function disposeTree(obj) {
  obj.traverse?.((o) => {
    if (o.geometry && o.geometry.dispose && !o.geometry.userData.shared) o.geometry.dispose();
    const m = o.material;
    if (!m) return;
    if (Array.isArray(m)) m.forEach((mm) => mm.userData.shared || mm.dispose());
    else if (!m.userData.shared) m.dispose();
  });
}
