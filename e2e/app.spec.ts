import { test, expect, type Page } from '@playwright/test';

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});
test.afterEach(() => expect(errors).toEqual([]));

// Peak of the output over ms
const outPeak = (page: Page, ms: number) => page.evaluate(async ms => {
  const md = (window as unknown as { md: { ctx: AudioContext; out: GainNode } }).md, an = md.ctx.createAnalyser(), buf = new Float32Array(an.fftSize);
  md.out.connect(an);
  let pk = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    an.getFloatTimeDomainData(buf);
    for (const x of buf) pk = Math.max(pk, Math.abs(x));
    await new Promise(r => setTimeout(r, 10));
  }
  return pk;
}, ms);

test('default pattern plays on the WASM engine at a sane level', async ({ page }) => {
  await page.click('#play');
  await expect(page.locator('#lengine')).toHaveText('WASM');
  const pk = await outPeak(page, 1500);
  expect(pk).toBeGreaterThan(0.1);
  expect(pk).toBeLessThan(1.5);
});

test('mouse: press a trig, release on an encoder (latch), drag it = parameter lock', async ({ page }) => {
  const step = page.locator('#trigs button').nth(2), enc = page.locator('#encs .enc').first();
  const c = async (l: typeof step) => { const b = (await l.boundingBox())!; return [b.x + b.width / 2, b.y + b.height / 2] as const; };
  const [sx, sy] = await c(step), [ex, ey] = await c(enc);
  await page.mouse.move(sx, sy); await page.mouse.down();
  await page.mouse.move(ex, ey, { steps: 5 }); await page.mouse.up(); // latched
  await page.mouse.down(); await page.mouse.move(ex, ey - 40, { steps: 5 }); await page.mouse.up();
  await expect(step).toHaveClass(/lock/);
  await expect(step).toHaveClass(/on/);
  await step.click(); // releases the latch without toggling
  await expect(step).toHaveClass(/on/);
  await expect(page.locator('#lstat')).toHaveText('SYNTHESIS');
});

test('falls back to the JS engine when the WASM file is blocked', async ({ page }) => {
  await page.route('**/*.wasm', r => r.abort());
  await page.click('#play');
  await expect(page.locator('#lengine')).toHaveText('JS');
  expect(await outPeak(page, 1000)).toBeGreaterThan(0.1);
  errors = errors.filter(e => !/wasm|Failed to load/i.test(e));
});

// 0.5 s 16-bit mono WAV of a 330 Hz sine
function wav(): Buffer {
  const sr = 44100, n = sr / 2, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / sr * 2 * Math.PI * 330) * 16000), 44 + i * 2);
  return b;
}

test('LOAD SMP puts a WAV on the track as a ROM machine, it plays and survives a reload', async ({ page }) => {
  await page.locator('#tracks button').nth(13).click(); // M2
  const chooser = page.waitForEvent('filechooser');
  await page.click('#load');
  await (await chooser).setFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: wav() });
  await expect(page.locator('#lmach')).toHaveText('ROM:TONE');
  const pk = outPeak(page, 400);
  await page.locator('#tracks button').nth(13).click();
  expect(await pk).toBeGreaterThan(0.05);
  // the sample survives a reload (IndexedDB)
  await page.reload();
  await page.locator('#tracks button').nth(13).click();
  await expect(page.locator('#lmach')).toHaveText('ROM:TONE');
  await page.waitForTimeout(300); // decode of the restored sample
  const pk2 = outPeak(page, 400);
  await page.locator('#tracks button').nth(13).click();
  expect(await pk2).toBeGreaterThan(0.05);
});

test('EXPORT then IMPORT brings back the pattern and samples', async ({ page }) => {
  await page.locator('#tracks button').nth(13).click();
  const chooser = page.waitForEvent('filechooser');
  await page.click('#load');
  await (await chooser).setFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: wav() });
  await expect(page.locator('#lmach')).toHaveText('ROM:TONE');
  await page.locator('#trigs button').nth(5).click();
  const on = await page.locator('#trigs button').nth(5).getAttribute('class');
  const dl = page.waitForEvent('download');
  await page.click('#export');
  const file = await (await dl).path();
  // wipe everything, then import
  await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('md-web'); });
  await page.reload();
  await page.locator('#tracks button').nth(13).click();
  await expect(page.locator('#lmach')).not.toHaveText('ROM:TONE');
  const ic = page.waitForEvent('filechooser');
  await page.click('#import');
  await (await ic).setFiles(file);
  await expect(page.locator('#lstat')).toHaveText('IMPORTED');
  await page.locator('#tracks button').nth(13).click();
  await expect(page.locator('#lmach')).toHaveText('ROM:TONE');
  expect(await page.locator('#trigs button').nth(5).getAttribute('class')).toBe(on);
  const pk = outPeak(page, 400);
  await page.locator('#tracks button').nth(13).click();
  expect(await pk).toBeGreaterThan(0.05);
});

test('IMPORT rejects a file that is not ours', async ({ page }) => {
  const ic = page.waitForEvent('filechooser');
  await page.click('#import');
  await (await ic).setFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"kit":[]}') });
  await expect(page.locator('#lstat')).toContainText('IMPORT FAILED');
});

test('EXP SYX then IMPORT of the .syx brings back the pattern', async ({ page }) => {
  await page.locator('#trigs button').nth(3).click();
  const on = await page.locator('#trigs button').nth(3).getAttribute('class');
  const dl = page.waitForEvent('download');
  await page.click('#syx');
  const file = await (await dl).path();
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const ic = page.waitForEvent('filechooser');
  await page.click('#import');
  await (await ic).setFiles({ name: 'k.syx', mimeType: 'application/octet-stream', buffer: (await import('fs')).readFileSync(file) });
  await expect(page.locator('#lstat')).toHaveText(/A01 MD-WEB/);
  expect(await page.locator('#trigs button').nth(3).getAttribute('class')).toBe(on);
});

test('IMPORT of a .syx during the DEMO stops the demo', async ({ page }) => {
  const dl = page.waitForEvent('download');
  await page.click('#syx');
  const file = await (await dl).path();
  await page.click('#demo');
  await expect(page.locator('#play')).toHaveClass(/on/);
  const ic = page.waitForEvent('filechooser');
  await page.click('#import');
  await (await ic).setFiles(file);
  await expect(page.locator('#lstat')).toHaveText(/A01 MD-WEB/);
  await expect(page.locator('#play')).not.toHaveClass(/on/);
});

test('SONG: rows play their patterns in order, the song stops at its end and survives a reload', async ({ page }) => {
  // A02 gets a pattern of its own
  await page.selectOption('#bank', '1');
  await expect(page.locator('#lpat')).toHaveText('A02');
  await page.locator('#trigs button').nth(0).click();
  await page.click('#songkey');
  await expect(page.locator('#lstat')).toHaveText('SONG - ADD A ROW');
  await page.click('#addrow'); // a new row takes the current pattern
  await page.locator('#song tr').nth(0).locator('select').selectOption('0');
  await page.locator('#song tr').nth(0).locator('[data-f=len]').fill('4');
  await page.locator('#song tr').nth(0).locator('[data-f=len]').dispatchEvent('change');
  await page.click('#addrow');
  await page.locator('#song tr').nth(1).locator('[data-f=len]').fill('4');
  await page.locator('#song tr').nth(1).locator('[data-f=len]').dispatchEvent('change');
  await page.click('#play');
  await expect(page.locator('#lstat')).toContainText('SONG ROW 001 A01');
  await expect(page.locator('#lstat')).toContainText('SONG ROW 002 A02');
  await expect(page.locator('#play')).not.toHaveClass(/on/, { timeout: 5000 }); // END: stops by itself
  await expect(page.locator('#lstat')).toHaveText('SONG ROW 001');
  await page.reload();
  await page.click('#songkey');
  await expect(page.locator('#song tr')).toHaveCount(2);
  await expect(page.locator('#song tr').nth(1).locator('select')).toHaveValue('1');
});

test('a save from before patterns / songs still loads as A01', async ({ page }) => {
  await page.locator('#trigs button').nth(1).click();
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('md-web-v1')!); delete s.pats; delete s.pat; delete s.song; localStorage.setItem('md-web-v1', JSON.stringify(s)); });
  await page.reload();
  await expect(page.locator('#lpat')).toHaveText('A01');
  await expect(page.locator('#trigs button').nth(0)).toHaveClass(/on/);
  await expect(page.locator('#trigs button').nth(1)).toHaveClass(/on/);
});

test('DEMO as .syx: EXP SYX during the demo, IMPORT it, SONG + PLAY plays it', async ({ page }) => {
  await page.click('#demo');
  await expect(page.locator('#play')).toHaveClass(/on/);
  const dl = page.waitForEvent('download');
  await page.click('#syx');
  const d = await dl;
  expect(d.suggestedFilename()).toBe('machinedrum-demo.syx');
  const file = await d.path();
  await page.click('#stop');
  await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('md-web'); });
  await page.reload();
  const ic = page.waitForEvent('filechooser');
  await page.click('#import');
  await (await ic).setFiles(file);
  await expect(page.locator('#lstat')).toHaveText(/A01 MD-WEB/);
  await expect(page.locator('#tempo')).toContainText('132');
  await page.locator('#tracks button').nth(13).click();   // ROM tracks in order: RC = ROM-01, M2 = ROM-02, M3 = ROM-03
  await expect(page.locator('#lmach')).toHaveText('ROM:ROM-02');
  await page.click('#songkey');
  expect(await page.locator('#song tr').count()).toBeGreaterThan(20);
  await page.click('#play');
  expect(await outPeak(page, 1500)).toBeGreaterThan(0.1);
});

test('CLEAR SONG deletes every song row (after a confirm)', async ({ page }) => {
  await page.click('#songkey');
  await page.click('#addrow'); await page.click('#addrow');
  await expect(page.locator('#song tr')).toHaveCount(2);
  page.once('dialog', d => d.dismiss());
  await page.click('#clrsong');
  await expect(page.locator('#song tr')).toHaveCount(2);
  page.once('dialog', d => d.accept());
  await page.click('#clrsong');
  await expect(page.locator('#song tr')).toHaveCount(0);
  await page.reload();
  await page.click('#songkey');
  await expect(page.locator('#song tr')).toHaveCount(0);
});

test('RESET FX puts the echo and gate box back to their defaults', async ({ page }) => {
  await page.click('#demo');
  await page.click('#stop');
  await page.click('#fxreset');
  await expect(page.locator('#lstat')).toHaveText('FX RESET');
  const fx = await page.evaluate(() => JSON.parse(localStorage.getItem('md-web-v1')!).fx);
  expect(fx).toEqual({ echo: [16, 60, 20, 90, 0, 0, 0, 100], gate: [0, 40, 20, 20, 100, 0, 0, 100] });
});
