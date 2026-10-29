import { SAMPLE_RATE } from './dsp';
import { renderSound, VARIANTS, type SoundId } from './weaponSounds';

export type VoiceGroup = 'shot' | 'impact' | 'foley';

/** Most simultaneous voices per group; the oldest is faded out to make room. */
const GROUP_LIMIT: Record<VoiceGroup, number> = { shot: 10, impact: 6, foley: 6 };

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
}

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  group: VoiceGroup;
  ended: boolean;
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
    source.connect(gain);
    let pan: StereoPannerNode | null = null;
    if (opts.pan) {
      pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, opts.pan));
      gain.connect(pan).connect(this.master);
    } else {
      gain.connect(this.master);
    }

    const voice: Voice = { source, gain, group, ended: false };
    this.voices.push(voice);
    source.onended = () => {
      voice.ended = true;
      source.disconnect();
      gain.disconnect();
      pan?.disconnect();
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
    };
    source.start(ctx.currentTime + Math.max(0, opts.delay ?? 0));
    this.playCount[id] = (this.playCount[id] ?? 0) + 1;
    return true;
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
