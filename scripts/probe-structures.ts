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
 * ground three times, and checks the *file that came out*. The file is the
 * deliverable -- a building the editor draws and does not save is exactly the
 * bug spec 176 turned out to be.
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

/** One press on the ground, which is the whole of placing a building. */
async function clickGround(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(500);
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
    await clickGround(page, 400, 330);
    check('a press says what it placed', /placed house facing 0/.test(await readout(page)), await placed(page));

    await setNumber(page, 'Buildings', 'Facing', 90);
    check(
      'the facing takes the value it was set to',
      (await panelRow(page, 'Buildings', 'Facing'))?.value === '90',
      'Facing = 90',
    );
    await clickGround(page, 760, 300);
    check('and says the facing it placed at', /placed house facing 90/.test(await readout(page)), await placed(page));

    await page.getByRole('button', { name: 'well', exact: true }).click();
    await page.waitForTimeout(300);
    // Well clear of both huts: the first cut put the well where the second
    // hut's roof came down over it, and a prop hidden behind another prop is a
    // screenshot that says nothing about either.
    await clickGround(page, 560, 560);
    check('the well places too', /placed well/.test(await readout(page)), await placed(page));

    await page.screenshot({ path: join(outDir, 'editor-structures.png') });

    // The file is the deliverable. Everything above could be true of an editor
    // that draws buildings and saves none of them.
    const after = structuresIn(await save(page));
    const houses = after.filter((p) => p.species === 'house');
    const wells = after.filter((p) => p.species === 'well');
    check('the saved map has both huts and the well', houses.length === 2 && wells.length === 1, `${houses.length} houses, ${wells.length} wells`);

    const turned = houses.filter((h) => Math.abs((h.rotation ?? 0) - Math.PI / 2) < 0.01);
    const square = houses.filter((h) => Math.abs(h.rotation ?? 0) < 0.01);
    check(
      'each hut was saved at the facing it was placed at',
      turned.length === 1 && square.length === 1,
      `${square.length} at 0, ${turned.length} at 90 degrees`,
    );
    check(
      'the buildings landed apart, where they were pressed',
      houses.length === 2 && Math.hypot((houses[0]?.x ?? 0) - (houses[1]?.x ?? 0), (houses[0]?.z ?? 0) - (houses[1]?.z ?? 0)) > 50,
      'not stacked',
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
