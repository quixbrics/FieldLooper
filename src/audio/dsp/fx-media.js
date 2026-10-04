/* Worn media: vinyl (crackle, hiss, rumble, wear, warp) and pops / clicks / dropouts / skips. */

class FxmVinyl extends FxBase {
  static get defaults() {
    return { crackle: 0.5, level: -18, hiss: 0.3, rumble: 0.3, wear: 0.4, warp: 0.2 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.cbp = new SVF();
    this.hhp = new SVF();
    this.rlp = new SVF();
    this.hp = [new SVF(), new SVF()];
    this.lp = [new SVF(), new SVF()];
    this.lines = [new DelayLine(this.sr * 0.02), new DelayLine(this.sr * 0.02)];
    this.ph = 0;
    this.brown = 0;
    this.imp = 0;
  }
  process(inputs, outputs) {
    const p = this.p;
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const [oL, oR] = outputs[0];
    const sr = this.sr;
    const wear = clamp(p.wear, 0, 1);
    for (let c = 0; c < 2; c++) {
      this.hp[c].set(25 + wear * 280, 0.7, sr);
      this.lp[c].set(19000 - wear * 15500, 0.8, sr);
    }
    this.cbp.set(3200, 0.9, sr);
    this.hhp.set(4000, 0.7, sr);
    this.rlp.set(45, 0.7, sr);
    const lvl = dbToLin(clamp(p.level, -70, 6));
    const prob = Math.pow(clamp(p.crackle, 0, 1), 2) * 0.0025;
    const hiss = clamp(p.hiss, 0, 1) * 0.05;
    const rumble = clamp(p.rumble, 0, 1) * 0.6;
    const warp = (clamp(p.warp, 0, 1) * 3.5 * sr) / 1000;
    const mono = wear * 0.7;
    for (let i = 0; i < oL.length; i++) {
      this.ph += 0.555 / sr;
      if (this.ph >= 1) this.ph -= 1;
      const d = 2 + warp * (1 + Math.sin(TAU * this.ph));
      const m = 0.5 * (xL[i] + xR[i]);
      const l0 = xL[i] * (1 - mono) + m * mono;
      const r0 = xR[i] * (1 - mono) + m * mono;
      this.lines[0].write(l0);
      this.lines[1].write(r0);
      let l = this.lp[0].process((this.hp[0].process(this.lines[0].readH(d)), this.hp[0].hp));
      let r = this.lp[1].process((this.hp[1].process(this.lines[1].readH(d)), this.hp[1].hp));
      // noise bed
      if (this.rand() < prob) this.imp = (this.rand() < 0.5 ? -1 : 1) * Math.pow(this.rand(), 3) * 1.5;
      this.cbp.process(this.imp);
      this.imp *= 0.3;
      const cr = this.cbp.bp * 2.5;
      const wn = this.rand() * 2 - 1;
      this.hhp.process(wn);
      this.brown = (this.brown + 0.02 * wn) / 1.02;
      const rb = this.rlp.process(this.brown * 6) * rumble + Math.sin(TAU * this.ph) * 0.02 * rumble;
      const noise = (cr + this.hhp.hp * hiss + rb) * lvl;
      oL[i] = l + noise;
      oR[i] = r + noise * 0.92;
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-vinyl', FxmVinyl);

class FxmClicks extends FxBase {
  static get defaults() {
    return { pops: 1, popLevel: 0.5, clicks: 4, clickLevel: 0.3, dropouts: 0.3, dropLen: 60, skips: 0.2, skipLen: 90 };
  }
  constructor(o) {
    super(o);
    this.cap = Math.ceil(this.sr * 0.35);
    this.seg = [new Float32Array(this.cap), new Float32Array(this.cap)];
    this.reset();
  }
  reset() {
    this.lines = [new DelayLine(this.sr * 0.4), new DelayLine(this.sr * 0.4)];
    this.popPh = 0;
    this.popEnv = 0;
    this.popF = 100;
    this.dropLeft = 0;
    this.dropG = 1;
    this.skipLeft = 0;
    this.skipPos = 0;
    this.skipLen = 1;
    this.skipMix = 0;
  }
  process(inputs, outputs) {
    const p = this.p;
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const [oL, oR] = outputs[0];
    const sr = this.sr;
    const pPop = clamp(p.pops, 0, 30) / sr;
    const pClick = clamp(p.clicks, 0, 80) / sr;
    const pDrop = clamp(p.dropouts, 0, 10) / sr;
    const pSkip = clamp(p.skips, 0, 5) / sr;
    for (let i = 0; i < oL.length; i++) {
      this.lines[0].write(xL[i]);
      this.lines[1].write(xR[i]);
      let l = xL[i];
      let r = xR[i];
      // skips: a CD-style repeat of the last few tens of ms
      if (this.skipLeft <= 0 && this.rand() < pSkip) {
        const len = Math.max(64, Math.min(this.cap, Math.round((clamp(p.skipLen, 10, 330) * sr) / 1000)));
        for (let k = 0; k < len; k++) {
          this.seg[0][k] = this.lines[0].read(len - 1 - k);
          this.seg[1][k] = this.lines[1].read(len - 1 - k);
        }
        this.skipLen = len;
        this.skipPos = 0;
        this.skipLeft = len * (2 + Math.floor(this.rand() * 5));
      }
      if (this.skipLeft > 0) {
        this.skipLeft--;
        this.skipMix = Math.min(1, this.skipMix + 0.05);
        const k = this.skipPos;
        this.skipPos = (this.skipPos + 1) % this.skipLen;
        l = l * (1 - this.skipMix) + this.seg[0][k] * this.skipMix;
        r = r * (1 - this.skipMix) + this.seg[1][k] * this.skipMix;
      } else if (this.skipMix > 0) {
        this.skipMix = Math.max(0, this.skipMix - 0.05);
      }
      // dropouts
      if (this.dropLeft <= 0 && this.rand() < pDrop) this.dropLeft = Math.round((clamp(p.dropLen, 2, 1000) * sr) / 1000);
      if (this.dropLeft > 0) this.dropLeft--;
      this.dropG += ((this.dropLeft > 0 ? 0 : 1) - this.dropG) * 0.05;
      l *= this.dropG;
      r *= this.dropG;
      // pops: a short thump with a crack on top
      if (this.rand() < pPop) {
        this.popEnv = clamp(p.popLevel, 0, 1) * (0.5 + this.rand() * 0.8);
        this.popF = 60 + this.rand() * 160;
        this.popPh = 0;
        l += this.popEnv;
        r += this.popEnv * 0.9;
      }
      if (this.popEnv > 1e-4) {
        this.popPh += this.popF / sr;
        const s = Math.sin(TAU * this.popPh) * this.popEnv;
        this.popEnv *= 0.9985;
        l += s;
        r += s;
      }
      // digital clicks: single-sample spikes
      if (this.rand() < pClick) {
        const v = (this.rand() < 0.5 ? -1 : 1) * clamp(p.clickLevel, 0, 1);
        l += v;
        if (this.rand() < 0.7) r += v;
      }
      oL[i] = l;
      oR[i] = r;
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-clicks', FxmClicks);
