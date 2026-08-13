// Dev-only: photograph the heal, over its whole life (spec 157).
// `npx tsx scripts/preview-heal.ts`
//
// The spec's central claim is that a heal "reads well when pixelated", and that
// is not a claim any test in Node can settle. The library tests can say the plus
// sheet is a cross and that the streaks go up; whether a seven-texel plus
// magnified onto eleven pixels and then run through the game's own palette
// quantizer is still a *plus* is a question about pixels, and only a GPU that
// has drawn one can answer it.
//
// A strip rather than a single frame, because the effect is three layers that
// arrive and leave at different times: the shockwave is gone in half a second,
// the streaks outlive it, and the plusses are still climbing after both. A
// picture at one tick would show one of the three and hide whether the other two
// ever appeared.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import { EFFECTS } from '../src/render/iso3d/vfx/registry.js';
import { previewFrame } from '../src/render/iso3d/studio/vfx-frame.js';
import { PROBE_VIRTUAL_H } from '../src/render/iso3d/vfx/probe-config.js';
import { MAX_RENDER_W } from '../src/render/iso3d/view-frame.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4336;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const COLUMNS = 5;

/**
 * World units the camera shows across at the default gameplay zoom, the same
 * number `auras.test.ts` judges ring radii against.
 */
const VIEW_WIDTH = 900;

/**
 * Half the probe's orthographic box, in world units, such that one world unit
 * covers as many pixels here as it does in the game.
 *
 * The second row of the strip, and the row that answers the spec's actual claim.
 * The first row is framed *to* the effect, which is how you judge a shape and is
 * also how you flatter one: a plus photographed forty pixels across is a plus
 * whatever it is made of. At the gameplay zoom the same symbol lands on about
 * eleven, which is where a sprite either survives its own resolution or does
 * not.
 */
const GAMEPLAY_HALF_HEIGHT = (PROBE_VIRTUAL_H * VIEW_WIDTH) / (2 * MAX_RENDER_W);

/**
 * The five moments worth seeing, in ticks.
 *
 * The wave opens over the first ten, the streaks are at their longest around
 * twenty, and the plusses are alone on screen by forty -- which is the moment
 * the whole design turns on, because it is the one a player's eye lands on after
 * the motion has stopped.
 */
const TICKS = [4, 10, 20, 32, 44] as const;

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

async function main(): Promise<void> {
  const shots = join(root, '.claude', 'screenshots');
  if (!existsSync(shots)) mkdirSync(shots, { recursive: true });

  const heal = EFFECTS.find((effect) => effect.id === 'heal_restore');
  if (!heal) throw new Error('heal_restore missing from the registry');

  // The binary rather than npx, and stdio ignored: killing the wrapper leaves the
  // server it spawned running, and the open pipes hold this script's own event
  // loop open long after it has finished.
  const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });

  const tiles: { label: string; png: PNG; particles: number; draws: number }[] = [];
  const problems: string[] = [];

  try {
    await waitForServer(`http://localhost:${PORT}/vfx-probe.html`);
    const page = await browser.newPage({ viewport: { width: 1000, height: 660 } });
    const logs: string[] = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

    await page.goto(`http://localhost:${PORT}/vfx-probe.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.vfxProbe !== undefined, undefined, { timeout: 30_000 });

    // Two rows. The first is framed to the effect by the same measurement the
    // Studio viewport uses -- that is the shape. The second is at the density
    // the game actually draws it -- that is the read.
    const framings = [
      { name: 'framed', halfHeight: previewFrame(heal, 24).span * 0.5 },
      { name: 'zoom', halfHeight: GAMEPLAY_HALF_HEIGHT },
    ] as const;
    for (const framing of framings) {
      for (const ticks of TICKS) {
        const report = await page.evaluate(
          ([id, count, half]) => window.vfxProbe?.shot(id as string, count as number, half as number),
          [heal.id, ticks, framing.halfHeight] as const,
        );
        const buffer = await page.locator('#probe-canvas').screenshot();
        tiles.push({
          label: `${framing.name} @${ticks}`,
          png: PNG.sync.read(buffer),
          particles: report?.particles ?? 0,
          draws: report?.drawCalls ?? 0,
        });
        // Every moment in the strip must hold something. An empty tile here is
        // the failure this script exists to catch: a layer that compiles, emits
        // and then draws nothing at all.
        if ((report?.particles ?? 0) <= 0) problems.push(`no live particles at ${framing.name} tick ${ticks}`);
      }
    }

    const shaderProblems = logs.filter((line) => /error|could not compile/i.test(line) && !/favicon|404/i.test(line));
    if (shaderProblems.length > 0) problems.push(...shaderProblems);
  } finally {
    await browser.close();
    server.kill();
  }

  const first = tiles[0];
  if (!first) throw new Error('no tiles were captured');
  const tileW = first.png.width;
  const tileH = first.png.height;
  const rows = Math.ceil(tiles.length / COLUMNS);
  const sheet = new PNG({ width: tileW * COLUMNS, height: tileH * rows });

  tiles.forEach((tile, index) => {
    const ox = (index % COLUMNS) * tileW;
    const oy = Math.floor(index / COLUMNS) * tileH;
    for (let y = 0; y < tileH; y++) {
      for (let x = 0; x < tileW; x++) {
        const src = (y * tile.png.width + x) * 4;
        const dst = ((oy + y) * sheet.width + ox + x) * 4;
        sheet.data[dst] = tile.png.data[src] ?? 0;
        sheet.data[dst + 1] = tile.png.data[src + 1] ?? 0;
        sheet.data[dst + 2] = tile.png.data[src + 2] ?? 0;
        sheet.data[dst + 3] = 255;
      }
    }
    // A hairline between tiles so each reads as its own frame.
    for (let y = 0; y < tileH; y++) {
      const dst = ((oy + y) * sheet.width + ox) * 4;
      sheet.data[dst] = 10;
      sheet.data[dst + 1] = 10;
      sheet.data[dst + 2] = 14;
    }
  });

  writeFileSync(join(shots, 'vfx-heal.png'), PNG.sync.write(sheet));

  console.log(`wrote ${join(shots, 'vfx-heal.png')}`);
  tiles.forEach((tile) => {
    console.log(`    ${tile.label.padEnd(22)} ${String(tile.particles).padStart(3)} particles, ${tile.draws} draw(s)`);
  });

  if (problems.length > 0) {
    console.error(`\nFAILED:\n  - ${problems.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nOK: the heal drew something at every moment of its life.');
}

await main();
