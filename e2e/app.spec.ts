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

test('LOAD SMP puts a WAV on the track as a ROM machine and it plays', async ({ page }) => {
  await page.locator('#tracks button').nth(13).click(); // M2
  const chooser = page.waitForEvent('filechooser');
  await page.click('#load');
  await (await chooser).setFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: wav() });
  await expect(page.locator('#lmach')).toHaveText('ROM:TONE');
  const pk = outPeak(page, 400);
  await page.locator('#tracks button').nth(13).click();
  expect(await pk).toBeGreaterThan(0.05);
});
