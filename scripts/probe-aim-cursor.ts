/**
 * What the pointer actually is, in a real page (spec 197).
 *
 * Everything the two marks *are* -- the art, their symmetry, the gap at the
 * crosshair's centre, the shared hotspot, the encoding, and which of the three
 * cursors wins -- is pure and asserted in `crosshair.test.ts`. What no headless
 * test can see is the half that makes it a feature: that the value reaches a
 * real canvas, that the browser accepts it (an engine that refuses the image
 * falls back to a keyword, which is a green test beside a cursor nobody chose),
 * that hovering a real body actually produces the small mark, and that all of
 * it goes away again.
 *
 * A cursor is drawn by the compositor and is not in a screenshot, so there is
 * nothing to photograph here: what is read is the computed style of the canvas,
 * which is the string the browser draws from, plus the images decoded out of it.
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

/**
 * How far below a floating health bar to look for the body it belongs to, in
 * CSS pixels.
 *
 * A ladder rather than one number, and searched rather than assumed, for the
 * reason `preview-paint.ts` searches for its aim: a bar is anchored over a
 * head, bodies are different heights, and a fixed offset that happened to miss
 * would report a working cursor as a broken one. What is reported is the offset
 * that worked, so a change in framing shows up as a number rather than as a
 * failure.
 */
const BODY_OFFSETS = [16, 24, 32, 40, 52, 64];

/**
 * How far apart the action bar's slots are, in CSS pixels, for the probe's walk
 * along the row. `ACTION_SLOT_CSS` plus the gap either side of it -- an
 * approximation on purpose, since what this is for is landing *somewhere* on
 * each of five squares rather than on their centres.
 */
const SLOT_STEP = 52;

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
 * The computed value is the one the compositor draws from, so this reports the
 * whole chain -- the assignment, the frame that made it, and the element the
 * pointer is actually over.
 */
async function cursorOf(page: Page): Promise<string> {
  // The *world* canvas, by name rather than by being first: the page holds three
  // (the world, the interface layer over it, and an unsized one belonging to
  // another tab), and reading whichever is first in the document is how a probe
  // reports a cursor that belongs to something nobody is pointing at.
  return page.evaluate(() => {
    const world = document.querySelector<HTMLCanvasElement>('canvas:not([data-ui-canvas])');
    return world === null ? '(no world canvas)' : getComputedStyle(world).cursor;
  });
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

/** Where every floating health bar is, so a real body can be pointed at. */
async function bodyBars(page: Page): Promise<{ id: string; x: number; y: number }[]> {
  return page.$$eval('[data-entity]', (nodes) =>
    nodes
      .filter((node) => (node as HTMLElement).dataset['self'] === undefined)
      .map((node) => {
        const box = node.getBoundingClientRect();
        // The holder is translated by -100%, so its bottom edge is the anchor
        // the HUD placed over the body's head.
        return { id: (node as HTMLElement).dataset['entity'] ?? '', x: box.left + box.width / 2, y: box.bottom };
      })
      .filter((bar) => bar.x > 0 && bar.y > 0),
  );
}

const isArrow = (value: string): boolean => value === 'auto' || value === 'default';

/**
 * The mark on screen: which one, and the middle of the box it was drawn in.
 *
 * Measured off the element's own rectangle rather than off the transform we
 * asked for, so what is checked is where the browser *put* it. This is the
 * measurement the CSS cursor image made impossible -- a cursor is composited
 * outside the page, and neither a screenshot nor OBS can see where it went.
 */
async function markOf(page: Page): Promise<{ art: string; x: number; y: number } | null> {
  return page.evaluate(() => {
    const node = document.querySelector<HTMLElement>('[data-crosshair]');
    if (node === null || node.dataset['crosshair'] === 'none') return null;
    const box = node.getBoundingClientRect();
    const canvas = document.querySelector<HTMLCanvasElement>('canvas:not([data-ui-canvas])');
    const origin = canvas?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return {
      art: node.dataset['crosshair'] ?? '?',
      // Back into the same pixels the pointer was given in.
      x: box.left + box.width / 2 - origin.left,
      y: box.top + box.height / 2 - origin.top,
    };
  });
}

/** A poll, for the same reason `cursorSettles` is one. */
async function markSettles(
  page: Page,
  wanted: (mark: Awaited<ReturnType<typeof markOf>>) => boolean,
  timeoutMs = 6000,
): Promise<Awaited<ReturnType<typeof markOf>>> {
  const deadline = Date.now() + timeoutMs;
  let seen = await markOf(page);
  while (Date.now() < deadline) {
    seen = await markOf(page);
    if (wanted(seen)) return seen;
    await page.waitForTimeout(100);
  }
  return seen;
}

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
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });
    await waitForTick(page, 150);

    /** How far the drawn mark sits from the point the pointer was put at. */
    const missBy = (mark: { x: number; y: number }, at: { x: number; y: number }): number =>
      Math.hypot(mark.x - at.x, mark.y - at.y);

    // Over open ground: the page's own arrow and no mark, which is the ordinary
    // case and the thing the two marks are only worth drawing against.
    await page.mouse.move(640, 400);
    const idle = await cursorSettles(page, isArrow);
    const idleMark = await markOf(page);
    console.log(`  open ground: cursor=${idle} mark=${idleMark === null ? 'none' : idleMark.art}`);
    if (!isArrow(idle)) problems.push(`open ground wore ${idle}, not the page's own arrow`);
    if (idleMark !== null) problems.push(`open ground drew a ${idleMark.art} mark`);

    // Over a real body: the small mark, and -- the measurement this whole
    // approach exists for -- *at the pointer*. Found rather than assumed, since
    // a bar is anchored over a head and a fixed drop below it could miss.
    const bars = await bodyBars(page);
    console.log(`  bodies:      ${bars.length} on screen`);
    if (bars.length === 0) problems.push('no other body was on screen to point at');
    let body: { x: number; y: number } | null = null;
    for (const bar of bars) {
      for (const drop of BODY_OFFSETS) {
        const at = { x: bar.x, y: bar.y + drop };
        await page.mouse.move(at.x, at.y);
        const mark = await markSettles(page, (m) => m?.art === 'small', 700);
        if (mark?.art === 'small') {
          body = at;
          console.log(
            `  over a body: small at (${mark.x.toFixed(1)},${mark.y.toFixed(1)}) for pointer ` +
              `(${at.x.toFixed(1)},${at.y.toFixed(1)}) -- off by ${missBy(mark, at).toFixed(2)}px, +${drop}px below the bar`,
          );
          if (missBy(mark, at) > 1) {
            problems.push(`the small mark missed the pointer by ${missBy(mark, at).toFixed(2)}px`);
          }
          if ((await cursorOf(page)) !== 'none') {
            problems.push('a drawn mark did not hide the real cursor under it');
          }
          break;
        }
      }
      if (body !== null) break;
    }
    if (body === null) problems.push('pointing at a body never produced the small mark');

    // Armed over that same body: the full crosshair, in the same place. This is
    // the pair's one invariant, and until the mark was drawn in the page there
    // was no way to check it at all.
    await page.keyboard.press('Digit3');
    const armed = await markSettles(page, (m) => m?.art === 'full');
    console.log(`  armed:       ${armed === null ? 'nothing' : `full at (${armed.x.toFixed(1)},${armed.y.toFixed(1)})`}`);
    if (armed?.art !== 'full') problems.push('arming a skill did not extend the mark');
    if (armed && body && missBy(armed, body) > 1) {
      problems.push(`arming the aim moved the mark by ${missBy(armed, body).toFixed(2)}px`);
    }
    await page.keyboard.press('Escape');

    // Armed by *clicking* a slot, with the mouse left where it is: the path
    // this was reported wrong on. The slot is found rather than assumed -- the
    // bar is drawn on the interface canvas and has no box in the DOM, so the
    // candidates are stepped along from the pool block, which does.
    const pool = await page.$eval('[data-hud-bottom="pools"]', (node) => {
      const box = node.getBoundingClientRect();
      return { right: box.right, middle: box.top + box.height / 2 };
    });
    let armedByClick = false;
    for (let slot = 0; slot < 5; slot++) {
      const at = { x: pool.right + SLOT_STEP * slot + SLOT_STEP / 2, y: pool.middle };
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.up();
      // Nothing is drawn while the pointer is over the interface -- a button is
      // a button, and the mark is for the world. So the check is that the aim
      // took, read the moment the pointer is back over the world, and that the
      // mark arrives *at the pointer* rather than where the slot was.
      const overBar = await markOf(page);
      if (overBar !== null) problems.push(`a ${overBar.art} mark was drawn over the action bar`);
      const back = { x: 700, y: 380 };
      await page.mouse.move(back.x, back.y);
      const mark = await markSettles(page, (m) => m?.art === 'full', 900);
      if (mark?.art === 'full') {
        armedByClick = true;
        console.log(
          `  clicked slot ${slot}: full at (${mark.x.toFixed(1)},${mark.y.toFixed(1)}) for pointer ` +
            `(${back.x},${back.y}) -- off by ${missBy(mark, back).toFixed(2)}px`,
        );
        if (missBy(mark, back) > 1) {
          problems.push(
            `after clicking a slot the mark sat ${missBy(mark, back).toFixed(2)}px from the pointer`,
          );
        }
        break;
      }
    }
    if (!armedByClick) problems.push('clicking a skill slot never armed the crosshair');

    // ...and it tracks the pointer while it moves, which is the other half of
    // being drawn rather than composited.
    for (const at of [
      { x: 500, y: 300 },
      { x: 900, y: 520 },
      { x: 300, y: 640 },
    ]) {
      await page.mouse.move(at.x, at.y);
      const mark = await markSettles(page, (m) => m !== null && missBy(m, at) <= 1, 1500);
      if (mark === null || missBy(mark, at) > 1) {
        const where = mark === null ? 'nothing drawn' : `${missBy(mark, at).toFixed(2)}px away`;
        problems.push(`the armed mark did not follow the pointer to (${at.x},${at.y}): ${where}`);
      }
    }
    console.log('  tracking:    the armed mark follows the pointer within 1px');

    await page.keyboard.press('Escape');
    const escaped = await cursorSettles(page, isArrow);
    const gone = await markOf(page);
    console.log(`  escaped:     cursor=${escaped} mark=${gone === null ? 'none' : gone.art}`);
    if (!isArrow(escaped)) problems.push(`Escape left ${escaped} behind`);
    if (gone !== null) problems.push(`Escape left a ${gone.art} mark behind`);
  } finally {
    await browser.close();
    server.kill();
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ! ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('  the mark is drawn where the pointer is, in every state, to within a pixel');
}

await main();
