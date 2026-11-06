import { expect, test } from 'vitest';
import { enter, next, slotName, type Row, type Next, type Pos } from './song';

const P = (pat: number, rep = 1): Row => ({ pat, rep, of: 0, len: 16, bpm: null, mute: 0 });
// the patterns a song plays, pass by pass (stops at a halt, the end, or n passes)
function play(song: Row[], n = 40, from = 0) {
  const out: (number | string)[] = [];
  for (let p: Next = enter(song, from); p && out.length < n; p = 'halt' in p ? null : next(song, p)) out.push('halt' in p ? 'H' + p.halt : slotName((song[p.row] as { pat: number }).pat));
  return out.join(' ');
}

test('rows play REP times, END and the last row stop', () => {
  expect(play([P(0, 2), P(1), { end: true }, P(2)])).toBe('A01 A01 A02');
  expect(play([P(0), P(17)])).toBe('A01 B02');
  expect(play([])).toBe('');
});
test('LOOP ×N plays the section N times, loops nest, ∞ never ends', () => {
  expect(play([P(0), P(1), { loop: 1, times: 3 }, P(2)])).toBe('A01 A02 A02 A02 A03');
  expect(play([P(0), P(1), { loop: 1, times: 2 }, { loop: 0, times: 2 }])).toBe('A01 A02 A02 A01 A02 A02');
  expect(play([P(0), { loop: 0, times: 0 }], 5)).toBe('A01 A01 A01 A01 A01');
});
test('JUMP skips ahead, HALT pauses and resumes below itself', () => {
  expect(play([P(0), { loop: 3, times: 0 }, P(1), P(2)])).toBe('A01 A03');
  expect(play([P(0), { loop: 1, times: 0 }, P(1)])).toBe('A01 H2');
  expect(play([P(0), { loop: 1, times: 0 }, P(1)], 40, 2)).toBe('A02');
  expect(play([{ loop: 1, times: 0 }, { loop: 0, times: 0 }])).toBe(''); // loops with nothing in them: treated as the end
});
test('a row edited away while it plays: the song carries on from there', () => {
  const p = enter([P(0, 4), P(1)], 0) as Pos;
  expect(next([{ loop: 0, times: 0 }, P(1)], p)).toEqual({ halt: 1 }); // turned into a LOOP to itself = HALT
  expect(next([{ loop: 2, times: 0 }, P(1), P(2)], p)).toMatchObject({ row: 2 }); // into a JUMP
  expect(next([{ end: true }], p)).toBe(null);
  expect(next([], p)).toBe(null); // deleted
});
