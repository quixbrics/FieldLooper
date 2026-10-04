/*
 * Space: an 8-line feedback delay network reverb with optional shimmer
 * (pitch-shifted feedback) and freeze. (FXMaker's; its resonator bank is left
 * out: FieldLooper uses its own, in fx-reso.js, which the sequencer can drive.)
 */

const FDN_MS = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.7, 73.1];
const DIFF_MS = [4.7, 3.6, 12.7, 9.3];

class FxmFdn extends FxBase {
  static get defaults() {
    return { size: 1, decay: 6, damping: 0.4, mod: 0.3, shimmer: 0.5, interval: 12, freeze: 0, predelay: 20 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    const sr = this.sr;
    this.lines = FDN_MS.map((ms) => new DelayLine(Math.ceil((ms * 2.2 * sr) / 1000) + 200));
    this.lp = new Float64Array(8);
    this.vals = new Float64Array(8);
    this.diff = DIFF_MS.map((ms) => ({ line: new DelayLine(Math.ceil((ms * sr) / 1000) + 4), d: (ms * sr) / 1000 }));
    this.pre = new DelayLine(sr * 0.6);
    this.shift = new Shifter(sr, 200);
    this.shift.setWindowMs(110);
    this.ph = 0;
    this.lastMono = 0;
    this.inG = 1;
    this.dcL = new DCBlock();
    this.dcR = new DCBlock();
  }
  process(inputs, outputs) {
    const p = this.p;
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const [oL, oR] = outputs[0];
    const sr = this.sr;
    const frozen = p.freeze >= 0.5;
    const size = clamp(p.size, 0.15, 2.2);
    const T60 = clamp(p.decay, 0.2, 120);
    const lens = FDN_MS.map((ms) => (ms * size * sr) / 1000);
    const gains = lens.map((l) => (frozen ? 1 : Math.pow(10, (-3 * (l / sr)) / T60)));
    const damp = frozen ? 0 : clamp(p.damping, 0, 0.98);
    const modD = (clamp(p.mod, 0, 1) * 1.2 * sr) / 1000;
    const shim = clamp(p.shimmer, 0, 1);
    const ratio = Math.pow(2, clamp(p.interval, -24, 24) / 12);
    const pd = clamp((p.predelay * sr) / 1000, 1, sr * 0.5);
    const lines = this.lines;
    const v = this.vals;
    for (let i = 0; i < oL.length; i++) {
      this.inG += ((frozen ? 0 : 1) - this.inG) * 0.003;
      this.pre.write(0.5 * (xL[i] + xR[i]) * this.inG);
      let u = this.pre.read(pd);
      // shimmer: the tail, pitch-shifted, fed back into the tank
      if (shim > 0) u += softclip(this.shift.process(this.lastMono, ratio) * shim * 0.6);
      // input diffusion (Schroeder allpasses)
      for (let k = 0; k < 4; k++) {
        const dfu = this.diff[k];
        const dd = dfu.line.read(dfu.d - 1);
        const w = u + 0.6 * dd;
        dfu.line.write(w);
        u = dd - 0.6 * w;
      }
      this.ph += 0.37 / sr;
      if (this.ph >= 1) this.ph -= 1;
      let sum = 0;
      for (let k = 0; k < 8; k++) {
        const m = modD * Math.sin(TAU * (this.ph + k * 0.125));
        let y = lines[k].read(lens[k] + m + modD);
        this.lp[k] += (y - this.lp[k]) * (1 - damp);
        y = this.lp[k] * gains[k];
        v[k] = y;
        sum += y;
      }
      const hh = (2 / 8) * sum;
      for (let k = 0; k < 8; k++) lines[k].write(softclip(v[k] - hh + u * 0.35));
      const l = v[0] - v[2] + v[4] - v[6] + 0.5 * (v[1] + v[5]);
      const r = v[1] - v[3] + v[5] - v[7] + 0.5 * (v[2] + v[6]);
      this.lastMono = 0.5 * (l + r);
      oL[i] = this.dcL.process(l * 0.6);
      oR[i] = this.dcR.process(r * 0.6);
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-fdn', FxmFdn);
