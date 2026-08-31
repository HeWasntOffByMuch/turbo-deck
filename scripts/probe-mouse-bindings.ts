/**
 * The pointer verbs, in a real browser (spec 189).
 *
 *   npm run build && npx tsx scripts/probe-mouse-bindings.ts
 *
 * What spec 189 *decides* is pure and asserted in Node: that a pointer code is a
 * chord like any other, that `decideControlDown` answers the same for a button
 * as for a key, that the screen captures one. None of that can say whether any
 * of it is wired to anything -- which is exactly the shape of the bug spec 138
 * found in the keyboard half, where binding a key stopped working entirely and
 * every test stayed green because the two facts had nothing between them.
 *
 * So this drives the shipped build with a real mouse:
 *
 *  - the wheel still zooms the camera, which is the verb most likely to have
 *    been broken here -- `scene.ts` no longer attaches a listener for it, so if
 *    the binding does not reach `zoomNotch` the wheel simply stops working;
 *  - **swapping the two camera rows inverts it**, which is the difference
 *    between a row the window lists and a row a player can change;
 *  - a mouse button bound to an ordinary keyboard action fires it, and the key
 *    it displaced no longer does -- the cross-device claim, in the one place it
 *    could be false;
 *  - and the window binds a real press: click the row's button, then press a
 *    mouse button, and read the profile back out of storage. Two events a
 *    browser has to deliver in order, which is precisely the path that broke
 *    last time.
 *
 * The readout and the camera are the two observables, because both are already
 * published for other harnesses and neither needs a fight to produce.
 *
 * Two page loads, and the count is the design rather than laziness: **nothing
 * here can be pressed until the load gate opens**, because the loading overlay
 * is a full-viewport div with pointer events on, and on a software-GL container
 * the shipped map streams for minutes. So the profiles are batched -- one load
 * on the defaults, one on a profile that swaps the camera and puts the readout
 * on the middle button -- rather than one load per question. What that costs is
 * the third wheel case, "unbound leaves it doing nothing"; the swap proves the
 * binding is live and `control-actions.test.ts` asserts the zero.
 *
 * Serves `dist/`, so what is probed is what ships. Prints a summary and exits
 * non-zero on any problem.
 *
 * It is slow, and the slowness is the load gate rather than anything here: on a
 * software-GL container the arena streams at under a chunk a second and the gate
 * wants all of them, so a run is minutes per page load and can time out
 * entirely under contention. Run it on a machine with a GPU, or raise
 * `waitForWorld`'s timeout and be patient. Nothing in CI depends on it.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { BINDINGS_KEY, BINDINGS_VERSION } from '../src/ui/input/binding-store.js';
import type { BindingOverride } from '../src/ui/input/input-map.js';
import {
  TOGGLE_STATS_ACTION,
  ZOOM_IN_ACTION,
  ZOOM_OUT_ACTION,
} from '../src/render/iso3d/world/control-actions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4333;

/** The same browser the other previews drive: no GPU here, so software GL. */
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** The middle button, which nothing in the shipped bindings uses. */
const MIDDLE = 'middle' as const;

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

/** The camera's zoom span, as the Play tab publishes it for every harness. */
async function zoom(page: Page): Promise<number> {
  const text = await page.evaluate(
    () => document.querySelector<HTMLElement>('[data-camera-zoom]')?.dataset['cameraZoom'] ?? '',
  );
  return Number(text);
}

/** Whether the diagnostic readout is drawn, the way `probe-stats-toggle` asks. */
async function readoutOn(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      document.querySelector<HTMLElement>('[data-stats-readout]')?.dataset['statsReadout'] === 'on',
  );
}

/**
 * Wait until the sim has run *and* the world is on screen.
 *
 * The tick alone is not enough and the difference is not cosmetic: the loading
 * overlay is a full-viewport div with pointer events on, so until it goes every
 * press in this file lands on it rather than on the canvas the handlers are
 * attached to -- which reads exactly like a mouse button that reaches no action.
 * It cost an afternoon; the tick had passed 30 while 169 chunks were still
 * streaming.
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

/** Write a profile and reload into it. The window's own capture is checked below. */
async function withBindings(page: Page, overrides: readonly BindingOverride[]): Promise<void> {
  await page.evaluate(
    ([key, text]) => globalThis.localStorage?.setItem(key ?? '', text ?? ''),
    [BINDINGS_KEY, JSON.stringify({ version: BINDINGS_VERSION, overrides })] as const,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForWorld(page, 30);
}

/**
 * The middle of the canvas, in CSS pixels.
 *
 * Where the world is when nothing is open, and where the cursor has to be for
 * the wheel to be the camera's rather than a scroll view's.
 */
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
 * Turn the wheel one notch and let a few frames go by.
 *
 * `deltaY` negative is away from the player, which `wheelNotches` reads as
 * positive and the shipped rows bind to `camera.zoomIn`.
 */
async function wheel(page: Page, deltaY: number): Promise<void> {
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(400);
}

/** One `id:x,y,w,h` out of a readout's box list, in UI pixels. */
function boxNamed(list: string, id: string): { x: number; y: number; width: number; height: number } | null {
  for (const entry of list.split(';')) {
    const [name, rect] = entry.split(':');
    if (name !== id || !rect) continue;
    const [x, y, width, height] = rect.split(',').map(Number);
    if (x === undefined || y === undefined || width === undefined || height === undefined) return null;
    return { x, y, width, height };
  }
  return null;
}

/**
 * A UI-pixel point in CSS pixels.
 *
 * The inverse of `UiLayer.toUi`, derived from the canvas's own CSS box over the
 * viewport it reports -- `cssWidth / uiWidth` is exactly `scale / dpr`, so the
 * harness never has to know either number. Lifted from `probe-window-layout.ts`,
 * which needs it for the same reason: an offset measured off a screenshot passes
 * for the wrong reason the first time the layout moves.
 */
async function toCss(page: Page, at: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(
    ([ux, uy]) => {
      const host = document.querySelector<HTMLElement>('[data-ui-viewport]');
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-ui-canvas]');
      const uiWidth = Number(host?.dataset['uiViewport']?.split('x')[0]);
      if (!canvas || !Number.isFinite(uiWidth) || uiWidth <= 0) return null;
      const rect = canvas.getBoundingClientRect();
      const perUiPixel = rect.width / uiWidth;
      return { x: rect.left + (ux ?? 0) * perUiPixel, y: rect.top + (uy ?? 0) * perUiPixel };
    },
    [at.x, at.y] as const,
  );
  if (!point) throw new Error('no UI canvas to measure against');
  return point;
}

/**
 * Every body the HUD is drawing a floating bar for, in CSS pixels (spec 196).
 *
 * The bar's *anchor* rather than the body: the holder is pinned above the head,
 * so a press has to go some way below it to land on what it names. There is no
 * element for a body -- it is drawn to the world canvas -- and this is the one
 * handle the scene already publishes for one.
 */
async function bodies(page: Page): Promise<{ id: string; x: number; y: number }[]> {
  return page.$$eval('[data-entity]', (nodes) =>
    nodes.map((node) => {
      const rect = (node as HTMLElement).getBoundingClientRect();
      return { id: (node as HTMLElement).dataset['entity'] ?? '', x: rect.x + rect.width / 2, y: rect.y };
    }),
  );
}

/** What the mini HUD says it is showing: `name|detail`, empty for nothing. */
async function selected(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector<HTMLElement>('[data-ui-selected]')?.dataset['uiSelected'] ?? '',
  );
}

/** What the profile in storage says one action is bound to. */
async function storedPrimary(page: Page, actionId: string): Promise<string> {
  const raw = await page.evaluate((key) => globalThis.localStorage?.getItem(key ?? '') ?? '', BINDINGS_KEY);
  if (raw === '') return 'no profile';
  const stored = JSON.parse(raw) as { overrides?: { actionId: string; primary?: { code?: string } }[] };
  const found = (stored.overrides ?? []).find((entry) => entry.actionId === actionId);
  return found?.primary?.code ?? 'unbound';
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
    // The built page is the game client since spec 254, where the readout starts
    // hidden; this harness depends on it being drawn at load, so it asks the
    // workbench back.
    await page.goto(`http://localhost:${PORT}/?client=workbench`, { waitUntil: 'domcontentloaded' });

    // A profile left by an earlier run would make every press below a test of
    // that run's leftovers rather than of the shipped defaults.
    await page.evaluate((key) => globalThis.localStorage?.removeItem(key), BINDINGS_KEY);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForWorld(page, 30);

    const world = await worldPoint(page);
    await page.mouse.move(world.x, world.y);

    console.log('the wheel the game ships with');
    const resting = await zoom(page);
    await wheel(page, -100);
    const nearer = await zoom(page);
    check(
      Number.isFinite(resting) && nearer < resting,
      `a notch away from the player pulls the camera in (${resting} -> ${nearer})`,
    );

    await wheel(page, 100);
    const further = await zoom(page);
    check(further > nearer, `a notch toward the player pushes it out (${nearer} -> ${further})`);

    // The left button's second reading (spec 196). Everything the feature
    // decides is asserted in Node -- that the decision reaches `selectionOf`,
    // that the panel draws what it is handed -- and none of it can say whether
    // a press on a body in the shipped page reaches any of it, which is the
    // same gap this file was written for.
    //
    // The offset is swept rather than guessed: a body's anchor is the top of the
    // holder above its head, and how far below that the body itself is depends
    // on the camera and on how tall the thing is.
    console.log('the left button naming a body');
    let named = '';
    for (const body of (await bodies(page)).filter((b) => b.x > 80 && b.x < 1200 && b.y > 100 && b.y < 640)) {
      for (const below of [26, 36, 46, 18]) {
        await page.mouse.click(body.x, body.y + below);
        await page.waitForTimeout(400);
        named = await selected(page);
        if (named.length > 0) break;
      }
      if (named.length > 0) break;
    }
    check(named.length > 0, `a left click on a body names it in the corner (${named || 'nothing'})`);

    if (named.length > 0) {
      // ...and a click on nothing puts it away. There is no second gesture for
      // that and there should not be: the way you stop looking at something is
      // to look at something else.
      await page.mouse.click(40, 700);
      await page.waitForTimeout(400);
      const after = await selected(page);
      check(after === '', `a left click on empty ground clears it (${after || 'nothing'})`);
    }

    console.log('a button nothing is bound to');
    check(await readoutOn(page), 'the readout is drawn to begin with');
    await page.mouse.click(world.x, world.y, { button: MIDDLE });
    await page.waitForTimeout(500);
    check(await readoutOn(page), 'the middle button does nothing on the shipped bindings');

    console.log('the window binding a real press');
    // Straight to the options window on its keys tab, which is what
    // `ui.keybindings` is for. `move.north` because the harness publishes the
    // first few rows of the *active* tab, and Movement is the one that opens.
    await page.keyboard.press('KeyK');
    await page.waitForTimeout(900);
    const binds = await page.evaluate(
      () => document.querySelector<HTMLElement>('[data-ui-binds]')?.dataset['uiBinds'] ?? '',
    );
    const row = boxNamed(binds, 'move.north');
    check(row !== null, `the keybinding row is on screen (${binds.slice(0, 60) || 'nothing published'})`);

    if (row) {
      const at = await toCss(page, { x: row.x + row.width / 2, y: row.y + row.height / 2 });
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(500);
      // And now the press that is the whole point: on a button the row has no
      // reason to expect, over the row itself, where a press that was not
      // captured would arm the capture a second time instead of binding.
      await page.mouse.click(at.x, at.y, { button: MIDDLE });
      await page.waitForTimeout(600);
      const bound = await storedPrimary(page, 'move.north');
      check(bound === 'MouseMiddle', `the next press is bound and saved (${bound})`);
    }

    // Shut it before reloading, and not for tidiness: a window a player opened
    // comes back open (spec 147), so leaving it up means the next reload starts
    // with the options window over the whole viewport -- where every press is
    // the interface's and every notch is a scroll view's. It read as a mouse
    // that had stopped working, with the keyboard checks beside it still green.
    await page.keyboard.press('KeyK');
    await page.waitForTimeout(1200);

    console.log('a profile a player saved');
    await withBindings(page, [
      { actionId: ZOOM_IN_ACTION, primary: { code: 'WheelDown' }, secondary: null },
      { actionId: ZOOM_OUT_ACTION, primary: { code: 'WheelUp' }, secondary: null },
      { actionId: TOGGLE_STATS_ACTION, primary: { code: 'MouseMiddle' }, secondary: null },
    ]);
    await page.mouse.move(world.x, world.y);

    const open = await page.evaluate(
      () => document.querySelector<HTMLElement>('[data-ui-windows]')?.dataset['uiWindows'] ?? '',
    );
    check(open === '', `nothing is covering the world (${open || 'nothing open'})`);

    const swappedFrom = await zoom(page);
    await wheel(page, -100);
    const swappedTo = await zoom(page);
    check(
      Number.isFinite(swappedFrom) && swappedTo > swappedFrom,
      `the same notch now pushes the camera out (${swappedFrom} -> ${swappedTo})`,
    );

    check(await readoutOn(page), 'the readout is drawn again after the reload');
    await page.keyboard.press('F3');
    await page.waitForTimeout(500);
    check(await readoutOn(page), 'the key the button displaced no longer toggles it');

    await page.mouse.click(world.x, world.y, { button: MIDDLE });
    await page.waitForTimeout(600);
    check(!(await readoutOn(page)), 'the middle button does');
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(
      '\nthe wheel is a binding, a button reaches an action, the left one names a body,' +
        ' and the window captures a press',
    );
  }
}

await main();
