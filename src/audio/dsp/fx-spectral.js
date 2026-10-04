/*
 * Spectral effects on a short-time Fourier transform: freeze, blur, scramble,
 * spectral gate. Both channels share one complex FFT (left in the real part,
 * right in the imaginary part) and are pulled apart by symmetry.
 */

class FxmSpectral extends FxBase {
  static get defaults() {
    return { mode: 0, size: 12, hold: 1, every: 0, glide: 0.3, drift: 0.2, amount: 0.7, band: 16, rate: 4, threshold: -50, invert: 0, tilt: 3 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    const N = 1 << clamp(Math.round(this.p.size), 9, 12);
    this.N = N;
    this.hop = N >> 2;
    const H = N / 2 + 1;
    this.inL = new Float32Array(N);
    this.inR = new Float32Array(N);
    this.wi = 0;
    this.cnt = 0;
    this.accL = new Float32Array(N * 2);
    this.accR = new Float32Array(N * 2);
    this.ri = 0;
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.mL = new Float64Array(H);
    this.pL = new Float64Array(H);
    this.mR = new Float64Array(H);
    this.pR = new Float64Array(H);
    this.hL = new Float64Array(H); // held / smoothed magnitudes
    this.hR = new Float64Array(H);
    this.tL = new Float64Array(H); // freeze targets
    this.tR = new Float64Array(H);
    this.aL = new Float64Array(H); // running phases
    this.aR = new Float64Array(H);
    this.perm = new Int32Array(H);
    for (let k = 0; k < H; k++) this.perm[k] = k;
    this.captured = false;
    this.liveFrames = 0;
    this.sinceCap = 0;
    this.sinceShuffle = 1e9;
  }
  onParams() {
    const N = 1 << clamp(Math.round(this.p.size), 9, 12);
    if (N !== this.N) this.reset();
    if (!this.p.hold) this.captured = false;
  }
  process(inputs, outputs) {
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const [oL, oR] = outputs[0];
    const N = this.N;
    for (let i = 0; i < oL.length; i++) {
      this.inL[this.wi] = xL[i];
      this.inR[this.wi] = xR[i];
      this.wi = (this.wi + 1) & (N - 1);
      if (++this.cnt >= this.hop) {
        this.cnt = 0;
        this.doFrame();
      }
      oL[i] = this.accL[this.ri];
      oR[i] = this.accR[this.ri];
      this.accL[this.ri] = 0;
      this.accR[this.ri] = 0;
      this.ri = (this.ri + 1) % (N * 2);
    }
    return this.guard(outputs);
  }
  doFrame() {
    const p = this.p;
    const N = this.N;
    const half = N >> 1;
    const re = this.re;
    const im = this.im;
    const w = hann(N);
    for (let n = 0; n < N; n++) {
      const j = (this.wi + n) & (N - 1);
      re[n] = this.inL[j] * w[n];
      im[n] = this.inR[j] * w[n];
    }
    getFFT(N).transform(re, im, false);
    const mL = this.mL, pL = this.pL, mR = this.mR, pR = this.pR;
    let energy = 0;
    for (let k = 0; k <= half; k++) {
      const a = re[k], b = im[k];
      const j = (N - k) & (N - 1);
      const c = re[j], d = im[j];
      const lr = 0.5 * (a + c), li = 0.5 * (b - d);
      const rr = 0.5 * (b + d), ri = 0.5 * (c - a);
      mL[k] = Math.hypot(lr, li);
      pL[k] = Math.atan2(li, lr);
      mR[k] = Math.hypot(rr, ri);
      pR[k] = Math.atan2(ri, rr);
      energy += mL[k] * mL[k] + mR[k] * mR[k];
    }
    const mode = Math.round(p.mode);
    let incoherent = 0;
    if (mode === 0) incoherent = this.freeze(energy);
    else if (mode === 1) incoherent = this.blur();
    else if (mode === 2) this.scramble();
    else this.gate();
    // recombine
    for (let k = 0; k <= half; k++) {
      const lr = mL[k] * Math.cos(pL[k]);
      const li = mL[k] * Math.sin(pL[k]);
      const rr = mR[k] * Math.cos(pR[k]);
      const ri = mR[k] * Math.sin(pR[k]);
      if (k === 0 || k === half) {
        re[k] = lr;
        im[k] = rr;
      } else {
        re[k] = lr - ri;
        im[k] = li + rr;
        re[N - k] = lr + ri;
        im[N - k] = rr - li;
      }
    }
    getFFT(N).transform(re, im, true);
    const g = 2 / 3 + (2 / 3) * incoherent;
    const L2 = N * 2;
    for (let n = 0; n < N; n++) {
      const j = (this.ri + n) % L2;
      this.accL[j] += re[n] * w[n] * g;
      this.accR[j] += im[n] * w[n] * g;
    }
  }
  freeze(energy) {
    const p = this.p;
    const half = this.N >> 1;
    const mL = this.mL, pL = this.pL, mR = this.mR, pR = this.pR;
    if (!p.hold) return 0;
    const hopSec = this.hop / this.sr;
    this.sinceCap += hopSec;
    const every = p.every > 0 ? Math.max(0.1, p.every) : 0;
    // wait until a whole window of real signal has arrived before the first capture
    this.liveFrames = energy > 1e-6 ? (this.liveFrames || 0) + 1 : 0;
    const wantCap = (!this.captured && this.liveFrames >= 4) || (every > 0 && this.sinceCap >= every);
    if (wantCap) {
      const first = !this.captured;
      for (let k = 0; k <= half; k++) {
        this.tL[k] = mL[k];
        this.tR[k] = mR[k];
        if (first) {
          this.hL[k] = mL[k];
          this.hR[k] = mR[k];
          this.aL[k] = pL[k];
          this.aR[k] = pR[k];
        }
      }
      this.captured = true;
      this.sinceCap = 0;
    }
    if (!this.captured) return 0;
    const gl = 1 - Math.pow(clamp(p.glide, 0, 0.995), 0.5) * 0.98;
    const drift = clamp(p.drift, 0, 1);
    for (let k = 0; k <= half; k++) {
      this.hL[k] += (this.tL[k] - this.hL[k]) * gl;
      this.hR[k] += (this.tR[k] - this.hR[k]) * gl;
      const adv = (TAU * k * this.hop) / this.N;
      this.aL[k] += adv + (this.rand() - 0.5) * TAU * drift;
      this.aR[k] += adv + (this.rand() - 0.5) * TAU * drift;
      mL[k] = this.hL[k];
      mR[k] = this.hR[k];
      pL[k] = this.aL[k];
      pR[k] = this.aR[k];
    }
    return drift;
  }
  blur() {
    const p = this.p;
    const half = this.N >> 1;
    const a = clamp(p.amount, 0, 1) * 0.985;
    const drift = clamp(p.drift, 0, 1);
    for (let k = 0; k <= half; k++) {
      this.hL[k] = this.hL[k] * a + this.mL[k] * (1 - a);
      this.hR[k] = this.hR[k] * a + this.mR[k] * (1 - a);
      this.mL[k] = this.hL[k];
      this.mR[k] = this.hR[k];
      this.pL[k] += (this.rand() - 0.5) * TAU * drift;
      this.pR[k] += (this.rand() - 0.5) * TAU * drift;
    }
    return drift;
  }
  scramble() {
    const p = this.p;
    const half = this.N >> 1;
    this.sinceShuffle += this.hop / this.sr;
    if (this.sinceShuffle >= 1 / clamp(p.rate, 0.05, 60)) {
      this.sinceShuffle = 0;
      const B = Math.round(clamp(p.band, 2, 512));
      const amt = clamp(p.amount, 0, 1);
      for (let k = 0; k <= half; k++) this.perm[k] = k;
      for (let s = 1; s < half; s += B) {
        const e = Math.min(half, s + B);
        for (let k = e - 1; k > s; k--) {
          if (this.rand() > amt) continue;
          const j = s + Math.floor(this.rand() * (k - s + 1));
          const t = this.perm[k];
          this.perm[k] = this.perm[j];
          this.perm[j] = t;
        }
      }
    }
    const mL = this.mL, pL = this.pL, mR = this.mR, pR = this.pR;
    this.hL.set(mL);
    this.tL.set(pL);
    this.hR.set(mR);
    this.tR.set(pR);
    for (let k = 1; k < half; k++) {
      const s = this.perm[k];
      mL[k] = this.hL[s];
      pL[k] = this.tL[s];
      mR[k] = this.hR[s];
      pR[k] = this.tR[s];
    }
  }
  gate() {
    const p = this.p;
    const half = this.N >> 1;
    const ref = this.N / 4;
    const kRef = (1000 * this.N) / this.sr;
    const inv = p.invert >= 0.5;
    for (let k = 1; k <= half; k++) {
      const thr = p.threshold - clamp(p.tilt, 0, 9) * Math.log2(k / kRef);
      const t = dbToLin(thr) * ref;
      const m = Math.max(this.mL[k], this.mR[k]);
      // soft 6 dB knee
      let g = clamp((m / t - 0.5) / 1.5, 0, 1);
      if (inv) g = 1 - g;
      this.mL[k] *= g;
      this.mR[k] *= g;
    }
  }
}
registerProcessor('fxm-spectral', FxmSpectral);
