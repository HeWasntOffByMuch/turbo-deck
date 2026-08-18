// Dev-only: the cross a click leaves, frame by frame (spec 175).
// `npx tsx scripts/preview-order-mark.ts`
//
// Writes .claude/screenshots/order-mark.png -- one row per zoom, one column per
// tick, through the game's own RetroPass at the game's own virtual resolution.
//
// ## Why a strip and not a tile
//
// This effect is a *third of a second*, and everything about whether it works is
// in how it arrives and how it leaves: the two marks draw themselves out over
// the first few ticks and retract over the last few, both in the vertex shader
// off the particle's age. `preview-vfx-library.ts` photographs every effect at
// the single tick that holds the most particles, which for a two-particle effect
// is the first tick it tries -- a picture of the middle of the life and nothing
// about the shape of it. The contact sheet is still the right place to check
// that this sits beside its neighbours; this is the only place the *motion* can
// be looked at without a browser open beside a stopwatch.
//
// Two rows, and the top one is the one that matters: the gameplay framing, where
// the whole question is whether a mark four pixels wide still reads as paint.
// The bottom row is the same frames close up, where the silhouette can actually
// be judged -- a stroke that has gone stubby or bent into a comma is invisible
// at 28 pixels long and obvious at four times that.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { PROBE_BACKGROUND } from '../src/render/iso3d/vfx/probe-config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4329;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/**
 * The ticks worth a column, out of the twenty the effect lives.
 *
 * Dense at both ends and sparse in the middle, because that is where the change
 * is: the marks are drawn out over the first three ticks and taken back over the
 * last seven, and the eight in between are one held pose.
 */
const TICKS = [1, 2, 3, 5, 8, 11, 13, 15, 17, 19, 21];

/** World half-heights the two rows are framed at: as played, and close up. */
const ZOOMS = [90, 46];

/**
 * How wide a column is, cropped out of the probe canvas.
 *
 * Biased below centre, because the probe plays an effect at y = 24 and this one
 * hangs half its length below where it is played -- the crop that fits every
 * other effect in the library cuts the bottom two arms off this one.
 */
const COLUMN_W = 240;
const COLUMN_H = 240;
const COLUMN_DROP = 40;

async function waitForServer(url: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`dev server never came up at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Pixels that are neither the probe's sky nor its ground: the mark itself. */
function inkBox(png: PNG): { count: number; width: number; height: number } {
  let count = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const sky = [(PROBE_BACKGROUND >> 16) & 255, (PROBE_BACKGROUND >> 8) & 255, PROBE_BACKGROUND & 255];
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const at = (y * png.width + x) * 4;
      const r = png.data[at] ?? 0;
      const g = png.data[at + 1] ?? 0;
      const b = png.data[at + 2] ?? 0;
      // The mark is the brightest thing in a dark scene by a mile, so a
      // luminance floor separates it from both the sky and the grey ground with
      // no assumption about which palette entry it landed on.
      const bright = (r + g + b) / 3;
      if (bright < 110 || (r === sky[0] && g === sky[1] && b === sky[2])) continue;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (count === 0) return { count: 0, width: 0, height: 0 };
  return { count, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function main(): Promise<void> {
  const shots = join(root, '.claude', 'screenshots');
  if (!existsSync(shots)) mkdirSync(shots, { recursive: true });

  const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });
  const rows: PNG[][] = [];
  const measured: string[] = [];

  try {
    await waitForServer(`http://localhost:${PORT}/vfx-probe.html`);
    const page = await browser.newPage({ viewport: { width: 1000, height: 660 } });
    const logs: string[] = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));
    await page.goto(`http://localhost:${PORT}/vfx-probe.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.vfxProbe !== undefined, undefined, { timeout: 30_000 });

    for (const halfHeight of ZOOMS) {
      const row: PNG[] = [];
      for (const ticks of TICKS) {
        const report = await page.evaluate(
          ([count, half]) => window.vfxProbe?.shot('order_move', count as number, half as number),
          [ticks, halfHeight] as const,
        );
        const buffer = await page.locator('#probe-canvas').screenshot();
        const png = PNG.sync.read(buffer);
        row.push(png);
        if (halfHeight === ZOOMS[0]) {
          const ink = inkBox(png);
          measured.push(
            `  tick ${String(ticks).padStart(2)}  ${String(report?.particles ?? 0)} particles` +
              `  ${String(ink.count).padStart(5)} px of ink  ${ink.width}x${ink.height}`,
          );
        }
      }
      rows.push(row);
    }

    const shaderProblems = logs.filter((line) => /error|could not compile/i.test(line) && !/favicon|404/i.test(line));
    if (shaderProblems.length > 0) throw new Error(shaderProblems.join('\n'));
  } finally {
    await browser.close();
    server.kill();
  }

  const first = rows[0]?.[0];
  if (!first) throw new Error('no frames were captured');
  const cropX = Math.floor((first.width - COLUMN_W) / 2);
  const cropY = Math.floor((first.height - COLUMN_H) / 2) + COLUMN_DROP;
  const sheet = new PNG({ width: COLUMN_W * TICKS.length, height: COLUMN_H * rows.length });
  rows.forEach((row, r) => {
    row.forEach((png, c) => {
      for (let y = 0; y < COLUMN_H; y++) {
        for (let x = 0; x < COLUMN_W; x++) {
          const from = ((cropY + y) * png.width + cropX + x) * 4;
          const to = ((r * COLUMN_H + y) * sheet.width + c * COLUMN_W + x) * 4;
          sheet.data[to] = png.data[from] ?? 0;
          sheet.data[to + 1] = png.data[from + 1] ?? 0;
          sheet.data[to + 2] = png.data[from + 2] ?? 0;
          sheet.data[to + 3] = 255;
        }
      }
    });
  });

  const out = join(shots, 'order-mark.png');
  writeFileSync(out, PNG.sync.write(sheet));
  console.log(`wrote ${out}`);
  console.log(`\n  order_move, at the gameplay framing (${ZOOMS[0]} units of half-height):\n`);
  for (const line of measured) console.log(line);
  console.log('\n  top row as played, bottom row close up. Ticks:', TICKS.join(', '));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
