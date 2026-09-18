/* =============================================================================
   the performance watchdog.  the graphics preset is picked from the device at
   boot; this is the safety net for when that guess is wrong - a hot phone, a
   heavy fight, a browser throttling the tab.  it only ever steps down, one
   notch at a time, and it says so once.
   ========================================================================== */
import { settings } from './settings.js';
import { toast } from '../ui/screens.js';

const WINDOW = 3;          // seconds per measurement
const GRACE = 6;           // ignore the first seconds of a match entirely

export class PerfWatch {
  constructor(engine) {
    this.engine = engine;
    this.reset();
  }

  reset() {
    this.t = 0;
    this.frames = 0;
    this.elapsed = 0;
    this.bad = 0;
    this.stepsTaken = 0;
    this.told = false;
  }

  get target() {
    const cap = settings.get('fpsCap') | 0;
    if (cap > 0) return cap * 0.8;
    return settings.device.isMobile ? 40 : 45;
  }

  update(dt) {
    if (!settings.get('autoQuality')) return;
    this.t += dt;
    if (this.t < GRACE) return;
    this.frames++;
    this.elapsed += dt;
    if (this.elapsed < WINDOW) return;
    const fps = this.frames / this.elapsed;
    this.frames = 0;
    this.elapsed = 0;
    if (fps >= this.target) { this.bad = 0; return; }
    this.bad++;
    if (this.bad < 2) return;          // one bad window can just be a load hitch
    this.bad = 0;
    this.stepDown(fps);
  }

  /* one notch down, cheapest thing first */
  stepDown(fps) {
    if (this.stepsTaken >= 4) return;
    const scale = settings.get('renderScale');
    if (settings.get('shadows') && this.stepsTaken === 0) {
      settings.set('shadows', false);
    } else if (scale > 0.62) {
      settings.set('renderScale', Math.max(0.6, Math.round((scale - 0.15) * 100) / 100));
    } else if (settings.get('particles') > 0.45) {
      settings.set('particles', 0.4);
    } else if (settings.get('fpsCap') === 0) {
      settings.set('fpsCap', 30);
    } else {
      this.stepsTaken = 4;
      return;
    }
    this.stepsTaken++;
    if (!this.told) {
      this.told = true;
      toast('프레임이 낮아 그래픽을 자동으로 낮췄습니다 (설정에서 변경 가능)', '', 3200);
    }
    void fps;
  }
}
