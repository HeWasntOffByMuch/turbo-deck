/**
 * The stop, in a real browser (spec 199).
 *
 *   npm run build && npx tsx scripts/probe-stop.ts
 *
 * What spec 199 *decides* is pure and asserted in Node: that `Space` resolves to
 * `combat.stop`, that the decision carries `stop` and nothing else with it, that
 * a rebind follows it, that `moveIntent` with nothing held and nothing ordered
 * asks for `(0, 0)`. None of that can say whether the decision reaches anything
 * -- which is the entire bug being fixed, since the row has been listed,
 * rebindable and saved since spec 125 while nothing read it, exactly as
 * `debug.toggleStats` had been until spec 183.
 *
 * And one rule here cannot be reached from Node at all, because it is a fact
 * about the browser rather than about the game: a key held down repeats
 * `keydown` at the platform's own rate, and each repeat would put `move.north`
 * straight back into `held`. Without the disarm the walk resumes on its own half
 * a second after the player asked it to stop -- a stop that works perfectly in
 * every unit test and visibly does not work on the screen. So the repeats are
 * dispatched here for real, and the harness checks that the browser *marked*
 * them as repeats before believing anything it measures from them: a check
 * against the wrong event is worse than no check, because it reads as evidence.
 *
 * Two observables, both published by `publishOrders`:
 *
 *  - `data-orders` is what has been asked for -- `walk attack pickup aim cast
 *    keys`, in a fixed order, so a missing word is a specific drop that did not
 *    happen rather than a diff to squint at;
 *  - `data-self-at` is whether the body is actually still moving, which is a
 *    fact about the server rather than about this file's bookkeeping. Both,
 *    because a stop that cleared the bookkeeping and left the legs running is
 *    the failure worth catching and the first one would report it as a pass.
 *
 * Two page loads, and the count is the design rather than laziness -- the same
 * arithmetic `probe-mouse-bindings.ts` sets out. Nothing here can be pressed
 * until the load gate opens, because the loading overlay is a full-viewport div
 * with pointer events on, and on a software-GL container the shipped map streams
 * for minutes. So the questions are batched: one load on the defaults, one on a
 * profile that moves the stop onto the middle mouse button -- which is the
 * cross-device claim as well as the rebind one, since a stop that turned out to
 * be a keyboard branch would pass every other check in this file.
 *
 * What it deliberately does **not** reach is the wind-up, which is the headline
 * of the feature -- catching a body mid-cast needs a monster found on screen and
 * a fight timed against a 20Hz delta, in an arena where the last harness that
 * tried it had to loop until it saw an impact at all. That half is not
 * unmeasured, it is measured somewhere better: `cancelCast` is the same call
 * spec 090's right-click and spec 155's lost mark already make, pinned over a
 * loopback in `client/session.test.ts` and `sim/attack-cancel.test.ts` from both
 * sides of the attack point, and `dropCommitments` is shared with Escape rather
 * than being a second list. What could only be false here is whether the
 * *control* reaches any of it, and a stop that never ran would fail every check
 * below before it got near a cast.
 *
 * Serves `dist/`, so what is probed is what ships. Prints a summary and exits
 * non-zero on any problem.
 *
 * It is slow, and the slowness is the load gate rather than anything here. Run
 * it on a machine with a GPU, or raise `waitForWorld`'s timeout and be patient.
 * Nothing in CI depends on it.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { BINDINGS_KEY, BINDINGS_VERSION } from '../src/ui/input/binding-store.js';
import type { BindingOverride } from '../src/ui/input/input-map.js';
import { STOP_ACTION } from '../src/render/iso3d/world/control-actions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4337;

/** The same browser the other previews drive: no GPU here, so software GL. */
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** The four directions, so a body pressed into a tree is not read as a dead key. */
const DIRECTIONS = ['KeyW', 'KeyS', 'KeyA', 'KeyD'] as const;

/** How far the body must travel to count as walking, in world units. */
const MOVED = 4;
/** How far it may drift and still count as stopped. Rounding is one unit. */
const STILL = 2;

const problems: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
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

/** What the body is committed to, as the Play tab publishes it. */
async function orders(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector<HTMLElement>('[data-orders]')?.dataset['orders'] ?? '?',
  );
}

/** Where the body is, in whole world units. */
async function at(page: Page): Promise<{ x: number; y: number }> {
  const text = await page.evaluate(
    () => document.querySelector<HTMLElement>('[data-self-at]')?.dataset['selfAt'] ?? '',
  );
  const [x, y] = text.split(',').map(Number);
  return { x: x ?? 0, y: y ?? 0 };
}

function apart(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Which windows the interface has open, the way `probe-window-layout` asks. */
async function windows(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector<HTMLElement>('[data-ui-windows]')?.dataset['uiWindows'] ?? '',
  );
}

/**
 * Wait until the sim has run *and* the world is on screen.
 *
 * The tick alone is not enough: the loading overlay is a full-viewport div with
 * pointer events on, so until it goes every press lands on it rather than on the
 * canvas the handlers are attached to -- which reads exactly like a control that
 * reaches no action (spec 189's probe learned this the expensive way).
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

/** Write a profile and reload into it. The window's own capture is spec 125's. */
async function withBindings(page: Page, overrides: readonly BindingOverride[]): Promise<void> {
  await page.evaluate(
    ([key, text]) => globalThis.localStorage?.setItem(key ?? '', text ?? ''),
    [BINDINGS_KEY, JSON.stringify({ version: BINDINGS_VERSION, overrides })] as const,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorld(page, 30);
}

/** The middle of the canvas: where the world is when nothing is open. */
async function worldPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  if (!box) throw new Error('no canvas on the page');
  return box;
}

/**
 * Count the `keydown` events the page saw for one code, and how many of them the
 * browser marked as repeats.
 *
 * Installed before the repeats are dispatched and read after, because the whole
 * of the disarm rule is about `event.repeat` -- and Playwright produces a repeat
 * only by pressing a key that is already down. If the harness cannot produce one
 * the measurement below is meaningless, and saying so is the only honest answer:
 * a stop that "held" against events that were never repeats is evidence of
 * nothing.
 */
async function watchRepeats(page: Page, code: string): Promise<void> {
  await page.evaluate((watched) => {
    const box = globalThis as unknown as { __repeats?: number };
    box.__repeats = 0;
    globalThis.addEventListener(
      'keydown',
      (event) => {
        if (event.code === watched && event.repeat) box.__repeats = (box.__repeats ?? 0) + 1;
      },
      true,
    );
  }, code);
}

async function repeatsSeen(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as { __repeats?: number }).__repeats ?? 0);
}

/**
 * Hold a direction until the body has actually travelled, and answer which one
 * worked.
 *
 * Every direction rather than one, for the reason `probe-chat.ts` gives: the
 * arena has 6942 trees in it, and a body pressed into one reports a working
 * keyboard as a broken one. It did exactly that once.
 */
async function walkSomewhere(page: Page): Promise<{ code: string; from: { x: number; y: number } } | null> {
  for (const code of DIRECTIONS) {
    const from = await at(page);
    await page.keyboard.down(code);
    await page.waitForTimeout(900);
    const now = await at(page);
    if (apart(from, now) >= MOVED) return { code, from };
    await page.keyboard.up(code);
  }
  return null;
}

/** One page's worth of questions, on whatever control the profile puts the stop on. */
async function probeHeldWalk(page: Page, press: () => Promise<void>, name: string): Promise<void> {
  const walking = await walkSomewhere(page);
  if (!walking) {
    check(false, 'a held direction walks the body at all (every direction was blocked)');
    return;
  }
  check(
    (await orders(page)).includes('keys'),
    `holding ${walking.code} is published as a commitment (${await orders(page)})`,
  );

  await watchRepeats(page, walking.code);
  await press();
  await page.waitForTimeout(400);
  check((await orders(page)) === '', `${name} drops every commitment (${await orders(page)})`);

  // The rule that only exists in a browser. The key is still down: dispatch the
  // repeats the platform would, and require the body to stay where it was put.
  const stopped = await at(page);
  for (let beat = 0; beat < 12; beat += 1) {
    await page.keyboard.down(walking.code);
    await page.waitForTimeout(100);
  }
  const repeats = await repeatsSeen(page);
  const after = await at(page);
  if (repeats === 0) {
    check(false, 'the harness could produce no repeat, so the disarm was never exercised');
  } else {
    check(
      apart(stopped, after) <= STILL,
      `a key still held does not restart the walk (${repeats} repeats, drifted ${apart(stopped, after).toFixed(1)})`,
    );
  }
  await page.keyboard.up(walking.code);

  // ...and letting go re-arms it, or the stop would be a control that disables
  // movement until the tab is reloaded.
  await page.keyboard.down(walking.code);
  await page.waitForTimeout(900);
  check(apart(after, await at(page)) >= MOVED, 'letting the key go re-arms it');
  await page.keyboard.up(walking.code);
  await press();
  await page.waitForTimeout(400);
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

    // A profile left by an earlier run would make every press below a test of
    // that run's leftovers rather than of the shipped default.
    await page.evaluate((key) => globalThis.localStorage?.removeItem(key), BINDINGS_KEY);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForWorld(page, 30);

    const space = async (): Promise<void> => {
      await page.keyboard.press('Space');
    };

    console.log('the shipped key, on a held direction');
    await probeHeldWalk(page, space, 'Space');

    console.log('the shipped key, on a move order');
    const centre = await worldPoint(page);
    const before = await at(page);
    await page.mouse.click(centre.x + 260, centre.y - 40, { button: 'right' });
    await page.waitForTimeout(700);
    check((await orders(page)).includes('walk'), `a right-click is a standing order (${await orders(page)})`);
    const rolling = await at(page);
    await space();
    await page.waitForTimeout(400);
    check((await orders(page)) === '', `Space drops the order (${await orders(page)})`);
    const settled = await at(page);
    await page.waitForTimeout(1200);
    check(
      apart(settled, await at(page)) <= STILL,
      `and the legs stop with it (drifted ${apart(settled, await at(page)).toFixed(1)})`,
    );
    check(
      apart(before, rolling) >= MOVED,
      'the order had the body walking in the first place, so the stop was asked of something',
    );

    console.log('a stop asked at rest');
    // The contrast that makes the rule visible: Escape at rest reaches for the
    // menu (spec 135), and a stop must not. One control that sometimes opens a
    // window is enough.
    const quiet = await at(page);
    await space();
    await page.waitForTimeout(400);
    check((await windows(page)) === '', `it opens nothing (${await windows(page) || 'no windows'})`);
    check((await orders(page)) === '', 'it drops nothing, because there was nothing');
    check(apart(quiet, await at(page)) <= STILL, 'and it moves nothing');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    check(
      (await windows(page)).includes('options'),
      `Escape at rest still does open the menu (${await windows(page) || 'no windows'})`,
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    console.log('the stop on a mouse button, out of a saved profile');
    await withBindings(page, [
      { actionId: STOP_ACTION, primary: { code: 'MouseMiddle' }, secondary: null },
    ]);
    const middle = await worldPoint(page);
    await probeHeldWalk(
      page,
      async () => {
        await page.mouse.click(middle.x, middle.y, { button: 'middle' });
      },
      'the middle button',
    );

    // And the key it displaced no longer does: a default still reaching the
    // branch would pass every check above.
    const held = await walkSomewhere(page);
    if (!held) {
      check(false, 'a held direction walks at all under the rebound profile');
    } else {
      await space();
      await page.waitForTimeout(400);
      check(
        (await orders(page)).includes('keys'),
        `Space no longer stops anything once the row moved (${await orders(page)})`,
      );
      await page.keyboard.up(held.code);
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
    console.log('\nthe stop drops every commitment, holds against a key still down, and follows a rebind');
  }
}

await main();
