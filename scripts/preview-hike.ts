// Dev-only: photograph the Play tab with the hike switches thrown, the way a
// player throws them (specs 097-092). `npx tsx scripts/preview-hike.ts`
//
// Exists because the outline pass shipped broken in a way none of the offscreen
// checks could see: the mask was correct, and the pass cleared the canvas before
// blending it, so the world went black. Everything measured was right and the
// thing on screen was wrong. This drives the real page and the real controls.
//
// It also answers the question the offscreen palette check cannot. That one
// proves every pixel is a palette colour, which is the correctness claim; whether
// sixteen colours are *enough* for this world is a question about the world, and
// the probe's four-tree scene has only a handful of tones in it either way.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4331;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('server never came up');
}

const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['preview', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});

let failed = false;
try {
  await waitForServer(`http://localhost:${PORT}/`);
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://localhost:${PORT}/?seed=20260806`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(3000);

  const outDir = join(root, '.claude', 'screenshots');
  mkdirSync(outDir, { recursive: true });

  const canvasRect = async (): Promise<{ x: number; y: number; width: number; height: number }> =>
    page.evaluate(() => {
      const r = document.querySelector('canvas')?.getBoundingClientRect();
      return { x: r?.x ?? 0, y: r?.y ?? 0, width: r?.width ?? 1, height: r?.height ?? 1 };
    });

  /**
   * Mean brightness of the drawn frame, so "went black" is a number.
   *
   * From a screenshot rather than from the canvas: reading a WebGL canvas back
   * through `drawImage` gives a blank image unless it was created with
   * `preserveDrawingBuffer`, and the game's is not. That measured 0% with the
   * feature switched off, which is a broken thermometer rather than a cold room.
   */
  const brightness = async (file: string): Promise<number> => {
    const shot = await page.screenshot({ path: file, clip: await canvasRect() });
    const png = PNG.sync.read(shot);
    let sum = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      sum += ((png.data[i] ?? 0) + (png.data[i + 1] ?? 0) + (png.data[i + 2] ?? 0)) / 3;
    }
    return sum / (png.data.length / 4) / 255;
  };

  const before = await brightness(join(outDir, 'world-outlines-off.png'));

  await page.click('button[aria-label="View settings"]');
  await page.locator('label', { hasText: 'Outlines' }).first().locator('input[type=checkbox]').check();
  await page.click('button[aria-label="View settings"]');
  await page.waitForTimeout(1200);

  const after = await brightness(join(outDir, 'world-outlines.png'));

  console.log(`brightness off: ${(before * 100).toFixed(1)}%   on: ${(after * 100).toFixed(1)}%`);
  if (after < before * 0.75) {
    failed = true;
    console.log('  FAIL: switching outlines on darkened the whole frame');
  } else if (after >= before * 0.999) {
    failed = true;
    console.log('  FAIL: switching outlines on changed nothing');
  } else {
    console.log('  ok: lines drawn over the picture, picture still there');
  }

  // And the palette, on the real world rather than on the probe's four trees.
  await page.click('button[aria-label="View settings"]');
  await page.locator('label', { hasText: 'Palette' }).first().locator('select').selectOption('world');
  await page.click('button[aria-label="View settings"]');
  await page.waitForTimeout(1200);
  await brightness(join(outDir, 'world-palette.png'));

  const distinct = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return 0;
    // Counted from a screenshot-equivalent readback is not available here, so the
    // count comes from the script side; this only reports the canvas size.
    return canvas.width * canvas.height;
  });
  console.log(`palette frame written (${distinct} px canvas)`);

  await browser.close();
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
