/**
 * The movement keys, against the camera they are read in (spec 278).
 *
 *   npm run build && npx tsx scripts/probe-camera-relative.ts
 *
 * What spec 278 *decides* is pure and asserted in Node: that `groundForward`
 * flattens an offset, that `rotateToBasis` rotates and never reflects, that
 * `moveIntent` with a basis walks `W` along it and leaves every world point
 * alone. All of it is green beside a `view.ts` that passes no basis at all --
 * which is exactly the shape spec 176 found for markers and spec 254 for the
 * shipped client, and is the whole reason this file exists.
 *
 * Three questions, and they are three because each can be true while the next
 * is false:
 *
 *  - **the basis follows the camera.** `data-move-basis` is the world bearing
 *    `move.north` currently walks along, published from the vector actually
 *    handed to `moveIntent`; `data-camera-orbit` is where the *slider* points.
 *    Turn the view and the first must follow the second, half a turn apart.
 *  - **the legs follow the basis.** Measured off `data-self-at`, which is where
 *    the body actually is -- a fact about the server rather than about this
 *    client's bookkeeping. A basis computed correctly and wired to nothing
 *    would pass the first check perfectly and fail this one.
 *  - **it turns smoothly.** The basis is read from the *drawn* camera, so
 *    during a swing it trails the slider by the ease and converges after it.
 *    Steered by the target instead, the two would be equal on every frame --
 *    which is the same reading a broken ease gives, so what is checked is the
 *    gap opening *and* closing rather than either alone.
 *
 * Every wait is a poll, and that is not tidiness: this environment paints the
 * page at about five frames a second under software GL, and both the camera
 * swing and the ease are per-frame quantities -- `orbitStep` clamps its own
 * step to a tenth of a second and `CAMERA_SMOOTH` closes 15% of the gap a
 * frame -- so a turn that takes one second on a real machine takes several
 * here. Waited out with a constant, the probe reads the bearing before the
 * turn and reports a working feature as a broken one.
 *
 * The arena has 6942 trees in it, so a walk is **measured for straightness as
 * well as for distance** and retried when it bends: a body sliding along a
 * trunk travels perfectly well in the wrong direction, which is the one failure
 * that would otherwise read as a wrongly rotated basis. `probe-chat.ts` records
 * the same hazard costing it a working keyboard read as a broken one.
 *
 * Serves `dist/`, so what is probed is what ships. Prints a summary and exits
 * non-zero on any problem. Nothing in CI depends on it.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { ORBIT_RIGHT_KEY } from '../src/render/iso3d/world/orbit-keys.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4341;

/** The same browser the other previews drive: no GPU here, so software GL. */
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** How far the body must travel before a bearing read off it means anything. */
const WALK_MIN = 40;
/** How far apart a walk's two halves may point before it is a slide, degrees. */
const STRAIGHT_DEG = 20;
/**
 * How far a measured bearing may sit from the published basis, degrees.
 *
 * Generous on purpose. What is being asked is "did the walk turn with the
 * camera", and the alternative hypothesis is a basis that reaches nothing --
 * which is wrong by whatever the camera was turned, a quarter turn. A tolerance
 * this wide cannot mistake one for the other, and it absorbs the rounding on
 * `data-self-at` (whole world units) and whatever the ground did to the step.
 */
const AIM_DEG = 30;
/** How far the view is swung between measurements. */
const TURN_DEG = 90;

const problems: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
}

/** Signed degrees from `b` to `a`, in (-180, 180]. */
function degreesApart(a: number, b: number): number {
  return Math.atan2(Math.sin(((a - b) * Math.PI) / 180), Math.cos(((a - b) * Math.PI) / 180)) * (180 / Math.PI);
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${url} never came up`);
}

/**
 * One of the Play tab's `data-` handles.
 *
 * By selector rather than off `documentElement`, because the tab writes them on
 * a div of its own -- the same way `probe-stop.ts` and `probe-editor-props.ts`
 * ask. An absent attribute answers `''`, which every caller below turns into a
 * `NaN` and fails on rather than reading as a bearing of zero.
 */
async function dataset(page: Page, attribute: string, key: string): Promise<string> {
  return page.evaluate(
    ([selector, name]) =>
      document.querySelector<HTMLElement>(`[${selector ?? ''}]`)?.dataset[name ?? ''] ?? '',
    [attribute, key] as const,
  );
}

/** Where the body is, in whole world units. */
async function at(page: Page): Promise<{ x: number; y: number }> {
  const text = await dataset(page, 'data-self-at', 'selfAt');
  const [x, y] = text.split(',').map(Number);
  return { x: x ?? 0, y: y ?? 0 };
}

/** The bearing `move.north` currently walks along, degrees. */
async function basis(page: Page): Promise<number> {
  return Number(await dataset(page, 'data-move-basis', 'moveBasis'));
}

/** Where the *slider* has the camera, as a forward bearing rather than an offset. */
async function sliderBearing(page: Page): Promise<number> {
  return Number(await dataset(page, 'data-camera-orbit', 'cameraOrbit')) + 180;
}

function apart(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function bearingOf(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

/**
 * Wait until the sim has run *and* the world is on screen.
 *
 * The tick alone is not enough: the loading overlay is a full-viewport div with
 * pointer events on, so until it goes every press lands on it rather than on the
 * canvas the handlers are attached to.
 */
async function waitForWorld(page: Page, ticks: number, timeoutMs = 600_000): Promise<void> {
  await page.waitForSelector('[data-world-ready]', { timeout: timeoutMs });
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

/** Poll `read` until `done`, and answer what it last saw either way. */
async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let seen = await read();
  while (!done(seen) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    seen = await read();
  }
  return seen;
}

/**
 * Hold `W` and answer which way the body actually went.
 *
 * Sampled in two halves so a slide can be told from a walk: a body pressed into
 * a trunk keeps travelling and stops travelling in a straight line, and the
 * bend is the only thing that separates it from a basis rotated wrongly.
 */
async function walkBearing(page: Page): Promise<{ bearing: number; travelled: number } | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const from = await at(page);
    await page.keyboard.down('KeyW');
    const mid = await until(
      () => at(page),
      (now) => apart(from, now) >= WALK_MIN / 2,
      6000,
    );
    const to = await until(
      () => at(page),
      (now) => apart(from, now) >= WALK_MIN,
      6000,
    );
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(300);

    const travelled = apart(from, to);
    const straight =
      apart(from, mid) >= WALK_MIN / 4 &&
      apart(mid, to) >= WALK_MIN / 4 &&
      Math.abs(degreesApart(bearingOf(from, mid), bearingOf(mid, to))) <= STRAIGHT_DEG;
    if (travelled >= WALK_MIN && straight) {
      return { bearing: bearingOf(from, to), travelled };
    }
    // Blocked or bent. Step aside under whatever basis is live and try again on
    // a different patch of ground -- which is the same repair `probe-chat.ts`
    // makes by trying every direction, in a probe where the direction is the
    // subject and cannot be varied.
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(700);
    await page.keyboard.up('KeyD');
    await page.waitForTimeout(300);
  }
  return null;
}

/** Swing the view clockwise by `degrees`, and answer what the slider reached. */
async function turnView(page: Page, degrees: number): Promise<number> {
  const from = Number(await dataset(page, 'data-camera-orbit', 'cameraOrbit'));
  await page.keyboard.down(ORBIT_RIGHT_KEY);
  const reached = await until(
    async () => Number(await dataset(page, 'data-camera-orbit', 'cameraOrbit')),
    (now) => Math.abs(degreesApart(now, from)) >= degrees,
    30_000,
  );
  await page.keyboard.up(ORBIT_RIGHT_KEY);
  return degreesApart(reached, from);
}

async function main(): Promise<void> {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(`http://localhost:${PORT}/?seed=20260806`, { waitUntil: 'domcontentloaded' });

    // The shipped page opens on the title screen (spec 255), and that overlay is
    // `inset: 0` -- so nothing below is being driven until Start has taken it
    // away. It costs the keys as well as the pointer here: the world behind it
    // is mounted and running, so a probe that skipped this would read a
    // perfectly correct `data-move-basis` beside a body that never took a step,
    // which is what the first run of this file did.
    await page.waitForSelector('[data-title][data-title-ready="true"]', { timeout: 120_000 });
    await page.click('[data-title-entry="start"]', { position: { x: 6, y: 6 } });
    await page.waitForSelector('[data-title]', { state: 'detached', timeout: 30_000 });
    console.log('  through the title screen');
    await waitForWorld(page, 30);

    console.log('the basis is published at all');
    const opening = await basis(page);
    check(Number.isFinite(opening), `data-move-basis is a bearing (${opening})`);
    check(
      Math.abs(degreesApart(opening, await sliderBearing(page))) <= 1,
      `and it agrees with the resting camera (basis ${opening.toFixed(1)}, slider ${(await sliderBearing(page)).toFixed(1)})`,
    );

    console.log('the legs follow it');
    const before = await walkBearing(page);
    if (!before) {
      check(false, 'holding W walks the body somewhere in a straight line');
    } else {
      check(
        Math.abs(degreesApart(before.bearing, opening)) <= AIM_DEG,
        `W walks along the basis (walked ${before.bearing.toFixed(1)} over ${before.travelled.toFixed(0)} units, basis ${opening.toFixed(1)})`,
      );
    }

    console.log('turning the view turns the walk');
    const turned = await turnView(page, TURN_DEG);
    check(Math.abs(turned) >= TURN_DEG - 5, `the view swung (${turned.toFixed(1)} degrees)`);

    // The ease, caught while it is still running. The basis is read from the
    // drawn camera, so right after the key is let go the slider is ahead of it;
    // steered by the slider the two would already be equal, which is also what
    // a broken ease looks like -- so both halves are required.
    const lag = Math.abs(degreesApart(await basis(page), await sliderBearing(page)));
    const settled = await until(
      async () => Math.abs(degreesApart(await basis(page), await sliderBearing(page))),
      (gap) => gap <= 2,
      30_000,
    );
    check(lag > 2, `the basis trails the slider during the swing (${lag.toFixed(1)} degrees behind)`);
    check(settled <= 2, `and catches up once it stops (${settled.toFixed(1)} degrees)`);

    const after = await basis(page);
    check(
      Math.abs(degreesApart(degreesApart(after, opening), turned)) <= 5,
      `the basis turned with the camera (basis moved ${degreesApart(after, opening).toFixed(1)}, camera ${turned.toFixed(1)})`,
    );

    const walked = await walkBearing(page);
    if (!walked) {
      check(false, 'holding W still walks the body after the turn');
    } else if (before) {
      check(
        Math.abs(degreesApart(walked.bearing, after)) <= AIM_DEG,
        `W still walks along the basis (walked ${walked.bearing.toFixed(1)} over ${walked.travelled.toFixed(0)} units, basis ${after.toFixed(1)})`,
      );
      // The measurement the whole file is for, and the one an attribute cannot
      // fake: the ground the body covered turned by what the camera turned by.
      const swung = degreesApart(walked.bearing, before.bearing);
      check(
        Math.abs(degreesApart(swung, turned)) <= AIM_DEG,
        `the walk turned with the view (walk ${swung.toFixed(1)} degrees, view ${turned.toFixed(1)})`,
      );
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('\nW walks away from the camera, and turns with it rather than ahead of it');
  }
}

await main();
