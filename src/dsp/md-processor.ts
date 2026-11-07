// AudioWorklet shell around the MD engine: WASM when it compiles, else the TS twin.
// Splits each render block at hit boundaries, like AfterBirth's tr606-processor.ts
import { MdEngine, NPAR, NOUT, MAXS } from './md';
import { MnmEngine } from './mnm';
import { Limiter } from '../master';

export type HitMsg = { t: number; tr: number; m: number; p: number[]; s?: number }; // s: slide
export type FlushMsg = { k: 'flush' };
export type SmpMsg = { k: 'smp'; tr: number; d: Float32Array };

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, ctor: new (options: { processorOptions: Opts }) => AudioWorkletProcessor): void;

// mnm: run the Monomachine-style engine instead (TS only, so no wasm)
type Opts = { wasm: WebAssembly.Module | null; mnm?: boolean };
interface Engine { trig(tr: number, m: number, p: number[], s: number): void; render(o: Float32Array[], off: number, n: number): void; sample(tr: number, d: Float32Array): void }

function wasmEngine(mod: WebAssembly.Module): Engine {
  const x = new WebAssembly.Instance(mod, {}).exports as unknown as {
    memory: WebAssembly.Memory; init(sr: number): void; outPtr(): number; parPtr(): number; trig(tr: number, m: number, s: number): void; render(n: number): void;
    smpPtr(tr: number): number; smpLen(tr: number, n: number): void;
  };
  x.init(sampleRate);
  const buf = new Float32Array(x.memory.buffer, x.outPtr(), 128 * NOUT), par = new Float64Array(x.memory.buffer, x.parPtr(), NPAR);
  return {
    trig(tr, m, p, s) { par.set(p); x.trig(tr, m, s); },
    render(o, off, n) { x.render(n); for (let k = 0; k < NOUT; k++) o[k].set(buf.subarray(k * 128, k * 128 + n), off); },
    sample(tr, d) { const n = Math.min(d.length, MAXS); new Float32Array(x.memory.buffer, x.smpPtr(tr), n).set(d.subarray(0, n)); x.smpLen(tr, n); },
  };
}

class MdProcessor extends AudioWorkletProcessor {
  private engine: Engine;
  private q: HitMsg[] = [];

  constructor({ processorOptions: o }: { processorOptions: Opts }) {
    super();
    let name = 'js', e: Engine | undefined;
    try {
      if (o.mnm) { e = new MnmEngine(sampleRate); name = 'mnm'; }
      else if (o.wasm) { e = wasmEngine(o.wasm); name = 'wasm'; }
    } catch (err) {
      this.port.postMessage({ k: 'error', msg: String(err) });
    }
    this.engine = e ?? new MdEngine(sampleRate);
    this.port.postMessage({ k: 'engine', name });
    this.port.onmessage = (ev: MessageEvent<HitMsg | FlushMsg | SmpMsg>) => {
      if ('k' in ev.data) { if (ev.data.k === 'smp') this.engine.sample(ev.data.tr, ev.data.d); else this.q.length = 0; return; }
      let i = this.q.length;
      while (i > 0 && this.q[i - 1].t > ev.data.t) i--;
      this.q.splice(i, 0, ev.data);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const o = outputs.flat(), n = o[0].length;
    let pos = 0;
    while (this.q.length) {
      const frame = Math.round((this.q[0].t - currentTime) * sampleRate);
      if (frame >= n) break;
      const at = Math.max(pos, frame);
      if (at > pos) { this.engine.render(o, pos, at - pos); pos = at; }
      const m = this.q.shift()!;
      this.engine.trig(m.tr, m.m, m.p, m.s ?? 0);
    }
    if (pos < n) this.engine.render(o, pos, n - pos);
    return true;
  }
}

registerProcessor('md', MdProcessor);

// the master end stage (master.ts), 2 in / 2 out; port message = [CLIP, GAIN]
class LimProcessor extends AudioWorkletProcessor {
  private lim = new Limiter(sampleRate);
  constructor() { super(); this.port.onmessage = (ev: MessageEvent<[number, number]>) => this.lim.set(...ev.data); }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [l, r] = outputs[0], i = inputs[0];
    if (i.length) { l.set(i[0]); r.set(i[1] ?? i[0]); } else { l.fill(0); r.fill(0); }
    this.lim.process(l, r);
    return true;
  }
}
registerProcessor('lim', LimProcessor as never);
