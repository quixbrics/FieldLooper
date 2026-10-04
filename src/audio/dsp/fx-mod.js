/*
 * Modulation and pitch: ring mod, frequency shifter, pitch shifter (and the
 * spiral delay built on it), chorus / flanger, phaser, wow & flutter,
 * Doppler, tremolo / auto-pan, stereo width.
 */

function lfoShape(shape, ph, held) {
  // ph 0..1
  switch (shape | 0) {
    case 1: return ph < 0.5 ? ph * 4 - 1 : 3 - ph * 4; // triangle
    case 2: return ph < 0.5 ? 1 : -1; // square
    case 3: return ph * 2 - 1; // saw
    case 4: return held; // sample & hold
    default: return Math.sin(TAU * ph);
  }
}

class FxmRing extends FxBase {
  static get defaults() {
    return { freq: 220, shape: 0, drift: 0, spread: 0 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.ph = [0, 0];
    this.held = [0, 0];
    this.walk = 0;
    this.walkT = 0;
    this.walkS = 0;
  }
  process(inputs, outputs) {
    const p = this.p;
    const out = outputs[0];
    const n = out[0].length;
    // drift: a slow random walk of up to ±2 octaves
    if (p.drift > 0) {
      this.walkT -= n;
      if (this.walkT <= 0) {
        this.walkT = this.sr * 0.25;
        this.walk = clamp(this.walk + (this.rand() * 2 - 1) * 0.35 * p.drift, -2 * p.drift, 2 * p.drift);
      }
    } else this.walk = 0;
    for (let c = 0; c < 2; c++) {
      const x = inCh(inputs, c);
      const y = out[c];
      let ph = this.ph[c];
      for (let i = 0; i < n; i++) {
        if (c === 0) this.walkS += (this.walk - this.walkS) * 0.0005;
        const f = clamp(p.freq, 0.05, 12000) * Math.pow(2, this.walkS) * (c ? 1 + p.spread * 0.5 : 1);
        ph += f / this.sr;
        if (ph >= 1) {
          ph -= Math.floor(ph);
          this.held[c] = this.rand() * 2 - 1;
        }
        y[i] = x[i] * lfoShape(p.shape, ph, this.held[c]);
      }
      this.ph[c] = ph;
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-ring', FxmRing);

/* ---- frequency shifter: allpass-pair Hilbert transformer (O. Niemitalo) -- */

class Hilbert {
  constructor() {
    this.ca = [0.6923878, 0.9360654322959, 0.988229522686, 0.9987488452737].map((a) => a * a);
    this.cb = [0.4021921162426, 0.856171088242, 0.9722909545651, 0.9952884791278].map((a) => a * a);
    this.reset();
  }
  reset() {
    this.sa = new Float64Array(16);
    this.sb = new Float64Array(16);
    this.dA = 0;
    this.i = 0;
    this.q = 0;
  }
  chain(x, c, s) {
    let u = x;
    for (let k = 0; k < 4; k++) {
      const o = k * 4; // x1 x2 y1 y2
      const y = c[k] * (u + s[o + 3]) - s[o + 1];
      s[o + 1] = s[o];
      s[o] = u;
      s[o + 3] = s[o + 2];
      s[o + 2] = y;
      u = y;
    }
    return u;
  }
  process(x) {
    const a = this.chain(x, this.ca, this.sa);
    this.i = this.dA;
    this.dA = a;
    this.q = this.chain(x, this.cb, this.sb);
  }
}

class FxmShift extends FxBase {
  static get defaults() {
    return { shift: 120, feedback: 0, delay: 80, spread: 0 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.h = [new Hilbert(), new Hilbert()];
    this.lines = [new DelayLine(this.sr * 2.1), new DelayLine(this.sr * 2.1)];
    this.ph = [0, 0];
    this.dc = [new DCBlock(), new DCBlock()];
  }
  process(inputs, outputs) {
    const p = this.p;
    const out = outputs[0];
    const fb = clamp(p.feedback, 0, 0.98);
    const d = clamp((p.delay * this.sr) / 1000, 1, this.sr * 2);
    for (let c = 0; c < 2; c++) {
      const x = inCh(inputs, c);
      const y = out[c];
      const hb = this.h[c];
      const line = this.lines[c];
      const f = clamp(p.shift, -5000, 5000) * (c ? 1 - 2 * clamp(p.spread, 0, 1) : 1);
      const inc = f / this.sr;
      let ph = this.ph[c];
      for (let i = 0; i < x.length; i++) {
        const fbv = fb > 0 ? softclip(line.read(d) * fb * 1.2) / 1.2 : 0;
        hb.process(x[i] + fbv);
        ph += inc;
        ph -= Math.floor(ph);
        const v = this.dc[c].process(hb.i * Math.cos(TAU * ph) - hb.q * Math.sin(TAU * ph));
        line.write(v);
        y[i] = v;
      }
      this.ph[c] = ph;
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-shift', FxmShift);

/* ---- pitch shifter / spiral delay ----------------------------------------- */

class FxmPitch extends FxBase {
  static get defaults() {
    return { semis: 12, fine: 0, window: 80, feedback: 0, delay: 0, tone: 12000, spread: 0 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.sh = [new Shifter(this.sr, 260), new Shifter(this.sr, 260)];
    this.lines = [new DelayLine(this.sr * 4.1), new DelayLine(this.sr * 4.1)];
    this.lp = [new SVF(), new SVF()];
    this.dc = [new DCBlock(), new DCBlock()];
  }
  process(inputs, outputs) {
    const p = this.p;
    const out = outputs[0];
    const fb = clamp(p.feedback, 0, 0.99);
    const d = clamp((p.delay * this.sr) / 1000, 64, this.sr * 4);
    for (let c = 0; c < 2; c++) {
      const x = inCh(inputs, c);
      const y = out[c];
      const sh = this.sh[c];
      sh.setWindowMs(clamp(p.window, 10, 250));
      const cents = p.semis * 100 + p.fine + (c ? 1 : -1) * p.spread * 25;
      const ratio = Math.pow(2, cents / 1200);
      const line = this.lines[c];
      const lp = this.lp[c];
      lp.set(clamp(p.tone, 200, 20000), 0.7, this.sr);
      for (let i = 0; i < x.length; i++) {
        const back = fb > 0 ? lp.process(line.read(d)) * fb : 0;
        const v = this.dc[c].process(sh.process(x[i] + softclip(back * 0.9) / 0.9, ratio));
        line.write(v);
        y[i] = v;
      }
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-pitch', FxmPitch);

/* ---- chorus / flanger ------------------------------------------------------ */

class FxmChorus extends FxBase {
  static get defaults() {
    return { delay: 14, depth: 4, rate: 0.4, feedback: 0, voices: 2, spread: 0.5 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.lines = [new DelayLine(this.sr * 0.1), new DelayLine(this.sr * 0.1)];
    this.ph = 0;
    this.last = [0, 0];
    this.dSm = null;
  }
  process(inputs, outputs) {
    const p = this.p;
    const out = outputs[0];
    const n = out[0].length;
    const voices = Math.round(clamp(p.voices, 1, 4));
    const base = (clamp(p.delay, 0.1, 50) * this.sr) / 1000;
    const depth = (clamp(p.depth, 0, 25) * this.sr) / 1000;
    const fb = clamp(p.feedback, -0.98, 0.98);
    const inc = clamp(p.rate, 0.005, 20) / this.sr;
    if (this.dSm === null) this.dSm = base;
    const norm = 1 / Math.sqrt(voices);
    const startPh = this.ph;
    for (let c = 0; c < 2; c++) {
      const x = inCh(inputs, c);
      const y = out[c];
      const line = this.lines[c];
      let ph = startPh;
      let dsm = this.dSm;
      for (let i = 0; i < n; i++) {
        ph += inc;
        if (ph >= 1) ph -= 1;
        dsm += (base - dsm) * 0.0007;
        line.write(x[i] + softclip(this.last[c] * fb * 1.1) / 1.1);
        let s = 0;
        for (let v = 0; v < voices; v++) {
          const off = v / voices + (c ? p.spread * 0.5 : 0);
          const m = 0.5 + 0.5 * Math.sin(TAU * (ph + off));
          s += line.readH(dsm + depth * m);
        }
        this.last[c] = s * norm;
        y[i] = s * norm;
      }
      if (c === 1) {
        this.ph = ph;
        this.dSm = dsm;
      }
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-chorus', FxmChorus);

/* ---- phaser ---------------------------------------------------------------- */

class FxmPhaser extends FxBase {
  static get defaults() {
    return { stages: 6, rate: 0.25, depth: 0.8, centre: 900, feedback: 0.5, spread: 0.25 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.x1 = [new Float64Array(16), new Float64Array(16)];
    this.y1 = [new Float64Array(16), new Float64Array(16)];
    this.ph = 0;
    this.last = [0, 0];
  }
  process(inputs, outputs) {
    const p = this.p;
    const out = outputs[0];
    const n = out[0].length;
    const stages = Math.round(clamp(p.stages, 2, 16));
    const inc = clamp(p.rate, 0.005, 20) / this.sr;
    const fb = clamp(p.feedback, -0.97, 0.97);
    const span = clamp(p.depth, 0, 1) * 4; // octaves
    const startPh = this.ph;
    for (let c = 0; c < 2; c++) {
      const x = inCh(inputs, c);
      const y = out[c];
      const X1 = this.x1[c];
      const Y1 = this.y1[c];
      let ph = startPh;
      let a = 0;
      for (let i = 0; i < n; i++) {
        ph += inc;
        if (ph >= 1) ph -= 1;
        if ((i & 15) === 0) {
          const m = Math.sin(TAU * (ph + (c ? p.spread * 0.5 : 0)));
          const fc = clamp(p.centre * Math.pow(2, (m * span) / 2), 20, this.sr * 0.45);
          const t = Math.tan((Math.PI * fc) / this.sr);
          a = (t - 1) / (t + 1);
        }
        let u = x[i] + softclip(this.last[c] * fb * 1.1) / 1.1;
        for (let s = 0; s < stages; s++) {
          const v = a * u + X1[s] - a * Y1[s];
          X1[s] = u;
          Y1[s] = v;
          u = v;
        }
        this.last[c] = u;
        y[i] = u;
      }
      if (c === 1) this.ph = ph;
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-phaser', FxmPhaser);

/* ---- wow & flutter --------------------------------------------------------- */

class FxmWow extends FxBase {
  static get defaults() {
    return { wow: 0.3, wowRate: 0.6, flutter: 0.2, flutterRate: 9, drift: 0.3, stereo: 0.2 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.lines = [new DelayLine(this.sr * 0.12), new DelayLine(this.sr * 0.12)];
    this.pw = [0, 0.25];
    this.pf = [0, 0.4];
    this.dr = [0, 0];
    this.drT = [0, 0];
    this.drS = [0, 0];
  }
  process(inputs, outputs) {
    const p = this.p;
    const out = outputs[0];
    const sr = this.sr;
    const wowD = (clamp(p.wow, 0, 1) * 40 * sr) / 1000;
    const flD = (clamp(p.flutter, 0, 1) * 2.5 * sr) / 1000;
    const drD = (clamp(p.drift, 0, 1) * 15 * sr) / 1000;
    const base = wowD + flD + drD + 4;
    for (let c = 0; c < 2; c++) {
      const x = inCh(inputs, c);
      const y = out[c];
      const line = this.lines[c];
      const st = c ? clamp(p.stereo, 0, 1) : 0;
      const wInc = (clamp(p.wowRate, 0.02, 8) * (1 + st * 0.13)) / sr;
      const fInc = (clamp(p.flutterRate, 2, 40) * (1 + st * 0.21)) / sr;
      for (let i = 0; i < x.length; i++) {
        this.pw[c] = (this.pw[c] + wInc) % 1;
        this.pf[c] = (this.pf[c] + fInc) % 1;
        this.drT[c]--;
        if (this.drT[c] <= 0) {
          this.drT[c] = sr * (0.3 + this.rand() * 0.9);
          this.dr[c] = this.rand() * 2 - 1;
          if (c && st < 0.5) this.dr[1] = this.dr[0];
        }
        this.drS[c] += (this.dr[c] - this.drS[c]) * 0.00005;
        const d = base + wowD * Math.sin(TAU * this.pw[c]) + flD * Math.sin(TAU * this.pf[c]) + drD * this.drS[c];
        line.write(x[i]);
        y[i] = line.readH(d);
      }
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-wow', FxmWow);

/* ---- Doppler fly-by --------------------------------------------------------- */

class FxmDoppler extends FxBase {
  static get defaults() {
    return { speed: 40, distance: 6, period: 6, air: 0.5, alternate: 1 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.line = [new DelayLine(this.sr * 2.6), new DelayLine(this.sr * 2.6)];
    this.t = 0;
    this.pass = 0;
    this.lp = [new SVF(), new SVF()];
    this.state = { d: 0, gl: 0, gr: 0 };
    this.dS = undefined;
  }
  process(inputs, outputs) {
    const p = this.p;
    const [oL, oR] = outputs[0];
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const sr = this.sr;
    const P = clamp(p.period, 0.5, 60);
    const v = clamp(p.speed, 0.5, 330);
    const D = clamp(p.distance, 0.3, 100);
    const maxX = Math.sqrt(Math.max(0, 800 * 800 - D * D));
    for (let i = 0; i < oL.length; i++) {
      this.t += 1 / sr;
      if (this.t >= P) {
        this.t -= P;
        this.pass++;
      }
      if ((i & 31) === 0) {
        const dir = p.alternate >= 0.5 && this.pass % 2 ? -1 : 1;
        const x = clamp(v * (this.t - P / 2) * dir, -maxX, maxX);
        const d = Math.sqrt(x * x + D * D);
        const env = Math.pow(Math.sin((Math.PI * this.t) / P), 0.35);
        const g = clamp(D / d, 0, 1) * env;
        const pan = x / d;
        const th = ((pan + 1) * Math.PI) / 4;
        this.state.d = (d / 343) * sr;
        this.state.gl = Math.cos(th) * Math.SQRT2 * g;
        this.state.gr = Math.sin(th) * Math.SQRT2 * g;
        const fc = 20000 / (1 + (clamp(p.air, 0, 1) * d) / 8);
        this.lp[0].set(fc, 0.6, sr);
        this.lp[1].set(fc, 0.6, sr);
      }
      if (this.dS === undefined) this.dS = this.state.d;
      // the delay glides (this IS the Doppler shift); the jump at the loop point is faded by env
      const jump = Math.abs(this.state.d - this.dS) > sr * 0.05;
      this.dS = jump ? this.state.d : this.dS + (this.state.d - this.dS) * 0.02;
      this.line[0].write(xL[i]);
      this.line[1].write(xR[i]);
      const m = 0.5 * (this.line[0].readH(this.dS) + this.line[1].readH(this.dS));
      const s = this.lp[0].process(m);
      oL[i] = s * this.state.gl;
      oR[i] = s * this.state.gr;
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-doppler', FxmDoppler);

/* ---- tremolo / auto-pan ----------------------------------------------------- */

class FxmTrem extends FxBase {
  static get defaults() {
    return { rate: 4, depth: 0.7, shape: 0, phase: 0 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.ph = 0;
    this.held = [0, 0];
    this.sm = [1, 1];
  }
  process(inputs, outputs) {
    const p = this.p;
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const [oL, oR] = outputs[0];
    const inc = clamp(p.rate, 0.01, 40) / this.sr;
    const depth = clamp(p.depth, 0, 1);
    const a = coefMs(p.shape >= 2 ? 2 : 0.2, this.sr);
    for (let i = 0; i < oL.length; i++) {
      const prev = this.ph;
      this.ph = (this.ph + inc) % 1;
      if (this.ph < prev) this.held[0] = this.rand() * 2 - 1;
      const phR = (this.ph + clamp(p.phase, 0, 1)) % 1;
      if (phR < (prev + clamp(p.phase, 0, 1)) % 1) this.held[1] = this.rand() * 2 - 1;
      const sh = Math.round(p.shape);
      const lfoL = sh === 3 ? this.held[0] : lfoShape(sh === 2 ? 2 : sh, this.ph, 0);
      const lfoR = sh === 3 ? this.held[1] : lfoShape(sh === 2 ? 2 : sh, phR, 0);
      const tL = 1 - depth * (0.5 + 0.5 * lfoL);
      const tR = 1 - depth * (0.5 + 0.5 * lfoR);
      this.sm[0] += (tL - this.sm[0]) * a;
      this.sm[1] += (tR - this.sm[1]) * a;
      oL[i] = xL[i] * this.sm[0];
      oR[i] = xR[i] * this.sm[1];
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-trem', FxmTrem);

/* ---- stereo width / Haas ---------------------------------------------------- */

class FxmStereo extends FxBase {
  static get defaults() {
    return { width: 1.5, haas: 0, rotate: 0 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.line = new DelayLine(this.sr * 0.05);
  }
  process(inputs, outputs) {
    const p = this.p;
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const [oL, oR] = outputs[0];
    const w = clamp(p.width, 0, 4);
    const hd = (clamp(p.haas, 0, 40) * this.sr) / 1000;
    const th = (clamp(p.rotate, -1, 1) * Math.PI) / 4;
    const cr = Math.cos(th);
    const sn = Math.sin(th);
    for (let i = 0; i < oL.length; i++) {
      const m = 0.5 * (xL[i] + xR[i]);
      const s = 0.5 * (xL[i] - xR[i]) * w;
      let l = m + s;
      let r = m - s;
      this.line.write(r);
      if (hd > 0) r = this.line.read(hd);
      oL[i] = l * cr - r * sn;
      oR[i] = l * sn + r * cr;
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-stereo', FxmStereo);
