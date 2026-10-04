/* Time: tape delay (feedback past 100 %), stutter / beat-repeat, tape stop. */

class FxmDelay extends FxBase {
  static get defaults() {
    return { timeL: 380, timeR: 520, feedback: 0.55, pingpong: 0, lowcut: 120, highcut: 6000, drive: 0.2, wobble: 0.15, freeze: 0 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.lines = [new DelayLine(this.sr * 4.2), new DelayLine(this.sr * 4.2)];
    this.hp = [new SVF(), new SVF()];
    this.lp = [new SVF(), new SVF()];
    this.dS = null;
    this.ph = 0;
    this.inG = 1;
  }
  process(inputs, outputs) {
    const p = this.p;
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const [oL, oR] = outputs[0];
    const sr = this.sr;
    const frozen = p.freeze >= 0.5;
    const fb = frozen ? 1 : clamp(p.feedback, 0, 1.3);
    const tL = clamp((p.timeL * sr) / 1000, 16, sr * 4);
    const tR = clamp((p.timeR * sr) / 1000, 16, sr * 4);
    if (!this.dS) this.dS = [tL, tR];
    const drive = frozen ? 0 : clamp(p.drive, 0, 1);
    const dg = 1 + drive * 4;
    const dn = 1 / Math.sqrt(dg);
    const wob = (clamp(p.wobble, 0, 1) * 6 * sr) / 1000;
    for (let c = 0; c < 2; c++) {
      this.hp[c].set(frozen ? 10 : clamp(p.lowcut, 10, 5000), 0.6, sr);
      this.lp[c].set(frozen ? sr * 0.45 : clamp(p.highcut, 300, 20000), 0.6, sr);
    }
    const ping = p.pingpong >= 0.5;
    const L0 = this.lines[0];
    const L1 = this.lines[1];
    for (let i = 0; i < oL.length; i++) {
      // tape-style glide when the time changes (pitch bends, no clicks)
      this.dS[0] += (tL - this.dS[0]) * 0.00025;
      this.dS[1] += (tR - this.dS[1]) * 0.00025;
      this.ph += 0.7 / sr;
      if (this.ph >= 1) this.ph -= 1;
      const m = wob * (1 + Math.sin(TAU * this.ph)) + wob * 0.3 * (1 + Math.sin(TAU * this.ph * 7.3));
      const dl = L0.readH(this.dS[0] + m);
      const dr = L1.readH(this.dS[1] + m * 0.9);
      // in-loop tone + saturation: it can scream, it cannot blow up
      this.hp[0].process(dl);
      this.hp[1].process(dr);
      const fl = softclip(this.lp[0].process(this.hp[0].hp) * fb * dg) * dn;
      const fr = softclip(this.lp[1].process(this.hp[1].hp) * fb * dg) * dn;
      this.inG += ((frozen ? 0 : 1) - this.inG) * 0.002;
      if (ping) {
        L0.write(0.5 * (xL[i] + xR[i]) * this.inG + fr);
        L1.write(fl);
      } else {
        L0.write(xL[i] * this.inG + fl);
        L1.write(xR[i] * this.inG + fr);
      }
      oL[i] = dl;
      oR[i] = dr;
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-delay', FxmDelay);

class FxmStutter extends FxBase {
  static get defaults() {
    return { slice: 120, repeats: 8, chance: 0.6, interval: 1500, decay: 0.15, pitch: 0, reverse: 0.2, gate: 1 };
  }
  constructor(o) {
    super(o);
    this.cap = Math.ceil(this.sr * 2.05);
    this.sl = [new Float32Array(this.cap), new Float32Array(this.cap)];
    this.reset();
  }
  reset() {
    this.lines = [new DelayLine(this.sr * 2.2), new DelayLine(this.sr * 2.2)];
    this.active = false;
    this.mixS = 0;
    this.timer = Math.max(1, (this.p.interval * this.sr) / 1000);
  }
  trigger() {
    const p = this.p;
    const len = Math.max(32, Math.min(this.cap, Math.round((clamp(p.slice, 5, 2000) * this.sr) / 1000)));
    for (let c = 0; c < 2; c++) {
      const line = this.lines[c];
      for (let k = 0; k < len; k++) this.sl[c][k] = line.read(len - 1 - k);
    }
    this.len = len;
    this.pos = 0;
    this.rep = 0;
    this.rate = 1;
    this.gain = 1;
    this.rev = this.rand() < p.reverse;
    this.active = true;
  }
  process(inputs, outputs) {
    const p = this.p;
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const [oL, oR] = outputs[0];
    const edge = Math.max(16, Math.round(0.002 * this.sr));
    for (let i = 0; i < oL.length; i++) {
      this.lines[0].write(xL[i]);
      this.lines[1].write(xR[i]);
      this.timer--;
      if (this.timer <= 0) {
        this.timer = Math.max(64, (clamp(p.interval, 20, 20000) * this.sr) / 1000);
        if (!this.active && this.rand() < p.chance) this.trigger();
      }
      let sL = 0;
      let sR = 0;
      if (this.active) {
        const playLen = this.len * clamp(p.gate, 0.05, 1);
        if (this.pos < playLen) {
          const q = this.rev ? this.len - 1 - this.pos : this.pos;
          const k = Math.min(this.len - 2, Math.max(0, Math.floor(q)));
          const f = q - Math.floor(q);
          const w = Math.min(1, this.pos / edge, (playLen - this.pos) / edge) * this.gain;
          sL = (this.sl[0][k] + (this.sl[0][k + 1] - this.sl[0][k]) * f) * w;
          sR = (this.sl[1][k] + (this.sl[1][k + 1] - this.sl[1][k]) * f) * w;
        }
        this.pos += this.rate;
        if (this.pos >= this.len) {
          this.pos = 0;
          this.rep++;
          this.gain *= 1 - clamp(p.decay, 0, 1) * 0.6;
          this.rate = clamp(this.rate * Math.pow(2, p.pitch / 12), 0.06, 16);
          if (this.rep >= Math.round(clamp(p.repeats, 1, 64))) this.active = false;
        }
      }
      this.mixS += ((this.active ? 1 : 0) - this.mixS) * 0.02;
      oL[i] = xL[i] * (1 - this.mixS) + sL * this.mixS;
      oR[i] = xR[i] * (1 - this.mixS) + sR * this.mixS;
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-stutter', FxmStutter);

class FxmTapeStop extends FxBase {
  static get defaults() {
    return { cycle: 8, stop: 1.2, hold: 0.4, start: 0.6, chance: 1, curve: 0.5 };
  }
  constructor(o) {
    super(o);
    this.reset();
  }
  reset() {
    this.lines = [new DelayLine(this.sr * 16), new DelayLine(this.sr * 16)];
    this.dc = [new DCBlock(), new DCBlock()];
    this.state = 0; // 0 live, 1 stopping, 2 holding, 3 starting, 4 returning
    this.t = 0;
    this.lag = 0;
    this.rate = 1;
    this.ret = 0;
    this.timer = (clamp(this.p.cycle, 0.5, 60) * this.sr) / 2;
  }
  process(inputs, outputs) {
    const p = this.p;
    const xL = inCh(inputs, 0);
    const xR = inCh(inputs, 1);
    const [oL, oR] = outputs[0];
    const sr = this.sr;
    const tStop = clamp(p.stop, 0.03, 8) * sr;
    const tHold = clamp(p.hold, 0, 8) * sr;
    const tStart = clamp(p.start, 0.03, 6) * sr;
    const curve = 1 + clamp(p.curve, 0, 1) * 2;
    for (let i = 0; i < oL.length; i++) {
      this.lines[0].write(xL[i]);
      this.lines[1].write(xR[i]);
      this.timer--;
      if (this.state === 0 && this.timer <= 0) {
        this.timer = clamp(p.cycle, 0.5, 60) * sr;
        if (this.rand() < p.chance) {
          this.state = 1;
          this.t = 0;
          this.lag = 0;
        }
      }
      if (this.state === 1) {
        this.rate = Math.pow(1 - Math.min(1, this.t / tStop), curve);
        if (++this.t >= tStop) {
          this.state = 2;
          this.t = 0;
        }
      } else if (this.state === 2) {
        this.rate = 0;
        if (++this.t >= tHold) {
          this.state = 3;
          this.t = 0;
        }
      } else if (this.state === 3) {
        this.rate = Math.pow(Math.min(1, this.t / tStart), 1 / curve);
        if (++this.t >= tStart) {
          this.state = 4;
          this.t = 0;
          this.rate = 1;
        }
      }
      if (this.state === 0) {
        oL[i] = xL[i];
        oR[i] = xR[i];
        continue;
      }
      this.lag = Math.min(this.lines[0].max - 8, this.lag + (1 - this.rate));
      const g = Math.sqrt(clamp(this.rate * 3, 0, 1));
      const tl = this.dc[0].process(this.lines[0].readH(this.lag + 2)) * g;
      const tr = this.dc[1].process(this.lines[1].readH(this.lag + 2)) * g;
      if (this.state === 4) {
        // crossfade from the lagging tape back to live over 80 ms
        this.ret = Math.min(1, this.ret + 1 / (0.08 * sr));
        oL[i] = tl * (1 - this.ret) + xL[i] * this.ret;
        oR[i] = tr * (1 - this.ret) + xR[i] * this.ret;
        if (this.ret >= 1) {
          this.state = 0;
          this.ret = 0;
        }
      } else {
        oL[i] = tl;
        oR[i] = tr;
      }
    }
    return this.guard(outputs);
  }
}
registerProcessor('fxm-tapestop', FxmTapeStop);
