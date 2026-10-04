/*
 * The signal graph.
 *
 *   looper ─► rec-mute ─► level ─┬─► dry ──────────────────────────────┐
 *                                └─► CHAIN (slot ─► slot ─► …) ─► wet ─┴─► master ─► fxm-safety ─► out
 *
 *   slot:  in ─┬─► effect ─► slot wet ─┬─► out     (each slot has its own wet/dry;
 *              └──────────► slot dry ──┘           switched off it passes straight through)
 *
 * The master Wet/Dry cross-fades the `dry` and `wet` gains (equal power); at
 * 100% wet the dry gain is exactly zero, so the wet sound is clean. With no
 * slot switched on the master blend is bypassed: the loop is heard dry.
 */
import { workletNode } from './worklets';
import { Chain, type SlotNode } from './units';
import type { Slot } from '../fx/slot';

type Params = Record<string, number | string>;

export interface TrackNodes {
  looper: AudioWorkletNode;
  /** silences the loop while it is being re-recorded */
  mute: GainNode;
  gain: GainNode;
}

export interface GraphNodes {
  master: GainNode;
  safety: AudioWorkletNode;
  /** the loop's direct sound, on its way to the master */
  dry: GainNode;
  /** the chain's output, on its way to the master */
  wet: GainNode;
  chain: Chain;
  tracks: TrackNodes[];
}

/** Everything the graph needs at the moment it is built. Gains are final linear values. */
export interface GraphInit {
  tracks: { params: Params; seed: number; mute: number; gain: number }[];
  master: number;
  /** processors report positions / meters back */
  report?: boolean;
}

export interface GraphHooks {
  safety?(m: { type: string; gr?: number; peak?: number }): void;
  looper?(track: number, m: { type: string; v?: number; r?: number }): void;
  blowup?(): void;
  /** a slot's audio node was just made (so its automation and notes can be sent) */
  slotCreated?(n: SlotNode, s: Slot): void;
}

/**
 * Equal-power cross-fade for a 0–1 Wet/Dry. At the ends one side is EXACTLY zero
 * (cos(π/2) is not), so "all wet" really has no dry in it and vice versa.
 */
export function wetDryGains(wet: number): { dry: number; wet: number } {
  const w = Math.min(1, Math.max(0, wet));
  if (w <= 0) return { dry: 1, wet: 0 };
  if (w >= 1) return { dry: 0, wet: 1 };
  return { dry: Math.cos((w * Math.PI) / 2), wet: Math.sin((w * Math.PI) / 2) };
}

/**
 * The master dry and wet gains. With no slot switched on there is nothing to blend
 * in, so the loop is heard as it is whatever the Wet/Dry says (an empty chain is
 * never silent).
 */
export const masterGains = (wet: number, anyOn: boolean): { dry: number; wet: number } => (anyOn ? wetDryGains(wet) : { dry: 1, wet: 0 });

export function buildGraph(ctx: BaseAudioContext, init: GraphInit, hooks: GraphHooks = {}): GraphNodes {
  const report = !!init.report;
  const master = ctx.createGain();
  master.gain.value = init.master;
  const safety = workletNode(ctx, 'fxm-safety', { params: { ceiling: -1 }, report });
  safety.port.onmessage = (e) => {
    if (e.data.type === 'blowup') hooks.blowup?.();
    else hooks.safety?.(e.data);
  };
  master.connect(safety).connect(ctx.destination);

  const dry = ctx.createGain();
  const wet = ctx.createGain();
  // the chain starts empty, so the loop starts dry (see masterGains)
  dry.gain.value = 1;
  wet.gain.value = 0;
  dry.connect(master);
  wet.connect(master);

  const chain = new Chain(ctx, { onBlowup: () => hooks.blowup?.() }, (n, s) => hooks.slotCreated?.(n, s));
  chain.output.connect(wet);

  const tracks = init.tracks.map((t, i): TrackNodes => {
    const looper = workletNode(ctx, 'fxm-looper', { params: t.params, seed: t.seed, report }, 0);
    looper.port.onmessage = (e) => {
      if (e.data.type === 'blowup') hooks.blowup?.();
      else hooks.looper?.(i, e.data);
    };
    const mute = ctx.createGain();
    const gain = ctx.createGain();
    mute.gain.value = t.mute;
    gain.gain.value = t.gain;
    // the loop's level applies to BOTH the dry sound and what feeds the effects
    looper.connect(mute).connect(gain);
    gain.connect(dry);
    gain.connect(chain.input);
    return { looper, mute, gain };
  });

  return { master, safety, dry, wet, chain, tracks };
}
