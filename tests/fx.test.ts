import { FX, defaultParams, fromNorm, costOf, COST_BUDGET, automatable } from '../src/fx/registry';
import { procParams, resoNote } from '../src/audio/units';
import { render, material, noise, sine, stats, peakFreq } from './harness';

const worklet = FX.filter((d) => d.impl.startsWith('fxm-'));
const input = material(2.5);

/** What the processor is sent for a pick of settings (procParams turns the resonator's Key + Octave into a note). */
function paramsFor(d: (typeof FX)[number], pick: 'def' | 'min' | 'max' | number) {
  const p: Record<string, number> = defaultParams(d);
  let s = typeof pick === 'number' ? pick : 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (const q of d.params) {
    if (pick === 'min') p[q.key] = q.min;
    else if (pick === 'max') p[q.key] = q.max;
    else if (typeof pick === 'number') p[q.key] = fromNorm(q, rnd());
  }
  return procParams(d, p);
}

describe('the curated set', () => {
  it('has every FXMaker effect except the two convolution reverbs, each with a processor or native unit', () => {
    expect(FX).toHaveLength(31);
    expect(FX.some((d) => d.impl === 'reverb')).toBe(false);
    const native = FX.filter((d) => !d.impl.startsWith('fxm-')).map((d) => d.impl).sort();
    expect(native).toEqual(['compressor', 'drive', 'filter']);
  });
  it('caps spectral FFTs at 4096 points', () => {
    for (const d of FX.filter((x) => x.impl === 'fxm-spectral')) expect(d.params.find((q) => q.key === 'size')!.max).toBe(12);
  });
  it('gives every effect a load cost, and eight of the heaviest overload the budget', () => {
    for (const d of FX) expect(costOf(d.type)).toBeGreaterThan(0);
    const heaviest = Math.max(...FX.map((d) => costOf(d.type)));
    expect(heaviest * 8).toBeGreaterThan(COST_BUDGET);
  });
  it('only continuous controls are automatable', () => {
    const delay = FX.find((d) => d.type === 'delay')!;
    const can = delay.params.filter(automatable).map((q) => q.key);
    expect(can).toContain('feedback');
    expect(can).not.toContain('freeze');
    expect(can).not.toContain('pingpong');
  });
  it('the resonator is sent a MIDI note from its Key and Octave, and none while the sequencer plays it', () => {
    const d = FX.find((x) => x.type === 'resonator')!;
    const p = defaultParams(d);
    expect(procParams(d, p).note).toBe(resoNote(p.root, p.octave));
    expect(procParams(d, p).root).toBeUndefined();
    expect('note' in procParams(d, p, true)).toBe(false);
    expect(resoNote(9, 3)).toBe(57);
  });
});

describe('every worklet effect survives extremes', () => {
  for (const d of worklet) {
    it(`${d.type}`, () => {
      for (const pick of ['def', 'min', 'max', 101, 202, 303] as const) {
        const { out } = render(d.impl, input, 2.5, { params: paramsFor(d, pick) });
        const s = stats(out);
        expect(s.finite, `${d.type} ${pick} finite`).toBe(true);
        expect(s.peak, `${d.type} ${pick} bounded`).toBeLessThan(40);
      }
    });
  }
});

describe('effects do what they say', () => {
  it('frequency shifter moves 1 kHz up by 200 Hz', () => {
    const { out } = render('fxm-shift', sine(1000, 1.5, 0.5), 1.5, { params: { shift: 200, feedback: 0 } });
    expect(Math.abs(peakFreq(out[0].subarray(20000), 1000, 1400, 2) - 1200)).toBeLessThan(6);
  });
  it('pitch shifter: −12 halves 440 Hz', () => {
    const { out } = render('fxm-pitch', sine(440, 1.5, 0.5), 1.5, { params: { semis: -12, feedback: 0, delay: 0, window: 80 } });
    expect(Math.abs(peakFreq(out[0].subarray(20000), 180, 300, 1) - 220)).toBeLessThan(8);
  });
  it('delay at 130 % feedback is bounded', () => {
    const { out } = render('fxm-delay', input, 2.5, { params: { feedback: 1.3, drive: 1, timeL: 30, timeR: 31 } });
    expect(stats(out).peak).toBeLessThan(4);
  });
  it('infinite reverb freeze keeps ringing after the input stops', () => {
    const x = material(4);
    for (const c of x) c.fill(0, 48000);
    const { out } = render('fxm-fdn', x, 4, { params: { freeze: 0, decay: 120, shimmer: 0 }, changes: [[0.9, { freeze: 1 }]] });
    expect(stats([out[0].subarray(48000 * 3.5), out[1].subarray(48000 * 3.5)]).rms).toBeGreaterThan(0.005);
  });
  it('spectral freeze drones on after the input stops, even at the phone FFT cap', () => {
    const x = sine(330, 3, 0.4);
    for (const c of x) c.fill(0, 24000);
    const { out } = render('fxm-spectral', x, 3, { params: { mode: 0, hold: 1, every: 0, drift: 0.1, size: 13 } });
    expect(stats([out[0].subarray(96000)]).rms).toBeGreaterThan(0.05);
  });
  it('gate silences what falls below its threshold', () => {
    const quiet = noise(1, 0.003);
    const { out } = render('fxm-gate', quiet, 1, { params: { threshold: -20, floor: -80 } });
    expect(stats([out[0].subarray(24000)]).rms).toBeLessThan(1e-4);
  });
});
