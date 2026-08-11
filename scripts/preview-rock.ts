/**
 * Drive the map editor's rock tools in a real browser (spec 121).
 *
 * `editor/rock.ts` is tested headlessly and covers what a tier *does* to the
 * store, including undoing one byte for byte. What it cannot cover is whether
 * any of it is wired to the mouse -- the drag, the outline, the commit on
 * release, the tier dropdown arming itself on what was just drawn, the second
 * storey taking its height from the first, and the Ctrl+Z that takes it back.
 * Those live in `view.ts` and `panel.ts`, which need a DOM and a GPU.
 *
 * It is also the only thing that can answer the question the headless tests
 * cannot even ask: whether a layer created after the scene was built is
 * actually *drawn*. A tier that is walked on, collided with and invisible
 * passes every test in the suite.
 *
 *   npm run build && npx tsx scripts/preview-rock.ts
 *
 * Serves `dist/` rather than the dev server, so what is photographed is what
 * ships. Exits non-zero if a step did not do what it claims.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4322;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** Checks this script makes. A failure here is a failure of the rock tools. */
const problems: string[] = [];
/**
 * Anything the page itself logged.
 *
 * Kept apart from `problems` and deliberately not fatal. The page opens on the
 * Play tab before this switches to the editor, and the unit loader reports its
 * root-motion findings (spec 118) through `console.error` -- so every run picks
 * up warnings about the pig's clips that have nothing to do with rock. Folding
 * those into the exit code would make this script red from the day it was
 * written and teach whoever runs it next to ignore the colour.
 */
const pageLog: string[] = [];
function check(what: string, ok: boolean, saw: string): void {
  if (ok) {
    console.log(`  ok    ${what}`);
  } else {
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

/** The editor's status line, which every tool reports through. */
async function readStatus(page: Page): Promise<string> {
  const body = (await page.textContent('body')) ?? '';
  return body.replace(/\s+/g, ' ').trim();
}

/** Press, move in steps so the drag handler runs, and stop short of releasing. */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 10 });
  await page.waitForTimeout(250);
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
    // A thrown error is this script's business; a logged one is the page's.
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') pageLog.push(message.text());
    });

    await page.goto(`http://localhost:${PORT}/?seed=20260806`, { waitUntil: 'load' });
    await page.click('button:has-text("Map editor")');
    await page.waitForSelector('canvas:visible', { timeout: 60_000 });
    await page.waitForTimeout(3000);

    await page.click('button:has-text("rock")');
    await page.waitForTimeout(400);
    check('the rock folder appears when the mode is armed', await page.isVisible('text=Height above'), '');
    await page.screenshot({ path: join(outDir, 'editor-rock-armed.png') });

    // Drag out the first tier over ground that is already there.
    await drag(page, [430, 330], [700, 520]);
    const mid = await readStatus(page);
    check('the drag reports the rectangle it will bake', /\d+ x \d+/.test(mid), /(\d+ x \d+)/.exec(mid)?.[1] ?? mid);
    await page.screenshot({ path: join(outDir, 'editor-rock-selecting.png') });

    await page.mouse.up();
    await page.waitForTimeout(1200);
    const afterFirst = await readStatus(page);
    const first = /tier "(rock\/\d+)": (\d+) cells at (-?\d+)/.exec(afterFirst);
    check('releasing commits the tier', first !== null, first ? first[0] : afterFirst);
    await page.screenshot({ path: join(outDir, 'editor-rock-one.png') });

    // The tier just made should now be armed, so a second drag extends it.
    const armedTier = await page.$$eval('select', (nodes) =>
      nodes.map((n) => (n as HTMLSelectElement).value).filter((v) => v.startsWith('rock/')),
    );
    check('the panel arms the tier that was just drawn', armedTier.length > 0, armedTier.join(', ') || 'none');

    // ...and a *new* tier on top of it has to take its height from the tier
    // below, not from the ground. That is the whole reason the height is
    // relative, and it only works if the world was rebuilt when the layer
    // arrived -- so this is the assertion that catches a stale `heightAt`.
    const firstTop = Number(first?.[3] ?? '0');
    await page.selectOption('select:near(:text("Tier"))', '').catch(() => undefined);
    await page.waitForTimeout(200);
    await drag(page, [500, 380], [630, 470]);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    const afterSecond = await readStatus(page);
    const second = /tier "(rock\/\d+)": (\d+) cells at (-?\d+)/.exec(afterSecond);
    const secondTop = Number(second?.[3] ?? '0');
    check('a second tier lands, in its own layer', second !== null && second[1] !== first?.[1], second ? second[0] : afterSecond);
    check(
      'the second tier stands on the first rather than on the ground',
      second !== null && secondTop > firstTop,
      `first ${firstTop}, second ${secondTop}`,
    );
    await page.screenshot({ path: join(outDir, 'editor-rock-stacked.png') });

    // Ctrl+Z twice has to take the whole formation back, layers included.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(700);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(900);
    const tiersLeft = await page.$$eval('select', (nodes) =>
      nodes.flatMap((n) => Array.from((n as HTMLSelectElement).options, (o) => o.value)).filter((v) => v.startsWith('rock/')),
    );
    check('undo takes both tiers back, layers and all', tiersLeft.length === 0, tiersLeft.join(', ') || 'none');
    await page.screenshot({ path: join(outDir, 'editor-rock-undone.png') });

    // Re-draw one, then carve a bite out of it with the remove tool.
    await drag(page, [430, 330], [700, 520]);
    await page.mouse.up();
    await page.waitForTimeout(1000);
    // `:visible` matters: the parts folder has a "remove" of its own and a
    // "Remove that part" beside it, and both are still in the DOM while the
    // rock mode is armed -- just hidden.
    await page.click('button[title="remove"]:visible');
    await page.waitForTimeout(300);
    await drag(page, [450, 350], [560, 430]);
    await page.mouse.up();
    await page.waitForTimeout(1000);
    const afterCarve = await readStatus(page);
    check('the remove tool carves a bite out of a tier', /carved \d+ cells/.test(afterCarve), afterCarve.slice(0, 160));
    await page.screenshot({ path: join(outDir, 'editor-rock-carved.png') });

    console.log('\n----');
    if (problems.length === 0) console.log('nothing broke.');
    else {
      console.log(`${problems.length} problem(s):`);
      for (const p of problems) console.log(`  - ${p}`);
    }
    if (pageLog.length > 0) {
      console.log(`\nthe page also logged ${pageLog.length} error(s), not counted above:`);
      for (const line of pageLog) console.log(`  - ${line.slice(0, 160)}`);
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
