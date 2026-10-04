/*
 * Effect units and the FX chain (from FXMaker, cut down for phones).
 *
 *   Unit      — one effect's processing (AudioWorklet or native nodes), wet only
 *   SlotNode  — a Unit inside the slot's own dry/wet + bypass wrapper
 *   Chain     — up to 8 SlotNodes in series, kept in step with a Slot[] by sync()
 *
 * Not here (too heavy for a phone): the convolution reverb and its impulse
 * responses. The drive's wave-shaper oversamples 2× instead of 4×.
 *
 * Automation: worklet effects play their own lanes on the audio thread (FxBase
 * in dsp/common.js), so they get `auto` and `autoHold` messages. The native
 * effects (compressor, drive, filter) and every slot's wet/dry are moved from
 * the main thread instead (see automation.ts and engine.ts).
 */

import { fxDef, type FxDef } from '../fx/registry';
import type { Automation, Slot } from '../fx/slot';
import { workletNode } from './worklets';

export interface Unit {
  input: AudioNode;
  output: AudioNode;
  set(p: Record<string, number>): void;
  reset(): void;
  dispose(): void;
  /** the AudioWorklet node, for worklet effects (they take messages: automation, notes) */
  node: AudioWorkletNode | null;
}

export interface UnitHooks {
  onBlowup?: () => void;
}

export function setParam(ctx: BaseAudioContext, ap: AudioParam, v: number, tc = 0.03) {
  if (!Number.isFinite(v)) return;
  const x = Math.min(ap.maxValue, Math.max(ap.minValue, v));
  if (ctx.currentTime === 0) ap.setValueAtTime(x, 0);
  else {
    ap.cancelScheduledValues(ctx.currentTime);
    ap.setTargetAtTime(x, ctx.currentTime, tc);
  }
}

const dbToGain = (db: number) => (db <= -90 ? 0 : Math.pow(10, db / 20));

/** MIDI note of a resonator's Key + Octave (octave 3, A = 57 = 220 Hz). */
export const resoNote = (root: number, octave: number): number => 12 * (Math.round(octave) + 1) + Math.round(root);

/**
 * What the processor is actually sent for a slot's settings. The resonator takes
 * one MIDI `note` rather than Key + Octave, and while the sequencer is playing it
 * the note is left out, so the Key setting never fights the sequencer.
 */
export function procParams(def: FxDef, p: Record<string, number>, noteOwned = false): Record<string, number> {
  const out: Record<string, number> = { ...p, ...(def.fixed ?? {}) };
  if (def.impl === 'fxm-reso') {
    delete out.root;
    delete out.octave;
    if (!noteOwned) out.note = resoNote(p.root, p.octave);
  }
  return out;
}

/* ---------------------------------------------------------- worklet units -- */

function workletUnit(ctx: BaseAudioContext, def: FxDef, slot: Slot, hooks: UnitHooks): Unit {
  const node = workletNode(ctx, def.impl, { params: procParams(def, slot.p), seed: slot.seed });
  node.port.onmessage = (e) => {
    if (e.data?.type === 'blowup') hooks.onBlowup?.();
  };
  return {
    input: node,
    output: node,
    node,
    set: (p) => node.port.postMessage({ type: 'params', params: p }),
    reset: () => node.port.postMessage({ type: 'reset' }),
    dispose: () => {
      node.port.onmessage = null;
      node.disconnect();
    },
  };
}

/* ----------------------------------------------------------- native units -- */

function compressorUnit(ctx: BaseAudioContext): Unit {
  const c = ctx.createDynamicsCompressor();
  const mk = ctx.createGain();
  c.connect(mk);
  return {
    input: c,
    output: mk,
    node: null,
    set(p) {
      setParam(ctx, c.threshold, p.threshold);
      setParam(ctx, c.ratio, p.ratio);
      setParam(ctx, c.attack, p.attack / 1000);
      setParam(ctx, c.release, p.release / 1000);
      setParam(ctx, c.knee, p.knee);
      setParam(ctx, mk.gain, dbToGain(p.makeup));
    },
    reset() {},
    dispose() {
      c.disconnect();
      mk.disconnect();
    },
  };
}

const RANGE = 32; // the shaper curve spans ±32 (pre-gain is divided by this)
const curves = new Map<number, Float32Array>();
function driveCurve(mode: number): Float32Array {
  const m = Math.round(mode);
  const hit = curves.get(m);
  if (hit) return hit;
  const n = 16385;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = ((i / (n - 1)) * 2 - 1) * RANGE;
    let y: number;
    switch (m) {
      case 1: y = Math.max(-1, Math.min(1, u)); break; // hard
      case 2: { // fuzz: gated, lopsided
        const g = (u * Math.abs(u)) / (Math.abs(u) + 0.08);
        y = g > 0 ? Math.tanh(g * 1.8) : -Math.min(0.55, Math.sqrt(-g) * 0.45);
        break;
      }
      case 3: y = Math.tanh(Math.abs(u) * 1.5) * 1.6 - 0.8; break; // full-wave rectify (octave up)
      case 4: y = Math.sin((u * Math.PI) / 2); break; // foldback
      default: y = Math.tanh(u); // soft
    }
    c[i] = y;
  }
  curves.set(m, c);
  return c;
}

function driveUnit(ctx: BaseAudioContext): Unit {
  const pre = ctx.createGain();
  const sh = ctx.createWaveShaper();
  sh.oversample = '2x'; // 4× on a desktop (FXMaker); 2× is plenty on a phone speaker and half the cost
  const dc = ctx.createBiquadFilter();
  dc.type = 'highpass';
  dc.frequency.value = 18;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = -1;
  const out = ctx.createGain();
  pre.connect(sh).connect(dc).connect(lp).connect(out);
  let mode = -1;
  return {
    input: pre,
    output: out,
    node: null,
    set(p) {
      if (Math.round(p.mode) !== mode) {
        mode = Math.round(p.mode);
        sh.curve = driveCurve(mode) as Float32Array<ArrayBuffer>;
      }
      setParam(ctx, pre.gain, dbToGain(p.gain) / RANGE);
      setParam(ctx, lp.frequency, p.tone);
      setParam(ctx, out.gain, dbToGain(p.output));
    },
    reset() {},
    dispose() {
      for (const n of [pre, sh, dc, lp, out]) n.disconnect();
    },
  };
}

const FILTER_TYPES: BiquadFilterType[] = ['lowpass', 'highpass', 'bandpass', 'notch'];

function filterUnit(ctx: BaseAudioContext): Unit {
  const f1 = ctx.createBiquadFilter();
  const f2 = ctx.createBiquadFilter();
  const out = ctx.createGain();
  f1.connect(f2).connect(out);
  const lfo = ctx.createOscillator();
  const depth = ctx.createGain();
  lfo.connect(depth);
  depth.connect(f1.detune);
  depth.connect(f2.detune);
  lfo.start();
  return {
    input: f1,
    output: out,
    node: null,
    set(p) {
      const type = FILTER_TYPES[Math.round(p.type)] ?? 'lowpass';
      const steep = p.slope >= 0.5;
      const r = Math.max(0, Math.min(1, p.resonance));
      f1.type = type;
      f2.type = steep ? type : 'allpass';
      const isLpHp = type === 'lowpass' || type === 'highpass';
      const q1 = isLpHp ? -3 + r * 33 : 0.5 * Math.pow(120, r);
      setParam(ctx, f1.Q, q1);
      setParam(ctx, f2.Q, steep ? (isLpHp ? -3 : q1) : 0.7);
      setParam(ctx, f1.frequency, p.cutoff);
      setParam(ctx, f2.frequency, p.cutoff);
      setParam(ctx, lfo.frequency, p.lfoRate);
      setParam(ctx, depth.gain, p.lfoDepth * 600);
      // resonant band-pass peaks get loud; pull the level back a little
      setParam(ctx, out.gain, type === 'bandpass' ? 1 + r * 2 : isLpHp ? dbToGain(-r * 9) : 1);
    },
    reset() {},
    dispose() {
      lfo.stop();
      for (const n of [f1, f2, out, lfo, depth]) n.disconnect();
    },
  };
}

export function createUnit(ctx: BaseAudioContext, slot: Slot, hooks: UnitHooks = {}): Unit {
  const def = fxDef(slot.type);
  if (!def) throw new Error(`unknown effect ${slot.type}`);
  let u: Unit;
  if (def.impl.startsWith('fxm-')) return workletUnit(ctx, def, slot, hooks);
  else if (def.impl === 'compressor') u = compressorUnit(ctx);
  else if (def.impl === 'drive') u = driveUnit(ctx);
  else if (def.impl === 'filter') u = filterUnit(ctx);
  else throw new Error(`no implementation ${def.impl}`);
  u.set(procParams(def, slot.p));
  return u;
}

/* -------------------------------------------------------------- slot node -- */

export class SlotNode {
  readonly input: GainNode;
  readonly output: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  readonly unit: Unit;
  readonly def: FxDef;
  private pKey = '';
  private wired = false;
  private on = true;
  /** the sequencer is playing this resonator: its Key setting is not sent */
  private noteOwned = false;

  constructor(private ctx: BaseAudioContext, slot: Slot, hooks: UnitHooks) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.def = fxDef(slot.type)!;
    this.unit = createUnit(ctx, slot, hooks);
    this.input.connect(this.dry).connect(this.output);
    this.unit.output.connect(this.wet).connect(this.output);
    this.pKey = JSON.stringify(slot.p);
    this.apply(slot, true);
  }

  get isWorklet(): boolean {
    return this.unit.node !== null;
  }

  update(slot: Slot) {
    const k = JSON.stringify(slot.p);
    if (k !== this.pKey) {
      this.pKey = k;
      this.unit.set(procParams(this.def, slot.p, this.noteOwned));
    }
    this.apply(slot, false);
  }

  setNoteOwned(owned: boolean, slot: Slot) {
    if (owned === this.noteOwned) return;
    this.noteOwned = owned;
    this.unit.set(procParams(this.def, slot.p, owned));
  }

  private apply(slot: Slot, first: boolean) {
    this.on = slot.on;
    // bypassed effects are disconnected so they cost nothing
    if (slot.on && !this.wired) {
      this.input.connect(this.unit.input);
      this.wired = true;
    } else if (!slot.on && this.wired) {
      try {
        this.input.disconnect(this.unit.input);
      } catch {
        /* already gone */
      }
      this.wired = false;
    }
    this.setMix(slot.mix, first);
  }

  /** The slot's wet/dry (linear cross-fade, as in FXMaker). Also what mix automation moves. */
  setMix(mix: number, first = false) {
    const m = this.on ? Math.min(1, Math.max(0, mix)) : 0;
    const dry = this.on ? 1 - m : 1;
    if (first) {
      this.dry.gain.value = dry;
      this.wet.gain.value = m;
    } else {
      setParam(this.ctx, this.dry.gain, dry, 0.02);
      setParam(this.ctx, this.wet.gain, m, 0.02);
    }
  }

  /** Automated values for a native effect (worklets move their own). */
  setNative(slot: Slot, values: Record<string, number>) {
    if (this.isWorklet) return;
    this.unit.set(procParams(this.def, { ...slot.p, ...values }));
  }

  /** Hand a worklet effect its automation. `start` is the absolute frame the loop began at. */
  sendAuto(auto: Automation | null, start: number) {
    const node = this.unit.node;
    if (!node) return;
    const lanes = auto ? auto.lanes.filter((l) => l.key !== 'mix') : [];
    node.port.postMessage({ type: 'auto', auto: auto && lanes.length ? { start, len: auto.len, lanes } : null });
  }

  /** A finger is on (or has left) one of this slot's controls: the hand wins while held. */
  hold(key: string, on: boolean) {
    this.unit.node?.port.postMessage({ type: 'autoHold', key, on });
  }

  /** A raw message to the processor (sequencer notes). */
  message(m: Record<string, unknown>) {
    this.unit.node?.port.postMessage(m);
  }

  dispose() {
    this.unit.dispose();
    for (const n of [this.input, this.output, this.dry, this.wet]) n.disconnect();
  }
}

/* ------------------------------------------------------------------ chain -- */

export class Chain {
  readonly input: GainNode;
  readonly output: GainNode;
  private nodes = new Map<string, SlotNode>();
  private order: string[] = [];
  private rewireTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: BaseAudioContext, private hooks: UnitHooks, private onCreate: (n: SlotNode, s: Slot) => void = () => undefined) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.input.connect(this.output);
  }

  node(id: string): SlotNode | undefined {
    return this.nodes.get(id);
  }

  /** Bring the audio graph in line with the slot list: create, update, remove, reorder. */
  sync(slots: Slot[]) {
    const ids = slots.map((s) => s.id);
    for (const [id, n] of this.nodes) {
      if (!ids.includes(id)) {
        n.dispose();
        this.nodes.delete(id);
      }
    }
    for (const s of slots) {
      const n = this.nodes.get(s.id);
      if (n) n.update(s);
      else {
        const created = new SlotNode(this.ctx, s, this.hooks);
        this.nodes.set(s.id, created);
        this.onCreate(created, s);
      }
    }
    const same = ids.length === this.order.length && ids.every((id, i) => id === this.order[i]);
    if (!same) {
      this.order = ids;
      this.rewire();
    }
  }

  private rewire() {
    const doWire = () => {
      this.input.disconnect();
      for (const n of this.nodes.values()) n.output.disconnect();
      let prev: AudioNode = this.input;
      for (const id of this.order) {
        const n = this.nodes.get(id);
        if (!n) continue;
        prev.connect(n.input);
        prev = n.output;
      }
      prev.connect(this.output);
    };
    // duck for ~25 ms so re-patching never clicks
    const g = this.output.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0, t, 0.005);
    if (this.rewireTimer) clearTimeout(this.rewireTimer);
    this.rewireTimer = setTimeout(() => {
      doWire();
      const t2 = this.ctx.currentTime;
      g.cancelScheduledValues(t2);
      g.setTargetAtTime(1, t2, 0.01);
    }, 30);
  }

  resetAll() {
    for (const n of this.nodes.values()) n.unit.reset();
  }

  dispose() {
    for (const n of this.nodes.values()) n.dispose();
    this.nodes.clear();
    this.input.disconnect();
    this.output.disconnect();
  }
}
