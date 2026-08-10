/**
 * Photograph and measure the player's own lights (spec 118), in a real browser.
 *
 *   npm run build && npx tsx scripts/preview-player-lights.ts
 *
 * The half of this change that no headless test can reach. `player-lights.ts`
 * pins the tint's arithmetic in Node and `player-lights.test.ts` pins the string
 * the mask rewrites, but neither can answer the only question that matters once
 * a shader has been edited: **did it compile, and is the player still there.**
 * three.js logs a failed compile and carries on drawing, so a broken patch is a
 * console line and a body that renders untouched -- which looks exactly like a
 * patch that worked, if all you have is a screenshot.
 *
 * So this drives the real page at midnight and measures the pixels the player is
 * made of, with each light on and off:
 *
 *  - the body brightens when a light is switched on, and leans toward that
 *    light's own hue -- warm for the torch, cool for the orb;
 *  - the ground beside the body brightens too, which is what says the light is
 *    still lighting the *world* rather than having been switched off entirely;
 *  - toggling `Player casts torch shadow` changes the ground under the player
 *    and nothing about the body.
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
 * How far below the health bar the body's own pixels start, and how big a patch
 * of them to average, in CSS pixels.
 *
 * The bar hangs at the top of the head, so dropping this far lands in the torso.
 * The patch is deliberately narrow: a wide one would take in the ground either
 * side of the figure, and the ground is lit by the torch -- which would report a
 * brightening body when the mask had done nothing at all.
 */
const BODY_DROP = 40;
const BODY_PATCH = 12;

/**
 * Where the "is the world still lit" patch is taken, relative to the same bar.
 * Far enough out to be past the figure, near enough to be inside the torch's
 * reach.
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
function boxDelta(
  a: PNG,
  b: PNG,
  left: number,
  top: number,
  size: number,
): { changed: number; meanShift: number } {
  let changed = 0;
  let shift = 0;
  let n = 0;
  for (let y = Math.max(0, Math.round(top)); y < Math.min(a.height, b.height, top + size); y++) {
    for (let x = Math.max(0, Math.round(left)); x < Math.min(a.width, b.width, left + size); x++) {
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

function report(name: string, patch: Patch): void {
  console.log(
    `    ${name.padEnd(22)} mean ${patch.mean.toFixed(1).padStart(6)}  ` +
      `rgb ${patch.r.toFixed(1)}/${patch.g.toFixed(1)}/${patch.b.toFixed(1)}  ` +
      `warmth ${warmth(patch).toFixed(1)}`,
  );
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

/** Where the local player's own health bar is, which is where the body is. */
async function selfBar(page: Page): Promise<{ x: number; y: number }> {
  const found = await page.$$eval('[data-entity]', (nodes) =>
    nodes
      .map((node) => node as HTMLElement)
      .filter((element) => element.dataset['self'] !== undefined)
      .map((element) => ({ x: element.offsetLeft, y: element.offsetTop })),
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

async function frame(page: Page): Promise<PNG> {
  await page.waitForTimeout(500);
  return PNG.sync.read(await page.screenshot());
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  console.log(`  wrote ${name}.png`);
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
    await page.goto(`http://localhost:${PORT}/?seed=20260806`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });
    await waitForTick(page, 150);

    await holdAtMidnight(page);

    const bar = await selfBar(page);
    const bodyBox = { left: bar.x - BODY_PATCH / 2, top: bar.y + BODY_DROP };
    const groundBox = { left: bar.x + GROUND_ACROSS, top: bar.y + GROUND_DROP };
    const body = (png: PNG): Patch => samplePatch(png, bodyBox.left, bodyBox.top, BODY_PATCH);
    const ground = (png: PNG): Patch => samplePatch(png, groundBox.left, groundBox.top, GROUND_PATCH);

    console.log('\nmidnight, no light carried');
    await withMenu(page, 'Player lights', async () => {
      await setCheckbox(page, 'Torch', false);
      await setCheckbox(page, 'Magic light', false);
      // The flame is stilled for every measurement below. The flicker runs from
      // 0.55 to 1.35 and the filter carries it on purpose, so two frames taken a
      // second apart differ by more than anything this script is toggling --
      // the first run of it read a 38% brighter body off nothing but the flame.
      await setSlider(page, 'Flicker', 0);
    });
    const dark = await frame(page);
    await shoot(page, 'player-lights-none');
    report('body', body(dark));
    report('ground beside', ground(dark));

    console.log('\ntorch on');
    await withMenu(page, 'Player lights', async () => {
      await setCheckbox(page, 'Torch', true);
    });
    const torch = await frame(page);
    await shoot(page, 'player-lights-torch');
    report('body', body(torch));
    report('ground beside', ground(torch));

    check(body(torch).mean > body(dark).mean, 'the torch brightens the body it is carried by');
    check(
      warmth(body(torch)) > warmth(body(dark)),
      'and warms it -- the filter is in the flame’s own colour',
    );
    check(ground(torch).mean > ground(dark).mean, 'the torch still lights the ground beside it');

    // The headline, and the one measurement that can tell the mask working from
    // the mask silently not applying: pull the torch's *reach* in. A point light
    // still landing on the body would drag it with the ground, because reach and
    // candela are the same number squared (`pointIntensity`). The filter is a
    // function of brightness alone, so a body under it does not move at all.
    console.log('\ntorch reach pulled right in');
    await withMenu(page, 'Player lights', async () => {
      await setSlider(page, 'Torch range', 80);
    });
    const near = await frame(page);
    report('body', body(near));
    report('ground beside', ground(near));
    check(
      ground(near).mean < ground(torch).mean - 20,
      'the ground beside the player falls out of the light',
    );
    check(
      Math.abs(body(near).mean - body(torch).mean) < 6,
      'and the body does not follow it -- the point light is off the body',
    );
    await withMenu(page, 'Player lights', async () => {
      await setSlider(page, 'Torch range', 300);
    });

    console.log('\nmagic orb on, torch off');
    await withMenu(page, 'Player lights', async () => {
      await setCheckbox(page, 'Torch', false);
      await setCheckbox(page, 'Magic light', true);
    });
    const orb = await frame(page);
    await shoot(page, 'player-lights-orb');
    report('body', body(orb));
    report('ground beside', ground(orb));

    check(body(orb).mean > body(dark).mean, 'the orb brightens the body it floats over');
    check(
      warmth(body(orb)) < warmth(body(torch)),
      'and cools it -- the two lights do not tint the same way',
    );

    console.log('\nplayer casting into the torch’s shadow map');
    await withMenu(page, 'Player lights', async () => {
      await setCheckbox(page, 'Magic light', false);
      await setCheckbox(page, 'Torch', true);
      await setCheckbox(page, 'Player casts torch shadow', true);
    });
    const casting = await frame(page);
    await shoot(page, 'player-lights-self-shadow');
    report('body', body(casting));
    report('ground beside', ground(casting));

    // Measured over a window rather than one patch: which way the silhouette
    // falls depends on which way the player is facing, so a fixed patch is a
    // coin toss. What is not a coin toss is that a shadow appearing takes light
    // *away* from the ground around the caster.
    const shadowed = boxDelta(torch, casting, bar.x - AROUND / 2, bar.y - AROUND / 4, AROUND);
    console.log(
      `    pixels changed around the player: ${shadowed.changed}, ` +
        `mean shift ${shadowed.meanShift.toFixed(2)}`,
    );
    check(shadowed.changed > 200, 'the checkbox visibly changes the ground around the player');
    check(shadowed.meanShift < 0, 'and it changes it by taking light away, which is what a shadow is');
    check(
      Math.abs(body(casting).mean - body(torch).mean) < 6,
      'while leaving the body’s own shading alone',
    );

    // A blank frame passes every brightness comparison above by accident, so
    // say out loud that there is a picture here at all.
    check(body(torch).mean > 4, 'the body is drawn at all -- this is not a black frame');

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
