// Song mode, as on the Machinedrum (manual pp. 51-55): rows play patterns in order.
// A pattern row: PAT, REP (times), OF/LEN (start step / end step), BPM (null = keep the last one), MUT (track mask).
// A LOOP row's target decides what it is: an earlier row = LOOP (×times, 0 = ∞; loops nest), a later row = JUMP,
// itself = HALT (pauses; PLAY carries on below it). END, or running off the last row, stops the song.
export type PatRow = { pat: number; rep: number; of: number; len: number; bpm: number | null; mute: number };
export type LoopRow = { loop: number; times: number };
export type Row = PatRow | LoopRow | { end: true };
export const isPat = (r: Row | undefined): r is PatRow => !!r && 'pat' in r;

// row: the pattern row playing; left: passes of it still to play; loops: passes left per LOOP row
export interface Pos { row: number; left: number; loops: Record<number, number> }
export type Next = Pos | { halt: number } | null; // null = end

export const slotName = (n: number) => 'ABCDEFGH'[n >> 4] + String((n & 15) + 1).padStart(2, '0');

// Start playing at row r: skip over LOOP / JUMP rows to the first pattern row
export function enter(song: Row[], r: number, loops: Record<number, number> = {}): Next {
  loops = { ...loops };
  for (let guard = 0; guard < 4096; guard++) { // ponytail: a loop of loops with no pattern rows in it counts as the end
    const x = song[r];
    if (!x || 'end' in x) return null;
    if (isPat(x)) return { row: r, left: Math.max(1, x.rep), loops };
    if (x.loop === r) return { halt: r + 1 };
    if (x.loop > r || x.times === 0) { r = x.loop; continue; } // JUMP, or LOOP ∞
    const left = loops[r] ?? x.times - 1;                      // ×N = the section plays N times
    if (left > 0) { loops[r] = left - 1; r = x.loop; } else { delete loops[r]; r++; }
  }
  return null;
}

// The pass after p: the same row again, or on to the next one
// (a row deleted or turned into LOOP / END while it plays: carry on from where it was)
export const next = (song: Row[], p: Pos): Next => !isPat(song[p.row]) ? enter(song, p.row, p.loops) : p.left > 1 ? { ...p, left: p.left - 1 } : enter(song, p.row + 1, p.loops);
