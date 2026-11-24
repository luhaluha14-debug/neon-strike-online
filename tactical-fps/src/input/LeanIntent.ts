/**
 * Phase 33: which way the player wants to lean from the two held controls (Q / E, or the ◀ ▶ buttons). One
 * held: that side. Both held: the one pressed last (pressing the other side while still holding the first
 * switches over at once, and letting it go returns to the first) — never a cancelled 0 that drops the lean
 * back upright for a moment. Neither: upright. A press is noticed between polls, so a quick tap of the other
 * side while holding one still takes effect. No allocation.
 */
export class LeanIntent {
  private prevLeft = false;
  private prevRight = false;
  /** -1 left / 1 right: the side pressed most recently. */
  private last = 0;

  /** -1 left, 1 right, 0 upright. */
  resolve(left: boolean, right: boolean): number {
    if (left && !this.prevLeft) this.last = -1;
    if (right && !this.prevRight) this.last = 1;
    this.prevLeft = left;
    this.prevRight = right;
    if (left && right) return this.last || 1;
    return left ? -1 : right ? 1 : 0;
  }

  reset(): void {
    this.prevLeft = this.prevRight = false;
    this.last = 0;
  }
}
