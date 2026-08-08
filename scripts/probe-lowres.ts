// Dev-only: check the fixed virtual resolution actually lands on whole device
// pixels, at several window sizes and several device pixel ratios (spec 089).
// Not part of the app. `npx tsx scripts/probe-lowres.ts`
//
// Requires a build first (`npm run build`); it serves `dist/` rather than the dev
// server, so what is measured is what ships.
//
// Three claims are checked, and only the last of them can be made by looking at
// numbers the page reports about itself:
//
//  1. the backing store is exactly the virtual buffer, whatever the window does;
//  2. the canvas is sized *and positioned* in whole device pixels, so the browser
//     has no reason to resample;
//  3. it really did not resample -- every scale x scale block of device pixels in
//     the finished frame is one uniform colour.
//
// (3) is the one that matters. Every size can be perfectly integral and the image
// still be filtered, if `image-rendering` is not doing what it is supposed to;
// and a factor chosen from CSS pixels instead of device pixels produces exactly
// that on a retina display while every number still looks right.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const PORT = 4322;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

const VIRTUAL_W = 480;
const VIRTUAL_H = 270;

/** Window sizes and ratios worth the round trip. */
const CASES = [
  { width: 1920, height: 1080, dpr: 1, note: 'exact 4x, no letterbox' },
  { width: 1003, height: 713, dpr: 1, note: 'odd remainder on both axes' },
  { width: 960, height: 540, dpr: 2, note: 'retina: must be 4x, not 2x' },
  { width: 800, height: 600, dpr: 3, note: 'dpr 3' },
] as const;

interface Measured {
  readonly backingWidth: number;
  readonly backingHeight: number;
  readonly rect: { x: number; y: number; width: number; height: number };
  readonly hudRect: { x: number; y: number; width: number; height: number };
  readonly dpr: number;
  readonly imageRendering: string;
}

async function waitForServer(url: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${url} never came up`);
}

/**
 * Turn the switch on through the panel the player uses, rather than by reaching
 * into the scene. If the cog or the label moves, this should break.
 */
async function enableLowRes(page: import('playwright').Page): Promise<void> {
  await page.click('button[aria-label="View settings"]');
  const row = page.locator('label', { hasText: 'Low-res buffer' }).first();
  await row.locator('input[type=checkbox]').check();
  await page.click('button[aria-label="View settings"]');
}

/**
 * True when every `scale` x `scale` block of device pixels is one flat colour.
 *
 * Sampled on a grid rather than exhaustively, and only inside the image, so a
 * letterbox edge cannot be mistaken for a block boundary.
 */
function blocksAreFlat(
  png: PNG,
  originX: number,
  originY: number,
  scale: number,
  blocksX: number,
  blocksY: number,
): { flat: boolean; checked: number; firstBad: string | null } {
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * png.width + x) * 4;
    return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0];
  };
  let checked = 0;
  let firstBad: string | null = null;

  // Every other block, one in off each edge: enough coverage to catch a filtered
  // image, few enough to stay quick. The whole image is fair game because the
  // caller hides the overlay before the shot.
  for (let by = 1; by < blocksY - 1; by += 2) {
    for (let bx = 1; bx < blocksX - 1; bx += 2) {
      const x0 = originX + bx * scale;
      const y0 = originY + by * scale;
      if (x0 + scale > png.width || y0 + scale > png.height) continue;
      const reference = at(x0, y0);
      checked++;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const p = at(x0 + dx, y0 + dy);
          if (p[0] !== reference[0] || p[1] !== reference[1] || p[2] !== reference[2]) {
            firstBad ??=
              `block (${bx},${by}) at device (${x0},${y0}): ` +
              `[${reference.join(',')}] vs [${p.join(',')}] at +${dx},+${dy}`;
          }
        }
      }
    }
  }
  return { flat: firstBad === null, checked, firstBad };
}

if (!existsSync(dist)) {
  console.error('no dist/ -- run `npm run build` first');
  process.exit(1);
}

// The binary directly, not through `npx`: `kill()` reaches the process it
// spawned, and killing the npx wrapper leaves the server holding the port. A
// leaked one from a previous run answers the readiness check happily, so the next
// run measures whatever that stale process is serving -- which cost an afternoon
// once already.
const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['preview', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});

let failed = false;
let browser: Browser | undefined;
try {
  await waitForServer(`http://localhost:${PORT}/`);
  browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  for (const testCase of CASES) {
    const context = await browser.newContext({
      viewport: { width: testCase.width, height: testCase.height },
      deviceScaleFactor: testCase.dpr,
    });
    const page = await context.newPage();
    const label = `${testCase.width}x${testCase.height} @${testCase.dpr}x`;
    try {
      // Pinned seed, for the same reason preview-world.ts pins one: without it
      // the view falls back to a clock and every run measures a different world.
      await page.goto(`http://localhost:${PORT}/?seed=20260806`, { waitUntil: 'load' });
      await page.waitForSelector('canvas', { timeout: 30_000 });
      // Let the world stream in and the camera settle before measuring.
      await page.waitForTimeout(2500);
      await enableLowRes(page);
      await page.waitForTimeout(600);

      const measured = (await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const hud = document.querySelector('canvas')?.parentElement?.querySelector('div[style*="pointer-events: none"]');
        const rect = canvas?.getBoundingClientRect();
        const hudBox = hud?.getBoundingClientRect();
        return {
          backingWidth: canvas?.width ?? 0,
          backingHeight: canvas?.height ?? 0,
          rect: { x: rect?.x ?? 0, y: rect?.y ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 0 },
          hudRect: { x: hudBox?.x ?? 0, y: hudBox?.y ?? 0, width: hudBox?.width ?? 0, height: hudBox?.height ?? 0 },
          dpr: globalThis.devicePixelRatio,
          imageRendering: canvas ? getComputedStyle(canvas).imageRendering : '',
        };
      })) as Measured;

      const problems: string[] = [];
      const dpr = measured.dpr;
      const scale = Math.round((measured.rect.width * dpr) / VIRTUAL_W);

      if (measured.backingWidth !== VIRTUAL_W || measured.backingHeight !== VIRTUAL_H) {
        problems.push(
          `backing store is ${measured.backingWidth}x${measured.backingHeight}, wanted ${VIRTUAL_W}x${VIRTUAL_H}`,
        );
      }
      if (Math.abs(measured.rect.width * dpr - VIRTUAL_W * scale) > 0.51) {
        problems.push(`width ${measured.rect.width}css x${dpr} is not ${VIRTUAL_W} x ${scale} device px`);
      }
      if (Math.abs(measured.rect.height * dpr - VIRTUAL_H * scale) > 0.51) {
        problems.push(`height ${measured.rect.height}css x${dpr} is not ${VIRTUAL_H} x ${scale} device px`);
      }
      for (const [name, value] of [['x', measured.rect.x], ['y', measured.rect.y]] as const) {
        const device = value * dpr;
        if (Math.abs(device - Math.round(device)) > 0.01) {
          problems.push(`${name} offset ${value}css is ${device} device px -- not on the device grid`);
        }
      }
      if (measured.imageRendering !== 'pixelated') {
        problems.push(`image-rendering is "${measured.imageRendering}", not pixelated`);
      }
      const hudMatches =
        Math.abs(measured.hudRect.x - measured.rect.x) < 0.51 &&
        Math.abs(measured.hudRect.y - measured.rect.y) < 0.51 &&
        Math.abs(measured.hudRect.width - measured.rect.width) < 0.51 &&
        Math.abs(measured.hudRect.height - measured.rect.height) < 0.51;
      if (!hudMatches) {
        problems.push(
          `the overlay is at ${JSON.stringify(measured.hudRect)} but the image is at ${JSON.stringify(measured.rect)}`,
        );
      }

      // And the claim the numbers cannot make: no resampling happened.
      //
      // The DOM has to go first. A screenshot composites the overlay over the
      // canvas, so the status line, the hotbar and -- the one that actually kept
      // firing -- the health bars floating over monsters all land inside the clip.
      // They are full-resolution text and thin bars, quite correctly not blocky,
      // which reads as a filtered upscale and is nothing of the kind.
      //
      // A stylesheet rather than inline styles: the overlay rebuilds elements as
      // bodies come and go, so anything set per-element can be gone by the time
      // the shot is taken. `visibility` inherits, and a descendant may override a
      // hidden ancestor, which is what makes these two rules enough.
      await page.addStyleTag({
        content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }',
      });
      // One frame for the compositor to act on it.
      await page.waitForTimeout(250);
      const shot = await page.screenshot({ clip: measured.rect });
      const png = PNG.sync.read(shot);
      const blocks = blocksAreFlat(png, 0, 0, scale, VIRTUAL_W, VIRTUAL_H);
      if (!blocks.flat) problems.push(`upscale is filtered, not nearest: ${blocks.firstBad}`);
      // Kept for the one case a human would want to look at, so the claim is
      // inspectable and not only asserted.
      if (testCase.dpr === 2) {
        mkdirSync(join(root, '.claude', 'screenshots'), { recursive: true });
        writeFileSync(join(root, '.claude', 'screenshots', 'lowres-probe.png'), shot);
      }

      if (problems.length > 0) failed = true;
      console.log(
        `${problems.length === 0 ? 'ok  ' : 'FAIL'}  ${label.padEnd(18)} scale ${scale}x  ` +
          `image ${measured.rect.width}x${measured.rect.height}css at (${measured.rect.x}, ${measured.rect.y})  ` +
          `${blocks.checked} blocks checked  -- ${testCase.note}`,
      );
      for (const problem of problems) console.log(`        ${problem}`);
    } catch (error) {
      failed = true;
      console.log(`FAIL  ${label} -- ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  server.kill();
}

if (failed) {
  console.error('\nthe virtual resolution is not landing on whole device pixels');
  process.exit(1);
}
console.log('\nevery window size and ratio upscales by whole device pixels, unfiltered');
