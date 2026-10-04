/* Colour: saturation (tube / tape), wavefolder, bit-crusher. (Drive is native.) */

class FxmSat extends FxBase {
  static get defaults() {
    return { mode: 0, drive: 12, bias: 0, hyst: 0.4, tone: 9000, output: 0 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.st = [0, 1].map(() => ({ pre: new SVF(), post: new SVF(), dc: new DCBlock(), y: 0 }));
  }
  process(inputs, outputs) {
    const p = this.p;
    const out = outputs[0];
    const g = dbToLin(clamp(p.drive, 0, 48));
    const comp = Math.pow(g, -0.4) * dbToLin(p.output);
    const tape = p.mode >= 0.5;
    const h = clamp(p.hyst, 0, 1);
    for (let c = 0; c < 2; c++) {
      const x = inCh(inputs, c);
      const y = out[c];
      const s = this.st[c];
      s.pre.set(2500, 0.6, this.sr);
      s.post.set(clamp(p.tone, 200, 20000), 0.6, this.sr);
      for (let i = 0; i < x.length; i++) {
        let v;
        if (tape) {
          // pre-emphasis → saturate with memory (hysteresis-like lag) → de-emphasis
          s.pre.process(x[i]);
          const e = x[i] + 0.7 * s.pre.hp;
          const u = g * e + p.bias * 0.3;
          const m = softclip(u);
          v = m + h * 0.7 * (s.y - m) * (1 - m * m);
          s.y = v;
        } else {
          const u = g * x[i] + p.bias * 0.5;
          v = u >= 0 ? softclip(u) : softclip(u * 1.6) / 1.6;
        }
        v = s.dc.process(v);
        y[i] = s.post.process(v) * comp;
      }
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-sat', FxmSat);

class FxmFold extends FxBase {
  static get defaults() {
    return { fold: 4, offset: 0, stages: 1, tone: 12000, output: -6 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.st = [0, 1].map(() => ({ lp: new SVF(), dc: new DCBlock() }));
  }
  process(inputs, outputs) {
    const p = this.p;
    const out = outputs[0];
    const g = clamp(p.fold, 1, 60);
    const st = Math.round(clamp(p.stages, 1, 4));
    const og = dbToLin(p.output);
    for (let c = 0; c < 2; c++) {
      const x = inCh(inputs, c);
      const y = out[c];
      const s = this.st[c];
      s.lp.set(clamp(p.tone, 200, 20000), 0.6, this.sr);
      for (let i = 0; i < x.length; i++) {
        let v = Math.sin((Math.PI / 2) * (g * x[i] + p.offset));
        for (let k = 1; k < st; k++) v = Math.sin((Math.PI / 2) * (1.7 * v + p.offset * 0.5));
        v = s.dc.process(v);
        y[i] = s.lp.process(v) * og;
      }
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-fold', FxmFold);

class FxmCrush extends FxBase {
  static get defaults() {
    return { bits: 8, rate: 4, jitter: 0, mangle: 0 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.ph = 0;
    this.hold = [0, 0];
    this.next = 1;
  }
  process(inputs, outputs) {
    const p = this.p;
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const [oL, oR] = outputs[0];
    const steps = Math.pow(2, clamp(p.bits, 1, 16) - 1);
    const down = clamp(p.rate, 1, 512);
    const nb = Math.max(1, Math.ceil(Math.log2(steps + 1)));
    for (let i = 0; i < oL.length; i++) {
      this.ph += 1;
      if (this.ph >= this.next) {
        this.ph = 0;
        this.next = down * (1 + (this.rand() * 2 - 1) * p.jitter * 0.9);
        for (let c = 0; c < 2; c++) {
          const x = c ? xR[i] : xL[i];
          let q = Math.round(clamp(x, -1, 1) * steps);
          if (p.mangle > 0 && this.rand() < p.mangle * 0.5) q ^= 1 << Math.floor(this.rand() * nb);
          this.hold[c] = clamp(q / steps, -1, 1);
        }
      }
      oL[i] = this.hold[0];
      oR[i] = this.hold[1];
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-crush', FxmCrush);
