// Built-in "voice" samples for the ROM machine, made by formant synthesis (no recorded audio): a glottal
// pulse (+ aspiration noise for the h) through three resonators that glide between vowel targets.
// ponytail: three formants and linear glides, so it shouts like a robot; good enough chopped up in a demo
type Key = [t: number, f1: number, f2: number, f3: number, voiced: number, noise: number];
const WORDS: Record<string, { f0: [number, number]; k: Key[] }> = {
  HEY: { f0: [190, 150], k: [[0, 530, 1840, 2480, 0, 0], [0.01, 530, 1840, 2480, 0, 0.7], [0.06, 530, 1840, 2480, 0.3, 0.3], [0.09, 560, 1850, 2500, 1, 0.05], [0.25, 420, 2050, 2700, 1, 0], [0.36, 300, 2250, 2900, 0.8, 0], [0.42, 300, 2250, 2900, 0, 0]] },
  HO: { f0: [170, 130], k: [[0, 570, 840, 2410, 0, 0], [0.01, 570, 840, 2410, 0, 0.7], [0.05, 570, 840, 2410, 0.4, 0.2], [0.08, 600, 900, 2400, 1, 0], [0.24, 450, 800, 2300, 1, 0], [0.34, 320, 760, 2250, 0.7, 0], [0.4, 320, 760, 2250, 0, 0]] },
  YEAH: { f0: [160, 120], k: [[0, 270, 2290, 3010, 0, 0], [0.02, 270, 2290, 3010, 0.8, 0], [0.1, 450, 2000, 2700, 1, 0], [0.22, 660, 1720, 2410, 1, 0], [0.5, 700, 1500, 2400, 0.9, 0], [0.62, 700, 1450, 2400, 0, 0]] },
};
export const VOICES = Object.keys(WORDS);

export function voice(word: string, fs: number, rnd = Math.random): Float32Array {
  const { f0, k } = WORDS[word], len = k[k.length - 1][0], n = Math.round(len * fs), out = new Float32Array(n);
  const bw = [90, 110, 150], st = [[0, 0], [0, 0], [0, 0]];
  let ph = 0, lp = 0, pk = 0, j = 0;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    while (j < k.length - 2 && t > k[j + 1][0]) j++;
    const a = k[j], b = k[j + 1], u = Math.min(1, (t - a[0]) / (b[0] - a[0])), at = (m: number) => a[m] + (b[m] - a[m]) * u;
    ph += (f0[0] + (f0[1] - f0[0]) * t / len) / fs; if (ph >= 1) ph -= 1;
    lp += ((1 - 2 * ph) - lp) * 0.3; // saw, softened toward a glottal pulse
    const src = lp * at(4) + (rnd() * 2 - 1) * at(5);
    let y = 0;
    for (let f = 0; f < 3; f++) { // two-pole resonator at the formant
      const r = Math.exp(-Math.PI * bw[f] / fs), c = 2 * r * Math.cos(2 * Math.PI * at(f + 1) / fs), s = st[f];
      const v = (1 - r) * src + c * s[0] - r * r * s[1]; s[1] = s[0]; s[0] = v;
      y += v / (f + 1);
    }
    out[i] = Math.tanh(y * 3); pk = Math.max(pk, Math.abs(out[i]));
  }
  return out.map(x => x / pk * 0.8);
}
