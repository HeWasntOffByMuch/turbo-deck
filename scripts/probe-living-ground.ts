/**
 * Whether the living ground (spec 252) is wired to anything, and whether it is
 * restrained -- in the shipped page, on the map the game boots from.
 *
 *   npm run build && npx tsx scripts/probe-living-ground.ts
 *
 * Serves `dist/` rather than the dev server, so what is measured is what ships.
 *
 * ## Why this exists at all
 *
 * `living-ground.test.ts` and `terrain-living.test.ts` pin every decision the
 * layer makes and every relationship in the composed shader, and both were fully
 * green while the ground material **did not compile** -- a constant this chunk
 * declared collided with one the wind chunk already had, and the whole terrain
 * silently drew nothing. `probe-shading.ts` is what caught that and is still the
 * right tool for "does it link". This one asks the two questions after it, which
 * are about a picture rather than about a program:
 *
 * - does the layer reach the grass, and only the grass?
 * - is there wind in it, over and above the streak layer already on that ground?
 *
 * ## The mask is the measurement
 *
 * There is no hand-picked crop of ground here, and that is the point. With the
 * weather clock stilled, the pixels that change when the panel's Ground detail
 * slider goes to zero **are** the pixels this layer reaches -- nothing else in
 * the frame is touched by it -- so the difference defines its own footprint, and
 * every later number is counted inside it. A crop chosen by eye would be a fact
 * about where the trees happened to be.
 *
 * Two things follow that a fixed rectangle could not give. The footprint's own
 * mean colour says whether the layer stayed on grass (green-dominant) or leaked
 * onto the dirt path beside it. And the motion measurement has a **control**:
 * the same pixels, over the same interval, with the layer switched off -- which
 * is the streak layer and the shadows moving, and is what "the ground is alive"
 * has to beat to mean anything.
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4321;

/** Software WebGL: there is no GPU in CI or in an agent's container. */
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/**
 * Pinned, for `preview-world.ts`'s reason: without a seed the view falls back to
 * the clock and every run measures a different world.
 */
const SEED = 20260806;

/** A channel difference this big is a change rather than a redither. */
const CHANGED = 8;

async function waitForServer(url: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function pixelsOf(page: Page): Promise<PNG> {
  return PNG.sync.read(await page.screenshot());
}

/** Indices (in pixels, not bytes) where two frames differ. */
function changedMask(a: PNG, b: PNG): Uint8Array {
  const mask = new Uint8Array(a.width * a.height);
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4;
    const dr = Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));
    const dg = Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0));
    const db = Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
    if (Math.max(dr, dg, db) > CHANGED) mask[p] = 1;
  }
  return mask;
}

function countMask(mask: Uint8Array): number {
  let n = 0;
  for (const v of mask) n += v;
  return n;
}

/**
 * What the layer *added* to a moving frame, drawn white over the frame at a
 * quarter brightness.
 *
 * The number alone cannot tell a gust front from television static -- both are
 * "4% of the grass changed" -- and "broad coherent bands rather than scrolling
 * noise" is the whole difference between wind and a shimmer. So this is the
 * picture, and it is a **difference of differences**: pixels that moved over the
 * live interval and did *not* move over the control one.
 *
 * It is drawn from a **phase difference rather than an interval**, and that took
 * two tries. Drawing what moved over a second came back as four white animals:
 * the sim keeps running while the weather clock is stilled, so walking bodies
 * are most of the motion in any interval long enough for a front to travel, and
 * subtracting a control interval does not cancel them -- they are somewhere new
 * by then. So instead the layer's own clock is jumped, by taking Ground drift
 * from nothing to its ceiling and shooting a third of a second later: the field
 * lands at a completely different phase, and the bodies have taken about one
 * step. What lights up is the shape of the fronts and the trails, which is the
 * thing the numbers cannot tell apart from static.
 */
function phaseView(mask: Uint8Array, changed: Uint8Array, over: PNG): PNG {
  const out = new PNG({ width: over.width, height: over.height });
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4;
    const lit = mask[p] === 1 && changed[p] === 1;
    // The frame at a quarter underneath, so a band reads against the ground it
    // is crossing rather than floating in the dark.
    out.data[i] = lit ? 255 : (over.data[i] ?? 0) >> 2;
    out.data[i + 1] = lit ? 255 : (over.data[i + 1] ?? 0) >> 2;
    out.data[i + 2] = lit ? 255 : (over.data[i + 2] ?? 0) >> 2;
    out.data[i + 3] = 255;
  }
  return out;
}

/** How many of `mask`'s pixels differ between two frames. */
function changedWithin(mask: Uint8Array, a: PNG, b: PNG): number {
  let n = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    const dr = Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));
    const dg = Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0));
    const db = Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
    if (Math.max(dr, dg, db) > CHANGED) n++;
  }
  return n;
}

/** Mean colour over a mask, and how many distinct quantized tones it holds. */
function toneStats(mask: Uint8Array, png: PNG): { mean: [number, number, number]; distinct: number } {
  const seen = new Set<number>();
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    const pr = png.data[i] ?? 0;
    const pg = png.data[i + 1] ?? 0;
    const pb = png.data[i + 2] ?? 0;
    r += pr;
    g += pg;
    b += pb;
    n++;
    seen.add((pr << 16) | (pg << 8) | pb);
  }
  if (n === 0) return { mean: [0, 0, 0], distinct: 0 };
  return { mean: [r / n, g / n, b / n], distinct: seen.size };
}

/**
 * A slider in the weather popover, by the text of its label.
 *
 * By label rather than by index, because the panel now holds sixteen rows and an
 * index is a number that silently means something else the moment a row is added
 * above it -- which is exactly what this probe would then report as a broken
 * feature.
 */
async function setSlider(page: Page, label: string, value: number | 'max'): Promise<void> {
  const moved = await page.evaluate(
    ({ label: name, value: v }) => {
      const panel = document.querySelector('button[aria-label="Weather"]')?.parentElement;
      if (!panel) return false;
      for (const row of Array.from(panel.querySelectorAll('label'))) {
        if (!row.textContent?.startsWith(name)) continue;
        const input = row.querySelector('input[type=range]');
        if (!(input instanceof HTMLInputElement)) continue;
        input.value = v === 'max' ? input.max : String(v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    },
    { label, value },
  );
  if (!moved) throw new Error(`no slider labelled "${label}" in the weather panel`);
  await page.waitForTimeout(500);
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    throw new Error('no dist/ to serve -- run `npm run build` first');
  }

  // `node_modules/.bin/vite` in a process group of its own, never `npx`, and the
  // whole group is signalled on the way out. `npx` is a wrapper: a SIGTERM to it
  // leaves the grandchild holding the port, which `probe-admin-console.ts`
  // records learning the hard way -- and which this script reproduced, leaving
  // three servers running and starving the next browser probe of a machine.
  const server = spawn(join(root, 'node_modules', '.bin', 'vite'), [
    'preview', '--port', String(PORT), '--strictPort',
  ], { cwd: root, stdio: 'ignore', detached: true });
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  const problems: string[] = [];
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
      const text = message.text();
      // Shader trouble is the failure this whole layer is most exposed to, and
      // three.js *logs* it and carries on rather than throwing.
      if (message.type() === 'error' && /shader|GL_|WebGL/i.test(text)) problems.push(text);
    });

    // The built page is the game client since spec 252 and builds none of the tuning
    // popovers; this harness drives "Weather", so it asks the workbench back.
    await page.goto(`http://localhost:${PORT}/?seed=${SEED}&client=workbench`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    // Long enough for the terrain to have streamed and the prop field to have
    // been batched: a frame taken mid-stream is a frame with holes in the ground.
    await page.waitForTimeout(12_000);

    await page.click('button[aria-label="Weather"]');
    await page.waitForTimeout(200);

    // Still the clock first. Everything else the weather owns -- the sway, the
    // water, the streak layer over this very ground -- moves while it runs, and
    // none of it is what the first measurement is about.
    await setSlider(page, 'Weather speed', 0);
    await page.waitForTimeout(600);

    const on = await pixelsOf(page);
    const onAgain = await pixelsOf(page);
    await page.screenshot({ path: join(outDir, 'living-ground-on.png') });

    await setSlider(page, 'Ground detail', 0);
    const off = await pixelsOf(page);
    await page.screenshot({ path: join(outDir, 'living-ground-off.png') });

    // The control: two frames at one setting. Even with the clock stilled the
    // page is not a still -- bodies walk, the retro pass redithers -- so the
    // footprint has to clear that floor rather than merely be non-empty.
    const floor = countMask(changedMask(on, onAgain));
    const footprint = changedMask(on, off);
    const reached = countMask(footprint);
    const total = on.width * on.height;
    console.log(`  footprint: ${reached} px (${((reached / total) * 100).toFixed(1)}% of frame), against ${floor} px of noise`);
    if (reached < Math.max(2000, floor * 4)) {
      problems.push('the ground layer barely changed the frame -- it is not reaching the terrain');
    }

    // Where it landed. The layer is masked to grass by a chromaticity test on the
    // vertex colour, so its footprint has to come back green-dominant; a leak
    // onto the dirt path or the rock would show up here as a warm mean.
    const litOn = toneStats(footprint, on);
    const litOff = toneStats(footprint, off);
    const [r, g, b] = litOn.mean;
    console.log(`  footprint mean: rgb(${r.toFixed(0)}, ${g.toFixed(0)}, ${b.toFixed(0)})`);
    if (!(g > r && g > b)) problems.push('the footprint is not green -- the layer is reaching something other than grass');

    // What it did there. The retro pass quantizes to twelve levels a channel, so
    // "how many distinct tones does the grass hold" is the sharp version of "is
    // there large-scale colour breakup" -- a modulation too small to cross a band
    // adds no tones at all, which is the exact way spec 074's streak shipped
    // invisible.
    console.log(`  distinct tones in that footprint: ${litOff.distinct} flat -> ${litOn.distinct} living`);
    if (litOn.distinct <= litOff.distinct) {
      problems.push('the living ground holds no more tones than the flat ground did');
    }

    // Now the wind, and the one thing this measurement has to get right is
    // **signal against bodies**. The sim keeps running while the weather clock
    // is stilled, so four animals walking are most of the motion in any interval
    // long enough for a front to travel: measured that way the layer's own
    // contribution and the foxes' came out the same size, and the ratio swung
    // from 2.2x to 0.67x between two runs of the same build. `preview-world.ts`
    // writes the lesson down -- a live world is a noisy place to measure in.
    //
    // So the clock is jumped instead of waited out. Ground drift goes from
    // nothing to its ceiling and the frame is taken a third of a second later:
    // the field lands at a completely different phase while the bodies have
    // taken about one step, which turns a question about motion into one about
    // *the field depending on the clock at all* -- and that is the wiring this
    // can honestly establish. How far a front travels per second is arithmetic,
    // and `living-ground.test.ts` holds it.
    // First, whether the gust term reaches the screen at all, which is a
    // different question from whether it moves and is measured with the clock
    // still: the front at nothing against the front at its ceiling, one instant
    // apart.
    await setSlider(page, 'Ground detail', 100);
    await setSlider(page, 'Gust lift', 0);
    await page.waitForTimeout(500);
    const noFront = await pixelsOf(page);
    await setSlider(page, 'Gust lift', 'max');
    await page.waitForTimeout(500);
    const fullFront = await pixelsOf(page);
    const frontReach = changedWithin(footprint, noFront, fullFront);
    console.log(`  the gust front alone reaches ${frontReach} px of the footprint (${((frontReach / reached) * 100).toFixed(1)}%)`);
    if (frontReach < reached * 0.25) {
      problems.push('the gust front barely changes the ground even at its ceiling');
    }

    // What this cannot ask, and why: **the shared wind clock does not advance in
    // a headless page here.** Measured directly -- with this layer switched off,
    // the weather at its maximum speed and the weather stilled change the same
    // number of pixels over six seconds, so the trees are not swaying either. It
    // is why `preview-world.ts` only ever asserts on wind *strength*, which is a
    // uniform, and why it says the clean numbers live in `preview-wind.ts`,
    // which drives a clock of its own.
    //
    // So "the fronts move with the clock" is asserted in `living-ground.test.ts`
    // over the transcribed field, where a time is an argument. What is left here
    // is the picture, which is the thing no number gives: the field at one phase
    // against the field at another, taken a third of a second apart so the
    // bodies barely move. Bands mean wind; an even sprinkle would mean static.
    for (const knob of ['Gust lift', 'Wind trails']) await setSlider(page, knob, 'max');
    await setSlider(page, 'Ground drift', 0);
    await page.waitForTimeout(600);
    const phaseA = await pixelsOf(page);
    await setSlider(page, 'Ground drift', 'max');
    await page.waitForTimeout(320);
    const phaseB = await pixelsOf(page);
    writeFileSync(
      join(outDir, 'living-ground-motion.png'),
      PNG.sync.write(phaseView(footprint, changedMask(phaseA, phaseB), phaseB)),
    );

    // Restraint, as an upper bound: this is the front repainted at the loudest
    // the panel allows, so if *that* is not most of the grass then the art
    // direction is a long way from boiling. What restraint means at the shipped
    // amplitudes is a claim about colour bands, held in the unit test.
    const share = frontReach / Math.max(1, reached);
    console.log(`  ...which is ${(share * 100).toFixed(1)}% of the grass on screen, at the loudest the panel allows`);
    if (share > 0.999) {
      problems.push('the gust front repaints literally all of the grass -- it is a wash, not a front');
    }

    // Back to the shipped weather for the frame that gets committed.
    for (const [knob, value] of [['Gust lift', 40], ['Wind trails', 55], ['Ground drift', 100]] as const) {
      await setSlider(page, knob, value);
    }
    await page.waitForTimeout(400);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, 'living-ground-gust.png') });

    await page.click('button[aria-label="Weather"]');
    console.log('  wrote living-ground-{off,on,gust,motion}.png');
  } finally {
    await browser.close();
    try {
      if (server.pid !== undefined) process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.log(`  ! ${problem}`);
    console.log('\nthe living ground is not doing what it says');
    process.exitCode = 1;
    return;
  }
  console.log('\nthe living ground reaches the grass, breaks its colour up, and has wind in it');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
