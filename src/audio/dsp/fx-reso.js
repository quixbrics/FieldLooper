/*
 * The resonator: FXMaker's string bank reduced to what FieldLooper needs. ONE
 * note (continuous MIDI pitch, so the sequencer can move it) played as a chord
 * of up to 8 tuned strings, excited by whatever comes in. Pitch changes glide
 * over `glide` seconds. Decay runs from 20 ms (a pluck) to 30 s (a drone);
 * `pluck` adds a noise burst on every note change, `onset` adds one whenever
 * the incoming audio has a hit in it.
 *
 * Outputs only its wet signal; the slot's dry/wet blend is done with gain nodes.
 */

/* Chord shapes: semitone offsets above the note (max 8 strings). */
const RESO_CHORDS = [
  [0], // single
  [0, 12, 24], // octaves
  [0, 7, 12, 19], // fifths
  [0, 3, 7, 12], // minor
  [0, 4, 7, 12], // major
  [0, 5, 7, 12], // sus4
  [0, 3, 7, 10, 14], // minor 9
];

class FxmReso extends FxBase {
  static get defaults() {
    return { note: 57, chord: 2, decay: 0.7, bright: 0.5, spread: 0.3, drive: 0.2, glide: 0.4, pluck: 0, onset: 0, input: 1 };
  }
  constructor(o) {
    super(o);
    this.lastNote = this.p.note;
    // an offline render hands over the whole note list up front, as absolute frames
    this.initialQueue = ((o && o.processorOptions && o.processorOptions.queue) || []).slice().sort((a, b) => a.frame - b.frame);
    this.reset();
  }
  reset() {
    const maxD = Math.ceil(this.sr / 25) + 8;
    this.lines = [[], []];
    this.lp = [new Float64Array(8), new Float64Array(8)];
    for (let c = 0; c < 2; c++) for (let v = 0; v < 8; v++) this.lines[c].push(new DelayLine(maxD));
    this.dc = [new DCBlock(), new DCBlock()];
    this.freq = new Float64Array(8);
    this.pk = 0; // pluck burst level, decays in ~4 ms
    this.queue = this.initialQueue ? this.initialQueue.slice() : []; // timed notes from the sequencer
    this.envF = 0; // onset detector: fast and slow envelopes
    this.envS = 0;
    this.refract = 0;
  }
  /** A pluck: a short noise burst into every string. */
  pluck(level) {
    this.pk = Math.max(this.pk, clamp(level, 0, 1));
  }
  /** Change the note; a note CHANGE (not a repeat) is plucked if Pluck is up. */
  setNote(note, offsets) {
    if (offsets !== undefined) this.p.offsets = offsets;
    this.p.note = note;
    if (note !== this.lastNote) {
      this.lastNote = note;
      if (this.p.pluck > 0) this.pluck(this.p.pluck);
    }
  }
  onParams() {
    // a note change arriving as a plain parameter (a key tapped on the phone)
    if (this.p.note !== this.lastNote) this.setNote(this.p.note);
  }
  onMessage(m) {
    if (m.type === 'note') this.queue.push(m);
    else if (m.type === 'clear') this.queue.length = 0;
    // offsets: a custom set of intervals (stacked scale thirds); chord: back to the chord shape
    else if (m.type === 'offsets' && Array.isArray(m.offsets)) this.p.offsets = m.offsets.slice(0, 8);
    else if (m.type === 'chord') this.p.offsets = null;
  }
  /** Fire queued notes whose time falls in this block. Events carry an absolute frame. */
  runQueue(n) {
    const now = typeof currentFrame === 'number' ? currentFrame : this.frame;
    while (this.queue.length && this.queue[0].frame < now + n) {
      const ev = this.queue.shift();
      this.setNote(ev.note, ev.offsets === undefined ? undefined : ev.offsets && ev.offsets.slice(0, 8));
      if (ev.pluck) this.pluck(ev.pluck);
    }
  }
  /** Onset detector on the incoming audio: a fast envelope jumping above a slow one. */
  detect(xL, xR) {
    const sens = clamp(this.p.onset, 0, 1);
    if (sens <= 0) return;
    const sr = this.sr;
    const aF = coefMs(2, sr);
    const rF = coefMs(30, sr);
    const aS = coefMs(200, sr);
    const ratio = 1.25 + (1 - sens) * 3;
    for (let i = 0; i < xL.length; i++) {
      const a = Math.abs(xL[i]) + Math.abs(xR[i]);
      this.envF += (a - this.envF) * (a > this.envF ? aF : rF);
      this.envS += (a - this.envS) * aS;
      if (this.refract > 0) this.refract--;
      else if (this.envF > 0.01 && this.envF > this.envS * ratio) {
        this.refract = Math.round(0.08 * sr);
        this.pluck(0.3 + 0.7 * clamp(this.p.pluck, 0, 1));
      }
    }
  }
  process(inputs, outputs) {
    const p = this.p;
    const out = outputs[0];
    const sr = this.sr;
    const blk = out[0].length;
    this.runQueue(blk);
    this.detect(inCh(inputs, 0), inCh(inputs, 1));
    const T60 = 0.02 * Math.pow(1500, clamp(p.decay, 0, 1)); // 20 ms .. 30 s
    const lpa = 0.15 + 0.85 * clamp(p.bright, 0, 1);
    const drv = 1 + clamp(p.drive, 0, 1) * 3;
    const spread = clamp(p.spread, 0, 1);
    const lpDelay = (1 - lpa) / lpa;
    const exc = 0.3 * clamp(p.input, 0, 1);
    const offs = p.offsets && p.offsets.length ? p.offsets : RESO_CHORDS[Math.round(clamp(p.chord, 0, RESO_CHORDS.length - 1))];
    const nv = Math.min(8, offs.length);
    const base = 440 * Math.pow(2, (clamp(p.note, 12, 108) - 69) / 12);
    // glide: the per-block smoothing coefficient for a time constant of `glide` seconds
    const gl = 1 - Math.exp(-blk / (sr * Math.max(0.004, p.glide)));
    for (let v = 0; v < nv; v++) {
      const tf = base * Math.pow(2, offs[v] / 12);
      this.freq[v] = this.freq[v] > 0 ? this.freq[v] + (tf - this.freq[v]) * gl : tf;
    }
    const norm = (0.25 / Math.sqrt(Math.max(1, nv))) * 4;
    const pkDecay = Math.exp(-1 / (0.004 * sr));
    const pk0 = this.pk;
    let pkEnd = pk0;
    for (let c = 0; c < 2; c++) {
      const x = inCh(inputs, c);
      const y = out[c];
      const lines = this.lines[c];
      const lps = this.lp[c];
      const det = c ? Math.pow(2, (spread * 18) / 1200) : 1;
      const ds = [];
      const fbs = [];
      for (let v = 0; v < nv; v++) {
        const f = clamp(this.freq[v] * det, 25, sr / 6);
        ds.push(Math.max(2, sr / f - 1 - lpDelay)); // minus the in-loop low-pass's own delay, so the string is in tune
        fbs.push(Math.pow(10, -3 / (f * T60)));
      }
      let pk = pk0;
      for (let i = 0; i < x.length; i++) {
        let s = 0;
        for (let v = 0; v < nv; v++) {
          const line = lines[v];
          const r = line.read(ds[v]);
          lps[v] += (r - lps[v]) * lpa;
          let e = x[i] * exc;
          if (pk > 1e-4) e += (this.rand() * 2 - 1) * pk * 0.5;
          const w = softclip((e + lps[v] * fbs[v]) * drv) / drv;
          line.write(w);
          s += w;
        }
        if (pk > 1e-4) pk *= pkDecay;
        y[i] = this.dc[c].process(s * norm);
      }
      pkEnd = pk;
    }
    this.pk = pkEnd;
    return this.guard(outputs);
  }
}
registerProcessor('fxm-reso', FxmReso);
