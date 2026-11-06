// Machinedrum SysEx (.syx): kit dump (0x52), 32-step pattern dump (0x67), song dump (0x69) and Sample Dump Standard
// samples, byte layout as in waftlord/mddt
// (Apache-2.0), which is tested against the hardware. Track params 0-23 are the MD's own order, so they copy 1:1.
// Not carried: LFO settings, accent / slide, per-step swing, track levels. Tempo goes in the song's first row.
import { trackFor, type State, type Pat } from './machines';
import { isPat, type Row } from './song';

const HDR = [0xf0, 0x00, 0x20, 0x3c, 0x02, 0x00];
const KIT = 0x52, PAT = 0x67, SONG = 0x69, KIT_LEN = 1233, PAT_LEN = 2763;

// our machine index -> MD machine ID (ROM -> ROM-01)
const MD_ID = [1, 2, 3, 16, 17, 22, 23, 19, 32, 33, 37, 38, 128];
const ROM = MD_ID.length - 1;

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
function wrap(id: number, ver: number, rev: number, body: number[], total: number, pos = 0): Uint8Array<ArrayBuffer> {
  const d = new Uint8Array(total);
  d.set([...HDR, id, ver, rev, pos], 0); d.set(body, 10);
  const end = total - 5, sum = d.subarray(9, end).reduce((s, b) => s + b, 0) & 0x3fff, len = total - 10;
  d.set([sum >> 7, sum & 0x7f, len >> 7 & 0x7f, len & 0x7f, 0xf7], end);
  return d;
}

export function kitSyx(st: State, name = 'MD-WEB'): Uint8Array<ArrayBuffer> {
  const b: number[] = [...Array.from({ length: 16 }, (_, i) => name.charCodeAt(i) & 0x7f || 0)];
  for (const t of st.kit) b.push(...t.p.map(v => Math.max(0, Math.min(127, Math.round(v)))));
  b.push(...Array(16).fill(100));                                                    // track levels
  const rom = romSlots(st);
  b.push(...enc7(st.kit.flatMap((t, tr) => be32(t.m === ROM ? 128 + rom[tr] : MD_ID[t.m]))));  // models (tonal flag off)
  b.push(...enc7(Array.from({ length: 576 }, (_, i) => i % 36 === 0 ? i / 36 : 0)));  // LFOs: each on its own track, depth is LFOD
  const e = st.fx.echo, g = st.fx.gate;
  b.push(0, g[0], g[2], g[1], g[3], g[4], 127, g[7]);                               // reverb: PRED = ATCK, DEC, DAMP = HOLD (no MD equivalents), HP, LP, GATE on, LEV
  b.push(e[0], 0, 0, e[1], e[2], e[3], 0, e[7]);                                    // delay: TIME, FB, FILF, FILW, LEV
  b.push(0, 64, 127, 64, 64, 64, 64, 64, ...Array(8).fill(0));                       // flat EQ, dynamix mix 0
  b.push(...enc7(Array(32).fill(255)));                                              // no trig / mute groups
  return wrap(KIT, 64, 1, b, KIT_LEN);
}

// ROM tracks get ROM-01, ROM-02 ... in track order (-1 = not a ROM track)
export const romSlots = (st: State) => { let n = 0; return st.kit.map(t => t.m === ROM ? n++ : -1); };

// swing: delay of the odd 16ths in steps; the MD stores it as (swing % - 50) / 50 * 16384 on the odd steps
export function patternSyx(p: Pat, swing = 0, pos = 0): Uint8Array<ArrayBuffer> {
  const rows: [number, number][] = [];                                               // (track, param) per lock row, sorted
  for (let tr = 0; tr < 16; tr++) for (let k = 0; k < 24; k++) if (p.lock[tr].some(l => l?.[k] != null)) rows.push([tr, k]);
  if (rows.length > 64) throw new Error('more than 64 locked params');
  const mask = p.lock.map((_, tr) => rows.reduce((m, [t, k]) => t === tr ? m | 1 << k : m, 0) >>> 0);
  const mat = rows.flatMap(([tr, k]) => Array.from({ length: 32 }, (_, s) => p.lock[tr][s]?.[k] ?? 0xff)).concat(Array((64 - rows.length) * 32).fill(0xff));
  const b = [
    ...enc7(p.trig.flatMap(r => be32(r.reduce((m, on, i) => on ? m | 1 << i : m, 0) >>> 0))),
    ...enc7(mask.flatMap(be32)),
    ...enc7([0, 0, 0xaaaaaaaa, Math.round(swing * 16384)].flatMap(be32)),             // accent / slide masks, swing on odd steps, amount
    0, 16, 0, 0, 0, rows.length,                                                     // accent amount, length, tempo x1, scale, kit 1, lock rows
    ...enc7(mat.map(v => Math.round(v))),
    ...enc7(Array(204).fill(0)),                                                     // per-track accent / slide / swing
  ];
  return wrap(PAT, 3, 1, b, PAT_LEN, pos);
}

// Song rows, 10 bytes each (7-bit packed per row): PAT, 0, REP-1, LOOP target, MUTE hi / lo, BPM*24 hi / lo (FFFF = keep), OF, end step.
// LOOP / JUMP / HALT: PAT = FE, REP = times; END: PAT = FF. The tempo goes into the first row unless it has one.
export function songSyx(song: Row[], tempo: number, name = 'MD-WEB'): Uint8Array<ArrayBuffer> {
  const rows = song.findIndex(r => 'end' in r) >= 0 ? song.slice(0, song.findIndex(r => 'end' in r)) : song;
  const raw = rows.map((r, i) => {
    if (!isPat(r)) return 'loop' in r ? [0xfe, 0, r.times, r.loop, 0, 0, 0xff, 0xff, 0, 0] : [0xff, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0];
    const bpm = r.bpm ?? (i === 0 ? tempo : null), t = bpm ? Math.round(bpm) * 24 : 0xffff;
    return [r.pat, 0, r.rep - 1, 0, r.mute >> 8 & 0xff, r.mute & 0xff, t >> 8, t & 0xff, r.of, r.len];
  }).concat([[0xff, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0]]);
  const b = [...Array.from({ length: 16 }, (_, i) => name.charCodeAt(i) & 0x7f || 0), ...raw.flatMap(enc7)];
  return wrap(SONG, 2, 2, b, 10 + b.length + 5);
}

// Sample Dump Standard, 16-bit, no loop; sent open-loop (no handshake)
export function sdsSyx(slot: number, d: Float32Array, rate: number): Uint8Array<ArrayBuffer> {
  const n = d.length, per = Math.round(1e9 / rate), b7 = (v: number) => [v & 0x7f, v >> 7 & 0x7f, v >> 14 & 0x7f];
  const out = [0xf0, 0x7e, 0, 1, slot & 0x7f, slot >> 7 & 0x7f, 16, ...b7(per), ...b7(n), ...b7(0), ...b7(Math.max(0, n - 1)), 0x7f, 0xf7];
  for (let i = 0, pk = 0; i < n; i += 40, pk++) {
    const data = Array.from({ length: 40 }, (_, k) => { const w = i + k < n ? Math.round(Math.max(-1, Math.min(1, d[i + k])) * 32767) + 0x8000 : 0x8000; return [w >> 9 & 0x7f, w >> 2 & 0x7f, w << 5 & 0x60]; }).flat();
    const head = [0x7e, 0, 2, pk & 0x7f];
    out.push(0xf0, ...head, ...data, [...head, ...data].reduce((x, y) => x ^ y, 0) & 0x7f, 0xf7);
  }
  return new Uint8Array(out);
}

// Everything: the kit, every used pattern (by slot), the song, and the ROM tracks' samples (one per ROM-nn slot)
export function stateSyx(st: State, samples: (Sample | undefined)[]): Uint8Array<ArrayBuffer> {
  const rom = romSlots(st), parts = [kitSyx(st)];
  st.pats.forEach((p, n) => { const q = n === st.pat ? { trig: st.trig, lock: st.lock } : p; if (q && q.trig.some(r => r.some(Boolean))) parts.push(patternSyx(q, st.swing, n)); });
  if (st.song.length) parts.push(songSyx(st.song, st.tempo));
  samples.forEach((s, tr) => { if (s && rom[tr] >= 0) parts.push(sdsSyx(rom[tr], s.d, s.rate)); });
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  return out;
}

// ---- reading ----
// MD machines we don't have -> the nearest one we do (machine params keep the MD's values, so it is an approximation)
const NEAR: Record<number, number> = {
  18: 3, 20: 10, 21: 10, 24: 6, 25: 1, 26: 7, 27: 3, 28: 3,                  // TRX-XT RS CB CY MA CL XC B2
  34: 8, 35: 7, 36: 10, 39: 11,                                              // EFM-XT CP RS CY
  48: 3, 49: 4, 50: 8, 51: 8, 52: 7, 53: 10, 54: 10, 55: 5, 56: 6, 57: 6, 58: 6, // E12
  64: 3, 65: 4, 72: 5,                                                       // P-I BD SD HH
};
const romSlot = (id: number) => id >= 128 && id < 160 ? id - 128 : id >= 176 && id < 192 ? id - 144 : -1;

export interface Sample { slot: number; rate: number; d: Float32Array }
export interface Dump { kits: Uint8Array[]; pats: Uint8Array[]; songs: Uint8Array[]; samples: Sample[] }

// Split a .syx into MD kit / pattern dumps (checksummed) and Sample Dump Standard samples (16-bit)
export function parseSyx(bytes: Uint8Array): Dump {
  const out: Dump = { kits: [], pats: [], songs: [], samples: [] };
  let smp: { s: Sample; n: number } | undefined;
  for (let i = bytes.indexOf(0xf0); i >= 0; i = bytes.indexOf(0xf0, i + 1)) {
    const end = bytes.indexOf(0xf7, i); if (end < 0) break;
    const d = bytes.subarray(i, end + 1);
    if (d[1] === 0x7e && d[3] === 0x01 && d.length >= 21) {                   // SDS header
      const len = d[10] | d[11] << 7 | d[12] << 14, per = d[7] | d[8] << 7 | d[9] << 14;
      smp = d[6] === 16 && len > 0 && len <= 1 << 22 && per > 0 ? { s: { slot: d[4] | d[5] << 7, rate: Math.round(1e9 / per), d: new Float32Array(len) }, n: 0 } : undefined;
      if (smp) out.samples.push(smp.s);
    } else if (d[1] === 0x7e && d[3] === 0x02 && smp && d.length === 127) {     // SDS data: 40 words, 3 bytes each, left-justified, offset binary
      for (let k = 5; k + 2 < 125 && smp.n < smp.s.d.length; k += 3) smp.s.d[smp.n++] = ((d[k] << 9 | d[k + 1] << 2 | d[k + 2] >> 5) - 0x8000) / 0x8000;
    } else if (d.length >= 15 && HDR.every((h, k) => d[k] === h) && (d[6] === KIT || d[6] === PAT || d[6] === SONG)) {
      const sum = d.subarray(9, d.length - 5).reduce((s, b) => s + b, 0) & 0x3fff;
      if (sum !== (d[d.length - 5] << 7 | d[d.length - 4])) throw new Error('bad checksum');
      if (d[6] === KIT && d.length !== KIT_LEN) throw new Error('bad kit length');
      if (d[6] === PAT && d.length < PAT_LEN) throw new Error('bad pattern length');
      (d[6] === KIT ? out.kits : d[6] === PAT ? out.pats : out.songs).push(d);
    }
  }
  if (!out.kits.length && !out.pats.length && !out.songs.length && !out.samples.length) throw new Error('no MD kit, pattern or sample');
  return out;
}

export const patName = (p: Uint8Array) => 'ABCDEFGH'[p[9] >> 4] + String((p[9] & 15) + 1).padStart(2, '0');
export const kitName = (k: Uint8Array) => String.fromCharCode(...k.subarray(10, 26)).replace(/[\0\x7f][\s\S]*/, '');
export const patKit = (p: Uint8Array) => p[0xb5];
export const isEmpty = (p: Uint8Array) => dec7(p, 0x0a, 64).every(b => b === 0);

// Put a kit dump into st; returns the ROM slot used by each track (-1 = none)
export function applyKit(d: Uint8Array, st: State): number[] {
  const models = dec7(d, 0x1aa, 64), slots: number[] = [];
  for (let tr = 0; tr < 16; tr++) {
    const id = rd32(models, tr * 4) & 0xffff, p = Array.from(d.subarray(0x1a + tr * 24, 0x1a + tr * 24 + 24));
    const m = MD_ID.indexOf(id) >= 0 ? MD_ID.indexOf(id) : romSlot(id) >= 0 ? ROM : NEAR[id] ?? -1;
    st.kit[tr] = m < 0 ? { ...trackFor(ROM), p: [...trackFor(ROM).p.slice(0, 8), ...p.slice(8)] } : { m, p }; // unknown: empty ROM, keep the FX
    slots.push(romSlot(id));
  }
  const r = d.subarray(0x487), e = d.subarray(0x48f);
  st.fx = { echo: [e[0], e[3], e[4], e[5], 0, 0, 0, e[7]], gate: [r[1], r[3], r[2], r[4], r[5], 0, 0, r[7]] };
  return slots;
}

// A pattern dump as one of our patterns (first 16 steps of a 32 / 64-step pattern) plus its swing;
// lock rows follow the lock masks in (track, param) order
export function readPattern(d: Uint8Array): Pat & { swing: number } {
  const trig = dec7(d, 0x0a, 64), mask = dec7(d, 0x54, 64), acc = dec7(d, 0x9e, 16), mat = dec7(d, 0xb7, 2048);
  const p: Pat = { trig: [], lock: [] };
  let row = 0;
  for (let tr = 0; tr < 16; tr++) {
    const tm = rd32(trig, tr * 4), lm = rd32(mask, tr * 4);
    p.trig[tr] = Array.from({ length: 16 }, (_, s) => !!(tm >>> s & 1));
    p.lock[tr] = Array(16).fill(null);
    for (let k = 0; k < 24; k++) if (lm >>> k & 1 && row < 64) {
      for (let s = 0; s < 16; s++) { const v = mat[row * 32 + s]; if (v <= 127) p.lock[tr][s] = { ...p.lock[tr][s], [k]: v }; }
      row++;
    }
  }
  const sw = rd32(acc, 12);
  return { ...p, swing: rd32(acc, 8) && sw <= 16384 ? Math.min(0.6, sw / 16384) : 0 };
}

// A song dump as our song rows (OF / end step cut to 16 steps)
export function readSong(d: Uint8Array): Row[] {
  const rows: Row[] = [];
  for (let o = 26; o + 12 <= d.length - 5 && rows.length < 256; o += 12) {
    const r = dec7(d, o, 10);
    if (r[0] === 0xff) break;
    if (r[0] === 0xfe) { rows.push({ loop: r[3], times: Math.min(64, r[2]) }); continue; }
    const t = r[6] << 8 | r[7], of = Math.min(15, r[8]), end = Math.min(16, r[9] || 16);
    rows.push({ pat: r[0] & 0x7f, rep: Math.min(64, r[2] + 1), of, len: Math.max(of + 1, end), bpm: t === 0xffff || t < 720 ? null : Math.min(300, Math.round(t / 24)), mute: (r[4] << 8 | r[5]) & 0xffff });
  }
  // LOOP targets past the last row: END there
  return rows.map((r): Row => 'loop' in r && r.loop >= rows.length ? { end: true } : r).concat({ end: true });
}

// mono 16-bit WAV, so a sample goes through the same decode / IndexedDB path as a loaded file
export function wav(s: Sample): ArrayBuffer {
  const n = s.d.length, v = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, s.rate, true); v.setUint32(28, s.rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  s.d.forEach((x, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 32767, true));
  return v.buffer;
}
