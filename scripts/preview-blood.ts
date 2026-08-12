// Dev-only: photograph blood in a lit scene, and measure the shadow (spec 139).
// `npx tsx scripts/preview-blood.ts`
//
// Two claims, neither of which any headless test can reach:
//
//  - **A stain takes the light it is lying in.** `DecalView` used to end its
//    fragment shader `gl_FragColor = vec4(vTint, 1.0)`, which is a constant, so
//    blood in the shadow of a cliff was drawn at full daylight over ground that
//    was not. That is a statement about a fragment shader running against a real
//    shadow map, and in Node there is no shader, no shadow map, and no pixel.
//    The check has teeth because the stains are *twinned*: same seed, same size,
//    one in the shade and one out of it, so the comparison is one splat against
//    itself. Reverting `decal-view.ts` to the flat material makes every pair
//    identical and the run fails.
//  - **A streak bends.** The ribbon is a shape, and a shape only exists once
//    something has drawn one. This is the picture that shows whether the chain
//    of quads reads as a comet or as a string of beads -- and it is also the
//    only thing that can tell whether the new `iMode` branch compiled at all,
//    since three logs a failed compile and carries on.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4333;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/**
 * The moments worth seeing.
 *
 * A ribbon has nothing to draw on the tick it is born -- the trail is one sample
 * long -- so the interesting range is the middle of the flight, where the drops
 * have travelled far enough to have a shape and gravity has had time to turn
 * them over. The last one is after most of them have landed, which is where the
 * stains are the subject.
 */
const TICKS = [4, 9, 16, 30] as const;

/** Effects worth a strip each: the loud one and the ordinary one. */
const EFFECTS = ['death_blood', 'hit_blood'] as const;

interface StainBox {
  label: string;
  shadowed: boolean;
  x: number;
  y: number;
  radius: number;
}

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
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

/**
 * The mean brightness of the blood inside one stain's box.
 *
 * Only reddish pixels count. The ground around a stain is grey and is *also*
 * darker in shadow, so averaging the whole box would measure the ground's
 * shadow and pass whatever the decal did.
 */
function stainLuma(png: PNG, box: StainBox): { luma: number; pixels: number } {
  const radius = Math.max(3, Math.round(box.radius));
  let total = 0;
  let count = 0;
  for (let y = Math.round(box.y - radius); y <= Math.round(box.y + radius); y++) {
    if (y < 0 || y >= png.height) continue;
    for (let x = Math.round(box.x - radius); x <= Math.round(box.x + radius); x++) {
      if (x < 0 || x >= png.width) continue;
      const at = (y * png.width + x) * 4;
      const r = png.data[at] ?? 0;
      const g = png.data[at + 1] ?? 0;
      const b = png.data[at + 2] ?? 0;
      // Red-dominant: blood, at any brightness. The ground is neutral grey and
      // never satisfies this, in sun or in shade.
      if (r < g + 10 || r < b + 10) continue;
      total += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      count += 1;
    }
  }
  return { luma: count > 0 ? total / count : 0, pixels: count };
}

function stitch(tiles: readonly { png: PNG }[], columns: number): PNG {
  const first = tiles[0];
  if (!first) throw new Error('no tiles were captured');
  const tileW = first.png.width;
  const tileH = first.png.height;
  const rows = Math.ceil(tiles.length / columns);
  const sheet = new PNG({ width: tileW * columns, height: tileH * rows });
  tiles.forEach((tile, index) => {
    const ox = (index % columns) * tileW;
    const oy = Math.floor(index / columns) * tileH;
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
    // A hairline so each moment reads as its own frame.
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
  return sheet;
}

async function main(): Promise<void> {
  const shots = join(root, '.claude', 'screenshots');
  if (!existsSync(shots)) mkdirSync(shots, { recursive: true });

  const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });

  const tiles: { label: string; png: PNG; particles: number; draws: number }[] = [];
  const pairs: { label: string; shadow: number; sun: number; shadowPixels: number; sunPixels: number }[] = [];
  const problems: string[] = [];

  try {
    await waitForServer(`http://localhost:${PORT}/vfx-probe.html`);
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const logs: string[] = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

    await page.goto(`http://localhost:${PORT}/vfx-probe.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.vfxProbe !== undefined, undefined, { timeout: 30_000 });

    for (const effect of EFFECTS) {
      for (const ticks of TICKS) {
        const report = await page.evaluate(
          ([count, id]) => window.vfxProbe?.blood(count as number, id as string),
          [ticks, effect] as const,
        );
        const png = PNG.sync.read(await page.locator('#probe-canvas').screenshot());
        tiles.push({ label: `${effect} @${ticks}`, png, particles: report?.particles ?? 0, draws: report?.drawCalls ?? 0 });

        // The shadow measurement is the same in every frame; take it from the
        // last one of each effect, when the air is clear of drops that would
        // otherwise put blood-coloured pixels inside a stain's box.
        if (ticks === TICKS[TICKS.length - 1] && effect === EFFECTS[0]) {
          const stains = (report?.stains ?? []) as StainBox[];
          for (const spot of stains.filter((stain) => stain.shadowed)) {
            const name = spot.label.replace('-shadow', '');
            const twin = stains.find((stain) => stain.label === `${name}-sun`);
            if (!twin) continue;
            const shade = stainLuma(png, spot);
            const sun = stainLuma(png, twin);
            pairs.push({ label: name, shadow: shade.luma, sun: sun.luma, shadowPixels: shade.pixels, sunPixels: sun.pixels });
          }
        }

        if ((report?.particles ?? 0) <= 0 && ticks !== TICKS[TICKS.length - 1]) {
          problems.push(`${effect} had no live particles at tick ${ticks}`);
        }
      }
    }

    const shaderProblems = logs.filter((line) => /error|could not compile/i.test(line) && !/favicon|404/i.test(line));
    if (shaderProblems.length > 0) problems.push(...shaderProblems);
  } finally {
    await browser.close();
    server.kill();
  }

  writeFileSync(join(shots, 'blood.png'), PNG.sync.write(stitch(tiles, TICKS.length)));
  console.log(`wrote ${join(shots, 'blood.png')}`);
  console.log(`  ${TICKS.length} across, in reading order:\n`);
  tiles.forEach((tile, index) => {
    const position = `${Math.floor(index / TICKS.length) + 1},${(index % TICKS.length) + 1}`;
    console.log(`    ${position.padEnd(5)} ${tile.label.padEnd(22)} ${String(tile.particles).padStart(3)} particles, ${tile.draws} draw(s)`);
  });

  console.log('\n  stain brightness, same splat under two lights:\n');
  console.log('    pair       in shadow    in sun   ratio   px (shadow/sun)');
  for (const pair of pairs) {
    const ratio = pair.sun > 0 ? pair.shadow / pair.sun : 1;
    console.log(
      `    ${pair.label.padEnd(9)} ${pair.shadow.toFixed(1).padStart(8)} ${pair.sun.toFixed(1).padStart(9)}   ${ratio.toFixed(2)}    ${pair.shadowPixels}/${pair.sunPixels}`,
    );
    if (pair.shadowPixels < 20 || pair.sunPixels < 20) {
      problems.push(`${pair.label}: only ${pair.shadowPixels}/${pair.sunPixels} blood pixels found -- the boxes missed the stains`);
      continue;
    }
    // A shadow that only just registers is a shadow the quantizer will eat. The
    // ground itself drops by about this much between sun and shade.
    if (ratio > 0.8) problems.push(`${pair.label}: a stain in shadow is ${(ratio * 100).toFixed(0)}% as bright as the same one in sun`);
  }

  if (pairs.length === 0) problems.push('no stain pairs were measured at all');

  if (problems.length > 0) {
    console.error(`\nFAILED:\n  - ${problems.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nOK: every stain is darker in the shade, and every streak drew.');
}

await main();
