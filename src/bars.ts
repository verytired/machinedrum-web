// Building blocks for songs made of bars: track names, note -> PTCH, bar / lock / hit / note helpers, the Song type,
// songState() (a song -> patterns + a song-mode song) and applyBar(). The factory songs themselves live in
// src/factory/ (not in the public repo).
import { TRACKS, SLIDE, defaultState, type Track, type State } from './machines';
import type { Fx } from './fx';
import { isPat } from './song';
import type { MPat, MTrack } from './mnm';

export const T = Object.fromEntries(TRACKS.map((n, i) => [n, i])) as Record<string, number>;
export const FLTF = 12, FLTW = 13, FLTQ = 14, DIST = 16, VOL = 17, PAN = 18, DEL = 19, REV = 20;

export type Lock = Record<number, number>;
export interface Bar { trig: boolean[][]; lock: (Lock | null)[][] }

// PTCH for a note on a machine whose pitch spans lo-hi Hz over 0-127
const SEMI: Record<string, number> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
const hz = (n: string) => 440 * Math.pow(2, (SEMI[n[0]] + (n[1] === '#' ? 1 : 0) + (+n.at(-1)! - 4) * 12) / 12);
export const ptch = (n: string, lo: number, hi: number) => Math.max(0, Math.min(127, Math.round(127 * Math.log(hz(n) / lo) / Math.log(hi / lo))));

export const empty = (): Bar => ({ trig: TRACKS.map(() => Array(16).fill(false)), lock: TRACKS.map(() => Array(16).fill(null)) });
export const lock = (b: Bar, tr: string, i: number, l: Lock = {}) => { b.trig[T[tr]][i] = true; b.lock[T[tr]][i] = { ...b.lock[T[tr]][i], ...l }; };
// 'x' = hit, 'o' = accent, 'g' = ghost, '.' = rest
export const LV: Record<string, number> = { x: 0, o: 25, g: -45 };
export const hits = (b: Bar, tr: string, pat: string, vol: number, f: (i: number) => Lock = () => ({})) =>
  [...pat].forEach((c, i) => { if (c !== '.') lock(b, tr, i, { [VOL]: Math.min(127, vol + LV[c]), ...f(i) }); });
// note line: 16 tokens, '-' = rest, a trailing ^ = accent (brighter + louder), a leading ~ = slide (glides in from the note before)
export const notes = (b: Bar, tr: string, line: string, lo: number, hi: number, vol: number, cut: number) =>
  line.split(' ').forEach((n, i) => {
    if (n === '-') return;
    const a = n.endsWith('^'), sl = n.startsWith('~'), nt = n.replace(/[~^]/g, '');
    const l: Lock = { 0: ptch(nt, lo, hi), [VOL]: vol + (a ? 20 : 0), [FLTW]: cut + (a ? 15 : 0) };
    if (sl) l[SLIDE] = 1;
    lock(b, tr, i, l);
  });


// A song as song-mode data: each different bar is a pattern (A01 up), runs of the same bar are one row with REP
// mnm: the MNM synth's kit and its part for each bar (it follows the MD's pattern slots)
export interface Song { name: string; tempo: number; swing: number; kit: Track[]; fx: Fx; bars: Bar[]; voices: Record<string, string>; mnm?: { kit: MTrack[]; bars: MPat[] } }
export function songState(d: Song): State & { mnm?: { kit: MTrack[]; pats: (MPat | null)[] } } {
  const st: State & { mnm?: { kit: MTrack[]; pats: (MPat | null)[] } } = defaultState(), keys: string[] = [];
  if (d.mnm) st.mnm = { kit: d.mnm.kit, pats: Array(128).fill(null) };
  Object.assign(st, { kit: d.kit, fx: d.fx, tempo: d.tempo, swing: d.swing });
  d.bars.forEach((b, bi) => {
    const mb = d.mnm?.bars[bi], k = JSON.stringify([b, mb]);
    let n = keys.indexOf(k);
    if (n < 0) {
      n = keys.push(k) - 1; st.pats[n] = { trig: b.trig.map(r => r.slice()), lock: b.lock.map(r => r.map(l => l && { ...l })) };
      if (st.mnm && mb) st.mnm.pats[n] = structuredClone(mb);
    }
    const last = st.song.at(-1);
    if (isPat(last) && last.pat === n && last.rep < 64) last.rep++;
    else st.song.push({ pat: n, rep: 1, of: 0, len: 16, bpm: st.song.length ? null : d.tempo, mute: 0 });
  });
  st.song.push({ end: true });
  Object.assign(st, structuredClone(st.pats[0]!));
  return st;
}

// Put a bar into the playing state (copies, so p-lock edits during playback don't leak into the song)
export function applyBar(st: State, b: Bar) {
  st.trig = b.trig.map(r => r.slice());
  st.lock = b.lock.map(r => r.map(l => l && { ...l }));
}
