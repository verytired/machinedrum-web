// .syx round trip; the byte layout was checked once against waftlord/mddt's encoder (identical output)
import { test, expect } from 'vitest';
import { kitSyx, patternSyx, parseSyx, applyKit, readPattern, readSong, stateSyx, romSlots, wav, enc7, dec7 } from './syx';
import { applyBar, songState, empty, hits, notes, FLTF, type Song } from './bars';
import { defaultState, trackFor } from './machines';
import { FACTORY } from './presets';
import { voice } from './voice';
import { enter, next, isPat } from './song';

test('7-bit packing round-trips', () => {
  const raw = Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff);
  expect(enc7(raw).length).toBe(74);
  expect(dec7(enc7(raw), 0, 64)).toEqual(raw);
});

// a kit with an EFM-BD bass, a bar with hits, locks, accents and slides
function fixture() {
  const st = defaultState(), b = empty();
  st.kit[12] = trackFor(8); st.fx = { echo: [16, 55, 62, 80, 0, 0, 0, 75], gate: [10, 25, 10, 58, 100, 0, 0, 70] };
  hits(b, 'BD', 'x...x...x...x...', 110); hits(b, 'CP', '....o..g....o...', 90, i => ({ [FLTF]: 40 + i }));
  notes(b, 'M1', 'E1 - E2^ ~G1 - E1 G1 - ~A1 - E1 - - D2^ E2 -', 30, 200, 60, 45);
  applyBar(st, b);
  return { st, d: { fx: st.fx } };
}

test('kit + pattern .syx: right sizes, and they read back to the same state', () => {
  const { st, d } = fixture();
  const k = kitSyx(st), p = patternSyx(st, 0.2, 5);
  expect([k.length, p.length, k[6], p[6], k.at(-1), p.at(-1)]).toEqual([1233, 2763, 0x52, 0x67, 0xf7, 0xf7]);
  const back = defaultState(); back.fx = d.fx;
  const dump = parseSyx(new Uint8Array([...k, ...p]));
  applyKit(dump.kits[0], back); Object.assign(back, readPattern(dump.pats[0]));
  expect(dump.pats[0][9]).toBe(5); expect(back.swing).toBeCloseTo(0.2, 4);
  expect([back.kit, back.trig, back.lock]).toEqual([st.kit, st.trig, st.lock]);
  p[100] ^= 1;
  expect(() => parseSyx(p)).toThrow('checksum');
});

test('SDS sample (16-bit) decodes and becomes a WAV', () => {
  const words = [0x8000, 0xffff, 0x0000, 0xc000];                      // 0, ~1, -1, 0.5 in offset binary
  const data = words.flatMap(w => [w >> 9 & 0x7f, w >> 2 & 0x7f, w << 5 & 0x60]);
  const hdr = [0xf0, 0x7e, 0, 1, 2, 0, 16, 0x13, 0x31, 0x01, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xf7]; // slot 2, 22675 ns, 4 words
  const pkt = [0xf0, 0x7e, 0, 2, 0, ...data, ...Array(120 - data.length).fill(0), 0, 0xf7];
  const s = parseSyx(new Uint8Array([...hdr, ...pkt])).samples[0];
  expect([s.slot, s.rate, s.d.length]).toEqual([2, 44101, 4]);
  expect(Array.from(s.d).map(x => Math.round(x * 100) / 100)).toEqual([0, 1, -1, 0.5]);
  expect(wav(s).byteLength).toBe(44 + 8);
});

test.skipIf(!FACTORY.length)('a factory song as .syx (kit, patterns, song, voice samples) reads back to the same song', () => {
  const song: Song = FACTORY[0](), st = songState(song), rom = romSlots(st);
  const smp = st.kit.map((_, tr) => rom[tr] >= 0 ? { slot: 0, rate: 44100, d: voice(['HEY', 'HO', 'YEAH'][rom[tr]] ?? 'HEY', 44100, () => 0.5) } : undefined);
  const d = parseSyx(stateSyx(st, smp));
  expect([d.kits.length, d.pats.length, d.songs.length, d.samples.map(s => s.slot)]).toEqual([1, st.pats.filter(Boolean).length, 1, [0, 1, 2]]);
  const back = defaultState();
  applyKit(d.kits[0], back);
  for (const p of d.pats) { const { trig, lock, swing } = readPattern(p); back.pats[p[9]] = { trig, lock }; back.swing = swing; }
  back.song = readSong(d.songs[0]);
  expect(back.kit).toEqual(st.kit);
  expect(back.fx).toEqual(st.fx);
  expect(back.pats).toEqual(st.pats);
  expect(back.song).toEqual(st.song);
  expect(back.swing).toBeCloseTo(0.2, 4);
  expect(isPat(back.song[0]) && back.song[0].bpm).toBe(133);
  // played through song mode, the rows give the demo's bars in order
  const bars: unknown[] = [];
  for (let p = enter(back.song, 0); p && !('halt' in p); p = next(back.song, p)) bars.push(back.pats[(back.song[p.row] as { pat: number }).pat]);
  expect(bars).toEqual(song.bars.map(b => ({ trig: b.trig, lock: b.lock })));
  for (const [i, s] of d.samples.entries()) expect(Math.max(...s.d.map(Math.abs))).toBeCloseTo(Math.max(...smp.filter(Boolean)[i]!.d.map(Math.abs)), 3);
});
