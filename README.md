# MD-WEB 16

ブラウザで動く 16 トラックの DSP ドラムマシンです。Machinedrum 風のパネルで、AfterBirth（`../rebirth-web`）と同じ方法で作っています。DSP は AssemblyScript（`assembly/md.ts`）と TS（`src/dsp/md.ts`）の 2 本立てで、両者の出力が一致することをユニットテストで確認しています。AudioWorklet で動き、ランタイム依存はありません。

```sh
npm install
npm run dev     # http://localhost:5173
npm run check   # 型チェック + ユニットテスト + build + Playwright
```

- マシン: GND-SN/NS/IM, TRX-BD/SD/CH/OH/CP, EFM-BD/SD/CB/HH（すべて合成。サンプルは使っていません）
- トラックチェイン: AMD/AMF → EQF/EQG → FLTF/FLTW/FLTQ → SRR → DIST → VOL/PAN
- トリガーキーをクリック = ON/OFF、押したままエンコーダを回す = パラメータロック
- パターンとキットは localStorage に自動保存されます

## Disclaimer

非公式のファンプロジェクトです。Elektron とは関係ありません。
