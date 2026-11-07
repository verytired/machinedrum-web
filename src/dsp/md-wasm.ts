// The WASM build of the MD engine (assembly/md.ts) behind MdEngine's interface; the worklet and EXP WAV both use it
import { NPAR, NOUT, MAXS } from './md';

export interface Engine { trig(tr: number, m: number, p: ArrayLike<number>, s: number): void; render(o: Float32Array[], off: number, n: number): void; sample(tr: number, d: Float32Array): void }

export function wasmEngine(mod: WebAssembly.Module, fs: number): Engine {
  const x = new WebAssembly.Instance(mod, {}).exports as unknown as {
    memory: WebAssembly.Memory; init(sr: number): void; outPtr(): number; parPtr(): number; trig(tr: number, m: number, s: number): void; render(n: number): void;
    smpPtr(tr: number): number; smpLen(tr: number, n: number): void;
  };
  x.init(fs);
  const buf = new Float32Array(x.memory.buffer, x.outPtr(), 128 * NOUT), par = new Float64Array(x.memory.buffer, x.parPtr(), NPAR);
  return {
    trig(tr, m, p, s) { for (let k = 0; k < NPAR; k++) par[k] = p[k]; x.trig(tr, m, s); },
    render(o, off, n) { x.render(n); for (let k = 0; k < NOUT; k++) o[k].set(buf.subarray(k * 128, k * 128 + n), off); },
    sample(tr, d) { const n = Math.min(d.length, MAXS); new Float32Array(x.memory.buffer, x.smpPtr(tr), n).set(d.subarray(0, n)); x.smpLen(tr, n); },
  };
}
