/**
 * Drive the map editor's rock tools in a real browser (spec 123).
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

/**
 * Read the status line until it says what a tool was expected to say.
 *
 * A fixed wait cannot work here: the autosave timer writes its own message into
 * the same line, so a read that is too late says "autosaved" and a read that is
 * too early says nothing yet -- and which of those you get depends on how fast
 * the machine is. Polling takes the first frame in which the tool has reported,
 * whichever side of the autosave that falls.
 */
async function waitForStatus(page: Page, pattern: RegExp, timeoutMs = 4000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    last = await readStatus(page);
    if (pattern.test(last)) return last;
    if (Date.now() >= deadline) return last;
    await page.waitForTimeout(100);
  }
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

    // `map=generated` because these steps are tuned against the small generated
    // world -- its extent, its empty corners, its part list. The editor opens
    // `maps/arena.json` by default since spec 176, and the shipped map is
    // already 210 chunks with six parts in it.
    // The built page is the game client since spec 253 and builds no tab strip at
    // all; this harness drives the Map editor tab, so it asks the workbench back.
    await page.goto(`http://localhost:${PORT}/?seed=20260806&map=generated&client=workbench`, { waitUntil: 'load' });
    await page.click('button:has-text("Map editor")');
    await page.waitForSelector('canvas:visible', { timeout: 60_000 });
    await page.waitForTimeout(3000);

    await page.click('button:has-text("rock")');
    await page.waitForTimeout(400);
    check('the rock folder appears when the mode is armed', await page.isVisible('text=Height above'), '');
    await page.screenshot({ path: join(outDir, 'editor-rock-armed.png') });

    // Drag out the first tier over ground that is already there.
    await drag(page, [330, 250], [820, 600]);
    const mid = await readStatus(page);
    check('the drag reports the rectangle it will bake', /\d+ x \d+/.test(mid), /(\d+ x \d+)/.exec(mid)?.[1] ?? mid);
    await page.screenshot({ path: join(outDir, 'editor-rock-selecting.png') });

    await page.mouse.up();
    const afterFirst = await waitForStatus(page, /tier "rock\/\d+": \d+ cells at -?\d+/);
    const first = /tier "(rock\/\d+)": (\d+) cells at (-?\d+)/.exec(afterFirst);
    check('releasing commits the tier', first !== null, first ? first[0] : afterFirst);
    // Trees stand on the ground layer and know nothing about a slab arriving
    // above them, so the tool that put the rock there has to take them out.
    check(
      'the trees under it are cleared',
      /cleared \d+ props/.test(afterFirst),
      /(cleared \d+ props)/.exec(afterFirst)?.[1] ?? 'no props cleared',
    );
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
    await drag(page, [500, 380], [700, 500]);
    await page.mouse.up();
    const afterSecond = await waitForStatus(page, /tier "rock\/\d+": \d+ cells at -?\d+/);
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

    // A broad tier for the stair to be cut into. Deliberately fatter than the
    // long thin slab above: a flight is drawn as two edges across the rock, and
    // a slab only a few cells wide leaves nowhere to put the first one.
    await drag(page, [300, 180], [900, 650]);
    await page.mouse.up();
    await waitForStatus(page, /tier "rock\/\d+"/);
    await page.screenshot({ path: join(outDir, 'editor-rock-stair-tier.png') });
    await page.click('button[title="stair"]:visible');
    await page.waitForTimeout(300);
    // Two edges, not a rectangle (spec 132): the first across the tier where the
    // flight meets it, the second out on the ground where its foot lands. Drawn
    // across the slab's width and stepped back along its length, because a
    // flight needs a cell of tread and a cell of riser per step.
    await drag(page, [510, 360], [570, 270]);
    await page.mouse.up();
    const afterHead = await waitForStatus(page, /head on "rock\/\d+" at -?\d+/);
    check(
      'the first edge is taken as the head, on the tier it was drawn on',
      /head on "rock\/\d+" at -?\d+ -- now draw the foot/.test(afterHead),
      /head on[^\u00b7]*/.exec(afterHead)?.[0] ?? afterHead.slice(-200),
    );

    await drag(page, [235, 175], [295, 85]);
    await page.mouse.up();
    const afterStair = await waitForStatus(page, /stair "stair\/\d+": \d+ cells in \d+ step/);
    const stair =
      /stair "(stair\/\d+)": (\d+) cells in (\d+) step\(s\), climbing (\d+), notched (\d+)/.exec(afterStair);
    check(
      'the second edge commits the flight',
      stair !== null,
      stair ? stair[0] : (/stair[^\u00b7]*/.exec(afterStair)?.[0] ?? afterStair.slice(-200)),
    );
    check(
      'the flight actually climbs something',
      stair !== null && Number(stair[4]) > 24,
      stair ? `climbs ${stair[4]}` : 'no climb reported',
    );
    // The steps are geometry now, so how many there are is a fact about the
    // shape rather than about the paint.
    check(
      'it is built out of more than one step',
      stair !== null && Number(stair[3]) > 1,
      stair ? `${stair[3]} step(s)` : 'no steps reported',
    );
    // ...and the tier it serves has a hole cut in it for the flight to sit in,
    // which is the half that only exists once the two are one stroke.
    check(
      'it is notched into the tier rather than propped against it',
      stair !== null && Number(stair[5]) > 0,
      stair ? `notched ${stair[5]}` : 'nothing notched',
    );
    await page.screenshot({ path: join(outDir, 'editor-rock-stair.png') });

    // An edge drawn out on the meadow is not the head of anything: there is no
    // tier under it for a flight to be cut into.
    await drag(page, [200, 640], [260, 700]);
    await page.mouse.up();
    const flat = await waitForStatus(page, /draw the first edge on a tier/);
    check(
      'an edge drawn off the rock is refused',
      /draw the first edge on a tier/.test(flat),
      /draw the first[^\u00b7]*/.exec(flat)?.[0] ?? flat.slice(-160),
    );

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(700);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(700);
    await page.click('button[title="add"]:visible');
    await page.waitForTimeout(300);

    // Re-draw one, then carve a bite out of it with the remove tool.
    await drag(page, [330, 250], [820, 600]);
    await page.mouse.up();
    await page.waitForTimeout(1000);
    // `:visible` matters: the parts folder has a "remove" of its own and a
    // "Remove that part" beside it, and both are still in the DOM while the
    // rock mode is armed -- just hidden.
    await page.click('button[title="remove"]:visible');
    await page.waitForTimeout(300);
    await drag(page, [380, 300], [560, 430]);
    await page.mouse.up();
    const afterCarve = await waitForStatus(page, /carved \d+ cells/);
    check('the remove tool carves a bite out of a tier', /carved \d+ cells/.test(afterCarve), afterCarve.slice(0, 160));
    await page.screenshot({ path: join(outDir, 'editor-rock-carved.png') });

    // Detail the formation: click it with the detail tool armed.
    await page.click('button[title="add"]:visible');
    await page.waitForTimeout(200);
    await drag(page, [330, 250], [820, 600]);
    await page.mouse.up();
    await page.waitForTimeout(1000);
    await page.click('button[title="detail"]:visible');
    await page.waitForTimeout(300);
    await page.mouse.move(560, 400);
    await page.mouse.down();
    await page.mouse.up();
    const afterDetail = await waitForStatus(page, /detailed \d+ tier\(s\)/);
    const detail = /detailed (\d+) tier\(s\): eroded (\d+) cells/.exec(afterDetail);
    check('the detail pass works a formation over', detail !== null, detail ? detail[0] : afterDetail.slice(0, 160));
    check(
      'it chews the outline',
      detail !== null && Number(detail[2]) > 0,
      detail ? `eroded ${detail[2]}` : 'nothing',
    );
    await page.screenshot({ path: join(outDir, 'editor-rock-detailed.png') });

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
