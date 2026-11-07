// Master effects on native nodes, fed by the engine's send outputs (each track's DEL / REV).
// RHYTHM ECHO: tempo-synced delay with a filtered feedback loop. GATE BOX: gated reverb = a convolver whose
// impulse response is noise held flat and then cut off (80s gated snare).
export const ECHO_LABELS = ['TIME', 'FB', 'FILF', 'FILW', '', '', '', 'LEV'];
export const GATE_LABELS = ['ATCK', 'HOLD', 'DEC', 'HP', 'LP', '', '', 'LEV'];
// DYNAMIX: the master end stage (master.ts). CLIP = soft clip drive into the limiter, 0 = off
export const DYN_LABELS = ['CLIP', '', '', '', '', '', '', ''];
export interface Fx { echo: number[]; gate: number[]; dyn?: number[] } // dyn: missing in older saves and the factory songs
export const defaultFx = (): Fx => ({ echo: [16, 60, 20, 90, 0, 0, 0, 100], gate: [0, 40, 20, 20, 100, 0, 0, 100], dyn: [0, 0, 0, 0, 0, 0, 0, 0] });
export const dynOf = (fx: Fx) => (fx.dyn ??= defaultFx().dyn!);
export const clipOf = (fx: Fx) => fx.dyn?.[0] ?? 0;

const ex = (v: number, lo: number, hi: number) => lo * Math.pow(hi / lo, v / 127);
export const echoSteps = (time: number) => 1 + Math.floor(time / 8); // 1-16 sixteenths

// Gate box impulse response: attack ramp, flat hold, short release, then silence
export function gateIR(fs: number, atck: number, hold: number, dec: number, rnd = Math.random): Float32Array<ArrayBuffer>[] {
  const a = Math.round(atck / 127 * 0.1 * fs), h = Math.round(hold / 127 * 0.5 * fs), d = Math.round(ex(dec, 0.005, 0.3) * fs);
  const n = a + h + d + 1, g = Math.sqrt(0.75 / ((a / 2 + h + d / 2 + 1) / fs * 1000)); // equal loudness across lengths
  return [0, 1].map(() => {
    const ch = new Float32Array(n);
    for (let i = 0; i < n - 1; i++) ch[i] = g * (rnd() * 2 - 1) * (i < a ? i / a : i < a + h ? 1 : 1 - (i - a - h) / d);
    return ch;
  });
}

export function masterFx(ctx: BaseAudioContext, dest: AudioNode) {
  const echoIn = new GainNode(ctx), dl = new DelayNode(ctx, { maxDelayTime: 4 }), fb = new GainNode(ctx), eOut = new GainNode(ctx);
  const ehp = new BiquadFilterNode(ctx, { type: 'highpass' }), elp = new BiquadFilterNode(ctx, { type: 'lowpass' });
  echoIn.connect(dl).connect(ehp).connect(elp);
  elp.connect(fb).connect(dl);
  elp.connect(eOut).connect(dest);

  const gateIn = new GainNode(ctx), conv = new ConvolverNode(ctx, { disableNormalization: true }), gOut = new GainNode(ctx);
  const ghp = new BiquadFilterNode(ctx, { type: 'highpass' }), glp = new BiquadFilterNode(ctx, { type: 'lowpass' });
  gateIn.connect(conv).connect(ghp).connect(glp).connect(gOut).connect(dest);
  let irKey = '';

  return {
    echoIn, gateIn,
    set(fx: Fx, stepSec: number) {
      const [time, f, ff, fw, , , , lev] = fx.echo;
      dl.delayTime.value = Math.min(4, echoSteps(time) * stepSec);
      fb.gain.value = f / 127 * 0.95;
      ehp.frequency.value = ex(ff, 20, 5000); elp.frequency.value = ex(fw, 500, 20000);
      eOut.gain.value = lev / 127;
      const [at, hold, dec, gh, gl, , , glev] = fx.gate;
      ghp.frequency.value = ex(gh, 20, 5000); glp.frequency.value = ex(gl, 500, 20000);
      gOut.gain.value = glev / 127;
      const key = `${at},${hold},${dec}`;
      if (key !== irKey) {
        irKey = key;
        const ir = gateIR(ctx.sampleRate, at, hold, dec), buf = ctx.createBuffer(2, ir[0].length, ctx.sampleRate);
        ir.forEach((c, i) => buf.copyToChannel(c, i));
        conv.buffer = buf;
      }
    },
  };
}
