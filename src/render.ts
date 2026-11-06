// Render the song to a WAV file, off line: the song is walked the way SONG mode plays it (rows, REP, LOOP / JUMP,
// per-row BPM, OF / LEN, mutes, swing), the TS engine renders the hits, and the same master effects, LEVEL and
// limiter run in an OfflineAudioContext. Deterministic, no AudioWorklet involved.
import { MdEngine, NOUT } from './dsp/md';
import { masterFx } from './fx';
import { stepParams, SLIDE, type State } from './machines';
import { enter, next, type PatRow } from './song';

export const SR = 44100;
type Hit = { f: number; tr: number; m: number; p: number[]; s: number };

// The song's hits (frame, track, machine, params, slide) and its length in frames. ponytail: an endless LOOP stops at 20 min
export function songHits(st: State): { hits: Hit[]; frames: number } {
  const hits: Hit[] = [], max = 20 * 60 * SR;
  let t = 0, bpm = st.tempo;
  for (let p = enter(st.song, 0); p && !('halt' in p) && t < max; p = next(st.song, p)) {
    const r = st.song[p.row] as PatRow, pat = st.pats[r.pat];
    if (r.bpm) bpm = r.bpm;
    const step = 60 / bpm / 4;
    for (let i = r.of; i < r.len; i++, t += step) {
      if (!pat) continue;
      const f = Math.round((t + (i % 2 ? st.swing * step : 0)) * SR);
      for (let tr = 0; tr < 16; tr++) if (pat.trig[tr][i] && !(r.mute >> tr & 1))
        hits.push({ f, tr, m: st.kit[tr].m, p: stepParams({ ...st, ...pat }, tr, i), s: pat.lock[tr][i]?.[SLIDE] ? 1 : 0 });
    }
  }
  return { hits, frames: Math.round(t * SR) };
}

// samples: the ROM tracks' audio at SR; level: the LEVEL knob (0-127). Returns a 16-bit stereo WAV
export async function renderWav(st: State, samples: (Float32Array | undefined)[], level: number): Promise<Blob> {
  const { hits, frames } = songHits(st);
  if (!frames) throw new Error('the song is empty');
  const n = frames + 3 * SR, e = new MdEngine(SR), o = Array.from({ length: NOUT }, () => new Float32Array(n));
  samples.forEach((d, tr) => { if (d) e.sample(tr, d); });
  let h = 0;
  for (let b = 0; b < n; b += 128) {                        // 128-frame blocks, split at hits, as md-processor.ts does
    const len = Math.min(128, n - b);
    let pos = 0;
    while (h < hits.length && hits[h].f < b + len) {
      const at = hits[h].f - b;
      if (at > pos) { e.render(o, b + pos, at - pos); pos = at; }
      e.trig(hits[h].tr, hits[h].m, hits[h].p, hits[h].s); h++;
    }
    if (pos < len) e.render(o, b + pos, len - pos);
  }
  const ctx = new OfflineAudioContext(2, n, SR);
  const src = (k: number) => { const buf = ctx.createBuffer(2, n, SR); buf.copyToChannel(o[k], 0); buf.copyToChannel(o[k + 1], 1);
    const s = new AudioBufferSourceNode(ctx, { buffer: buf }); s.start(); return s; };
  const out = new GainNode(ctx, { gain: level / 127 });
  const lim = new DynamicsCompressorNode(ctx, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
  out.connect(lim).connect(ctx.destination);
  const fx = masterFx(ctx, out);
  fx.set(st.fx, 60 / st.tempo / 4);
  src(0).connect(out); src(2).connect(fx.echoIn); src(4).connect(fx.gateIn);
  const r = await ctx.startRendering();
  return wav16(r);
}

function wav16(b: AudioBuffer): Blob {
  const n = b.length, v = new DataView(new ArrayBuffer(44 + n * 4)), l = b.getChannelData(0), r = b.getChannelData(1);
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, l[i])) * 32767, true);
    v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, r[i])) * 32767, true);
  }
  return new Blob([v.buffer], { type: 'audio/wav' });
}
