// Master bus end stage and meter, shared by the live worklet (md-processor.ts) and EXP WAV (render.ts).
// Limiter: makeup GAIN -> soft clip (CLIP, 0 = off) -> stereo-linked look-ahead brickwall at CEIL. The gain is the minimum of the
// needed gains over the look-ahead window, released, then box-averaged over the same window, so it is down to a
// peak's gain by the time that peak leaves the delay line: no overs, no attack click.
// Meter: integrated / short-term max loudness (ITU-R BS.1770-4, gated), 4x true peak, and the level per band.
export const CEIL = Math.pow(10, -1 / 20); // -1 dBFS
const LOOK = 0.005, REL = 0.08;

export class Limiter {
  readonly lat: number; // delay in samples
  private n: number; private dl: Float32Array; private dr: Float32Array;
  private qv: Float64Array; private qi: Float64Array; private qh = 0; private qt = 0; // monotonic deque (ring) for the window min
  private box: Float64Array; private sum: number; private g = 1; private kr: number; private i = 0;
  private drive = 1; private knee = Infinity;
  constructor(fs: number) {
    const n = this.n = Math.max(2, Math.round(LOOK * fs));
    this.lat = n - 1;
    this.dl = new Float32Array(n); this.dr = new Float32Array(n);
    this.qv = new Float64Array(n + 1); this.qi = new Float64Array(n + 1);
    this.box = new Float64Array(n).fill(1); this.sum = n;
    this.kr = Math.exp(-1 / (REL * fs));
  }
  // clip 0-127: up to +6 dB of drive into a tanh knee that starts lower the more it is turned up; gain 0-127: 0 to +18 dB
  set(clip: number, gain = 0) { const c = clip / 127; this.drive = (1 + c) * Math.pow(10, gain / 127 * 18 / 20); this.knee = clip > 0 ? CEIL * (1 - 0.5 * c) : Infinity; }
  private sat(x: number) {
    x *= this.drive;
    const a = Math.abs(x), k = this.knee;
    return a <= k ? x : Math.sign(x) * (k + (CEIL - k) * Math.tanh((a - k) / (CEIL - k)));
  }
  process(l: Float32Array, r: Float32Array, off = 0, len = l.length - off) {
    const n = this.n, m = n + 1;
    for (let j = off; j < off + len; j++) {
      const xl = this.sat(l[j]), xr = this.sat(r[j]), pk = Math.max(Math.abs(xl), Math.abs(xr)), need = pk > CEIL ? CEIL / pk : 1, i = this.i;
      while (this.qt !== this.qh && this.qv[(this.qt + m - 1) % m] >= need) this.qt = (this.qt + m - 1) % m;
      this.qv[this.qt] = need; this.qi[this.qt] = i; this.qt = (this.qt + 1) % m;
      while (this.qi[this.qh] <= i - n) this.qh = (this.qh + 1) % m;
      const w = this.qv[this.qh];
      this.g = w < this.g ? w : w - (w - this.g) * this.kr;
      const b = i % n;
      this.sum += this.g - this.box[b]; this.box[b] = this.g;
      this.dl[b] = xl; this.dr[b] = xr;
      const o = (i + 1) % n, g = this.sum / n;
      l[j] = Math.max(-CEIL, Math.min(CEIL, this.dl[o] * g)); r[j] = Math.max(-CEIL, Math.min(CEIL, this.dr[o] * g));
      this.i = i + 1;
    }
  }
}

// ---- meter ----
type Bq = [b0: number, b1: number, b2: number, a1: number, a2: number];
const rbj = (type: 'lp' | 'hp', fs: number, f: number, q: number): Bq => {
  const w = 2 * Math.PI * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q), k = type === 'lp' ? (1 - c) / 2 : (1 + c) / 2, a0 = 1 + al;
  return [k / a0, (type === 'lp' ? 1 - c : -(1 + c)) / a0, k / a0, -2 * c / a0, (1 - al) / a0];
};
function filt(x: Float32Array, ...fs: Bq[]): Float32Array {
  const y = Float32Array.from(x);
  for (const [b0, b1, b2, a1, a2] of fs) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) { const v = y[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; }
  }
  return y;
}
const db = (p: number) => p > 0 ? 10 * Math.log10(p) : -Infinity;
const r1 = (v: number) => Math.round(v * 10) / 10;

// BS.1770 loudness: K-weighted, 400 ms blocks (75 % overlap), -70 LUFS absolute and -10 LU relative gates
function loudness(l: Float32Array, r: Float32Array, fs: number) {
  // the two K-weighting stages for any rate, as libebur128 derives them (48 kHz gives the spec's coefficients)
  const K1 = Math.tan(Math.PI * 1681.974450955533 / fs), Q1 = 0.7071752369554196, Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  const a1 = 1 + K1 / Q1 + K1 * K1, K2 = Math.tan(Math.PI * 38.13547087602444 / fs), Q2 = 0.5003270373238773, a2 = 1 + K2 / Q2 + K2 * K2;
  const kw: Bq[] = [
    [(Vh + Vb * K1 / Q1 + K1 * K1) / a1, 2 * (K1 * K1 - Vh) / a1, (Vh - Vb * K1 / Q1 + K1 * K1) / a1, 2 * (K1 * K1 - 1) / a1, (1 - K1 / Q1 + K1 * K1) / a1],
    [1, -2, 1, 2 * (K2 * K2 - 1) / a2, (1 - K2 / Q2 + K2 * K2) / a2],
  ];
  const kl = filt(l, ...kw), kr = filt(r, ...kw), hop = Math.round(0.1 * fs), ms: number[] = [];
  for (let s = 0; s + hop <= kl.length; s += hop) { let e = 0; for (let i = s; i < s + hop; i++) e += kl[i] * kl[i] + kr[i] * kr[i]; ms.push(e / hop); }
  const win = (k: number, n: number) => { let e = 0; for (let j = k; j < k + n; j++) e += ms[j]; return e / n; };
  const lu = (p: number) => -0.691 + db(p);
  const blocks: number[] = []; for (let k = 0; k + 4 <= ms.length; k++) blocks.push(win(k, 4));
  const abs = blocks.filter(p => lu(p) > -70), mean = (a: number[]) => a.reduce((s, p) => s + p, 0) / a.length;
  const rel = lu(mean(abs)) - 10, gated = abs.filter(p => lu(p) > rel);
  let st = -Infinity; for (let k = 0; k + 30 <= ms.length; k++) st = Math.max(st, lu(win(k, 30)));
  return { lufs: gated.length ? lu(mean(gated)) : -Infinity, stMax: st };
}

// 4x true peak: Hann-windowed sinc, 16 taps each side
const TAPS = 16, PH = [1, 2, 3].map(f => Array.from({ length: 2 * TAPS }, (_, k) => {
  const t = k - TAPS + 1 - f / 4; return Math.sin(Math.PI * t) / (Math.PI * t) * (0.5 + 0.5 * Math.cos(Math.PI * t / TAPS));
}));
function truePeak(x: Float32Array) {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    p = Math.max(p, Math.abs(x[i]));
    if (i < TAPS - 1 || i + TAPS >= x.length) continue;
    for (const h of PH) { let s = 0; for (let k = 0; k < 2 * TAPS; k++) s += h[k] * x[i - TAPS + 1 + k]; p = Math.max(p, Math.abs(s)); }
  }
  return p;
}

export const BANDS: [string, number, number][] = [['sub', 20, 60], ['low', 60, 250], ['mid', 250, 2000], ['high', 2000, 8000], ['air', 8000, 20000]];
export interface Report { lufs: number; stMax: number; tp: number; peak: number; plr: number; bands: Record<string, number> }
// bands: each band's level against the whole mix in dB (mono sum, 4th-order band edges)
export function measure(l: Float32Array, r: Float32Array, fs: number): Report {
  const { lufs, stMax } = loudness(l, r, fs);
  let peak = 0; for (let i = 0; i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  const tp = Math.max(truePeak(l), truePeak(r)), mono = l.map((v, i) => (v + r[i]) / 2);
  const pow = (x: Float32Array) => { let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i]; return e / x.length; }, all = pow(mono);
  const q = Math.SQRT1_2, bands: Record<string, number> = {};
  for (const [name, lo, hi] of BANDS) bands[name] = r1(db(pow(filt(mono, rbj('hp', fs, lo, q), rbj('hp', fs, lo, q), ...(hi < fs / 2.2 ? [rbj('lp', fs, hi, q), rbj('lp', fs, hi, q)] : []))) / all));
  return { lufs: r1(lufs), stMax: r1(stMax), tp: r1(20 * Math.log10(tp)), peak: r1(20 * Math.log10(peak)), plr: r1(20 * Math.log10(tp) - lufs), bands };
}
