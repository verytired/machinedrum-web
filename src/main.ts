import { $, numbox, encoder, drawEnc } from './dom';
import { masterFx, defaultFx, dynOf, dynVals, seeded, ECHO_LABELS, GATE_LABELS, DYN_LABELS } from './fx';
import { MACHINES, FX_LABELS, ROUTE_LABELS, TRACKS, SLIDE, micro, defaultState, stepParams, applyAuto, laneAt, type Lane, type State, type Pat } from './machines';
import { enter, next, barAt, isPat, slotName, type Pos, type PatRow, type Row } from './song';
import { songState } from './bars';
import { FACTORY } from './presets';
import { renderWav } from './render';
import { voice, VOICES } from './voice';
import { mnm } from './mnm';
import { stateSyx, parseSyx, applyKit, readPattern, readSong, patName, patKit, kitName, isEmpty, wav, type Dump, type Sample } from './syx';
import type { HitMsg, SmpMsg } from './dsp/md-processor';
import procUrl from './dsp/md-processor.ts?worker&url';
import wasmUrl from './dsp/md.wasm?url';

// ---- state (kit, patterns A01-H16, song; autosaved) ----
const KEY = 'md-web-v1';
const grid = (p: Pat | null | undefined) => p?.trig?.length === 16 && p.trig.every(r => r?.length === 16)
  && p.lock?.length === 16 && p.lock.every(r => r?.length === 16 && r.every(l => l == null || Object.values(l).every(Number.isFinite)));
const int = (x: unknown, lo: number, hi: number) => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;
const rowOk = (r: any) => r?.end === true || (int(r?.loop, 0, 255) && int(r.times, 0, 64))
  || (int(r?.pat, 0, 127) && int(r.rep, 1, 64) && int(r.of, 0, 15) && int(r.len, 1, 16) && r.of < r.len && (r.bpm === null || int(r.bpm, 30, 300)) && int(r.mute, 0, 0xffff));
// shape check for anything read back (localStorage, an imported file); fills what older saves lack (fx, patterns, song)
function valid(s: State | undefined): s is State {
  const ok = s?.kit?.length === 16 && s.kit.every(t => Number.isInteger(t?.m) && MACHINES[t.m] && t.p?.length === 24 && t.p.every(Number.isFinite))
    && grid(s) && Number.isFinite(s.tempo);
  if (!ok) return false;
  s.fx ??= defaultFx();
  if (!(s.pats?.length === 128 && s.pats.every(p => p === null || grid(p)))) s.pats = Array(128).fill(null);
  if (!int(s.pat, 0, 127)) s.pat = 0;
  if (!(Number.isFinite(s.swing) && s.swing >= 0 && s.swing <= 0.6)) s.swing = 0;
  if (!(Array.isArray(s.song) && s.song.length <= 256 && s.song.every(rowOk))) s.song = [];
  if (!(Array.isArray(s.auto) && s.auto.every(a => int(a?.tr, 0, 21) && int(a.par, 0, 33) && Array.isArray(a.pts) && a.pts.every(q => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite))))) delete s.auto;
  return true;
}
// First run (nothing saved), or the page opened with ?factory=N (= factory reset to factory song N, 0 by default):
// the factory content, as on the MD. A factory song is patterns from A01, the song, its kit and voice samples
// (press SONG, then PLAY)
const fq = new URLSearchParams(location.search).get('factory');
if (fq !== null) history.replaceState(null, '', location.pathname);
const song0 = FACTORY[Math.max(0, Math.min(FACTORY.length - 1, parseInt(fq ?? '') || 0))]?.(); // none in a build without src/factory/
let fresh = false;
function load(): State {
  if (fq === null) try { const s = JSON.parse(localStorage.getItem(KEY) ?? ''); if (valid(s)) return s; } catch { /* first run */ }
  fresh = true;
  if (!song0) return defaultState();
  const s = songState(song0);
  if (s.mnm) mnm.load(s.mnm.kit, s.mnm.pats); else mnm.clear(); // the MNM gets the song's part, or rests
  delete s.mnm;
  return s;
}
const st = load();
const stash = () => { st.pats[st.pat] = { trig: st.trig, lock: st.lock }; };
const save = () => { stash(); try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* private mode */ } };
let msg = '', cur = 0, page = 0, held = -1, heldEdited = false, latched = false, skipUp = false, pos = -1, level = 100;

// ---- audio ----
let fx: ReturnType<typeof masterFx> | undefined;
let limNode: AudioWorkletNode | undefined;
const applyFx = () => { fx?.set(st.fx, 60 / tempo.value / 4); limNode?.port.postMessage(dynVals(st.fx)); };
let ctx: AudioContext | undefined, node: AudioWorkletNode | undefined, out: GainNode | undefined, engine = '';
let ready: Promise<void> | undefined;
// md.wasm compiled once, for the worklet and EXP WAV (null = it didn't compile: the TS engine)
let wasmMod: Promise<WebAssembly.Module | null> | undefined;
const getWasm = () => wasmMod ??= fetch(wasmUrl).then(r => r.arrayBuffer()).then(b => WebAssembly.compile(b)).catch(() => null);
async function ensureAudio() {
  await (ready ??= (async () => {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(procUrl);
    const wasm = await getWasm();
    node = new AudioWorkletNode(ctx, 'md', { numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [2, 2, 2], processorOptions: { wasm } });
    node.port.onmessage = e => { if (e.data.k === 'engine') { engine = e.data.name.toUpperCase(); draw(); } };
    out = new GainNode(ctx, { gain: level / 127 });
    // master end stage (master.ts): soft clip + look-ahead limiter at -1 dBFS, the same code as EXP WAV
    const lim = limNode = new AudioWorkletNode(ctx, 'lim', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    node.connect(out, 0).connect(lim).connect(ctx.destination);
    fx = masterFx(ctx, out);
    node.connect(fx.echoIn, 1); node.connect(fx.gateIn, 2);
    // the MnM: same worklet shell with its own engine, into the same mixer / limiter / master FX
    const mn = new AudioWorkletNode(ctx, 'md', { numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [2, 2, 2], processorOptions: { wasm: null, mnm: true } });
    mn.connect(out, 0); mn.connect(fx.echoIn, 1); mn.connect(fx.gateIn, 2);
    mnm.ctx = ctx; mnm.node = mn;
    applyFx();
    (await restored).forEach((s, tr) => { if (s) setSample(tr, s, false).catch(() => { /* unreadable: stays empty */ }); });
    Object.assign(window, { md: { ctx, out } }); // e2e hook
  })());
  await ctx!.resume();
}
mnm.ensure = ensureAudio;
const hit = (tr: number, t: number, p: number[], s = 0) => {
  node!.port.postMessage({ t, tr, m: st.kit[tr].m, p, s } satisfies HitMsg);
  if (tr === 0) mnm.node?.port.postMessage({ t, tr: -1, m: 0, p: [] } satisfies HitMsg); // the MNM's duck key
};

// ---- sequencer (lookahead scheduler, as in AfterBirth's transport.ts) ----
let playing = false, nextT = 0, step = 0, n16 = 0, timer: ReturnType<typeof setInterval> | undefined;
// song mode: sp = the song pointer while playing, songRow = where PLAY starts, cue = row picked while playing
// pattern mode: a pattern picked while playing waits in `queued` for the end of the pattern
let songBar = 0; // the playing bar on the song's timeline (song automation)
let songMode = false, sp: Pos | null = null, songRow = 0, cue = -1, queued = -1, first = 0, last = 16, mute = 0, newBar = true;
const at = (t: number, f: () => void) => setTimeout(() => { if (playing) f(); }, Math.max(0, (t - ctx!.currentTime) * 1000));
const finish = (t: number) => { clearInterval(timer); setTimeout(() => $('stop').click(), (t - ctx!.currentTime) * 1000 + 1500); }; // let the tails ring out
function usePat(n: number) {
  stash();
  const p = st.pats[n] ?? { trig: TRACKS.map(() => Array<boolean>(16).fill(false)), lock: TRACKS.map(() => Array(16).fill(null)) };
  st.pat = n; st.trig = p.trig; st.lock = p.lock; save(); draw();
  mnm.usePat(n); // the MNM follows the MD's pattern, as on a program change
}
// top of a bar: the song's next row or a queued pattern. false = stop here
function bar(t: number): boolean {
  first = 0; last = 16; mute = 0;
  if (songMode) {
    const n = cue >= 0 ? enter(st.song, cue) : sp ? next(st.song, sp) : enter(st.song, songRow);
    cue = -1;
    if (!n || 'halt' in n) { songRow = n ? n.halt : 0; sp = null; at(t, draw); finish(t); return false; } // END / HALT
    const r = st.song[n.row] as PatRow;
    sp = n; songRow = n.row; songBar = barAt(st.song, n);
    if (st.pat !== r.pat) usePat(r.pat);
    if (r.bpm && r.bpm !== tempo.value) tempo.set(r.bpm);
    first = r.of; last = r.len; mute = r.mute;
    at(t, draw);
  } else if (queued >= 0) { usePat(queued); queued = -1; }
  return true;
}
function tick() {
  while (nextT < ctx!.currentTime + 0.1) {
    const t = nextT;
    if (newBar) { newBar = false; if (!bar(t)) return; step = first; }
    const i = step, ts = t + (i % 2 ? st.swing * 60 / tempo.value / 4 : 0);
    const at16 = songBar + i / 16, auto = songMode ? st.auto : undefined;
    for (let tr = 0; tr < 16; tr++) if (st.trig[tr][i] && !(mute >> tr & 1)) {
      const p = stepParams(st, tr, i);
      applyAuto(auto, tr, at16, p, st.lock[tr][i], st.kit[tr].p);
      hit(tr, ts + micro(st.lock[tr][i]) * 60 / tempo.value / 4, p, st.lock[tr][i]?.[SLIDE] ? 1 : 0);
    }
    const mi = n16 % 16; mnm.step(n16++, ts, 60 / tempo.value / 4, auto && ((tr, p, l, base) => applyAuto(auto, 16 + tr, at16, p, l, base))); // the MnM on the MD's clock
    at(t, () => { pos = i; drawSteps(); mnm.show(mi); });
    nextT += 60 / tempo.value / 4;
    if (++step >= last) newBar = true;
  }
}
$('play').onclick = async () => {
  await ensureAudio();
  if (playing) { if (songMode) $('stop').click(); return; } // song mode: PLAY again pauses
  playing = true; newBar = true; n16 = 0; nextT = ctx!.currentTime + 0.05;
  timer = setInterval(tick, 25);
  $('play').classList.add('on'); draw();
};
// song mode: STOP holds the position, a second STOP goes back to the first row
$('stop').onclick = () => {
  if (!playing) songRow = 0; else if (sp) songRow = sp.row;
  node?.port.postMessage({ k: 'flush' }); mnm.flush(); playing = false; sp = null; cue = queued = -1;
  clearInterval(timer); pos = -1; $('play').classList.remove('on'); draw();
};
const tempo = numbox($('tempo'), 30, 300, st.tempo, v => { st.tempo = v; save(); applyFx(); });

// ---- encoders ----
// Each encoder edits the selected track's param on the current page; while a trig is held it writes a p-lock
// Pages 3-5 are the master effects: global, not lockable
const PAGES = ['SYNTHESIS', 'EFFECTS', 'ROUTING', 'RHYTHM ECHO', 'GATE BOX', 'DYNAMIX'];
const idx = (k: number) => page < 3 ? page * 8 + k : k;
const labels = () => [MACHINES[st.kit[cur].m].labels, FX_LABELS, ROUTE_LABELS, ECHO_LABELS, GATE_LABELS, DYN_LABELS][page];
const arr = () => page < 3 ? st.kit[cur].p : page === 3 ? st.fx.echo : page === 4 ? st.fx.gate : dynOf(st.fx);
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
const defVal = (k: number) => page === 0 ? MACHINES[st.kit[cur].m].defs[k] : page < 3 ? defaultState().kit[0].p[idx(k)] : (page === 3 ? defaultFx().echo : page === 4 ? defaultFx().gate : defaultFx().dyn!)[k];

const encs = Array.from({ length: 8 }, (_, k) => {
  const lab = document.createElement('label'), enc = document.createElement('div');
  enc.className = 'enc'; lab.append(enc, document.createElement('b'));
  $('encs').append(lab);
  encoder(enc, () => val(k), v => setVal(k, v), () => defVal(k));
  return lab;
});
const lev = $('level');
encoder(lev, () => level, v => { level = Math.max(0, Math.min(127, Math.round(v))); if (out) out.gain.value = level / 127; drawEnc(lev, level); }, () => 100);

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
$('fxreset').onclick = () => { st.fx = defaultFx(); save(); applyFx(); flash('FX RESET'); };
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
// factory content: its ROM tracks get the song's voices, the other tracks' samples are dropped
const voices: Record<string, string> = song0?.voices ?? {};
const restored = Promise.all(TRACKS.map((n, tr) => !fresh ? idb<Saved | undefined>('readonly', s => s.get(tr)).catch(() => undefined)
  : (voices[n] ? idb('readwrite', o => o.put({ name: voices[n], voice: voices[n] }, tr)) : idb('readwrite', o => o.delete(tr))).catch(() => {}).then(() => voices[n] ? { name: voices[n], voice: voices[n] } : undefined)))
  .then(all => { all.forEach((s, tr) => { if (s) { smpName[tr] = s.name; saved[tr] = s; } }); draw(); return all; });

async function setSample(tr: number, s: Saved, persist = true) {
  smpName[tr] = s.name; saved[tr] = s;
  if (persist) idb('readwrite', st => st.put(s, tr)).catch(() => { /* private mode: this session only */ });
  let d: Float32Array;
  if (s.voice) d = voice(s.voice, ctx!.sampleRate, seeded(s.voice));
  else {
    const ab = await ctx!.decodeAudioData(s.file!.slice(0)); // resampled to the context rate; slice: decoding detaches its input
    d = new Float32Array(ab.length);
    for (let c = 0; c < ab.numberOfChannels; c++) ab.getChannelData(c).forEach((v, i) => d[i] += v / ab.numberOfChannels);
  }
  node!.port.postMessage({ k: 'smp', tr, d } satisfies SmpMsg, [d.buffer]);
}
function dropSample(tr: number) {
  smpName[tr] = ''; saved[tr] = undefined; idb('readwrite', s => s.delete(tr)).catch(() => {});
  node?.port.postMessage({ k: 'smp', tr, d: new Float32Array(0) } satisfies SmpMsg);
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
// .syx for a real Machinedrum (send it with C6 / mddt): kit, used patterns, song, ROM samples; see src/syx.ts for what carries over
const SR = 44100;
async function pcm(x: Saved): Promise<Sample> {
  if (x.voice) return { slot: 0, rate: SR, d: voice(x.voice, SR, seeded(x.voice)) };
  const ab = await new OfflineAudioContext(1, 1, SR).decodeAudioData(x.file!.slice(0)), d = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) ab.getChannelData(c).forEach((v, i) => d[i] += v / ab.numberOfChannels);
  return { slot: 0, rate: SR, d };
}
$('syx').onclick = async () => {
  try {
    stash();
    await restored;
    const smp = await Promise.all(saved.map(x => x ? pcm(x).catch(() => undefined) : undefined));
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([stateSyx(st, smp)])), download: `machinedrum-${new Date().toISOString().slice(0, 10)}.syx` });
    a.click(); URL.revokeObjectURL(a.href);
    flash('SYX EXPORTED');
  } catch (e) { flash('SYX FAILED: ' + (e as Error).message.toUpperCase().slice(0, 30)); }
};
// imported .syx files (kits, patterns, songs, SDS samples) stay here; patterns go to their slots, the song to SONG mode.
// The PAT menu picks a pattern and loads its kit (we keep one kit, the MD has one per pattern)
let dump: Dump = { kits: [], pats: [], songs: [], samples: [] };
const patSel = $('pat') as HTMLSelectElement;
async function usePattern(i: number) {
  const p = dump.pats[i], k = p ? dump.kits.find(k => k[9] === patKit(p)) ?? dump.kits[0] : dump.kits[0];
  const s = structuredClone(st);
  const slots = k ? applyKit(k, s) : [];
  Object.assign(st, s);
  if (p) { st.pat = p[9] & 0x7f; Object.assign(st, structuredClone(st.pats[st.pat]!)); } // not usePat: its stash() would write the old pattern over the imported one
  save(); applyFx();
  await ensureAudio();
  for (const [tr, slot] of slots.entries()) {
    const x = dump.samples.find(x => x.slot === slot);
    if (x) await setSample(tr, { name: 'ROM-' + String(slot + 1).padStart(2, '0'), file: wav(x) }).catch(() => {});
  }
  flash((p ? patName(p) + ' ' : '') + (k ? kitName(k) : ''));
}
patSel.onchange = () => usePattern(+patSel.value);
const importer = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json,.syx', multiple: true });
importer.onchange = async () => {
  const files = [...importer.files ?? []]; importer.value = '';
  const f = files[0];
  if (!f) return;
  try {
    const bufs = await Promise.all(files.map(async f => new Uint8Array(await f.arrayBuffer())));
    if (bufs.every(b => b[0] === 0xf0)) {   // .syx: kits / patterns replace the previous ones, samples add up
      const ds = bufs.map(parseSyx), kits = ds.flatMap(d => d.kits), pats = ds.flatMap(d => d.pats).filter(p => !isEmpty(p));
      dump = { kits: kits.length ? kits : dump.kits, pats: pats.length || kits.length ? pats : dump.pats, songs: [], samples: [...ds.flatMap(d => d.samples), ...dump.samples] };
      stash();
      for (const p of ds.flatMap(d => d.pats)) { const { trig, lock } = readPattern(p); st.pats[p[9] & 0x7f] = { trig, lock }; }
      if (pats.length) st.swing = readPattern(pats[0]).swing;
      const songs = ds.flatMap(d => d.songs);
      if (songs.length) { st.song = readSong(songs[0]); const r = st.song[0]; if (isPat(r) && r.bpm) tempo.set(r.bpm); }
      patSel.replaceChildren(...dump.pats.map((p, i) => new Option(patName(p) + ' ' + kitName(dump.kits.find(k => k[9] === patKit(p)) ?? dump.kits[0] ?? new Uint8Array(26)), String(i))));
      patSel.hidden = dump.pats.length < 2;
      await usePattern(0); drawBank(); renderSong(); return;
    }
    const b = JSON.parse(await f.text()) as Bundle;
    if (b?.app !== 'machinedrum-web' || !valid(b.st) || !Array.isArray(b.samples)) throw new Error('not a machinedrum-web file');
    $('stop').click();
    Object.assign(st, b.st); save(); tempo.set(st.tempo); applyFx();
    await ensureAudio();
    for (let tr = 0; tr < 16; tr++) dropSample(tr);
    for (const x of b.samples) {
      if (!Number.isInteger(x?.tr) || x.tr < 0 || x.tr > 15 || typeof x.name !== 'string') continue;
      const file = typeof x.file === 'string' ? await (await fetch('data:application/octet-stream;base64,' + x.file)).arrayBuffer() : undefined;
      const voiceName = typeof x.voice === 'string' && VOICES.includes(x.voice) ? x.voice : undefined;
      if (file || voiceName) await setSample(x.tr, { name: x.name.slice(0, 12), file, voice: voiceName }).catch(() => {});
    }
    drawBank(); renderSong(); flash('IMPORTED');
  } catch (e) { flash('IMPORT FAILED: ' + (e as Error).message.toUpperCase().slice(0, 30)); }
};
$('import').onclick = () => importer.click();

// ---- EXP WAV: the song rendered off line (song mode's rows, the master effects, LEVEL and the limiter) ----
// The meter report goes to the LCD and the console ("[render] {...}", also window.md.report); shift-click = also
// a WAV per sounding track (stems)
const download = (blob: Blob, name: string) => { const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); };
$('wav').onclick = async (ev: MouseEvent) => {
  if (!st.song.length) { flash('WAV: MAKE A SONG FIRST (SONG MODE)'); return; }
  msg = 'RENDERING...'; draw(); await new Promise(r => setTimeout(r, 30)); // let the LCD show it before the CPU is busy
  try {
    stash(); await restored;
    const smp = await Promise.all(saved.map((x, tr) => x && st.kit[tr].m === ROM ? pcm(x).then(s => s.d).catch(() => undefined) : undefined));
    const base = `machinedrum-${new Date().toISOString().slice(0, 10)}`, r = await renderWav(st, smp, level, mnm.state(), ev.shiftKey, await getWasm());
    download(r.wav, base + '.wav');
    for (const s of r.stems ?? []) { await new Promise(ok => setTimeout(ok, 400)); download(s.wav, `${base}-${s.name}.wav`); } // Chrome drops a burst of ~10+
    console.log('[render]', JSON.stringify(r.report));
    Object.assign(window, { mdReport: r.report }); // for scripted exports
    flash(`WAV ${r.report.lufs} LUFS ${r.report.tp} DBTP`);
  } catch (e) { flash('WAV FAILED: ' + (e as Error).message.toUpperCase().slice(0, 30)); }
};

// ---- VOICE: a built-in voice on the selected ROM track ----
const voiceSel = $('voice') as HTMLSelectElement;
voiceSel.replaceChildren(new Option('VOICE', ''), ...VOICES.map(v => new Option(v, v)));
voiceSel.onchange = async () => {
  const v = voiceSel.value; voiceSel.value = '';
  if (!v) return;
  await ensureAudio(); await setSample(cur, { name: v, voice: v }); draw();
};


// ---- patterns: A01-H16 menu, COPY / PASTE ----
const bankSel = $('bank') as HTMLSelectElement;
const used = (p: Pat | null) => !!p?.trig.some(r => r.some(Boolean));
const drawBank = () => { stash(); bankSel.replaceChildren(...st.pats.map((p, n) => new Option(slotName(n) + (used(p) ? ' *' : ''), String(n)))); };
bankSel.onchange = () => {
  const n = +bankSel.value;
  if (!playing) usePat(n);
  else if (!songMode) { queued = n; draw(); } // takes over at the end of the pattern
  else draw(); // the song picks the patterns
};
let clip: Pat | null = null;
$('copy').onclick = () => { clip = structuredClone({ trig: st.trig, lock: st.lock }); flash(slotName(st.pat) + ' COPIED'); };
$('paste').onclick = () => { if (!clip) return; Object.assign(st, structuredClone(clip)); save(); flash('PASTED TO ' + slotName(st.pat)); };

// ---- song editor: one row per line; the row number starts the song there (while playing: after this row) ----
const songEl = $('song');
const LIM: Record<string, [number, number]> = { rep: [1, 64], of: [1, 16], len: [1, 16], bpm: [30, 300], loop: [1, 256], times: [0, 64] };
const kinds = st.pats.map((_, n) => `<option value="${n}">${slotName(n)}</option>`).join('') + '<option value="loop">LOOP</option><option value="end">END</option>';
const num = (f: string, v: number | string, title = '') => `<input type="number" data-f="${f}" min="${LIM[f][0]}" max="${LIM[f][1]}" value="${v}" title="${title}">`;
const newRow = (): PatRow => ({ pat: st.pat, rep: 1, of: 0, len: 16, bpm: null, mute: 0 });
function rowHtml(r: Row, i: number) {
  const cells = isPat(r)
    ? `<td>×${num('rep', r.rep, 'repeats')}</td><td>OF${num('of', r.of + 1, 'first step')}</td><td>LEN${num('len', r.len, 'last step')}</td>`
      + `<td>BPM<input type="number" data-f="bpm" min="30" max="300" value="${r.bpm ?? ''}" placeholder="---" title="empty = keep the tempo"></td>`
      + `<td class="mut">${TRACKS.map((n, k) => `<button data-t="${k}" class="${r.mute >> k & 1 ? 'on' : ''}" title="mute ${n}">${n}</button>`).join('')}</td>`
    : 'loop' in r ? `<td colspan="3">${r.loop < i ? 'LOOP' : r.loop > i ? 'JUMP' : 'HALT'} TO ${num('loop', r.loop + 1, 'row')}</td>`
      + (r.loop < i ? `<td colspan="2">×${num('times', r.times, '0 = ∞')}${r.times ? '' : ' ∞'}</td>` : '<td colspan="2"></td>')
    : '<td colspan="5"></td>';
  return `<tr data-r="${i}"><td><button class="go" title="start here">${String(i + 1).padStart(3, '0')}</button></td><td><select data-f="kind">${kinds}</select></td>${cells}`
    + `<td><button class="ins" title="duplicate this row below">+</button><button class="del" title="delete this row">−</button></td></tr>`;
}
function renderSong() {
  songEl.innerHTML = `<table>${st.song.map(rowHtml).join('')}</table><button class="key" id="addrow">+ ROW</button><button class="key" id="clrsong">CLEAR SONG</button>`
    + `<div class="auto">AUTOMATION (song mode, EXP WAV): click = add a point, drag = move, double-click = delete${(st.auto ?? []).map(laneHtml).join('')}`
    + `<button class="key" id="addlane">+ LANE</button></div>`;
  songEl.querySelectorAll<HTMLSelectElement>('tr select').forEach((el, i) => { const r = st.song[i]; el.value = isPat(r) ? String(r.pat) : 'loop' in r ? 'loop' : 'end'; });
  songEl.querySelectorAll<HTMLCanvasElement>('.lane canvas').forEach((c, i) => { c.width = c.clientWidth; drawLane(c, st.auto![i]); laneDrag(c, st.auto![i]); });
  draw();
}

// ---- automation lanes: [bar, value] points over the song's bars (the pattern rows' repeats, loops not unrolled)
const songLen = () => Math.max(1, st.song.reduce((n, r) => n + (isPat(r) ? Math.max(1, r.rep) : 0), 0));
const parLabels = (tr: number) => tr < 16 ? MACHINES[st.kit[tr].m].labels.concat(FX_LABELS, ROUTE_LABELS) : mnm.labels(tr - 16);
const opts = (names: string[], v: number) => names.map((n, k) => n ? `<option value="${k}"${k === v ? ' selected' : ''}>${n}</option>` : '').join('');
const laneHtml = (a: Lane, i: number) => `<div class="lane" data-a="${i}"><select data-f="tr">${opts([...TRACKS, ...[1, 2, 3, 4, 5, 6].map(k => `MN${k}`)], a.tr)}</select>`
  + `<select data-f="par">${opts(parLabels(a.tr), a.par)}</select><button class="dlane" title="delete this lane">−</button><canvas height="64"></canvas></div>`;
const LH = 64, PR = 5;
const lx = (c: HTMLCanvasElement, bar: number) => PR + bar / songLen() * (c.width - 2 * PR), ly = (v: number) => PR + (127 - v) / 127 * (LH - 2 * PR);
function drawLane(c: HTMLCanvasElement, a: Lane) {
  const g = c.getContext('2d')!, fg = getComputedStyle(songEl).color, n = songLen();
  g.clearRect(0, 0, c.width, LH); g.strokeStyle = g.fillStyle = fg;
  g.globalAlpha = 0.25; for (let b = 0; b <= n; b += 16) g.fillRect(Math.round(lx(c, b)), 0, 1, LH);   // every 16 bars
  g.globalAlpha = 1; g.beginPath();
  const pts: [number, number][] = a.pts.length ? a.pts : [[0, 64]];
  g.moveTo(lx(c, 0), ly(laneAt(pts, 0)));
  for (const [b, v] of pts) g.lineTo(lx(c, b), ly(v));
  g.lineTo(lx(c, n), ly(laneAt(pts, n))); g.stroke();
  for (const [b, v] of a.pts) g.fillRect(lx(c, b) - 3, ly(v) - 3, 6, 6);
}
function laneDrag(c: HTMLCanvasElement, a: Lane) {
  const at = (e: MouseEvent): [number, number] => {
    const r = c.getBoundingClientRect(), x = (e.clientX - r.left) * c.width / r.width, y = e.clientY - r.top;
    return [Math.max(0, Math.min(songLen(), Math.round((x - PR) / (c.width - 2 * PR) * songLen()))), Math.max(0, Math.min(127, Math.round(127 - (y - PR) / (LH - 2 * PR) * 127)))];
  };
  const near = (e: MouseEvent) => { const r = c.getBoundingClientRect(); return a.pts.find(([b, v]) => Math.hypot(lx(c, b) - (e.clientX - r.left) * c.width / r.width, ly(v) - (e.clientY - r.top)) < 7); };
  c.onpointerdown = e => {
    let q = near(e);
    if (!q) { q = at(e); a.pts.push(q); }
    c.setPointerCapture(e.pointerId);
    const move = (m: MouseEvent) => { [q![0], q![1]] = at(m); a.pts.sort((x, y) => x[0] - y[0]); drawLane(c, a); };
    move(e);
    c.onpointermove = move;
    c.onpointerup = () => { c.onpointermove = c.onpointerup = null; save(); };
  };
  c.ondblclick = e => { const q = near(e); if (q) { a.pts.splice(a.pts.indexOf(q), 1); drawLane(c, a); save(); } };
}
// rows moved by an insert / delete at i: LOOP / JUMP targets below it follow them
const shift = (i: number, d: number) => st.song.forEach(r => { if ('loop' in r && r.loop > i) r.loop += d; });
songEl.onchange = e => {
  const el = e.target as HTMLInputElement, lane = el.closest<HTMLElement>('.lane');
  if (lane) {
    const a = st.auto![+lane.dataset.a!];
    if (el.dataset.f === 'tr') { a.tr = +el.value; if (!parLabels(a.tr)[a.par]) a.par = parLabels(a.tr).findIndex(Boolean); } else a.par = +el.value;
    save(); renderSong(); return;
  }
  const i = +el.closest('tr')!.dataset.r!, f = el.dataset.f!, r = st.song[i];
  if (f === 'kind') st.song[i] = el.value === 'end' ? { end: true } : el.value === 'loop' ? { loop: Math.max(0, i - 1), times: 2 } : isPat(r) ? { ...r, pat: +el.value } : { ...newRow(), pat: +el.value };
  else {
    const [lo, hi] = LIM[f], v = el.value === '' ? null : Math.max(lo, Math.min(hi, Math.round(+el.value) || lo));
    const o = r as unknown as Record<string, number | null>;
    o[f] = f === 'bpm' ? v : (v ?? lo) - (f === 'of' || f === 'loop' ? 1 : 0); // OF and TO show 1-based
    if (isPat(r) && r.of >= r.len) { if (f === 'of') r.len = r.of + 1; else r.of = r.len - 1; }
  }
  save(); renderSong();
};
songEl.onclick = e => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  if (b.id === 'addrow') { if (st.song.length < 256) st.song.push(newRow()); }
  else if (b.id === 'addlane') { const v = st.kit[cur].p[13]; (st.auto ??= []).push({ tr: cur, par: 13, pts: [[0, v], [songLen(), v]] }); }   // FLTW of the track in hand
  else if (b.classList.contains('dlane')) st.auto!.splice(+b.closest<HTMLElement>('.lane')!.dataset.a!, 1);
  else if (b.id === 'clrsong') { if (!st.song.length || !confirm('Delete all song rows?')) return; $('stop').click(); st.song = []; songRow = 0; }
  else {
    const i = +b.closest('tr')!.dataset.r!, r = st.song[i];
    if (b.classList.contains('go')) { if (playing && songMode) cue = i; else songRow = i; }
    else if (b.classList.contains('ins')) { if (st.song.length < 256) { shift(i, 1); st.song.splice(i + 1, 0, structuredClone(r)); } }
    else if (b.classList.contains('del')) { st.song.splice(i, 1); shift(i, -1); if (songRow >= st.song.length) songRow = 0; }
    else if (b.dataset.t && isPat(r)) r.mute ^= 1 << +b.dataset.t;
  }
  save(); renderSong();
};
$('songkey').onclick = () => {
  $('stop').click(); songMode = !songMode; songEl.hidden = !songMode;
  $('songkey').classList.toggle('on', songMode); renderSong();
};

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
const songStat = () => !st.song.length ? 'SONG - ADD A ROW' : `SONG ROW ${String(songRow + 1).padStart(3, '0')}`
  + (sp ? ` ${slotName(st.pat)} ${sp.left - 1 ? sp.left - 1 + ' MORE' : ''}` : playing ? ' END' : '') + (cue >= 0 ? ` > ${String(cue + 1).padStart(3, '0')}` : '');
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
  voiceSel.hidden = t.m !== ROM;
  $('lengine').textContent = engine;
  $('lpat').textContent = slotName(st.pat) + (queued >= 0 ? '>' + slotName(queued) : '');
  bankSel.value = String(st.pat); bankSel.options[st.pat].text = slotName(st.pat) + (st.trig.some(r => r.some(Boolean)) ? ' *' : '');
  songEl.querySelectorAll('tr').forEach((tr, i) => { tr.classList.toggle('cur', i === songRow); tr.classList.toggle('cue', i === cue); });
  $('lgrid').innerHTML = labs.map((lab, k) =>
    `<span class="${!lab ? 'off' : lockOf(k) !== undefined ? 'lk' : ''}"><i>${lab || '----'}</i><b>${lab ? pad(val(k)) : ''}</b></span>`).join('');
  $('lstat').textContent = msg ? msg : held >= 0 ? `LOCK STEP ${held + 1} - TURN AN ENCODER${latched ? ' / CLICK A TRIG TO RELEASE' : ''}` : songMode ? songStat() : PAGES[page];
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
drawBank();
draw();
