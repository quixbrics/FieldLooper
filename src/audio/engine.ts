/*
 * The audio engine: one AudioContext, the microphone, the loop, and the FX
 * chain. The graph itself is built in graph.ts, the chain's slots in units.ts.
 *
 *   mic ─► fs-capture (raw PCM, meter) ─► [taken while recording]
 *   looper ─► level ─┬─► dry ─────────────────┐
 *                    └─► CHAIN ─► wet ────────┴─► master ─► fxm-safety ─► out ─► fs-tap (Performance Record)
 *
 * The context is created inside the first tap (iOS refuses otherwise), and the
 * mic request is fired in that same tap, in parallel with loading the DSP.
 *
 * The engine still speaks of "track 0" in places (the record, buffer and
 * parameter calls take a track index), but there is exactly one loop.
 */
import { ensureWorklets, workletNode } from './worklets';
import { MAX_SECONDS, computePeaks, concat, layerInto, normalise, peakOf, prepareLoop, repairSpeed, resampleTo, toMono } from './loopfx';
import { buildGraph, masterGains, type GraphNodes, type TrackNodes } from './graph';
import type { SlotNode } from './units';
import { AutoRecorder, loopPhase, valuesAt } from './automation';
import { WavStream } from './wav';
import { Sequencer, type SeqSettings, type Step } from '../music/sequencer';
import { MAX_AUTO_SECONDS, MAX_SLOTS, cloneSlots, newSlot, readSlot, type Automation, type Slot } from '../fx/slot';
import { COST_BUDGET, costOf, fxDef, toNorm } from '../fx/registry';

/** One loop. */
export const TRACKS = 1;
export type EngineKind = 'spectral' | 'granular' | 'tape';
/** A loop is a list of channels; mic takes are mono. */
export type Loop = Float32Array[];

export const trackName = (_i: number): string => 'Loop';

/** Per-mode sound controls. Each mode keeps its own, so switching modes never loses a setting. */
export interface TapeSound {
  /** slow speed drift 0–1 */
  wow: number;
  /** fast speed wobble 0–1 */
  flutter: number;
  /** tape saturation 0–1 */
  drive: number;
  /** high-frequency loss 0–1 */
  age: number;
  /** tape noise 0–1 */
  hiss: number;
}
export interface SpectralSound {
  /** log2 of the FFT frame (11–15): small = soft and quick, large = fine detail and slow */
  window: number;
  /** stereo width of the random phases 0–1 */
  spread: number;
  /** −1 dark … +1 bright */
  tilt: number;
  /** 0 diffuse … 0.5 as the source … 1 tonal */
  focus: number;
}
export interface GranularSound {
  /** ms */
  grain: number;
  /** grains per second */
  density: number;
  /** position scatter 0–1 */
  jitter: number;
  /** pitch scatter, semitones */
  spray: number;
  spread: number;
  /** 0 percussive … 1 smooth */
  shape: number;
  /** chance a grain plays backwards 0–1 */
  grev: number;
}
export interface SoundState {
  tape: TapeSound;
  spectral: SpectralSound;
  granular: GranularSound;
}
export const defaultSound = (): SoundState => ({
  tape: { wow: 0, flutter: 0, drive: 0, age: 0, hiss: 0 },
  spectral: { window: 13, spread: 0.6, tilt: 0, focus: 0.5 },
  granular: { grain: 120, density: 24, jitter: 0.2, spray: 0, spread: 0.6, shape: 1, grev: 0 },
});
/** the Focus slider (0–1, middle = unchanged) → the spectrum power law the DSP uses */
export const focusToContrast = (f: number): number => (f < 0.5 ? 0.5 + f : 1 + (f - 0.5) * 3);

export interface TrackState {
  engine: EngineKind;
  stretch: number;
  /** seconds a stretch change takes to arrive (0 = instant); on tape it is the motor's inertia */
  glide: number;
  /** semitones, −24…+24 (shown even when linked to the stretch) */
  pitch: number;
  /**
   * Pitch and stretch move together, as on tape, where slowing the reel drops the pitch.
   * On: pitch follows stretch (−12 st per doubling) and the pitch slider follows too.
   * Off: they are independent (what Spectral and Granular are for).
   */
  link: boolean;
  reverse: boolean;
  freeze: boolean;
  start: number;
  end: number;
  level: number;
  /** recording layers over the loop instead of replacing it */
  overdub: boolean;
  /** how much of the old loop survives an overdub (1 = all of it) */
  keep: number;
  sound: SoundState;
  /** length of the loop in seconds; 0 = empty */
  seconds: number;
}

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
/** MIDI note of a root + octave (octave 3, A = 57 = A3 = 220 Hz) */
export const noteOf = (root: number, octave: number): number => 12 * (octave + 1) + root;

/** What a saved project holds (the audio is stored beside it). */
export interface ProjectData {
  app: 'FieldLooper';
  v: 1;
  sampleRate: number;
  masterLevel: number;
  track: Omit<TrackState, 'seconds'>;
  chain: Slot[];
  /** master Wet/Dry */
  wet: number;
  seq: SeqSettings & { rate: number };
  /** the resonator slot the sequencer plays (null = the first one) */
  seqTarget: string | null;
}

/** What happened to the most recent take (shown in Settings, to diagnose a wrong-speed recording). */
export interface TakeInfo {
  heardSeconds: number;
  realSeconds: number;
  /** 1 = fine; otherwise the speed error that was repaired */
  repaired: number;
}

/** longest Performance Record (written to 24-bit PCM as it arrives, ~17 MB a minute) */
export const MAX_PERF_SECONDS = 600;
/** the Performance Record timer warns from here */
export const PERF_WARN_SECONDS = 540;

const num = (v: unknown, lo: number, hi: number, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);

export interface SeqState {
  on: boolean;
  /** seconds per step */
  rate: number;
}
/** How far ahead notes are handed to the audio thread (so a throttled timer never drops a step). */
const LOOKAHEAD = 1.2;
/** How often the main thread moves the automation it is responsible for (native effects, slot wet/dry, sliders). */
const AUTO_HZ = 30;

export interface EngineEvents {
  level(peak: number): void;
  /** playhead (0–1 of the loop) and the real speed it is moving at (1 = normal, negative = reverse) */
  pos(track: number, v: number, rate: number): void;
  limiter(grDb: number, peakDb: number): void;
  ctxState(state: string): void;
  recTime(track: number, seconds: number): void;
  recAutoStop(track: number): void;
  blowup(): void;
  /** the loop's stretch, pitch, link or mode changed from code (so the sliders must follow) */
  trackParams(track: number): void;
  /** the loop's audio was loaded, replaced or cleared */
  track(track: number): void;
  /** the whole state was replaced (project opened, preset applied, new project): rebuild the UI */
  project(): void;
  /** slots were added, removed, reordered or switched (rebuild the chain view) */
  chain(): void;
  /** where each automated slot is: loop phase 0–1 and its automated values (~30 Hz, for the sliders) */
  auto(frame: Map<string, { phase: number; values: Record<string, number> }>): void;
  /** a slot was armed or disarmed for automation, or its recording state changed */
  armed(id: string | null): void;
  /** Performance Record progress, seconds */
  perfTime(seconds: number): void;
  /** Performance Record hit its length limit */
  perfAutoStop(): void;
}

type SceneSound = { tape?: Partial<TapeSound>; spectral?: Partial<SpectralSound>; granular?: Partial<GranularSound> };
export type PresetTrack = Partial<Omit<TrackState, 'seconds' | 'start' | 'end' | 'sound'>> & { sound?: SceneSound };
/** A preset slot: an effect and any settings that differ from its defaults. */
export type PresetSlot = { type: string; on?: boolean; mix?: number; p?: Record<string, number>; auto?: Automation | null };

/** A starting point: the loop's settings and a whole chain (the recording stays). */
export interface Preset {
  name: string;
  blurb: string;
  track?: PresetTrack;
  chain: PresetSlot[];
  wet?: number;
  seq?: Partial<SeqSettings & { rate: number }>;
  seqOn?: boolean;
  /** saved by the user (can be deleted) */
  user?: boolean;
}

export type RecResult = { ok: true } | { ok: false; reason: 'short' | 'quiet' | 'idle' };

/** Stretch limits (a stretch below 1 plays faster than normal). */
export const MIN_STRETCH = 0.25;
export const MAX_STRETCH = 1000;
const clampStretch = (s: number) => Math.min(MAX_STRETCH, Math.max(MIN_STRETCH, s));

/** The pitch change that goes with a stretch on tape: −12 semitones per doubling, shown within ±24. */
export const pitchOfStretch = (stretch: number): number => Math.max(-24, Math.min(24, -12 * Math.log2(stretch)));
/** The stretch that goes with a pitch on tape. */
export const stretchOfPitch = (pitch: number): number => clampStretch(Math.pow(2, -pitch / 12));

/**
 * The pitch shift the audio engine is given. Linked on TAPE, the speed is simply 1 ÷ stretch (so the
 * pitch already follows it; nothing is added). Linked on Spectral or Granular, the pitch follows the
 * stretch the way tape's does. Unlinked, the pitch is whatever is set, independent of the stretch.
 */
export function effectivePitch(t: Pick<TrackState, 'link' | 'engine' | 'stretch' | 'pitch'>): number {
  if (!t.link) return t.pitch;
  return t.engine === 'tape' ? 0 : pitchOfStretch(t.stretch);
}

/** The loop starts plain, at normal speed (tape at 1×, pitch and stretch linked). */
const defaultTrack = (): TrackState => ({
  engine: 'tape',
  stretch: 1,
  glide: 0,
  pitch: 0,
  link: true,
  reverse: false,
  freeze: false,
  start: 0,
  end: 1,
  level: 0.8,
  overdub: false,
  keep: 1,
  sound: defaultSound(),
  seconds: 0,
});

const mergeSound = (base: SoundState, patch: SceneSound | undefined): SoundState => ({
  tape: { ...base.tape, ...patch?.tape },
  spectral: { ...base.spectral, ...patch?.spectral },
  granular: { ...base.granular, ...patch?.granular },
});

/** Read a sound block from a saved file: anything missing or out of range falls back to the default. */
function readSound(src: unknown): SoundState {
  const d = defaultSound();
  const s = (src ?? {}) as { tape?: Partial<TapeSound>; spectral?: Partial<SpectralSound>; granular?: Partial<GranularSound> };
  const t = s.tape ?? {};
  const sp = s.spectral ?? {};
  const g = s.granular ?? {};
  return {
    tape: { wow: num(t.wow, 0, 1, d.tape.wow), flutter: num(t.flutter, 0, 1, d.tape.flutter), drive: num(t.drive, 0, 1, d.tape.drive), age: num(t.age, 0, 1, d.tape.age), hiss: num(t.hiss, 0, 1, d.tape.hiss) },
    spectral: { window: Math.round(num(sp.window, 11, 15, d.spectral.window)), spread: num(sp.spread, 0, 1, d.spectral.spread), tilt: num(sp.tilt, -1, 1, d.spectral.tilt), focus: num(sp.focus, 0, 1, d.spectral.focus) },
    granular: {
      grain: num(g.grain, 10, 1000, d.granular.grain),
      density: num(g.density, 1, 200, d.granular.density),
      jitter: num(g.jitter, 0, 1, d.granular.jitter),
      spray: num(g.spray, 0, 12, d.granular.spray),
      spread: num(g.spread, 0, 1, d.granular.spread),
      shape: num(g.shape, 0, 1, d.granular.shape),
      grev: num(g.grev, 0, 1, d.granular.grev),
    },
  };
}

/** The chain's estimated load, 0–1 of the budget. */
export function chainLoad(slots: Pick<Slot, 'type' | 'on'>[]): number {
  return slots.reduce((a, s) => a + (s.on ? costOf(s.type) : 0), 0) / COST_BUDGET;
}

/** A control's value mapped onto 0..1 (so automation is thinned evenly whatever the units). */
function scaleFor(type: string, key: string): (x: number) => number {
  const q = fxDef(type)?.params.find((p) => p.key === key);
  return q ? (x) => toNorm(q, x) : (x) => x;
}

type AudioSessionNav = Navigator & { audioSession?: { type: string } };
/** the iOS audio session types this app uses */
type SessionType = 'playback' | 'play-and-record';
type Wake = { release(): Promise<void> };

export class Engine {
  ctx: AudioContext | null = null;
  events: Partial<EngineEvents> = {};
  tracks: TrackState[] = [defaultTrack()];
  /** the FX chain, in signal order */
  chain: Slot[] = [];
  /** master Wet/Dry: 0 = only the loop, 1 = only what comes out of the chain */
  wet = 1;
  seq: SeqState = { on: false, rate: 3 };
  /** the resonator slot the sequencer plays (null = the first one in the chain) */
  seqTarget: string | null = null;
  sequencer = new Sequencer({ scale: 'dorian', motion: 'drift', range: 2, chance: 0.85, chordSize: 0, seed: 1 });
  /** waveform peaks (null = empty) */
  peaks: (Float32Array | null)[] = [null];
  /** the loop audio itself, kept for saving, redraw and layering */
  loops: (Loop | null)[] = [null];
  /** last reported playhead, 0–1 (where an overdub lands) */
  lastPos: number[] = [0];
  playing = true;
  masterLevel = 0.85;
  micError: string | null = null;
  recTrack = -1;
  /** a Performance Record is running */
  performing = false;
  /** the slot armed for automation recording (null = none) */
  armedId: string | null = null;
  /** audio-path facts for the Settings sheet */
  diag: { ctxRate: number; micRate: number | null; take: TakeInfo | null; session: string } = { ctxRate: 0, micRate: null, take: null, session: 'n/a' };

  private g: GraphNodes | null = null;
  private capture: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private micSrc: MediaStreamAudioSourceNode | null = null;
  private startP: Promise<boolean> | null = null;
  private chunks: Float32Array[] = [];
  private recSamples = 0;
  private recDone: (() => void) | null = null;
  private recOverdub = false;
  private recOffset = 0;
  private recWall0 = 0;
  private wake: Wake | null = null;
  private starting: Promise<void> | null = null;
  private seqTimer = 0;
  private seqNext = 0;
  private seqLast = 0;
  /** a tapped note is holding the resonator off the Key setting */
  private manualNote = false;
  private seqLog: { at: number; step: Step }[] = [];
  /** the slot node the sequencer is currently driving (to hand the Key back when that changes) */
  private seqNode: SlotNode | null = null;
  private fxListeners = new Set<() => void>();
  private changeListeners = new Set<(audioTrack?: number) => void>();
  private tap: AudioWorkletNode | null = null;
  private perf: WavStream | null = null;
  private tapDone: (() => void) | null = null;
  /** when each slot's automation loop began (context seconds) */
  private autoStart = new Map<string, number>();
  /** the recording in progress on the armed slot */
  private recorder: AutoRecorder | null = null;
  /** controls a finger is on, per slot (the hand wins while held) */
  private held = new Map<string, Set<string>>();
  private autoTimer = 0;

  /** Subscribe to any state change (autosave). `audioTrack` is set when the loop's audio changed. */
  onChange(fn: (audioTrack?: number) => void): void {
    this.changeListeners.add(fn);
  }
  private touch(audioTrack?: number) {
    for (const l of this.changeListeners) l(audioTrack);
  }
  /** Drop UI subscriptions before the UI is rebuilt. */
  clearUiListeners() {
    this.fxListeners.clear();
  }
  /** UI hook: runs whenever a slot or sequencer value changes (to keep duplicate controls in step). Dropped when `signal` aborts. */
  onFxChange(fn: () => void, signal?: AbortSignal): void {
    this.fxListeners.add(fn);
    signal?.addEventListener('abort', () => this.fxListeners.delete(fn));
  }
  private fxChanged() {
    for (const l of this.fxListeners) l();
  }

  get started(): boolean {
    return this.g !== null;
  }
  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }
  /** a tapped note is holding the resonator (the sequencer is off) */
  get holding(): boolean {
    return this.manualNote;
  }
  get micOpen(): boolean {
    return this.stream !== null;
  }
  /** estimated chain load, 0–1 of the budget */
  get load(): number {
    return chainLoad(this.chain);
  }

  /** Must be called from a tap. Safe to call again (e.g. to resume). */
  start(): Promise<void> {
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume();
    if (!this.starting) this.starting = this.boot();
    return this.starting;
  }

  private async boot(): Promise<void> {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.diag.ctxRate = ctx.sampleRate;
    ctx.onstatechange = () => this.events.ctxState?.(ctx.state);
    void ctx.resume();
    // ask for the microphone now, inside the tap, in parallel with DSP loading. The audio session is
    // deliberately left alone until this has been answered: iOS will not capture in a plain-playback session.
    const micP = this.askMic();
    await ensureWorklets(ctx);

    const t = this.tracks[0];
    this.g = buildGraph(
      ctx,
      {
        tracks: [{ params: this.looperParams(t), seed: 1000, mute: this.muteGain(0), gain: t.level ** 2 }],
        master: this.masterLevel ** 2,
        report: true,
      },
      {
        safety: (m) => {
          if (m.type === 'meter') this.events.limiter?.(m.gr ?? 0, m.peak ?? 0);
        },
        looper: (i, m) => {
          if (m.type === 'pos') {
            this.lastPos[i] = m.v ?? 0;
            this.events.pos?.(i, m.v ?? 0, m.r ?? 0);
          }
        },
        blowup: () => this.events.blowup?.(),
        slotCreated: (n, s) => this.slotCreated(n, s),
      },
    );
    // a project restored before the context existed: build its chain now
    this.syncChain();
    this.autoTimer = window.setInterval(() => this.autoTick(), 1000 / AUTO_HZ);

    this.createCapture(ctx);
    const stream = await micP;
    // Permission is now granted for this page, so let the microphone go at once: an open microphone is what makes
    // iOS treat the page like a phone call and use the earpiece. It is opened again for each take.
    stream?.getTracks().forEach((tr) => tr.stop());
    // now plain playback: the main speaker, and the silent switch does not mute us
    this.setSession('playback');
    this.events.ctxState?.(ctx.state);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && ctx.state !== 'running') void ctx.resume();
    });
  }

  /* ------------------------------------------------------- graph state -- */

  private muteGain(i: number): number {
    // the loop goes quiet while it is being re-recorded (not while overdubbing)
    return this.recTrack === i && !this.recOverdub ? 0 : 1;
  }

  private looperParams(t: TrackState): Record<string, number | string> {
    const s = t.sound;
    return {
      engine: t.engine,
      stretch: t.stretch,
      glide: t.glide,
      pitch: effectivePitch(t),
      reverse: t.reverse ? 1 : 0,
      freeze: t.freeze ? 1 : 0,
      start: t.start,
      end: t.end,
      playing: this.playing && t.seconds > 0 ? 1 : 0,
      // tape
      wow: s.tape.wow,
      flutter: s.tape.flutter,
      drive: s.tape.drive,
      age: s.tape.age,
      hiss: s.tape.hiss,
      // spectral and granular both use `spread`; send the one for the mode in use
      window: s.spectral.window,
      tilt: s.spectral.tilt,
      contrast: focusToContrast(s.spectral.focus),
      spread: t.engine === 'granular' ? s.granular.spread : s.spectral.spread,
      // granular
      grain: s.granular.grain,
      density: s.granular.density,
      jitter: s.granular.jitter,
      spray: s.granular.spray,
      shape: s.granular.shape,
      grev: s.granular.grev,
    };
  }

  /* -------------------------------------------------------------- chain -- */

  slot(id: string): Slot | undefined {
    return this.chain.find((s) => s.id === id);
  }

  /** Can another effect of this type go in (slot count and load budget)? */
  canAdd(type: string): boolean {
    return this.chain.length < MAX_SLOTS && this.load + costOf(type) / COST_BUDGET <= 1.0001;
  }

  /** Add an effect at the end of the chain (or at `index`). Returns the new slot, or null if the chain is full. */
  addSlot(type: string, index = this.chain.length): Slot | null {
    if (!this.canAdd(type)) return null;
    const s = newSlot(type);
    this.chain.splice(Math.max(0, Math.min(this.chain.length, index)), 0, s);
    this.chainChanged();
    return s;
  }

  removeSlot(id: string) {
    const i = this.chain.findIndex((s) => s.id === id);
    if (i < 0) return;
    if (this.armedId === id) this.disarm(false);
    if (this.seqNode && this.g?.chain.node(id) === this.seqNode) this.seqNode = null;
    this.chain.splice(i, 1);
    this.autoStart.delete(id);
    this.held.delete(id);
    if (this.seqTarget === id) this.seqTarget = null;
    this.chainChanged();
  }

  /** Move a slot to a new place in the signal chain. */
  moveSlot(id: string, to: number) {
    const i = this.chain.findIndex((s) => s.id === id);
    if (i < 0) return;
    const j = Math.max(0, Math.min(this.chain.length - 1, to));
    if (i === j) return;
    const [s] = this.chain.splice(i, 1);
    this.chain.splice(j, 0, s);
    this.chainChanged();
  }

  setSlotOn(id: string, on: boolean) {
    const s = this.slot(id);
    if (!s || s.on === on) return;
    s.on = on;
    this.chainChanged();
  }

  setSlotMix(id: string, mix: number) {
    const s = this.slot(id);
    if (!s) return;
    s.mix = Math.min(1, Math.max(0, mix));
    this.recordMove(id, 'mix', s.mix);
    this.g?.chain.node(id)?.update(s);
    this.touch();
    this.fxChanged();
  }

  setSlotParam(id: string, key: string, v: number) {
    const s = this.slot(id);
    if (!s) return;
    s.p[key] = v;
    this.recordMove(id, key, v);
    this.g?.chain.node(id)?.update(s);
    this.touch();
    this.fxChanged();
    // the resonator's Key while the sequencer is playing it: re-plan from the new key
    if (s.type === 'resonator' && (key === 'root' || key === 'octave') && this.seqSlot()?.id === id) {
      this.manualNote = false;
      if (this.seq.on) this.seqReschedule(true);
      else this.applyNoteOwnership();
    }
  }

  /** Master Wet/Dry: 0 = only the loop, 1 = only what comes out of the chain. */
  setWet(v: number) {
    this.wet = Math.min(1, Math.max(0, v));
    this.touch();
    this.fxChanged();
    this.applyWet();
  }

  private applyWet() {
    if (!this.ctx || !this.g) return;
    const gains = masterGains(this.wet, this.chain.some((s) => s.on));
    const now = this.ctx.currentTime;
    this.g.dry.gain.setTargetAtTime(gains.dry, now, 0.02);
    this.g.wet.gain.setTargetAtTime(gains.wet, now, 0.02);
  }

  /** The slot list changed shape: bring the audio graph and the views in line. */
  private chainChanged() {
    this.syncChain();
    this.touch();
    this.fxChanged();
    this.events.chain?.();
  }

  private syncChain() {
    if (!this.g) return;
    this.g.chain.sync(this.chain);
    this.applyWet();
    this.applyNoteOwnership();
  }

  /** A slot's audio node was just made: give it its automation. */
  private slotCreated(n: SlotNode, s: Slot) {
    if (s.auto) this.pushAuto(s, n);
  }

  /* --------------------------------------------------------- automation -- */

  /** Is this slot's automation loop running, and where (0–1)? */
  autoPhase(id: string): number | null {
    const s = this.slot(id);
    const st = this.autoStart.get(id);
    if (!s?.auto || st === undefined || !this.ctx) return null;
    return loopPhase(this.ctx.currentTime, st, s.auto.len) / s.auto.len;
  }

  /** seconds recorded so far on the armed slot (a fresh recording), or null */
  armedElapsed(): number | null {
    if (!this.recorder || this.recorder.punch || !this.ctx) return null;
    return this.recorder.t0 === null ? 0 : this.recorder.elapsed(this.ctx.currentTime);
  }

  /** Is the armed slot punching in over existing automation? */
  get punching(): boolean {
    return !!this.recorder?.punch;
  }

  /** Hand a slot's automation to the audio side, starting its loop now (or from `start`). */
  private pushAuto(s: Slot, n = this.g?.chain.node(s.id), start?: number) {
    if (!this.ctx) return;
    if (!s.auto) {
      this.autoStart.delete(s.id);
      n?.sendAuto(null, 0);
      return;
    }
    const st = start ?? this.autoStart.get(s.id) ?? this.ctx.currentTime;
    this.autoStart.set(s.id, st);
    n?.sendAuto(s.auto, Math.round(st * this.ctx.sampleRate));
    // a finger already on a control keeps winning
    for (const k of this.held.get(s.id) ?? []) n?.hold(k, true);
  }

  /** Arm a slot to record automation (disarming any other). Arming a slot that already loops punches in. */
  arm(id: string) {
    const s = this.slot(id);
    if (!s || !this.ctx) return;
    if (this.armedId) this.disarm(true);
    this.armedId = id;
    this.recorder = new AutoRecorder(s.auto, this.autoStart.get(id) ?? this.ctx.currentTime, (key) => scaleFor(s.type, key));
    this.events.armed?.(id);
  }

  /** Stop recording. `keep` closes a fresh recording into a loop (false throws it away). */
  disarm(keep = true) {
    const id = this.armedId;
    const rec = this.recorder;
    this.armedId = null;
    this.recorder = null;
    if (id && rec && keep && this.ctx) {
      const s = this.slot(id);
      if (s && !rec.punch) {
        const auto = rec.finish(this.ctx.currentTime);
        if (auto) {
          s.auto = auto;
          // the loop began when the first control was touched, so it carries straight on from its top
          this.pushAuto(s, undefined, rec.t0 ?? this.ctx.currentTime);
          this.touch();
        }
      }
    }
    this.events.armed?.(null);
    this.fxChanged();
  }

  clearAuto(id: string) {
    const s = this.slot(id);
    if (!s) return;
    if (this.armedId === id) this.disarm(false);
    s.auto = null;
    this.pushAuto(s);
    this.touch();
    this.fxChanged();
  }

  /** A finger went down on one of a slot's controls. */
  grab(id: string, key: string) {
    const s = this.slot(id);
    if (!s || !this.ctx) return;
    let set = this.held.get(id);
    if (!set) this.held.set(id, (set = new Set()));
    set.add(key);
    this.g?.chain.node(id)?.hold(key, true);
    if (this.armedId === id && this.recorder) this.recorder.down(key, this.ctx.currentTime, key === 'mix' ? s.mix : s.p[key]);
    if (this.armedId === id) this.events.armed?.(id);
  }

  /** The finger left the control: automation takes over again from where its loop is. */
  release(id: string, key: string) {
    const s = this.slot(id);
    this.held.get(id)?.delete(key);
    if (!s) return;
    if (this.armedId === id && this.recorder) {
      const merged = this.recorder.up(key, key === 'mix' ? s.mix : s.p[key]);
      if (merged) {
        s.auto = merged;
        this.pushAuto(s);
        this.touch();
      }
    }
    this.g?.chain.node(id)?.hold(key, false);
  }

  private recordMove(id: string, key: string, v: number) {
    if (this.armedId !== id || !this.recorder || !this.ctx) return;
    const now = this.ctx.currentTime;
    if (!this.recorder.punch && this.recorder.elapsed(now) >= MAX_AUTO_SECONDS) {
      this.disarm(true);
      return;
    }
    this.recorder.move(key, now, v);
  }

  /** ~30 Hz: native effects and slot wet/dry follow their automation; the sliders are told where everything is. */
  private autoTick() {
    if (!this.ctx || !this.g) return;
    const now = this.ctx.currentTime;
    const frame = new Map<string, { phase: number; values: Record<string, number> }>();
    for (const s of this.chain) {
      const st = this.autoStart.get(s.id);
      if (!s.auto || st === undefined) continue;
      const ph = loopPhase(now, st, s.auto.len);
      const held = this.held.get(s.id);
      const values = valuesAt(s.auto, ph, held);
      frame.set(s.id, { phase: ph / s.auto.len, values });
      const n = this.g.chain.node(s.id);
      if (!n) continue;
      if ('mix' in values) n.setMix(values.mix);
      if (!n.isWorklet) {
        const { mix: _m, ...rest } = values;
        if (Object.keys(rest).length) n.setNative(s, rest);
      }
    }
    if (this.armedId && this.recorder && !this.recorder.punch && this.recorder.elapsed(now) >= MAX_AUTO_SECONDS) this.disarm(true);
    this.events.auto?.(frame);
  }

  /* ---------------------------------------------------------- sequencer -- */

  /** The resonator the sequencer plays: the chosen one, else the first in the chain. */
  seqSlot(): Slot | null {
    const chosen = this.seqTarget ? this.slot(this.seqTarget) : undefined;
    if (chosen?.type === 'resonator') return chosen;
    return this.chain.find((s) => s.type === 'resonator') ?? null;
  }

  private resoNode(): SlotNode | null {
    const s = this.seqSlot();
    return (s && this.g?.chain.node(s.id)) || null;
  }

  setSeqTarget(id: string | null) {
    this.seqTarget = id;
    this.touch();
    if (this.seq.on) this.setSeqOn(true);
    else this.applyNoteOwnership();
    this.fxChanged();
  }

  /** While the sequencer (or a tapped note) is playing a resonator, that resonator's Key is not sent to it. */
  private applyNoteOwnership() {
    if (!this.g) return;
    const s = this.seqSlot();
    const n = s ? this.g.chain.node(s.id) ?? null : null;
    const owned = this.seq.on || this.manualNote;
    if (this.seqNode && this.seqNode !== n) {
      // the sequencer moved off a resonator: give it back its own Key and chord
      const old = this.chain.find((x) => this.g!.chain.node(x.id) === this.seqNode);
      this.seqNode.message({ type: 'clear' });
      this.seqNode.message({ type: 'chord' });
      if (old) this.seqNode.setNoteOwned(false, old);
      this.seqNode = null;
    }
    if (s && n) {
      n.setNoteOwned(owned, s);
      this.seqNode = owned ? n : null;
    }
  }

  setSeqOn(on: boolean) {
    this.seq.on = on;
    this.manualNote = false;
    window.clearInterval(this.seqTimer);
    this.applyNoteOwnership();
    const reso = this.resoNode();
    if (this.ctx && reso) {
      reso.message({ type: 'clear' });
      this.seqLog = [];
      if (on) {
        // sound the current note first, then step on from there
        const at = this.ctx.currentTime + 0.05;
        this.sendStep(this.sequencer.describe(this.sequencer.index), at, 0);
        this.seqLast = at;
        this.seqNext = at + this.seq.rate;
        this.seqTimer = window.setInterval(() => this.seqTick(), 120);
        this.seqTick();
      } else reso.message({ type: 'chord' }); // back to the Key setting and chord shape, gliding there
    }
    this.fxChanged();
  }

  updateSeq(patch: Partial<SeqSettings> & { rate?: number }) {
    const { rate, ...settings } = patch;
    if (rate !== undefined) this.seq.rate = rate;
    Object.assign(this.sequencer.s, settings);
    this.touch();
    if (patch.range !== undefined || patch.scale !== undefined) this.sequencer.set(Math.min(this.sequencer.index, this.sequencer.max));
    this.fxChanged();
    if (this.seq.on) this.seqReschedule(patch.scale !== undefined || patch.chordSize !== undefined || patch.range !== undefined);
    else if (patch.chordSize !== undefined && this.g && this.manualNote) this.seqSet(this.sequencer.index);
  }

  /** a new seed: a new line, from the tonic */
  reseed(seed = Math.floor(Math.random() * 1e6)) {
    this.sequencer.reseed(seed);
    this.touch();
    this.fxChanged();
    if (this.seq.on) this.seqReschedule(true);
  }

  /** Play a scale note now (a tapped note); it holds until the sequencer moves on. */
  seqSet(index: number) {
    if (!this.ctx || !this.resoNode()) return;
    const step = this.sequencer.set(index);
    if (!this.seq.on) {
      this.manualNote = true;
      this.applyNoteOwnership();
    } else this.seqReschedule(false);
    this.sendStep(step, this.ctx.currentTime + 0.02, 0);
    this.fxChanged();
  }

  /** Drop what is queued and re-plan from the current settings. `replay` re-sounds the current note. */
  private seqReschedule(replay: boolean) {
    const reso = this.resoNode();
    if (!this.ctx || !reso) return;
    const now = this.ctx.currentTime;
    reso.message({ type: 'clear' });
    this.seqLog = this.seqLog.filter((e) => e.at <= now);
    this.seqNext = Math.max(now + 0.05, this.seqLast + this.seq.rate);
    if (replay) {
      const at = now + 0.03;
      this.sendStep(this.sequencer.describe(this.sequencer.index), at, 0);
      this.seqNext = Math.max(this.seqNext, at + this.seq.rate);
      this.seqLast = at;
    }
  }

  private seqTick() {
    if (!this.seq.on || !this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.seqNext < now) this.seqNext = now + 0.05;
    while (this.seqNext < now + LOOKAHEAD) {
      const step = this.sequencer.next();
      if (step) this.sendStep(step, this.seqNext, 0);
      this.seqLast = this.seqNext;
      this.seqNext += this.seq.rate;
    }
    this.seqLog = this.seqLog.filter((e) => e.at > now - 10);
  }

  /** The tonic the sequencer walks from: the target resonator's Key and Octave. */
  private tonic(): number {
    const s = this.seqSlot();
    return s ? noteOf(Math.round(s.p.root), Math.round(s.p.octave)) : 57;
  }

  private sendStep(step: Step, at: number, pluck: number) {
    const reso = this.resoNode();
    if (!this.ctx || !reso) return;
    reso.message({
      type: 'note',
      frame: Math.round(at * this.ctx.sampleRate),
      note: this.tonic() + step.semis,
      offsets: step.offsets,
      pluck,
    });
    this.seqLog.push({ at, step });
  }

  /** The step that is sounding right now (for the display). */
  currentStep(): Step | null {
    if (!this.ctx) return null;
    const now = this.ctx.currentTime;
    let cur: Step | null = null;
    for (const e of this.seqLog) if (e.at <= now) cur = e.step;
    return cur;
  }

  /* --------------------------------------------------------------- mic -- */

  private async askMic(): Promise<MediaStream | null> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot reach the microphone.');
      // all three processors OFF: on iOS they make the mic behave like a phone call
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (e) {
      const err = e as DOMException;
      this.micError =
        err.name === 'NotAllowedError'
          ? 'Microphone access was declined. You can still load sounds from your files.'
          : err.message || 'No microphone available.';
      return null;
    }
  }

  /** The capture node exists for the life of the page; the microphone is connected to it only while open. */
  private createCapture(ctx: AudioContext) {
    const cap = workletNode(ctx, 'fs-capture', {}, 1, 1);
    cap.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'level') this.events.level?.(m.peak);
      else if (m.type === 'chunk') this.onChunk(m.data as Float32Array);
      else if (m.type === 'recStopped') this.recDone?.();
    };
    // the capture node outputs silence; it is wired to the destination only so it keeps running
    const mute = ctx.createGain();
    mute.gain.value = 0;
    cap.connect(mute).connect(ctx.destination);
    this.capture = cap;
  }

  /** Tell iOS what kind of audio session this is (16.4+; elsewhere there is nothing to set). */
  private setSession(type: SessionType) {
    const nav = navigator as AudioSessionNav;
    try {
      if (nav.audioSession) nav.audioSession.type = type;
      this.diag.session = nav.audioSession ? nav.audioSession.type : 'not supported';
    } catch {
      this.diag.session = 'not supported';
    }
  }

  private useStream(stream: MediaStream) {
    if (!this.ctx || !this.capture) return;
    this.stream = stream;
    this.diag.micRate = stream.getAudioTracks()[0]?.getSettings().sampleRate ?? null;
    this.micSrc = this.ctx.createMediaStreamSource(stream);
    this.micSrc.connect(this.capture);
    // if iOS or the user ends the mic stream, say so instead of recording silence
    for (const tr of stream.getAudioTracks())
      tr.addEventListener('ended', () => {
        if (this.stream !== stream) return; // we closed it ourselves
        this.stream = null;
        this.micSrc = null;
        this.micError = 'The microphone was disconnected.';
      });
  }

  /** Open the microphone if it is not already open. */
  private async openMic(): Promise<boolean> {
    if (this.stream) return true;
    // the call-style session is the one iOS records in; it must be set BEFORE the request
    this.setSession('play-and-record');
    const stream = await this.askMic();
    if (!stream) {
      this.setSession('playback');
      return false;
    }
    this.micError = null;
    this.useStream(stream);
    return true;
  }

  /** Let the microphone go and put the session back to plain playback (the main speaker). */
  private closeMic() {
    this.micSrc?.disconnect();
    this.micSrc = null;
    const s = this.stream;
    this.stream = null;
    s?.getTracks().forEach((t) => t.stop());
    this.setSession('playback');
    this.events.level?.(0);
  }

  /* ------------------------------------------------------------ record -- */

  /**
   * Record the mic into the loop. With Overdub on (and something already there) it layers over the loop instead of
   * replacing it. The loop is claimed at once; the microphone is opened if it was not already (a moment on a phone),
   * and the take starts when it is ready.
   */
  startRecording(track: number): Promise<boolean> {
    // no check that the mic was allowed at start: if that request failed, this tap asks again (a fresh gesture)
    if (!this.capture || this.recTrack >= 0 || track >= TRACKS) return Promise.resolve(false);
    this.recTrack = track;
    this.startP = (async () => {
      if (!(await this.openMic())) {
        this.recTrack = -1;
        this.applyMix(track);
        return false;
      }
      this.chunks = [];
      this.recSamples = 0;
      this.recWall0 = performance.now();
      const loop = this.loops[track];
      this.recOverdub = this.tracks[track].overdub && !!loop;
      // an overdub lands where the loop is now; the loop keeps playing underneath
      this.recOffset = loop ? Math.floor(this.lastPos[track] * loop[0].length) : 0;
      this.applyMix(track);
      this.capture!.port.postMessage({ type: 'rec', on: true });
      if (!this.playing) this.setPlaying(true);
      return true;
    })();
    return this.startP;
  }

  private onChunk(data: Float32Array) {
    if (this.recTrack < 0) return;
    this.chunks.push(data);
    this.recSamples += data.length;
    const sr = this.sampleRate;
    this.events.recTime?.(this.recTrack, this.recSamples / sr);
    if (this.recSamples >= MAX_SECONDS * sr) this.events.recAutoStop?.(this.recTrack);
  }

  async stopRecording(): Promise<RecResult> {
    const t = this.recTrack;
    if (t < 0 || !this.capture) return { ok: false, reason: 'idle' };
    // stopped before the microphone had finished opening: let it open, there is just nothing in the take
    if (this.startP && !(await this.startP)) return { ok: false, reason: 'idle' };
    const wall = (performance.now() - this.recWall0) / 1000;
    const done = new Promise<void>((res) => {
      this.recDone = res;
      setTimeout(res, 600); // never hang if the context was suspended
    });
    this.capture.port.postMessage({ type: 'rec', on: false });
    await done;
    this.recDone = null;
    const overdub = this.recOverdub;
    this.recTrack = -1;
    this.recOverdub = false;
    let raw = concat(this.chunks);
    this.chunks = [];
    const sr = this.sampleRate;
    // a take must be as long as the time that really passed; if not, the speed was wrong
    const fixed = repairSpeed(raw, sr, wall);
    raw = fixed.data;
    this.diag.take = { heardSeconds: this.recSamples / sr, realSeconds: wall, repaired: fixed.ratio };
    const max = Math.floor(MAX_SECONDS * sr);
    if (raw.length > max) raw = raw.subarray(0, max);
    let result: RecResult;
    const old = this.loops[t];
    if (overdub && old) {
      // layer the take over the loop at the playhead it started on
      let mean = 0;
      for (let i = 0; i < raw.length; i++) mean += raw[i];
      mean /= Math.max(1, raw.length);
      const layer = raw.map((v) => v - mean);
      if (raw.length < 0.1 * sr) result = { ok: false, reason: 'short' };
      else if (peakOf([layer]) < 0.001) result = { ok: false, reason: 'quiet' };
      else {
        const dst = old[0].slice();
        layerInto(dst, layer, this.recOffset, this.tracks[t].keep);
        this.setBuffer(t, [dst], true);
        result = { ok: true };
      }
    } else {
      const res = prepareLoop([raw], sr);
      if (res.ok) {
        this.setBuffer(t, res.chans);
        result = { ok: true };
      } else result = { ok: false, reason: res.reason };
    }
    this.applyMix(t);
    this.closeMic();
    return result;
  }

  /**
   * Put audio in the loop. A new loop resets the loop window and restarts; `keep`
   * swaps audio of the same length under the playing loop without restarting it
   * (an overdub, a normalise).
   */
  setBuffer(track: number, chans: Loop, keep = false) {
    const t = this.tracks[track];
    const same = keep && this.loops[track] && this.loops[track]![0].length === chans[0].length;
    this.loops[track] = chans;
    this.peaks[track] = computePeaks(chans, 320);
    t.seconds = chans[0].length / this.sampleRate;
    if (!same) {
      t.start = 0;
      t.end = 1;
    }
    const copies = chans.map((c) => c.slice());
    this.g?.tracks[track].looper.port.postMessage({ type: 'buffer', channels: copies, keep: !!same }, copies.map((c) => c.buffer));
    this.update(track, same ? {} : { start: 0, end: 1 });
    this.events.track?.(track);
    this.touch(track);
  }

  clearTrack(track: number) {
    this.loops[track] = null;
    this.peaks[track] = null;
    this.tracks[track].seconds = 0;
    this.g?.tracks[track]?.looper.port.postMessage({ type: 'buffer', channels: [] });
    this.events.track?.(track);
    this.touch(track);
  }

  /** Bring a quiet recording up to −3 dBFS. Never done automatically. */
  normaliseTrack(track: number): { ok: true; gainDb: number } | { ok: false; reason: 'empty' | 'quiet' } {
    const loop = this.loops[track];
    if (!loop) return { ok: false, reason: 'empty' };
    const r = normalise(loop);
    if (!r.ok) return { ok: false, reason: 'quiet' };
    this.setBuffer(track, r.chans, true);
    return { ok: true, gainDb: r.gainDb };
  }

  async importFile(track: number, file: File): Promise<RecResult> {
    if (!this.ctx) return { ok: false, reason: 'idle' };
    const decoded = await this.ctx.decodeAudioData(await file.arrayBuffer());
    const all = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
    let chans: Loop = [toMono(all)];
    const max = Math.floor(MAX_SECONDS * decoded.sampleRate);
    if (chans[0].length > max) chans = chans.map((c) => c.slice(0, max));
    if (decoded.sampleRate !== this.sampleRate) chans = chans.map((c) => resampleTo(c, Math.round((c.length * this.sampleRate) / decoded.sampleRate)));
    const res = prepareLoop(chans, this.sampleRate);
    if (!res.ok) return { ok: false, reason: res.reason };
    this.setBuffer(track, res.chans);
    if (!this.playing) this.setPlaying(true);
    return { ok: true };
  }

  /* ------------------------------------------------------------- params -- */

  update(track: number, patch: Partial<Omit<TrackState, 'sound'>>) {
    const t = this.tracks[track];
    Object.assign(t, patch);
    this.touch();
    const n = this.g?.tracks[track];
    if (!n) return;
    n.looper.port.postMessage({ type: 'params', params: this.looperParams(t) });
    if ('level' in patch) this.applyMix(track);
  }

  /** A mode's own controls (the loop keeps one set per mode). */
  updateSound<K extends keyof SoundState>(track: number, kind: K, patch: Partial<SoundState[K]>) {
    const t = this.tracks[track];
    Object.assign(t.sound[kind], patch);
    this.touch();
    this.g?.tracks[track]?.looper.port.postMessage({ type: 'params', params: this.looperParams(t) });
  }

  /** Change the stretch. If pitch and stretch are linked the pitch follows. */
  setStretch(track: number, stretch: number) {
    const t = this.tracks[track];
    const s = clampStretch(stretch);
    this.update(track, t.link ? { stretch: s, pitch: pitchOfStretch(s) } : { stretch: s });
    this.events.trackParams?.(track);
  }

  /** Change the pitch (semitones). If pitch and stretch are linked the stretch follows, as on a tape reel. */
  setPitch(track: number, pitch: number) {
    const t = this.tracks[track];
    const p = Math.max(-24, Math.min(24, pitch));
    this.update(track, t.link ? { pitch: p, stretch: stretchOfPitch(p) } : { pitch: p });
    this.events.trackParams?.(track);
  }

  /**
   * Link or unlink pitch and stretch without a jump where that is possible.
   * Linking on tape keeps the speed you hear (the stretch is recomputed from the speed);
   * unlinking keeps the pitch you hear (tape: the offset goes back to 0; the others keep the derived pitch).
   */
  setLink(track: number, on: boolean) {
    const t = this.tracks[track];
    if (on === t.link) return;
    if (on) {
      if (t.engine === 'tape') t.stretch = clampStretch(t.stretch * Math.pow(2, -t.pitch / 12));
      this.update(track, { link: true, stretch: t.stretch, pitch: pitchOfStretch(t.stretch) });
    } else this.update(track, { link: false, pitch: t.engine === 'tape' ? 0 : pitchOfStretch(t.stretch) });
    this.events.trackParams?.(track);
  }

  /** Switch the stretch mode. Tape is linked (that is what tape is); the other modes start independent, keeping the pitch you were hearing. */
  setEngine(track: number, kind: EngineKind) {
    const t = this.tracks[track];
    if (kind === t.engine) return;
    if (kind === 'tape') this.update(track, { engine: kind, link: true, pitch: pitchOfStretch(t.stretch) });
    else if (t.engine === 'tape') this.update(track, { engine: kind, link: false, pitch: t.link ? pitchOfStretch(t.stretch) : t.pitch });
    else this.update(track, { engine: kind });
    this.events.trackParams?.(track);
  }

  private applyMix(track: number) {
    const t = this.tracks[track];
    const n: TrackNodes | undefined = this.g?.tracks[track];
    if (!n || !this.ctx) return;
    const now = this.ctx.currentTime;
    n.mute.gain.setTargetAtTime(this.muteGain(track), now, 0.02);
    n.gain.gain.setTargetAtTime(t.level * t.level, now, 0.02);
  }

  setMaster(v: number) {
    this.masterLevel = v;
    this.touch();
    if (this.ctx && this.g) this.g.master.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.02);
  }

  setPlaying(on: boolean) {
    this.playing = on;
    this.update(0, {});
    if (on && this.tracks[0].seconds > 0) this.g?.tracks[0].looper.port.postMessage({ type: 'play' });
    void this.holdScreen(on || this.performing);
  }

  /** Reset every processor (the "panic" button). */
  panic() {
    if (!this.g) return;
    for (const n of this.g.tracks) n.looper.port.postMessage({ type: 'reset' });
    this.g.safety.port.postMessage({ type: 'reset' });
    this.g.chain.resetAll();
  }

  /** Keep the screen (and so the audio) awake while playing. */
  private async holdScreen(on: boolean) {
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<Wake> } }).wakeLock;
      if (on && wl && !this.wake) this.wake = await wl.request('screen');
      else if (!on && this.wake) {
        await this.wake.release();
        this.wake = null;
      }
    } catch {
      this.wake = null; // not allowed (low power mode, hidden tab) — harmless
    }
  }

  /* ------------------------------------------------- Performance Record -- */

  private ensureTap(): AudioWorkletNode | null {
    if (!this.ctx || !this.g) return null;
    if (!this.tap) {
      this.tap = workletNode(this.ctx, 'fs-tap', {}, 1);
      this.tap.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'chunk') {
          if (!this.perf) return;
          this.perf.push([m.l, m.r]);
          const sec = this.perf.seconds;
          this.events.perfTime?.(sec);
          if (sec >= MAX_PERF_SECONDS) this.events.perfAutoStop?.();
        } else if (m.type === 'recStopped') this.tapDone?.();
      };
      const silent = this.ctx.createGain();
      silent.gain.value = 0;
      this.g.safety.connect(this.tap).connect(silent).connect(this.ctx.destination);
    }
    return this.tap;
  }

  /** Start recording what comes out of the speakers (after the limiter), while you play. */
  startPerformance(): boolean {
    if (!this.started || this.performing) return false;
    const tap = this.ensureTap();
    if (!tap) return false;
    this.perf = new WavStream(2, this.sampleRate, 24);
    tap.port.postMessage({ type: 'rec', on: true });
    this.performing = true;
    void this.holdScreen(true);
    return true;
  }

  /** Stop and get the WAV (null if nothing came through). */
  async stopPerformance(): Promise<{ wav: Blob; seconds: number } | null> {
    if (!this.performing || !this.tap) return null;
    const done = new Promise<void>((res) => {
      this.tapDone = res;
      setTimeout(res, 600);
    });
    this.tap.port.postMessage({ type: 'rec', on: false });
    await done;
    this.tapDone = null;
    this.performing = false;
    void this.holdScreen(this.playing);
    const perf = this.perf;
    this.perf = null;
    if (!perf || perf.frames === 0) return null;
    return { seconds: perf.seconds, wav: perf.finish() };
  }

  /* ----------------------------------------------------------- projects -- */

  getProject(): ProjectData {
    const { seconds: _s, ...t } = this.tracks[0];
    return {
      app: 'FieldLooper',
      v: 1,
      sampleRate: this.sampleRate,
      masterLevel: this.masterLevel,
      track: JSON.parse(JSON.stringify(t)) as Omit<TrackState, 'seconds'>,
      chain: cloneSlots(this.chain),
      wet: this.wet,
      seq: { ...this.sequencer.s, rate: this.seq.rate },
      seqTarget: this.seqTarget,
    };
  }

  /**
   * Replace the whole state. Tolerant of hand-edited files: anything missing or
   * out of range falls back to the default, and an effect this build does not
   * have is left out (the count is returned so it can be mentioned). The
   * sequencer is left off — a project should never start making sound by itself.
   */
  applyProject(d: Partial<ProjectData>, loop: Loop | null, audioRate: number): { dropped: number } {
    if (this.armedId) this.disarm(false);
    const kinds: EngineKind[] = ['spectral', 'granular', 'tape'];
    const fresh = defaultTrack();
    const src = (d.track ?? {}) as Partial<TrackState>;
    const tr = this.tracks[0];
    tr.engine = kinds.includes(src.engine as EngineKind) ? (src.engine as EngineKind) : fresh.engine;
    tr.stretch = num(src.stretch, MIN_STRETCH, MAX_STRETCH, fresh.stretch);
    tr.glide = num(src.glide, 0, 10, fresh.glide);
    tr.pitch = num(src.pitch, -24, 24, 0);
    tr.link = bool(src.link, tr.engine === 'tape' && tr.pitch === 0);
    tr.reverse = bool(src.reverse, false);
    tr.freeze = bool(src.freeze, false);
    tr.level = num(src.level, 0, 1, fresh.level);
    tr.overdub = bool(src.overdub, false);
    tr.keep = num(src.keep, 0, 1, fresh.keep);
    tr.sound = readSound(src.sound);
    if (loop && loop[0].length >= 256) {
      const chans = audioRate === this.sampleRate ? loop : loop.map((c) => resampleTo(c, Math.round((c.length * this.sampleRate) / audioRate)));
      this.setBuffer(0, chans);
      // setBuffer resets the loop window; put the saved one back
      tr.start = num(src.start, 0, 1, 0);
      tr.end = num(src.end, 0, 1, 1);
      if (tr.end - tr.start < 0.01) (tr.start = 0), (tr.end = 1);
    } else this.clearTrack(0);
    this.update(0, {});

    // the chain: every slot read tolerantly, at most MAX_SLOTS
    const rawChain = Array.isArray(d.chain) ? d.chain : [];
    const chain: Slot[] = [];
    let dropped = 0;
    for (const raw of rawChain) {
      const s = readSlot(raw);
      if (!s || chain.length >= MAX_SLOTS || chain.some((x) => x.id === s.id)) dropped++;
      else chain.push(s);
    }
    this.chain = chain;
    this.autoStart.clear();
    this.held.clear();
    this.wet = num(d.wet, 0, 1, 1);
    this.masterLevel = num(d.masterLevel, 0, 1, 0.85);

    const sq = (d.seq ?? {}) as Partial<SeqSettings & { rate: number }>;
    this.seq.rate = num(sq.rate, 0.15, 30, 3);
    this.seqTarget = typeof d.seqTarget === 'string' && chain.some((s) => s.id === d.seqTarget) ? d.seqTarget : null;
    const modes = ['lydian', 'ionian', 'mixolydian', 'dorian', 'aeolian', 'harmonicMinor', 'phrygian', 'octatonic'];
    const motions = ['drift', 'arp', 'markov', 'wander', 'hold'];
    Object.assign(this.sequencer.s, {
      scale: modes.includes(sq.scale as string) ? sq.scale : 'dorian',
      motion: motions.includes(sq.motion as string) ? sq.motion : 'drift',
      range: Math.round(num(sq.range, 1, 3, 2)),
      chance: num(sq.chance, 0, 1, 0.85),
      chordSize: [0, 3, 4, 5].includes(sq.chordSize as number) ? sq.chordSize : 0,
    });
    this.sequencer.reseed(Math.round(num(sq.seed, 0, 1e9, 1)));
    this.manualNote = false;
    this.seq.on = false;
    window.clearInterval(this.seqTimer);
    this.seqNode = null;
    // push everything to the audio side (a fresh node per slot, so automation starts from the top)
    if (this.ctx && this.g) {
      this.g.chain.sync([]);
      this.syncChain();
      this.setMaster(this.masterLevel);
      this.applyMix(0);
    }
    this.touch();
    this.events.chain?.();
    this.events.project?.();
    return { dropped };
  }

  /** A blank slate: empty loop, empty chain, default settings. */
  newProject() {
    this.applyProject({}, null, this.sampleRate);
  }

  /** Apply a preset: the loop's settings and a whole new chain (the recording and its loop window stay). */
  applyPreset(preset: Preset) {
    const cur = this.getProject();
    const pt = preset.track ?? {};
    const track = { ...cur.track, ...pt, sound: mergeSound(cur.track.sound, pt.sound), start: cur.track.start, end: cur.track.end };
    // a preset that changes the mode without saying otherwise gets that mode's usual link
    if (pt.engine !== undefined && pt.link === undefined) track.link = pt.engine === 'tape';
    const chain = preset.chain.map((ps) => {
      const s = newSlot(ps.type);
      return { ...s, on: ps.on ?? true, mix: ps.mix ?? s.mix, p: { ...s.p, ...ps.p }, auto: ps.auto ?? null };
    });
    this.applyProject(
      { ...cur, track, chain, wet: preset.wet ?? cur.wet, seq: { ...cur.seq, ...preset.seq }, seqTarget: null },
      this.loops[0],
      this.sampleRate,
    );
    if (preset.seqOn && this.seqSlot()) this.setSeqOn(true);
  }

  /** The current settings as a preset (no audio, no loop window). */
  capturePreset(name: string, blurb = 'Saved from your settings.'): Preset {
    const p = this.getProject();
    const { start: _a, end: _b, ...track } = p.track;
    return {
      name,
      blurb,
      user: true,
      track,
      chain: p.chain.map((s) => ({ type: s.type, on: s.on, mix: s.mix, p: s.p, auto: s.auto })),
      wet: p.wet,
      seq: p.seq,
      seqOn: this.seq.on,
    };
  }

  /** Release the mic and context. */
  dispose() {
    window.clearInterval(this.autoTimer);
    this.closeMic();
    void this.ctx?.close();
  }
}
