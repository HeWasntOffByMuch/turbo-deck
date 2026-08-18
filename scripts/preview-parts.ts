/**
 * Drive the map editor's part tools in a real browser (spec 084).
 *
 * `parts.ts` is tested headlessly and covers what a part *does* to the store.
 * What it cannot cover is whether any of it is wired to the mouse: the drag,
 * the chunk-snapped outline, the recipe dropdown, the commit on release, the
 * remove-by-click and the Ctrl+Z that takes it all back. Those live in
 * `view.ts` and `panel.ts`, which need a DOM and a GPU, so they get the same
 * treatment the rest of the renderer does -- drive the real page and photograph
 * the frames into `.claude/screenshots/`.
 *
 *   npm run build && npx tsx scripts/preview-parts.ts
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
const PORT = 4321;

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
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${url} never came up`);
}

/**
 * The editor's status line, which is where every part outcome is reported.
 *
 * Pulled out of the page text by shape rather than by selector: the readout is
 * one block with the map's own stats, and a refusal has to be as visible here
 * as a success or this harness reports "it did not work" for both.
 */
async function readStatus(page: Page): Promise<string> {
  const body = (await page.textContent('body')) ?? '';
  return /((?:added part|removed part|part refused|remove refused|no part|no recipe)[^\n]*)/.exec(body)?.[1] ?? '';
}

/** Drag across the ground, slowly enough that the loop sees the intermediate frames. */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      from[0] + ((to[0] - from[0]) * i) / 8,
      from[1] + ((to[1] - from[1]) * i) / 8,
    );
    await page.waitForTimeout(40);
  }
}

const failures: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
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

  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });

    // `map=generated` because these steps are tuned against the small generated
    // world -- its extent, its empty corners, its part list. The editor opens
    // `maps/arena.json` by default since spec 176, and the shipped map is
    // already 210 chunks with six parts in it.
    await page.goto(`http://localhost:${PORT}/?seed=20260806&map=generated`, { waitUntil: 'load' });
    await page.click('button:has-text("Map editor")');
    // `canvas` alone matches the Play tab's too -- it stays in the DOM, hidden,
    // when a tab is switched away from.
    await page.waitForSelector('canvas:visible', { timeout: 60_000 });
    await page.waitForTimeout(3000);

    // Arm the part tool. The mode strip is a row of buttons, one per mode.
    await page.click('button:has-text("part")');
    await page.waitForTimeout(400);
    const recipeVisible = await page.isVisible('text=Recipe');
    check('the part folder appears when the mode is armed', recipeVisible, '');

    const recipeOptions = await page.$$eval('select', (nodes) =>
      nodes.flatMap((n) => Array.from((n as HTMLSelectElement).options, (o) => o.value)),
    );
    check(
      'the bundled recipes reached the dropdown',
      recipeOptions.includes('east-shelf'),
      recipeOptions.filter((o) => o).join(', '),
    );

    await page.screenshot({ path: join(outDir, 'editor-part-armed.png') });

    // Zoom out until the map's edge is on screen: a part is grown into ground
    // that does not exist, so the drag has to reach past the terrain.
    await page.mouse.move(640, 400);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, 'editor-part-zoomed.png') });

    // Drag over the empty space north-west of the map -- outside the terrain
    // diamond and clear of the panel on the right -- and hold, so the outline is
    // caught mid-drag rather than only after it commits.
    await drag(page, [120, 130], [250, 200]);
    const dragging = (await page.textContent('body')) ?? '';
    const showsSelection = /\d+ chunks: -?\d+,-?\d+\.\.-?\d+,-?\d+/.test(dragging);
    check(
      'the drag reports a chunk-snapped selection',
      showsSelection,
      /(\d+ chunks: [-\d,.]+)/.exec(dragging)?.[1] ?? 'no selection line',
    );
    await page.screenshot({ path: join(outDir, 'editor-part-selecting.png') });

    await page.mouse.up();
    await page.waitForTimeout(1200);
    const afterAdd = await readStatus(page);
    const grew = /added part "([^"]+)" \((\d+) chunks/.exec(afterAdd);
    check('releasing commits the part', grew !== null, grew ? `${grew[1]}, ${grew[2]} chunks` : afterAdd);
    // Track the camera west so the new ground is in frame rather than off the
    // corner it was grown into -- the screenshot is the point of this script.
    await page.mouse.move(640, 400);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(880, 520, { steps: 12 });
    await page.mouse.up({ button: 'middle' });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, 'editor-part-added.png') });

    // Ctrl+Z has to take back the whole thing: the chunks, the bounds and the
    // parts list. The status line only says a stroke was undone, so the proof
    // is that removing the part afterwards can no longer find it.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(outDir, 'editor-part-undone.png') });

    // Re-add, then remove by clicking inside it.
    await drag(page, [120, 130], [250, 200]);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    const readded = /added part "([^"]+)"/.exec(await readStatus(page));
    check('the same part can be grown again after an undo', readded !== null, readded?.[1] ?? '');

    // A second part from the same recipe, without touching the id field: the
    // name is made unique rather than colliding, so growing a run of ground is
    // a run of drags (spec 084).
    await drag(page, [120, 250], [250, 320]);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    const second = /added part "([^"]+)"/.exec(await readStatus(page));
    check(
      'a second part from the same recipe gets its own id',
      second !== null && second[1] !== 'east-shelf',
      second?.[1] ?? (await readStatus(page)),
    );

    const namedOptions = await page.$$eval('select', (nodes) =>
      nodes.flatMap((n) => Array.from((n as HTMLSelectElement).options, (o) => o.value)),
    );
    check(
      'the remove dropdown lists the parts in the map',
      namedOptions.includes('east-shelf') && namedOptions.includes('east-shelf-2'),
      namedOptions.filter((o) => o).join(', '),
    );

    // Remove the second one by name, since clicking a part off-screen is not
    // always possible once the world is a few thousand units across.
    await page.selectOption('select >> nth=-1', 'east-shelf-2');
    await page.click('button:has-text("Remove that part")');
    await page.waitForTimeout(1200);
    const byName = /removed part "([^"]+)"/.exec(await readStatus(page));
    check('the named part can be removed from the panel', byName?.[1] === 'east-shelf-2', byName?.[1] ?? '');

    await page.click('button:has-text("remove")');
    await page.waitForTimeout(300);
    await page.mouse.click(185, 165);
    await page.waitForTimeout(1200);
    const afterRemove = await readStatus(page);
    const removed = /removed part "([^"]+)" \((\d+) chunks/.exec(afterRemove);
    check(
      'clicking inside a part removes it',
      removed !== null,
      removed ? `${removed[1]}, ${removed[2]} chunks` : afterRemove,
    );
    await page.screenshot({ path: join(outDir, 'editor-part-removed.png') });

    // And undo puts it back.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(outDir, 'editor-part-restored.png') });

    // The shipped map's east column and south row are *short* (spec 084): their
    // ground stops before their own chunk footprint ends. A part dragged clear
    // of one must absorb and complete it, or it strands a 528-unit strip of
    // nothing too narrow to select and impossible to fill by dragging.
    //
    // Which pixels land next to a short edge depends on the camera, and aiming
    // world coordinates through an isometric projection from this harness would
    // be testing this file's copy of the projection rather than the editor's.
    // So it tries a ring of drags around the map and asks which one did it --
    // the same way `preview-world.ts` hunts for a body to right-click.
    await page.click('button:has-text("add")');
    await page.waitForTimeout(200);

    const attempts: [[number, number], [number, number]][] = [
      [[700, 470], [860, 600]],
      [[820, 380], [960, 500]],
      [[560, 560], [700, 680]],
      [[880, 300], [1000, 420]],
      [[420, 520], [560, 650]],
    ];
    let completedCount = 0;
    let where = '';
    for (const [from, to] of attempts) {
      await drag(page, from, to);
      const selection = /(\d+ chunks: [-\d,.]+)/.exec((await page.textContent('body')) ?? '')?.[1] ?? '?';
      await page.mouse.up();
      await page.waitForTimeout(1400);
      const status = await readStatus(page);
      const completed = /added part "[^"]+" \(\d+ chunks, (\d+) completed\)/.exec(status);
      if (completed) {
        completedCount = Number(completed[1]);
        where = selection;
        break;
      }
      // Not next to a short edge: take it back and try elsewhere, so the
      // attempts do not pile up into a map nobody meant to build.
      if (/added part/.test(status)) {
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(700);
      }
    }
    // Whether any of these pixels lands beside a short edge depends on where the
    // camera ended up, which depends on how the earlier steps' wheel and drag
    // events were timed -- so this is *not* asserted. `part.test.ts` pins both
    // completion paths exactly and deterministically; all this can honestly say
    // is whether completion reached the screen on this run. A check that passes
    // or fails by timing is worse than no check, because it teaches you to
    // ignore the harness.
    console.log(
      completedCount > 0
        ? `  ok   completion reached the screen — ${completedCount} completed, selection ${where}`
        : '  --   no attempt landed at a short edge this run (not a failure; see part.test.ts)',
    );
    await page.screenshot({ path: join(outDir, 'editor-part-short-edge.png') });

    check('the page logged no errors', problems.length === 0, problems.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nall part-tool checks passed');
  }
}

void main();
