// MD-style drum engine: 16 tracks, each a generic voice (sine/FM tone with pitch sweep, filtered noise with
// clap bursts, six-square metal, impulse) configured per hit by its machine, then the track chain
// AM -> EQ -> filter (HP base + LP width) -> SRR -> DIST -> VOL/PAN.
// AssemblyScript twin: assembly/md.ts — keep the two in sync; src/dsp/md.test.ts checks they match.
// Every parameter is 0-127 and latched at the hit (p-locks come in the same way).
// ponytail: VOL/PAN/filter only change on the next hit, unlike the hardware; add per-sample smoothing if it bothers
export const NPAR = 24;
export const AMD = 8, AMF = 9, EQF = 10, EQG = 11, FLTF = 12, FLTW = 13, FLTQ = 14, SRR = 15, DIST = 16, VOL = 17, PAN = 18, DEL = 19, REV = 20;
// DUCK (not on the MD; its LFOS slot, harmless in a .syx since LFOD is 0): how far a BD-track hit pushes this track down
// (dry and sends, so its echo / gate box return doesn't fill the kick's space), sidechain style. The duck envelope is the engine's, fired by every track-1 trig.
// ponytail: fixed release; make DUCK_DEC a knob if one curve doesn't suit every tempo
export const DUCK = 21, DUCK_DEC = 1.0, DUCK_MAX = 0.9;
export const NOUT = 6; // dry L/R, echo send L/R, gate box send L/R
export const MAXS = 1 << 18; // ROM sample length cap per track (~5.5 s at 48 kHz)

export const TAU = 2 * Math.PI;
const LN1000 = 6.907755278982137;
const ATTACK = 0.0003;
export const LP = 0, BP = 1, HP = 2;
const METAL = [245, 306, 365, 415, 437, 619];

export const coef = (fs: number, dec: number) => Math.exp(-LN1000 / (dec * fs));
export const ex = (v: number, lo: number, hi: number) => lo * Math.pow(hi / lo, v / 127);

export class Env {
  e = 0; h = 0; k = 1; a: number;
  constructor(private fs: number) { this.a = 1 - Math.exp(-1 / (ATTACK * fs)); }
  trig(peak: number, dec: number) { this.h = peak; this.k = coef(this.fs, dec); }
  tick(): number { this.h *= this.k; this.e += (this.h - this.e) * this.a; return this.e; }
}

export class Svf {
  ic1 = 0; ic2 = 0; k = 1; a1 = 0; a2 = 0; a3 = 0; mode = LP;
  constructor(private fs: number) {}
  set(f: number, q: number, mode: number) {
    const g = Math.tan(Math.PI * Math.min(f, this.fs * 0.45) / this.fs);
    this.mode = mode;
    this.k = 1 / q; this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  tick(x: number): number {
    const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    return this.mode == LP ? v2 : this.mode == BP ? v1 : x - this.k * v1 - v2;
  }
}

// RBJ peaking EQ
class Peq {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  constructor(private fs: number) {}
  set(f: number, db: number) {
    const A = Math.pow(10, db / 40), w = TAU * Math.min(f, this.fs * 0.45) / this.fs, al = Math.sin(w) / 2, c = Math.cos(w);
    const a0 = 1 + al / A;
    this.b0 = (1 + al * A) / a0; this.b1 = -2 * c / a0; this.b2 = (1 - al * A) / a0;
    this.a1 = -2 * c / a0; this.a2 = (1 - al / A) / a0;
  }
  tick(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

export function blep(t: number, dt: number): number {
  if (t < dt) { const u = t / dt; return u + u - u * u - 1; }
  if (t > 1 - dt) { const u = (t - 1) / dt; return u * u + u + u + 1; }
  return 0;
}

class Voice {
  // tone
  ph = 0; mph = 0; f0 = 100; pe = 0; pk = 0; pamt = 0; ie = 0; ik = 0; iamt = 0; ratio = 1;
  // slide (as on a 303 / the MD's slide trigs): the pitch glides from f0 to ft, the envelopes and FM keep going
  sl = false; ft = 100; gc: number; du = 0;
  toneE: Env; noiseE: Env; metalE: Env;
  noiseF: Svf; metalF: Svf;
  mph6 = [0, 0, 0, 0, 0, 0]; mdt = [0, 0, 0, 0, 0, 0];
  imp = 0; nb = 0; bc = 0; cdec = 0.1;
  // ROM: the track's sample, played from sp toward se at sd samples per tick (negative = reverse)
  smp = new Float32Array(1); slen = 0; sp = 0; sd = 0; se = 0; son = 0; smpE: Env;
  // track chain
  amd = 0; amf = 1; amph = 0; eq: Peq; hp: Svf; lp: Svf; sk = 1; sc = 0; sh = 0; dg = 0; gl = 0; gr = 0; dl = 0; dr = 0; rl = 0; rr = 0; // dl..rr: post-fader sends to echo / gate box

  constructor(private fs: number) {
    this.toneE = new Env(fs); this.noiseE = new Env(fs); this.metalE = new Env(fs); this.smpE = new Env(fs); this.gc = coef(fs, 0.06);
    this.noiseF = new Svf(fs); this.metalF = new Svf(fs);
    this.eq = new Peq(fs); this.hp = new Svf(fs); this.lp = new Svf(fs);
  }

  tone(f0: number, peak: number, dec: number) { this.ft = f0; if (this.sl) return; this.f0 = f0; this.toneE.trig(peak, dec); this.ph = 0; this.mph = 0; }
  sweep(amt: number, dec: number) { if (this.sl) return; this.pamt = amt; this.pe = 1; this.pk = coef(this.fs, dec); }
  fm(amt: number, ratio: number, dec: number) { if (this.sl) return; this.iamt = amt; this.ratio = ratio; this.ie = 1; this.ik = coef(this.fs, dec); }
  noise(peak: number, dec: number, f: number, q: number, mode: number) { this.noiseE.trig(peak, dec); this.noiseF.set(f, q, mode); }
  metal(peak: number, dec: number, tune: number, hpf: number) {
    this.metalE.trig(peak, dec); this.metalF.set(hpf, 1, HP);
    for (let j = 0; j < 6; j++) this.mdt[j] = METAL[j] * tune / this.fs;
  }

  trig(m: number, p: ArrayLike<number>, slide = 0) {
    this.sl = slide > 0 && this.toneE.h > 1e-4; // only a sounding note glides
    if (!this.sl) { this.pamt = 0; this.iamt = 0; }
    this.son = 0;
    if (m == 0) { this.tone(ex(p[0], 20, 2000), 1, ex(p[1], 0.01, 4)); this.sweep(p[2] / 127 * 8, ex(p[3], 0.005, 1)); } // GND-SN
    else if (m == 1) this.noise(1, ex(p[0], 0.01, 4), 18000, 0.7, LP); // GND-NS
    else if (m == 2) this.imp = 1; // GND-IM
    else if (m == 3) { // TRX-BD
      this.tone(ex(p[0], 30, 120), 1, ex(p[1], 0.05, 2)); this.sweep(p[2] / 127 * 6, ex(p[3], 0.005, 0.2));
      this.imp = p[4] / 127; this.noise(p[5] / 127 * 0.5, 0.02, 3000, 0.7, LP);
    } else if (m == 4) { // TRX-SD
      this.tone(ex(p[0], 120, 400), 0.7, ex(p[1], 0.03, 0.6)); this.sweep(p[2] / 127 * 2, ex(p[3], 0.005, 0.1));
      this.noise(p[4] / 127, ex(p[1], 0.05, 0.8), ex(p[5], 500, 8000), 0.8, HP);
    } else if (m == 5) this.metal(0.6, ex(p[1], 0.01, 0.3), ex(p[0], 0.5, 2), ex(p[2], 3000, 12000)); // TRX-CH
    else if (m == 6) this.metal(0.6, ex(p[1], 0.05, 2), ex(p[0], 0.5, 2), ex(p[2], 3000, 12000)); // TRX-OH
    else if (m == 7) { // TRX-CP: CLPY bursts then the tail
      this.noiseF.set(ex(p[2], 600, 3000), 2, BP);
      this.nb = 1 + Math.round(p[0] / 127 * 5); this.bc = 0; this.cdec = ex(p[1], 0.05, 1);
    } else if (m == 8) { // EFM-BD
      this.tone(ex(p[0], 30, 200), 1, ex(p[1], 0.05, 2)); this.sweep(p[2] / 127 * 6, ex(p[3], 0.005, 0.2));
      this.fm(p[4] / 127 * 8, ex(p[5], 0.5, 8), ex(p[6], 0.005, 1));
    } else if (m == 9) { // EFM-SD
      this.tone(ex(p[0], 100, 500), 0.6, ex(p[1], 0.03, 0.8));
      this.noise(p[2] / 127, ex(p[3], 0.02, 0.8), ex(p[7], 200, 8000), 0.7, HP);
      this.fm(p[4] / 127 * 8, ex(p[5], 0.5, 8), ex(p[6], 0.005, 0.5));
    } else if (m == 10) { // EFM-CB
      this.tone(ex(p[0], 200, 1200), 0.6, ex(p[1], 0.02, 1)); this.fm(p[2] / 127 * 10, ex(p[3], 0.5, 8), ex(p[4], 0.005, 1));
    } else if (m == 11) { // EFM-HH
      this.tone(ex(p[0], 200, 2000), 0.4, ex(p[1], 0.01, 1)); this.fm(p[2] / 127 * 20, ex(p[3], 0.5, 8), ex(p[4], 0.005, 1));
      this.noise(0.3, ex(p[1], 0.01, 1), ex(p[5], 2000, 12000), 0.7, HP);
    } else if (m == 12 && this.slen > 1) { // ROM: PTCH 2 steps per semitone around 64, END < STRT plays reverse
      const n = this.slen - 1, a = p[2] / 127 * n, b = p[3] / 127 * n, r = Math.pow(2, (p[0] - 64) / 24);
      this.sp = a; this.se = b; this.sd = b >= a ? r : -r; this.son = 1; this.smpE.trig(1, ex(p[1], 0.02, 10));
    }
    this.amd = p[AMD] / 127; this.amf = ex(p[AMF], 0.5, 2000);
    this.eq.set(ex(p[EQF], 50, 15000), (p[EQG] - 64) / 64 * 18);
    const fb = ex(p[FLTF], 20, 20000), q = ex(p[FLTQ], 0.5, 20);
    this.hp.set(fb, q, HP); this.lp.set(fb * ex(p[FLTW], 1, 1000), q, LP);
    this.sk = 1 + Math.floor(p[SRR] / 4);
    this.dg = p[DIST] / 127 * (p[DIST] / 127) * 20; // squared: low settings warm, only the top end turns square
    const v = p[VOL] / 127, a = (p[PAN] / 127) * Math.PI / 2;
    this.gl = v * Math.cos(a); this.gr = v * Math.sin(a);
    this.du = p[DUCK] / 127 * DUCK_MAX;
    const ds = p[DEL] / 127, rs = p[REV] / 127;
    this.dl = this.gl * ds; this.dr = this.gr * ds; this.rl = this.gl * rs; this.rr = this.gr * rs;
  }

  tick(nz: number): number {
    const fs = this.fs;
    this.f0 = this.ft + (this.f0 - this.ft) * this.gc;
    const f = this.f0 * (1 + this.pamt * this.pe); this.pe *= this.pk;
    const tone = Math.sin(TAU * this.ph + this.iamt * this.ie * Math.sin(TAU * this.mph)); this.ie *= this.ik;
    this.ph += f / fs; if (this.ph >= 1) this.ph -= 1;
    this.mph += f * this.ratio / fs; if (this.mph >= 1) this.mph -= Math.floor(this.mph);
    let x = tone * this.toneE.tick();
    if (this.nb > 0) {
      if (this.bc <= 0) { this.nb -= 1; this.noiseE.trig(1, this.nb > 0 ? 0.02 : this.cdec); this.bc = Math.floor(0.011 * fs); }
      this.bc -= 1;
    }
    x += this.noiseF.tick(nz) * this.noiseE.tick();
    let metal = 0;
    for (let j = 0; j < 6; j++) {
      const p = this.mph6[j], dt = this.mdt[j];
      let q = p + 0.5; if (q >= 1) q -= 1;
      metal += (p < 0.5 ? 1.0 : -1.0) + blep(p, dt) - blep(q, dt);
      let np = p + dt; if (np >= 1) np -= 1;
      this.mph6[j] = np;
    }
    x += this.metalF.tick(metal) * 0.3 * this.metalE.tick();
    x += this.imp; this.imp = 0;
    if (this.son > 0) {
      const i = Math.floor(this.sp), fr = this.sp - i, a = this.smp[i], b = this.smp[Math.min(i + 1, this.slen - 1)];
      x += (a + (b - a) * fr) * this.smpE.tick();
      this.sp += this.sd;
      if (this.sd > 0 ? this.sp > this.se : this.sp < this.se) this.son = 0;
    }
    // track chain
    if (this.amd > 0) {
      x *= 1 - this.amd * (0.5 + 0.5 * Math.sin(TAU * this.amph));
      this.amph += this.amf / fs; if (this.amph >= 1) this.amph -= 1;
    }
    x = this.lp.tick(this.hp.tick(this.eq.tick(x)));
    this.sc += 1; if (this.sc >= this.sk) { this.sc = 0; this.sh = x; }
    x = this.sh;
    if (this.dg > 0) x = Math.tanh(x * (1 + this.dg)) / Math.tanh(1 + this.dg);
    return x;
  }
}

export class MdEngine {
  private vs: Voice[] = [];
  private seed = 0x12345678;
  private dk: Env;
  constructor(fs: number) { for (let i = 0; i < 16; i++) this.vs.push(new Voice(fs)); this.dk = new Env(fs); }
  trig(tr: number, m: number, p: ArrayLike<number>, slide = 0) { this.vs[tr].trig(m, p, slide); if (tr == 0) this.dk.trig(1, DUCK_DEC); }
  // load a mono sample (at the engine rate) into a track for the ROM machine
  sample(tr: number, d: Float32Array) { const v = this.vs[tr]; v.slen = Math.min(d.length, MAXS); v.smp = d.slice(0, v.slen); v.son = 0; }
  // o: dry L/R, echo send L/R, gate box send L/R
  render(o: Float32Array[], off: number, n: number) {
    for (let i = 0; i < n; i++) {
      let L = 0, R = 0, DL = 0, DR = 0, RL = 0, RR = 0;
      const dk = this.dk.tick();
      for (let t = 0; t < 16; t++) {
        let s = this.seed;
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        this.seed = s;
        const v = this.vs[t], x = v.tick((s >>> 0) / 4294967296 * 2 - 1), d = x * (1 - v.du * dk);
        L += d * v.gl; R += d * v.gr; DL += d * v.dl; DR += d * v.dr; RL += d * v.rl; RR += d * v.rr;
      }
      o[0][off + i] = L; o[1][off + i] = R; o[2][off + i] = DL; o[3][off + i] = DR; o[4][off + i] = RL; o[5][off + i] = RR;
    }
  }
}
