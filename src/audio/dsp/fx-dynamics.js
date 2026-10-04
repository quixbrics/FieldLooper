/* Dynamics: noise gate and rhythmic chopper. (The compressor is native.) */

class FxmGate extends FxBase {
  static get defaults() {
    return { threshold: -36, attack: 1, hold: 40, release: 120, floor: -80, invert: 0 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.env = 0;
    this.g = 0;
    this.holdLeft = 0;
    this.open = false;
  }
  process(inputs, outputs) {
    const p = this.p;
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const [oL, oR] = outputs[0];
    const sr = this.sr;
    const thrOpen = dbToLin(p.threshold);
    const thrClose = dbToLin(p.threshold - 4);
    const floor = dbToLin(p.floor);
    const aD = coefMs(0.3, sr);
    const rD = coefMs(25, sr);
    const aG = coefMs(Math.max(0.05, p.attack), sr);
    const rG = coefMs(Math.max(1, p.release), sr);
    const holdS = (p.hold * sr) / 1000;
    for (let i = 0; i < oL.length; i++) {
      const pk = Math.max(Math.abs(xL[i]), Math.abs(xR[i]));
      this.env += (pk - this.env) * (pk > this.env ? aD : rD);
      // detector with 4 dB hysteresis, so a signal near threshold does not chatter
      const above = this.env > (this.open ? thrClose : thrOpen);
      this.open = above;
      const want = p.invert ? !above : above;
      if (want) this.holdLeft = holdS;
      else if (this.holdLeft > 0) this.holdLeft--;
      const gateOn = want || this.holdLeft > 0;
      const target = gateOn ? 1 : floor;
      this.g += (target - this.g) * (target > this.g ? aG : rG);
      oL[i] = xL[i] * this.g;
      oR[i] = xR[i] * this.g;
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-gate', FxmGate);

class FxmChop extends FxBase {
  static get defaults() {
    return { rate: 6, duty: 0.5, smooth: 3, depth: 1, offset: 0, skip: 0 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.ph = 0;
    this.gl = 1;
    this.gr = 1;
    this.muteA = false;
    this.muteB = false;
  }
  process(inputs, outputs) {
    const p = this.p;
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const [oL, oR] = outputs[0];
    const inc = clamp(p.rate, 0.05, 60) / this.sr;
    const a = coefMs(Math.max(0.1, p.smooth), this.sr);
    const low = 1 - clamp(p.depth, 0, 1);
    for (let i = 0; i < oL.length; i++) {
      this.ph += inc;
      if (this.ph >= 1) {
        this.ph -= 1;
        this.muteA = this.rand() < p.skip;
        this.muteB = p.offset === 0 ? this.muteA : this.rand() < p.skip;
      }
      const phR = (this.ph + p.offset) % 1;
      const tL = this.ph < p.duty && !this.muteA ? 1 : low;
      const tR = phR < p.duty && !this.muteB ? 1 : low;
      this.gl += (tL - this.gl) * a;
      this.gr += (tR - this.gr) * a;
      oL[i] = xL[i] * this.gl;
      oR[i] = xR[i] * this.gr;
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-chop', FxmChop);
