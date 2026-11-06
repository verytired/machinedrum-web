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
- DEMO plays a built-in song
- The pattern and kit are saved to localStorage automatically; EXPORT / IMPORT writes and reads everything (samples included) as one JSON file
- EXP SYX writes the kit and pattern as Machinedrum SysEx (kit dump 0x52 + 32-step pattern dump 0x67); IMPORT also reads .syx files, several at once: kits, patterns (first 16 steps; a menu picks the pattern and loads its kit) and 16-bit Sample Dump Standard samples, which go to the ROM tracks that use their slot. Machines map by name, others to the nearest one we have (E12-BD -> TRX-BD etc., an approximation) or an empty ROM; LFOs, accents, track levels and tempo are not carried. The writer matches [mddt](https://github.com/waftlord/mddt) byte for byte; the reader was checked on public hardware dumps (388 kit / pattern messages, all checksums and p-locks consistent). Writing to a real MD is still untested

## Disclaimer

This is an unofficial fan project. It is not affiliated with Elektron.
