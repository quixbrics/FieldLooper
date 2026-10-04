/*
 * One slot in the FX chain: which effect, its settings, its own wet/dry and its
 * looping automation. Plain JSON, so it goes straight into project files and
 * presets.
 */
import { FX, automatable, defaultParams, fxDef } from './registry';

/** Longest chain. */
export const MAX_SLOTS = 8;
/** Longest automation loop, seconds. */
export const MAX_AUTO_SECONDS = 120;

/** One automated control: points (seconds into the loop, ascending) and the value at each. */
export interface Lane {
  key: string;
  t: number[];
  v: number[];
}

/** A slot's automation: a loop of `len` seconds. `key: 'mix'` automates the slot's wet/dry. */
export interface Automation {
  len: number;
  lanes: Lane[];
}

export interface Slot {
  id: string;
  type: string;
  on: boolean;
  /** this slot's wet/dry: 0 = only what came in, 1 = only the effect */
  mix: number;
  p: Record<string, number>;
  seed: number;
  auto: Automation | null;
}

let idCounter = 0;
export const newId = (): string => `s${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export function newSlot(type: string): Slot {
  const def = fxDef(type);
  if (!def) throw new Error(`unknown effect ${type}`);
  return { id: newId(), type, on: true, mix: def.mix, p: defaultParams(def), seed: Math.floor(Math.random() * 1e6) + 1, auto: null };
}

const num = (v: unknown, lo: number, hi: number, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);

/** Read an automation block from a saved file: anything malformed is dropped. */
function readAuto(src: unknown, allowed: Set<string>): Automation | null {
  const a = src as Partial<Automation> | null | undefined;
  if (!a || typeof a.len !== 'number' || !(a.len > 0) || !Array.isArray(a.lanes)) return null;
  const len = Math.min(MAX_AUTO_SECONDS, a.len);
  const lanes: Lane[] = [];
  for (const l of a.lanes) {
    if (!l || typeof l.key !== 'string' || !allowed.has(l.key) || !Array.isArray(l.t) || !Array.isArray(l.v)) continue;
    const t: number[] = [];
    const v: number[] = [];
    const n = Math.min(l.t.length, l.v.length);
    for (let i = 0; i < n; i++) {
      const ti = l.t[i];
      const vi = l.v[i];
      if (typeof ti !== 'number' || typeof vi !== 'number' || !Number.isFinite(ti) || !Number.isFinite(vi)) continue;
      if (ti < 0 || ti > len || (t.length && ti < t[t.length - 1])) continue;
      t.push(ti);
      v.push(vi);
    }
    if (t.length) lanes.push({ key: l.key, t, v });
  }
  return lanes.length ? { len, lanes } : null;
}

/**
 * A slot from a saved file or preset. Returns null for an effect this build does
 * not have; every value is clamped to its range and anything missing gets its default.
 */
export function readSlot(src: unknown): Slot | null {
  const s = (src ?? {}) as Partial<Slot>;
  const def = typeof s.type === 'string' ? fxDef(s.type) : undefined;
  if (!def) return null;
  const p = defaultParams(def);
  const sp = (s.p ?? {}) as Record<string, unknown>;
  for (const q of def.params) {
    let v = num(sp[q.key], q.min, q.max, q.def);
    if (q.choices || q.curve === 'int') v = Math.round(v);
    p[q.key] = v;
  }
  const allowed = new Set(['mix', ...def.params.filter(automatable).map((q) => q.key)]);
  const auto = readAuto(s.auto, allowed);
  // automation values are clamped like the controls they move
  if (auto)
    for (const l of auto.lanes) {
      const q = def.params.find((x) => x.key === l.key);
      const lo = q ? q.min : 0;
      const hi = q ? q.max : 1;
      l.v = l.v.map((x) => Math.min(hi, Math.max(lo, x)));
    }
  return {
    id: typeof s.id === 'string' && s.id ? s.id : newId(),
    type: def.type,
    on: typeof s.on === 'boolean' ? s.on : true,
    mix: num(s.mix, 0, 1, def.mix),
    p,
    seed: Math.round(num(s.seed, 1, 1e9, 1)),
    auto,
  };
}

/** A deep copy with fresh ids (a preset applied twice must not share slot ids). */
export function cloneSlots(slots: Slot[], freshIds = false): Slot[] {
  return slots.map((s) => ({ ...(JSON.parse(JSON.stringify(s)) as Slot), id: freshIds ? newId() : s.id }));
}

/** Every effect type, for tests and the browser. */
export const ALL_TYPES = FX.map((d) => d.type);
