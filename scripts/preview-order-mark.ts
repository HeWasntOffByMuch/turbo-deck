// Dev-only: the cross a click leaves, frame by frame and from several seats
// (spec 175). `npx tsx scripts/preview-order-mark.ts`
//
// Writes .claude/screenshots/order-mark.png -- columns are ticks, rows are
// framings and camera bearings, all through the game's own RetroPass at the
// game's own virtual resolution.
//
// ## Why a strip and not a tile
//
// This effect is a *third of a second*, and everything about whether it works is
// in how it arrives and how it leaves: the two marks draw themselves out over
// the first few ticks and come apart over the last few, both in the vertex
// shader off the particle's age. `preview-vfx-library.ts` photographs every
// effect at the single tick that holds the most particles, which for a
// two-particle effect is the first tick it tries -- a picture of the middle of
// the life and nothing about the shape of it.
//
// ## Why more than one bearing
//
// Because the mark is flat. A mark painted on the floor is squashed along the
// camera's own horizontal bearing and untouched across it, so two arms at a
// right angle foreshorten by different amounts depending where you stand -- and
// at one bearing in four, one arm lies along that axis and is drawn as a stub
// beside a full-length stroke. The yaws are authored 45 degrees either side of
// the default camera so the ordinary case is symmetric; the last row is the
// camera turned onto one of the arms, which is what the worst case actually
// looks like and the only honest way to decide it is acceptable.
//
// It uses the probe's `brush` entry rather than its `shot` entry for exactly
// that reason: `shot` fixes the camera so the library's forty tiles stay
// comparable, and this needs to move it.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { PROBE_BACKGROUND } from '../src/render/iso3d/vfx/probe-config.js';
import { DEFAULT_CAMERA_ORBIT, DEFAULT_VIEW_HALF_WIDTH } from '../src/render/iso3d/view-settings.js';
import { PROBE_VIRTUAL_H, PROBE_VIRTUAL_W } from '../src/render/iso3d/vfx/probe-config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4329;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/**
 * The ticks worth a column, out of the twenty the effect lives.
 *
 * Dense at both ends and sparse in the middle, because that is where the change
 * is: the marks are drawn out over the first three ticks and taken apart over
 * the last seven, and the eight in between are one held pose.
 */
const TICKS = [1, 2, 3, 5, 8, 11, 13, 15, 17, 19, 21];

/** The game's own seat, so every row is a bearing a player can actually be at. */
const SEAT = DEFAULT_CAMERA_ORBIT.azimuth;
const PITCH = DEFAULT_CAMERA_ORBIT.elevation;

/**
 * The two framings, and they answer different questions.
 *
 * `FIELD` is the game's own orthographic box -- how much of the world is on
 * screen at the default zoom -- so the first row says how *prominent* the mark
 * is. `PIXELS` is the game's world-units-per-pixel on a middling window, so the
 * rest say how it *reads*: whether a stroke a couple of world units wide is
 * still paint once it is a handful of pixels. A sheet with only the first is a
 * sheet of dots; a sheet with only the second flatters everything.
 */
const FIELD = (DEFAULT_VIEW_HALF_WIDTH * PROBE_VIRTUAL_H) / PROBE_VIRTUAL_W;
const PIXELS = 34;

interface Row {
  readonly label: string;
  readonly halfHeight: number;
  readonly azimuth: number;
}

const ROWS: readonly Row[] = [
  { label: "the game's field of view", halfHeight: FIELD, azimuth: SEAT },
  { label: 'at the size it is drawn', halfHeight: PIXELS, azimuth: SEAT },
  { label: 'a quarter turn round', halfHeight: PIXELS, azimuth: SEAT + Math.PI / 2 },
  { label: 'the camera on one arm', halfHeight: PIXELS, azimuth: SEAT + Math.PI / 4 },
];

/** How much of the probe canvas a column keeps, in device pixels. */
const COLUMN_W = 250;
const COLUMN_H = 170;

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

/** The mark's own pixels: brighter than both the probe's sky and its ground. */
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
      // A luminance floor rather than a palette test: the mark is the brightest
      // thing in a dark scene by a mile, and this needs no assumption about
      // which quantized level it happened to land on.
      if ((r + g + b) / 3 < 110 || (r === sky[0] && g === sky[1] && b === sky[2])) continue;
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
  const grid: PNG[][] = [];
  const measured: string[] = [];

  try {
    await waitForServer(`http://localhost:${PORT}/vfx-probe.html`);
    const page = await browser.newPage({ viewport: { width: 1000, height: 660 } });
    const logs: string[] = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));
    await page.goto(`http://localhost:${PORT}/vfx-probe.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.vfxProbe !== undefined, undefined, { timeout: 30_000 });

    for (const row of ROWS) {
      const frames: PNG[] = [];
      for (const ticks of TICKS) {
        const report = await page.evaluate(
          (input) => window.vfxProbe?.brush(input),
          { id: 'order_move', ticks, azimuth: row.azimuth, elevation: PITCH, halfHeight: row.halfHeight },
        );
        const png = PNG.sync.read(await page.locator('#probe-canvas').screenshot());
        frames.push(png);
        if (row.halfHeight === PIXELS && row.azimuth === SEAT) {
          const ink = inkBox(png);
          measured.push(
            `  tick ${String(ticks).padStart(2)}  ${report?.particles ?? 0} particles` +
              `  ${String(ink.count).padStart(5)} px of ink  ${ink.width}x${ink.height}`,
          );
        }
      }
      grid.push(frames);
    }

    const shaderProblems = logs.filter((line) => /error|could not compile/i.test(line) && !/favicon|404/i.test(line));
    if (shaderProblems.length > 0) throw new Error(shaderProblems.join('\n'));
  } finally {
    await browser.close();
    server.kill();
  }

  const first = grid[0]?.[0];
  if (!first) throw new Error('no frames were captured');
  const cropX = Math.floor((first.width - COLUMN_W) / 2);
  const cropY = Math.floor((first.height - COLUMN_H) / 2);
  const sheet = new PNG({ width: COLUMN_W * TICKS.length, height: COLUMN_H * grid.length });
  grid.forEach((frames, r) => {
    frames.forEach((png, c) => {
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
  console.log(`\n  order_move, at the size the game draws it (${PIXELS} units of half-height):\n`);
  for (const line of measured) console.log(line);
  console.log(`\n  ticks across: ${TICKS.join(', ')}`);
  console.log(`  rows down:    ${ROWS.map((row) => row.label).join(' / ')}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
