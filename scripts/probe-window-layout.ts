/**
 * A window sized, moved, and still there after a reload (spec 147).
 *
 * Everything this feature *decides* is pure and asserted in Node: the debounce,
 * the deferred restore, which windows may come back open, what the document
 * migrates from. What no headless test can reach is the half that was actually
 * broken for three specs -- the **wiring**. `layout-store.ts` passed every one
 * of its own tests while nothing in the shipped build imported it, and
 * `UiWindow.resizable` had a grip, a drag handler and a unit test while every
 * window in the game was registered without it.
 *
 * So this drives the real page: press I, drag the title bar, drag the grip, read
 * the box back off the readout, reload the tab, and require the same numbers.
 * Three things can only be answered here --
 *
 * - whether a browser's pointer events reach the grip at all, which is the one
 *   the spec's `hitTest` override exists for: the content box is inset by 4 and
 *   the grip is 7 square, so before the override the handle was a 4-pixel corner
 *   band and everything inside it belonged to the scroll view;
 * - whether `localStorage` actually receives the document;
 * - whether the restore survives the frame it has to survive, which is the one
 *   where `clientWidth` is still 0 and the viewport is the 1x1 placeholder.
 *
 *   npm run build && npx tsx scripts/probe-window-layout.ts
 *
 * Serves `dist/` rather than the dev server, so what is probed is what ships.
 * Prints a summary and exits non-zero on any problem.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4329;
const LAYOUT_KEY = 'turbo-deck.ui.layout';

/** The same browser the other previews drive: no GPU here, so software GL. */
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
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

/** The bits of the readout this probe reads. */
async function readout(page: Page): Promise<{ windows: string; frames: string; viewport: string }> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-ui-windows]');
    return {
      windows: host?.dataset['uiWindows'] ?? '',
      frames: host?.dataset['uiFrames'] ?? '',
      viewport: host?.dataset['uiViewport'] ?? '',
    };
  });
}

/** One `id:x,y,w,h` out of a readout's box list, in UI pixels. */
function boxNamed(list: string, id: string): Box | null {
  for (const entry of list.split(';')) {
    const [name, rect] = entry.split(':');
    if (name !== id || !rect) continue;
    const [x, y, width, height] = rect.split(',').map(Number);
    if (x === undefined || y === undefined || width === undefined || height === undefined) return null;
    return { x, y, width, height };
  }
  return null;
}

async function windowBox(page: Page, id: string): Promise<Box | null> {
  return boxNamed((await readout(page)).frames, id);
}

/**
 * A UI-pixel point in CSS pixels.
 *
 * The inverse of `UiLayer.toUi`, derived from the canvas's own CSS box over the
 * viewport it reports -- `cssWidth / uiWidth` is exactly `scale / dpr`, so the
 * harness never has to know either number. The same conversion `preview-world`
 * clicks through, for the same reason: an offset measured off a screenshot
 * passes for the wrong reason the first time the layout moves.
 */
async function toCss(page: Page, at: { x: number; y: number }): Promise<{ x: number; y: number } | null> {
  const uiWidth = Number((await readout(page)).viewport.split('x')[0]);
  if (!Number.isFinite(uiWidth) || uiWidth <= 0) return null;
  return page.evaluate(
    ([ux, uy, width]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-ui-canvas]');
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const perUiPixel = rect.width / (width ?? 1);
      return { x: rect.left + (ux ?? 0) * perUiPixel, y: rect.top + (uy ?? 0) * perUiPixel };
    },
    [at.x, at.y, uiWidth] as const,
  );
}

/**
 * Press, move, release -- in UI pixels, through the real pointer pipeline.
 *
 * Stepped rather than jumped, because the router turns a press into a drag only
 * once it has moved past `dragThreshold`, and a single teleporting move is one
 * event that may arrive before the press has been processed at all.
 */
async function dragUi(
  page: Page,
  from: { x: number; y: number },
  by: { x: number; y: number },
): Promise<void> {
  const start = await toCss(page, from);
  const end = await toCss(page, { x: from.x + by.x, y: from.y + by.y });
  if (!start || !end) return;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(
      start.x + ((end.x - start.x) * step) / 6,
      start.y + ((end.y - start.y) * step) / 6,
    );
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** The layout document as the page has it, or ''. */
async function storedLayout(page: Page): Promise<string> {
  return page.evaluate((key) => globalThis.localStorage?.getItem(key) ?? '', LAYOUT_KEY);
}

async function waitFor<T>(page: Page, read: () => Promise<T | null>, timeoutMs = 5000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await page.waitForTimeout(120);
  }
  return null;
}

function describeBox(box: Box | null): string {
  return box ? `${box.x},${box.y} ${box.width}x${box.height}` : 'nowhere';
}

async function main(): Promise<void> {
  const problems: string[] = [];

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
    await waitForTick(page, 30);

    // A layout left by an earlier run would make every number below a restore
    // rather than a placement, and the whole probe would pass without testing
    // anything. Cleared, then reloaded so the mount starts from nothing.
    await page.evaluate((key) => globalThis.localStorage?.removeItem(key), LAYOUT_KEY);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForTick(page, 30);

    // --- open the bag ------------------------------------------------------
    await page.keyboard.press('KeyI');
    const opened = await waitFor(page, async () =>
      (await readout(page)).windows.includes('inventory') ? await windowBox(page, 'inventory') : null,
    );
    if (!opened) {
      problems.push('pressing I never opened the bag');
      throw new Error(problems.join('; '));
    }
    console.log(`  the bag opens at ${describeBox(opened)}`);

    // --- drag it by the title bar ------------------------------------------
    // Six pixels down from the top edge is inside the title bar at any scale:
    // the bar is the body font's height plus the window padding.
    const moveBy = { x: 96, y: 64 };
    await dragUi(page, { x: opened.x + Math.floor(opened.width / 2), y: opened.y + 4 }, moveBy);
    const moved = await windowBox(page, 'inventory');
    if (!moved || (moved.x === opened.x && moved.y === opened.y)) {
      problems.push(`dragging the title bar moved nothing (still ${describeBox(moved)})`);
    } else {
      console.log(`  dragging the title bar moves it to ${describeBox(moved)}`);
    }
    const placed = moved ?? opened;

    // --- drag the grip -----------------------------------------------------
    //
    // The measurement this probe exists for. The grip is drawn in the very
    // corner and the content box reaches to within 4 pixels of it, so before
    // spec 147's `hitTest` override the scroll view took this press and the
    // window never saw a drag -- in Node and in the browser alike, which is why
    // "resizable: true" alone would not have been enough.
    const growBy = { x: 72, y: 56 };
    await dragUi(page, { x: placed.x + placed.width - 2, y: placed.y + placed.height - 2 }, growBy);
    const grown = await windowBox(page, 'inventory');
    if (!grown || grown.width <= placed.width || grown.height <= placed.height) {
      problems.push(
        `dragging the grip did not resize the bag (${describeBox(placed)} -> ${describeBox(grown)})`,
      );
    } else {
      console.log(`  dragging the grip resizes it to ${describeBox(grown)}`);
    }
    const before = grown ?? placed;

    // --- the document ------------------------------------------------------
    //
    // Waited for rather than read straight away: the write is debounced by 400ms
    // of real time, and a read on the next frame would find nothing and be right.
    const document = await waitFor(page, async () => {
      const text = await storedLayout(page);
      return text.includes('"inventory"') ? text : null;
    }, 6000);
    if (!document) {
      problems.push(`nothing was written to ${LAYOUT_KEY} after moving and resizing the bag`);
    } else {
      console.log(`  ${LAYOUT_KEY} holds ${document.length} bytes`);
    }

    // --- reload ------------------------------------------------------------
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForTick(page, 30);
    // Nothing is pressed here. The bag was open when the tab went away, and the
    // bag is a window the player drives, so it comes back open on its own.
    const after = await waitFor(page, async () => {
      const box = await windowBox(page, 'inventory');
      return box && box.width > 0 ? box : null;
    }, 8000);

    if (!after) {
      problems.push('the bag published no placement after the reload');
    } else if (
      after.x !== before.x ||
      after.y !== before.y ||
      after.width !== before.width ||
      after.height !== before.height
    ) {
      problems.push(`the bag came back at ${describeBox(after)} rather than ${describeBox(before)}`);
    } else {
      console.log(`  after a reload the bag is still at ${describeBox(after)}`);
    }

    const reopened = (await readout(page)).windows;
    if (!reopened.includes('inventory')) {
      problems.push(`the bag did not come back open (windows: "${reopened}")`);
    } else {
      console.log('  ...and still open, without a key being pressed');
    }

    // The two the server owns must never come back open, however the document
    // was written: a trade window restored open has no trade in it.
    for (const id of ['shop', 'trade']) {
      if (reopened.includes(id)) problems.push(`the ${id} window came back open`);
    }
  } finally {
    await browser.close();
    server.kill();
  }

  if (problems.length > 0) {
    console.error('\nproblems:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nthe layout survives a reload, and the grip is reachable.');
}

await main();
