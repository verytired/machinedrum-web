import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MdEngine, NPAR, NOUT, VOL, FLTW, FLTQ, DIST, SRR, AMD, DEL, REV } from './md';
import { MACHINES, SLIDE, trackFor, defaultState, stepParams } from '../machines';
import { applyBar, songState } from '../bars';
import { FACTORY } from '../presets';
import { stateSyx } from '../syx';
import { songHits } from '../render';
import { MnmEngine } from './mnm';
import { gateIR } from '../fx';
import { voice, VOICES } from '../voice';
import { TRACKS } from '../machines';

const SR = 48000;
// test sample for the ROM machine: 0.3 s of a decaying 220 Hz sine with some 2nd harmonic
const SMP = Float32Array.from({ length: SR * 0.3 }, (_, i) => (Math.sin(i / SR * 2 * Math.PI * 220) + 0.3 * Math.sin(i / SR * 2 * Math.PI * 440)) * Math.exp(-i / SR * 8) * 0.7);
interface Engine { trig(tr: number, m: number, p: number[], s?: number): void; render(o: Float32Array[], off: number, n: number): void }

function wasmEngine(): Engine {
  const x = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL('./md.wasm', import.meta.url))), {}).exports as unknown as {
    memory: WebAssembly.Memory; init(sr: number): void; outPtr(): number; parPtr(): number; trig(tr: number, m: number, s: number): void; render(n: number): void;
    smpPtr(tr: number): number; smpLen(tr: number, n: number): void;
  };
  x.init(SR);
  for (let tr = 0; tr < 16; tr++) { new Float32Array(x.memory.buffer, x.smpPtr(tr), SMP.length).set(SMP); x.smpLen(tr, SMP.length); }
  const buf = new Float32Array(x.memory.buffer, x.outPtr(), 128 * NOUT), par = new Float64Array(x.memory.buffer, x.parPtr(), NPAR);
  return {
    trig(tr, m, p, s = 0) { par.set(p); x.trig(tr, m, s); },
    render(o, off, n) { x.render(n); for (let k = 0; k < NOUT; k++) o[k].set(buf.subarray(k * 128, k * 128 + n), off); },
  };
}

type Hit = [frame: number, tr: number, m: number, p: number[], slide?: number];

// Render in 128-frame blocks, split at hits like md-processor.ts
function drive(e: Engine, hits: Hit[], frames: number) {
  const o = Array.from({ length: NOUT }, () => new Float32Array(frames));
  let h = 0;
  for (let b = 0; b < frames; b += 128) {
    const n = Math.min(128, frames - b);
    let pos = 0;
    while (h < hits.length && hits[h][0] < b + n) {
      const at = hits[h][0] - b;
      if (at > pos) { e.render(o, b + pos, at - pos); pos = at; }
      e.trig(hits[h][1], hits[h][2], hits[h][3], hits[h][4]); h++;
    }
    if (pos < n) e.render(o, b + pos, n - pos);
  }
  return o;
}
const peak = (a: Float32Array, from = 0, to = a.length) => { let p = 0; for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i])); return p; };
const js = () => { const e = new MdEngine(SR); for (let tr = 0; tr < 16; tr++) e.sample(tr, SMP); return e; };

describe('MD engine', () => {
  it('WASM matches the TS engine, every machine plus locked track params', () => {
    const s = SR / 8, hits: Hit[] = [];
    MACHINES.forEach((_, m) => hits.push([m * s, m, m, trackFor(m).p]));
    const locked = trackFor(8).p; locked[FLTW] = 60; locked[DIST] = 80; locked[SRR] = 20; locked[AMD] = 70; locked[DEL] = 90; locked[REV] = 50;
    hits.push([12 * s + 5, 12, 8, locked]);
    hits.push([13 * s, 7, 7, trackFor(7).p]); // retrigger mid-tail
    const rev = trackFor(12).p; rev[0] = 71; rev[2] = 100; rev[3] = 10; hits.push([14 * s + 3, 13, 12, rev]); // ROM reversed, pitched up
    // a 303-style slide on EFM-BD: three notes, the 2nd and 3rd glide in without a retrigger
    const acid = trackFor(8).p; acid[1] = 90; acid[FLTQ] = 100;
    [[60, 0], [80, 1], [40, 1]].forEach(([pt, sl], k) => hits.push([15 * s + k * s / 4, 14, 8, [pt, ...acid.slice(1)], sl]));
    const n = 17 * s, ao = drive(js(), hits, n), bo = drive(wasmEngine(), hits, n), a = ao[0];
    let err = 0;
    for (let k = 0; k < NOUT; k++) for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(ao[k][i] - bo[k][i]));
    expect(peak(ao[2])).toBeGreaterThan(0.01); // the echo / gate box sends carry the locked hit
    expect(peak(ao[4])).toBeGreaterThan(0.01);
    expect(peak(a)).toBeGreaterThan(0.2);
    expect(err / peak(a)).toBeLessThan(1e-5);
  });

  MACHINES.forEach((mc, m) =>
    it(`${mc.name}: sensible level and dies away`, () => {
      const [a] = drive(js(), [[0, 0, m, trackFor(m).p]], SR * 4);
      expect(peak(a)).toBeGreaterThan(0.05);
      expect(peak(a)).toBeLessThan(1.5);
      expect(peak(a, SR * 3.5)).toBeLessThan(0.01);
    }));

  it('a slide trig glides into the new pitch without a retrigger (303 style)', () => {
    const p = trackFor(8).p; p[1] = 100; const hi = [100, ...p.slice(1)], at = SR / 4;
    const env = (slide: number) => { const [a] = drive(js(), [[0, 0, 8, p], [at, 0, 8, hi, slide]], SR / 2); return [peak(a, at - 600, at), peak(a, at, at + 600)]; };
    const [b1, a1] = env(1), [b0, a0] = env(0);
    expect(a0 / b0).toBeGreaterThan(1.3);   // a normal trig attacks again
    expect(a1 / b1).toBeLessThan(1.05);     // a slide carries on from where the note was
  });

  it('VOL 0 is silent', () => {
    const p = trackFor(3).p; p[VOL] = 0;
    expect(peak(drive(js(), [[0, 0, 3, p]], SR)[0])).toBe(0);
  });
});

describe('p-locks', () => {
  it('a lock overrides the kit on its step only', () => {
    const st = defaultState();
    st.lock[0][4] = { 0: 127 };
    expect(stepParams(st, 0, 4)[0]).toBe(127);
    expect(stepParams(st, 0, 5)[0]).toBe(st.kit[0].p[0]);
    expect(stepParams(st, 0, 4)).toHaveLength(NPAR);
  });
});

describe.skipIf(!FACTORY.length)('factory songs (src/factory/, local only)', () => {
  FACTORY.forEach(f => it(`${f().name}: renders the whole song at a sane level, fits 128 patterns and the .syx lock rows`, () => {
    const d = f(), st = defaultState(), step = Math.round(SR * 60 / d.tempo / 4), hits: Hit[] = [];
    st.kit = d.kit;
    d.bars.forEach((b, bi) => {
      applyBar(st, b);
      for (let i = 0; i < 16; i++) for (let tr = 0; tr < 16; tr++)
        if (st.trig[tr][i]) hits.push([(bi * 16 + i) * step, tr, st.kit[tr].m, stepParams(st, tr, i), st.lock[tr][i]?.[SLIDE] ? 1 : 0]);
    });
    const e = js();
    for (const [tr, w] of Object.entries(d.voices)) e.sample(TRACKS.indexOf(tr), voice(w, SR, () => 0.5));
    const n = (d.bars.length * 16 + 8) * step, [l, r] = drive(e, hits, n);
    const ss0 = songState(d);
    if (ss0.mnm) {                                       // the MNM part, rendered the way EXP WAV does, on top
      const six = () => Array.from({ length: 6 }, () => Array(16).fill(null));
      const { mhits } = songHits(ss0, { kit: ss0.mnm.kit, pats: ss0.mnm.pats, trig: six().map(r => r.map(() => false)), lock: six() });
      const m = drive(new MnmEngine(SR), mhits.map(h => [Math.round(h.f / 44100 * SR), h.tr, h.m, h.p] as Hit), n);
      expect(Math.max(peak(m[0]), peak(m[1]))).toBeGreaterThan(0.05);
      m[0].forEach((v, i) => { l[i] += v; }); m[1].forEach((v, i) => { r[i] += v; });
    }
    const pk = Math.max(peak(l), peak(r));
    expect(Number.isFinite(pk)).toBe(true);
    expect(pk).toBeGreaterThan(0.2);
    expect(pk).toBeLessThan(1.6); // before LEVEL (x0.79) and the master limiter
    const ss = songState(d), used = ss.pats.filter(Boolean).length;
    expect(ss.pats.length).toBe(128);
    expect(() => stateSyx(ss, [])).not.toThrow();
    console.log(d.name, 'peak', pk.toFixed(2), 'bars', d.bars.length, 'length', (d.bars.length * 16 * 60 / d.tempo / 4 / 60).toFixed(2), 'min', 'patterns', used);
  }, 60000));
});

describe('gate box', () => {
  it('IR is cut dead after attack + hold + release, whatever the settings', () => {
    for (const [a, h, d] of [[0, 40, 20], [127, 127, 127], [0, 0, 0]]) {
      const [l] = gateIR(SR, a, h, d);
      const end = Math.round(a / 127 * 0.1 * SR) + Math.round(h / 127 * 0.5 * SR);
      expect(peak(l, 0, end + 1)).toBeGreaterThan(0);
      expect(l[l.length - 1]).toBe(0);
    }
  });
});

describe('voice samples', () => {
  it('every word is finite, audible and normalized', () => {
    for (const w of VOICES) {
      const v = voice(w, SR, () => 0.5);
      expect(v.every(Number.isFinite)).toBe(true);
      expect(peak(v)).toBeCloseTo(0.8, 5);
      expect(v.length).toBeGreaterThan(SR * 0.15);
    }
  });
});
