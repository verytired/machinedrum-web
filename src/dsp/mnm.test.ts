import { describe, it, expect } from 'vitest';
import { MnmEngine, MNPAR, NOTE, GATE, DEST, DEP } from './mnm';

const SR = 48000;
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
});
