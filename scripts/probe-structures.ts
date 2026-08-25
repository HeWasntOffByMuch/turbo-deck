/**
 * Place a hut and a well in the Map editor, and read them back out of the saved
 * file (spec 222).
 *
 * The half no headless test can reach, and the failure it exists to catch is
 * the one this repo keeps finding: every rule about a structure is green in Node
 * -- the store takes one, `serializeMap` writes it, the field builds its
 * geometry, `placeStructure` refuses the right things -- and all of that can be
 * true beside a `view.ts` that calls none of it. A ninth entry in a mode array
 * cannot fail a typecheck and cannot fail a headless test.
 *
 * So this drives the shipped build: opens the tab, arms the tool, presses on the
 * ground, drags one out, and checks the *file that came out*. The file is the
 * deliverable -- a building the editor draws and does not save is exactly the
 * bug spec 176 turned out to be.
 *
 * Spec 223 adds the half a file cannot answer. A preview lives entirely in the
 * scene graph and a drag's size is only visible while the button is down, so
 * both are read off `data-ghost` mid-gesture: a tool that ignored the drag and
 * sized the building at the release would leave exactly the same document as
 * one that grew it under the cursor the whole way.
 *
 *   npm run build && npx tsx scripts/probe-structures.ts
 *
 * Serves `dist/` rather than the dev server, so what is measured is what ships.
 * Exits non-zero if a step did not do what it claims.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { STRUCTURE_KINDS } from '../src/terrain/vegetation.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4331;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

interface SavedProp {
  readonly species: string;
  readonly x: number;
  readonly z: number;
  readonly rotation?: number;
  readonly scale?: number;
}
interface MapFile {
  readonly layers?: readonly { readonly chunks?: readonly { readonly props?: readonly SavedProp[] }[] }[];
}

const failures: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
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

const readout = async (page: Page): Promise<string> => (await page.textContent('body')) ?? '';

/**
 * What the ghost has on the scene graph, off `data-ghost` (spec 223).
 *
 * Published from what is *attached and visible* rather than from what the frame
 * last asked for, so a preview built and hung on nothing, or one left up after
 * the tool was disarmed, reads as wrong here.
 */
async function ghost(page: Page): Promise<string> {
  return (await page.getAttribute('[data-ghost]', 'data-ghost')) ?? '(no readout)';
}

const ghostScale = async (page: Page): Promise<number> =>
  Number(/scale:([\d.]+)/.exec(await ghost(page))?.[1] ?? Number.NaN);

/** How many props the editor says the map holds. The one unambiguous signal
 *  that a placement has actually been processed. */
async function propCount(page: Page): Promise<number> {
  return Number(/([\d,]+) props/.exec(await readout(page))?.[1]?.replace(/,/g, '') ?? Number.NaN);
}

/**
 * Wait until the editor has actually taken the gesture.
 *
 * A **poll**, never a fixed wait, and the reason is measured rather than
 * cautious: this environment paints the editor at about five frames a second
 * under software GL, and a building now lands on the *release* (spec 223) --
 * so half a second after the button comes up the frame that places it may not
 * have run. Waited out with a constant, the first cut of this probe read the
 * status line before the placement, set the facing slider before it, and
 * reported three huts placed at one facing as a broken facing slider.
 */
/** Spin the wheel over the canvas, and let the ground catch up. */
async function zoom(page: Page, notches: number, delta: number): Promise<void> {
  await page.mouse.move(500, 400);
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(2500);
}

/**
 * Poll `data-ghost` over a point until it says what is wanted, or give up.
 *
 * Which point matters, and the first cut of this got it wrong: it hovered the
 * middle of the view, where ground stays meshed however far you zoom out --
 * the keep window grows around what was already there -- and reported a
 * working refusal as a preview that would not go away. Unmeshed ground is at
 * the *corners*, which is where a zoomed-out view has ground it has not caught
 * up with yet.
 */
async function ghostBecomes(page: Page, want: 'hidden' | 'drawn', at: readonly [number, number]): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    // Nudged by a pixel each time, because the preview is placed from a pointer
    // event as well as from the frame: parked perfectly still, a poll can read
    // the same stale frame sixty times.
    await page.mouse.move(at[0] + (i % 2), at[1]);
    await page.waitForTimeout(400);
    const now = await ghost(page);
    if (want === 'hidden' ? now === 'hidden' : /meshes:[1-9]/.test(now)) return true;
  }
  return false;
}

/** The far corner of the canvas, and the middle of it. */
const CORNER: readonly [number, number] = [60, 110];
const MIDDLE: readonly [number, number] = [480, 400];

async function settled(page: Page, was: number): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    if ((await propCount(page)) > was) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * One row of the panel, by the folder it is in and the label it shows.
 *
 * The folder is not decoration in this lookup. Row labels are **not unique**
 * across the panel -- the fence's tile size and a building's size are both
 * `Size`, correctly, because neither is ever on screen while the other is --
 * so a search over every `.lil-controller` finds the first one and answers
 * questions about the wrong tool. Asked without the folder, this reported a
 * working panel as a hidden one.
 *
 * lil-gui's classes are `lil-` prefixed in this build, and a **folder is itself
 * a `.lil-gui`** titled by its own `.lil-title` child -- there is no
 * `.lil-folder`. Both are worth restating, because the obvious selectors match
 * nothing at all and a probe that finds no row reports every question about it
 * as a failure rather than as a miss.
 */
async function panelRow(page: Page, folder: string, label: string): Promise<{ value: string; shown: boolean } | null> {
  return page.evaluate(
    ({ inside, wanted }) => {
      for (const group of Array.from(document.querySelectorAll('.lil-gui'))) {
        if (group.querySelector(':scope > .lil-title')?.textContent?.trim() !== inside) continue;
        for (const row of Array.from(group.querySelectorAll('.lil-controller'))) {
          if (row.querySelector('.lil-name')?.textContent?.trim() !== wanted) continue;
          const field = row.querySelector('select') ?? row.querySelector('input');
          const box = row.getBoundingClientRect();
          return { value: field?.value ?? '', shown: box.width > 0 && box.height > 0 };
        }
      }
      return null;
    },
    { inside: folder, wanted: label },
  );
}

/**
 * Drag a lil-gui number to a value.
 *
 * Set through the field rather than by dragging the slider, because what is
 * under test is the tool and not lil-gui: a drag is a pixel-per-unit
 * calculation against a widget whose width depends on the panel, and getting it
 * wrong would report the facing as broken when it is the probe that missed.
 */
async function setNumber(page: Page, folder: string, label: string, value: number): Promise<void> {
  await page.evaluate(
    ({ inside, wanted, to }) => {
      for (const group of Array.from(document.querySelectorAll('.lil-gui'))) {
        if (group.querySelector(':scope > .lil-title')?.textContent?.trim() !== inside) continue;
        for (const row of Array.from(group.querySelectorAll('.lil-controller'))) {
          if (row.querySelector('.lil-name')?.textContent?.trim() !== wanted) continue;
          const input = row.querySelector('input');
          if (!input) return;
          input.value = String(to);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.blur();
          return;
        }
      }
    },
    { inside: folder, wanted: label, to: value },
  );
  await page.waitForTimeout(250);
}

/** The last thing the editor's status line said it did. */
async function placed(page: Page): Promise<string> {
  return /placed (?:house|well)[^A-Z]*/.exec(await readout(page))?.[0]?.trim() ?? 'said nothing';
}

async function openEditor(page: Page): Promise<void> {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.click('button:has-text("Map editor")');
  // `canvas` alone matches the Play tab's too -- it stays in the DOM, hidden,
  // when a tab is switched away from.
  await page.waitForSelector('canvas:visible', { timeout: 60_000 });
  await page.waitForTimeout(3000);
}

/** One press on the ground: a building at whatever size the panel says. */
async function clickGround(page: Page, x: number, y: number): Promise<boolean> {
  const was = await propCount(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  return settled(page, was);
}

/**
 * Press, drag out, release -- and report the size the ghost had reached at the
 * far end, before the button came up.
 *
 * Read *during* the drag rather than after it, because that is the half no
 * saved file can answer: a tool that ignored the drag and sized the building at
 * the release would leave exactly the same document as one that grew it under
 * the cursor the whole way.
 */
async function dragOut(page: Page, x: number, y: number, dx: number, dy: number): Promise<number> {
  const was = await propCount(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(200);
  // In steps, so the page gets pointermove events rather than one teleport --
  // at a few frames a second a single jump can land between two of them.
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  // Long enough for a frame to have drawn the ghost at the far end of the drag,
  // which is the one thing that has to be read while the button is still down.
  await page.waitForTimeout(1200);
  const reached = await ghostScale(page);
  await page.mouse.up();
  await settled(page, was);
  return reached;
}

/** Press Save to file and hand back what the browser downloaded. */
async function save(page: Page): Promise<MapFile> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.click('button:has-text("Save to file")'),
  ]);
  const path = await download.path();
  if (path === null) throw new Error('the download had no file behind it');
  return JSON.parse(readFileSync(path, 'utf8')) as MapFile;
}

/** Every prop in a saved document whose species is a building. */
function structuresIn(doc: MapFile): SavedProp[] {
  const kinds: readonly string[] = STRUCTURE_KINDS;
  return (doc.layers ?? []).flatMap((layer) =>
    (layer.chunks ?? []).flatMap((chunk) => (chunk.props ?? []).filter((p) => kinds.includes(p.species))),
  );
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
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
      const text = message.text();
      if (message.type() === 'error' && !text.includes('[units]') && !text.includes('404')) problems.push(text);
    });

    await openEditor(page);

    const before = structuresIn(await save(page));
    check('the shipped map has no buildings to begin with', before.length === 0, `${before.length} found`);

    // The tool has to be reachable from the mode strip at all: a ninth entry in
    // an array is exactly the kind of thing that typechecks and is wired to
    // nothing.
    await page.getByRole('button', { name: 'structure', exact: true }).click();
    await page.waitForTimeout(400);
    check(
      'arming it shows the buildings panel',
      (await panelRow(page, 'Buildings', 'Facing'))?.shown === true &&
        (await panelRow(page, 'Buildings', 'Size'))?.shown === true,
      'Facing and Size on screen',
    );
    check(
      'and hides the scatter, which has nothing to say about a building',
      (await panelRow(page, 'Scatter', 'Per second'))?.shown !== true,
      'Per second hidden',
    );

    // Two huts at different facings, so the one thing a slider could get wrong
    // -- turning the prop and not the panel, or the other way about -- shows up
    // in the file rather than only on screen.
    check('a press puts a building down', await clickGround(page, 400, 330), await placed(page));
    check('and says what it placed', /placed house facing 0/.test(await readout(page)), await placed(page));

    await setNumber(page, 'Buildings', 'Facing', 90);
    check(
      'the facing takes the value it was set to',
      (await panelRow(page, 'Buildings', 'Facing'))?.value === '90',
      'Facing = 90',
    );
    check('a second press lands too', await clickGround(page, 760, 300), await placed(page));
    check('and says the facing it placed at', /placed house facing 90/.test(await readout(page)), await placed(page));

    await page.getByRole('button', { name: 'well', exact: true }).click();
    await page.waitForTimeout(300);
    // Well clear of both huts: the first cut put the well where the second
    // hut's roof came down over it, and a prop hidden behind another prop is a
    // screenshot that says nothing about either.
    check('the well places too', await clickGround(page, 560, 560), await placed(page));
    check('and says so', /placed well/.test(await readout(page)), await placed(page));

    // --- the preview (spec 223) --------------------------------------------
    await page.mouse.move(430, 520);
    await page.waitForTimeout(500);
    check(
      'the ghost stands under the cursor before anything is pressed',
      /^well meshes:[1-9]/.test(await ghost(page)),
      await ghost(page),
    );
    await page.getByRole('button', { name: 'house', exact: true }).click();
    await page.waitForTimeout(400);
    await page.mouse.move(440, 525);
    await page.waitForTimeout(500);
    check('switching kind switches what is previewed', /^house meshes:[1-9]/.test(await ghost(page)), await ghost(page));

    // The preview going away *is* the refusal, seen before the click rather than
    // as a status line after it. Staged by zooming out past what the editor has
    // meshed: `scene.pick` finds nothing, which is exactly the case spec 212
    // says a tool must go on refusing rather than act on at the flat plane's
    // height. Checked as a **round trip** -- gone, then back -- because "the
    // ghost is hidden" on its own is also what a broken ghost looks like.
    const span = /span (\d+)/.exec(await readout(page))?.[1] ?? '?';
    await zoom(page, 6, 400);
    check(
      'the preview goes away where there is no ground under the cursor',
      await ghostBecomes(page, 'hidden', CORNER),
      `span ${span} -> ${/span (\d+)/.exec(await readout(page))?.[1] ?? '?'}: ${await ghost(page)}`,
    );
    await zoom(page, 6, -400);
    check('and comes back when there is', await ghostBecomes(page, 'drawn', MIDDLE), await ghost(page));

    await page.getByRole('button', { name: 'marker', exact: true }).click();
    await page.waitForTimeout(400);
    await page.mouse.move(440, 525);
    await page.waitForTimeout(500);
    check('and away entirely when the tool is not armed', (await ghost(page)) === 'hidden', await ghost(page));
    await page.getByRole('button', { name: 'structure', exact: true }).click();
    await page.waitForTimeout(400);

    // --- the drag (spec 223) ------------------------------------------------
    const sizeBefore = Number((await panelRow(page, 'Buildings', 'Size'))?.value ?? Number.NaN);
    const reached = await dragOut(page, 300, 560, 150, 40);
    check(
      'dragging out grows the preview past the size the panel was set to',
      Number.isFinite(reached) && reached > sizeBefore,
      `${sizeBefore} -> ${reached.toFixed(2)} mid-drag`,
    );
    const sizeAfter = Number((await panelRow(page, 'Buildings', 'Size'))?.value ?? Number.NaN);
    const shown = (await panelRow(page, 'Buildings', 'Size'))?.value ?? '';
    check(
      'and the panel is told, so the next building is the size of the last',
      Math.abs(sizeAfter - reached) < 1e-9,
      `Size = ${shown}`,
    );
    check(
      'as a number somebody could also have set the slider to',
      /^\d+(\.\d{1,2})?$/.test(shown),
      shown,
    );

    await page.screenshot({ path: join(outDir, 'editor-structures.png') });

    // The file is the deliverable. Everything above could be true of an editor
    // that draws buildings and saves none of them.
    const after = structuresIn(await save(page));
    const houses = after.filter((p) => p.species === 'house');
    const wells = after.filter((p) => p.species === 'well');
    check(
      'the saved map has every hut and the well',
      houses.length === 3 && wells.length === 1,
      `${houses.length} houses, ${wells.length} wells`,
    );
    const dragged = houses.filter((h) => Math.abs((h.scale ?? 1) - reached) < 0.06);
    check(
      'the dragged hut was saved at the size the drag reached',
      dragged.length === 1,
      `${dragged.length} at ${reached.toFixed(2)}x of ${houses.map((h) => (h.scale ?? 1).toFixed(2)).join(', ')}`,
    );

    const turned = houses.filter((h) => Math.abs((h.rotation ?? 0) - Math.PI / 2) < 0.01);
    const square = houses.filter((h) => Math.abs(h.rotation ?? 0) < 0.01);
    check(
      'each hut was saved at the facing it was placed at',
      turned.length === 2 && square.length === 1,
      `${square.length} at 0, ${turned.length} at 90 degrees`,
    );
    const spread = houses.flatMap((a, i) =>
      houses.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.z - b.z)),
    );
    check(
      'the buildings landed apart, where they were pressed',
      spread.length > 0 && Math.min(...spread) > 50,
      `closest pair ${Math.round(Math.min(...spread))} units`,
    );

    check('the page logged no errors', problems.length === 0, problems.slice(0, 3).join(' | '));
    await page.close();
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  console.log(`\nwrote ${join(outDir, 'editor-structures.png')}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('all checks passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
