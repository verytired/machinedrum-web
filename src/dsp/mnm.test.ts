import { describe, it, expect } from 'vitest';
import { MnmEngine, MNPAR, NOTE, GATE, DEST, DEP, SLD, ACC, ATK, SUS, FENV, CHD } from './mnm';

const SR = 48000, TAU = 2 * Math.PI;
const TRACK = [0, 60, 60, 40, 3, 0, 90, 64, 0, 90, 20, 90, 0, 50, 0, 0, 40, 0, 0, 0, 0, 0, 0, 0];
const params = (m: number, over: Record<number, number> = {}) => {
  const p = [m ? 16 : 0, 40, 20, 40, 30, 0, 0, 0, ...TRACK, 45]; p[GATE] = 0.1;
  for (const k in over) p[+k] = over[k];
  return p;
};
function render(m: number, over?: Record<number, number>, secs = 1.5) {
  const e = new MnmEngine(SR), o = Array.from({ length: 6 }, () => new Float32Array(SR * secs));
  e.trig(0, m, params(m, over));
  for (let b = 0; b < o[0].length; b += 128) e.render(o, b, Math.min(128, o[0].length - b));
  return o[0];
}
const rms = (x: Float32Array, a: number, b: number) => Math.sqrt(x.subarray(a, b).reduce((s, v) => s + v * v, 0) / (b - a));

describe('MnM engine', () => {
  it('has NOTE right after the 32 params', () => expect(NOTE).toBe(MNPAR));
  for (const [name, m] of [['SWAVE', 0], ['FM', 1]] as const) it(`${name}: sounds during the gate, finite, silent after the release`, () => {
    const x = render(m);
    expect(x.every(Number.isFinite)).toBe(true);
    expect(rms(x, 0, SR * 0.1)).toBeGreaterThan(0.01);
    expect(rms(x, SR * 1.3, SR * 1.5)).toBeLessThan(1e-4);
  });
  it('LFO on pitch changes the output', () => {
    const a = render(0), b = render(0, { [DEST]: 0, [DEP]: 100 });
    expect(rms(a, 0, SR * 0.1)).not.toBeCloseTo(rms(b, 0, SR * 0.1), 4);
  });
  it('SLD glides to the new note without a retrigger, a silent voice just plays it; ACC is louder', () => {
    const run = (second: Record<number, number>, firstOn = true) => {
      const o2 = { 3: second[3] ?? 40, 4: second[4] ?? 30 };
      const e = new MnmEngine(SR), o = Array.from({ length: 6 }, () => new Float32Array(SR * 0.6));
      if (firstOn) e.trig(0, 0, params(0, { [ATK]: 90, [SUS]: 127, [GATE]: 1, [FENV]: 110, ...o2 }));      // a slow attack, still rising at 0.2 s
      for (let b = 0; b < o[0].length; b += 128) {
        if (b === SR * 0.2 - (SR * 0.2) % 128) e.trig(0, 0, params(0, { [ATK]: 90, [SUS]: 127, [NOTE]: 57, [GATE]: 1, [FENV]: 110, ...second }));
        e.render(o, b, 128);
      }
      return o[0];
    };
    const ups = (x: Float32Array, a: number, b: number) => { let n = 0; for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) n++; return n / ((b - a) / SR); };
    const sl = run({ [SLD]: 1 }), re = run({});
    expect(ups(sl, SR * 0.45, SR * 0.6) / ups(re, SR * 0.45, SR * 0.6)).toBeCloseTo(1, 1);   // at the new note by then
    expect(ups(sl, SR * 0.45, SR * 0.6)).toBeGreaterThan(ups(sl, SR * 0.05, SR * 0.2) * 1.5);  // an octave over the first
    // the first cycle after the trig (a plain saw): the retrigger is at A3 at once (~218 samples), the slide still on its way up
    const cyc = (x: Float32Array) => { const u: number[] = []; for (let i = SR * 0.2 + 1; u.length < 2; i++) if (x[i - 1] < 0 && x[i] >= 0) u.push(i); return u[1] - u[0]; };
    const saw = { 3: 0, 4: 0 };
    expect(cyc(run(saw))).toBeLessThan(230);
    expect(cyc(run({ ...saw, [SLD]: 1 }))).toBeGreaterThan(260);   // the retrigger's new filter envelope, none on the slide
    expect(run({ [SLD]: 1 }, false)).toEqual(run({}, false));                                    // nothing sounding: a plain trig
    const a = render(0, { [ACC]: 1 }), n = render(0);
    expect(rms(a, SR * 0.02, SR * 0.08) / rms(n, SR * 0.02, SR * 0.08)).toBeGreaterThan(1.2);
  });
  it('CHD plays a chord on one trig (m: the minor third and the fifth over the root), at about the root alone level; FM ignores it', () => {
    const g = (x: Float32Array, f: number) => { let re = 0, im = 0; for (let i = 0; i < SR * 0.1; i++) { re += x[i] * Math.cos(TAU * f * i / SR); im += x[i] * Math.sin(TAU * f * i / SR); } return Math.hypot(re, im); };
    const over = { 3: 0, 4: 0, 16: 0, 17: 127 };                  // a plain saw, the filter open
    const one = render(0, over), m = render(0, { ...over, [CHD]: 16 }), root = 110 * Math.pow(2, 0);
    for (const s of [3, 7]) expect(g(m, root * Math.pow(2, s / 12))).toBeGreaterThan(g(one, root * Math.pow(2, s / 12)) * 10);
    expect(Math.abs(20 * Math.log10(rms(m, 0, SR * 0.1) / rms(one, 0, SR * 0.1)))).toBeLessThan(3);
    expect(render(1, { [CHD]: 16 })).toEqual(render(1));
  });
});
