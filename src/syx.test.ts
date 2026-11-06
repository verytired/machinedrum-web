// .syx round trip; the byte layout was checked once against waftlord/mddt's encoder (identical output for the demo)
import { test, expect } from 'vitest';
import { kitSyx, patternSyx, parseSyx, applyKit, applyPattern, wav, enc7, dec7 } from './syx';
import { demoSong, applyBar } from './demo';
import { defaultState } from './machines';

test('7-bit packing round-trips', () => {
  const raw = Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff);
  expect(enc7(raw).length).toBe(74);
  expect(dec7(enc7(raw), 0, 64)).toEqual(raw);
});

test('kit + pattern .syx: right sizes, and they read back to the same state', () => {
  const d = demoSong(), st = defaultState();
  st.kit = d.kit; st.fx = d.fx; applyBar(st, d.bars[30]);
  const k = kitSyx(st), p = patternSyx(st);
  expect([k.length, p.length, k[6], p[6], k.at(-1), p.at(-1)]).toEqual([1233, 2763, 0x52, 0x67, 0xf7, 0xf7]);
  const back = defaultState(); back.fx = d.fx;
  const dump = parseSyx(new Uint8Array([...k, ...p]));
  applyKit(dump.kits[0], back); applyPattern(dump.pats[0], back);
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
