// MNM-WEB: the Monomachine-style unit under the MD. Its own panel, pattern and save; main.ts drives it from the MD's
// clock (step() on every 16th, flush() on STOP) and gives it the audio node, which plays through the MD's
// mixer, limiter and master FX. Same gestures as the MD: click a trig = on/off, hold (or drag off to latch) a trig and
// turn an encoder / press a key = p-lock (a key locks the step's NOTE)
import { $, numbox, encoder, drawEnc } from './dom';
import { MNPAR, NOTE, GATE, LEN } from './dsp/mnm';
import type { HitMsg } from './dsp/md-processor';

interface Machine { name: string; labels: string[]; defs: number[] }
const pad8 = <T,>(a: T[], f: T) => a.concat(Array(8).fill(f)).slice(0, 8);
const M = (name: string, labels: string, defs: number[]): Machine => ({ name, labels: pad8(labels.split(' '), ''), defs: pad8(defs, 0) });
const MACHINES = [M('SWAVE', 'WAV PW DET OSC2 SUB NOIS', [0, 0, 20, 40, 30, 0]), M('FM', 'RAT IDX IDEC FB', [16, 40, 50, 0])];
const PAGES = ['SYNTH', 'AMP', 'FILTER', 'LFO'];
const PAGE_LABELS = ['', 'ATK DEC SUS REL LEN DIST VOL PAN', 'BASE WDTH Q FENV FATK FDEC DEL REV', 'SPD DEP SHP DEST'].map(s => pad8(s.split(' '), ''));
//                 AMP                              FILTER                            LFO
const TRACK_DEFS = [0, 60, 60, 40, 3, 0, 90, 64, 0, 90, 20, 90, 0, 50, 0, 0, 40, 0, 0, 0, 0, 0, 0, 0];
const NAMES = 'C C# D D# E F F# G G# A A# B'.split(' ');
const noteName = (n: number) => NAMES[n % 12] + (Math.floor(n / 12) - 1);

type Lock = Record<number, number> | null;
interface MState { kit: { m: number; p: number[] }[]; trig: boolean[][]; lock: Lock[][] }
const track = (m: number, note: number) => ({ m, p: MACHINES[m].defs.concat(TRACK_DEFS, note) });
function defaults(): MState {
  const s: MState = { kit: [0, 1, 0, 1, 0, 1].map((m, i) => track(m, [36, 60, 48, 72, 55, 67][i])), trig: Array.from({ length: 6 }, () => Array(16).fill(false)), lock: Array.from({ length: 6 }, () => Array(16).fill(null)) };
  [2, 6, 10, 14].forEach((i, k) => { s.trig[0][i] = true; s.lock[0][i] = { [NOTE]: [36, 36, 39, 34][k] }; }); // offbeat bass
  [0, 11].forEach(i => { s.trig[1][i] = true; });
  Object.assign(s.kit[1].p, { 22: 50 });                                                                            // FM bell into the echo
  return s;
}
const KEY = 'mnm-web-v1';
const ok = (s: MState | undefined) => s?.kit?.length === 6 && s.kit.every(t => MACHINES[t?.m] && t.p?.length === MNPAR + 1 && t.p.every(Number.isFinite))
  && s.trig?.length === 6 && s.trig.every(r => r?.length === 16) && s.lock?.length === 6 && s.lock.every(r => r?.length === 16);
const st: MState = (() => { try { const s = JSON.parse(localStorage.getItem(KEY) ?? ''); if (ok(s)) return s; } catch { /* first run */ } return defaults(); })();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* private mode */ } };

// ---- what main.ts wires up ----
export const mnm = {
  ctx: undefined as AudioContext | undefined,
  node: undefined as AudioWorkletNode | undefined,
  ensure: async () => {},
  // the n-th 16th since PLAY at time t (dur = one 16th): the MnM loops its own 16 steps, like a unit on MIDI clock
  step(n: number, t: number, dur: number) { const i = n % 16; for (let tr = 0; tr < 6; tr++) if (st.trig[tr][i]) hit(tr, t, params(tr, i), dur); },
  show(i: number) { pos = i; drawSteps(); },
  flush() { this.node?.port.postMessage({ k: 'flush' }); this.show(-1); },
};
function params(tr: number, i: number) {
  const p = st.kit[tr].p.slice(), l = st.lock[tr][i];
  if (l) for (const k in l) p[+k] = l[k];
  return p;
}
const hit = (tr: number, t: number, p: number[], dur: number) => { p[GATE] = (p[LEN] + 1) / 8 * dur; mnm.node?.port.postMessage({ t, tr, m: st.kit[tr].m, p } satisfies HitMsg); };
const preview = async (tr: number, p = params(tr, -1)) => { await mnm.ensure(); hit(tr, mnm.ctx!.currentTime, p, 0.15); };

// ---- panel ----
let cur = 0, page = 0, held = -1, heldEdited = false, latched = false, skipUp = false, pos = -1;
const labels = () => page ? PAGE_LABELS[page] : MACHINES[st.kit[cur].m].labels;
const lockOf = (i: number) => held >= 0 ? st.lock[cur][held]?.[i] : undefined;
const val = (i: number) => lockOf(i) ?? st.kit[cur].p[i];
function setVal(i: number, v: number) {
  v = Math.max(0, Math.min(127, Math.round(v)));
  if (held >= 0) { (st.lock[cur][held] ??= {})[i] = v; st.trig[cur][held] = true; heldEdited = true; }
  else st.kit[cur].p[i] = v;
  save(); draw();
}
const encs = Array.from({ length: 8 }, (_, k) => {
  const lab = document.createElement('label'), enc = document.createElement('div');
  enc.className = 'enc'; lab.append(enc, document.createElement('b'));
  $('mencs').append(lab);
  encoder(enc, () => val(page * 8 + k), v => { if (labels()[k]) setVal(page * 8 + k, v); }, () => page ? TRACK_DEFS[page * 8 + k - 8] : MACHINES[st.kit[cur].m].defs[k]);
  return lab;
});
document.querySelectorAll<HTMLElement>('[data-mpage]').forEach(b => b.onclick = () => { page = +b.dataset.mpage!; draw(); });
function setMachine(d: number) {
  const t = st.kit[cur], m = (t.m + d + MACHINES.length) % MACHINES.length;
  st.kit[cur] = { m, p: MACHINES[m].defs.concat(t.p.slice(8)) };
  st.lock[cur].forEach(l => { if (l) for (let i = 0; i < 8; i++) delete l[i]; }); // synth locks meant the old machine
  save(); draw();
}
$('mmprev').onclick = () => setMachine(-1);
$('mmnext').onclick = () => setMachine(1);
$('mclear').onclick = () => { st.trig[cur].fill(false); st.lock[cur].fill(null); save(); draw(); };

// keyboard, one octave from C; no trig held = the track's note (and a preview), a held trig = a NOTE lock on it
const oct = numbox($('moct'), 0, 8, Math.floor(st.kit[cur].p[NOTE] / 12) - 1);
const keys = Array.from({ length: 13 }, (_, k) => {
  const b = document.createElement('button');
  b.className = NAMES[k % 12].length > 1 ? 'blk' : ''; b.textContent = NAMES[k % 12];
  b.onclick = () => {
    const n = Math.min(127, 12 * (oct.value + 1) + k);
    setVal(NOTE, n);
    const p = params(cur, held); p[NOTE] = n; preview(cur, p);
  };
  $('mkeys').append(b); return b;
});
const trackBtns = Array.from({ length: 6 }, (_, i) => {
  const b = document.createElement('button'); b.textContent = 'T' + (i + 1);
  b.onclick = () => { cur = i; draw(); preview(i); };
  $('mtracks').append(b); return b;
});
const trigBtns = Array.from({ length: 16 }, (_, i) => {
  const b = document.createElement('button'); b.setAttribute('aria-label', `mnm step ${i + 1}`);
  b.innerHTML = `<span>${i + 1}</span>`;
  b.onpointerdown = () => {
    if (latched) { latched = false; skipUp = true; held = -1; draw(); return; }
    held = i; heldEdited = false; draw();
  };
  b.onpointerup = () => {
    if (skipUp) { skipUp = false; return; }
    if (held !== i) return;
    if (!heldEdited) { st.trig[cur][i] = !st.trig[cur][i]; if (!st.trig[cur][i]) st.lock[cur][i] = null; save(); }
    held = -1; draw();
  };
  b.onpointercancel = () => { held = -1; draw(); };
  $('mtrigs').append(b); return b;
});
// released off the trig: latch it, so a mouse can still turn an encoder or press a key
addEventListener('pointerup', () => { if (held >= 0 && !latched) { latched = true; draw(); } });

function drawSteps() {
  trigBtns.forEach((b, i) => {
    const l = st.lock[cur][i];
    b.className = [st.trig[cur][i] && 'on', l && Object.keys(l).length && 'lock', i === pos && 'pos', i === held && 'held'].filter(Boolean).join(' ');
  });
  trackBtns.forEach((b, i) => b.classList.toggle('hit', pos >= 0 && st.trig[i][pos]));
}
function draw() {
  const labs = labels(), n = val(NOTE);
  $('mltrack').textContent = `T${cur + 1}`;
  $('mlmach').textContent = MACHINES[st.kit[cur].m].name;
  $('mlnote').textContent = noteName(n);
  $('mlnote').classList.toggle('lk', lockOf(NOTE) !== undefined);
  $('mlgrid').innerHTML = labs.map((lab, k) =>
    `<span class="${!lab ? 'off' : lockOf(page * 8 + k) !== undefined ? 'lk' : ''}"><i>${lab || '----'}</i><b>${lab ? String(val(page * 8 + k)).padStart(3, '0') : ''}</b></span>`).join('');
  $('mlstat').textContent = held >= 0 ? `LOCK STEP ${held + 1} - TURN AN ENCODER OR PRESS A KEY${latched ? ' / CLICK A TRIG TO RELEASE' : ''}` : PAGES[page];
  encs.forEach((lab, k) => {
    lab.classList.toggle('off', !labs[k]);
    lab.querySelector('b')!.textContent = labs[k] || '-';
    lab.firstElementChild!.setAttribute('aria-label', labs[k] ? 'mnm ' + labs[k] : 'unused');
    drawEnc(lab.firstElementChild as HTMLElement, labs[k] ? val(page * 8 + k) : 0);
  });
  keys.forEach((b, k) => b.classList.toggle('on', 12 * (oct.value + 1) + k === n));
  document.querySelectorAll<HTMLElement>('[data-mpage]').forEach(b => b.classList.toggle('on', +b.dataset.mpage! === page));
  trackBtns.forEach((b, i) => b.classList.toggle('sel', i === cur));
  drawSteps();
}
draw();
