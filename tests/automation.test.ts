import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AutoRecorder, autoValue, loopPhase, mergePunch, thin, valuesAt } from '../src/audio/automation';
import type { Automation } from '../src/fx/slot';
import { render, sine } from './harness';

const SR = 48000;
const id = (x: number) => x;

/** the audio thread's copy of autoValue, out of dsp/common.js */
const jsAutoValue = (() => {
  const src = readFileSync(join(__dirname, '../src/audio/dsp/common.js'), 'utf8');
  const body = src.slice(src.indexOf('function autoValue('), src.indexOf('/* ------------------------------------------------------- base class'));
  return new Function(`${body}; return autoValue;`)() as typeof autoValue;
})();

describe('reading a lane', () => {
  const ts = [1, 3, 6];
  const vs = [0, 10, 4];
  it('joins points with straight lines', () => {
    expect(autoValue(1, ts, vs, 8)).toBe(0);
    expect(autoValue(2, ts, vs, 8)).toBe(5);
    expect(autoValue(4.5, ts, vs, 8)).toBe(7);
  });
  it('wraps from the last point to the first across the loop end', () => {
    // 6 → 9 (= 1 + 8): 4 → 0 over 3 s
    expect(autoValue(7.5, ts, vs, 8)).toBeCloseTo(2, 9);
    expect(autoValue(0, ts, vs, 8)).toBeCloseTo(4 / 3, 9);
  });
  it('one point is a constant; no points is nothing', () => {
    expect(autoValue(5, [2], [7], 8)).toBe(7);
    expect(autoValue(5, [], [], 8)).toBeNaN();
  });
  it('the audio thread reads lanes exactly as the main thread does', () => {
    for (let t = 0; t < 8; t += 0.137) expect(jsAutoValue(t, ts, vs, 8)).toBe(autoValue(t, ts, vs, 8));
    expect(jsAutoValue(3, [2], [7], 8)).toBe(7);
  });
  it('loopPhase wraps however long it has been running', () => {
    expect(loopPhase(10, 4, 4)).toBeCloseTo(2, 9);
    expect(loopPhase(4, 4, 4)).toBe(0);
    expect(loopPhase(1003.5, 3.5, 4)).toBeCloseTo(0, 9);
  });
});

describe('thinning', () => {
  it('drops points on a straight line and keeps corners', () => {
    const t = [0, 1, 2, 3, 4, 5, 6];
    const v = [0, 1, 2, 3, 2, 1, 0];
    const r = thin(t, v, (x) => x / 10);
    expect(r.t).toEqual([0, 3, 6]);
    expect(r.v).toEqual([0, 3, 0]);
  });
  it('a jittery line within tolerance collapses to its ends', () => {
    const t = Array.from({ length: 50 }, (_, i) => i / 10);
    const v = t.map((x, i) => x * 10 + (i % 2 ? 0.01 : -0.01));
    expect(thin(t, v, (x) => x / 100, 0.004).t.length).toBe(2);
  });
});

describe('recording a fresh loop', () => {
  it('the clock starts at the first touch and the loop is as long as you played', () => {
    const r = new AutoRecorder(null, 0, () => id);
    r.down('cutoff', 10, 500);
    r.move('cutoff', 10.5, 800);
    r.move('cutoff', 11, 1000);
    const a = r.finish(14)!;
    expect(a.len).toBe(4);
    const lane = a.lanes[0];
    expect(lane.key).toBe('cutoff');
    expect(lane.t[0]).toBe(0);
    expect(lane.v[0]).toBe(500);
    // after the last move it holds until just before the end
    expect(autoValue(3, lane.t, lane.v, a.len)).toBe(1000);
  });
  it('a control first touched part-way through sits at its old value until then', () => {
    const r = new AutoRecorder(null, 0, () => id);
    r.down('a', 0, 0);
    r.move('a', 1, 1);
    r.down('b', 2, 0.25);
    r.move('b', 3, 0.75);
    const a = r.finish(4)!;
    const b = a.lanes.find((l) => l.key === 'b')!;
    expect(autoValue(1, b.t, b.v, a.len)).toBe(0.25);
    expect(autoValue(3, b.t, b.v, a.len)).toBe(0.75);
  });
  it('nothing touched records nothing; a tap closes to the shortest loop', () => {
    expect(new AutoRecorder(null, 0, () => id).finish(5)).toBeNull();
    const r = new AutoRecorder(null, 0, () => id);
    r.down('a', 1, 0.5);
    expect(r.finish(1.01)!.len).toBe(0.25);
  });
  it('is capped at 120 s', () => {
    const r = new AutoRecorder(null, 0, () => id);
    r.down('a', 0, 0);
    r.move('a', 200, 1);
    expect(r.finish(300)!.len).toBe(120);
  });
});

describe('punching in', () => {
  const base: Automation = { len: 10, lanes: [{ key: 'x', t: [0, 5], v: [0, 1] }] };
  it('overwrites only the span the finger was on, and keeps the rest', () => {
    const m = mergePunch(base, 'x', { t: [2, 3, 4], v: [9, 9, 9] }, 0, (v) => v / 10);
    const l = m.lanes[0];
    expect(autoValue(3, l.t, l.v, 10)).toBe(9);
    expect(autoValue(7.5, l.t, l.v, 10)).toBeCloseTo(autoValue(7.5, base.lanes[0].t, base.lanes[0].v, 10), 6);
    expect(m.len).toBe(10);
  });
  it('a stroke across the loop end wraps round', () => {
    const m = mergePunch(base, 'x', { t: [9, 10, 11], v: [5, 5, 5] }, 0, (v) => v / 10);
    const l = m.lanes[0];
    expect(autoValue(9.5, l.t, l.v, 10)).toBe(5);
    expect(autoValue(0.5, l.t, l.v, 10)).toBe(5);
    expect(autoValue(4, l.t, l.v, 10)).toBeCloseTo(autoValue(4, base.lanes[0].t, base.lanes[0].v, 10), 6);
  });
  it('a control with no lane yet gets one that holds its setting outside the punch', () => {
    const m = mergePunch(base, 'y', { t: [2, 3], v: [0.9, 0.9] }, 0.3, id);
    const l = m.lanes.find((x) => x.key === 'y')!;
    expect(autoValue(2.5, l.t, l.v, 10)).toBe(0.9);
    expect(autoValue(6, l.t, l.v, 10)).toBeCloseTo(0.3, 6);
    expect(m.lanes.find((x) => x.key === 'x')).toEqual(base.lanes[0]);
  });
  it('the recorder merges each stroke when the finger lifts, on the playing loop', () => {
    // the loop began at t = 100; a finger lands 2 s into it
    const r = new AutoRecorder(base, 100, () => id);
    expect(r.punch).toBe(true);
    r.down('x', 102, 0.4);
    r.move('x', 102.5, 7);
    r.move('x', 103, 7);
    const m = r.up('x', 0)!;
    expect(autoValue(2.75, m.lanes[0].t, m.lanes[0].v, 10)).toBe(7);
    expect(r.finish(200)).toBe(m);
  });
  it('valuesAt skips held controls', () => {
    const a: Automation = { len: 4, lanes: [{ key: 'a', t: [0], v: [1] }, { key: 'b', t: [0], v: [2] }] };
    expect(valuesAt(a, 1)).toEqual({ a: 1, b: 2 });
    expect(valuesAt(a, 1, new Set(['b']))).toEqual({ a: 1 });
  });
});

describe('automation on the audio thread', () => {
  // a tremolo whose depth is automated 0 → 1 → 0 over a 2 s loop
  const auto = { start: 0, len: 2, lanes: [{ key: 'depth', t: [0, 1], v: [0, 1] }] };
  const params = { rate: 8, depth: 0, shape: 0, phase: 0 };
  const rmsWindow = (x: Float32Array, at: number, w = 0.1) => {
    const a = Math.floor(at * SR);
    let s = 0;
    for (let i = a; i < a + w * SR; i++) s += x[i] * x[i];
    return Math.sqrt(s / (w * SR));
  };
  it('moves the parameter along the lane, looping', () => {
    const { out, node } = render('fxm-trem', sine(300, 4, 0.5), 4, { params, messages: [[0, { type: 'auto', auto }]] });
    const p = (node as unknown as { p: Record<string, number> }).p;
    expect(p.depth).toBeGreaterThanOrEqual(0);
    // tremolo depth ~0 near 0 s and 2 s, deep near 1 s and 3 s: the output's level swings more there
    const swing = (at: number) => {
      const vals = Array.from({ length: 8 }, (_, k) => rmsWindow(out[0], at + k * 0.0156, 0.0156));
      return Math.max(...vals) - Math.min(...vals);
    };
    expect(swing(0.95)).toBeGreaterThan(swing(0.02) + 0.05);
    expect(swing(2.95)).toBeGreaterThan(swing(2.02) + 0.05);
  });
  it('a held control is left alone until it is released', () => {
    const { node } = render('fxm-trem', sine(300, 1.5, 0.5), 1.5, {
      params,
      messages: [
        [0, { type: 'auto', auto }],
        [0.2, { type: 'autoHold', key: 'depth', on: true }],
        [0.21, { type: 'params', params: { depth: 0.123 } }],
      ],
    });
    expect((node as unknown as { p: Record<string, number> }).p.depth).toBe(0.123);
    const released = render('fxm-trem', sine(300, 1.5, 0.5), 1.5, {
      params,
      messages: [
        [0, { type: 'auto', auto }],
        [0.2, { type: 'autoHold', key: 'depth', on: true }],
        [0.21, { type: 'params', params: { depth: 0.123 } }],
        [0.4, { type: 'autoHold', key: 'depth', on: false }],
      ],
    });
    const d = (released.node as unknown as { p: Record<string, number> }).p.depth;
    expect(d).not.toBe(0.123);
    expect(Math.abs(d - autoValue(1.5, auto.lanes[0].t, auto.lanes[0].v, 2))).toBeLessThan(0.05);
  });
  it('a reset (blow-up recovery) does not lose the automation or its timing', () => {
    const { node } = render('fxm-trem', sine(300, 1.5, 0.5), 1.5, { params, messages: [[0, { type: 'auto', auto }], [0.7, { type: 'reset' }]] });
    const d = (node as unknown as { p: Record<string, number> }).p.depth;
    expect(Math.abs(d - autoValue(1.5, auto.lanes[0].t, auto.lanes[0].v, 2))).toBeLessThan(0.05);
  });
  it('clearing the automation stops it where it is', () => {
    const { node } = render('fxm-trem', sine(300, 1.5, 0.5), 1.5, { params, messages: [[0, { type: 'auto', auto }], [0.5, { type: 'auto', auto: null }]] });
    const d = (node as unknown as { p: Record<string, number> }).p.depth;
    expect(Math.abs(d - 0.5)).toBeLessThan(0.05);
  });
});
