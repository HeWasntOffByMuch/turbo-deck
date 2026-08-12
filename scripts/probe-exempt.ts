// Dev-only: does the player actually keep their colours? (spec 138)
//
//   npx tsx scripts/probe-exempt.ts
//
// Requires a build first (`npm run build`); it serves `dist/`, so what is
// measured is what ships.
//
// Nothing in `npm test` can answer this. The exemption is a second render
// target sharing the scene buffer's depth attachment, and every way it can fail
// needs a GL context to fail in: the mask can come back empty (nothing exempt,
// no visible change), full (every pixel exempt, the retro filter silently off),
// unoccluded (a body masked through the tree in front of it), or the shared
// depth can simply not survive being attached to two framebuffers. The unit
// tests check what the pass does to the *scene* -- what it hides, what it
// restores, what it clears -- because that is all that is observable without a
// GPU. This checks the pixels.
//
// The oracle is the palette, the same one `probe-vfx.ts` leans on: with a fixed
// palette set, every pixel RetroPass emits is exactly one of sixteen known
// colours. So "which pixels escaped the quantize" is not a judgement call or a
// threshold, it is an equality test -- the exempt pixels are the ones that are
// not palette colours.
//
// It is deliberately NOT a diff of two frames. The world is live -- trees sway,
// the light moves, monsters walk -- and preview-hike.ts already found that
// differencing two screenshots a second apart reports ~19% change everywhere
// with the feature switched off. Both frames are measured against the palette
// independently, and the two counts are compared.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { paletteById } from '../src/render/iso3d/hike.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4337;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/**
 * The slice of the canvas the measurement looks at, as fractions of it.
 *
 * The HUD is DOM drawn over the canvas and never went through RetroPass, so
 * every pixel of it is "off palette" and none of it means anything here. This
 * box clears the tab bar and the settings cogs above, the ability bar and the
 * weapon list below, and leaves the middle of the frame -- which is where the
 * camera keeps the player.
 */
const BOX = { left: 0.28, right: 0.72, top: 0.22, bottom: 0.66 };

/** How big a blob has to be to be a body rather than a nameplate, in pixels. */
const BODY_PIXELS = 400;

interface Reading {
  readonly total: number;
  readonly offPalette: number;
  readonly blob: number;
  readonly blobBox: { x: number; y: number; w: number; h: number } | null;
  readonly strays: string[];
}

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

/**
 * Every pixel in the box that is not a palette colour, and the largest
 * connected run of them.
 *
 * The blob matters more than the count. A frame can be a few hundred pixels off
 * palette because a damage number floated over the box, and that is nothing; a
 * body is a *contiguous* few thousand. Flood filled iteratively rather than
 * recursively, because a full-frame failure is one component the size of the
 * box and would blow a call stack on the way to reporting itself.
 */
function measure(png: PNG, palette: ReadonlySet<number>, highlight: boolean): Reading {
  const x0 = Math.floor(png.width * BOX.left);
  const x1 = Math.floor(png.width * BOX.right);
  const y0 = Math.floor(png.height * BOX.top);
  const y1 = Math.floor(png.height * BOX.bottom);
  const w = x1 - x0;
  const h = y1 - y0;

  const off = new Uint8Array(w * h);
  const strays = new Set<string>();
  let offPalette = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = ((y + y0) * png.width + (x + x0)) * 4;
      const r = png.data[at] ?? 0;
      const g = png.data[at + 1] ?? 0;
      const b = png.data[at + 2] ?? 0;
      if (palette.has((r << 16) | (g << 8) | b)) continue;
      off[y * w + x] = 1;
      offPalette += 1;
      if (strays.size < 8) strays.add(`#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`);
    }
  }

  let blob = 0;
  let blobBox: Reading['blobBox'] = null;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let start = 0; start < off.length; start++) {
    if (off[start] !== 1 || seen[start] === 1) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    let size = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    while (stack.length > 0) {
      const at = stack.pop() ?? 0;
      const x = at % w;
      const y = (at - x) / w;
      size += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const visit = (next: number): void => {
        if (off[next] !== 1 || seen[next] === 1) return;
        seen[next] = 1;
        stack.push(next);
      };
      if (x > 0) visit(at - 1);
      if (x < w - 1) visit(at + 1);
      if (y > 0) visit(at - w);
      if (y < h - 1) visit(at + w);
    }
    if (size > blob) {
      blob = size;
      blobBox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }
  }

  // The picture a person decides from: every off-palette pixel painted magenta
  // over the frame it came from, and the box drawn around what was looked at.
  if (highlight) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (off[y * w + x] !== 1) continue;
        const at = ((y + y0) * png.width + (x + x0)) * 4;
        png.data[at] = 255;
        png.data[at + 1] = 0;
        png.data[at + 2] = 255;
      }
    }
    for (let x = x0; x < x1; x++) {
      for (const y of [y0, y1 - 1]) {
        const at = (y * png.width + x) * 4;
        png.data[at] = 255;
        png.data[at + 1] = 255;
        png.data[at + 2] = 0;
      }
    }
    for (let y = y0; y < y1; y++) {
      for (const x of [x0, x1 - 1]) {
        const at = (y * png.width + x) * 4;
        png.data[at] = 255;
        png.data[at + 1] = 255;
        png.data[at + 2] = 0;
      }
    }
  }

  return { total: w * h, offPalette, blob, blobBox, strays: [...strays] };
}

const failures: string[] = [];
const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['preview', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});

try {
  await waitForServer(`http://localhost:${PORT}/`);
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });
  const page: Page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(String(e)));

  await page.goto(`http://localhost:${PORT}/?seed=20260806`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(3500);

  const canvasRect = async (): Promise<{ x: number; y: number; width: number; height: number }> =>
    page.evaluate(() => {
      const r = document.querySelector('canvas')?.getBoundingClientRect();
      return { x: r?.x ?? 0, y: r?.y ?? 0, width: r?.width ?? 1, height: r?.height ?? 1 };
    });

  // The oracle. Without a palette the quantized frame is on a twelve-step
  // lattice, which is a threshold to argue about; with one it is sixteen exact
  // colours, which is not.
  await page.click('button[aria-label="Hike look"]');
  await page.locator('label', { hasText: 'Palette' }).first().locator('select').selectOption('world');
  await page.click('button[aria-label="Hike look"]');
  await page.waitForTimeout(1200);

  const palette = new Set(paletteById('world') ?? []);
  if (palette.size !== 16) throw new Error(`expected 16 palette colours, got ${palette.size}`);

  const read = async (name: string): Promise<Reading> => {
    const shot = await page.screenshot({ clip: await canvasRect() });
    const png = PNG.sync.read(shot);
    const reading = measure(png, palette, true);
    await writeFile(join(outDir, name), PNG.sync.write(png));
    return reading;
  };

  const setSpared = async (on: boolean): Promise<void> => {
    await page.click('button[aria-label="Retro filter"]');
    const box = page.locator('label', { hasText: 'Spare the player' }).first().locator('input[type=checkbox]');
    if (on) await box.check();
    else await box.uncheck();
    await page.click('button[aria-label="Retro filter"]');
    await page.waitForTimeout(1200);
  };

  await setSpared(false);
  const off = await read('exempt-off.png');

  await setSpared(true);
  const on = await read('exempt-on.png');

  const pct = (n: number, of: number): string => `${((n / of) * 100).toFixed(2)}%`;
  const show = (label: string, r: Reading): void => {
    console.log(`  ${label}`);
    console.log(`    off-palette pixels   ${r.offPalette} of ${r.total}  (${pct(r.offPalette, r.total)})`);
    console.log(
      `    largest blob         ${r.blob}${r.blobBox ? `  ${r.blobBox.w}x${r.blobBox.h} at ${r.blobBox.x},${r.blobBox.y}` : ''}`,
    );
    if (r.strays.length > 0) console.log(`    e.g.                 ${r.strays.join(' ')}`);
    console.log('');
  };

  console.log('\n== which pixels escaped the palette? (spec 138) ==\n');
  show('spare the player OFF', off);
  show('spare the player ON', on);

  // 1. With the exemption off, everything in the box went through the quantize.
  //    A handful of stray pixels is a nameplate or a damage number floating over
  //    the middle of the frame; a body's worth of them is the filter not working.
  if (off.blob >= BODY_PIXELS) {
    failures.push(
      `with the exemption OFF, ${off.blob} contiguous pixels are off the palette -- ` +
        'something in the middle of the frame is not going through RetroPass, so this probe cannot ' +
        'tell an exempt body from it.',
    );
  }

  // 2. With it on, a body's worth of pixels escaped. This is the feature.
  if (on.blob < BODY_PIXELS) {
    failures.push(
      `with the exemption ON, the largest off-palette blob is only ${on.blob} pixels -- ` +
        'the mask is empty. Either nothing was named exempt, or it was masked out by the depth test.',
    );
  }

  // 3. ...and only a body's worth. The mask filling the frame is the failure
  //    that looks like success from every other angle: the picture is still
  //    there, still lit, still animated, and the retro filter is off.
  if (on.offPalette > on.total * 0.5) {
    failures.push(
      `with the exemption ON, ${pct(on.offPalette, on.total)} of the box is off the palette -- ` +
        'the mask is covering the world, not the player. The retro filter is effectively switched off.',
    );
  }

  // 4. The blob is a body: taller than it is wide, and not a stripe across the
  //    frame. A mask that leaked along a scanline or filled a quadrant passes
  //    the size checks and fails this one.
  if (on.blobBox && on.blob >= BODY_PIXELS) {
    const { w, h } = on.blobBox;
    if (w > (on.total / h) * 0.6) {
      failures.push(`the exempt blob is ${w}x${h} -- that is a band across the frame, not a body`);
    }
  }

  // The depth test is NOT checked here, on purpose, and cannot be: nothing in
  // this arena draws in front of the player. At the default 27-degree camera,
  // 96 frames of walking three directions never split the exempt silhouette and
  // never cost it a third of its area -- that spread is the gait. With no
  // occluder to find, a mask drawn with no depth at all renders the identical
  // picture, so every number above is blind to it.
  //
  // A walk-into-the-trees check lived here briefly and passed, which is worse
  // than failing: it was reading the walk cycle. `runExempt` in shading-probe.ts
  // settles it by building a wall rather than hoping to walk behind one.

  const problems = logs.filter(
    (line) => /error|fail|could not compile|INVALID_/i.test(line) && !/favicon|404|\[units\]/i.test(line),
  );
  if (problems.length > 0) failures.push(`page logged problems:\n    ${problems.join('\n    ')}`);

  await browser.close();
} finally {
  server.kill();
}

console.log('wrote .claude/screenshots/exempt-off.png and exempt-on.png (off-palette pixels in magenta)');

if (failures.length > 0) {
  console.error(`\nFAILED:\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
} else {
  console.log('\nok: the player kept their colours and nothing else did');
}
