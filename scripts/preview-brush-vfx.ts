// Dev-only: look at the painted effects, and measure the three claims a picture
// alone cannot settle (spec 158).
// `npx tsx scripts/preview-brush-vfx.ts`
//
// Writes `.claude/screenshots/brush-vfx.png`: seven rows of six, through the
// game's own `RetroPass` at the game's own virtual resolution.
//
//   1  blood over time         does the flick read, and is it gone by 0.4s
//   2  blood from six bearings  a flat mark held in the view plane, from all round
//   3  blood, six seeds         is the variation real or is it one mark six times
//   4  explosion over time      flash, burst, debris, smoke -- in that order
//   5  explosion from six bearings
//   6  explosion, six seeds
//   7  intensity and size       0.6x / 1x / 1.8x, and the three explosion presets
//
// ## Why a browser, and why measurements rather than just a picture
//
// Three of this spec's claims are claims about pixels, and none of them can be
// made in Node:
//
//   - **the shader compiles.** The stroke path is a `#define`, an attribute and
//     a varying that only exist on some batches. three.js logs a failed compile
//     and carries on drawing nothing, which is why `probe-shading.ts` exists and
//     why the console is read here.
//   - **a flat mark reads from every angle.** That is the whole argument for the
//     two card orientations, and a wrong basis is invisible from the one camera
//     a fixed shot would use. So: six bearings, and the ink in each is compared.
//   - **two spawns do not look alike.** Measured as the fraction of pixels that
//     differ between seeds. A per-instance deformation that silently did nothing
//     -- an attribute that failed to bind, a hash that collapsed -- would leave
//     every tile in row 3 identical and a person flicking through a contact
//     sheet would very likely not notice.
//
// The tile is cropped at 1:1 rather than downscaled, for the reason
// `preview-vfx-library.ts` records: the thing being judged is what a mark *is*,
// and at three-to-one it is four pixels of one.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { PROBE_BACKGROUND, PROBE_GROUND } from '../src/render/iso3d/vfx/probe-config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4327;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const COLUMNS = 6;
/** The device-pixel window kept from each canvas. */
const TILE_W = 300;
const TILE_H = 230;

/** The bearings row 2 and row 5 walk, evenly round the compass. */
const BEARINGS = Array.from({ length: COLUMNS }, (_, i) => (i / COLUMNS) * Math.PI * 2);

/** Six seeds that are not consecutive integers, for the reason `rng.ts` gives. */
const SEEDS = [20260810, 917331, 4242, 60817, 1180339, 271828];

interface Shot {
  readonly label: string;
  readonly id: string;
  readonly ticks: number;
  readonly azimuth?: number;
  readonly seed?: number;
  readonly scale?: number;
  readonly rotation?: number;
  readonly halfHeight: number;
}

interface Row {
  readonly title: string;
  /** Tiles whose ink is compared against each other, if any. */
  readonly check?: 'angles' | 'seeds';
  readonly shots: readonly Shot[];
}

const BLOOD_BOX = 66;
const BOOM_BOX = 130;

/** A blow arriving from the west, so every tile is aimed the same way. */
const BLOW = 0;

function bloodOverTime(): Row {
  // 2 to 24 ticks: the whole of a hit, which is authored to be over by 40.
  const ticks = [2, 4, 7, 11, 16, 24];
  return {
    title: 'blood_hit_brush over time (ticks)',
    shots: ticks.map((tick) => ({
      label: `t=${tick}`,
      id: 'blood_hit_brush',
      ticks: tick,
      rotation: BLOW,
      halfHeight: BLOOD_BOX,
    })),
  };
}

function explosionOverTime(): Row {
  const ticks = [3, 6, 10, 17, 28, 44];
  return {
    title: 'explosion_brush over time (ticks)',
    shots: ticks.map((tick) => ({
      label: `t=${tick}`,
      id: 'explosion_brush',
      ticks: tick,
      halfHeight: BOOM_BOX,
    })),
  };
}

function fromEveryBearing(id: string, ticks: number, halfHeight: number): Row {
  return {
    title: `${id} from six bearings`,
    check: 'angles',
    shots: BEARINGS.map((azimuth) => ({
      label: `${Math.round((azimuth * 180) / Math.PI)}deg`,
      id,
      ticks,
      azimuth,
      rotation: BLOW,
      halfHeight,
    })),
  };
}

function sixSeeds(id: string, ticks: number, halfHeight: number): Row {
  return {
    title: `${id} with six seeds`,
    check: 'seeds',
    shots: SEEDS.map((seed) => ({
      label: `#${seed}`,
      id,
      ticks,
      seed,
      rotation: BLOW,
      halfHeight,
    })),
  };
}

const ROWS: readonly Row[] = [
  bloodOverTime(),
  fromEveryBearing('blood_hit_brush', 9, BLOOD_BOX),
  sixSeeds('blood_hit_brush', 9, BLOOD_BOX),
  explosionOverTime(),
  fromEveryBearing('explosion_brush', 12, BOOM_BOX),
  sixSeeds('explosion_brush', 12, BOOM_BOX),
  {
    title: 'intensity, and the three explosion presets',
    shots: [
      { label: 'hit 0.6x', id: 'blood_hit_brush', ticks: 9, scale: 0.6, rotation: BLOW, halfHeight: BLOOD_BOX },
      { label: 'hit 1.0x', id: 'blood_hit_brush', ticks: 9, scale: 1, rotation: BLOW, halfHeight: BLOOD_BOX },
      { label: 'hit heavy', id: 'blood_hit_brush_heavy', ticks: 11, rotation: BLOW, halfHeight: BLOOD_BOX },
      { label: 'boom small', id: 'explosion_brush_small', ticks: 11, halfHeight: BOOM_BOX },
      { label: 'boom mid', id: 'explosion_brush', ticks: 12, halfHeight: BOOM_BOX },
      { label: 'boom large', id: 'explosion_brush_large', ticks: 14, halfHeight: BOOM_BOX * 1.55 },
    ],
  },
];

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

/** How close a pixel is to a packed sRGB colour, as a max-channel distance. */
function near(png: PNG, at: number, packed: number, tolerance: number): boolean {
  const r = Math.abs((png.data[at] ?? 0) - ((packed >> 16) & 0xff));
  const g = Math.abs((png.data[at + 1] ?? 0) - ((packed >> 8) & 0xff));
  const b = Math.abs((png.data[at + 2] ?? 0) - (packed & 0xff));
  return Math.max(r, g, b) <= tolerance;
}

/**
 * The fraction of the tile that is neither sky nor ground: the effect's own ink.
 *
 * A tolerance rather than an equality, because the retro pass grades and dithers
 * the whole frame -- the ground is not exactly `PROBE_GROUND` by the time it
 * reaches the canvas, and an equality test would count the entire floor as ink
 * and report every tile as full.
 */
function inkFraction(png: PNG): number {
  let ink = 0;
  const total = png.width * png.height;
  for (let i = 0; i < total; i++) {
    const at = i * 4;
    if (!near(png, at, PROBE_BACKGROUND, 26) && !near(png, at, PROBE_GROUND, 26)) ink += 1;
  }
  return ink / total;
}

/** The fraction of pixels where two tiles disagree by more than a hair. */
function difference(a: PNG, b: PNG): number {
  const total = Math.min(a.width * a.height, b.width * b.height);
  let differing = 0;
  for (let i = 0; i < total; i++) {
    const at = i * 4;
    const dr = Math.abs((a.data[at] ?? 0) - (b.data[at] ?? 0));
    const dg = Math.abs((a.data[at + 1] ?? 0) - (b.data[at + 1] ?? 0));
    const db = Math.abs((a.data[at + 2] ?? 0) - (b.data[at + 2] ?? 0));
    if (Math.max(dr, dg, db) > 18) differing += 1;
  }
  return differing / total;
}

interface Tile {
  readonly label: string;
  readonly png: PNG;
  readonly particles: number;
  readonly draws: number;
  readonly ink: number;
}

async function main(): Promise<void> {
  const shots = join(root, '.claude', 'screenshots');
  if (!existsSync(shots)) mkdirSync(shots, { recursive: true });

  // The binary rather than npx, and stdio ignored: killing the wrapper leaves
  // the server it spawned running, and the open pipes hold this script's own
  // event loop open long after it has finished.
  const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });

  const rows: Tile[][] = [];
  const problems: string[] = [];

  try {
    await waitForServer(`http://localhost:${PORT}/vfx-probe.html`);
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const logs: string[] = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

    await page.goto(`http://localhost:${PORT}/vfx-probe.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.vfxProbe !== undefined, undefined, { timeout: 30_000 });

    for (const row of ROWS) {
      const tiles: Tile[] = [];
      for (const shot of row.shots) {
        const report = await page.evaluate(
          (input) => window.vfxProbe?.brush(input as Parameters<NonNullable<typeof window.vfxProbe>['brush']>[0]),
          {
            id: shot.id,
            ticks: shot.ticks,
            ...(shot.azimuth === undefined ? {} : { azimuth: shot.azimuth }),
            ...(shot.seed === undefined ? {} : { seed: shot.seed }),
            ...(shot.scale === undefined ? {} : { scale: shot.scale }),
            ...(shot.rotation === undefined ? {} : { rotation: shot.rotation }),
            halfHeight: shot.halfHeight,
          },
        );
        const buffer = await page.locator('#probe-canvas').screenshot();
        const png = PNG.sync.read(buffer);
        const cropped = crop(png);
        tiles.push({
          label: shot.label,
          png: cropped,
          particles: report?.particles ?? 0,
          draws: report?.drawCalls ?? 0,
          ink: inkFraction(cropped),
        });
        if ((report?.particles ?? 0) <= 0) {
          problems.push(`${row.title} / ${shot.label}: no live particles at tick ${shot.ticks}`);
        }
      }
      rows.push(tiles);
    }

    const shaderProblems = logs.filter((line) => /error|could not compile|shader/i.test(line) && !/favicon|404/i.test(line));
    if (shaderProblems.length > 0) problems.push(...shaderProblems);
  } finally {
    await browser.close();
    server.kill();
  }

  // --- the sheet -----------------------------------------------------------
  const sheet = new PNG({ width: TILE_W * COLUMNS, height: TILE_H * rows.length });
  rows.forEach((tiles, rowIndex) => {
    tiles.forEach((tile, column) => {
      const ox = column * TILE_W;
      const oy = rowIndex * TILE_H;
      for (let y = 0; y < TILE_H; y++) {
        for (let x = 0; x < TILE_W; x++) {
          const src = (y * tile.png.width + x) * 4;
          const dst = ((oy + y) * sheet.width + ox + x) * 4;
          sheet.data[dst] = tile.png.data[src] ?? 0;
          sheet.data[dst + 1] = tile.png.data[src + 1] ?? 0;
          sheet.data[dst + 2] = tile.png.data[src + 2] ?? 0;
          sheet.data[dst + 3] = 255;
        }
      }
      // A hairline between tiles, so each reads as its own frame.
      for (let x = 0; x < TILE_W; x++) {
        const dst = (oy * sheet.width + ox + x) * 4;
        sheet.data[dst] = 10;
        sheet.data[dst + 1] = 10;
        sheet.data[dst + 2] = 14;
      }
      for (let y = 0; y < TILE_H; y++) {
        const dst = ((oy + y) * sheet.width + ox) * 4;
        sheet.data[dst] = 10;
        sheet.data[dst + 1] = 10;
        sheet.data[dst + 2] = 14;
      }
    });
  });
  const out = join(shots, 'brush-vfx.png');
  writeFileSync(out, PNG.sync.write(sheet));

  // --- the numbers ---------------------------------------------------------
  console.log(`wrote ${out}`);
  ROWS.forEach((row, index) => {
    const tiles = rows[index] ?? [];
    console.log(`\n  row ${index + 1}: ${row.title}`);
    for (const tile of tiles) {
      console.log(
        `    ${tile.label.padEnd(12)} ${String(tile.particles).padStart(4)} marks, ` +
          `${tile.draws} draw(s), ink ${(tile.ink * 100).toFixed(2)}%`,
      );
    }

    if (row.check === 'angles') {
      // The claim: a flat mark held in the view plane reads from every bearing.
      // A basis built wrong -- the world velocity instead of its screen
      // projection, say -- collapses some of these to a sliver.
      const inks = tiles.map((tile) => tile.ink);
      const low = Math.min(...inks);
      const high = Math.max(...inks);
      const ratio = high > 0 ? low / high : 0;
      console.log(`    -> thinnest bearing keeps ${(ratio * 100).toFixed(0)}% of the fattest one's ink`);
      if (ratio < 0.45) problems.push(`${row.title}: ink varies ${(ratio * 100).toFixed(0)}% across bearings`);
    }

    if (row.check === 'seeds') {
      // The claim: two spawns do not look alike. Every pair, because one pair
      // differing is what a single working seed and five broken ones look like.
      let worst = 1;
      for (let a = 0; a < tiles.length; a++) {
        for (let b = a + 1; b < tiles.length; b++) {
          const left = tiles[a];
          const right = tiles[b];
          if (!left || !right) continue;
          worst = Math.min(worst, difference(left.png, right.png));
        }
      }
      console.log(`    -> the two most alike seeds still differ over ${(worst * 100).toFixed(2)}% of the tile`);
      if (worst < 0.005) problems.push(`${row.title}: two seeds are near-identical (${(worst * 100).toFixed(3)}%)`);
    }
  });

  const draws = rows.flat().map((tile) => tile.draws);
  console.log(`\n  most draw calls any single effect took: ${Math.max(...draws)}`);

  if (problems.length > 0) {
    console.error('\nproblems:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
}

/** The middle of a canvas, at 1:1, biased above centre where the effects sit. */
function crop(png: PNG): PNG {
  const width = Math.min(png.width, TILE_W);
  const height = Math.min(png.height, TILE_H);
  const x0 = Math.max(0, Math.floor((png.width - width) / 2));
  const y0 = Math.max(0, Math.floor((png.height - height) / 2) - Math.floor(height * 0.08));
  const out = new PNG({ width: TILE_W, height: TILE_H });
  for (let y = 0; y < TILE_H; y++) {
    for (let x = 0; x < TILE_W; x++) {
      const src = ((Math.min(png.height - 1, y0 + y)) * png.width + Math.min(png.width - 1, x0 + x)) * 4;
      const dst = (y * TILE_W + x) * 4;
      out.data[dst] = png.data[src] ?? 0;
      out.data[dst + 1] = png.data[src + 1] ?? 0;
      out.data[dst + 2] = png.data[src + 2] ?? 0;
      out.data[dst + 3] = 255;
    }
  }
  return out;
}

await main();
