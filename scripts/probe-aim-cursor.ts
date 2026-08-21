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

const isOurs = (value: string): boolean => value.startsWith('url("data:image/svg+xml');
const isArrow = (value: string): boolean => value === 'auto' || value === 'default';
/** The hotspot and fallback a value declares -- what actually places the image. */
const anchorOf = (value: string): string => value.slice(value.indexOf('") ') + 3);

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

    // Over open ground: the page's own arrow, which is the ordinary case and
    // the thing the two marks are only worth drawing against.
    await page.mouse.move(640, 400);
    const idle = await cursorSettles(page, isArrow);
    console.log(`  open ground: ${idle}`);
    if (!isArrow(idle)) problems.push(`open ground wore ${idle}, not the page's own arrow`);

    // Over a real body: the small mark. Found rather than assumed -- a bar is
    // anchored over a head and a fixed drop below it could miss the body.
    const bars = await bodyBars(page);
    console.log(`  bodies:      ${bars.length} on screen`);
    if (bars.length === 0) problems.push('no other body was on screen to point at');
    let hovering = '';
    let landedAt = -1;
    let body = { x: 0, y: 0 };
    for (const bar of bars) {
      for (const drop of BODY_OFFSETS) {
        await page.mouse.move(bar.x, bar.y + drop);
        const seen = await cursorSettles(page, isOurs, 700);
        if (isOurs(seen)) {
          hovering = seen;
          landedAt = drop;
          body = { x: bar.x, y: bar.y + drop };
          break;
        }
      }
      if (hovering !== '') break;
    }
    console.log(`  over a body: ${hovering === '' ? '(never found one)' : `${hovering.slice(0, 46)}... at +${landedAt}px`}`);
    if (hovering === '') problems.push('pointing at a body never produced the small mark');

    // Armed by *clicking* a slot, with the mouse then left where it is: the
    // path the cursor used to be drawn wrong on, because the change was made in
    // an animation frame with no input event for the browser to re-place the
    // image with. The slot is found rather than assumed -- the bar is drawn on
    // the interface canvas and has no box in the DOM, so the candidates are
    // stepped along from the pool block, which does.
    const pool = await page.$eval('[data-hud-bottom="pools"]', (node) => {
      const box = node.getBoundingClientRect();
      return { right: box.right, middle: box.top + box.height / 2 };
    });
    let clickedAt = -1;
    let clicked = '';
    for (let slot = 0; slot < 5; slot++) {
      const x = pool.right + SLOT_STEP * slot + SLOT_STEP / 2;
      await page.mouse.move(x, pool.middle);
      await page.mouse.down();
      await page.mouse.up();
      // Deliberately no move between the click and the reading: that is the
      // whole of what is being checked.
      const seen = await cursorSettles(page, isOurs, 900);
      if (isOurs(seen)) {
        clicked = seen;
        clickedAt = slot;
        break;
      }
    }
    console.log(`  clicked slot: ${clicked === '' ? '(no slot armed an aim)' : `${clicked.slice(0, 40)}... slot ${clickedAt}`}`);
    if (clicked === '') problems.push('clicking a skill slot never produced the crosshair');
    await page.keyboard.press('Escape');

    // ...and armed over a body: the full crosshair, at the same hotspot, which
    // is the one invariant the pair exists for.
    if (hovering !== '') await page.mouse.move(body.x, body.y);
    await page.keyboard.press('Digit3');
    const armed = await cursorSettles(page, (value) => isOurs(value) && value !== hovering);
    console.log(`  armed:       ${armed.slice(0, 46)}...`);
    if (!isOurs(armed)) problems.push(`a pending ground aim wore ${armed}, not the full crosshair`);
    if (armed === hovering) problems.push('arming a skill over a body did not extend the mark');
    if (isOurs(armed) && hovering !== '') {
      if (anchorOf(armed) !== anchorOf(hovering)) {
        problems.push(`the two marks name different hotspots: ${anchorOf(hovering)} vs ${anchorOf(armed)}`);
      }
      if (!/\d+ \d+, crosshair$/.test(armed)) {
        problems.push(`the cursor names no hotspot or no fallback: ${armed.slice(-40)}`);
      }
    }

    // The computed style reports what was *declared*, image or no image -- so
    // the values above prove the wiring and say nothing about whether this
    // browser can draw them. Decoding is the other half, and the half that
    // catches a malformed path, a bad encoding, or a size an engine refuses.
    for (const [name, value] of [
      ['small', hovering],
      ['full', armed],
    ] as const) {
      if (!isOurs(value)) continue;
      const decoded = await page.evaluate(
        async (url: string) =>
          await new Promise<{ ok: boolean; width: number; height: number }>((resolve) => {
            const image = new Image();
            image.onload = () =>
              resolve({ ok: true, width: image.naturalWidth, height: image.naturalHeight });
            image.onerror = () => resolve({ ok: false, width: 0, height: 0 });
            image.src = url;
          }),
        value.slice(value.indexOf('url("') + 5, value.indexOf('")')),
      );
      console.log(`  decoded ${name}: ${decoded.ok ? `${decoded.width}x${decoded.height}` : 'refused'}`);
      if (!decoded.ok) problems.push(`the browser could not decode the ${name} mark`);
      // Both have to come back the same size, or the swap moves the drawn mark
      // however well the hotspots agree. Over 32 and some engines drop it.
      if (decoded.ok && (decoded.width !== 22 || decoded.height !== 22)) {
        problems.push(`the ${name} mark decoded at ${decoded.width}x${decoded.height}, not 22x22`);
      }
    }

    // Off the body with the aim still armed: still the full crosshair, because
    // an armed skill outranks what happens to be under the pointer.
    await page.mouse.move(640, 700);
    const armedOffBody = await cursorSettles(page, (value) => value === armed);
    if (armedOffBody !== armed) {
      problems.push(`an armed aim over open ground wore ${armedOffBody}`);
    }

    // Escape puts it all back.
    await page.keyboard.press('Escape');
    const escaped = await cursorSettles(page, isArrow);
    console.log(`  escaped:     ${escaped}`);
    if (!isArrow(escaped)) problems.push(`Escape left ${escaped} behind`);

    // ...and the body still wears the small mark afterwards, so cancelling an
    // aim does not take the hover state with it.
    if (hovering !== '') {
      await page.mouse.move(body.x, body.y);
      const again = await cursorSettles(page, (value) => value === hovering);
      if (again !== hovering) problems.push(`after Escape, the body wore ${again}`);
    }
  } finally {
    await browser.close();
    server.kill();
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ! ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('  arrow on open ground, the small mark on a body, the full crosshair when armed');
}

await main();
