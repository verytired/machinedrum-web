// master.ts: the limiter's ceiling and transparency, the meter against known signals
import { test, expect } from 'vitest';
import { Limiter, measure, CEIL } from './master';

const FS = 48000;
const sine = (f: number, a: number, secs: number, ph = 0) => Float32Array.from({ length: FS * secs }, (_, i) => a * Math.sin(2 * Math.PI * f * i / FS + ph));

test('limiter: no sample over the ceiling, quiet audio passes untouched (just delayed)', () => {
  const lim = new Limiter(FS), l = sine(60, 3, 1), r = sine(90, 0.2, 1);
  for (let i = 0; i < l.length; i += 4000) l[i] = -8;       // spikes
  lim.process(l, r);
  expect(Math.max(...l.map(Math.abs), ...r.map(Math.abs))).toBeLessThanOrEqual(CEIL);
  const q = new Limiter(FS), a = sine(440, 0.5, 1), b = a.slice();
  q.process(a, b, 0, 1000); q.process(a, b, 1000);          // in two blocks, like the worklet
  const x = sine(440, 0.5, 1);
  for (let i = q.lat; i < a.length; i++) expect(Math.abs(a[i] - x[i - q.lat])).toBeLessThan(1e-6);
});

test('soft clip lowers the crest factor, CLIP 0 does nothing', () => {
  const run = (clip: number) => { const lim = new Limiter(FS), l = sine(100, 1.5, 1), r = l.slice(); lim.set(clip); lim.process(l, r); return measure(l, r, FS); };
  const off = run(0), on = run(127);
  expect(on.lufs).toBeGreaterThan(off.lufs + 0.5);
  expect(on.tp).toBeLessThanOrEqual(-0.9);
});

test('GAIN: +18 dB at 127 on a quiet signal, the ceiling still holds on a loud one', () => {
  const q = new Limiter(FS), a = sine(440, 0.01, 1), b = a.slice(); q.set(0, 127); q.process(a, b);
  expect(measure(a, b, FS).lufs - measure(sine(440, 0.01, 1), sine(440, 0.01, 1), FS).lufs).toBeCloseTo(18, 0);
  const w = new Limiter(FS), l = sine(60, 0.5, 1), r = l.slice(); w.set(64, 127); w.process(l, r);
  expect(Math.max(...l.map(Math.abs))).toBeLessThanOrEqual(CEIL);
});

test('meter: BS.1770 level of a 1 kHz sine, 4x true peak, bands', () => {
  const s = sine(1000, 0.1, 5), m = measure(s, s, FS);
  expect(Math.abs(m.lufs - -20)).toBeLessThan(0.15);        // both channels at 0.1 = -20 LUFS (one channel at 0 dBFS = -3.01)
  const q = sine(FS / 4, 0.9, 1, Math.PI / 4), t = measure(q, q, FS); // samples land 3 dB under the crests
  expect(t.peak).toBeCloseTo(20 * Math.log10(0.9 * Math.SQRT1_2), 0);
  expect(Math.abs(t.tp - 20 * Math.log10(0.9))).toBeLessThan(0.3);
  const b = measure(sine(40, 0.5, 2), sine(40, 0.5, 2), FS).bands;
  expect(b.sub).toBeGreaterThan(-3);                         // 40 Hz sits between the 20 and 60 Hz edges: -2.1 dB in theory
  expect(b.mid).toBeLessThan(-30);
});

test('seeded: the same sequence for the same seed, a different one for another', async () => {
  const { seeded, gateIR } = await import('./fx');
  const a = seeded('HEY'), b = seeded('HEY'), c = seeded('HO'), xs = Array.from({ length: 1000 }, a);
  expect(xs).toEqual(Array.from({ length: 1000 }, b));
  expect(xs).not.toEqual(Array.from({ length: 1000 }, c));
  expect(Math.min(...xs)).toBeGreaterThanOrEqual(0); expect(Math.max(...xs)).toBeLessThan(1);
  expect(gateIR(44100, 0, 40, 20, seeded('0,40,20'))[0]).toEqual(gateIR(44100, 0, 40, 20, seeded('0,40,20'))[0]);
});

test('MONO: the low end of a one-sided signal ends up in both channels, the highs stay where they were', () => {
  const run = (f: number) => { const lim = new Limiter(FS), l = sine(f, 0.3, 1), r = new Float32Array(FS); lim.set(0, 0, 76); lim.process(l, r);
    const e = (x: Float32Array) => x.slice(FS / 2).reduce((s, v) => s + v * v, 0); return e(r) / e(l); };
  expect(run(40)).toBeGreaterThan(0.8);   // 40 Hz, left only: now (nearly) mono
  expect(run(2000)).toBeLessThan(1e-4);   // 2 kHz, left only: untouched
});

test('limiter: true peaks under the ceiling too, even driven hard (high tones, clipped kicks)', () => {
  const lim = new Limiter(FS), l = sine(FS / 4 - 50, 2, 2, Math.PI / 4), r = sine(55, 3, 2); // samples fall between the crests
  for (let i = 0; i < l.length; i++) r[i] += Math.sign(Math.sin(2 * Math.PI * 3000 * i / FS)) * 0.5; // square edges
  lim.set(64, 80); lim.process(l, r);
  expect(measure(l.subarray(FS / 10), r.subarray(FS / 10), FS).tp).toBeLessThanOrEqual(-0.9);
});
