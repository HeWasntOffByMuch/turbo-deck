/**
 * The readout toggle, in a real browser (spec 183).
 *
 *   npm run build && npx tsx scripts/probe-stats-toggle.ts
 *
 * What spec 183 *decides* is pure and asserted in Node: that `debug.toggleStats`
 * produces a decision, that a rebind follows it, that a compact layout draws no
 * readout whichever way the switch is set. None of that can say whether the
 * decision reaches anything -- which is the entire bug being fixed here, since
 * the action has been listed, rebindable and saved since spec 125 while nothing
 * read it.
 *
 * So this drives the shipped build and presses the real key:
 *
 *  - the readout is there to begin with, which is what every session did before;
 *  - pressing it takes the box away;
 *  - **its text keeps advancing while it is gone** -- the one rule that must not
 *    break, because `scripts/preview-touch.ts` reads the tick and the target
 *    line out of `document.body.textContent`, which includes a `display:none`
 *    subtree, and it is the only clock that harness has;
 *  - pressing it again brings the box back;
 *  - and a binding stored by the keybinding window is obeyed: the new key
 *    toggles and F3 no longer does.
 *
 * The last one is the point of the spec. A rebind is written straight into the
 * store rather than clicked through the window's capture row, because what is
 * being asked is whether a *saved* binding reaches the game -- the window's own
 * capture is spec 125's and has its own tests.
 *
 * Serves `dist/`, so what is probed is what ships. Prints a summary and exits
 * non-zero on any problem.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { BINDINGS_KEY, BINDINGS_VERSION } from '../src/ui/input/binding-store.js';
import { TOGGLE_STATS_ACTION } from '../src/render/iso3d/world/key-actions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4331;

/** The same browser the other previews drive: no GPU here, so software GL. */
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

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

/**
 * The readout as the page has it.
 *
 * `state` is what the HUD published, `drawn` is what the browser actually does
 * with the box, and `tick` is read out of `body.textContent` -- deliberately the
 * same way `preview-touch.ts` reads it, because that is the reader this feature
 * could break.
 */
async function readout(page: Page): Promise<{ state: string; drawn: boolean; tick: number }> {
  const state = await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('[data-stats-readout]');
    return {
      state: box?.dataset['statsReadout'] ?? 'absent',
      // `offsetParent` is null for a `display:none` subtree, which is exactly
      // the question -- and not the same question as "does it have text".
      drawn: box !== null && box.offsetParent !== null,
    };
  });
  const text = (await page.textContent('body')) ?? '';
  return { ...state, tick: Number(/tick (\d+)/.exec(text)?.[1] ?? -1) };
}

/** Wait until the sim has run, measured the way the touch harness measures it. */
async function waitForTick(page: Page, ticks: number, timeoutMs = 90_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = (await readout(page)).tick;
    if (last >= ticks) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(`sim never reached tick ${ticks} (last seen: ${last})`);
}

/**
 * Press a key and let a few frames go by.
 *
 * A poll rather than a fixed wait everywhere else in this repo; here the thing
 * being waited for is a style property that is written synchronously in the
 * handler, so what the wait is for is the *frame after it* -- and this
 * environment paints a few frames a second under software GL.
 */
async function press(page: Page, code: string): Promise<void> {
  await page.keyboard.press(code);
  await page.waitForTimeout(500);
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
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });

    // A binding stored by an earlier run would make every press below a test of
    // that run's leftovers rather than of the shipped default.
    await page.evaluate((key) => globalThis.localStorage?.removeItem(key), BINDINGS_KEY);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForTick(page, 30);

    console.log('the shipped key');
    const shown = await readout(page);
    check(shown.state === 'on' && shown.drawn, `the readout is drawn to begin with (${shown.state})`);

    await press(page, 'F3');
    const hidden = await readout(page);
    check(hidden.state === 'off' && !hidden.drawn, `F3 takes the readout away (${hidden.state})`);

    // The rule this feature could have broken. Read the tick twice with the box
    // hidden: a toggle that stopped the writing rather than the drawing would
    // leave `preview-touch.ts` unable to tell "the tap did nothing" from "the
    // frame had not run yet".
    const before = (await readout(page)).tick;
    await page.waitForTimeout(1200);
    const after = (await readout(page)).tick;
    check(before > 0 && after > before, `the hidden readout is still written (tick ${before} -> ${after})`);

    await press(page, 'F3');
    const back = await readout(page);
    check(back.state === 'on' && back.drawn, `F3 brings it back (${back.state})`);

    console.log('a binding the keybinding window saved');
    await page.evaluate(
      ([key, document]) => globalThis.localStorage?.setItem(key ?? '', document ?? ''),
      [
        BINDINGS_KEY,
        JSON.stringify({
          version: BINDINGS_VERSION,
          overrides: [{ actionId: TOGGLE_STATS_ACTION, primary: { code: 'KeyG' }, secondary: null }],
        }),
      ] as const,
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForTick(page, 30);

    await press(page, 'F3');
    const stale = await readout(page);
    check(stale.state === 'on' && stale.drawn, `the old key no longer toggles (${stale.state})`);

    await press(page, 'KeyG');
    const rebound = await readout(page);
    check(rebound.state === 'off' && !rebound.drawn, `the rebound key does (${rebound.state})`);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('\nthe readout toggles, stays written while hidden, and follows a rebind');
  }
}

await main();
