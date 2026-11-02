// The shooter's hit confirm (hit marker + hit sound), once per round. A
// shotgun round is eight pellets, and a room member hears about each of its
// pellets from the host in a separate message: without merging, one round
// would restart the marker and stack up to eight hit sounds. Hits are
// collected through the frame and shown together; one that arrives within a
// moment of the last confirm (the rest of the same round, a frame late) only
// shows when it adds something (a head hit, a kill). Kill confirms are not
// made here: they follow the match's own kill records (KillConfirm).

/** Seconds after a confirm in which further hits count as the same round (well under any gun's shot interval). */
export const HIT_MERGE_WINDOW = 0.04;

export type ShowHit = (head: boolean, kill: boolean, sound: boolean, delay: number) => void;

export class HitFeedback {
  private pending = false;
  private head = false;
  private kill = false;
  private delay = 0;
  private lastAt = -Infinity;
  private lastHead = false;
  private lastKill = false;

  constructor(private readonly show: ShowHit) {}

  /** A hit by this player's round (a pellet, or the host's word). `delay`: when its sound is due (s from now). */
  add(head: boolean, kill: boolean, delay = 0): void {
    if (!this.pending) this.delay = delay;
    else this.delay = Math.min(this.delay, delay);
    this.pending = true;
    this.head ||= head;
    this.kill ||= kill;
  }

  /** End of a frame (`now` in s): shows what was collected. */
  flush(now: number): void {
    if (!this.pending) return;
    const { head, kill, delay } = this;
    this.pending = this.head = this.kill = false;
    const sameRound = now - this.lastAt < HIT_MERGE_WINDOW;
    if (sameRound) {
      // The rest of a round already confirmed: only something new is shown (a head sound only if it was a body one).
      const newHead = head && !this.lastHead;
      const newKill = kill && !this.lastKill;
      if (!newHead && !newKill) return;
      this.lastHead ||= head;
      this.lastKill ||= kill;
      this.show(this.lastHead, this.lastKill, newHead, delay);
      return;
    }
    this.lastAt = now;
    this.lastHead = head;
    this.lastKill = kill;
    this.show(head, kill, true, delay);
  }
}
