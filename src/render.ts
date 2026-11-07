// Render the song to a WAV file, off line: the song is walked the way SONG mode plays it (rows, REP, LOOP / JUMP,
// per-row BPM, OF / LEN, mutes, swing), the TS engine renders the hits, and the same master effects and LEVEL run in
// an OfflineAudioContext; then the master end stage (master.ts, as live), the meter and a 24-bit WAV.
// Deterministic, no AudioWorklet involved.
import { MdEngine, NOUT, VOL } from './dsp/md';
import { MnmEngine, GATE, LEN } from './dsp/mnm';
import type { MState } from './mnm';
import { masterFx, clipOf } from './fx';
import { Limiter, measure, type Report } from './master';
import { stepParams, SLIDE, micro, TRACKS, type State } from './machines';
import { enter, next, type PatRow } from './song';

export const SR = 44100;
type Hit = { f: number; tr: number; m: number; p: number[]; s: number };
const mparams = (m: MState, pat: { lock: MState['lock'] }, tr: number, i: number) => { const p = m.kit[tr].p.slice(), l = pat.lock[tr][i]; if (l) for (const k in l) p[+k] = l[k]; return p; };

// The song's hits (frame, track, machine, params, slide) and its length in frames. ponytail: an endless LOOP stops at 20 min
// mnm: the MNM synth, following the MD's pattern slots (a slot without an MNM pattern keeps the current one)
export function songHits(st: State, mnm?: MState): { hits: Hit[]; mhits: Hit[]; frames: number } {
  const hits: Hit[] = [], mhits: Hit[] = [], max = 20 * 60 * SR;
  let t = 0, bpm = st.tempo, mp: { trig: boolean[][]; lock: MState['lock'] } | undefined = mnm; // its current pattern until a row switches it
  for (let p = enter(st.song, 0); p && !('halt' in p) && t < max; p = next(st.song, p)) {
    const r = st.song[p.row] as PatRow, pat = st.pats[r.pat];
    if (r.bpm) bpm = r.bpm;
    const step = 60 / bpm / 4;
    if (mnm?.pats?.[r.pat]) mp = mnm.pats[r.pat]!;
    for (let i = r.of; i < r.len; i++, t += step) {
      const f = Math.round((t + (i % 2 ? st.swing * step : 0)) * SR);
      if (mnm && mp) for (let tr = 0; tr < 6; tr++) if (mp.trig[tr][i]) {
        const p = mparams(mnm, mp, tr, i); p[GATE] = (p[LEN] + 1) / 8 * step; mhits.push({ f, tr, m: mnm.kit[tr].m, p, s: 0 });
      }
      if (!pat) continue;
      for (let tr = 0; tr < 16; tr++) if (pat.trig[tr][i] && !(r.mute >> tr & 1))
        hits.push({ f: f + Math.round(micro(pat.lock[tr][i]) * step * SR), tr, m: st.kit[tr].m, p: stepParams({ ...st, ...pat }, tr, i), s: pat.lock[tr][i]?.[SLIDE] ? 1 : 0 });
    }
  }
  hits.sort((a, b) => a.f - b.f);                          // microtiming can move a hit before the step's others
  if (mnm) { for (const h of hits) if (h.tr === 0) mhits.push({ f: h.f, tr: -1, m: 0, p: [], s: 0 }); mhits.sort((a, b) => a.f - b.f); } // the MNM's duck key
  return { hits, mhits, frames: Math.round(t * SR) };
}

// samples: the ROM tracks' audio at SR; level: the LEVEL knob (0-127). Returns a 24-bit stereo WAV and its meter report.
// stems: also each sounding track alone (dry, after VOL / PAN and the duck, before the master effects and limiter)
export async function renderWav(st: State, samples: (Float32Array | undefined)[], level: number, mnm?: MState, stems = false):
  Promise<{ wav: Blob; report: Report & { stems?: (Report & { name: string })[] }; stems?: { name: string; wav: Blob }[] }> {
  const song = songHits(st, mnm);
  if (!song.frames) throw new Error('the song is empty');
  const n = song.frames + 3 * SR, md = () => { const e = new MdEngine(SR); samples.forEach((d, tr) => { if (d) e.sample(tr, d); }); return e; };
  const o = bus(n), mo = bus(n);
  drive(md(), song.hits, o, n);
  if (song.mhits.some(h => h.tr >= 0)) drive(new MnmEngine(SR), song.mhits, mo, n); // not just duck keys
  o.forEach((c, k) => mo[k].forEach((v, i) => { c[i] += v; })); // the MNM into the same buses

  const ctx = new OfflineAudioContext(2, n, SR);
  const src = (k: number) => { const buf = ctx.createBuffer(2, n, SR); buf.copyToChannel(o[k], 0); buf.copyToChannel(o[k + 1], 1);
    const s = new AudioBufferSourceNode(ctx, { buffer: buf }); s.start(); return s; };
  const out = new GainNode(ctx, { gain: level / 127 });
  out.connect(ctx.destination);
  const fx = masterFx(ctx, out);
  fx.set(st.fx, 60 / st.tempo / 4);
  src(0).connect(out); src(2).connect(fx.echoIn); src(4).connect(fx.gateIn);
  const r = await ctx.startRendering(), l = r.getChannelData(0), rr = r.getChannelData(1);
  const lim = new Limiter(SR);
  lim.setClip(clipOf(st.fx));
  lim.process(l, rr);
  const L = l.subarray(lim.lat), R = rr.subarray(lim.lat);    // drop the look-ahead delay
  const report: Report & { stems?: (Report & { name: string })[] } = measure(L, R, SR);
  if (!stems) return { wav: wav24(L, R), report };

  // one render per sounding track; the BD track stays in every MD stem at VOL 0 so the duck still fires
  const out2: { name: string; wav: Blob }[] = [], g = level / 127;
  report.stems = [];
  const one = (name: string, x: Float32Array[]) => {
    const a = x[0].map(v => v * g), b = x[1].map(v => v * g);
    report.stems!.push({ name, ...measure(a, b, SR) }); out2.push({ name, wav: wav24(a, b) });
  };
  for (let tr = 0; tr < 16; tr++) if (song.hits.some(h => h.tr === tr)) {
    const x = bus(n);
    drive(md(), song.hits.filter(h => h.tr === tr || h.tr === 0).map(h => h.tr === tr ? h : { ...h, p: Object.assign(h.p.slice(), { [VOL]: 0 }) }), x, n);
    one(TRACKS[tr], x);
  }
  for (let tr = 0; tr < 6; tr++) if (song.mhits.some(h => h.tr === tr)) {
    const x = bus(n);
    drive(new MnmEngine(SR), song.mhits.filter(h => h.tr === tr || h.tr < 0), x, n);
    one('MNM' + (tr + 1), x);
  }
  return { wav: wav24(L, R), report, stems: out2 };
}
const bus = (n: number) => Array.from({ length: NOUT }, () => new Float32Array(n));

// 128-frame blocks, split at hits, as md-processor.ts does
function drive(e: { trig(tr: number, m: number, p: number[], s: number): void; render(o: Float32Array[], off: number, n: number): void }, hits: Hit[], o: Float32Array[], n: number) {
  let h = 0;
  for (let b = 0; b < n; b += 128) {
    const len = Math.min(128, n - b);
    let pos = 0;
    while (h < hits.length && hits[h].f < b + len) {
      const at = hits[h].f - b;
      if (at > pos) { e.render(o, b + pos, at - pos); pos = at; }
      e.trig(hits[h].tr, hits[h].m, hits[h].p, hits[h].s); h++;
    }
    if (pos < len) e.render(o, b + pos, len - pos);
  }
}

function wav24(l: Float32Array, r: Float32Array): Blob {
  const n = l.length, v = new DataView(new ArrayBuffer(44 + n * 6));
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 6, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 6, true); v.setUint16(32, 6, true); v.setUint16(34, 24, true); str(36, 'data'); v.setUint32(40, n * 6, true);
  const put = (o: number, x: number) => { const s = Math.round(Math.max(-1, Math.min(1, x)) * 8388607); v.setUint8(o, s & 255); v.setUint8(o + 1, s >> 8 & 255); v.setUint8(o + 2, s >> 16 & 255); };
  for (let i = 0; i < n; i++) { put(44 + i * 6, l[i]); put(47 + i * 6, r[i]); }
  return new Blob([v.buffer], { type: 'audio/wav' });
}
