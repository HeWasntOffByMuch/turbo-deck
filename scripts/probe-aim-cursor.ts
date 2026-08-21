/**
 * Is the aim cursor actually on the canvas? (spec 197)
 *
 * Everything the crosshair *is* -- the art, its symmetry, the gap at its
 * centre, the hotspot, the encoding, and which cursor wins when a drop and an
 * aim both apply -- is pure and asserted in `crosshair.test.ts`. What no
 * headless test can see is the half that makes it a feature: that the value
 * reaches a real canvas, that the browser accepts it (an engine that refuses
 * the image silently falls back to a keyword, which is a working test beside a
 * cursor nobody chose), and that it goes away again when the aim does.
 *
 * A cursor is drawn by the compositor and is not in a screenshot, so there is
 * nothing to photograph here: what is read is the computed style of the canvas
 * the pointer is over, which is the same string the browser is drawing from.
 *
 *   npm run build && npx tsx scripts/probe-aim-cursor.ts
 *
 * Serves `dist/`, so what is measured is what ships.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium, type Page } from 'playwright';

const PORT = 4326;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** The bar ships empty (spec 164), so the skills have to be put in it to press. */
const SLOTS = 'melee.heavy,bolt.seek,ground.quake,self.mend';

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
 * What the *browser* thinks the cursor is, not what we assigned.
 *
 * The computed value is the one the compositor draws from, so a data URI the
 * engine parsed and a data URI it threw away read differently here -- which is
 * the whole reason this is a probe rather than an assertion about a string.
 */
async function cursorOf(page: Page): Promise<string> {
  return page.$eval('canvas', (node) => getComputedStyle(node).cursor);
}

/** A poll, not a wait: this page paints a few frames a second under software GL. */
async function cursorSettles(
  page: Page,
  wanted: (value: string) => boolean,
  timeoutMs = 6000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let seen = '';
  while (Date.now() < deadline) {
    seen = await cursorOf(page);
    if (wanted(seen)) return seen;
    await page.waitForTimeout(100);
  }
  return seen;
}

const isCrosshair = (value: string): boolean => value.startsWith('url("data:image/svg+xml');
const isArrow = (value: string): boolean => value === 'auto' || value === 'default';

async function main(): Promise<void> {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });
  const problems: string[] = [];
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (error) => problems.push(String(error)));
    await page.goto(`http://localhost:${PORT}/?seed=20260806&slots=${SLOTS}`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });
    await waitForTick(page, 150);
    await page.mouse.move(640, 400);

    const idle = await cursorSettles(page, isArrow);
    console.log(`  idle:        ${idle.slice(0, 60)}`);
    if (!isArrow(idle)) problems.push(`idle canvas wore ${idle}, not the page's own cursor`);

    // Slot 3 is `ground.quake`: a point aim, so the press asks for a click.
    await page.keyboard.press('Digit3');
    const aiming = await cursorSettles(page, isCrosshair);
    console.log(`  aiming:      ${aiming.slice(0, 60)}...`);
    if (!isCrosshair(aiming)) {
      problems.push(`a pending ground aim wore ${aiming}, not the crosshair`);
    } else {
      // The engine parsed the image: a refused one falls through to the keyword
      // and would read as `crosshair` alone, which is a fallback rather than the
      // mark this spec is about.
      if (!aiming.includes('svg')) problems.push('the cursor url is not the SVG we built');
      if (!/\d+ \d+, crosshair$/.test(aiming)) {
        problems.push(`the cursor names no hotspot or no fallback: ${aiming.slice(-40)}`);
      }
    }

    // The computed style reports what was *declared*, image or no image -- so
    // the value above proves the wiring and says nothing about whether this
    // browser can draw it. Decoding it is the other half, and it is the half
    // that would catch a malformed path, a bad encoding or a size the engine
    // refuses: the same URI, loaded as an image, has to come back at the box
    // the SVG declares.
    const decoded = await page.evaluate(async (value: string) => {
      const url = value.slice(value.indexOf('url("') + 5, value.indexOf('")'));
      return await new Promise<{ ok: boolean; width: number; height: number }>((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ ok: true, width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => resolve({ ok: false, width: 0, height: 0 });
        image.src = url;
      });
    }, aiming);
    console.log(`  decoded:     ${decoded.ok ? `${decoded.width}x${decoded.height}` : 'refused'}`);
    if (!decoded.ok) problems.push('the browser could not decode the cursor image');
    if (decoded.ok && (decoded.width !== 22 || decoded.height !== 22)) {
      // Over 32 and some engines drop the image; a different number here means
      // the SVG is not the size `CROSSHAIR_BOX` says it is.
      problems.push(`the cursor decoded at ${decoded.width}x${decoded.height}, not 22x22`);
    }

    // Right-click calls the aim off (spec 080), and the cursor goes with it.
    await page.mouse.click(640, 400, { button: 'right' });
    const cancelled = await cursorSettles(page, isArrow);
    console.log(`  cancelled:   ${cancelled.slice(0, 60)}`);
    if (!isArrow(cancelled)) problems.push(`a cancelled aim left ${cancelled} behind`);

    // Slot 2 is `bolt.seek`: a *unit* aim, which is the other gesture and the
    // one whose click lands on a body rather than on the ground.
    await page.keyboard.press('Digit2');
    const unit = await cursorSettles(page, isCrosshair);
    console.log(`  unit aim:    ${unit.slice(0, 60)}...`);
    if (!isCrosshair(unit)) problems.push(`a pending unit aim wore ${unit}, not the crosshair`);
    if (unit !== aiming) problems.push('the two gestures wore different crosshairs');

    await page.keyboard.press('Escape');
    const escaped = await cursorSettles(page, isArrow);
    console.log(`  escaped:     ${escaped.slice(0, 60)}`);
    if (!isArrow(escaped)) problems.push(`Escape left ${escaped} behind`);
  } finally {
    await browser.close();
    server.kill();
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ! ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('  the aim cursor is the crosshair, and only while an aim is pending');
}

await main();
