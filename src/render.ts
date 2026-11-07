// Render the song to a WAV file, off line: the song is walked the way SONG mode plays it (rows, REP, LOOP / JUMP,
// per-row BPM, OF / LEN, mutes, swing), the engines render the hits (the MD on its WASM build when given one, as
// live), and the same master effects and LEVEL run in an OfflineAudioContext; then the master end stage (master.ts,
// as live), the meter and a 24-bit WAV. Deterministic, no AudioWorklet involved.
import { MdEngine, NOUT } from './dsp/md';
import { wasmEngine, type Engine } from './dsp/md-wasm';
import { MnmEngine, GATE, LEN } from './dsp/mnm';
import type { MState } from './mnm';
import { masterFx, dynVals } from './fx';
import { Limiter, Meter, type Report } from './master';
import { stepParams, applyAuto, SLIDE, micro, TRACKS, type State } from './machines';
import { enter, next, barAt, type PatRow } from './song';

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
    const b0 = barAt(st.song, p);
    for (let i = r.of; i < r.len; i++, t += step) {
      const f = Math.round((t + (i % 2 ? st.swing * step : 0)) * SR);
      if (mnm && mp) for (let tr = 0; tr < 6; tr++) if (mp.trig[tr][i]) {
        const p = mparams(mnm, mp, tr, i); applyAuto(st.auto, 16 + tr, b0 + i / 16, p, mp.lock[tr][i], mnm.kit[tr].p); p[GATE] = (p[LEN] + 1) / 8 * step; mhits.push({ f, tr, m: mnm.kit[tr].m, p, s: 0 });
      }
      if (!pat) continue;
      for (let tr = 0; tr < 16; tr++) if (pat.trig[tr][i] && !(r.mute >> tr & 1))
        {
          const q = stepParams({ ...st, ...pat }, tr, i);
          applyAuto(st.auto, tr, b0 + i / 16, q, pat.lock[tr][i], st.kit[tr].p);
          hits.push({ f: f + Math.round(micro(pat.lock[tr][i]) * step * SR), tr, m: st.kit[tr].m, p: q, s: pat.lock[tr][i]?.[SLIDE] ? 1 : 0 });
        }
    }
  }
  hits.sort((a, b) => a.f - b.f);                          // microtiming can move a hit before the step's others
  if (mnm) { for (const h of hits) if (h.tr === 0) mhits.push({ f: h.f, tr: -1, m: 0, p: [], s: 0 }); mhits.sort((a, b) => a.f - b.f); } // the MNM's duck key
  return { hits, mhits, frames: Math.round(t * SR) };
}

// samples: the ROM tracks' audio at SR; level: the LEVEL knob (0-127); wasm: the compiled md.wasm (null = TS engine).
// Returns a 24-bit stereo WAV and its meter report.
// stems: also each sounding track alone (dry, after VOL / PAN and the duck, before the master effects and limiter),
// tapped from the same pass (TS engines: the WASM build has no tap) and metered / written block by block
export async function renderWav(st: State, samples: (Float32Array | undefined)[], level: number, mnm?: MState, stems = false, wasm: WebAssembly.Module | null = null):
  Promise<{ wav: Blob; report: Report & { stems?: (Report & { name: string })[] }; stems?: { name: string; wav: Blob }[] }> {
  const song = songHits(st, mnm);
  if (!song.frames) throw new Error('the song is empty');
  const n = song.frames + 3 * SR, g = level / 127, o = bus(n), mo = bus(n);
  const sts: { name: string; meter: Meter; wav: Wav }[] = [];
  const tapped = (e: MdEngine | MnmEngine, hits: Hit[], names: string[]) => {
    if (!stems) return undefined;
    const tap = e.tap = names.flatMap(() => [new Float32Array(128), new Float32Array(128)]);
    const s = names.map((name, tr) => hits.some(h => h.tr === tr) ? { name, meter: new Meter(SR, false), wav: new Wav(n) } : null);
    s.forEach(x => { if (x) sts.push(x); });
    return (b: number, len: number) => s.forEach((x, tr) => {
      if (!x) return;
      const L = tap[2 * tr], R = tap[2 * tr + 1];
      for (let i = 0; i < len; i++) { L[i] *= g; R[i] *= g; }
      x.meter.push(L, R, 0, len); x.wav.put(b, L, R, len);
    });
  };
  let e: Engine | MdEngine = new MdEngine(SR);
  if (wasm && !stems) try { e = wasmEngine(wasm, SR); } catch { /* the TS twin */ }
  samples.forEach((d, tr) => { if (d) e.sample(tr, d); });
  drive(e, song.hits, o, n, e instanceof MdEngine ? tapped(e, song.hits, TRACKS) : undefined);
  if (song.mhits.some(h => h.tr >= 0)) { const m = new MnmEngine(SR); drive(m, song.mhits, mo, n, tapped(m, song.mhits, [1, 2, 3, 4, 5, 6].map(k => 'MNM' + k))); } // not just duck keys
  o.forEach((c, k) => mo[k].forEach((v, i) => { c[i] += v; })); // the MNM into the same buses

  const ctx = new OfflineAudioContext(2, n, SR);
  const src = (k: number) => { const buf = ctx.createBuffer(2, n, SR); buf.copyToChannel(o[k], 0); buf.copyToChannel(o[k + 1], 1);
    const s = new AudioBufferSourceNode(ctx, { buffer: buf }); s.start(); return s; };
  const out = new GainNode(ctx, { gain: g });
  out.connect(ctx.destination);
  const fx = masterFx(ctx, out);
  fx.set(st.fx, 60 / st.tempo / 4);
  src(0).connect(out); src(2).connect(fx.echoIn); src(4).connect(fx.gateIn);
  const r = await ctx.startRendering(), l = r.getChannelData(0), rr = r.getChannelData(1);
  const lim = new Limiter(SR);
  lim.set(...dynVals(st.fx));
  lim.process(l, rr);
  const L = l.subarray(lim.lat), R = rr.subarray(lim.lat);    // drop the look-ahead delay
  const m = new Meter(SR); m.push(L, R);
  const report: Report & { stems?: (Report & { name: string })[] } = m.report(), wav = new Wav(L.length);
  wav.put(0, L, R, L.length);
  if (!stems) return { wav: wav.blob(), report };
  report.stems = sts.map(x => ({ name: x.name, ...x.meter.report() }));
  return { wav: wav.blob(), report, stems: sts.map(x => ({ name: x.name, wav: x.wav.blob() })) };
}
const bus = (n: number) => Array.from({ length: NOUT }, () => new Float32Array(n));

// 128-frame blocks, split at hits, as md-processor.ts does; block(b, len) after each one
function drive(e: { trig(tr: number, m: number, p: number[], s: number): void; render(o: Float32Array[], off: number, n: number): void }, hits: Hit[], o: Float32Array[], n: number, block?: (b: number, len: number) => void) {
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
    block?.(b, len);
  }
}

// a 24-bit stereo WAV of n frames, filled by put() in any order
class Wav {
  private v: DataView;
  constructor(n: number) {
    const v = this.v = new DataView(new ArrayBuffer(44 + n * 6));
    const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 6, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 6, true); v.setUint16(32, 6, true); v.setUint16(34, 24, true); str(36, 'data'); v.setUint32(40, n * 6, true);
  }
  put(at: number, l: Float32Array, r: Float32Array, len: number) {
    const v = this.v, w = (o: number, x: number) => { const s = Math.round(Math.max(-1, Math.min(1, x)) * 8388607); v.setUint8(o, s & 255); v.setUint8(o + 1, s >> 8 & 255); v.setUint8(o + 2, s >> 16 & 255); };
    for (let i = 0; i < len; i++) { w(44 + (at + i) * 6, l[i]); w(47 + (at + i) * 6, r[i]); }
  }
  blob() { return new Blob([this.v.buffer as ArrayBuffer], { type: 'audio/wav' }); }
}
