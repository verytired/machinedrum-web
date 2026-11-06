// Built-in "voice" samples for the ROM machine, made by formant synthesis (no recorded audio): a glottal
// pulse (+ aspiration noise for the h) through three resonators that glide between vowel targets.
// ponytail: three formants and linear glides, so it shouts like a robot; good enough chopped up in a demo
type Key = [t: number, f1: number, f2: number, f3: number, voiced: number, noise: number];
const WORDS: Record<string, { f0: [number, number]; k: Key[] }> = {
  // HEY: a loud h, a voiced burst above full level (the tanh squashes it), pitch falling hard like a shout, cut off sharp
  HEY: { f0: [230, 140], k: [[0, 600, 1900, 2600, 0, 0], [0.005, 600, 1900, 2600, 0, 1], [0.04, 600, 1900, 2600, 0.5, 0.5], [0.06, 650, 1900, 2600, 1.3, 0.1], [0.18, 480, 2100, 2750, 1, 0], [0.24, 350, 2250, 2900, 0.9, 0], [0.255, 350, 2250, 2900, 0, 0]] },
  // HO: starts on an open 'aw' (high F1, mid F2) and closes toward o; a pure o reads as a tone, not a voice
  HO: { f0: [210, 150], k: [[0, 650, 1100, 2600, 0, 0], [0.005, 650, 1100, 2600, 0, 0.9], [0.05, 650, 1100, 2600, 0.5, 0.4], [0.07, 680, 1150, 2600, 1.3, 0.05], [0.25, 600, 1000, 2500, 1, 0], [0.4, 500, 880, 2450, 0.9, 0], [0.415, 500, 880, 2450, 0, 0]] },
  // JACK: a 'j' hiss (formants pushed up so the noise is bright), the 'a' of cat, a stop, then a short 'k' burst
  JACK: { f0: [200, 150], k: [[0, 2600, 3000, 3600, 0, 0], [0.005, 2600, 3000, 3600, 0, 1.2], [0.05, 2400, 2900, 3500, 0.3, 0.8], [0.065, 700, 1750, 2500, 1.3, 0.05], [0.2, 750, 1700, 2450, 1, 0], [0.225, 750, 1700, 2450, 0, 0], [0.27, 750, 1700, 2450, 0, 0], [0.275, 1800, 2500, 3200, 0, 1], [0.31, 1800, 2500, 3200, 0, 0]] },
  // WOO: a party whoop, the pitch rising; a little breath so the u stays a voice
  WOO: { f0: [220, 340], k: [[0, 300, 600, 2300, 0, 0], [0.02, 300, 600, 2300, 0.9, 0.15], [0.08, 320, 750, 2300, 1.2, 0.05], [0.45, 330, 800, 2350, 1, 0.04], [0.55, 330, 800, 2350, 0, 0]] },
  // OW!: an open a closing to u, falling like a yelp
  OW: { f0: [240, 160], k: [[0, 750, 1150, 2500, 0, 0], [0.005, 750, 1150, 2500, 0.6, 0.3], [0.03, 750, 1200, 2550, 1.3, 0.05], [0.15, 700, 1100, 2500, 1, 0], [0.28, 400, 850, 2400, 0.9, 0], [0.3, 400, 850, 2400, 0, 0]] },
  // UH: a short low grunt, breathy at the attack
  UH: { f0: [150, 110], k: [[0, 600, 1200, 2500, 0, 0], [0.005, 600, 1200, 2500, 0.8, 0.6], [0.03, 620, 1200, 2500, 1.3, 0.1], [0.2, 580, 1150, 2450, 1, 0], [0.23, 580, 1150, 2450, 0, 0]] },
  YEAH: { f0: [160, 120], k: [[0, 270, 2290, 3010, 0, 0], [0.02, 270, 2290, 3010, 0.8, 0], [0.1, 450, 2000, 2700, 1, 0], [0.22, 660, 1720, 2410, 1, 0], [0.5, 700, 1500, 2400, 0.9, 0], [0.62, 700, 1450, 2400, 0, 0]] },
};
export const VOICES = Object.keys(WORDS);
const SPEED = 0.7, LIFT = 1.3; // shorter and higher than the keyframes: a quick shout, not a drawl

export function voice(word: string, fs: number, rnd = Math.random): Float32Array {
  const w = WORDS[word], f0 = w.f0.map(f => f * LIFT), k = w.k.map(([t, ...r]) => [t * SPEED, ...r] as Key), len = k[k.length - 1][0], n = Math.round(len * fs), out = new Float32Array(n);
  const bw = [90, 120, 170], gain = [1, 0.8, 0.5], st = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  let ph = 0, pk = 0, j = 0;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    while (j < k.length - 2 && t > k[j + 1][0]) j++;
    const a = k[j], b = k[j + 1], u = Math.min(1, (t - a[0]) / (b[0] - a[0])), at = (m: number) => a[m] + (b[m] - a[m]) * u;
    const vib = 1 + 0.015 * Math.sin(2 * Math.PI * 5.5 * t); // a little wobble keeps it human
    ph += (f0[0] + (f0[1] - f0[0]) * t / len) * vib / fs; if (ph >= 1) ph -= 1;
    const src = (1 - 2 * ph) * at(4) + (rnd() * 2 - 1) * (at(5) + 0.04 * at(4)); // bright saw + breath
    let y = 0;
    for (let f = 0; f < 3; f++) { // RBJ band-pass at the formant, 0 dB at its peak
      const w = 2 * Math.PI * at(f + 1) / fs, al = Math.sin(w) * bw[f] / (2 * at(f + 1)), a0 = 1 + al, c = -2 * Math.cos(w) / a0, d = (1 - al) / a0, g = al / a0;
      const q = st[f], v = g * src - g * q[1] - c * q[2] - d * q[3];
      q[1] = q[0]; q[0] = src; q[3] = q[2]; q[2] = v;
      y += v * gain[f];
    }
    out[i] = Math.tanh(y * 1.5); pk = Math.max(pk, Math.abs(out[i]));
  }
  return out.map(x => x / pk * 0.8);
}
