/*
 * Slot automation: recording a performance on a slot's controls into a loop,
 * and reading values back out of it. Pure functions and one small recorder
 * class, with no Web Audio in them, so all of it is tested in Node.
 *
 * Recording a slot (engine.ts drives this):
 *   - Arm a slot with no automation: the clock starts at the first touch, every
 *     control moved is stored against it, and disarming closes the loop (its
 *     length is however long you played, ≤ 120 s). It starts again from the top.
 *   - Arm a slot that already loops: PUNCH. The length stays; a lane you touch
 *     is overwritten only over the span your finger was on it.
 */
import { MAX_AUTO_SECONDS, type Automation, type Lane } from '../fx/slot';

/** Shortest loop a recording can close into. */
export const MIN_AUTO_SECONDS = 0.25;
/** When a lane was only touched part-way through, its last value holds until this close to the loop end, then glides home. */
const WRAP_GLIDE = 0.05;
/** A punch-in keeps the old values right up to this close to the edges of what was played. */
const EDGE = 0.01;

/**
 * The value of a lane at `t` seconds into a loop of `len`. Straight lines between
 * points; the last point joins the first across the loop's end. Kept identical to
 * autoValue() in dsp/common.js, which does the same on the audio thread.
 */
export function autoValue(t: number, ts: ArrayLike<number>, vs: ArrayLike<number>, len: number): number {
  const n = ts.length;
  if (n === 0) return NaN;
  if (n === 1) return vs[0];
  if (t < ts[0] || t >= ts[n - 1]) {
    const t0 = ts[n - 1];
    const span = ts[0] + len - t0;
    const x = t >= t0 ? t - t0 : t + len - t0;
    return span > 0 ? vs[n - 1] + (vs[0] - vs[n - 1]) * (x / span) : vs[0];
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = ts[hi] - ts[lo];
  return span > 0 ? vs[lo] + (vs[hi] - vs[lo]) * ((t - ts[lo]) / span) : vs[hi];
}

/** Where a loop that began at `startSec` is at time `nowSec`, in seconds 0..len. */
export function loopPhase(nowSec: number, startSec: number, len: number): number {
  const t = nowSec - startSec;
  return t - Math.floor(t / len) * len;
}

/**
 * Thin a lane (Ramer–Douglas–Peucker): drop points that lie within `eps` of the
 * line through their neighbours. `scale` maps a value onto 0..1 so `eps` means the
 * same for a frequency as for a percentage.
 */
export function thin(t: number[], v: number[], scale: (x: number) => number, eps = 0.004): { t: number[]; v: number[] } {
  const n = t.length;
  if (n <= 2) return { t: t.slice(), v: v.slice() };
  const u = v.map(scale);
  // time is scaled so a second counts about as much as the whole range of the control
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let at = -1;
    const dt = t[b] - t[a];
    for (let i = a + 1; i < b; i++) {
      const f = dt > 0 ? (t[i] - t[a]) / dt : 0;
      const d = Math.abs(u[i] - (u[a] + (u[b] - u[a]) * f));
      if (d > worst) (worst = d), (at = i);
    }
    if (worst > eps && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const ot: number[] = [];
  const ov: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) ot.push(t[i]), ov.push(v[i]);
  return { t: ot, v: ov };
}

/** Points recorded for one control during one take. */
interface Stroke {
  /** seconds since the clock started (fresh) or unwrapped loop phase (punch) */
  t: number[];
  v: number[];
}

/**
 * Records one slot. `base` is the automation already looping (null = a fresh
 * recording); `scale(key)` maps that control's value onto 0..1 for thinning.
 */
export class AutoRecorder {
  /** clock start (seconds, context time) of a fresh recording; null until the first touch */
  t0: number | null = null;
  private fresh = new Map<string, Stroke & { v0: number }>();
  /** punch strokes in progress, and finished ones waiting to be merged */
  private live = new Map<string, Stroke & { down: number }>();

  constructor(
    readonly base: Automation | null,
    /** for a punch: when the playing loop began (seconds, context time) */
    readonly baseStart: number,
    private scale: (key: string) => (x: number) => number,
  ) {}

  get punch(): boolean {
    return this.base !== null;
  }

  /** seconds recorded so far (fresh recordings) */
  elapsed(now: number): number {
    return this.t0 === null ? 0 : now - this.t0;
  }

  /** A finger went down on a control (`before` = its value just before). */
  down(key: string, now: number, before: number) {
    if (this.punch) {
      const ph = loopPhase(now, this.baseStart, this.base!.len);
      this.live.set(key, { t: [ph], v: [before], down: now });
      return;
    }
    if (this.t0 === null) this.t0 = now;
    if (!this.fresh.has(key)) {
      const t = now - this.t0;
      this.fresh.set(key, { t: [t], v: [before], v0: before });
    }
  }

  /** The control moved. */
  move(key: string, now: number, value: number) {
    if (this.punch) {
      const s = this.live.get(key);
      if (!s) return;
      const ph = s.t[0] + (now - s.down);
      if (ph - s.t[0] > this.base!.len - 2 * EDGE) return; // held for longer than the loop: the first pass stands
      s.t.push(ph);
      s.v.push(value);
      return;
    }
    if (this.t0 === null) this.down(key, now, value);
    const s = this.fresh.get(key)!;
    const t = now - this.t0!;
    if (t < s.t[s.t.length - 1]) return;
    s.t.push(t);
    s.v.push(value);
  }

  /**
   * The finger left a control. In a punch the stroke is merged into the loop at once and the
   * new automation returned (so it can be heard straight away); otherwise null.
   */
  up(key: string, staticValue: number): Automation | null {
    if (!this.punch) return null;
    const s = this.live.get(key);
    this.live.delete(key);
    if (!s || s.t.length < 2) return null;
    const merged = mergePunch(this.base!, key, s, staticValue, this.scale(key));
    (this as { base: Automation | null }).base = merged;
    return merged;
  }

  /**
   * Close a fresh recording into a loop of however long it ran. Null if nothing was touched.
   * (A punch has already been merged stroke by stroke: its result is `base`.)
   */
  finish(now: number): Automation | null {
    if (this.punch) return this.base;
    if (this.t0 === null || !this.fresh.size) return null;
    const len = Math.min(MAX_AUTO_SECONDS, Math.max(MIN_AUTO_SECONDS, now - this.t0));
    const lanes: Lane[] = [];
    for (const [key, s] of this.fresh) {
      let t = s.t.filter((x) => x <= len);
      let v = s.v.slice(0, t.length);
      if (!t.length) continue;
      // before the first touch the control sat at its old value
      if (t[0] > 0) (t = [0, ...t]), (v = [s.v0, ...v]);
      // after the last move it holds, then glides back to where the loop starts
      const hold = len - WRAP_GLIDE;
      if (t[t.length - 1] < hold) t.push(hold), v.push(v[v.length - 1]);
      lanes.push({ key, ...thin(t, v, this.scale(key)) });
    }
    return lanes.length ? { len, lanes } : null;
  }
}

/** Overwrite one lane over the span a punch stroke covered (wrapping round the loop end if it did). */
export function mergePunch(base: Automation, key: string, s: Stroke, staticValue: number, scale: (x: number) => number): Automation {
  const len = base.len;
  const a = s.t[0];
  const b = s.t[s.t.length - 1];
  const old = base.lanes.find((l) => l.key === key);
  const valueAt = (x: number) => (old ? autoValue(((x % len) + len) % len, old.t, old.v, len) : staticValue);
  const wrap = (x: number) => ((x % len) + len) % len;
  // inside [a, b] on the loop (which may cross the end)
  const inside = (x: number) => {
    const d = wrap(x - a);
    return d <= b - a;
  };
  const pts: [number, number][] = [];
  if (old) for (let i = 0; i < old.t.length; i++) if (!inside(old.t[i]) && !inside(old.t[i] + EDGE) && !inside(old.t[i] - EDGE)) pts.push([old.t[i], old.v[i]]);
  pts.push([wrap(a - EDGE), valueAt(a - EDGE)]);
  pts.push([wrap(b + EDGE), valueAt(b + EDGE)]);
  for (let i = 0; i < s.t.length; i++) pts.push([wrap(s.t[i]), s.v[i]]);
  pts.sort((p, q) => p[0] - q[0]);
  const thinned = thin(
    pts.map((p) => p[0]),
    pts.map((p) => p[1]),
    scale,
  );
  const lanes = base.lanes.filter((l) => l.key !== key);
  lanes.push({ key, ...thinned });
  return { len, lanes };
}

/** Every automated value at loop phase `t` (for the native effects, the wet/dry and the sliders). */
export function valuesAt(auto: Automation, t: number, skip?: Set<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of auto.lanes) {
    if (skip?.has(l.key)) continue;
    const v = autoValue(t, l.t, l.v, auto.len);
    if (Number.isFinite(v)) out[l.key] = v;
  }
  return out;
}
