/* =============================================================================
   one action state, many devices.  keyboard+mouse and touch both write into the
   same struct, so nothing in the game ever asks "is this a phone?".

   actions
     axes     moveX (strafe)  moveZ (forward)  lookDX  lookDY  (radians, per frame)
     holds    fire altFire sprint crouch aim
     presses  jump dash ability1 ability2 ultimate refocus menu scoreboard
   ========================================================================== */
import { clamp } from '../core/math.js';

export const HOLD_ACTIONS = ['fire', 'altFire', 'sprint', 'crouch', 'forward', 'back', 'left', 'right', 'scoreboard'];
export const PRESS_ACTIONS = ['jump', 'dash', 'ability1', 'ability2', 'ultimate', 'refocus', 'menu'];

export class InputManager {
  constructor() {
    this.moveX = 0;
    this.moveZ = 0;
    this.lookDX = 0;
    this.lookDY = 0;
    this.holds = Object.create(null);
    this.presses = Object.create(null);     // action -> frame counter of queued presses
    this.releases = Object.create(null);
    this.lastDevice = 'kbm';                // 'kbm' | 'touch'
    this.lookIsManual = false;              // true while the player is actively aiming
    this.manualLookT = 0;
    this.enabled = true;
    this.sources = [];
  }

  addSource(src) { this.sources.push(src); return src; }

  setHold(action, down) {
    const was = !!this.holds[action];
    this.holds[action] = !!down;
    if (down && !was) this.press(action);
    if (!down && was) this.releases[action] = (this.releases[action] || 0) + 1;
  }
  press(action) { this.presses[action] = (this.presses[action] || 0) + 1; }

  isDown(a) { return !!this.holds[a]; }
  /* consumes one queued press; returns true at most once per press */
  consume(a) {
    if (!this.presses[a]) return false;
    this.presses[a]--;
    return true;
  }
  consumeRelease(a) {
    if (!this.releases[a]) return false;
    this.releases[a]--;
    return true;
  }

  addLook(dx, dy, device = 'kbm') {
    if (!this.enabled) return;
    this.lookDX += dx;
    this.lookDY += dy;
    this.lastDevice = device;
    if (Math.abs(dx) + Math.abs(dy) > 0.0004) this.manualLookT = 0.22;
  }

  setMove(x, z, device) {
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    this.moveX = clamp(x, -1, 1);
    this.moveZ = clamp(z, -1, 1);
    if (device) this.lastDevice = device;
  }

  /* called once per frame after the player has read the state */
  endFrame(dt) {
    this.lookDX = 0;
    this.lookDY = 0;
    this.manualLookT = Math.max(0, this.manualLookT - dt);
    this.lookIsManual = this.manualLookT > 0;
    // unconsumed presses expire after a frame so a menu cannot replay them later
    for (const k in this.presses) this.presses[k] = 0;
    for (const k in this.releases) this.releases[k] = 0;
  }

  clear() {
    this.moveX = this.moveZ = this.lookDX = this.lookDY = 0;
    for (const k in this.holds) this.holds[k] = false;
    for (const k in this.presses) this.presses[k] = 0;
  }

  dispose() {
    for (const s of this.sources) s.dispose?.();
    this.sources.length = 0;
  }
}
