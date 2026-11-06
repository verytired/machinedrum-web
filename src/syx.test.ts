// .syx round trip; the byte layout was checked once against waftlord/mddt's encoder (identical output for the demo)
import { test, expect } from 'vitest';
import { kitSyx, patternSyx, readSyx, enc7, dec7 } from './syx';
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
  expect(readSyx(new Uint8Array([...k, ...p]), back)).toEqual(['KIT', 'PATTERN']);
  expect([back.kit, back.trig, back.lock]).toEqual([st.kit, st.trig, st.lock]);
  p[100] ^= 1;
  expect(() => readSyx(p, back)).toThrow('checksum');
});
