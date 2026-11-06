// AssemblyScript port of src/dsp/md.ts. Keep the two in sync; src/dsp/md.test.ts renders both from the
// same hits and checks they match. --runtime stub: everything is allocated in init(), never after.

const AMD = 8, AMF = 9, EQF = 10, EQG = 11, FLTF = 12, FLTW = 13, FLTQ = 14, SRR = 15, DIST = 16, VOL = 17, PAN = 18, DEL = 19, REV = 20;
const TAU: f64 = 2 * Math.PI;
const LN1000: f64 = 6.907755278982137;
const ATTACK: f64 = 0.0003;
const MAXS: i32 = 1 << 18; // ROM sample cap per track; 16 x 1 MB is why maximumMemory is 300 pages
const LP = 0, BP = 1, HP = 2;
const METAL: StaticArray<f64> = [245, 306, 365, 415, 437, 619];

function coef(fs: f64, dec: f64): f64 { return Math.exp(-LN1000 / (dec * fs)); }
function ex(v: f64, lo: f64, hi: f64): f64 { return lo * Math.pow(hi / lo, v / 127); }

class Env {
  e: f64 = 0; h: f64 = 0; k: f64 = 1; a: f64; fs: f64;
  constructor(fs: f64) { this.fs = fs; this.a = 1 - Math.exp(-1 / (ATTACK * fs)); }
  trig(peak: f64, dec: f64): void { this.h = peak; this.k = coef(this.fs, dec); }
  tick(): f64 { this.h *= this.k; this.e += (this.h - this.e) * this.a; return this.e; }
}

class Svf {
  ic1: f64 = 0; ic2: f64 = 0; k: f64 = 1; a1: f64 = 0; a2: f64 = 0; a3: f64 = 0; mode: i32 = LP; fs: f64;
  constructor(fs: f64) { this.fs = fs; }
  set(f: f64, q: f64, mode: i32): void {
    const g = Math.tan(Math.PI * Math.min(f, this.fs * 0.45) / this.fs);
    this.mode = mode;
    this.k = 1 / q; this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  tick(x: f64): f64 {
    const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    return this.mode == LP ? v2 : this.mode == BP ? v1 : x - this.k * v1 - v2;
  }
}

class Peq {
  b0: f64 = 1; b1: f64 = 0; b2: f64 = 0; a1: f64 = 0; a2: f64 = 0; x1: f64 = 0; x2: f64 = 0; y1: f64 = 0; y2: f64 = 0; fs: f64;
  constructor(fs: f64) { this.fs = fs; }
  set(f: f64, db: f64): void {
    const A = Math.pow(10, db / 40), w = TAU * Math.min(f, this.fs * 0.45) / this.fs, al = Math.sin(w) / 2, c = Math.cos(w);
    const a0 = 1 + al / A;
    this.b0 = (1 + al * A) / a0; this.b1 = -2 * c / a0; this.b2 = (1 - al * A) / a0;
    this.a1 = -2 * c / a0; this.a2 = (1 - al / A) / a0;
  }
  tick(x: f64): f64 {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

function blep(t: f64, dt: f64): f64 {
  if (t < dt) { const u = t / dt; return u + u - u * u - 1; }
  if (t > 1 - dt) { const u = (t - 1) / dt; return u * u + u + u + 1; }
  return 0;
}

class Voice {
  ph: f64 = 0; mph: f64 = 0; f0: f64 = 100; pe: f64 = 0; pk: f64 = 0; pamt: f64 = 0; ie: f64 = 0; ik: f64 = 0; iamt: f64 = 0; ratio: f64 = 1;
  sl: bool = false; ft: f64 = 100; gc: f64 = 0; // slide: see src/dsp/md.ts
  toneE: Env; noiseE: Env; metalE: Env;
  noiseF: Svf; metalF: Svf;
  mph6: StaticArray<f64> = new StaticArray<f64>(6); mdt: StaticArray<f64> = new StaticArray<f64>(6);
  imp: f64 = 0; nb: f64 = 0; bc: f64 = 0; cdec: f64 = 0.1;
  smp: StaticArray<f32> = new StaticArray<f32>(MAXS); slen: i32 = 0; sp: f64 = 0; sd: f64 = 0; se: f64 = 0; son: i32 = 0; smpE: Env;
  amd: f64 = 0; amf: f64 = 1; amph: f64 = 0; eq: Peq; hp: Svf; lp: Svf; sk: f64 = 1; sc: f64 = 0; sh: f64 = 0; dg: f64 = 0; gl: f64 = 0; gr: f64 = 0; dl: f64 = 0; dr: f64 = 0; rl: f64 = 0; rr: f64 = 0;
  fs: f64;

  constructor(fs: f64) {
    this.fs = fs;
    this.toneE = new Env(fs); this.noiseE = new Env(fs); this.metalE = new Env(fs); this.smpE = new Env(fs); this.gc = coef(fs, 0.06);
    this.noiseF = new Svf(fs); this.metalF = new Svf(fs);
    this.eq = new Peq(fs); this.hp = new Svf(fs); this.lp = new Svf(fs);
  }

  tone(f0: f64, peak: f64, dec: f64): void { this.ft = f0; if (this.sl) return; this.f0 = f0; this.toneE.trig(peak, dec); this.ph = 0; this.mph = 0; }
  sweep(amt: f64, dec: f64): void { if (this.sl) return; this.pamt = amt; this.pe = 1; this.pk = coef(this.fs, dec); }
  fm(amt: f64, ratio: f64, dec: f64): void { if (this.sl) return; this.iamt = amt; this.ratio = ratio; this.ie = 1; this.ik = coef(this.fs, dec); }
  noise(peak: f64, dec: f64, f: f64, q: f64, mode: i32): void { this.noiseE.trig(peak, dec); this.noiseF.set(f, q, mode); }
  metal(peak: f64, dec: f64, tune: f64, hpf: f64): void {
    this.metalE.trig(peak, dec); this.metalF.set(hpf, 1, HP);
    for (let j = 0; j < 6; j++) this.mdt[j] = METAL[j] * tune / this.fs;
  }

  trig(m: i32, p: StaticArray<f64>, slide: i32): void {
    this.sl = slide > 0 && this.toneE.h > 1e-4;
    if (!this.sl) { this.pamt = 0; this.iamt = 0; }
    this.son = 0;
    if (m == 0) { this.tone(ex(p[0], 20, 2000), 1, ex(p[1], 0.01, 4)); this.sweep(p[2] / 127 * 8, ex(p[3], 0.005, 1)); }
    else if (m == 1) this.noise(1, ex(p[0], 0.01, 4), 18000, 0.7, LP);
    else if (m == 2) this.imp = 1;
    else if (m == 3) {
      this.tone(ex(p[0], 30, 120), 1, ex(p[1], 0.05, 2)); this.sweep(p[2] / 127 * 6, ex(p[3], 0.005, 0.2));
      this.imp = p[4] / 127; this.noise(p[5] / 127 * 0.5, 0.02, 3000, 0.7, LP);
    } else if (m == 4) {
      this.tone(ex(p[0], 120, 400), 0.7, ex(p[1], 0.03, 0.6)); this.sweep(p[2] / 127 * 2, ex(p[3], 0.005, 0.1));
      this.noise(p[4] / 127, ex(p[1], 0.05, 0.8), ex(p[5], 500, 8000), 0.8, HP);
    } else if (m == 5) this.metal(0.6, ex(p[1], 0.01, 0.3), ex(p[0], 0.5, 2), ex(p[2], 3000, 12000));
    else if (m == 6) this.metal(0.6, ex(p[1], 0.05, 2), ex(p[0], 0.5, 2), ex(p[2], 3000, 12000));
    else if (m == 7) {
      this.noiseF.set(ex(p[2], 600, 3000), 2, BP);
      this.nb = 1 + Math.round(p[0] / 127 * 5); this.bc = 0; this.cdec = ex(p[1], 0.05, 1);
    } else if (m == 8) {
      this.tone(ex(p[0], 30, 200), 1, ex(p[1], 0.05, 2)); this.sweep(p[2] / 127 * 6, ex(p[3], 0.005, 0.2));
      this.fm(p[4] / 127 * 8, ex(p[5], 0.5, 8), ex(p[6], 0.005, 1));
    } else if (m == 9) {
      this.tone(ex(p[0], 100, 500), 0.6, ex(p[1], 0.03, 0.8));
      this.noise(p[2] / 127, ex(p[3], 0.02, 0.8), ex(p[7], 200, 8000), 0.7, HP);
      this.fm(p[4] / 127 * 8, ex(p[5], 0.5, 8), ex(p[6], 0.005, 0.5));
    } else if (m == 10) {
      this.tone(ex(p[0], 200, 1200), 0.6, ex(p[1], 0.02, 1)); this.fm(p[2] / 127 * 10, ex(p[3], 0.5, 8), ex(p[4], 0.005, 1));
    } else if (m == 11) {
      this.tone(ex(p[0], 200, 2000), 0.4, ex(p[1], 0.01, 1)); this.fm(p[2] / 127 * 20, ex(p[3], 0.5, 8), ex(p[4], 0.005, 1));
      this.noise(0.3, ex(p[1], 0.01, 1), ex(p[5], 2000, 12000), 0.7, HP);
    } else if (m == 12 && this.slen > 1) {
      const n = <f64>(this.slen - 1), a = p[2] / 127 * n, b = p[3] / 127 * n, r = Math.pow(2, (p[0] - 64) / 24);
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
    const ds = p[DEL] / 127, rs = p[REV] / 127;
    this.dl = this.gl * ds; this.dr = this.gr * ds; this.rl = this.gl * rs; this.rr = this.gr * rs;
  }

  tick(nz: f64): f64 {
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
    let metal: f64 = 0;
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
      const i = <i32>Math.floor(this.sp), fr = this.sp - <f64>i;
      const a = <f64>unchecked(this.smp[i]), b = <f64>unchecked(this.smp[min(i + 1, this.slen - 1)]);
      x += (a + (b - a) * fr) * this.smpE.tick();
      this.sp += this.sd;
      if (this.sd > 0 ? this.sp > this.se : this.sp < this.se) this.son = 0;
    }
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

const out = new StaticArray<f32>(128 * 6); // channel k at k * 128: dry L/R, echo send L/R, gate box send L/R
const par = new StaticArray<f64>(24);
const vs = new Array<Voice>(0);
let seed: u32 = 0x12345678;

export function init(fs: f64): void { for (let i = 0; i < 16; i++) vs.push(new Voice(fs)); }
export function outPtr(): usize { return changetype<usize>(out); }
export function parPtr(): usize { return changetype<usize>(par); }
export function trig(tr: i32, m: i32, slide: i32): void { unchecked(vs[tr]).trig(m, par, slide); }
// ROM sample: JS writes up to MAXS floats at smpPtr(tr), then calls smpLen(tr, n)
export function smpPtr(tr: i32): usize { return changetype<usize>(unchecked(vs[tr]).smp); }
export function smpLen(tr: i32, n: i32): void { const v = unchecked(vs[tr]); v.slen = min(n, MAXS); v.son = 0; }

export function render(n: i32): void {
  for (let i = 0; i < n; i++) {
    let L: f64 = 0, R: f64 = 0, DL: f64 = 0, DR: f64 = 0, RL: f64 = 0, RR: f64 = 0;
    for (let t = 0; t < 16; t++) {
      let s = seed;
      s ^= s << 13; s ^= s >> 17; s ^= s << 5;
      seed = s;
      const v = unchecked(vs[t]), x = v.tick(<f64>s / 4294967296 * 2 - 1);
      L += x * v.gl; R += x * v.gr; DL += x * v.dl; DR += x * v.dr; RL += x * v.rl; RR += x * v.rr;
    }
    out[i] = <f32>L; out[128 + i] = <f32>R; out[256 + i] = <f32>DL; out[384 + i] = <f32>DR; out[512 + i] = <f32>RL; out[640 + i] = <f32>RR;
  }
}
