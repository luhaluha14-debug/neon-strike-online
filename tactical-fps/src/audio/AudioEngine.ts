import { SAMPLE_RATE } from './dsp';
import { renderSound, VARIANTS, type SoundId } from './weaponSounds';

export type VoiceGroup = 'shot' | 'impact' | 'foley' | 'confirm' | 'env';

/**
 * Most simultaneous voices per group; the oldest is faded out to make room.
 * `confirm` (kill confirm) has its own small pool so a burst of impacts in
 * full-auto fire can never cut it off. `env` (the player's footsteps, landings, spent cases
 * on the floor) has its own too, so it never takes a voice from gunfire or impacts.
 */
const GROUP_LIMIT: Record<VoiceGroup, number> = { shot: 10, impact: 6, foley: 6, confirm: 2, env: 4 };

export interface PlayOptions {
  /** Seconds from now (keeps shots that fired in the same frame correctly spaced). */
  delay?: number;
  /** Linear gain before the master volume. */
  gain?: number;
  /** -1 (left) .. 1 (right). */
  pan?: number;
  /** ± random pitch/length variation (0.03 = ±3 %). */
  rateJitter?: number;
  group?: VoiceGroup;
  /** Low-pass cutoff (Hz): a distant sound loses its crack (absent = full range). */
  lowpass?: number;
  /** Send to the room reverb (0..1, linear; absent = dry only). */
  wet?: number;
}

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  group: VoiceGroup;
  ended: boolean;
  send: GainNode | null;
}

/**
 * Small Web Audio front end for effects.
 *
 * - All sounds are synthesised once into sample arrays shortly after start-up
 *   (spread over several tasks, during map loading), never during combat.
 * - The AudioContext is created on the first user gesture, as browsers require;
 *   until then nothing plays and nothing is logged.
 * - Voices are pooled per group with hard caps, and everything runs through a
 *   master gain (the volume setting) and a limiter so stacked shots never clip.
 */
export class AudioEngine {
  /** How many times each sound was started (debug / tests). */
  readonly playCount: Partial<Record<SoundId, number>> = {};
  /** Resolves when every sound has been synthesised. */
  readonly ready: Promise<void>;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly samples = new Map<SoundId, Float32Array[]>();
  private readonly buffers = new Map<SoundId, AudioBuffer[]>();
  private readonly lastVariant = new Map<SoundId, number>();
  private readonly voices: Voice[] = [];
  private volume: number;
  /** Shared room reverb: one input, an indoor and an outdoor response mixed by `setSpace`. */
  private roomIn: GainNode | null = null;
  private indoorMix: GainNode | null = null;
  private outdoorMix: GainNode | null = null;
  private indoor = 0;

  constructor(volume: number, renderOptions: { srFireInterval: number }) {
    this.volume = volume;
    this.ready = this.synthesise(renderOptions);
    const unlock = (): void => this.unlock();
    for (const type of ['pointerdown', 'keydown', 'touchend'] as const) window.addEventListener(type, unlock, { capture: true });
  }

  /** Voices currently playing (not counting ones already fading out). */
  get activeVoices(): number {
    let n = 0;
    for (const v of this.voices) if (!v.ended) n++;
    return n;
  }

  /** Every source node not yet released, fading ones included (leak checks). */
  get liveNodes(): number {
    return this.voices.length;
  }

  get state(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
  }

  /** Current audio clock (seconds), or 0 before the context exists. */
  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.masterGain(), this.ctx.currentTime, 0.02);
  }

  play(id: SoundId, opts: PlayOptions = {}): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running' || this.volume <= 0) return false;
    const variants = this.buffersFor(id);
    if (!variants) return false;

    const group = opts.group ?? 'foley';
    this.makeRoom(group);

    // Never the same variant twice in a row.
    let v = Math.floor(Math.random() * variants.length);
    if (variants.length > 1 && v === this.lastVariant.get(id)) v = (v + 1) % variants.length;
    this.lastVariant.set(id, v);

    const jitter = opts.rateJitter ?? 0;
    const source = ctx.createBufferSource();
    source.buffer = variants[v];
    source.playbackRate.value = 1 + (Math.random() * 2 - 1) * jitter;
    const gain = ctx.createGain();
    gain.gain.value = (opts.gain ?? 1) * (1 + (Math.random() * 2 - 1) * jitter * 2);
    let filter: BiquadFilterNode | null = null;
    if (opts.lowpass) {
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = opts.lowpass;
      source.connect(filter).connect(gain);
    } else {
      source.connect(gain);
    }
    let pan: StereoPannerNode | null = null;
    if (opts.pan) {
      pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, opts.pan));
      gain.connect(pan).connect(this.master);
    } else {
      gain.connect(this.master);
    }

    let send: GainNode | null = null;
    if (opts.wet && this.roomIn) {
      send = ctx.createGain();
      send.gain.value = Math.min(opts.wet, 1);
      gain.connect(send).connect(this.roomIn);
    }
    const voice: Voice = { source, gain, group, ended: false, send };
    this.voices.push(voice);
    source.onended = () => {
      voice.ended = true;
      source.disconnect();
      filter?.disconnect();
      gain.disconnect();
      pan?.disconnect();
      send?.disconnect();
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
    };
    source.start(ctx.currentTime + Math.max(0, opts.delay ?? 0));
    this.playCount[id] = (this.playCount[id] ?? 0) + 1;
    return true;
  }

  /**
   * Where the listener is: 0 = in the open, 1 = indoors (fractions while walking through a door).
   * Indoors the reverb is short and dense (walls close by); outside, long and thin with a late
   * slap off distant buildings. Faded, never switched.
   */
  setSpace(indoor: number): void {
    this.indoor = Math.min(Math.max(indoor, 0), 1);
    if (!this.ctx || !this.indoorMix || !this.outdoorMix) return;
    const t = this.ctx.currentTime;
    this.indoorMix.gain.setTargetAtTime(this.indoor * 0.9, t, 0.15);
    this.outdoorMix.gain.setTargetAtTime((1 - this.indoor) * 0.75, t, 0.15);
  }

  get space(): number {
    return this.indoor;
  }

  /** Quickly fades out every voice of a group (e.g. foley of a weapon put away). */
  stopGroup(group: VoiceGroup): void {
    for (const v of this.voices) if (v.group === group) this.fadeOut(v);
  }

  private makeRoom(group: VoiceGroup): void {
    let count = 0;
    for (const v of this.voices) if (v.group === group && !v.ended) count++;
    for (const v of this.voices) {
      if (count < GROUP_LIMIT[group]) break;
      if (v.group === group && !v.ended) {
        this.fadeOut(v);
        count--;
      }
    }
  }

  private fadeOut(v: Voice): void {
    if (v.ended || !this.ctx) return;
    v.ended = true; // no longer counts toward the group limit
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0, t, 0.008);
    try {
      v.source.stop(t + 0.05);
    } catch {
      // Already stopped.
    }
  }

  private masterGain(): number {
    return this.volume * 0.75;
  }

  private unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor({ latencyHint: 'interactive' });
      } catch {
        return;
      }
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -4;
      limiter.knee.value = 2;
      limiter.ratio.value = 16;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.12;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterGain();
      this.master.connect(limiter).connect(this.ctx.destination);
      // Room reverb (made once): indoor and outdoor responses, each through its own mix gain.
      this.roomIn = this.ctx.createGain();
      this.indoorMix = this.ctx.createGain();
      this.outdoorMix = this.ctx.createGain();
      const indoorVerb = this.ctx.createConvolver();
      const outdoorVerb = this.ctx.createConvolver();
      indoorVerb.buffer = roomResponse(this.ctx, 'indoor');
      outdoorVerb.buffer = roomResponse(this.ctx, 'outdoor');
      this.roomIn.connect(indoorVerb).connect(this.indoorMix).connect(this.master);
      this.roomIn.connect(outdoorVerb).connect(this.outdoorMix).connect(this.master);
      this.setSpace(this.indoor);
      for (const id of this.samples.keys()) this.buffersFor(id);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  /** AudioBuffers are made on first use from the pre-rendered samples (a plain copy, no decoding). */
  private buffersFor(id: SoundId): AudioBuffer[] | null {
    let list = this.buffers.get(id);
    if (list) return list;
    const data = this.samples.get(id);
    if (!data || !this.ctx) return null;
    list = data.map((d) => {
      const b = this.ctx!.createBuffer(1, d.length, SAMPLE_RATE);
      b.copyToChannel(d as Float32Array<ArrayBuffer>, 0);
      return b;
    });
    this.buffers.set(id, list);
    return list;
  }

  private async synthesise(renderOptions: { srFireInterval: number }): Promise<void> {
    for (const id of Object.keys(VARIANTS) as SoundId[]) {
      const list: Float32Array[] = [];
      for (let v = 0; v < VARIANTS[id]; v++) {
        // One variant per task so start-up never blocks the page for long.
        await new Promise((r) => setTimeout(r, 0));
        list.push(renderSound(id, v, renderOptions));
      }
      this.samples.set(id, list);
    }
    // Build every AudioBuffer now if the context already exists, so the first shot doesn't pay for it.
    if (this.ctx) for (const id of this.samples.keys()) this.buffersFor(id);
  }
}

/**
 * A synthesised room response (stereo, decorrelated): indoors 0.7 s of dense, dark reflections
 * (concrete rooms, close walls); outdoors 1.5 s, thin, with a few distinct slaps off buildings
 * further away. Made once when audio starts.
 */
function roomResponse(ctx: BaseAudioContext, kind: 'indoor' | 'outdoor'): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * (kind === 'indoor' ? 0.7 : 1.5));
  const buf = ctx.createBuffer(2, len, sr);
  let seed = kind === 'indoor' ? 1234 : 5678;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const n = rand() * 2 - 1;
      if (kind === 'indoor') {
        // Dense from the start, decaying fast; walls absorb the highs (one-pole low-pass ~3 kHz).
        lp += (n - lp) * 0.35;
        d[i] = lp * Math.exp(-t / 0.16) * (t < 0.004 ? t / 0.004 : 1) * 0.5;
      } else {
        // Sparse, dark, long: a quiet wash plus slaps at 120 / 260 / 470 ms.
        lp += (n - lp) * 0.12;
        d[i] = lp * Math.exp(-t / 0.5) * 0.18 * Math.min(t / 0.03, 1);
      }
    }
    if (kind === 'outdoor') {
      for (const [at, g] of [[0.12, 0.3], [0.26, 0.2], [0.47, 0.12]] as const) {
        const i0 = Math.floor((at + ch * 0.007) * sr);
        for (let k = 0; k < 220 && i0 + k < len; k++) d[i0 + k] += (rand() * 2 - 1) * g * Math.exp(-k / 60);
      }
    }
  }
  return buf;
}
