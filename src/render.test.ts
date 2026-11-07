// songHits: MICRO moves a trig off its step (triplets on the 16-step grid)
import { test, expect } from 'vitest';
import { songHits, SR } from './render';
import { defaultState } from './machines';
import { empty, trip, hits as put, applyBar } from './bars';

test('triplets via MICRO land on thirds of a beat', () => {
  const st = defaultState(), b = empty();
  st.trig.forEach(r => r.fill(false));
  trip(b, 'BD', 'xxx.........', 100);                       // the first beat as three 8th-note triplets
  applyBar(st, b); st.pats[0] = { trig: st.trig, lock: st.lock };
  st.song = [{ pat: 0, rep: 1, of: 0, len: 16, bpm: 120, mute: 0 }, { end: true }];
  const beat = 60 / 120 * SR, f = songHits(st).hits.filter(h => h.tr === 0).map(h => h.f);
  [0, beat / 3, beat * 2 / 3].forEach((x, i) => expect(Math.abs(f[i] - x)).toBeLessThanOrEqual(1)); // within a sample (rounding)
  expect(f).toHaveLength(3);
});

test('song automation: a lane sweeps a param along the song, a p-lock on the step still wins, the MNM too', async () => {
  const { laneAt } = await import('./machines');
  expect([laneAt([[0, 10], [2, 30]], -1), laneAt([[0, 10], [2, 30]], 1), laneAt([[0, 10], [2, 30]], 5)]).toEqual([10, 20, 30]);
  const st = defaultState(), b = empty();
  st.trig.forEach(r => r.fill(false));
  put(b, 'BD', 'x...x...x...x...', 100);
  applyBar(st, b); st.lock[0][4] = { 12: 99 };               // a FLTF lock on the 2nd kick
  st.pats[0] = { trig: st.trig, lock: st.lock };
  st.song = [{ pat: 0, rep: 4, of: 0, len: 16, bpm: 120, mute: 0 }, { end: true }];
  st.auto = [{ tr: 0, par: 12, pts: [[0, 0], [4, 64]] }, { tr: 16, par: 16, pts: [[0, 20], [4, 100]] }];
  const mnm = { kit: [0, 1, 0, 1, 0, 1].map(m => ({ m, p: Array(34).fill(0) })), trig: Array.from({ length: 6 }, (_, k) => Array(16).fill(k === 0)), lock: Array.from({ length: 6 }, () => Array(16).fill(null)) };
  const { hits, mhits } = songHits(st, mnm);
  const f = hits.filter(h => h.tr === 0).map(h => h.p[12]);
  expect(f.slice(0, 5)).toEqual([0, 99, 8, 12, 16]);        // bar 0 steps 0 / 4 (locked) / 8 / 12, then bar 1 step 0
  expect(f.at(-1)).toBe(Math.round(64 * (3 + 12 / 16) / 4));
  const m = mhits.filter(h => h.tr === 0).map(h => h.p[16]);
  expect([m[0], m[16]]).toEqual([20, 40]);                   // MNM track 1 BASE: bar 0, bar 1
});
