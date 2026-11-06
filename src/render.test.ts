// songHits: MICRO moves a trig off its step (triplets on the 16-step grid)
import { test, expect } from 'vitest';
import { songHits, SR } from './render';
import { defaultState } from './machines';
import { empty, trip, applyBar } from './bars';

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
