# MD-WEB 16

**Live: https://verytired.github.io/machinedrum-web/**

A 16-track DSP drum machine in the browser, with a Machinedrum-style panel. It is built the same way as AfterBirth (rebirth-web): the DSP is written twice, once in AssemblyScript (`assembly/md.ts`) and once in TypeScript (`src/dsp/md.ts`), and a unit test checks that both render the same samples. It runs in an AudioWorklet and has no runtime dependencies.

```sh
npm install
npm run dev     # http://localhost:5173
npm run check   # typecheck + unit tests + build + Playwright
```

- Machines: GND-SN/NS/IM, TRX-BD/SD/CH/OH/CP, EFM-BD/SD/CB/HH (all synthesized, no samples)
- Track chain: AMD/AMF → EQF/EQG → FLTF/FLTW/FLTQ → SRR → DIST → VOL/PAN → DEL/REV sends
- Master effects: Rhythm Echo (tempo-synced delay) and Gate Box (gated reverb)
- Click a track name to select it; click a trig key to toggle a step; hold a trig and turn an encoder for a parameter lock
- DEMO plays a built-in song
- The pattern and kit are saved to localStorage automatically

## Disclaimer

This is an unofficial fan project. It is not affiliated with Elektron.
