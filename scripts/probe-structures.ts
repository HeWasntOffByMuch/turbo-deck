/**
 * Place a hut and a well in the Map editor, and read them back out of the saved
 * file (spec 224).
 *
 * The half no headless test can reach, and the failure it exists to catch is
 * the one this repo keeps finding: every rule about a structure is green in Node
 * -- the store takes one, `serializeMap` writes it, the field builds its
 * geometry, `placeStructure` refuses the right things -- and all of that can be
 * true beside a `view.ts` that calls none of it. One more entry in a mode array
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
import { PLACED_KINDS, STRUCTURE_KINDS } from '../src/terrain/vegetation.js';
import { STRUCTURE_SCALE_STEP } from '../src/render/iso3d/editor/structure.js';

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
  /** What a sign says (spec 260). Absent on every other kind. */
  readonly text?: string;
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

/**
 * The editor's own readout block, which is the element carrying `data-ghost`.
 *
 * The *element* rather than the whole body, because the page has no line breaks
 * in its text content: read off `body`, every detail line printed by this probe
 * ran straight from the status into the tab strip and the entire settings
 * panel, which turns a failure nobody can read into a failure nobody can act
 * on. It changes no check -- every number this parses was always in this block.
 */
const readout = async (page: Page): Promise<string> => {
  const text = await page.evaluate(() => {
    const node = document.querySelector<HTMLElement>('[data-ghost]');
    return node?.textContent ?? null;
  });
  return text ?? (await page.textContent('body')) ?? '';
};

/**
 * What the ghost has on the scene graph, off `data-ghost` (spec 225).
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
 * under software GL, and a building now lands on the *release* (spec 225) --
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

/**
 * What the sign is placed saying (spec 260).
 *
 * Distinctive, and short enough that the editor's status line quotes it whole:
 * that line cuts at 40 characters, so a message longer than one would be
 * reported as a mismatch by a probe rather than by the feature.
 */
const SIGN_MESSAGE = 'Beware the bridge';

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

/**
 * Type into a panel row's text field. {@link setNumber}, for a string.
 *
 * Its own function rather than a widened `setNumber` because the two dispatch
 * differently in lil-gui's own handling and a number coerced out of a string is
 * exactly the sort of thing that would pass here and place a sign saying `NaN`.
 */
async function setText(page: Page, folder: string, label: string, value: string): Promise<void> {
  await page.evaluate(
    ({ inside, wanted, to }) => {
      for (const group of Array.from(document.querySelectorAll('.lil-gui'))) {
        if (group.querySelector(':scope > .lil-title')?.textContent?.trim() !== inside) continue;
        for (const row of Array.from(group.querySelectorAll('.lil-controller'))) {
          if (row.querySelector('.lil-name')?.textContent?.trim() !== wanted) continue;
          const input = row.querySelector('input');
          if (!input) return;
          input.value = to;
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

/**
 * Which kinds the status line can be reporting a placement of.
 *
 * **Derived, never typed.** It was a hand-written `house|well|sign`, and spec
 * 263's grave was the fourth kind and the first one to show what that costs: a
 * grave really was placed, the assertion above really did pass, and every check
 * about it printed `said nothing` as its evidence -- which is exactly what a
 * grave that was *not* placed would have printed. A detail line that reads the
 * same whether the thing worked or not is worse than none, because it is read as
 * evidence. `PLACED_KINDS` rather than `STRUCTURE_KINDS`, since a fixture prints
 * through this same line.
 */
const PLACED_PATTERN = new RegExp(`placed (?:${PLACED_KINDS.join('|')})[^]*$`);

/** The last thing the editor's status line said it did. */
async function placed(page: Page): Promise<string> {
  return PLACED_PATTERN.exec(await readout(page))?.[0]?.trim() ?? 'said nothing';
}

/** Whatever the status line is saying, which is the tail after the undo count. */
async function status(page: Page): Promise<string> {
  return /\d+ undo(?: \u00b7 ([^]*))?$/.exec(await readout(page))?.[1]?.trim() ?? '(nothing)';
}

/**
 * Wait for the status line to say something, and answer whether it did.
 *
 * A **poll**, which is the rule spec 250 extended to every read in
 * `probe-map-editor.ts` after two consecutive runs failed on different checks:
 * the status is published from the frame and this environment paints the editor
 * at about five frames a second under software GL, so anything read a fixed
 * moment after a click is read before the click was processed.
 *
 * It matters more for a *refusal* than for a placement, and that is why this
 * exists rather than `clickGround`: that helper waits for the prop count to
 * change, which a refusal never does, so it spends its whole timeout -- long
 * enough for the autosave to land and write its own message over the refusal.
 */
async function statusUntil(page: Page, wanted: RegExp, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (wanted.test(await readout(page))) return true;
    await page.waitForTimeout(120);
  }
  return false;
}

async function openEditor(page: Page): Promise<void> {
  // The built page is the game client since spec 254 and builds no tab strip at
  // all; this harness drives the Map editor tab, so it asks the workbench back.
  await page.goto(`http://localhost:${PORT}/?client=workbench`, { waitUntil: 'load' });
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
/**
 * What one saved prop is, as a string.
 *
 * So the probe can tell the buildings it pressed from the ones the map already
 * had. Coordinates are quantized on the way into the document, so two saves of
 * an untouched prop give the same key exactly rather than nearly.
 */
function propKey(p: SavedProp): string {
  return `${p.species}|${String(p.x)}|${String(p.z)}|${String(p.rotation ?? 0)}|${String(p.scale ?? 1)}`;
}

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

    // What the map already holds, so every count below is of what this probe
    // *added*.
    //
    // This used to assert the map had none, which was true when the arena was
    // empty ground and stopped being true the moment spec 247 gave the
    // shopkeepers a village to stand in -- three huts and a well, none of them
    // anything to do with this probe, and four checks failing to say so.
    const before = structuresIn(await save(page));
    const existing = new Set(before.map(propKey));
    console.log(`  --   the map already holds ${String(before.length)} building(s); counting from there`);

    // The tool has to be reachable from the mode strip at all: one more entry in
    // an array is exactly the kind of thing that typechecks and is wired to
    // nothing.
    await page.getByRole('button', { name: 'structure', exact: true }).click();
    await page.waitForTimeout(400);
    check(
      'arming it shows the buildings panel',
      (await panelRow(page, 'Structures', 'Facing'))?.shown === true &&
        (await panelRow(page, 'Structures', 'Size'))?.shown === true,
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

    await setNumber(page, 'Structures', 'Facing', 90);
    check(
      'the facing takes the value it was set to',
      (await panelRow(page, 'Structures', 'Facing'))?.value === '90',
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

    // --- the sign, and its message (spec 260) -------------------------------
    //
    // The one placed kind with a field of its own, so the one whose panel row
    // can be shown for the wrong kind or read by nothing at all -- and neither
    // failure is visible in a screenshot, because a sign placed with an empty
    // message looks exactly like one placed with the right message.
    await page.getByRole('button', { name: 'sign', exact: true }).click();
    await page.waitForTimeout(400);
    check(
      'arming a sign shows its message row',
      (await panelRow(page, 'Structures', 'Message'))?.shown === true,
      'Message on screen',
    );
    // Pressed directly rather than through `clickGround`: that helper waits for
    // the prop count to move, and the whole claim here is that it does not.
    const propsBefore = await propCount(page);
    await page.mouse.move(300, 560);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.up();
    const refused = await statusUntil(page, /a sign needs a message/);
    check('and a blank one is refused rather than placed', refused, await status(page));
    check(
      'and nothing was put down when it was refused',
      (await propCount(page)) === propsBefore,
      `${propsBefore} -> ${await propCount(page)} props`,
    );
    await setText(page, 'Structures', 'Message', SIGN_MESSAGE);
    check('a sign with something on it places', await clickGround(page, 300, 560), await placed(page));
    // Quoted in the status line, for the reason a fixture's brightness is: a
    // board with the wrong words on it looks identical to one with the right
    // words on it until somebody walks up to it.
    check(
      'and the editor says what it placed it saying',
      (await readout(page)).includes(SIGN_MESSAGE),
      await placed(page),
    );
    // --- the grave (spec 263) ----------------------------------------------
    //
    // The kind with nothing of its own -- no message, no brightness, no reach --
    // which is exactly why it is worth a step here: everything that makes it
    // placeable is *derived* (`STRUCTURE_KINDS` composes `PLACED_KINDS`, which
    // the panel's strip is built from), so the whole feature is a button nobody
    // wrote and geometry nobody dispatched to. Both of those fail silently.
    await page.getByRole('button', { name: 'grave', exact: true }).click();
    await page.waitForTimeout(400);
    check(
      'arming a grave shows no message row, having nothing to say',
      (await panelRow(page, 'Structures', 'Message'))?.shown !== true,
      'Message hidden',
    );
    await setNumber(page, 'Structures', 'Facing', 180);
    check('a grave places', await clickGround(page, 640, 440), await placed(page));
    check('and says so, at the facing it was turned to', /placed grave facing 180/.test(await readout(page)), await placed(page));
    await setNumber(page, 'Structures', 'Facing', 90);

    await page.getByRole('button', { name: 'well', exact: true }).click();
    await page.waitForTimeout(300);
    check(
      'and the message row goes away for a kind that cannot read one',
      (await panelRow(page, 'Structures', 'Message'))?.shown !== true,
      'Message hidden',
    );
    // And the well stays armed, because the ghost check below is written
    // against it -- this block sits between the two on purpose, so a sign is
    // placed in the same session as the buildings rather than in one of its
    // own, but it may not change what the next check finds armed.

    // --- the preview (spec 225) --------------------------------------------
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

    // --- the drag (spec 225) ------------------------------------------------
    const sizeBefore = Number((await panelRow(page, 'Structures', 'Size'))?.value ?? Number.NaN);
    const reached = await dragOut(page, 300, 560, 150, 40);
    check(
      'dragging out grows the preview past the size the panel was set to',
      Number.isFinite(reached) && reached > sizeBefore,
      `${sizeBefore} -> ${reached.toFixed(2)} mid-drag`,
    );
    const sizeAfter = Number((await panelRow(page, 'Structures', 'Size'))?.value ?? Number.NaN);
    const shown = (await panelRow(page, 'Structures', 'Size'))?.value ?? '';
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
    const after = structuresIn(await save(page)).filter((p) => !existing.has(propKey(p)));
    const houses = after.filter((p) => p.species === 'house');
    const wells = after.filter((p) => p.species === 'well');
    check(
      'the saved map has every hut and the well this probe put down',
      houses.length === 3 && wells.length === 1,
      `${houses.length} houses, ${wells.length} wells`,
    );
    // Half a step, **derived rather than typed**: a size is snapped to
    // `STRUCTURE_SCALE_STEP`, so any two distinct sizes are one step apart and a
    // tolerance wider than one cannot tell them apart. It was 0.06 against a
    // step of 0.05, so a drag that reached exactly one step above the default
    // matched all three huts and reported the feature working as broken.
    const sizeSlack = STRUCTURE_SCALE_STEP / 2;
    const dragged = houses.filter((h) => Math.abs((h.scale ?? 1) - reached) < sizeSlack);
    check(
      'the dragged hut was saved at the size the drag reached',
      dragged.length === 1,
      `${dragged.length} at ${reached.toFixed(2)}x of ${houses.map((h) => (h.scale ?? 1).toFixed(2)).join(', ')}`,
    );

    // The sign, and its message: the file is where "the panel row is wired to
    // the tool" is finally answered (spec 260). A `Message` row that changed
    // nothing draws exactly the same board.
    const signs = after.filter((p) => p.species === 'sign');
    check(
      'the saved map has the one sign this probe put down',
      signs.length === 1,
      `${signs.length} signs`,
    );
    check(
      'and it carries the message that was typed into the panel',
      signs[0]?.text === SIGN_MESSAGE,
      `text = ${JSON.stringify(signs[0]?.text ?? null)}`,
    );
    check(
      'and nothing else in the map gained one',
      after.every((p) => p.species === 'sign' || p.text === undefined),
      after.filter((p) => p.species !== 'sign' && p.text !== undefined).map((p) => p.species).join(', ') || 'none',
    );

    // The grave: the file is where "a kind that is only a row in a list is
    // really placeable" is answered (spec 263). Nothing about it is
    // special-cased anywhere, so the way it fails is by not being there at all.
    const graves = after.filter((p) => p.species === 'grave');
    check(
      'the saved map has the one grave this probe put down',
      graves.length === 1,
      `${graves.length} graves`,
    );
    check(
      'and it was saved at the facing it was placed at',
      Math.abs((graves[0]?.rotation ?? 0) - Math.PI) < 0.01,
      `rotation = ${(graves[0]?.rotation ?? 0).toFixed(3)}`,
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
