// Machinedrum SysEx (.syx): kit dump (0x52) and 32-step pattern dump (0x67), byte layout as in waftlord/mddt
// (Apache-2.0), which is tested against the hardware. Track params 0-23 are the MD's own order, so they copy 1:1.
// Not carried: LFO settings, accent/slide/swing, track levels, tempo (the MD keeps it in the global/song).
import { trackFor, type State } from './machines';

const HDR = [0xf0, 0x00, 0x20, 0x3c, 0x02, 0x00];
const KIT = 0x52, PAT = 0x67, KIT_LEN = 1233, PAT_LEN = 2763;

// our machine index -> MD machine ID (ROM -> ROM-01)
const MD_ID = [1, 2, 3, 16, 17, 22, 23, 19, 32, 33, 37, 38, 128];
const ROM = MD_ID.length - 1;
const ours = (id: number) => { const i = MD_ID.indexOf(id); return i >= 0 ? i : (id >= 128 && id < 160) || (id >= 176 && id < 192) ? ROM : -1; };

// 7 bytes per group, led by a byte holding their top bits (bit 6-k = byte k)
export function enc7(raw: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < raw.length; i += 7) {
    const g = Array.from({ length: Math.min(7, raw.length - i) }, (_, k) => raw[i + k] & 0xff);
    out.push(g.reduce((h, b, k) => h | (b >> 7) << (6 - k), 0), ...g.map(b => b & 0x7f));
  }
  return out;
}
export function dec7(d: ArrayLike<number>, off: number, n: number): number[] {
  const out: number[] = [];
  for (let i = off; out.length < n; i += 8) for (let k = 0; k < 7 && out.length < n; k++) out.push(d[i + 1 + k] | ((d[i] >> (6 - k)) & 1) << 7);
  return out;
}
const be32 = (v: number) => [v >>> 24 & 0xff, v >>> 16 & 0xff, v >>> 8 & 0xff, v & 0xff];
const rd32 = (a: number[], o: number) => (a[o] << 24 | a[o + 1] << 16 | a[o + 2] << 8 | a[o + 3]) >>> 0;

// header, body from offset 7, then checksum (sum of bytes 9.. & 0x3fff), length (total - 10), F7
function wrap(id: number, ver: number, rev: number, body: number[], total: number): Uint8Array<ArrayBuffer> {
  const d = new Uint8Array(total);
  d.set([...HDR, id, ver, rev, 0], 0); d.set(body, 10);
  const end = total - 5, sum = d.subarray(9, end).reduce((s, b) => s + b, 0) & 0x3fff, len = total - 10;
  d.set([sum >> 7, sum & 0x7f, len >> 7 & 0x7f, len & 0x7f, 0xf7], end);
  return d;
}

export function kitSyx(st: State, name = 'MD-WEB'): Uint8Array<ArrayBuffer> {
  const b: number[] = [...Array.from({ length: 16 }, (_, i) => name.charCodeAt(i) & 0x7f || 0)];
  for (const t of st.kit) b.push(...t.p.map(v => Math.max(0, Math.min(127, Math.round(v)))));
  b.push(...Array(16).fill(100));                                                    // track levels
  b.push(...enc7(st.kit.flatMap(t => be32(MD_ID[t.m]))));                            // models (tonal flag off)
  b.push(...enc7(Array.from({ length: 576 }, (_, i) => i % 36 === 0 ? i / 36 : 0)));  // LFOs: each on its own track, depth is LFOD
  const e = st.fx.echo, g = st.fx.gate;
  b.push(0, 0, g[2], 0, g[3], g[4], 127, g[7]);                                     // reverb: DEC, HP, LP, GATE on, LEV
  b.push(e[0], 0, 0, e[1], e[2], e[3], 0, e[7]);                                    // delay: TIME, FB, FILF, FILW, LEV
  b.push(0, 64, 127, 64, 64, 64, 64, 64, ...Array(8).fill(0));                       // flat EQ, dynamix mix 0
  b.push(...enc7(Array(32).fill(255)));                                              // no trig / mute groups
  return wrap(KIT, 64, 1, b, KIT_LEN);
}

export function patternSyx(st: State): Uint8Array<ArrayBuffer> {
  const rows: [number, number][] = [];                                               // (track, param) per lock row, sorted
  for (let tr = 0; tr < 16; tr++) for (let p = 0; p < 24; p++) if (st.lock[tr].some(l => l?.[p] != null)) rows.push([tr, p]);
  if (rows.length > 64) throw new Error('more than 64 locked params');
  const mask = st.kit.map((_, tr) => rows.reduce((m, [t, p]) => t === tr ? m | 1 << p : m, 0) >>> 0);
  const mat = rows.flatMap(([tr, p]) => Array.from({ length: 32 }, (_, s) => st.lock[tr][s]?.[p] ?? 0xff)).concat(Array((64 - rows.length) * 32).fill(0xff));
  const b = [
    ...enc7(st.trig.flatMap(r => be32(r.reduce((m, on, i) => on ? m | 1 << i : m, 0) >>> 0))),
    ...enc7(mask.flatMap(be32)),
    ...enc7(Array(16).fill(0)),                                                      // accent / slide / swing masks, swing amount
    0, 16, 0, 0, 0, rows.length,                                                     // accent amount, length, tempo x1, scale, kit 1, lock rows
    ...enc7(mat.map(v => Math.round(v))),
    ...enc7(Array(204).fill(0)),                                                     // per-track accent / slide / swing
  ];
  return wrap(PAT, 3, 1, b, PAT_LEN);
}

// Read every kit / pattern message in a .syx into st; returns what was read. 32- and 64-step patterns: first 16 steps.
export function readSyx(bytes: Uint8Array, st: State): string[] {
  const got: string[] = [];
  for (let i = bytes.indexOf(0xf0); i >= 0; i = bytes.indexOf(0xf0, i + 1)) {
    const end = bytes.indexOf(0xf7, i); if (end < 0) break;
    const d = bytes.subarray(i, end + 1);
    if (d.length < 15 || HDR.some((h, k) => d[k] !== h) || (d[6] !== KIT && d[6] !== PAT)) continue;
    const sum = d.subarray(9, d.length - 5).reduce((s, b) => s + b, 0) & 0x3fff;
    if (sum !== (d[d.length - 5] << 7 | d[d.length - 4])) throw new Error('bad checksum');
    if (d[6] === KIT) {
      if (d.length !== KIT_LEN) throw new Error('bad kit length');
      const models = dec7(d, 0x1aa, 64);
      for (let tr = 0; tr < 16; tr++) {
        const m = ours(rd32(models, tr * 4) & 0xffff);
        const p = Array.from(d.subarray(0x1a + tr * 24, 0x1a + tr * 24 + 24));
        st.kit[tr] = m < 0 ? { ...trackFor(ROM), p: [...trackFor(ROM).p.slice(0, 8), ...p.slice(8)] } : { m, p };  // unknown machine: empty ROM, keep the FX
      }
      const r = d.subarray(0x487), e = d.subarray(0x48f);
      st.fx = { echo: [e[0], e[3], e[4], e[5], 0, 0, 0, e[7]], gate: [st.fx.gate[0], st.fx.gate[1], r[2], r[4], r[5], 0, 0, r[7]] };
      got.push('KIT');
    } else {
      if (d.length < PAT_LEN) throw new Error('bad pattern length');
      const trig = dec7(d, 0x0a, 64), mask = dec7(d, 0x54, 64), mat = dec7(d, 0xb7, 2048);
      let row = 0;
      for (let tr = 0; tr < 16; tr++) {
        const tm = rd32(trig, tr * 4), lm = rd32(mask, tr * 4);
        st.trig[tr] = Array.from({ length: 16 }, (_, s) => !!(tm >>> s & 1));
        st.lock[tr] = Array(16).fill(null);
        for (let p = 0; p < 24; p++) if (lm >>> p & 1 && row < 64) {
          for (let s = 0; s < 16; s++) { const v = mat[row * 32 + s]; if (v <= 127) st.lock[tr][s] = { ...st.lock[tr][s], [p]: v }; }
          row++;
        }
      }
      got.push('PATTERN');
    }
  }
  if (!got.length) throw new Error('no MD kit or pattern');
  return got;
}
