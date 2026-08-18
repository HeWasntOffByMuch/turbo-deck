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
 *   npm run build && npx tsx scripts/probe-map-editor.ts
 *
 * Serves `dist/` rather than the dev server, so what is measured is what ships.
 * Exits non-zero if a step did not do what it claims.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4327;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** The map the server boots from -- what the editor is supposed to be editing. */
const SHIPPED_MAP = join(root, 'maps', 'arena.json');

interface Marker {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
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

const markerCount = async (page: Page): Promise<number> =>
  Number(/(\d+) markers/.exec(await readout(page))?.[1] ?? -1);

async function openEditor(page: Page, query: string): Promise<void> {
  await page.goto(`http://localhost:${PORT}/${query}`, { waitUntil: 'load' });
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

async function main(): Promise<void> {
  const shipped = markersIn(JSON.parse(readFileSync(SHIPPED_MAP, 'utf8')) as MapFile);
  console.log(`maps/arena.json holds ${shipped.length} markers`);

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
      // The unit importer warns about root motion on every load; it is not this
      // probe's business and it is not an error in the page.
      if (message.type() === 'error' && !message.text().includes('[units]')) problems.push(message.text());
    });

    // Nothing in the query string: this is what somebody opening the tab gets.
    await openEditor(page, '');

    const opened = await readout(page);
    check('the readout names the map being edited', /editing/i.test(opened) || opened.includes('arena.json'), 'arena.json');
    const before = await markerCount(page);
    check(
      'the editor opened the map the game plays',
      before === shipped.length,
      `${before} markers on screen, ${shipped.length} in maps/arena.json`,
    );

    // Arm the spawner and drop one on the ground.
    await page.getByRole('button', { name: 'marker', exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'spawner', exact: true }).click();
    await page.waitForTimeout(300);
    await clickGround(page, 540, 400);

    const placed = await markerCount(page);
    check('placing one adds it to the map', placed === before + 1, `${before} -> ${placed}`);

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

    check('the page logged no errors', problems.length === 0, problems.slice(0, 3).join(' | '));
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
