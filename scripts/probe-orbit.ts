/**
 * Turn the camera with the keyboard, in a real browser (spec 129).
 *
 * `orbit-keys.ts` is pure and tested in Node, but it answers only "how many
 * degrees this frame". Everything that makes those degrees reach the camera is
 * DOM: the key lands in `view.ts`'s held set, the frame loop calls `orbitBy`,
 * and `orbitBy` writes a range input that the scene reads back. Vitest runs on
 * `environment: 'node'`, so none of that is reachable from the suite -- which is
 * exactly where both of this feature's real bugs lived. One handed degrees to a
 * helper that wanted radians and multiplied them by 57.3; the other wrote a
 * fraction of a degree to a slider with a step of 1, where the browser rounded
 * it straight back to where it started.
 *
 *   npm run build && npx tsx scripts/probe-orbit.ts
 *
 * Serves `dist/` rather than the dev server, so what is driven is what ships.
 * Exits non-zero if a key did not turn the view.
 *
 * Since spec 139 it drives the two-finger swipe as well, in a second, phone-
 * shaped context -- and the keyboard half is a regression test now rather than a
 * feature check: `[` and `]` were dead for eleven specs, because `orbitStep`
 * reads key codes and the set it was handed started holding rebindable action
 * ids in spec 125. The pure test passed the whole time. This is the check that
 * would not have.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4323;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** Degrees per second the keys are meant to turn at; mirrors `orbit-keys.ts`. */
const DEG_PER_SECOND = 90;
/** Degrees per canvas pixel a two-finger swipe turns at; mirrors it too (spec 139). */
const DEG_PER_PX = 0.25;

interface Point {
  readonly x: number;
  readonly y: number;
}

const problems: string[] = [];
function check(what: string, ok: boolean, saw: string): void {
  if (ok) console.log(`  ok    ${what}`);
  else {
    console.log(`  BROKE ${what} -- saw: ${saw}`);
    problems.push(what);
  }
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${url} never came up`);
}

/**
 * The Orbit slider's live value, in degrees.
 *
 * Read straight out of the input rather than from any state of our own: the
 * panel *is* where the camera's azimuth lives, so a number that agrees with the
 * slider is the only one worth asserting on.
 */
async function orbitDegrees(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('label'));
    const row = rows.find((r) => r.querySelector('span > span')?.textContent === 'Orbit');
    const input = row?.querySelector('input[type=range]');
    return input ? Number((input as HTMLInputElement).value) : Number.NaN;
  });
}

/**
 * The same angle, without the panel.
 *
 * A phone does not build the settings popovers at all (spec 139), so the slider
 * `orbitDegrees` reads is not in the document on exactly the device the swipe is
 * for. `view.ts` publishes the number it writes as `data-camera-orbit`, the same
 * way it publishes the interface's scale and open windows. `data-camera-zoom`
 * sits beside it, and `scripts/preview-touch.ts` reads that one for the same
 * reason: the pinch writes a slider a phone does not have either.
 */
async function publishedOrbit(page: Page): Promise<number> {
  const text = await page.getAttribute('[data-camera-orbit]', 'data-camera-orbit');
  return text === null ? Number.NaN : Number(text);
}

/** Hold a key down for a while, and report how long it was actually held. */
async function hold(page: Page, ...codes: string[]): Promise<{ before: number; after: number; seconds: number }> {
  const before = await orbitDegrees(page);
  const start = Date.now();
  for (const code of codes) await page.keyboard.down(code);
  await page.waitForTimeout(1000);
  for (const code of codes) await page.keyboard.up(code);
  const seconds = (Date.now() - start) / 1000;
  // The last frame to see the key held may still be in flight.
  await page.waitForTimeout(200);
  return { before, after: await orbitDegrees(page), seconds };
}

/** Shortest signed way round from `a` to `b`, in degrees. */
function turnBetween(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

/** How many pixels of the two frames differ by more than a hair. */
function pixelsChanged(a: Buffer, b: Buffer): number {
  const one = PNG.sync.read(a);
  const two = PNG.sync.read(b);
  if (one.width !== two.width || one.height !== two.height) return one.width * one.height;
  let changed = 0;
  for (let i = 0; i < one.data.length; i += 4) {
    const dr = Math.abs(one.data.readUInt8(i) - two.data.readUInt8(i));
    const dg = Math.abs(one.data.readUInt8(i + 1) - two.data.readUInt8(i + 1));
    const db = Math.abs(one.data.readUInt8(i + 2) - two.data.readUInt8(i + 2));
    if (dr > 8 || dg > 8 || db > 8) changed += 1;
  }
  return changed;
}

/**
 * Turn the camera with two fingers, in a phone-shaped frame (spec 139).
 *
 * Its own context because the gesture only exists on a touch device, and
 * `hasTouch` is what makes `(pointer: coarse)` match -- which is also what takes
 * the settings panel away, so the angle is read from `data-camera-orbit`.
 *
 * Through CDP rather than Playwright's touchscreen, for the reason
 * `preview-touch.ts` gives: it has no two-finger gesture, and two fingers are
 * the whole of this.
 */
async function probeSwipe(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage();
    page.on('pageerror', (error) => problems.push(String(error)));
    const cdp = await context.newCDPSession(page);

    await page.goto(`http://localhost:${PORT}/?seed=20260806`, { waitUntil: 'load' });
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });
    await page.waitForTimeout(2000);

    // The panel is gone on a finger, which is itself worth saying out loud here:
    // if it came back, the rest of this probe would be reading the wrong thing.
    check(
      'a phone has no settings panel to read the angle off',
      !Number.isFinite(await orbitDegrees(page)),
      'the Orbit slider is in the document',
    );

    const start = await publishedOrbit(page);
    check('a phone publishes the camera angle', Number.isFinite(start), String(start));

    const DISTANCE = 300;
    const before = await page.screenshot({ path: join(outDir, 'orbit-swipe-before.png') });
    await swipe(cdp, { x: 250, y: 195 }, DISTANCE);
    await page.waitForTimeout(300);
    const swung = turnBetween(start, await publishedOrbit(page));

    // Right, so the world follows the fingers and the camera goes anticlockwise.
    check('a two-finger swipe right turns the view anticlockwise', swung < -1, `${swung.toFixed(1)}°`);
    // The ceiling again, and for the same reason: "it moved, and the right way"
    // passes happily when degrees have been handed to something wanting radians.
    check(
      'it turns at about the rate it claims',
      Math.abs(swung) <= DISTANCE * DEG_PER_PX * 1.15,
      `${swung.toFixed(1)}° for ${DISTANCE}px, at most ${(DISTANCE * DEG_PER_PX).toFixed(0)}°`,
    );

    const after = await page.screenshot({ path: join(outDir, 'orbit-swipe-after.png') });
    const moved = pixelsChanged(before, after);
    check('the frame is drawn from somewhere else afterwards', moved > 20_000, `${moved} px differ`);

    // ...and the other way turns back.
    const mid = await publishedOrbit(page);
    await swipe(cdp, { x: 550, y: 195 }, -DISTANCE);
    await page.waitForTimeout(300);
    const back = turnBetween(mid, await publishedOrbit(page));
    check('a two-finger swipe left turns the view clockwise', back > 1, `${back.toFixed(1)}°`);
  } finally {
    await context.close();
  }
}

/**
 * Two fingers sliding sideways, their separation held.
 *
 * Stepped rather than jumped, because each report is measured against the last
 * one -- and both fingers are moved on every step, since a browser delivers one
 * pointer per event and a step that moved only one would be half spread.
 */
async function swipe(cdp: CDPSession, start: Point, by: number, steps = 12): Promise<void> {
  const SPREAD = 120;
  const at = (dx: number): { x: number; y: number; id: number }[] => [
    { x: start.x + dx, y: start.y, id: 1 },
    { x: start.x + SPREAD + dx, y: start.y, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  for (let step = 1; step <= steps; step++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at((by * step) / steps) });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    throw new Error('no dist/ -- run `npm run build` first');
  }

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
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (error) => problems.push(String(error)));

    await page.goto(`http://localhost:${PORT}/?seed=20260806`, { waitUntil: 'load' });
    await page.waitForSelector('canvas:visible', { timeout: 60_000 });
    await page.waitForTimeout(4000);

    const start = await orbitDegrees(page);
    check('the Play tab has an Orbit slider to read', Number.isFinite(start), String(start));
    const before = await page.screenshot({ path: join(outDir, 'orbit-before.png') });

    // ] turns clockwise.
    const right = await hold(page, 'BracketRight');
    const swungRight = turnBetween(right.before, right.after);
    check('] turns the view clockwise', swungRight > 1, `${swungRight.toFixed(1)}°`);
    // The ceiling is the assertion that catches a unit mix-up: a degrees-for-
    // radians slip turns ~57x too far and still passes "it moved, clockwise".
    check(
      'it turns at about the rate it claims',
      swungRight <= DEG_PER_SECOND * right.seconds * 1.15,
      `${swungRight.toFixed(1)}° in ${right.seconds.toFixed(2)}s, at most ${(DEG_PER_SECOND * right.seconds).toFixed(0)}°`,
    );
    const after = await page.screenshot({ path: join(outDir, 'orbit-after.png') });

    // ...and the camera has to have actually moved, not just the widget.
    const moved = pixelsChanged(before, after);
    check('the frame is drawn from somewhere else afterwards', moved > 20_000, `${moved} px differ`);

    // [ turns the other way.
    const left = await hold(page, 'BracketLeft');
    const swungLeft = turnBetween(left.before, left.after);
    check('[ turns the view anticlockwise', swungLeft < -1, `${swungLeft.toFixed(1)}°`);

    // Both at once cancel rather than fighting.
    const both = await hold(page, 'BracketLeft', 'BracketRight');
    check(
      'both keys held hold the view still',
      Math.abs(turnBetween(both.before, both.after)) < 0.5,
      `${turnBetween(both.before, both.after).toFixed(2)}°`,
    );

    // The slider is a 0..360 track, so a turn past the end has to come round
    // rather than pile up against the stop.
    const wrapped = await orbitDegrees(page);
    check('the angle stays on the slider’s track', wrapped >= 0 && wrapped <= 360, String(wrapped));

    // The published angle is the panel's, so a probe that cannot see the panel
    // is reading the same number and not a second one that could drift.
    check(
      'the published angle agrees with the slider',
      Math.abs(turnBetween(wrapped, await publishedOrbit(page))) < 0.02,
      `${wrapped} vs ${await publishedOrbit(page)}`,
    );

    await probeSwipe(browser);

    console.log('\n----');
    if (problems.length === 0) console.log('nothing broke.');
    else {
      console.log(`${problems.length} problem(s):`);
      for (const p of problems) console.log(`  - ${p}`);
    }
  } finally {
    await browser.close();
    server.kill();
  }
  if (problems.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
