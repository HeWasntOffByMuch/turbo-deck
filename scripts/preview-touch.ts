/**
 * Drive the play view with real touch events (spec 093).
 *
 * The recogniser is pure and unit-tested; what this checks is the half that is
 * not -- that a tap reaches `pointerup` at all on a device where the browser
 * would rather scroll, that it carries the order a right-click used to, that a
 * pinch moves the zoom the slider owns, and that a phone-shaped landscape
 * viewport is a playable frame rather than a HUD with a game behind it.
 *
 *   npm run build && npx tsx scripts/preview-touch.ts
 *
 * Serves `dist/` rather than the dev server, so what is driven is what ships.
 * The gestures go through CDP `Input.dispatchTouchEvent`, because Playwright's
 * own touchscreen has no pinch and a pinch is half of this spec.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type CDPSession, type Page } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4321;

/** A phone held sideways. Narrow enough that the HUD has to share the frame. */
const VIEWPORT = { width: 844, height: 390 };

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

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

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A tap, as the browser delivers one: down, a beat, up in the same place.
 *
 * Dispatched through CDP rather than `page.mouse`, so it arrives as a pointer
 * event with `pointerType === 'touch'` -- which is the whole thing being
 * checked. A mouse click would take the other branch and prove nothing.
 */
async function tap(cdp: CDPSession, at: Point): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: at.x, y: at.y, id: 1 }],
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * A pinch about a centre: two fingers stepped from `from` to `to` apart.
 *
 * Stepped rather than jumped, because the recogniser reports each move against
 * the last one -- a single leap would be one ratio and would not exercise the
 * composition that makes a real gesture feel proportional.
 */
async function pinch(cdp: CDPSession, centre: Point, from: number, to: number, steps = 10): Promise<void> {
  const at = (spread: number): { x: number; y: number; id: number }[] => [
    { x: centre.x - spread / 2, y: centre.y, id: 1 },
    { x: centre.x + spread / 2, y: centre.y, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from) });
  for (let step = 1; step <= steps; step++) {
    const spread = from + ((to - from) * step) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(spread) });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** The target line the HUD is showing: "no target", or a name and its health. */
async function readTarget(page: Page): Promise<string> {
  const text = (await page.textContent('body')) ?? '';
  return /(no target|target [^\n]*)/.exec(text)?.[1] ?? '';
}

/**
 * The target line once it has stopped changing, without its health.
 *
 * Polled rather than read once: the line is written during a *frame*, and on
 * software WebGL a frame is not a formality -- a single read a couple of hundred
 * milliseconds after a gesture reports the state before it. The health is
 * stripped because it moves on its own while the target is being attacked, so
 * it can never settle.
 */
async function settledTarget(page: Page, timeoutMs = 15_000): Promise<string> {
  // Waited out in *ticks*, not milliseconds. Under software WebGL a frame here
  // can take over a second, and two wall-clock reads 150ms apart are then two
  // samples of the same stale frame -- which reads as "settled" and is not. The
  // tick counter only moves when a frame ran, so it is the honest clock.
  await waitTicks(page, 20, timeoutMs);
  let last = (await readTarget(page)).replace(/ \d+\/\d+$/, '');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await waitTicks(page, 10, timeoutMs);
    const now = (await readTarget(page)).replace(/ \d+\/\d+$/, '');
    if (now === last) return now;
    last = now;
  }
  return last;
}

/** Wait until the sim has advanced `ticks` further than it has right now. */
async function waitTicks(page: Page, ticks: number, timeoutMs = 15_000): Promise<void> {
  const readTick = async (): Promise<number> =>
    Number(/tick (\d+)/.exec((await page.textContent('body')) ?? '')?.[1] ?? -1);
  const start = await readTick();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readTick()) >= start + ticks) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface Bar {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** Where every body with a health bar is on screen, by entity id. */
async function bodiesOnScreen(page: Page): Promise<Bar[]> {
  return page.$$eval('[data-entity]', (nodes) =>
    nodes.map((node) => {
      const element = node as HTMLElement;
      return { id: element.dataset['entity'] ?? '', x: element.offsetLeft, y: element.offsetTop };
    }),
  );
}

/**
 * The zoom the view is actually framing at.
 *
 * Read off the panel's slider, because the slider *is* the zoom (spec 034) --
 * if the pinch moved a number of its own instead, this would sit still and say
 * so.
 */
async function readZoom(page: Page): Promise<number> {
  // Off the published attribute rather than off the Zoom slider: a phone does
  // not build the settings panel at all since spec 140, and the pinch has to be
  // checkable on the device it is for. It is the same number the slider holds --
  // `view.ts` writes it from `ViewControls.viewHalfWidth()`.
  const text = await page.getAttribute('[data-camera-zoom]', 'data-camera-zoom');
  return text === null ? Number.NaN : Number(text);
}

/**
 * Wait for a window to be open (or shut), and report the list either way.
 *
 * Polled rather than slept against, because the *first* window opened in a
 * session is slow: laying a screen out, baking its atlas and painting it lands
 * in one frame, on top of a world that is already using most of the budget. A
 * fixed 250ms saw the state from before the tap and reported the button broken
 * -- which is the same class of mistake the tap budget was in spec 093.
 */
async function waitForWindow(page: Page, id: string, open: boolean, timeoutMs = 6000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let windows = '';
  while (Date.now() < deadline) {
    windows = (await page.getAttribute('[data-ui-windows]', 'data-ui-windows')) ?? '';
    if (windows.split(',').includes(id) === open) return windows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return windows;
}

async function waitForTick(page: Page, ticks: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const text = (await page.textContent('body')) ?? '';
    last = Number(/tick (\d+)/.exec(text)?.[1] ?? -1);
    if (last >= ticks) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`sim never reached tick ${ticks} (last seen: ${last})`);
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
  const problems: string[] = [];
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    // `hasTouch` is what makes `(pointer: coarse)` match, which is what decides
    // whether the fullscreen button exists and whether the hint line talks about
    // taps -- so it is not decoration, it is the device under test.
    const context = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);

    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });

    // Pinned, for the same reason `preview-world.ts` pins it: an unseeded world
    // puts the bodies somewhere new every run.
    await page.goto(`http://localhost:${PORT}/?seed=20260806`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });
    await waitForTick(page, 150);

    await shoot(page, 'touch-landscape');

    // --- the hint line names gestures, not buttons -------------------------
    const hint = (await page.textContent('body')) ?? '';
    const tapHint = /tap ground to move[^\n]*/.exec(hint)?.[0] ?? '';
    console.log(`  hint line: ${tapHint || '(still the mouse one)'}`);
    if (!tapHint) problems.push('the HUD is still telling a phone to right-click');

    // --- a phone is offered the game and nothing else (spec 140) -----------
    //
    // The fullscreen button is not a tab and is meant to be there: it is the one
    // control left in the bar, because a third of this frame is browser chrome.
    const workbenches = await page.$$eval('[data-tab-bar] button', (nodes) =>
      nodes
        .filter((node) => !/Fullscreen|Leave fullscreen/.test(node.getAttribute('aria-label') ?? ''))
        .map((node) => node.textContent ?? ''),
    );
    console.log(`  tab buttons in the bar: ${workbenches.length === 0 ? 'none' : workbenches.join(', ')}`);
    if (workbenches.length > 0) problems.push(`a phone is still offered ${workbenches.join(', ')}`);

    // The seven tuning popovers are not built at all, so the corner is world.
    const cogs = await page.$$eval('button', (nodes) =>
      nodes.filter((node) =>
        /View settings|Day and night|Player lights|Retro filter|Hike look|Weather|Effects/.test(
          node.getAttribute('aria-label') ?? node.getAttribute('title') ?? '',
        ),
      ).length,
    );
    console.log(`  tuning popovers on screen: ${cogs}`);
    if (cogs > 0) problems.push(`${cogs} tuning popover(s) are still built on a phone`);

    // ...and the developer readout is written but not drawn, which is what the
    // tick-reading above depends on. Asserted on the painted box, not on text.
    const readoutDrawn = await page.evaluate(() => {
      // The *innermost* match. Every ancestor of the readout contains its text
      // too -- the HUD root's `textContent` starts with "tick 3 delta 0" -- so a
      // `find` over every div reports the HUD's own box and calls it drawn.
      const panels = Array.from(document.querySelectorAll('div')).filter(
        (node) => /^tick \d+\s+delta/.test(node.textContent ?? '') && node.children.length === 0,
      );
      const readout = panels[panels.length - 1];
      if (!readout) return 'absent';
      return readout.getBoundingClientRect().height > 0 ? 'drawn' : 'hidden';
    });
    console.log(`  developer readout: ${readoutDrawn}`);
    if (readoutDrawn === 'drawn') problems.push('the developer readout is drawn on a phone');
    if (readoutDrawn === 'absent') {
      problems.push('the developer readout is gone entirely, and it is this harness’s clock');
    }

    // --- the three window buttons open their windows ------------------------
    //
    // The reason they exist: I, C and Escape are the only other way in, and a
    // phone has none of the three.
    for (const [id, name] of [
      ['inventory', 'Bag'],
      ['character', 'Gear'],
      ['options', 'Options'],
    ] as const) {
      const button = await page.$(`[data-window="${id}"]`);
      if (!button) {
        problems.push(`no ${name} button on the HUD`);
        continue;
      }
      const box = await button.boundingBox();
      if (!box) {
        problems.push(`the ${name} button is not laid out`);
        continue;
      }
      // A real finger on the button, not `.click()`: the whole question is
      // whether a touch reaches it rather than being eaten by the world.
      const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await tap(cdp, centre);
      const opened = await waitForWindow(page, id, true);
      console.log(`  tapped ${name}: windows now "${opened || 'none'}"`);
      if (!opened.split(',').includes(id)) problems.push(`tapping ${name} did not open ${id}`);
      // ...and it closes again, so the button is a toggle rather than a one-way
      // door on a device with no Escape key.
      await tap(cdp, centre);
      const closed = await waitForWindow(page, id, false);
      if (closed.split(',').includes(id)) problems.push(`tapping ${name} again did not close ${id}`);
    }
    await shoot(page, 'touch-windows');

    // --- a tap inside an open window is not also a move order ---------------
    const bagButton = await page.$('[data-window="inventory"]');
    const bagBox = await bagButton?.boundingBox();
    if (bagBox) {
      await tap(cdp, { x: bagBox.x + bagBox.width / 2, y: bagBox.y + bagBox.height / 2 });
      await waitForWindow(page, 'inventory', true);
      const cells = (await page.getAttribute('[data-ui-cells]', 'data-ui-cells')) ?? '';
      const first = /(-?\d+),(-?\d+),(\d+),(\d+)/.exec(cells.split(';')[0] ?? '');
      const scale = Number((await page.getAttribute('[data-ui-scale]', 'data-ui-scale')) ?? '1');
      if (first) {
        // UI pixels back to CSS pixels: the layer scales by `scale` over dpr.
        const dpr = await page.evaluate(() => window.devicePixelRatio);
        const cx = ((Number(first[1]) + Number(first[3]) / 2) * scale) / dpr;
        const cy = ((Number(first[2]) + Number(first[4]) / 2) * scale) / dpr;
        const before = await readTarget(page);
        await tap(cdp, { x: cx, y: cy });
        await page.waitForTimeout(300);
        const after = await readTarget(page);
        console.log(`  tap inside the open bag at ${Math.round(cx)},${Math.round(cy)}: "${before}" -> "${after}"`);
        if (after !== before) {
          problems.push(`a tap inside the bag reached the world ("${before}" -> "${after}")`);
        }
      }
      // Leave it closed, so the rest of the run sees the world.
      await tap(cdp, { x: bagBox.x + bagBox.width / 2, y: bagBox.y + bagBox.height / 2 });
      await waitForWindow(page, 'inventory', false);
    }

    // --- the fullscreen button exists on a coarse pointer -------------------
    const fullscreen = await page.$$eval('button', (nodes) =>
      nodes.filter((node) => /Fullscreen|Leave fullscreen/.test(node.getAttribute('aria-label') ?? '')).length,
    );
    console.log(`  fullscreen buttons in the bar: ${fullscreen}`);
    if (fullscreen !== 1) problems.push(`expected one fullscreen button, found ${fullscreen}`);

    // --- a tap on a body is the attack order --------------------------------
    // Count what the canvas actually receives, so "the tap did nothing" can be
    // told apart from "the tap never arrived".
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const tally: Record<string, number> = {};
      (window as unknown as { __touchTally: Record<string, number> }).__touchTally = tally;
      const trace: string[] = [];
      (window as unknown as { __touchTrace: string[] }).__touchTrace = trace;
      for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'pointermove']) {
        canvas?.addEventListener(type, (event) => {
          const pointer = event as PointerEvent;
          const key = `${type}:${pointer.pointerType}`;
          tally[key] = (tally[key] ?? 0) + 1;
          if (pointer.pointerType === 'touch' && type !== 'pointermove') {
            trace.push(`${type} id=${pointer.pointerId} t=${Math.round(pointer.timeStamp)}`);
          }
        });
      }
    });

    // Re-read the bars before *every* tap. A tap that misses is a move order, so
    // the player walks and the camera follows -- and a list read once names
    // pixels the bodies have already left. This was a harness bug that looked
    // exactly like a broken tap.
    let targeted = '';
    const tried = new Set<string>();
    for (let attempt = 0; attempt < 14 && !targeted; attempt++) {
      const bars = await bodiesOnScreen(page);
      const bar = bars.find((candidate) => {
        if (tried.has(candidate.id)) return false;
        const y = candidate.y + 40;
        // Bars behind the readout panel or the hotbar are taps on the HUD, which
        // the canvas never hears.
        return y > 0 && y < VIEWPORT.height && candidate.x > 0 && candidate.x < VIEWPORT.width;
      });
      if (!bar) break;
      tried.add(bar.id);
      const point = { x: bar.x, y: bar.y + 40 };
      const top = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.tagName.toLowerCase() ?? 'nothing',
        point,
      );
      if (top !== 'canvas') continue;
      await tap(cdp, point);
      await page.waitForTimeout(150);
      const target = await readTarget(page);
      // A right-click at the same pixel, purely to tell "touch is broken" apart
      // from "this harness is aiming at the wrong pixel". If the mouse finds a
      // body here and the finger did not, the fault is the finger's.
      let byMouse = '';
      if (!target.startsWith('target ')) {
        await page.mouse.click(point.x, point.y, { button: 'right' });
        await page.waitForTimeout(150);
        byMouse = await readTarget(page);
      }
      console.log(`    bar ${bar.id} at ${point.x},${point.y} -> tap: ${target} | mouse: ${byMouse || 'n/a'}`);
      // The player's own bar is in this list, and tapping yourself is a move
      // order -- so a miss is an answer, not a failure.
      if (target.startsWith('target ')) targeted = target;
    }
    console.log(`  tap on a body: ${targeted || 'found nothing'}`);
    if (!targeted) problems.push('a tap on a body never produced an attack order');
    await shoot(page, 'touch-target');

    // --- a tap on empty ground lets the target go ---------------------------
    //
    // The point is *found* rather than written down: the HUD panels move with
    // the viewport, and a hard-coded pixel that drifts under the weapon list is
    // a tap on a button, which proves nothing about the ground.
    // No named inner functions in here: tsx compiles this body with esbuild's
    // keepNames, which wraps them in a `__name` helper that does not exist in
    // the page.
    // The *emptiest* canvas pixel, not the first one found. A pick is forgiving
    // by design (spec 071), so ground that merely has no body exactly on it can
    // still be within a body's budget -- the first bare pixel in a raster scan
    // is at the screen edge, which is exactly where that is hardest to rule out.
    const grass = await page.evaluate((bars: Bar[]) => {
      let best: { x: number; y: number; clearance: number } | null = null;
      for (let y = 70; y < window.innerHeight - 50; y += 10) {
        for (let x = 30; x < window.innerWidth - 30; x += 10) {
          if (document.elementFromPoint(x, y)?.tagName.toLowerCase() !== 'canvas') continue;
          let clearance = Infinity;
          for (const bar of bars) clearance = Math.min(clearance, Math.hypot(bar.x - x, bar.y + 40 - y));
          if (!best || clearance > best.clearance) best = { x, y, clearance };
        }
      }
      return best;
    }, await bodiesOnScreen(page));
    if (!grass) throw new Error('no bare canvas to tap');
    console.log(`  bare ground at ${grass.x},${grass.y} (${Math.round(grass.clearance)}px from the nearest body)`);
    await tap(cdp, grass);
    await page.waitForTimeout(400);
    const afterGround = await readTarget(page);
    let groundByMouse = '';
    if (afterGround !== 'no target') {
      await page.mouse.click(grass.x, grass.y, { button: 'right' });
      await page.waitForTimeout(400);
      groundByMouse = await readTarget(page);
    }
    console.log(`  tap on grass: ${afterGround} | mouse at the same pixel: ${groundByMouse || 'n/a'}`);
    if (afterGround !== 'no target') {
      problems.push(
        groundByMouse === 'no target'
          ? `a tap on grass left the target as "${afterGround}" where a right-click cleared it`
          : `neither a tap nor a right-click cleared the target at ${grass.x},${grass.y} — the pixel is not bare ground`,
      );
    }

    // --- the sim keeps running after all that -------------------------------
    const before = Number(/tick (\d+)/.exec((await page.textContent('body')) ?? '')?.[1] ?? -1);
    await page.waitForTimeout(1200);
    const after = Number(/tick (\d+)/.exec((await page.textContent('body')) ?? '')?.[1] ?? -1);
    console.log(`  ticks advanced after the taps: ${after - before}`);
    if (after <= before) problems.push('the sim stopped ticking after a tap');

    // --- pinch moves the zoom the slider owns -------------------------------
    const centre = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
    const opened = await readZoom(page);
    await pinch(cdp, centre, 120, 380);
    await page.waitForTimeout(200);
    const spread = await readZoom(page);
    await pinch(cdp, centre, 380, 120);
    await page.waitForTimeout(200);
    const closed = await readZoom(page);
    console.log(`  zoom span — opened ${opened}, after spreading ${spread}, after closing ${closed}`);
    if (!(spread < opened)) problems.push(`spreading the fingers did not zoom in (${opened} -> ${spread})`);
    if (!(closed > spread)) problems.push(`closing the fingers did not zoom out (${spread} -> ${closed})`);
    await shoot(page, 'touch-pinched');

    // --- a pinch is not also a tap ------------------------------------------
    //
    // Asserted in the one direction combat cannot fake. "Did the order survive
    // the pinch" looks like the natural check and is not sound: a pinch takes
    // seconds of wall clock here, and in that time a Grazer being auto-attacked
    // can die, which drops the target legitimately (`driveAutoAttack`). Nothing
    // in the game *acquires* a target on its own -- only an order does -- so a
    // target appearing out of "no target" can only be a finger read as a tap.
    // Pinching centred on a body is what makes that the likely failure.
    const beforePinch = await settledTarget(page);
    if (beforePinch !== 'no target') {
      problems.push(`expected to go into the pinch untargeted, was "${beforePinch}"`);
    }
    const over = (await bodiesOnScreen(page)).find(
      (bar) => bar.x > 60 && bar.x < VIEWPORT.width - 60 && bar.y + 40 > 60 && bar.y + 40 < VIEWPORT.height - 60,
    );
    const pinchAt = over ? { x: over.x, y: over.y + 40 } : centre;
    console.log(`  pinching over ${over ? `body ${over.id}` : 'the middle of the frame'} at ${pinchAt.x},${pinchAt.y}`);
    await pinch(cdp, pinchAt, 150, 300);
    const afterPinch = await settledTarget(page);
    console.log(`  target across a pinch: "${beforePinch}" -> "${afterPinch}"`);
    if (afterPinch.startsWith('target ')) {
      problems.push(`a pinch acquired "${afterPinch}", so a finger was read as a tap`);
    }

    if (problems.length > 0) {
      // The raw event log, printed only when something failed. It is what told
      // "the tap never arrived" apart from "the tap arrived and did nothing" --
      // and, from the gap between a down and its up, that the tap budget was
      // measuring the renderer's load rather than the finger.
      console.error('\npointer events the canvas saw:');
      console.error(
        `  ${JSON.stringify(
          await page.evaluate(
            () => (window as unknown as { __touchTally: Record<string, number> }).__touchTally,
          ),
        )}`,
      );
      for (const line of await page.evaluate(
        () => (window as unknown as { __touchTrace: string[] }).__touchTrace,
      )) {
        console.error(`  ${line}`);
      }
      console.error('\nproblems:');
      for (const problem of problems) console.error(`  ${problem}`);
      process.exitCode = 1;
    } else {
      console.log('\nall touch checks passed');
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

await main();
