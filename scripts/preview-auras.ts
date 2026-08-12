// Dev-only: photograph the status auras on their own (spec 124).
// `npx tsx scripts/preview-auras.ts`
//
// A separate sheet from `preview-vfx-library.ts` for one reason: that one frames
// every effect identically, which is right for comparing forty of them and wrong
// for these. An aura is a hundred-odd world units across where a hit flash is
// fifteen, so on the library sheet the big ones are photographed from inside
// themselves and what you judge is a corner of a ring.
//
// Here each sigil is framed to its own radius, so the thing being decided -- does
// this read as a drawn magic circle -- is actually on screen.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import { EFFECTS } from '../src/render/iso3d/vfx/registry.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4326;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const COLUMNS = 4;

/**
 * Two moments per aura, because these never end.
 *
 * The early one is the sigil almost alone -- the shafts and diamonds are stamped
 * on a rate emitter and have barely started -- and the later one is the steady
 * state a player actually looks at. Both are worth seeing: if the ring only
 * reads once it is buried under light, it does not read.
 */
const TICKS = [40, 150] as const;

/** The radius each aura was authored at, read back off its own ring. */
function radiusOf(effect: (typeof EFFECTS)[number]): number {
  const ring = effect.emitters.find((emitter) => emitter.id === 'ring');
  return ring?.size.keys[0]?.[1] ?? 60;
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

  const auras = EFFECTS.filter((effect) => effect.id.startsWith('aura_'));
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

    for (const effect of auras) {
      // A little more than the radius, so the ring has ground around it. A sigil
      // touching the edge of frame looks cropped rather than large.
      const halfHeight = radiusOf(effect) * 1.45;
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
        if ((report?.particles ?? 0) <= 0) problems.push(`${effect.id} had no live particles at tick ${ticks}`);
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

  writeFileSync(join(shots, 'vfx-auras.png'), PNG.sync.write(sheet));

  console.log(`wrote ${join(shots, 'vfx-auras.png')}`);
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
  console.log('\nOK: every aura drew something at both moments.');
}

await main();
