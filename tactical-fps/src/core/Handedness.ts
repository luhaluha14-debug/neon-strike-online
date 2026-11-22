// Phase 30 손잡이 (handedness): which side the first-person weapon is held on. A display setting of this
// browser only: it mirrors the first-person view (weapon, hands, animations) and changes nothing about
// aiming, shots, hits or what other players see; it is never sent to anyone. Stored apart from the
// settings record (whose format stays as it was).

export type Handedness = 'right' | 'left';

const KEY = 'tactical-fps.hand.v1';

export function loadHandedness(): Handedness {
  try {
    return localStorage.getItem(KEY) === 'left' ? 'left' : 'right';
  } catch {
    return 'right';
  }
}

export function saveHandedness(h: Handedness): void {
  try {
    if (h === 'left') localStorage.setItem(KEY, 'left');
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: for this visit only.
  }
}
