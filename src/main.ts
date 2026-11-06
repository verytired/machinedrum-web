import { $, numbox } from './dom';
import { masterFx, defaultFx, ECHO_LABELS, GATE_LABELS } from './fx';
import { MACHINES, FX_LABELS, ROUTE_LABELS, TRACKS, defaultState, stepParams, type State } from './machines';
import { demoSong, applyBar, BARS as demoBars, type Bar } from './demo';
import { voice, VOICES } from './voice';
import type { HitMsg, SmpMsg } from './dsp/md-processor';
import procUrl from './dsp/md-processor.ts?worker&url';
import wasmUrl from './dsp/md.wasm?url';

// ---- state (one pattern + kit, autosaved) ----
const KEY = 'md-web-v1';
// shape check for anything read back (localStorage, an imported file); fills fx for old saves
function valid(s: State | undefined): s is State {
  const ok = s?.kit?.length === 16 && s.kit.every(t => Number.isInteger(t?.m) && MACHINES[t.m] && t.p?.length === 24 && t.p.every(Number.isFinite))
    && s.trig?.length === 16 && s.trig.every(r => r?.length === 16) && s.lock?.length === 16 && s.lock.every(r => r?.length === 16 && r.every(l => l == null || Object.values(l).every(Number.isFinite)))
    && Number.isFinite(s.tempo);
  if (ok) s.fx ??= defaultFx();
  return ok;
}
function load(): State {
  try { const s = JSON.parse(localStorage.getItem(KEY) ?? ''); if (valid(s)) return s; } catch { /* first run */ }
  return defaultState();
}
const st = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* private mode */ } };
let msg = '', cur = 0, page = 0, held = -1, heldEdited = false, latched = false, skipUp = false, pos = -1, songPos = 0, level = 100;

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
    (await restored).forEach((s, tr) => { if (s) setSample(tr, s, false).catch(() => { /* unreadable: stays empty */ }); });
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
  await ensureAudio();
  // the demo's ROM tracks get the built-in voice samples
  await Promise.all(Object.entries(d.voices).map(([tr, w]) => setSample(TRACKS.indexOf(tr), { name: w, voice: w })));
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
// Saved per track in IndexedDB as the original file bytes (or the built-in voice's name) and decoded again on
// start, so a different sample rate next time still plays at the right pitch.
type Saved = { name: string; file?: ArrayBuffer; voice?: string };
const smpName: string[] = Array(16).fill('');
const saved: (Saved | undefined)[] = Array(16); // what EXPORT writes out
const db = new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open('md-web', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('smp');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const idb = <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => db.then(d => new Promise<T>((res, rej) => {
  const q = f(d.transaction('smp', mode).objectStore('smp')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
}));
// what was saved last time: names show right away, audio is decoded once the AudioContext exists
const restored = Promise.all(TRACKS.map((_, tr) => idb<Saved | undefined>('readonly', s => s.get(tr)).catch(() => undefined)))
  .then(all => { all.forEach((s, tr) => { if (s) { smpName[tr] = s.name; saved[tr] = s; } }); draw(); return all; });

async function setSample(tr: number, s: Saved, persist = true) {
  smpName[tr] = s.name; saved[tr] = s;
  if (persist) idb('readwrite', st => st.put(s, tr)).catch(() => { /* private mode: this session only */ });
  let d: Float32Array;
  if (s.voice) d = voice(s.voice, ctx!.sampleRate);
  else {
    const ab = await ctx!.decodeAudioData(s.file!.slice(0)); // resampled to the context rate; slice: decoding detaches its input
    d = new Float32Array(ab.length);
    for (let c = 0; c < ab.numberOfChannels; c++) ab.getChannelData(c).forEach((v, i) => d[i] += v / ab.numberOfChannels);
  }
  node!.port.postMessage({ k: 'smp', tr, d } satisfies SmpMsg, [d.buffer]);
}
async function loadSample(tr: number, f: File) {
  await ensureAudio();
  await setSample(tr, { name: f.name.replace(/\.[^.]+$/, '').toUpperCase().slice(0, 12), file: await f.arrayBuffer() });
  cur = tr;
  if (st.kit[tr].m !== ROM) { st.kit[tr] = { m: ROM, p: MACHINES[ROM].defs.concat(st.kit[tr].p.slice(8)) }; st.lock[tr].forEach(l => { if (l) for (let i = 0; i < 8; i++) delete l[i]; }); save(); }
  draw(); hit(tr, ctx!.currentTime, stepParams(st, tr, -1));
}
const ROM = MACHINES.findIndex(m => m.name === 'ROM');
const picker = Object.assign(document.createElement('input'), { type: 'file', accept: 'audio/*' });
picker.onchange = () => { if (picker.files?.[0]) loadSample(cur, picker.files[0]); picker.value = ''; };
$('load').onclick = () => picker.click();

// ---- EXPORT / IMPORT: the whole state plus the ROM samples in one JSON file ----
type Bundle = { app: 'machinedrum-web'; v: 1; st: State; samples: { tr: number; name: string; voice?: string; file?: string }[] };
const b64 = (buf: ArrayBuffer) => new Promise<string>(res => { const r = new FileReader(); r.onload = () => res((r.result as string).split(',')[1]); r.readAsDataURL(new Blob([buf])); });
const flash = (m: string) => { msg = m; draw(); setTimeout(() => { msg = ''; draw(); }, 2500); };
$('export').onclick = async () => {
  await restored;
  const samples = await Promise.all(saved.map(async (s, tr) => s && { tr, name: s.name, voice: s.voice, file: s.file && await b64(s.file) }));
  const b: Bundle = { app: 'machinedrum-web', v: 1, st, samples: samples.filter(x => !!x) };
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(b)], { type: 'application/json' })), download: `machinedrum-${new Date().toISOString().slice(0, 10)}.json` });
  a.click(); URL.revokeObjectURL(a.href);
  flash('EXPORTED');
};
const importer = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
importer.onchange = async () => {
  const f = importer.files?.[0]; importer.value = '';
  if (!f) return;
  try {
    const b = JSON.parse(await f.text()) as Bundle;
    if (b?.app !== 'machinedrum-web' || !valid(b.st) || !Array.isArray(b.samples)) throw new Error('not a machinedrum-web file');
    $('stop').click();
    Object.assign(st, b.st); save(); tempo.set(st.tempo); applyFx();
    await ensureAudio();
    for (let tr = 0; tr < 16; tr++) { smpName[tr] = ''; saved[tr] = undefined; idb('readwrite', s => s.delete(tr)).catch(() => {}); node!.port.postMessage({ k: 'smp', tr, d: new Float32Array(0) } satisfies SmpMsg); }
    for (const x of b.samples) {
      if (!Number.isInteger(x?.tr) || x.tr < 0 || x.tr > 15 || typeof x.name !== 'string') continue;
      const file = typeof x.file === 'string' ? await (await fetch('data:application/octet-stream;base64,' + x.file)).arrayBuffer() : undefined;
      const voiceName = typeof x.voice === 'string' && VOICES.includes(x.voice) ? x.voice : undefined;
      if (file || voiceName) await setSample(x.tr, { name: x.name.slice(0, 12), file, voice: voiceName }).catch(() => {});
    }
    flash('IMPORTED');
  } catch (e) { flash('IMPORT FAILED: ' + (e as Error).message.toUpperCase().slice(0, 30)); }
};
$('import').onclick = () => importer.click();

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
  $('lstat').textContent = msg ? msg : held >= 0 ? `LOCK STEP ${held + 1} - TURN AN ENCODER${latched ? ' / CLICK A TRIG TO RELEASE' : ''}` : songPos ? `DEMO  BAR ${songPos}/${demoBars}` : PAGES[page];
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
