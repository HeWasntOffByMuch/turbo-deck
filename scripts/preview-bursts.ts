// Dev-only: photograph the bursts on their own (spec 125).
// `npx tsx scripts/preview-bursts.ts`
//
// Same reason `preview-auras.ts` exists: the library sheet frames every effect
// identically, and an explosion is ninety world units across where a hit is
// eighteen -- so on that sheet the big ones are photographed from inside
// themselves and the hits are four pixels.
//
// Each burst is framed by `previewFrame`, the same measurement the Studio tab's
// viewport uses, so what is on screen is the whole crystal and nothing else.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import { EFFECTS } from '../src/render/iso3d/vfx/registry.js';
import { previewFrame } from '../src/render/iso3d/studio/vfx-frame.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4327;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const COLUMNS = 3;

/**
 * Three moments per burst, because a burst is a shape that opens and closes.
 *
 * The first is the crystal flowering, the second is it at full reach, and the
 * third is after it has gone and only the thrown material is left. All three are
 * worth seeing: an explosion that reads at its peak and leaves nothing behind is
 * a flash with extra steps.
 */
const TICKS = [5, 11, 26] as const;

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

  const bursts = EFFECTS.filter(
    (effect) =>
      effect.id.startsWith('explosion_') ||
      effect.id.startsWith('hit_') ||
      effect.id === 'impact_flash' ||
      effect.id === 'shockwave_ring',
  );
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

    for (const effect of bursts) {
      // The same measurement the Studio viewport frames by, so a burst is never
      // photographed from inside itself.
      const halfHeight = previewFrame(effect, 24).span * 0.5;
      for (const ticks of TICKS) {
        const report = await page.evaluate(
          ([id, count, half]) => window.vfxProbe?.shot(id as string, count as number, half as number),
          [effect.id, ticks, halfHeight] as const,
        );
        const buffer = await page.locator('#probe-canvas').screenshot();
        tiles.push({
          label: `${effect.id} @${ticks}`,
          png: PNG.sync.read(buffer),
          particles: report?.particles ?? 0,
          draws: report?.drawCalls ?? 0,
        });
        // Only the first two moments must hold something: by the third the
        // crystal is gone on purpose and a small hit has nothing left.
        if (ticks !== TICKS[2] && (report?.particles ?? 0) <= 0) {
          problems.push(`${effect.id} had no live particles at tick ${ticks}`);
        }
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

  writeFileSync(join(shots, 'vfx-bursts.png'), PNG.sync.write(sheet));

  console.log(`wrote ${join(shots, 'vfx-bursts.png')}`);
  console.log(`  ${tiles.length} tiles, ${COLUMNS} across, in reading order:\n`);
  tiles.forEach((tile, index) => {
    const position = `${Math.floor(index / COLUMNS) + 1},${(index % COLUMNS) + 1}`;
    console.log(`    ${position.padEnd(5)} ${tile.label.padEnd(26)} ${String(tile.particles).padStart(3)} particles, ${tile.draws} draw(s)`);
  });

  if (problems.length > 0) {
    console.error(`\nFAILED:\n  - ${problems.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nOK: every burst drew something at all three moments.');
}

await main();
