import { biquad, buffer, expEnv, finish, glideSine, mix, noise, ring, rng, shape, SAMPLE_RATE } from './dsp';

// Procedural sound recipes. Every sound is synthesised offline into a sample
// array once at startup (no audio files, no licensing questions) and then
// only played back during combat. Several seeded variants per gunshot keep
// repeated shots from sounding identical.

export type SoundId =
  | 'ar01.shot'
  | 'sr01.shot'
  | 'sr01.bolt'
  | 'karambit.swing'
  | 'karambit.hit'
  | 'dryfire'
  | 'mag.out'
  | 'mag.in'
  | 'ar01.charge'
  | 'sr01.chamber'
  | 'equip.gun'
  | 'equip.knife'
  | 'impact'
  | 'hit.body'
  | 'hit.head';

/** Number of pre-rendered variants per sound. */
export const VARIANTS: Record<SoundId, number> = {
  'ar01.shot': 4,
  'sr01.shot': 3,
  'sr01.bolt': 1,
  'karambit.swing': 3,
  'karambit.hit': 2,
  dryfire: 2,
  'mag.out': 1,
  'mag.in': 2,
  'ar01.charge': 1,
  'sr01.chamber': 1,
  'equip.gun': 2,
  'equip.knife': 2,
  impact: 4,
  'hit.body': 2,
  'hit.head': 2,
};

interface GunshotRecipe {
  length: number;
  /** Supersonic crack / muzzle blast attack: bright, very short. */
  crack: { highpass: number; tau: number; gain: number };
  /** Main body: broadband blast through a lowpass. */
  body: { lowpass: number; tau: number; gain: number };
  /** Low "thump" felt more than heard; kept modest to avoid boomy bass. */
  thump: { f0: number; f1: number; tau: number; gain: number };
  /** Mechanical action right after the blast (bolt carrier / receiver ring). */
  mech: { freq: number; delay: number; tau: number; gain: number };
  /** Environmental tail: soft, dark, decaying. */
  tail: { lowpass: number; attack: number; tau: number; gain: number };
  /** A couple of quiet, dark early reflections (no obvious echo). */
  reflections: readonly [delay: number, gain: number][];
}

const AR01_SHOT: GunshotRecipe = {
  length: 0.95,
  crack: { highpass: 2400, tau: 0.0035, gain: 0.7 },
  body: { lowpass: 2000, tau: 0.02, gain: 1.0 },
  thump: { f0: 180, f1: 90, tau: 0.028, gain: 0.28 },
  mech: { freq: 3300, delay: 0.011, tau: 0.009, gain: 0.16 },
  tail: { lowpass: 950, attack: 0.025, tau: 0.2, gain: 0.2 },
  reflections: [
    [0.072, 0.12],
    [0.15, 0.06],
  ],
};

const SR01_SHOT: GunshotRecipe = {
  length: 1.9,
  crack: { highpass: 2000, tau: 0.0055, gain: 0.95 },
  body: { lowpass: 1700, tau: 0.04, gain: 1.0 },
  thump: { f0: 140, f1: 68, tau: 0.045, gain: 0.3 },
  mech: { freq: 2600, delay: 0.016, tau: 0.012, gain: 0.1 },
  tail: { lowpass: 720, attack: 0.04, tau: 0.48, gain: 0.32 },
  reflections: [
    [0.11, 0.16],
    [0.24, 0.09],
    [0.41, 0.04],
  ],
};

function gunshot(r: GunshotRecipe, seed: number): Float32Array {
  const rand = rng(seed);
  const j = (v: number, amount: number): number => v * (1 + (rand() * 2 - 1) * amount);
  const out = buffer(r.length);

  // Attack: high-passed noise burst plus a one-sample-wide click for definition.
  const crack = biquad(noise(0.06, rand), 'highpass', j(r.crack.highpass, 0.08), 0.9);
  shape(crack, expEnv(0.0002, j(r.crack.tau, 0.12)));
  crack[0] += 0.9;
  crack[1] -= 0.5;
  mix(out, crack, r.crack.gain);

  // Body: the blast itself. Two lowpass stages give a rounder "punch".
  const body = noise(0.35, rand);
  biquad(body, 'lowpass', j(r.body.lowpass, 0.1), 0.8);
  biquad(body, 'highpass', 90);
  shape(body, expEnv(0.0008, j(r.body.tau, 0.12)));
  mix(out, body, r.body.gain);

  const thump = glideSine(0.4, j(r.thump.f0, 0.06), r.thump.f1, 0.02);
  shape(thump, expEnv(0.0015, j(r.thump.tau, 0.1)));
  mix(out, thump, r.thump.gain);

  // Mechanism: band of noise plus small metal partials.
  const mech = biquad(noise(0.08, rand), 'bandpass', j(r.mech.freq, 0.1), 3.5);
  shape(mech, expEnv(0.0005, r.mech.tau));
  mix(out, mech, r.mech.gain * 2.5, r.mech.delay);
  const f = j(r.mech.freq, 0.05);
  mix(out, ring(0.12, [[f * 0.87, 1, 0.02], [f * 1.31, 0.6, 0.014], [f * 1.93, 0.35, 0.01]]), r.mech.gain * 0.3, r.mech.delay);

  // Tail: dark noise swelling slightly after the blast, then decaying.
  const tail = noise(r.length, rand);
  biquad(tail, 'lowpass', j(r.tail.lowpass, 0.1), 0.6);
  biquad(tail, 'highpass', 110);
  shape(tail, expEnv(r.tail.attack, j(r.tail.tau, 0.1), 0.008));
  mix(out, tail, r.tail.gain);

  // Early reflections of the blast: low-passed, so they read as space, not echo.
  const echo = out.slice(0, Math.round(0.08 * SAMPLE_RATE));
  biquad(echo, 'lowpass', 1400);
  for (const [delay, gain] of r.reflections) mix(out, echo, gain, j(delay, 0.12));

  biquad(out, 'highpass', 65); // no sub-bass rumble / DC
  return finish(out, 0.9, 1.6);
}

/** Short metallic click: trigger, catch, latch. */
function click(rand: () => number, freq: number, tau: number, gain: number, len = 0.05): Float32Array {
  const c = biquad(noise(len, rand), 'bandpass', freq, 2.5);
  shape(c, expEnv(0.0003, tau));
  mix(c, ring(len, [[freq * 0.9, 0.25, tau * 2], [freq * 1.6, 0.15, tau * 1.5]]));
  for (let i = 0; i < c.length; i++) c[i] *= gain;
  return c;
}

/** Metal-on-metal slide (bolt, magazine in its well). */
function slide(rand: () => number, seconds: number, centre: number, gain: number): Float32Array {
  const s = biquad(noise(seconds, rand), 'bandpass', (t) => centre * (0.85 + 0.3 * (t / seconds)), 1.8);
  shape(s, (t) => Math.sin(Math.PI * Math.min(t / seconds, 1)) ** 0.7 * (0.6 + 0.4 * rand()));
  for (let i = 0; i < s.length; i++) s[i] *= gain;
  return s;
}

/** Soft cloth / glove movement. */
function rustle(rand: () => number, seconds: number, gain: number): Float32Array {
  const s = biquad(noise(seconds, rand), 'bandpass', 1200, 0.6);
  biquad(s, 'lowpass', 3000);
  shape(s, (t) => Math.sin(Math.PI * Math.min(t / seconds, 1)) * gain);
  return s;
}

/**
 * SR-01 bolt cycle, timed to the view model's bolt animation (see
 * `animateBolt`): lift at 0, pull back until 0.5, push forward until 0.8,
 * lock down at 1.0 of the cycle. `start` and `span` are in seconds.
 */
export function boltTimeline(fireInterval: number): { start: number; span: number } {
  const cycle = Math.min(fireInterval, 1.4);
  return { start: 0.18, span: cycle - 0.3 };
}

function srBolt(seed: number, fireInterval: number): Float32Array {
  const rand = rng(seed);
  const { start, span } = boltTimeline(fireInterval);
  const at = (u: number): number => start + u * span;
  const out = buffer(at(1) + 0.15);
  mix(out, click(rand, 2400, 0.008, 0.55), 1, at(0.02)); // handle up
  mix(out, slide(rand, at(0.48) - at(0.22), 2100, 0.35), 1, at(0.22)); // back
  mix(out, click(rand, 1700, 0.012, 0.8), 1, at(0.48)); // stop
  mix(out, slide(rand, at(0.78) - at(0.55), 2400, 0.3), 1, at(0.55)); // forward
  mix(out, click(rand, 1500, 0.014, 0.9), 1, at(0.78)); // round chambered
  mix(out, click(rand, 2800, 0.006, 0.6), 1, at(0.98)); // handle down
  biquad(out, 'highpass', 200);
  return finish(out, 0.75, 1.1);
}

function swing(seed: number): Float32Array {
  const rand = rng(seed);
  const len = 0.24 + rand() * 0.04;
  const s = noise(len, rand);
  // Band sweeps up then down as the blade passes: a short "whff".
  biquad(s, 'bandpass', (t) => 350 + 1500 * Math.sin(Math.PI * Math.min(t / len, 1)), 1.1);
  shape(s, (t) => Math.sin(Math.PI * Math.min(t / len, 1)) ** 1.6);
  return finish(s, 0.6, 1);
}

function knifeHit(seed: number): Float32Array {
  const rand = rng(seed);
  const out = buffer(0.25);
  const thud = biquad(noise(0.2, rand), 'lowpass', 900);
  shape(thud, expEnv(0.0008, 0.03));
  mix(out, thud, 1);
  mix(out, click(rand, 3800, 0.01, 0.5, 0.12), 1, 0.002);
  biquad(out, 'highpass', 80);
  return finish(out, 0.8, 1.3);
}

function dryFire(seed: number): Float32Array {
  const rand = rng(seed);
  const out = buffer(0.09);
  mix(out, click(rand, 3000 + rand() * 300, 0.004, 0.7), 1, 0);
  mix(out, click(rand, 2200, 0.006, 0.9), 1, 0.014 + rand() * 0.004);
  return finish(out, 0.55, 1);
}

function magOut(seed: number): Float32Array {
  const rand = rng(seed);
  const out = buffer(0.42);
  mix(out, click(rand, 2600, 0.006, 0.8), 1, 0); // release button
  mix(out, slide(rand, 0.16, 1500, 0.4), 1, 0.03); // magazine slides out
  mix(out, rustle(rand, 0.2, 0.25), 1, 0.2);
  return finish(out, 0.6, 1);
}

function magIn(seed: number): Float32Array {
  const rand = rng(seed);
  const out = buffer(0.3);
  mix(out, slide(rand, 0.09, 1700, 0.35), 1, 0); // into the well
  const seat = biquad(noise(0.1, rand), 'lowpass', 1600);
  shape(seat, expEnv(0.0006, 0.014));
  mix(out, seat, 0.8, 0.085); // seated knock
  mix(out, click(rand, 2300, 0.008, 1), 1, 0.088); // catch
  return finish(out, 0.7, 1.2);
}

function arCharge(seed: number): Float32Array {
  const rand = rng(seed);
  const out = buffer(0.32);
  mix(out, slide(rand, 0.07, 2200, 0.35), 1, 0); // pull
  mix(out, click(rand, 1900, 0.008, 0.7), 1, 0.07);
  mix(out, click(rand, 1600, 0.014, 1), 1, 0.13); // carrier slams home
  return finish(out, 0.7, 1.2);
}

function srChamber(seed: number): Float32Array {
  const rand = rng(seed);
  const out = buffer(0.2);
  mix(out, click(rand, 1800, 0.012, 1), 1, 0);
  mix(out, click(rand, 2900, 0.006, 0.6), 1, 0.07);
  return finish(out, 0.6, 1.1);
}

function equipGun(seed: number): Float32Array {
  const rand = rng(seed);
  const out = buffer(0.5);
  mix(out, rustle(rand, 0.28, 0.5), 1, 0);
  mix(out, click(rand, 2000 + rand() * 300, 0.01, 0.6), 1, 0.24);
  return finish(out, 0.45, 1);
}

function equipKnife(seed: number): Float32Array {
  const rand = rng(seed);
  const out = buffer(0.4);
  mix(out, rustle(rand, 0.15, 0.4), 1, 0);
  // Light blade "shing": bright band sweep plus a faint high ring.
  const shing = biquad(noise(0.2, rand), 'bandpass', (t) => 4200 + 3000 * t, 3);
  shape(shing, (t) => Math.sin(Math.PI * Math.min(t / 0.2, 1)));
  mix(out, shing, 0.35, 0.08);
  mix(out, ring(0.3, [[5300, 0.05, 0.08], [7900, 0.03, 0.06]]), 1, 0.12);
  return finish(out, 0.4, 1);
}

function impact(seed: number): Float32Array {
  const rand = rng(seed);
  const out = buffer(0.3);
  const snap = biquad(noise(0.04, rand), 'highpass', 2500);
  shape(snap, expEnv(0.0002, 0.0025));
  mix(out, snap, 1);
  const hit = biquad(noise(0.12, rand), 'bandpass', 900 + rand() * 500, 1.2);
  shape(hit, expEnv(0.0005, 0.016));
  mix(out, hit, 1.2);
  // A few grains of debris.
  for (let k = 0; k < 4; k++) {
    mix(out, click(rand, 3000 + rand() * 3000, 0.002, 0.25 * rand(), 0.02), 1, 0.02 + rand() * 0.12);
  }
  biquad(out, 'highpass', 150);
  return finish(out, 0.7, 1.2);
}

/** Body hit confirm: a dull, padded thwack (round into a vest / dummy). */
function hitBody(seed: number): Float32Array {
  const rand = rng(seed);
  const out = buffer(0.16);
  const thwack = biquad(noise(0.12, rand), 'lowpass', 1100 + rand() * 200);
  shape(thwack, expEnv(0.0006, 0.018));
  mix(out, thwack, 1);
  const knock = glideSine(0.1, 260, 150, 0.02);
  shape(knock, expEnv(0.0008, 0.022));
  mix(out, knock, 0.45);
  mix(out, click(rand, 2200, 0.004, 0.25, 0.03), 1, 0.001);
  biquad(out, 'highpass', 110);
  return finish(out, 0.75, 1.3);
}

/** Head hit confirm: a sharp, short metallic tink (helmet), easy to tell from a body hit. */
function hitHead(seed: number): Float32Array {
  const rand = rng(seed);
  const out = buffer(0.3);
  const tick = biquad(noise(0.02, rand), 'highpass', 3000);
  shape(tick, expEnv(0.0002, 0.002));
  mix(out, tick, 0.8);
  const f = 2350 + rand() * 120;
  mix(out, ring(0.3, [[f, 0.5, 0.07], [f * 1.53, 0.32, 0.05], [f * 2.31, 0.18, 0.035]]), 1, 0.0005);
  biquad(out, 'highpass', 600);
  return finish(out, 0.7, 1.2);
}

/** Renders one variant of one sound. */
export function renderSound(id: SoundId, variant: number, opts: { srFireInterval: number }): Float32Array {
  const seed = hash(id) + variant * 7919;
  switch (id) {
    case 'ar01.shot':
      return gunshot(AR01_SHOT, seed);
    case 'sr01.shot':
      return gunshot(SR01_SHOT, seed);
    case 'sr01.bolt':
      return srBolt(seed, opts.srFireInterval);
    case 'karambit.swing':
      return swing(seed);
    case 'karambit.hit':
      return knifeHit(seed);
    case 'dryfire':
      return dryFire(seed);
    case 'mag.out':
      return magOut(seed);
    case 'mag.in':
      return magIn(seed);
    case 'ar01.charge':
      return arCharge(seed);
    case 'sr01.chamber':
      return srChamber(seed);
    case 'equip.gun':
      return equipGun(seed);
    case 'equip.knife':
      return equipKnife(seed);
    case 'impact':
      return impact(seed);
    case 'hit.body':
      return hitBody(seed);
    case 'hit.head':
      return hitHead(seed);
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
