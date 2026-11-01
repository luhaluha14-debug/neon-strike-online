// Kill confirm: one sound per kill the player is credited with. Every kill
// has a key (single player: match, victim and its death count; a room
// member: the id the host gives the kill), and a key is confirmed once, so a
// repeated death report, a second damage event on the same death or a
// message that arrives twice never plays it again. Hits that do not kill,
// teammates and training dummies never reach it: callers only pass kills the
// match itself credited.

/** Keys remembered (old ones are forgotten first; a key only repeats within moments). */
const MEMORY = 256;

export class KillConfirm {
  private readonly seen = new Set<string>();
  /** Kills confirmed (sound requested) so far. */
  count = 0;

  constructor(private readonly play: () => void) {}

  /** Plays for a new kill; false (silent) for a key already confirmed. */
  confirm(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > MEMORY) this.seen.delete(this.seen.values().next().value!);
    this.count++;
    this.play();
    return true;
  }
}
