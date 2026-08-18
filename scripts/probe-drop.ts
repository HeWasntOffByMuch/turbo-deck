/**
 * An item taken out of a bag and left in the world (spec 168).
 *
 * Everything the feature decides is asserted in Node: the container rule
 * (`player/inventory.test.ts`), where it lands and what it is
 * (`sim/loot.test.ts`), the whole path over a real socket
 * (`client/drop-wire.test.ts`), and which press counts as "the world"
 * (`world/ui-screens.test.ts`). What none of them can see is the **wiring** --
 * whether a browser's press on the grass reaches `UiScreens.handlePointer`
 * before gameplay does, and whether `onDropItem` is connected to anything at
 * all. `UiScreens` is pure, so its test hands itself the press; the mount is one
 * line in `view.ts` and a line like that has been missing for three specs
 * before.
 *
 *   npm run build && npx tsx scripts/probe-drop.ts
 *
 * The measurement that makes it honest is the **Escape control**. A cell drawn
 * empty means one of two things -- the item is on the ground, or it is still in
 * hand, since a carry empties the cell it came from (spec 137). Escape cancels a
 * carry and puts it back, so the probe presses it: a cell that fills again was
 * never dropped, and a cell that stays empty is an item that genuinely left. It
 * runs the negative case first, so "Escape restores a carry" is measured on this
 * build rather than assumed.
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
const PORT = 4331;

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

/** The bag readout: one name per cell, gaps kept, so an index means something. */
async function cellNames(page: Page): Promise<readonly string[]> {
  const text = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-ui-cell-names]');
    return host?.dataset['uiCellNames'] ?? '';
  });
  return text.split(',');
}

async function cellBox(page: Page, index: number): Promise<Box | null> {
  const text = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-ui-cells]');
    return host?.dataset['uiCells'] ?? '';
  });
  for (const entry of text.split(';')) {
    const [id, rect] = entry.split(':');
    if (id !== String(index) || !rect) continue;
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
 * viewport it reports, so the harness never has to know the scale or the device
 * pixel ratio. The same conversion `probe-window-layout` clicks through.
 */
async function toCss(page: Page, at: { x: number; y: number }): Promise<{ x: number; y: number } | null> {
  const uiWidth = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-ui-viewport]');
    return Number((host?.dataset['uiViewport'] ?? '').split('x')[0]);
  });
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

async function clickUi(page: Page, at: { x: number; y: number }): Promise<void> {
  const css = await toCss(page, at);
  if (!css) throw new Error('the interface published no viewport to click in');
  await page.mouse.move(css.x, css.y);
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.up();
  await page.waitForTimeout(200);
}

/** The first bag cell with something in it, or -1. */
async function filledCell(page: Page): Promise<number> {
  return (await cellNames(page)).findIndex((name) => name !== '');
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

    await page.keyboard.press('KeyI');
    await page.waitForTimeout(500);

    const index = await filledCell(page);
    if (index < 0) {
      problems.push('the bag drew no cell with anything in it');
      throw new Error(problems.join('; '));
    }
    const held = (await cellNames(page))[index] ?? '';
    console.log(`  bag cell ${index} holds ${held}`);

    const cell = await cellBox(page, index);
    if (!cell) {
      problems.push(`the bag published no box for cell ${index}`);
      throw new Error(problems.join('; '));
    }
    const onCell = { x: cell.x + Math.floor(cell.width / 2), y: cell.y + Math.floor(cell.height / 2) };
    // Right of centre and above the bottom row of buttons: the bag opens at the
    // top-left margin and the HUD owns the corners, so this is grass.
    const uiViewport = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('[data-ui-viewport]');
      const [w, h] = (host?.dataset['uiViewport'] ?? '0x0').split('x').map(Number);
      return { width: w ?? 0, height: h ?? 0 };
    });
    const onWorld = {
      x: Math.floor(uiViewport.width * 0.62),
      y: Math.floor(uiViewport.height * 0.42),
    };

    // --- the control: a carry Escape puts back -----------------------------
    await clickUi(page, onCell);
    if (((await cellNames(page))[index] ?? '') !== '') {
      problems.push('clicking a cell did not take the item out of it');
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if (((await cellNames(page))[index] ?? '') !== held) {
      problems.push(`Escape did not put ${held} back in cell ${index}`);
    } else {
      console.log('  a carry cancelled with Escape goes back in its cell');
    }

    // --- the measurement ---------------------------------------------------
    await clickUi(page, onCell);
    await clickUi(page, onWorld);
    // Escape after the drop: if it were still in hand this would put it back,
    // and the cell would fill. It must not.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    const after = (await cellNames(page))[index] ?? '';
    if (after !== '') {
      problems.push(`${held} came back to cell ${index} -- it was never put down (cell holds "${after}")`);
    } else {
      console.log(`  a press on the world put ${held} down: cell ${index} is empty and stays empty`);
    }

    // A second look a moment later, because the rollback that would undo this is
    // an `Inventory` from the server and it travels at the speed of the wire: a
    // refusal read too early reads exactly like an acceptance.
    await page.waitForTimeout(1200);
    if (((await cellNames(page))[index] ?? '') !== '') {
      problems.push(`the server put ${held} back a moment later -- the drop was refused`);
    } else {
      console.log('  ...and the server agreed: a second later it is still gone');
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
  console.log('\nan item can be taken out of the bag and left in the world.');
}

await main();
