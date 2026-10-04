import { repairSpeed, resampleTo } from '../src/audio/loopfx';
import { WavStream, encodeWav, parseWav } from '../src/audio/wav';
import { packProject, unpackProject } from '../src/io/project';
import { readZip } from '../src/io/zip';
import { render, sine, stats, peakFreq } from './harness';
import type { ProjectData } from '../src/audio/engine';

const SR = 48000;

describe('speed repair (a take must be as long as the time that really passed)', () => {
  it('leaves a normal take alone, even with a little start/stop latency', () => {
    const raw = sine(300, 4, 0.5)[0];
    const r = repairSpeed(raw, SR, 4.06);
    expect(r.ratio).toBe(1);
    expect(r.data).toBe(raw);
  });
  it('stretches a take that came in 1.5× too short back to real time, restoring its pitch', () => {
    // 6 s of a 300 Hz tone was recorded, but only 4 s of samples arrived: it plays back at 450 Hz
    const raw = sine(450, 4, 0.5)[0]; // what the broken capture hands us
    const r = repairSpeed(raw, SR, 6);
    expect(r.ratio).toBeCloseTo(4 / 6, 2);
    expect(r.data.length).toBe(6 * SR);
    expect(Math.abs(peakFreq(r.data, 250, 350, 1) - 300)).toBeLessThan(3);
  });
  it('does not guess on very short takes', () => {
    const raw = sine(300, 0.8, 0.5)[0];
    expect(repairSpeed(raw, SR, 1.6).ratio).toBe(1);
  });
  it('resampleTo hits the requested length and keeps the endpoints', () => {
    const r = resampleTo(Float32Array.of(0, 1, 0, -1), 7);
    expect(r.length).toBe(7);
    expect(r[0]).toBe(0);
    expect(r[6]).toBe(-1);
  });
});

describe('capture keeps real time', () => {
  it('counts frames the input skipped as silence, so a take never comes up short', () => {
    // no input at all for the whole run (a route change on iOS can do this)
    const { messages } = render('fs-capture', null, 1, { messages: [[0, { type: 'rec', on: true }], [0.99, { type: 'rec', on: false }]] });
    const chunks = messages.filter((m) => (m as { type: string }).type === 'chunk') as { data: Float32Array }[];
    const n = chunks.reduce((s, c) => s + c.data.length, 0);
    expect(Math.abs(n - 0.99 * SR)).toBeLessThanOrEqual(256);
  });
});

describe('performance record tap', () => {
  it('records both channels of what it is fed, bit-exact', () => {
    const L = sine(220, 1, 0.4)[0];
    const R = sine(330, 1, 0.3)[0];
    const { messages } = render('fs-tap', [L, R], 1, { messages: [[0.1, { type: 'rec', on: true }], [0.6, { type: 'rec', on: false }]] });
    const chunks = messages.filter((m) => (m as { type: string }).type === 'chunk') as { l: Float32Array; r: Float32Array }[];
    const l = new Float32Array(chunks.reduce((s, c) => s + c.l.length, 0));
    const r = new Float32Array(l.length);
    let o = 0;
    for (const c of chunks) (l.set(c.l, o), r.set(c.r, o), (o += c.l.length));
    expect(Math.abs(l.length - 0.5 * SR)).toBeLessThanOrEqual(256);
    const start = Math.round((0.1 * SR) / 128) * 128;
    for (let i = 0; i < 300; i++) {
      expect(l[i]).toBeCloseTo(L[start + i], 5);
      expect(r[i]).toBeCloseTo(R[start + i], 5);
    }
  });
  it('is silent and costs nothing when not recording', () => {
    const { messages } = render('fs-tap', sine(100, 0.5), 0.5);
    expect(messages.length).toBe(0);
  });
});

describe('wav', () => {
  it('24-bit stereo round-trips within a quantisation step', async () => {
    const L = sine(220, 0.2, 0.7)[0];
    const R = sine(330, 0.2, 0.2)[0];
    const blob = encodeWav([L, R], 44100, 24);
    const w = parseWav(await blob.arrayBuffer());
    expect(w.sampleRate).toBe(44100);
    expect(w.channels.length).toBe(2);
    expect(w.channels[0].length).toBe(L.length);
    for (let i = 0; i < L.length; i += 97) {
      expect(Math.abs(w.channels[0][i] - L[i])).toBeLessThan(1e-5);
      expect(Math.abs(w.channels[1][i] - R[i])).toBeLessThan(1e-5);
    }
  });
  it('refuses a file that is not a WAV', () => {
    expect(() => parseWav(new Uint8Array(100))).toThrow(/not a WAV/);
  });
  it('a WAV written chunk by chunk as it arrives is the same as one written at once', async () => {
    const L = sine(220, 0.5, 0.6)[0];
    const R = sine(330, 0.5, 0.4)[0];
    const ws = new WavStream(2, SR, 24);
    for (let o = 0; o < L.length; o += 4096) ws.push([L.subarray(o, o + 4096), R.subarray(o, o + 4096)]);
    expect(ws.frames).toBe(L.length);
    expect(ws.seconds).toBeCloseTo(0.5, 6);
    const w = parseWav(await ws.finish().arrayBuffer());
    expect(w.channels[0].length).toBe(L.length);
    for (let i = 0; i < L.length; i += 211) {
      expect(Math.abs(w.channels[0][i] - L[i])).toBeLessThan(1e-5);
      expect(Math.abs(w.channels[1][i] - R[i])).toBeLessThan(1e-5);
    }
  });
});

describe('project files', () => {
  const project = (over: Partial<ProjectData> = {}): ProjectData => ({
    app: 'FieldLooper',
    v: 1,
    sampleRate: SR,
    masterLevel: 0.7,
    track: {} as ProjectData['track'],
    chain: [{ id: 'a', type: 'chorus', on: true, mix: 0.5, p: { rate: 1 }, seed: 3, auto: { len: 4, lanes: [{ key: 'mix', t: [0, 2], v: [0, 1] }] } }],
    wet: 0.8,
    seq: { scale: 'dorian', motion: 'drift', range: 2, chance: 0.8, chordSize: 0, seed: 9, rate: 2 },
    seqTarget: null,
    ...over,
  });
  it('packs and unpacks the settings, the chain with its automation, and the loop', async () => {
    const a = sine(220, 1, 0.5)[0];
    const blob = await packProject(project(), [a]);
    const out = unpackProject(await blob.arrayBuffer());
    expect(out.project.seq?.seed).toBe(9);
    expect(out.project.chain?.[0].auto?.lanes[0].v).toEqual([0, 1]);
    expect(out.sampleRate).toBe(SR);
    expect(out.loop![0].length).toBe(a.length);
    expect(stats([out.loop![0]]).peak).toBeCloseTo(0.5, 3);
  });
  it('a project with no recording (just a chain) has no audio inside', async () => {
    const blob = await packProject(project(), null);
    const out = unpackProject(await blob.arrayBuffer());
    expect(out.loop).toBeNull();
    expect([...readZip(await blob.arrayBuffer()).keys()]).toEqual(['project.json']);
  });
  it('the loop is a plain WAV inside the zip, so the file can be unzipped by hand', async () => {
    const blob = await packProject(project(), [sine(220, 0.3, 0.5)[0]]);
    const files = readZip(await blob.arrayBuffer());
    expect([...files.keys()].sort()).toEqual(['loop.wav', 'project.json']);
  });
  it('rejects a zip that is not a FieldLooper project, and files that are not zips at all', async () => {
    const { makeZip } = await import('../src/io/zip');
    const zb = await (await makeZip([{ name: 'project.json', data: '{"app":"FieldStretcher"}' }])).arrayBuffer();
    expect(() => unpackProject(zb)).toThrow(/not a FieldLooper/);
    const none = await (await makeZip([{ name: 'readme.txt', data: 'hi' }])).arrayBuffer();
    expect(() => unpackProject(none)).toThrow(/no project.json/);
    expect(() => unpackProject(new ArrayBuffer(64))).toThrow();
  });
  it('rejects a damaged project.json', async () => {
    const { makeZip } = await import('../src/io/zip');
    const zb = await (await makeZip([{ name: 'project.json', data: '{nope' }])).arrayBuffer();
    expect(() => unpackProject(zb)).toThrow(/damaged/);
  });
});
