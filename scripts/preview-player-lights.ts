/**
 * Photograph and measure the player's own lights (spec 118), in a real browser.
 *
 *   npm run build && npx tsx scripts/preview-player-lights.ts
 *
 * The half of this change that no headless test can reach. `player-lights.ts`
 * pins the distance arithmetic in Node and `player-lights.test.ts` pins the
 * string the patch rewrites, but neither can answer the only question that
 * matters once a shader has been edited: **did it compile, and is the player
 * still there.** three.js logs a failed compile and carries on drawing, so a
 * broken patch is a console line and a body lit the old way -- which looks
 * exactly like a patch that worked, if all you have is a screenshot.
 *
 * So this drives the real page at midnight and measures the pixels the player is
 * actually made of:
 *
 *  - the body is lit when a light is switched on, leans toward that light's own
 *    hue -- warm for the torch, cool for the orb -- and is not blown out;
 *  - top and bottom of the body land within a narrow ratio of each other, which
 *    is the uniformity a flame at head height cannot give;
 *  - across the reach slider the ground climbs and the body does not, which is
 *    what says the body is lit from the apparent distance and not the real one;
 *  - `Player casts torch shadow` darkens both the ground around the player and
 *    the player, which is the whole of why it is off by default.
 *
 * Serves `dist/` rather than the dev server, so what is measured is what ships.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4321;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';

/** Software WebGL: there is no GPU in CI or in an agent's container. */
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/**
 * The box around the health bar the body is looked for in, in CSS pixels: from
 * a little over the head down past the feet, and the figure's width either side.
 */
const BODY_SEARCH = { left: -45, top: -10, width: 90, height: 130 };

/**
 * How far below the bar to aim the cursor to hover the body, in CSS pixels.
 *
 * Several, tried in turn until one produces a figure-sized mask. The bar hangs
 * over the head and the pick is the body's own geometry since spec 095, so how
 * far down the column is solid depends on which way the figure is facing and
 * what it is doing with its arms -- one fixed drop came back empty on about
 * half the readings.
 */
const BODY_DROPS = [42, 30, 55, 68, 20];

/**
 * How much brighter a pixel must go when the cursor lands on the body to count
 * as one of the body's own.
 *
 * The hover highlight is an emissive term worth 35% of each material's colour
 * (`highlight.ts`), so a real body pixel moves by tens of levels while the
 * ground beside it does not move at all. Comfortably above two frames' own
 * churn and comfortably below what the highlight actually does.
 */
const HOVER_LIFT = 10;

/** A mask smaller or larger than this is not a figure, and is not measured. */
const MASK_MIN = 300;
const MASK_MAX = 8000;

/**
 * Where the "is the world still lit" patch is taken, relative to the same bar:
 * past the figure, and inside the torch's default reach.
 */
const GROUND_DROP = 96;
const GROUND_ACROSS = 62;
const GROUND_PATCH = 30;

/**
 * The window around the player two frames are compared over, in CSS pixels.
 *
 * Wide enough to hold whatever silhouette the player throws at any heading --
 * the torch is carried at one shoulder, so which way the shadow falls depends on
 * which way they happen to be facing -- and narrow enough that most of what
 * moves inside it is the thing being toggled.
 */
const AROUND = 320;

interface Patch {
  readonly mean: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** The warmth of a patch: how much red it has over its blue. */
function warmth(patch: Patch): number {
  return patch.r - patch.b;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The pixels the player's own body is drawn on, found rather than guessed.
 *
 * Offsets from the health bar were the first attempt and were wrong twice over:
 * a patch below the bar landed in the pool of torchlight the figure stands in,
 * and one a little lower landed on the unlit flame mesh, which is the brightest
 * thing in frame. Both reported a gloriously lit body while measuring no part
 * of one.
 *
 * So the body says where it is. Hovering a unit brightens its rig and nothing
 * else in the scene (spec 095), so the pixels that move when the cursor lands on
 * it *are* the rig -- ground, flame, orb and every other body excluded by
 * construction.
 */
interface BodyMask {
  /** Indices into a frame's `data`, one per body pixel, already times four. */
  readonly pixels: readonly number[];
  /** The same, split at the body's middle, for the top-to-bottom check. */
  readonly upper: readonly number[];
  readonly lower: readonly number[];
}

function maskFrom(cold: PNG, warm: PNG, box: Box): BodyMask {
  const pixels: number[] = [];
  const rows: number[] = [];
  for (let y = Math.max(0, box.top); y < Math.min(cold.height, box.top + box.height); y++) {
    for (let x = Math.max(0, box.left); x < Math.min(cold.width, box.left + box.width); x++) {
      const i = (y * cold.width + x) * 4;
      const before = ((cold.data[i] ?? 0) + (cold.data[i + 1] ?? 0) + (cold.data[i + 2] ?? 0)) / 3;
      const after = ((warm.data[i] ?? 0) + (warm.data[i + 1] ?? 0) + (warm.data[i + 2] ?? 0)) / 3;
      if (after - before < HOVER_LIFT) continue;
      pixels.push(i);
      rows.push(y);
    }
  }
  const middle = rows.length > 0 ? (Math.min(...rows) + Math.max(...rows)) / 2 : 0;
  const upper: number[] = [];
  const lower: number[] = [];
  pixels.forEach((i, n) => ((rows[n] ?? 0) < middle ? upper : lower).push(i));
  return { pixels, upper, lower };
}

function sampleMask(png: PNG, pixels: readonly number[]): Patch {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of pixels) {
    r += png.data[i] ?? 0;
    g += png.data[i + 1] ?? 0;
    b += png.data[i + 2] ?? 0;
  }
  const n = Math.max(1, pixels.length);
  return { mean: (r + g + b) / (3 * n), r: r / n, g: g / n, b: b / n };
}

function samplePatch(png: PNG, left: number, top: number, size: number): Patch {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.max(0, Math.round(top)); y < Math.min(png.height, Math.round(top + size)); y++) {
    for (let x = Math.max(0, Math.round(left)); x < Math.min(png.width, Math.round(left + size)); x++) {
      const i = (y * png.width + x) * 4;
      r += png.data[i] ?? 0;
      g += png.data[i + 1] ?? 0;
      b += png.data[i + 2] ?? 0;
      n++;
    }
  }
  if (n === 0) return { mean: 0, r: 0, g: 0, b: 0 };
  return { mean: (r + g + b) / (3 * n), r: r / n, g: g / n, b: b / n };
}

/** How many pixels of a box differ between two frames, and by how much on average. */
function boxDelta(a: PNG, b: PNG, box: Box): { changed: number; meanShift: number } {
  let changed = 0;
  let shift = 0;
  let n = 0;
  for (let y = Math.max(0, box.top); y < Math.min(a.height, b.height, box.top + box.height); y++) {
    for (let x = Math.max(0, box.left); x < Math.min(a.width, b.width, box.left + box.width); x++) {
      const i = (y * a.width + x) * 4;
      const before = ((a.data[i] ?? 0) + (a.data[i + 1] ?? 0) + (a.data[i + 2] ?? 0)) / 3;
      const after = ((b.data[i] ?? 0) + (b.data[i + 1] ?? 0) + (b.data[i + 2] ?? 0)) / 3;
      if (Math.abs(after - before) > 8) changed++;
      shift += after - before;
      n++;
    }
  }
  return { changed, meanShift: n > 0 ? shift / n : 0 };
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server never came up at ${url}`);
}

async function waitForTick(page: Page, ticks: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const text = (await page.textContent('body')) ?? '';
    last = Number(/tick (\d+)/.exec(text)?.[1] ?? -1);
    if (last >= ticks) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`sim never reached tick ${ticks} (last seen: ${last})`);
}

/**
 * Where the local player's own health bar is, which is where the body is.
 *
 * `x` is the bar's **centre**, not its left edge. That distinction cost a run:
 * hovering at `offsetLeft` aims some twenty-five pixels to the left of the
 * figure, which lands on the body about half the time and on the grass the
 * other half -- and a hover that misses returns an empty mask, not a wrong one.
 */
async function selfBar(page: Page): Promise<{ x: number; y: number }> {
  const found = await page.$$eval('[data-entity]', (nodes) =>
    nodes
      .map((node) => node as HTMLElement)
      .filter((element) => element.dataset['self'] !== undefined)
      .map((element) => ({ x: element.offsetLeft + element.offsetWidth / 2, y: element.offsetTop })),
  );
  const bar = found[0];
  if (!bar) throw new Error('the local player has no bar on screen');
  return bar;
}

/** Open a settings popover by the label on its button, and close it again. */
async function withMenu(page: Page, label: string, body: () => Promise<void>): Promise<void> {
  await page.click(`button[aria-label="${label}"]`);
  await page.waitForTimeout(120);
  await body();
  await page.click(`button[aria-label="${label}"]`);
  await page.waitForTimeout(120);
}

/** Set a range input by the text of the row it sits in. */
async function setSlider(page: Page, label: string, value: number): Promise<void> {
  await page.$eval(
    `label:has-text("${label}") input[type=range]`,
    (node, v) => {
      const input = node as HTMLInputElement;
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value,
  );
}

async function setCheckbox(page: Page, label: string, on: boolean): Promise<void> {
  const selector = `label:has-text("${label}") input[type=checkbox]`;
  const checked = await page.$eval(selector, (node) => (node as HTMLInputElement).checked);
  if (checked !== on) await page.click(selector);
}

/** Hold the sky at midnight, so a measurement is not racing the clock. */
async function holdAtMidnight(page: Page): Promise<void> {
  await withMenu(page, 'Day and night', async () => {
    await setCheckbox(page, 'Run the clock', false);
    await setSlider(page, 'Time', 0);
  });
}

/**
 * Switch the retro filter off for the duration.
 *
 * Not housekeeping: it quantizes each channel to twelve steps, which is a step
 * of twenty-one levels. Anything smaller reaches a screenshot as dither noise or
 * as nothing, and the hover lift the body mask is found by sits right on that
 * boundary -- with the filter on the mask came back as 166 scattered pixels of a
 * figure a hundred tall.
 */
async function dropTheFilter(page: Page): Promise<void> {
  await withMenu(page, 'Retro filter', async () => {
    await setCheckbox(page, 'Retro filter', false);
  });
}

/** Still the flame, and open at a known reach. */
async function settleTheTorch(page: Page): Promise<void> {
  await withMenu(page, 'Player lights', async () => {
    // The flicker runs from 0.55 to 1.35, so two frames a second apart differ by
    // more than anything this script toggles -- the first run of it read a 38%
    // brighter body off nothing but the flame.
    await setSlider(page, 'Flicker', 0);
    await setSlider(page, 'Torch range', 300);
  });
}

async function frame(page: Page): Promise<PNG> {
  await page.waitForTimeout(400);
  return PNG.sync.read(await page.screenshot());
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  console.log(`  wrote ${name}.png`);
}

/** Everything one lighting condition has to say, measured off its own frames. */
interface Reading {
  readonly body: Patch;
  readonly top: Patch;
  readonly bottom: Patch;
  readonly ground: Patch;
  readonly found: number;
  readonly frame: PNG;
  readonly around: Box;
}

/**
 * Photograph the current condition and measure the body in it.
 *
 * The mask is re-derived here rather than taken once at the start, and that is
 * not caution: the first version captured it once and every later reading
 * disagreed with itself, because the world does not hold still for a screenshot
 * harness. A body a monster has nudged three pixels is a mask over the ground
 * beside it, and the ground is lit ten times harder than the body -- so a stale
 * mask does not merely add noise, it reports the ground's own behaviour under
 * the body's name. Each reading now takes its own pair of frames a moment apart
 * and finds the figure where it is *now*.
 */
async function read(page: Page): Promise<Reading> {
  const bar = await selfBar(page);
  const parked = { x: Math.max(20, bar.x - 320), y: bar.y + 220 };
  const box = {
    left: bar.x + BODY_SEARCH.left,
    top: bar.y + BODY_SEARCH.top,
    width: BODY_SEARCH.width,
    height: BODY_SEARCH.height,
  };

  await page.mouse.move(parked.x, parked.y);
  const cold = await frame(page);

  let mask = maskFrom(cold, cold, box);
  for (const drop of BODY_DROPS) {
    await page.mouse.move(bar.x, bar.y + drop);
    const warm = await frame(page);
    const found = maskFrom(cold, warm, box);
    if (found.pixels.length > mask.pixels.length) mask = found;
    if (mask.pixels.length > MASK_MIN) break;
  }
  await page.mouse.move(parked.x, parked.y);

  return {
    body: sampleMask(cold, mask.pixels),
    top: sampleMask(cold, mask.upper),
    bottom: sampleMask(cold, mask.lower),
    ground: samplePatch(
      cold,
      bar.x + GROUND_ACROSS - GROUND_PATCH / 2,
      bar.y + GROUND_DROP,
      GROUND_PATCH,
    ),
    found: mask.pixels.length,
    frame: cold,
    around: { left: bar.x - AROUND / 2, top: bar.y - AROUND / 4, width: AROUND, height: AROUND },
  };
}

function report(name: string, reading: Reading): void {
  const line = (what: string, patch: Patch): string =>
    `${what} ${patch.mean.toFixed(1).padStart(6)} (${patch.r.toFixed(0)}/${patch.g.toFixed(0)}/${patch.b.toFixed(0)})`;
  console.log(
    `    ${name.padEnd(20)} ${line('body', reading.body)}  ` +
      `${line('top', reading.top)}  ${line('bottom', reading.bottom)}  ` +
      `${line('ground', reading.ground)}  [${reading.found}px]`,
  );
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });

  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };

  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });

    // Pinned, like every other harness here: without a seed the view falls back
    // to the clock and the body stands somewhere different every run.
    // The built page is the game client since spec 253 and builds none of the tuning
    // popovers; this harness drives three of them, so it asks the workbench back.
    await page.goto(`http://localhost:${PORT}/?seed=20260806&client=workbench`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });
    await waitForTick(page, 150);

    await holdAtMidnight(page);
    await dropTheFilter(page);
    await settleTheTorch(page);

    console.log('\nmidnight');
    await withMenu(page, 'Player lights', async () => {
      await setCheckbox(page, 'Torch', false);
      await setCheckbox(page, 'Magic light', false);
    });
    const dark = await read(page);
    await shoot(page, 'player-lights-none');
    report('no light carried', dark);

    await withMenu(page, 'Player lights', async () => {
      await setCheckbox(page, 'Torch', true);
    });
    const torch = await read(page);
    await shoot(page, 'player-lights-torch');
    report('torch', torch);

    const located = (reading: Reading): boolean =>
      reading.found > MASK_MIN && reading.found < MASK_MAX;
    check(located(dark) && located(torch), 'the hover highlight located the player’s own pixels');
    check(torch.body.mean > dark.body.mean, 'the torch lights the body carrying it');
    check(warmth(torch.body) > warmth(dark.body), 'and it is the flame’s own colour landing on it');
    check(torch.ground.mean > dark.ground.mean, 'the torch still lights the ground beside it');
    // Lit, not held against: a body a torch is pressed to clips on the near side.
    check(
      Math.max(torch.body.r, torch.body.g, torch.body.b) < 250,
      'and the body is lit rather than blown out',
    );

    // The uniformity the spec is named for, and the check that can tell the
    // patch working from the patch silently not applying. The flame hangs at head
    // height 44 units off: lit from *there*, the shoulders sit at a fraction of
    // that distance and the shins at several times it, and 1/d² turns that into a
    // near/far ratio around ten. From half the torch's range both are within a
    // fraction of a stop, and what is left between them is the moon's own shading.
    const spread = torch.top.mean / Math.max(1, torch.bottom.mean);
    console.log(`    top/bottom brightness ratio: ${spread.toFixed(2)}`);
    check(spread > 1 / 1.8 && spread < 1.8, 'and lit evenly top to bottom');

    // Reach and candela are the same number squared (`pointIntensity`), so how
    // lit the body is would follow this slider anywhere if the body were lit
    // from where the flame actually is. Measured from half the range it holds
    // still, because half the range is the distance `brightness` is defined at.
    //
    // The short end is in the table and out of the assertion on purpose: at a
    // range of 80 the half-range is 40 units and the flame's own anchor is 44,
    // so `carriedLightDistance` leaves the light exactly where it is. A lamp
    // with an 80-unit reach is meant to be an intimate light.
    console.log('\nacross the reach slider');
    const sweep: { range: number; reading: Reading }[] = [];
    for (const range of [80, 150, 300, 600, 900]) {
      await withMenu(page, 'Player lights', async () => {
        await setSlider(page, 'Torch range', range);
      });
      const reading = await read(page);
      report(`range ${range}`, reading);
      sweep.push({ range, reading });
    }
    const wide = sweep.filter((entry) => entry.range >= 300).map((entry) => entry.reading);
    const bodies = wide.map((reading) => reading.body.mean);
    const grounds = wide.map((reading) => reading.ground.mean);
    const span = (xs: number[]): number => Math.max(...xs) / Math.max(1, Math.min(...xs));
    console.log(`    over 300..900 -- body spans ${span(bodies).toFixed(2)}x, ground ${span(grounds).toFixed(2)}x`);
    check(span(bodies) < 1.25, 'tripling the reach barely moves how lit the body is');
    check(span(grounds) > 1.25, 'while it plainly moves how far the light throws');

    console.log('\nmagic orb on, torch off');
    await withMenu(page, 'Player lights', async () => {
      await setSlider(page, 'Torch range', 300);
      await setCheckbox(page, 'Torch', false);
      await setCheckbox(page, 'Magic light', true);
    });
    const orb = await read(page);
    await shoot(page, 'player-lights-orb');
    report('orb', orb);
    check(orb.body.mean > dark.body.mean, 'the orb lights the body it floats over');
    check(warmth(orb.body) < warmth(torch.body), 'and cools it -- the two do not land the same way');

    console.log('\nplayer casting into the torch’s shadow map');
    await withMenu(page, 'Player lights', async () => {
      await setCheckbox(page, 'Magic light', false);
      await setCheckbox(page, 'Torch', true);
    });
    const before = await read(page);
    await withMenu(page, 'Player lights', async () => {
      await setCheckbox(page, 'Player casts torch shadow', true);
    });
    const casting = await read(page);
    await shoot(page, 'player-lights-self-shadow');
    report('not casting', before);
    report('casting', casting);

    // Measured over a window rather than a patch: which way the silhouette falls
    // depends on which way the player happens to be facing, so a fixed patch is
    // a coin toss. What is not a coin toss is that a shadow appearing takes
    // light away from the ground around the caster.
    const shadowed = boxDelta(before.frame, casting.frame, before.around);
    console.log(
      `    pixels changed around the player: ${shadowed.changed}, ` +
        `mean shift ${shadowed.meanShift.toFixed(2)}`,
    );
    check(shadowed.changed > 200, 'the checkbox visibly changes the ground around the player');
    check(shadowed.meanShift < 0, 'and it changes it by taking light away, which is a shadow');
    // The other half of why it is off by default, and the half that only exists
    // because the player is lit by the torch again: a body drawn into the cube
    // map occludes the flame from its own far side, so it shadows itself.
    check(
      casting.body.mean < before.body.mean,
      'and the body shadows itself once it is drawn into the cube map',
    );

    // A blank frame passes every brightness comparison above by accident, so say
    // out loud that there is a picture here at all.
    check(torch.body.mean > 4, 'the body is drawn at all -- this is not a black frame');

    const shaderErrors = problems.filter((line) => /shader|glsl|program|compile/i.test(line));
    check(shaderErrors.length === 0, 'no shader failed to compile');
    for (const line of shaderErrors) console.error(`    ${line}`);

    if (problems.length > 0) {
      console.error('\npage reported errors:');
      for (const problem of problems) console.error(`  ${problem}`);
    }
  } finally {
    await browser.close();
    server.kill();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall checks passed');
  }
}

await main();
