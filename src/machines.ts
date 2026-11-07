// Machine table, kit/pattern state and the p-lock merge. Indices match src/dsp/md.ts
import { NPAR } from './dsp/md';
import { defaultFx, type Fx } from './fx';
import type { Row } from './song';

export interface Machine { name: string; labels: string[]; defs: number[] }
const M = (name: string, labels: string, defs: number[]): Machine => ({ name, labels: labels.split(' ').concat(Array(8).fill('')).slice(0, 8), defs: defs.concat(Array(8).fill(0)).slice(0, 8) });

export const MACHINES: Machine[] = [
  M('GND-SN', 'PTCH DEC RAMP RDEC', [40, 50, 0, 30]),
  M('GND-NS', 'DEC', [40]),
  M('GND-IM', '', []),
  M('TRX-BD', 'PTCH DEC RAMP RDEC STRT NOIS', [50, 60, 60, 40, 30, 10]),
  M('TRX-SD', 'PTCH DEC BUMP BENV SNAP TONE', [50, 40, 40, 30, 90, 70]),
  M('TRX-CH', 'PTCH DEC TONE', [64, 40, 60]),
  M('TRX-OH', 'PTCH DEC TONE', [64, 60, 60]),
  M('TRX-CP', 'CLPY DEC TONE', [70, 50, 64]),
  M('EFM-BD', 'PTCH DEC RAMP RDEC MOD MFRQ MDEC', [50, 60, 50, 40, 40, 40, 30]),
  M('EFM-SD', 'PTCH DEC NOIS NDEC MOD MFRQ MDEC HP', [50, 40, 80, 50, 40, 80, 30, 80]),
  M('EFM-CB', 'PTCH DEC MOD MFRQ MDEC', [60, 50, 50, 90, 50]),
  M('EFM-HH', 'PTCH DEC MOD MFRQ MDEC HP', [100, 30, 90, 110, 60, 80]),
  M('ROM', 'PTCH DEC STRT END', [64, 127, 0, 127]), // plays the WAV loaded into the track
];

// Encoder pages: SYNTH = the machine's 8, then the track chain (– = not implemented yet)
export const FX_LABELS = ['AMD', 'AMF', 'EQF', 'EQG', 'FLTF', 'FLTW', 'FLTQ', 'SRR'];
export const ROUTE_LABELS = ['DIST', 'VOL', 'PAN', 'DEL', 'REV', 'DUCK', '', '']; // DUCK: sidechain from the BD track (md.ts)
const TRACK_DEFS = [0, 64, 64, 64, 0, 127, 0, 0, 0, 100, 64, 0, 0, 0, 0, 0];

export const TRACKS = 'BD SD HT MT LT CP RS CB CH OH RC CC M1 M2 M3 M4'.split(' ');
const KIT_MACHINES = [3, 4, 8, 8, 8, 7, 2, 10, 5, 6, 11, 1, 0, 9, 11, 0];

export interface Track { m: number; p: number[] }
export interface Pat { trig: boolean[][]; lock: (Record<number, number> | null | undefined)[][] }
// trig / lock: the pattern being played and edited (pats[pat] is synced to it on save); pats: A01-H16, null = never used
// swing: delay of the odd 16ths, in steps (0-0.6)
// auto: song automation lanes (below)
export interface State extends Pat { kit: Track[]; tempo: number; swing: number; fx: Fx; pats: (Pat | null)[]; pat: number; song: Row[]; auto?: Lane[] }

// Song automation (not on the MD): a lane moves one param of one track along the song's timeline (song.ts barAt), in
// bars: [bar, value] points (a bar can be fractional, 16ths = 1/16), linear in between, held before the first and
// after the last. tr 0-15 = the MD tracks, 16-21 = the MNM's. It replaces the kit value at each hit, a p-lock on the
// step still wins. Song mode and EXP WAV only; not in a .syx.
// ponytail: params latch at the hit, so a long note doesn't sweep inside itself; per-block updates if pads need it
export interface Lane { tr: number; par: number; pts: [bar: number, v: number][] }
export function laneAt(pts: [number, number][], pos: number): number {
  if (pos <= pts[0][0]) return pts[0][1];
  for (let k = 1; k < pts.length; k++) if (pos < pts[k][0]) { const [a, va] = pts[k - 1], [b, vb] = pts[k]; return va + (vb - va) * (pos - a) / (b - a); }
  return pts[pts.length - 1][1];
}
export function applyAuto(auto: Lane[] | undefined, tr: number, pos: number, p: number[], lock?: Record<number, number> | null) {
  if (auto) for (const a of auto) if (a.tr === tr && a.pts.length && lock?.[a.par] === undefined) p[a.par] = Math.max(0, Math.min(127, Math.round(laneAt(a.pts, pos))));
}

export const trackFor = (m: number): Track => ({ m, p: MACHINES[m].defs.concat(TRACK_DEFS) });

export function defaultState(): State {
  const kit = KIT_MACHINES.map(trackFor);
  [kit[2], kit[3], kit[4]].forEach((t, i) => { t.p[0] = 90 - i * 15; t.p[1] = 45; t.p[4] = 10; }); // HT/MT/LT as FM toms
  const trig = TRACKS.map(() => Array<boolean>(16).fill(false));
  [0, 4, 8, 12].forEach(i => { trig[0][i] = true; trig[9][i + 2] = true; });
  [4, 12].forEach(i => { trig[1][i] = true; });
  [0, 2, 4, 6, 8, 10, 12, 14].forEach(i => { trig[8][i] = true; });
  return { kit, trig, lock: TRACKS.map(() => Array(16).fill(null)), tempo: 125, swing: 0, fx: defaultFx(), pats: Array(128).fill(null), pat: 0, song: [] };
}

// The kit's params with this step's p-locks on top
// a lock on SLIDE (beyond the 24 params) marks a slide trig: the note glides from the one before, no retrigger
export const SLIDE = 24;
// a lock on MICRO moves the trig off its step (microtiming): 64 = on the step, each unit 1/24 of a step either way.
// Triplets on the 16-step grid use it. Not on the MD, so .syx export drops it
export const MICRO = 25;
export const micro = (l: Record<number, number> | null | undefined) => l?.[MICRO] !== undefined ? (l[MICRO] - 64) / 24 : 0;
export function stepParams(s: State, tr: number, step: number): number[] {
  const p = s.kit[tr].p.slice(0, NPAR), l = s.lock[tr][step];
  if (l) for (const k in l) if (+k < NPAR) p[+k] = l[k];
  return p;
}
