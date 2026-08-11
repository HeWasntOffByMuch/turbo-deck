// Dev-only: verify the particles are inside the low-resolution buffer, and
// photograph the glow approaches so a person can decide between them (spec 118).
// Not part of the app. `npx tsx scripts/probe-vfx.ts`
//
// Drives `src/render/vfx-probe.html`, which renders a spark burst through the
// real `RetroPass` at a real virtual resolution with a small palette. Two things
// are checked, and a particle drawn at native resolution and composited on top
// fails both:
//
//   1. every pixel is a palette entry, because the pass snaps the whole image to
//      one -- anything drawn afterwards keeps its own colour;
//   2. the *device* pixels form flat SCALE x SCALE blocks, because the canvas
//      backing store is the virtual buffer and CSS does an integer upscale --
//      anything drawn at native resolution has edges inside the blocks.
//
// The second check is the one that needs a browser: it is a claim about the
// composited page, not about the render target.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import {
  PROBE_BACKGROUND,
  PROBE_GROUND,
  PROBE_PALETTE,
  PROBE_SCALE,
} from '../src/render/iso3d/vfx/probe-config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4323;
const SCALE = PROBE_SCALE;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
/** Software WebGL: there is no GPU in CI or in an agent's container. */
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

type GlowMode = 'dither' | 'smooth' | 'layered';

/** What the page reports: what the sim was holding when the frame was drawn. */
interface PageReport {
  mode: GlowMode;
  particles: number;
  drawCalls: number;
}

/** What the pixels say. Measured here, from the screenshot of the real page. */
interface PixelReport {
  effectPixels: number;
  distinct: number;
  onPalette: number;
  offPalette: number;
  strays: string[];
  brokenBlocks: number;
  blocksChecked: number;
  /** Virtual pixels in the halo, and how many distinct luminances they hold. */
  haloPixels: number;
  haloLevels: number;
}

const BACKGROUND = PROBE_BACKGROUND;
const GROUND = PROBE_GROUND;

async function waitForServer(url: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`dev server never came up at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Count SCALE x SCALE device-pixel blocks that are not one flat colour.
 *
 * This is the whole low-resolution claim, measured rather than asserted. The
 * canvas is `virtual` pixels wide with a CSS width of `virtual * SCALE`, and
 * `image-rendering: pixelated` is defined as nearest-neighbour -- so a correctly
 * routed frame has every block flat. One particle drawn at native resolution
 * puts a gradient inside a block and shows up here immediately.
 */
function brokenBlocks(png: PNG): { broken: number; checked: number } {
  let broken = 0;
  let checked = 0;
  for (let by = 0; by + SCALE <= png.height; by += SCALE) {
    for (let bx = 0; bx + SCALE <= png.width; bx += SCALE) {
      const base = (by * png.width + bx) * 4;
      const r = png.data[base];
      const g = png.data[base + 1];
      const b = png.data[base + 2];
      checked += 1;
      let flat = true;
      for (let y = 0; y < SCALE && flat; y++) {
        for (let x = 0; x < SCALE; x++) {
          const at = ((by + y) * png.width + bx + x) * 4;
          if (png.data[at] !== r || png.data[at + 1] !== g || png.data[at + 2] !== b) {
            flat = false;
            break;
          }
        }
      }
      if (!flat) broken += 1;
    }
  }
  return { broken, checked };
}

/**
 * Everything the pixels can answer, measured on the composited page.
 *
 * The screenshot is the honest subject: it is what a player sees, and it is the
 * only place the CSS upscale exists at all. Sampling every SCALE-th device pixel
 * recovers the virtual buffer exactly, because `image-rendering: pixelated` is
 * defined as nearest-neighbour.
 */
function analyse(png: PNG): PixelReport {
  const palette = new Set(PROBE_PALETTE);
  const distinct = new Set<number>();
  const strays = new Set<string>();
  let effectPixels = 0;
  let onPalette = 0;
  let offPalette = 0;
  const haloLumas = new Set<number>();
  let haloPixels = 0;

  for (let vy = 0; vy * SCALE < png.height; vy++) {
    for (let vx = 0; vx * SCALE < png.width; vx++) {
      // The middle of the block, so a stray half-pixel at a block seam cannot be
      // mistaken for the block's colour.
      const px = vx * SCALE + (SCALE >> 1);
      const py = vy * SCALE + (SCALE >> 1);
      const at = (py * png.width + px) * 4;
      const r = png.data[at] ?? 0;
      const g = png.data[at + 1] ?? 0;
      const b = png.data[at + 2] ?? 0;
      const hex = (r << 16) | (g << 8) | b;

      distinct.add(hex);
      if (palette.has(hex)) onPalette += 1;
      else {
        offPalette += 1;
        if (strays.size < 12) strays.add(`#${hex.toString(16).padStart(6, '0')}`);
      }
      if (hex !== BACKGROUND && hex !== GROUND) {
        effectPixels += 1;
        haloPixels += 1;
        haloLumas.add(Math.round((r * 0.2126 + g * 0.7152 + b * 0.0722) / 4));
      }
    }
  }

  const { broken, checked } = brokenBlocks(png);
  return {
    effectPixels,
    distinct: distinct.size,
    onPalette,
    offPalette,
    strays: [...strays],
    brokenBlocks: broken,
    blocksChecked: checked,
    haloPixels,
    haloLevels: haloLumas.size,
  };
}

async function main(): Promise<void> {
  const shots = join(root, '.claude', 'screenshots');
  if (!existsSync(shots)) mkdirSync(shots, { recursive: true });

  // The binary directly rather than through `npx`, and `stdio: 'ignore'`. This is
  // the trap `probe-shading.ts` already documents: killing the npx wrapper leaves
  // the server it spawned running, so the next run's readiness check is answered
  // by a stale process serving stale modules -- and the open stdio pipes keep this
  // script's own event loop alive long after it has finished, which from the
  // outside is indistinguishable from a hang in the browser.
  const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });
  const failures: string[] = [];
  const results: { page: PageReport; pixels: PixelReport }[] = [];

  try {
    await waitForServer(`http://localhost:${PORT}/vfx-probe.html`);
    const page = await browser.newPage({ viewport: { width: 1000, height: 660 } });
    const logs: string[] = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

    await page.goto(`http://localhost:${PORT}/vfx-probe.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.vfxProbe !== undefined, undefined, { timeout: 30_000 });

    for (const mode of ['dither', 'smooth', 'layered'] as const) {
      const report = (await page.evaluate((m) => window.vfxProbe?.run(m), mode)) as PageReport | undefined;
      if (!report) throw new Error(`probe returned nothing for ${mode}`);

      const buffer = await page.locator('#probe-canvas').screenshot();
      writeFileSync(join(shots, `vfx-glow-${mode}.png`), buffer);
      results.push({ page: report, pixels: analyse(PNG.sync.read(buffer)) });
    }

    // A missing favicon is a 404 and is not a rendering problem; three logs a
    // failed shader compile and carries on, which is the thing worth catching.
    const problems = logs.filter(
      (line) => /error|fail|could not compile/i.test(line) && !/favicon/i.test(line) && !/404/.test(line),
    );
    if (problems.length > 0) failures.push(`page logged problems:\n    ${problems.join('\n    ')}`);
  } finally {
    await browser.close();
    server.kill();
  }

  console.log('== is the effect inside the low-resolution buffer? ==\n');
  for (const { page, pixels } of results) {
    console.log(`  ${page.mode}`);
    console.log(`    live particles       ${page.particles} in ${page.drawCalls} draw call(s)`);
    console.log(`    effect pixels        ${pixels.effectPixels}`);
    console.log(`    distinct colours     ${pixels.distinct}`);
    console.log(`    on palette           ${pixels.onPalette}`);
    console.log(`    off palette          ${pixels.offPalette}${pixels.strays.length > 0 ? `  e.g. ${pixels.strays.join(' ')}` : ''}`);
    console.log(`    non-flat blocks      ${pixels.brokenBlocks} of ${pixels.blocksChecked}`);
    console.log(`    halo luma levels     ${pixels.haloLevels} over ${pixels.haloPixels} px`);
    console.log('');
  }

  for (const { page, pixels } of results) {
    if (pixels.effectPixels < 30) {
      failures.push(`${page.mode}: only ${pixels.effectPixels} effect pixels -- nothing was drawn`);
    }
    if (page.drawCalls > 4) {
      failures.push(`${page.mode}: ${page.drawCalls} draw calls for one effect -- batching is not working`);
    }
    if (pixels.offPalette > 0) {
      failures.push(
        `${page.mode}: ${pixels.offPalette} pixels are off the palette (${pixels.strays.join(' ')}). ` +
          'Something reached the canvas without going through RetroPass.',
      );
    }
    if (pixels.brokenBlocks > 0) {
      failures.push(
        `${page.mode}: ${pixels.brokenBlocks} device-pixel blocks are not flat. ` +
          'Something was drawn at native resolution.',
      );
    }
  }

  console.log(`wrote ${results.length} images to .claude/screenshots/vfx-glow-*.png`);

  if (failures.length > 0) {
    console.error(`\nFAILED:\n  - ${failures.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nOK: every pixel is on the palette and every device-pixel block is flat.');
}

// The page's own `probe.ts` already declares `window.vfxProbe`, and this script
// is compiled against the same project -- so it is in scope here rather than
// being re-declared, which would be a conflicting declaration and not a fix.

await main();
