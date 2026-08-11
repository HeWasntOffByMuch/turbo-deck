// Dev-only: photograph the whole effect library (spec 121).
// `npx tsx scripts/preview-vfx-library.ts`
//
// Forty-odd authored effects, each played through the game's own RetroPass at
// the game's own virtual resolution, stitched into one contact sheet.
//
// The tests beside the library assert that every effect compiles, emits, names a
// real sprite and dangles no sub-effect. None of that says a flame looks like a
// flame. This is the picture that does, and it is the only way to look at forty
// effects without fighting one of each.
//
// (Named `preview-vfx-library` and not `preview-library`: that one is spec 112's,
// and it drives the Studio tab's unit library. Two scripts, two libraries.)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import { EFFECTS } from '../src/render/iso3d/vfx/registry.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4324;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/** Columns in the sheet. */
const COLUMNS = 7;

/**
 * The ticks worth photographing an effect at.
 *
 * Derived from the definition rather than from its name, and then *measured*:
 * the first version of this guessed from an id prefix and photographed eleven
 * effects after they had finished. Every flash in the library lives three or
 * four ticks and was being caught at eight, which produced eleven empty tiles
 * and eleven bug reports about effects that were working perfectly.
 *
 * So the candidates come from the emitters and the winner is whichever tick
 * actually holds the most particles. Counting is cheap -- it is the screenshot
 * that is slow -- so every candidate is run and only the best is photographed.
 */
function candidateTicks(effect: (typeof EFFECTS)[number]): readonly number[] {
  if ((effect.durationTicks ?? 0) > 0) {
    const duration = effect.durationTicks ?? 1;
    return [Math.max(2, Math.round(duration * 0.4)), Math.max(3, Math.round(duration * 0.75))];
  }
  // A rate emitter never finishes, so what matters is reaching steady state.
  if (effect.emitters.some((emitter) => emitter.emission.kind === 'rate')) return [45, 110, 190];

  // A burst: somewhere inside the shortest life and somewhere inside the longest.
  const mins = effect.emitters.map((emitter) => emitter.lifetimeTicks[0]);
  const shortest = Math.min(...mins);
  const longest = Math.max(...mins);
  const ticks = new Set([
    Math.max(2, Math.round(shortest * 0.6)),
    Math.max(2, Math.round(longest * 0.5)),
    Math.max(2, Math.round(longest * 0.85)),
  ]);
  return [...ticks].sort((a, b) => a - b);
}

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

  // The binary rather than npx, and stdio ignored: killing the wrapper leaves the
  // server it spawned running, and the open pipes hold this script's own event
  // loop open long after it has finished.
  const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });

  const tiles: { id: string; png: PNG; particles: number; draws: number }[] = [];
  const problems: string[] = [];

  try {
    await waitForServer(`http://localhost:${PORT}/vfx-probe.html`);
    const page = await browser.newPage({ viewport: { width: 1000, height: 660 } });
    const logs: string[] = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

    await page.goto(`http://localhost:${PORT}/vfx-probe.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.vfxProbe !== undefined, undefined, { timeout: 30_000 });

    for (const effect of EFFECTS) {
      // Count at every candidate, photograph only the winner. The sim is
      // deterministic, so replaying the winning tick reproduces exactly the
      // frame that was counted.
      let bestTicks = 0;
      let bestParticles = -1;
      let bestDraws = 0;
      for (const ticks of candidateTicks(effect)) {
        const report = await page.evaluate(
          ([id, count]) => window.vfxProbe?.shot(id as string, count as number),
          [effect.id, ticks] as const,
        );
        const particles = report?.particles ?? 0;
        if (particles > bestParticles) {
          bestParticles = particles;
          bestTicks = ticks;
          bestDraws = report?.drawCalls ?? 0;
        }
      }

      await page.evaluate(
        ([id, count]) => window.vfxProbe?.shot(id as string, count as number),
        [effect.id, bestTicks] as const,
      );
      const buffer = await page.locator('#probe-canvas').screenshot();
      tiles.push({ id: effect.id, png: PNG.sync.read(buffer), particles: bestParticles, draws: bestDraws });

      // An effect that is empty at *every* candidate is the one failure a picture
      // makes easy to miss: a blank tile among forty reads as "that one is
      // subtle" rather than as "that one is broken".
      if (bestParticles <= 0) {
        problems.push(`${effect.id} had no live particles at any of ${candidateTicks(effect).join(', ')}`);
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
  // Cropped to the middle at 1:1 rather than downscaled.
  //
  // Downscaling by three was the first version, and it made every tile a
  // handful of pixels -- which is honest about gameplay scale and useless as a
  // contact sheet, because the thing being judged is what an effect *is* and at
  // three-to-one it is four pixels of it. Cropping keeps the pixels the size the
  // game draws them and simply shows less ground around each effect.
  const tileW = Math.min(first.png.width, 300);
  const tileH = Math.min(first.png.height, 230);
  const cropX = Math.floor((first.png.width - tileW) / 2);
  // Biased above centre: effects are played at y = 24 and rise, so the middle of
  // the frame is mostly the ground under them.
  const cropY = Math.floor((first.png.height - tileH) / 2) - Math.floor(tileH * 0.12);
  const rows = Math.ceil(tiles.length / COLUMNS);
  const sheet = new PNG({ width: tileW * COLUMNS, height: tileH * rows });

  tiles.forEach((tile, index) => {
    const ox = (index % COLUMNS) * tileW;
    const oy = Math.floor(index / COLUMNS) * tileH;
    for (let y = 0; y < tileH; y++) {
      for (let x = 0; x < tileW; x++) {
        const src = ((y + Math.max(0, cropY)) * tile.png.width + x + cropX) * 4;
        const dst = ((oy + y) * sheet.width + ox + x) * 4;
        sheet.data[dst] = tile.png.data[src] ?? 0;
        sheet.data[dst + 1] = tile.png.data[src + 1] ?? 0;
        sheet.data[dst + 2] = tile.png.data[src + 2] ?? 0;
        sheet.data[dst + 3] = 255;
      }
    }
    // A hairline between tiles so each reads as its own frame.
    for (let x = 0; x < tileW; x++) {
      const dst = (oy * sheet.width + ox + x) * 4;
      sheet.data[dst] = 10;
      sheet.data[dst + 1] = 10;
      sheet.data[dst + 2] = 14;
    }
    for (let y = 0; y < tileH; y++) {
      const dst = ((oy + y) * sheet.width + ox) * 4;
      sheet.data[dst] = 10;
      sheet.data[dst + 1] = 10;
      sheet.data[dst + 2] = 14;
    }
  });

  writeFileSync(join(shots, 'vfx-library.png'), PNG.sync.write(sheet));

  console.log(`wrote ${join(shots, 'vfx-library.png')}`);
  console.log(`  ${tiles.length} effects, ${COLUMNS} across, in reading order:\n`);
  tiles.forEach((tile, index) => {
    const position = `${Math.floor(index / COLUMNS) + 1},${(index % COLUMNS) + 1}`;
    console.log(`    ${position.padEnd(5)} ${tile.id.padEnd(24)} ${String(tile.particles).padStart(4)} particles, ${tile.draws} draw(s)`);
  });
  console.log(`\n  most draw calls any single effect took: ${Math.max(...tiles.map((tile) => tile.draws))}`);

  if (problems.length > 0) {
    console.error(`\nFAILED:\n  - ${problems.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nOK: every effect in the library drew something.');
}

await main();
