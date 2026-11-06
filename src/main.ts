import { $, numbox } from './dom';
import { masterFx, defaultFx, ECHO_LABELS, GATE_LABELS } from './fx';
import { MACHINES, FX_LABELS, ROUTE_LABELS, TRACKS, defaultState, stepParams, type State } from './machines';
import { demoSong, applyBar, BARS as demoBars, type Bar } from './demo';
import type { HitMsg, SmpMsg } from './dsp/md-processor';
import procUrl from './dsp/md-processor.ts?worker&url';
import wasmUrl from './dsp/md.wasm?url';

// ---- state (one pattern + kit, autosaved) ----
const KEY = 'md-web-v1';
function load(): State {
  try { const s = JSON.parse(localStorage.getItem(KEY) ?? ''); if (s?.kit?.length === 16) { s.fx ??= defaultFx(); return s; } } catch { /* first run */ }
  return defaultState();
}
const st = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* private mode */ } };
let cur = 0, page = 0, held = -1, heldEdited = false, latched = false, skipUp = false, pos = -1, songPos = 0, level = 100;

// ---- audio ----
let fx: ReturnType<typeof masterFx> | undefined;
const applyFx = () => fx?.set(st.fx, 60 / tempo.value / 4);
let ctx: AudioContext | undefined, node: AudioWorkletNode | undefined, out: GainNode | undefined, engine = '';
let ready: Promise<void> | undefined;
async function ensureAudio() {
  await (ready ??= (async () => {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(procUrl);
    let wasm: WebAssembly.Module | null = null;
    try { wasm = await WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer()); } catch { /* JS engine */ }
    node = new AudioWorkletNode(ctx, 'md', { numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [2, 2, 2], processorOptions: { wasm } });
    node.port.onmessage = e => { if (e.data.k === 'engine') { engine = e.data.name.toUpperCase(); draw(); } };
    out = new GainNode(ctx, { gain: level / 127 });
    // master limiter: 16 tracks landing on one step add up past full scale
    const lim = new DynamicsCompressorNode(ctx, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
    node.connect(out, 0).connect(lim).connect(ctx.destination);
    fx = masterFx(ctx, out);
    node.connect(fx.echoIn, 1); node.connect(fx.gateIn, 2);
    applyFx();
    Object.assign(window, { md: { ctx, out } }); // e2e hook
  })());
  await ctx!.resume();
}
const hit = (tr: number, t: number, p: number[]) => node!.port.postMessage({ t, tr, m: st.kit[tr].m, p } satisfies HitMsg);

// ---- sequencer (lookahead scheduler, as in AfterBirth's transport.ts) ----
let playing = false, nextT = 0, step = 0, timer: ReturnType<typeof setInterval> | undefined;
let song: Bar[] | null = null, songBar = 0, swing = 0; // swing: delay of odd 16ths, in steps (set by the demo)
function tick() {
  while (nextT < ctx!.currentTime + 0.1) {
    const i = step, t = nextT;
    if (song && i === 0) {
      if (songBar >= song.length) { // end: stop scheduling, let the tails ring out
        clearInterval(timer); song = null;
        setTimeout(() => $('stop').click(), (t - ctx!.currentTime) * 1000 + 1500);
        return;
      }
      applyBar(st, song[songBar++]);
      const n = songBar;
      setTimeout(() => { if (playing) { songPos = n; draw(); } }, Math.max(0, (t - ctx!.currentTime) * 1000));
    }
    const ts = t + (i % 2 ? swing * 60 / tempo.value / 4 : 0);
    for (let tr = 0; tr < 16; tr++) if (st.trig[tr][i]) hit(tr, ts, stepParams(st, tr, i));
    setTimeout(() => { if (playing) { pos = i; drawSteps(); } }, Math.max(0, (t - ctx!.currentTime) * 1000));
    nextT += 60 / tempo.value / 4;
    step = (step + 1) % 16;
  }
}
$('play').onclick = async () => {
  await ensureAudio();
  if (playing) return;
  playing = true; step = 0; nextT = ctx!.currentTime + 0.05;
  timer = setInterval(tick, 25);
  $('play').classList.add('on');
};
$('demo').onclick = async () => {
  $('stop').click();
  const d = demoSong();
  tempo.set(d.tempo); // saves; the demo kit/bars below are not saved unless you edit during the demo
  st.kit = d.kit; st.fx = d.fx; applyFx(); song = d.bars; songBar = 0; songPos = 0; swing = d.swing;
  $('play').click();
};
$('stop').onclick = () => { node?.port.postMessage({ k: 'flush' }); playing = false; song = null; songPos = 0; swing = 0; clearInterval(timer); pos = -1; $('play').classList.remove('on'); drawSteps(); };
const tempo = numbox($('tempo'), 30, 300, st.tempo, v => { st.tempo = v; save(); applyFx(); });

// ---- encoders ----
// Each encoder edits the selected track's param on the current page; while a trig is held it writes a p-lock
// Pages 3/4 are the master effects: global, not lockable
const PAGES = ['SYNTHESIS', 'EFFECTS', 'ROUTING', 'RHYTHM ECHO', 'GATE BOX'];
const idx = (k: number) => page < 3 ? page * 8 + k : k;
const labels = () => [MACHINES[st.kit[cur].m].labels, FX_LABELS, ROUTE_LABELS, ECHO_LABELS, GATE_LABELS][page];
const arr = () => page < 3 ? st.kit[cur].p : page === 3 ? st.fx.echo : st.fx.gate;
const lockOf = (k: number) => held >= 0 && page < 3 ? st.lock[cur][held]?.[idx(k)] : undefined;
const val = (k: number) => lockOf(k) ?? arr()[idx(k)];
function setVal(k: number, v: number) {
  if (!labels()[k]) return;
  v = Math.max(0, Math.min(127, Math.round(v)));
  if (held >= 0 && page < 3) {
    (st.lock[cur][held] ??= {})[idx(k)] = v;
    st.trig[cur][held] = true; heldEdited = true;
  } else arr()[idx(k)] = v;
  if (page >= 3) applyFx();
  save(); draw();
}
const defVal = (k: number) => page === 0 ? MACHINES[st.kit[cur].m].defs[k] : page < 3 ? defaultState().kit[0].p[idx(k)] : (page === 3 ? defaultFx().echo : defaultFx().gate)[k];

function encoder(el: HTMLElement, get: () => number, set: (v: number) => void, def: () => number) {
  el.tabIndex = 0; el.setAttribute('role', 'slider');
  el.onpointerdown = e => {
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY, v0 = get();
    el.onpointermove = e => set(v0 + (y0 - e.clientY) / 2);
  };
  el.onpointerup = el.onpointercancel = () => { el.onpointermove = null; };
  el.onwheel = e => { e.preventDefault(); set(get() - Math.sign(e.deltaY)); };
  el.ondblclick = () => set(def());
  el.onkeydown = e => {
    const d = ({ ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 } as Record<string, number>)[e.key];
    if (d) { e.preventDefault(); set(get() + d * (e.shiftKey ? 10 : 1)); }
  };
}
const encs = Array.from({ length: 8 }, (_, k) => {
  const lab = document.createElement('label'), enc = document.createElement('div');
  enc.className = 'enc'; lab.append(enc, document.createElement('b'));
  $('encs').append(lab);
  encoder(enc, () => val(k), v => setVal(k, v), () => defVal(k));
  return lab;
});
const lev = $('level');
encoder(lev, () => level, v => { level = Math.max(0, Math.min(127, Math.round(v))); if (out) out.gain.value = level / 127; drawEnc(lev, level); }, () => 100);
const drawEnc = (el: HTMLElement, v: number) => { el.style.setProperty('--a', (v / 127 * 270 - 135) + 'deg'); el.setAttribute('aria-valuenow', String(v)); };

// ---- machine select / pages / clear ----
function setMachine(d: number) {
  const t = st.kit[cur], m = (t.m + d + MACHINES.length) % MACHINES.length;
  st.kit[cur] = { m, p: MACHINES[m].defs.concat(t.p.slice(8)) };
  st.lock[cur].forEach(l => { if (l) for (let i = 0; i < 8; i++) delete l[i]; }); // synth locks meant the old machine
  save(); draw();
}
$('mprev').onclick = () => setMachine(-1);
$('mnext').onclick = () => setMachine(1);
document.querySelectorAll<HTMLElement>('[data-page]').forEach(b => b.onclick = () => { page = +b.dataset.page!; draw(); });
$('clear').onclick = () => { st.trig[cur].fill(false); st.lock[cur].fill(null); save(); draw(); };

// ---- ROM samples: LOAD (file picker) or drop an audio file on a track key ----
// ponytail: samples live only in memory, a reload leaves ROM tracks silent; persist to IndexedDB if that bites
const smpName: string[] = Array(16).fill('');
async function loadSample(tr: number, f: File) {
  await ensureAudio();
  const ab = await ctx!.decodeAudioData(await f.arrayBuffer()); // resampled to the context rate
  const d = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) ab.getChannelData(c).forEach((v, i) => d[i] += v / ab.numberOfChannels);
  node!.port.postMessage({ k: 'smp', tr, d } satisfies SmpMsg, [d.buffer]);
  smpName[tr] = f.name.replace(/\.[^.]+$/, '').toUpperCase().slice(0, 12);
  cur = tr;
  if (st.kit[tr].m !== ROM) { st.kit[tr] = { m: ROM, p: MACHINES[ROM].defs.concat(st.kit[tr].p.slice(8)) }; st.lock[tr].forEach(l => { if (l) for (let i = 0; i < 8; i++) delete l[i]; }); save(); }
  draw(); hit(tr, ctx!.currentTime, stepParams(st, tr, -1));
}
const ROM = MACHINES.findIndex(m => m.name === 'ROM');
const picker = Object.assign(document.createElement('input'), { type: 'file', accept: 'audio/*' });
picker.onchange = () => { if (picker.files?.[0]) loadSample(cur, picker.files[0]); picker.value = ''; };
$('load').onclick = () => picker.click();

// ---- track keys + trig keys ----
const trackBtns = TRACKS.map((name, i) => {
  const b = document.createElement('button'); b.textContent = name;
  b.onclick = async () => { cur = i; draw(); await ensureAudio(); hit(i, ctx!.currentTime, stepParams(st, i, -1)); };
  b.ondragover = e => e.preventDefault();
  b.ondrop = e => { e.preventDefault(); const f = e.dataTransfer?.files[0]; if (f) loadSample(i, f); };
  $('tracks').append(b); return b;
});
const trigBtns = Array.from({ length: 16 }, (_, i) => {
  const b = document.createElement('button'); b.setAttribute('aria-label', `step ${i + 1}`);
  b.innerHTML = `<span>${i + 1}</span>`;
  // A mouse can't hold a trig and drag an encoder, so releasing off the trig latches it; the next trig click releases
  b.onpointerdown = () => {
    if (latched) { latched = false; skipUp = true; held = -1; draw(); return; }
    held = i; heldEdited = false; draw();
  };
  b.onpointerup = () => {
    if (skipUp) { skipUp = false; return; }
    if (held !== i) return; // released over another trig: the window handler latches
    if (!heldEdited) { st.trig[cur][i] = !st.trig[cur][i]; if (!st.trig[cur][i]) st.lock[cur][i] = null; save(); }
    held = -1; draw();
  };
  b.onpointercancel = () => { held = -1; draw(); };
  $('trigs').append(b); return b;
});

addEventListener('pointerup', () => { if (held >= 0 && !latched) { latched = true; draw(); } });

// ---- drawing ----
const pad = (n: number) => String(n).padStart(3, '0');
function drawSteps() {
  trigBtns.forEach((b, i) => {
    const l = st.lock[cur][i];
    b.className = [st.trig[cur][i] && 'on', l && Object.keys(l).length && 'lock', i === pos && 'pos', i === held && 'held'].filter(Boolean).join(' ');
  });
  trackBtns.forEach((b, i) => b.classList.toggle('hit', pos >= 0 && st.trig[i][pos]));
}
function draw() {
  const t = st.kit[cur], labs = labels();
  $('ltrack').textContent = `T${String(cur + 1).padStart(2, '0')}:${TRACKS[cur].padEnd(2)}`;
  $('lmach').textContent = MACHINES[t.m].name + (t.m === ROM ? ':' + (smpName[cur] || 'EMPTY') : '');
  $('lengine').textContent = engine;
  $('lgrid').innerHTML = labs.map((lab, k) =>
    `<span class="${!lab ? 'off' : lockOf(k) !== undefined ? 'lk' : ''}"><i>${lab || '----'}</i><b>${lab ? pad(val(k)) : ''}</b></span>`).join('');
  $('lstat').textContent = held >= 0 ? `LOCK STEP ${held + 1} - TURN AN ENCODER${latched ? ' / CLICK A TRIG TO RELEASE' : ''}` : songPos ? `DEMO  BAR ${songPos}/${demoBars}` : PAGES[page];
  encs.forEach((lab, k) => {
    lab.classList.toggle('off', !labs[k]);
    lab.querySelector('b')!.textContent = labs[k] || '-';
    lab.firstElementChild!.setAttribute('aria-label', labs[k] || 'unused');
    drawEnc(lab.firstElementChild as HTMLElement, labs[k] ? val(k) : 0);
  });
  document.querySelectorAll<HTMLElement>('[data-page]').forEach(b => b.classList.toggle('on', +b.dataset.page! === page));
  trackBtns.forEach((b, i) => b.classList.toggle('sel', i === cur));
  drawSteps();
}
drawEnc(lev, level);
draw();
