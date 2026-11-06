# MD-WEB 16

**Live: https://verytired.github.io/machinedrum-web/**

A 16-track DSP drum machine in the browser, with a Machinedrum-style panel. It is built the same way as AfterBirth (rebirth-web): the DSP is written twice, once in AssemblyScript (`assembly/md.ts`) and once in TypeScript (`src/dsp/md.ts`), and a unit test checks that both render the same samples. It runs in an AudioWorklet and has no runtime dependencies.

```sh
npm install
npm run dev     # http://localhost:5173
npm run check   # typecheck + unit tests + build + Playwright
```

- Machines: GND-SN/NS/IM, TRX-BD/SD/CH/OH/CP, EFM-BD/SD/CB/HH (synthesized), plus ROM: load a WAV with LOAD SMP or drop one on a track key (PTCH / DEC / STRT / END, END < STRT plays it reversed; samples are kept in IndexedDB)
- Track chain: AMD/AMF → EQF/EQG → FLTF/FLTW/FLTQ → SRR → DIST → VOL/PAN → DEL/REV sends
- Master effects: Rhythm Echo (tempo-synced delay) and Gate Box (gated reverb)
- Click a track name to select it; click a trig key to toggle a step; hold a trig and turn an encoder for a parameter lock
- Factory content, as on the MD: songs placed in `src/factory/` (kept out of this repo) are loaded on a first run (nothing saved) into the patterns from A01 and the song, with their kit, voice samples and MNM part; press SONG, then PLAY. `?factory=N` resets to song N. Without that folder a first run starts blank
- EXP WAV renders the song (song mode) to a 16-bit stereo WAV at 44.1 kHz, off line through the same engine, effects, LEVEL and limiter. The VOICE menu (on a ROM track) puts one of the built-in voices on it
- Slide trigs (a lock on SLIDE): the note glides in from the one before without a retrigger, as on a 303; written to / read from the MD's per-track slide masks
- Patterns A01-H16 (menu next to COPY / PASTE; while playing, a new pattern waits for the end of the current one). SONG mode works as on the Machinedrum: rows of PAT / ×REP / OF / LEN / BPM / track mutes, plus LOOP rows (to an earlier row ×N or ∞ = LOOP, to a later row = JUMP, to itself = HALT) and END. PLAY again pauses, STOP holds the position, STOP twice goes back to row 1. One song; all patterns share the one kit
- The pattern and kit are saved to localStorage automatically; EXPORT / IMPORT writes and reads everything (samples included) as one JSON file
- EXP SYX writes Machinedrum SysEx: the kit, every used pattern (32-step pattern dumps, with swing), the song (tempo in its first row) and the ROM tracks' samples (Sample Dump Standard, ROM-01.. in track order). IMPORT reads .syx files, several at once: patterns go to their slots (first 16 steps), the first song to SONG mode, SDS samples to the ROM tracks that use their slot; a menu picks a pattern and loads its kit. Machines map by name, others to the nearest one we have (E12-BD -> TRX-BD etc., an approximation) or an empty ROM; LFOs, accents, slides and track levels are not carried. The writer matches [mddt](https://github.com/waftlord/mddt); the reader was checked on public hardware dumps (kits, patterns and songs). Writing to a real MD is still untested

## Disclaimer

This is an unofficial fan project. It is not affiliated with Elektron.
