/**
 * Place a marker in the Map editor and read it back out of the saved file (spec 176).
 *
 * The half no headless test can reach. Everything about saving a marker is
 * asserted in Node -- the store round-trips them, `serializeMap` writes them,
 * `openEditorMap` opens the document the server boots from -- and for eighty
 * specs all of it was true beside an editor that opened a world generated from
 * the clock, so nothing placed in it had anywhere to arrive. What was missing
 * was not a rule; it was whether view.ts called any of them.
 *
 * So this drives the shipped build: it opens the tab, reads which map the
 * readout says it is editing, places a spawner, saves, and opens the download.
 * Every check is against the *file that came out*, because that file is the
 * whole deliverable -- a marker the editor draws and does not save is the bug
 * this exists to catch.
 *
 * Spec 177 adds the other end of the same loop. A download is not a saved map:
 * it is the first of four steps -- save, find it in ~/Downloads, copy it over
 * `maps/arena.json`, restart the server -- and missing one looks exactly like
 * the editor having failed to save. So the run happens twice: once over `dist/`,
 * where there is no dev server and the editor must *say so* rather than
 * pretending, and once over `npx vite`, where the button has to actually change
 * the file on disk. The second half backs the map up and puts it back.
 *
 *   npm run build && npx tsx scripts/probe-map-editor.ts
 *
 * Serves `dist/` rather than the dev server for the first half, so what is
 * measured is what ships. Exits non-zero if a step did not do what it claims.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { joinMap, MANIFEST_PATH, parseManifest } from '../src/terrain/regions.js';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { STEM_HEIGHT } from '../src/render/iso3d/editor/marker-view.js';
import { SELECT_PICK_RADIUS } from '../src/render/iso3d/editor/tools.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4327;
/** The dev server, for the half that writes the file. A second port, not a second run. */
const DEV_PORT = 4328;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** The map the server boots from -- what the editor is supposed to be editing. */
const SHIPPED_MAP_DIR = join(root, 'maps', 'arena');

/**
 * The whole shipped world as one string, for comparing before against after.
 *
 * The map is a manifest and a grid of regions since spec 204, so "did the file
 * change" became "did any of 225 files change". The manifest carries a hash of
 * ordered region hashes, which is exactly that question already answered -- so
 * the identity is what this compares, and the joined document is what it counts
 * markers in.
 */
function shippedMapNow(): { mapId: string; doc: MapFile } {
  const manifest = parseManifest(readFileSync(join(SHIPPED_MAP_DIR, MANIFEST_PATH), 'utf8'));
  const doc = joinMap(manifest, (region) => readFileSync(join(SHIPPED_MAP_DIR, region), 'utf8'));
  return { mapId: manifest.mapId, doc: doc as unknown as MapFile };
}

interface Marker {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  readonly spawner?: { readonly respawnSeconds?: number; readonly leashRadius?: number };
}

interface MapFile {
  readonly layers: readonly { readonly chunks: readonly { readonly markers?: readonly Marker[] }[] }[];
}

const markersIn = (doc: MapFile): readonly Marker[] =>
  doc.layers.flatMap((l) => l.chunks).flatMap((c) => c.markers ?? []);

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
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${url} never came up`);
}

/**
 * The editor's readout, which is where the map's own numbers are reported.
 *
 * By shape rather than by selector, like `preview-parts.ts`: the readout is one
 * block, and what is wanted out of it is the marker count and the map's name.
 */
async function readout(page: Page): Promise<string> {
  return (await page.textContent('body')) ?? '';
}

/** Which marker kind the strip shows as armed: the filled button (bold). */
async function armedMarkerKind(page: Page): Promise<string> {
  return page.evaluate(() => {
    const kinds = ['spawn', 'objective', 'campfire', 'trigger', 'monster'];
    for (const button of Array.from(document.querySelectorAll('button'))) {
      const text = (button.textContent ?? '').trim();
      if (kinds.includes(text) && button.style.fontWeight === '700') return text;
    }
    return '(none armed)';
  });
}

/**
 * One row of the panel, by the label it shows.
 *
 * lil-gui's classes are `lil-` prefixed in this build (`lil-controller`,
 * `lil-name`), which is worth stating because the obvious selectors match
 * nothing at all and a probe that finds no row reports every question about it
 * as a failure.
 */
async function panelRow(page: Page, label: string): Promise<{ value: string; enabled: boolean } | null> {
  return page.evaluate((wanted) => {
    for (const row of Array.from(document.querySelectorAll('.lil-controller'))) {
      if (row.querySelector('.lil-name')?.textContent?.trim() !== wanted) continue;
      // Only rows on screen. Since spec 222 the panel holds two rows called
      // `Monster` -- the marker tool's and the select tool's -- and only one of
      // them is ever shown, because `applyVisibility` hides the folder that is
      // not the armed mode's. A hidden row is not a row anybody can use, so
      // skipping it is both what disambiguates these two and what this function
      // should have been doing all along.
      if (row.getClientRects().length === 0) continue;
      const select = row.querySelector('select');
      const input = row.querySelector('input');
      const field = select ?? input;
      return {
        value: field?.value ?? '',
        // A lil-gui row that is disabled says so on the row *and* on the field;
        // either is enough to answer "can this be used".
        enabled: field !== null && !field.disabled && !row.classList.contains('lil-disabled'),
      };
    }
    return null;
  }, label);
}

/** Whether the Monster dropdown is live. */
async function monsterEnabled(page: Page): Promise<boolean> {
  return (await panelRow(page, 'Monster'))?.enabled ?? false;
}

/** What the panel says the armed marker kind does. A text row, so not in the page's text. */
async function markerEffect(page: Page): Promise<string> {
  return (await panelRow(page, 'Does'))?.value ?? '(no row)';
}

/**
 * What the editor says the selected marker *is*, out of the document (spec 222).
 *
 * `data-selected` rather than the panel's own fields, and read off the store
 * rather than off the settings at the point it is published -- so a panel that
 * believes it edited something and wrote nothing reads here as unedited.
 */
async function selectedMarker(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector('[data-selected]')?.getAttribute('data-selected') ?? '(no readout)',
  );
}

/**
 * Poll `data-selected` until it matches, and hand back what it finally said.
 *
 * A *poll*, not a wait, and that is not tidiness. This environment paints the
 * page at about five frames a second under software GL, and `data-selected` is
 * published from the frame -- so a fixed few hundred milliseconds is less than
 * one frame, and every check about an edit reads the state from before the click
 * that caused it. Its first cut did exactly that and reported three working
 * edits as failures, each with the right answer in its own detail line, because
 * the detail was read a moment later than the assertion.
 */
async function waitForSelected(page: Page, want: RegExp, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await selectedMarker(page);
    if (want.test(last)) return last;
    await page.waitForTimeout(200);
  }
  return last;
}

/** The camera's own numbers, so a click can be aimed in world units. */
async function camera(page: Page): Promise<{ span: number; pitchDeg: number; width: number }> {
  const text = await readout(page);
  const span = Number(/span (\d+)/.exec(text)?.[1] ?? 0);
  const pitchDeg = Number(/pitch (\d+)/.exec(text)?.[1] ?? 0);
  const width = await page.evaluate(() => document.querySelector('canvas')?.clientWidth ?? 0);
  return { span, pitchDeg, width };
}

/** Set a lil-gui number row by the label it shows, and let the panel commit it. */
async function setPanelNumber(page: Page, label: string, value: number): Promise<void> {
  await page.evaluate(
    ({ wanted, next }) => {
      for (const row of Array.from(document.querySelectorAll('.lil-controller'))) {
        if (row.querySelector('.lil-name')?.textContent?.trim() !== wanted) continue;
        if (row.getClientRects().length === 0) continue;
        const input = row.querySelector('input');
        if (!input) return;
        input.value = String(next);
        // lil-gui's number controller commits on `input`, so this is the event a
        // person typing would produce rather than a synthetic shortcut.
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    },
    { wanted: label, next: value },
  );
}

/** Choose an option in a lil-gui dropdown by the label its row shows. */
async function setPanelOption(page: Page, label: string, value: string): Promise<void> {
  await page.evaluate(
    ({ wanted, next }) => {
      for (const row of Array.from(document.querySelectorAll('.lil-controller'))) {
        if (row.querySelector('.lil-name')?.textContent?.trim() !== wanted) continue;
        if (row.getClientRects().length === 0) continue;
        const select = row.querySelector('select');
        if (!select) return;
        select.value = next;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    },
    { wanted: label, next: value },
  );
}

const markerCount = async (page: Page): Promise<number> =>
  Number(/(\d+) markers/.exec(await readout(page))?.[1] ?? -1);

async function openEditor(page: Page, query: string, port = PORT): Promise<void> {
  await page.goto(`http://localhost:${port}/${query}`, { waitUntil: 'load' });
  await page.click('button:has-text("Map editor")');
  // `canvas` alone matches the Play tab's too -- it stays in the DOM, hidden,
  // when a tab is switched away from.
  await page.waitForSelector('canvas:visible', { timeout: 60_000 });
  await page.waitForTimeout(3000);
}

/** Click once on the ground, which is the whole of placing a marker. */
async function clickGround(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/**
 * Press and *hold* on the ground, for a tool that works on the drag.
 *
 * `clickGround` is a press and a release 150ms apart, which is all a marker
 * placement needs -- that happens on the press edge, and an edge survives until
 * a frame consumes it. The eraser runs inside `input.isPainting`, so it needs a
 * frame drawn *while the button is down*, and this environment paints at about
 * five frames a second: a 150ms hold is less than one frame, and the eraser
 * genuinely never runs.
 */
async function holdGround(page: Page, x: number, y: number, ms = 1500): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.waitForTimeout(600);
}

/** Press the write button and hand back what the status line then says. */
async function saveToDisk(page: Page): Promise<string> {
  await page.click('button:has-text("Save to maps/")');
  // The write is a round trip over a three-megabyte body, and the browser
  // serialises the document on the main thread before it can even send it --
  // which under software GL takes seconds, not milliseconds. Waited out
  // generously: a short poll here reports a working save as a silent one.
  for (let i = 0; i < 240; i++) {
    await page.waitForTimeout(250);
    const said = /(wrote maps[^&<]*|no dev server here[^&<]*|could not reach[^&<]*|not a map document[^&<]*|is not a bare filename[^&<]*)/.exec(
      await readout(page),
    )?.[1];
    if (said !== undefined) return said.trim();
  }
  return '(the status line never said anything)';
}

/** Press Save to file and hand back what the browser downloaded. */
async function save(page: Page): Promise<{ name: string; doc: MapFile }> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.click('button:has-text("Save to file")'),
  ]);
  const path = await download.path();
  if (path === null) throw new Error('the download had no file behind it');
  return { name: download.suggestedFilename(), doc: JSON.parse(readFileSync(path, 'utf8')) as MapFile };
}

/**
 * The half that closes the loop: `npx vite`, the write button, the real file.
 *
 * Backs the map up first and puts it back in a `finally`, because the whole
 * point of the feature under test is that the button changes the map the server
 * boots from -- there is no way to check that without changing it.
 */
async function devHalf(browser: Browser, problems: string[]): Promise<void> {
  // A whole directory now, so the backup is a copy of the tree rather than of
  // one file (spec 204).
  const backup = `${SHIPPED_MAP_DIR}.probe-backup`;
  rmSync(backup, { recursive: true, force: true });
  cpSync(SHIPPED_MAP_DIR, backup, { recursive: true });
  const before = shippedMapNow();
  // `node_modules/.bin/vite` rather than `npx vite`, and in its own process
  // group: `npx` is a wrapper, and a SIGTERM to it leaves the grandchild
  // holding the port -- the same trap `probe-admin-console.ts` documents, and
  // the reason a second run of this probe used to find 4328 already taken.
  const dev = spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(DEV_PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    detached: true,
  });
  try {
    await waitForServer(`http://localhost:${DEV_PORT}/`, 60_000);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (error) => problems.push(String(error)));
    await openEditor(page, '', DEV_PORT);

    const shipped = markersIn(before.doc);
    await page.getByRole('button', { name: 'marker', exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'campfire', exact: true }).click();
    await page.waitForTimeout(300);
    await clickGround(page, 600, 420);
    check(
      'the editor says the edit is not on disk yet',
      /not in maps\//.test(await readout(page)),
      /(\d+ edits? not in maps\/)/.exec(await readout(page))?.[1] ?? 'said nothing',
    );

    const said = await saveToDisk(page);
    check('the write button reports what it wrote', /wrote maps/.test(said), said);

    const after = shippedMapNow();
    check(
      'maps/arena/ actually changed on disk',
      after.mapId !== before.mapId,
      `mapId ${before.mapId} -> ${after.mapId}`,
    );
    const now = markersIn(after.doc);
    check(
      'the file on disk has the placed marker, and everything that was there',
      now.length === shipped.length + 1 && shipped.every((m) => now.some((s) => s.id === m.id)),
      `${shipped.length} -> ${now.length} markers`,
    );
    check(
      'the editor stops saying there are edits off disk',
      !/not in maps\//.test(await readout(page)),
      /(\d+ edits? not in maps\/)/.exec(await readout(page))?.[1] ?? 'clean',
    );
    await page.close();
  } finally {
    rmSync(SHIPPED_MAP_DIR, { recursive: true, force: true });
    cpSync(backup, SHIPPED_MAP_DIR, { recursive: true });
    rmSync(backup, { recursive: true, force: true });
    // The whole group, so nothing is left listening on DEV_PORT.
    if (dev.pid !== undefined) {
      try {
        process.kill(-dev.pid, 'SIGTERM');
      } catch {
        dev.kill('SIGTERM');
      }
    }
  }
}

async function main(): Promise<void> {
  const shipped = markersIn(shippedMapNow().doc);
  console.log(`maps/arena/ holds ${shipped.length} markers`);

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
      // Two expected ones: the unit importer warns about root motion on every
      // load, and the built page's write endpoint is *meant* to 404 -- that is
      // the check two blocks below, not a fault.
      const text = message.text();
      const expected = text.includes('[units]') || text.includes('404');
      if (message.type() === 'error' && !expected) problems.push(text);
    });

    // Nothing in the query string: this is what somebody opening the tab gets.
    await openEditor(page, '');

    const opened = await readout(page);
    check('the readout names the map being edited', /editing/i.test(opened) || opened.includes('arena.json'), 'arena.json');
    const before = await markerCount(page);
    check(
      'the editor opened the map the game plays',
      before === shipped.length,
      `${before} markers on screen, ${shipped.length} in maps/arena/`,
    );

    // Arm the marker tool. The monster kind is the default now, so this is what
    // somebody gets without choosing anything (spec 178).
    await page.getByRole('button', { name: 'marker', exact: true }).click();
    await page.waitForTimeout(400);
    check(
      'the monster kind is armed without anybody choosing it',
      await armedMarkerKind(page) === 'monster',
      await armedMarkerKind(page),
    );
    check('the monster dropdown is live for it', await monsterEnabled(page), 'enabled');
    const effect = await markerEffect(page);
    check('the panel says what the armed kind does', /spawns the monster below/.test(effect), effect);

    // The kind that caused this: `spawn` is two letters away and read by
    // nothing, and the dropdown must go dead rather than look like its own.
    await page.getByRole('button', { name: 'spawn', exact: true }).click();
    await page.waitForTimeout(400);
    check(
      'the monster dropdown goes dead for a kind that does not spawn one',
      !(await monsterEnabled(page)),
      'disabled',
    );
    const inertEffect = await markerEffect(page);
    check(
      'and the panel says that kind is read by nothing',
      /nothing reads it yet/.test(inertEffect),
      inertEffect,
    );

    await page.getByRole('button', { name: 'monster', exact: true }).click();
    await page.waitForTimeout(400);
    await clickGround(page, 540, 400);

    const placed = await markerCount(page);
    check('placing one adds it to the map', placed === before + 1, `${before} -> ${placed}`);
    const said = /placed (spawner-\d+: \w+|spawn-\d+)/.exec(await readout(page))?.[1] ?? '';
    check('the editor names what it just placed, with its monster', /^spawner-\d+: \w+$/.test(said), said || 'said nothing');

    // The picture, once, and of the shipped map: the billboards on screen are
    // the arena's own spawners, which is the change in one frame.
    await mkdir(outDir, { recursive: true });
    await page.screenshot({ path: join(outDir, 'editor-shipped-map.png') });

    const saved = await save(page);
    check(
      'the save comes back as the file it was opened from',
      saved.name === 'arena.json',
      saved.name,
    );

    const inFile = markersIn(saved.doc);
    check(
      'the saved file carries every marker that was already there',
      shipped.every((m) => inFile.some((s) => s.id === m.id && s.kind === m.kind && s.label === m.label)),
      `${inFile.length} in the file`,
    );
    check(
      'the saved file carries the one just placed',
      inFile.length === shipped.length + 1,
      inFile
        .filter((m) => !shipped.some((s) => s.id === m.id))
        .map((m) => `${m.kind} ${m.id}${m.label ? ` (${m.label})` : ''}`)
        .join(', ') || 'nothing new',
    );

    // --- selecting one and editing it (spec 222) ---------------------------
    //
    // Every rule about the select tool is asserted in Node -- which marker a
    // click names, what a patch does to a kind that cannot read a spawner's
    // numbers, that the two halves of the panel are inverses -- and none of them
    // can say whether the frame loop calls any of it. This is that question, on
    // the marker that was just placed.
    await page.getByRole('button', { name: 'select', exact: true }).click();
    await page.waitForTimeout(400);
    const openedWith = await selectedMarker(page);
    check('nothing is selected before anything is clicked', openedWith === 'none', openedWith);

    // Aimed at the **disc**, not at the ground under it, which is the decision
    // the whole tool turns on. The disc floats STEM_HEIGHT above the marker, so
    // its screen position is that height projected -- and the ground under that
    // pixel is `STEM_HEIGHT / tan(pitch)` away from the marker, which is checked
    // here rather than assumed. If that distance is beyond SELECT_PICK_RADIUS
    // then a selection from this click cannot have come from the ground
    // fallback, so this measures the billboard raycast and nothing else.
    const cam = await camera(page);
    const pitch = (cam.pitchDeg * Math.PI) / 180;
    const unitsPerPixel = cam.span / (cam.width / 2);
    const discPixelsUp = (STEM_HEIGHT * Math.cos(pitch)) / unitsPerPixel;
    const groundUnderDisc = STEM_HEIGHT / Math.tan(pitch);
    check(
      'the disc sits over ground the fallback could not reach',
      groundUnderDisc > SELECT_PICK_RADIUS,
      `${Math.round(groundUnderDisc)} units away, fallback reaches ${SELECT_PICK_RADIUS}`,
    );

    await clickGround(page, 540, 400 - Math.round(discPixelsUp));
    const bySprite = await waitForSelected(page, /^spawner-/);
    // What this claims is exactly what it measures: a click that high selects a
    // marker, and the ground under it is further from any marker's own point
    // than the fallback reaches -- so the billboard raycast is what answered.
    // What it deliberately does not claim is *which* marker: sprites are 138
    // world units wide and the shipped map has eighteen spawners, so several
    // discs overlap that pixel and the nearest to the camera wins.
    check(
      'a click at the disc height selects a marker, out of the fallback\'s reach',
      /^spawner-/.test(bySprite),
      `${bySprite} (clicked ${Math.round(discPixelsUp)}px up, ground ${Math.round(groundUnderDisc)} units off)`,
    );

    // And the fallback, which is the other half: a click by the stem rather than
    // on the disc still names the obvious thing.
    await clickGround(page, 700, 460);
    await clickGround(page, 540, 400);
    const underCursor = await waitForSelected(page, /^spawner-/);
    check('clicking the ground under it selects a marker too', /^spawner-/.test(underCursor), underCursor);
    // Whatever that turned out to be, rather than the one this run placed: the
    // shipped map has eighteen spawners of its own and these coordinates land on
    // whichever is nearest. What the next few checks are about is that an edit
    // reaches the document, and any real marker answers that.
    const editedId = underCursor.split(' ')[0] ?? '';

    // The three properties this spec is about, one row at a time.
    await setPanelOption(page, 'Monster', 'stalker');
    const named = await waitForSelected(page, /label:stalker/);
    check('changing the monster reaches the document', /label:stalker/.test(named), named);

    await setPanelNumber(page, 'Respawn s (0=default)', 90);
    const waited = await waitForSelected(page, /respawn:90/);
    check('a respawn time reaches the document', /respawn:90/.test(waited), waited);

    await setPanelNumber(page, 'Leash (0=default)', 240);
    const leashed = await waitForSelected(page, /leash:240/);
    check('a leash radius reaches the document', /leash:240/.test(leashed), leashed);

    const edited = await save(page);
    const editedSpawner = markersIn(edited.doc).find((m) => m.id === editedId);
    check(
      'the saved file carries what was edited',
      editedSpawner?.label === 'stalker' &&
        editedSpawner.spawner?.respawnSeconds === 90 &&
        editedSpawner.spawner.leashRadius === 240,
      JSON.stringify(editedSpawner ?? null),
    );

    // Undo takes an edit back, which is the claim that the panel opens and
    // closes a history entry per change rather than per stroke -- there is no
    // stroke here to close one.
    await page.keyboard.press('Control+z');
    const undone = await waitForSelected(page, /leash:0/);
    check('Ctrl+Z takes the last edit back', /leash:0/.test(undone), undone);

    // Empty ground clears it, which is what makes a selection dismissable
    // without a second control.
    //
    // *Searched* rather than guessed, because the shipped map is covered in
    // spawners and a fixed coordinate lands on one -- which reads as "the
    // selection did not clear" when what really happened is that it moved to the
    // marker under the second click. A run where every candidate hits something
    // is reported as such rather than as a pass.
    const candidates: readonly (readonly [number, number])[] = [
      [900, 620],
      [1000, 200],
      [300, 640],
      [1050, 700],
      [250, 220],
      [820, 180],
    ];
    let clearedAt: readonly [number, number] | null = null;
    const landedOn: string[] = [];
    for (const [x, y] of candidates) {
      await clickGround(page, x, y);
      // Either answer is an arrival, so this polls for *a change* rather than
      // for one of them -- a click that has not been drawn yet still reads as
      // whatever the last one selected.
      const now = await waitForSelected(page, new RegExp(`^(?!${editedId}\\b).`));
      if (now === 'none') {
        clearedAt = [x, y];
        break;
      }
      landedOn.push(`${x},${y} -> ${now.split(' ')[0] ?? '?'}`);
    }
    check(
      'clicking empty ground clears the selection',
      clearedAt !== null,
      clearedAt ? `cleared at ${clearedAt[0]},${clearedAt[1]}` : `every candidate hit a marker: ${landedOn.join('; ')}`,
    );

    // The other way a selection goes away: the marker is taken off the map by
    // something that is not the Delete button. `refreshMarkers` notices rather
    // than being told, because it is the one function every path that changes
    // the marker set already calls -- and the panel has to be told on the
    // transition, or it goes on naming a marker that is not there.
    await clickGround(page, 540, 400);
    await waitForSelected(page, /^spawner-/);
    await page.getByRole('button', { name: 'erase', exact: true }).click();
    await page.waitForTimeout(400);
    await holdGround(page, 540, 400);
    const afterErase = await waitForSelected(page, /^none$/);
    await page.getByRole('button', { name: 'select', exact: true }).click();
    await page.waitForTimeout(400);
    // The readout is the assertion; the panel row is reported beside it. Only
    // the first is non-vacuous here -- arming a mode refreshes the whole panel,
    // so a check on that row after switching back would pass whether or not
    // `refreshMarkers` had told it anything.
    const panelAfterErase = (await panelRow(page, 'Marker'))?.value ?? '(no row)';
    check(
      'erasing the selected marker is noticed, not announced',
      afterErase === 'none',
      `readout ${afterErase}, panel ${panelAfterErase}`,
    );
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(1200);

    await clickGround(page, 540, 400);
    const doomed = await waitForSelected(page, /^spawner-/);
    const beforeDelete = await markerCount(page);
    await page.click('button:has-text("Delete marker")');
    const cleared = await waitForSelected(page, /^none$/);
    const afterDelete = await markerCount(page);
    check(
      'Delete takes the selected marker off the map',
      afterDelete === beforeDelete - 1 && cleared === 'none',
      `${doomed.split(' ')[0] ?? '?'}: ${beforeDelete} -> ${afterDelete} markers, selection ${cleared}`,
    );

    // The other source still works, and says so in its own name: a generated
    // world must never come back named after the map it would replace.
    await openEditor(page, '?seed=20260806&map=generated');
    const generated = await markerCount(page);
    check('a generated world is still reachable, and is not the shipped map', generated === 0, `${generated} markers`);
    const generatedSave = await save(page);
    check(
      'a generated world is not named after the map it would replace',
      generatedSave.name === 'map-20260806.json',
      generatedSave.name,
    );

    // A built page has no write endpoint, and the editor has to say that rather
    // than look like a save that failed -- the download is still the answer here.
    await openEditor(page, '');
    const refused = await saveToDisk(page);
    check(
      'a built page says there is no dev server, and points at the download',
      /no dev server here/.test(refused),
      refused,
    );

    check('the page logged no errors', problems.length === 0, problems.slice(0, 3).join(' | '));
    await page.close();

    // --- the dev server, where the button actually writes the file ----------
    await devHalf(browser, problems);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
