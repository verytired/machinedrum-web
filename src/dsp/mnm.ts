// Monomachine-style synth engine: 6 mono tracks, each SWAVE (saw/pulse morph + detuned 2nd saw + sub + noise) or
// FM (2-op with feedback), then AMP ADSR -> HP/LP filter with its own envelope -> DIST -> VOL/PAN, one LFO.
// Same shape as MdEngine (trig / render to 6 outs) so md-processor.ts and the master FX take it unchanged.
// Every parameter is 0-127 and latched at the trig; p[NOTE] is the MIDI note, p[GATE] the gate in seconds.
// ponytail: TS only, no AssemblyScript twin like md.ts; add one if 6 tracks in JS ever cost too much CPU
import { TAU, LP, HP, ex, coef, blep, Svf, Env, DUCK_DEC, DUCK_MAX } from './md';

export const MNPAR = 32;
export const ATK = 8, DEC = 9, SUS = 10, REL = 11, LEN = 12, DIST = 13, VOL = 14, PAN = 15;
export const BASE = 16, WDTH = 17, Q = 18, FENV = 19, FATK = 20, FDEC = 21, DEL = 22, REV = 23;
export const SPD = 24, DEP = 25, SHP = 26, DEST = 27, DUCK = 28; // DUCK: as on the MD tracks, keyed by the MD's BD track
export const NOTE = 32, GATE = 33;
// locks beyond the track's params: SLD = a slide trig (the pitch glides ~60 ms from the sounding note, no retrigger: the
// envelopes, phases and LFO carry on, only the gate is renewed), ACC = an accent (+3 dB, the filter envelope 1.5 octaves harder)
export const SLD = 34, ACC = 35;
const SWAVE = 0; // 1 = FM

class Voice {
  ph = 0; ph2 = 0; sph = 0; mph = 0; fb = 0; f = 110; ft = 110; gk = 0;
  m = SWAVE; wav = 0; pw = 0.5; det = 1; o2 = 0; sub = 0; nz = 0; rat = 1; idx = 0; ie = 0; ik = 1; fbk = 0;
  // AMP: attack ramp, decay to sustain, release after the gate
  stage = 0; e = 0; ai = 0; dk = 1; sus = 0; rk = 1; gate = 0;
  // filter: HP at BASE, LP at BASE * WDTH, both moved by an AD envelope (FENV around 64)
  hp: Svf; lp: Svf; fb0 = 100; fw = 10; fq = 1; famt = 0; fe = 0; fai = 0; fdk = 1; fst = 0; fc = 0;
  lph = 0; lpi = 0; ldep = 0; lshp = 0; ldst = 0;
  dg = 0; gl = 0; gr = 0; dl = 0; dr = 0; rl = 0; rr = 0; du = 0;
  constructor(private fs: number) { this.hp = new Svf(fs); this.lp = new Svf(fs); }

  trig(m: number, p: ArrayLike<number>) {
    const fs = this.fs, f = 440 * Math.pow(2, (p[NOTE] - 69) / 12);
    if (p[SLD] > 0 && this.e > 1e-4 && m == this.m) {   // only a sounding note glides
      this.ft = f; this.gk = coef(fs, 0.06); this.gate = Math.max(1, Math.round(p[GATE] * fs)); if (this.stage == 0) this.stage = 2;
      return;
    }
    this.m = m; this.f = this.ft = f; this.gk = 0;
    if (m == SWAVE) { this.wav = p[0] / 127; this.pw = 0.5 - p[1] / 127 * 0.45; this.det = Math.pow(2, p[2] / 127 * 0.5 / 12); this.o2 = p[3] / 127; this.sub = p[4] / 127; this.nz = p[5] / 127; }
    else { this.rat = Math.max(0.5, Math.round(p[0] / 127 * 16) / 2); this.idx = p[1] / 127 * 10; this.ie = 1; this.ik = coef(fs, ex(p[2], 0.01, 4)); this.fbk = p[3] / 127 * 1.5; }
    this.stage = 1; this.ai = 1 / (ex(p[ATK], 0.001, 2) * fs); this.dk = coef(fs, ex(p[DEC], 0.01, 4));
    this.sus = p[SUS] / 127; this.rk = coef(fs, ex(p[REL], 0.01, 4)); this.gate = Math.max(1, Math.round(p[GATE] * fs));
    this.fb0 = ex(p[BASE], 20, 20000); this.fw = ex(p[WDTH], 1, 1000); this.fq = ex(p[Q], 0.5, 20); this.famt = (p[FENV] - 64) / 64 * 6;
    this.fe = 0; this.fst = 1; this.fai = 1 / (ex(p[FATK], 0.001, 2) * fs); this.fdk = coef(fs, ex(p[FDEC], 0.01, 4)); this.fc = 0;
    this.lph = 0; this.lpi = ex(p[SPD], 0.05, 30) / fs; this.ldep = p[DEP] / 127; this.lshp = p[SHP] >> 5; this.ldst = p[DEST] >> 5;
    this.dg = p[DIST] / 127 * (p[DIST] / 127) * 20;
    if (p[ACC] > 0) this.famt += 1.5;
    const v = p[VOL] / 127 * (p[ACC] > 0 ? 1.41 : 1), a = (p[PAN] / 127) * Math.PI / 2;
    this.gl = v * Math.cos(a); this.gr = v * Math.sin(a); this.du = p[DUCK] / 127 * DUCK_MAX;
    const ds = p[DEL] / 127, rs = p[REV] / 127;
    this.dl = this.gl * ds; this.dr = this.gr * ds; this.rl = this.gl * rs; this.rr = this.gr * rs;
  }

  tick(noise: number): number {
    const fs = this.fs;
    if (this.stage == 0 && this.e < 1e-5) return 0;
    // LFO: 0 sine, 1 triangle, 2 saw down, 3 square; DEST 0 pitch, 1 filter, 2 amp, 3 PW / FM index
    const lp = this.lph, l = this.lshp == 0 ? Math.sin(TAU * lp) : this.lshp == 1 ? 1 - 4 * Math.abs(lp - 0.5) : this.lshp == 2 ? 1 - 2 * lp : lp < 0.5 ? 1 : -1;
    this.lph += this.lpi; if (this.lph >= 1) this.lph -= 1;
    const lv = l * this.ldep;
    if (this.gk) this.f = this.ft + (this.f - this.ft) * this.gk;
    const f = this.ldst == 0 ? this.f * Math.pow(2, lv) : this.f, dt = Math.min(f / fs, 0.45);
    let x = 0;
    if (this.m == SWAVE) {
      const pw = this.ldst == 3 ? Math.min(0.95, Math.max(0.05, this.pw + lv * 0.45)) : this.pw;
      const p = this.ph, saw = 2 * p - 1 - blep(p, dt);
      let q = p - pw; if (q < 0) q += 1;
      const pulse = (p < pw ? 1 : -1) + blep(p, dt) - blep(q, dt);
      const dt2 = Math.min(dt * this.det, 0.45), p2 = this.ph2;
      x = (1 - this.wav) * saw + this.wav * pulse + this.o2 * (2 * p2 - 1 - blep(p2, dt2)) + this.sub * Math.sin(TAU * this.sph) + this.nz * noise;
      this.ph += dt; if (this.ph >= 1) this.ph -= 1;
      this.ph2 += dt2; if (this.ph2 >= 1) this.ph2 -= 1;
      this.sph += dt / 2; if (this.sph >= 1) this.sph -= 1;
      x *= 0.4;
    } else {
      const ix = this.idx * this.ie * (this.ldst == 3 ? Math.max(0, 1 + lv) : 1); this.ie *= this.ik;
      const mo = Math.sin(TAU * this.mph + this.fbk * this.fb); this.fb = mo;
      x = Math.sin(TAU * this.ph + ix * mo) * 0.6;
      this.ph += dt; if (this.ph >= 1) this.ph -= 1;
      this.mph += dt * this.rat; if (this.mph >= 1) this.mph -= Math.floor(this.mph);
    }
    // AMP
    if (this.stage == 1) { this.e += this.ai; if (this.e >= 1) { this.e = 1; this.stage = 2; } }
    else if (this.stage == 2) this.e = this.sus + (this.e - this.sus) * this.dk;
    else this.e *= this.rk;
    if (this.stage && --this.gate <= 0) this.stage = 0;
    // filter envelope, coefficients refreshed every 16 samples
    if (this.fst == 1) { this.fe += this.fai; if (this.fe >= 1) { this.fe = 1; this.fst = 2; } } else this.fe *= this.fdk;
    if (this.fc-- <= 0) {
      this.fc = 15;
      const fb = this.fb0 * Math.pow(2, this.famt * this.fe + (this.ldst == 1 ? lv * 4 : 0));
      this.hp.set(fb, this.fq, HP); this.lp.set(fb * this.fw, this.fq, LP);
    }
    x = this.lp.tick(this.hp.tick(x)) * this.e * (this.ldst == 2 ? 1 - this.ldep * (0.5 - 0.5 * l) : 1);
    if (this.dg > 0) x = Math.tanh(x * (1 + this.dg)) / Math.tanh(1 + this.dg);
    return x;
  }
}

export class MnmEngine {
  private vs: Voice[] = [];
  private seed = 0x2468ace1;
  private dk: Env;
  constructor(fs: number) { for (let i = 0; i < 6; i++) this.vs.push(new Voice(fs)); this.dk = new Env(fs); }
  // tr -1: the MD's BD track was hit (the duck key), not a note
  trig(tr: number, m: number, p: ArrayLike<number>) { if (tr < 0) this.dk.trig(1, DUCK_DEC); else this.vs[tr].trig(m, p); }
  sample() { /* no ROM machine */ }
  // tap: each track's dry L/R (after VOL / PAN and the duck) as well, for stems: 2 x 6 arrays of 128, indexed by
  // (off + i) & 127, so a 128-aligned block reads back from 0. TS only (instrumentation, not sound)
  tap: Float32Array[] | null = null;
  render(o: Float32Array[], off: number, n: number) {
    const tap = this.tap;
    for (let i = 0; i < n; i++) {
      let L = 0, R = 0, DL = 0, DR = 0, RL = 0, RR = 0;
      const dk = this.dk.tick();
      for (let t = 0; t < 6; t++) {
        let s = this.seed;
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        this.seed = s;
        const v = this.vs[t], x = v.tick((s >>> 0) / 4294967296 * 2 - 1), d = x * (1 - v.du * dk);
        if (tap) { const j = (off + i) & 127; tap[2 * t][j] = d * v.gl; tap[2 * t + 1][j] = d * v.gr; }
        L += d * v.gl; R += d * v.gr; DL += d * v.dl; DR += d * v.dr; RL += d * v.rl; RR += d * v.rr;
      }
      o[0][off + i] = L; o[1][off + i] = R; o[2][off + i] = DL; o[3][off + i] = DR; o[4][off + i] = RL; o[5][off + i] = RR;
    }
  }
}
