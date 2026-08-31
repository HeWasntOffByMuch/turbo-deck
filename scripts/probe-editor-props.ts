/**
 * Whether the editor's deferred prop field actually puts the trees back (spec 211).
 *
 * The half no headless test can reach, and the half this tree keeps discovering
 * it needed. Every rule about the ledger is asserted in Node -- what a region is
 * keyed as, what order they are owed in, that a drained field is the field the
 * eager build returns -- and not one of those can say whether `view.ts`'s frame
 * loop calls any of it. An editor that opens instantly and draws no trees ever
 * passes all of them.
 *
 *   npm run build && npx tsx scripts/probe-editor-props.ts
 *
 * Three things are measured, and the first two are opposites on purpose:
 *
 * - **The open composes nothing.** If the first frames already hold every
 *   instance, the field is not deferred and the 4.5s came back.
 * - **The fill finishes.** Every region owed is eventually composed, and the
 *   instance count lands on what the map actually holds.
 * - **What is drawn is what is attached.** The count is walked off the scene
 *   graph by `EditorScene.drawnPropInstances`, not totted up from what was
 *   asked for, so a region composed into batches that never reached the group
 *   reads as absent -- which is the one failure a deferred field can have and
 *   an eager one could not.
 *
 * Served from `dist/` rather than the dev server, so what is measured is what
 * ships. Exits non-zero if a step did not do what it claims.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

import { loadMapFile } from '../src/server/world/map-file.js';
import { loadMap } from '../src/terrain/map-world.js';
import { propRegions } from '../src/render/iso3d/editor/prop-residency.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4329;

// Software GL, as every browser probe in this tree uses: there is no GPU here,
// and the default headless shell is not the binary this container ships.
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
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

interface PropState {
  readonly drawn: number;
  readonly pending: number;
}

/**
 * What the editor says it has on screen, off the readout's `data-props`.
 *
 * Returns null until the attribute exists at all, which is the state before the
 * first frame has run -- distinguished from "zero drawn" deliberately, because
 * those are the two readings this probe most needs to tell apart.
 */
async function propState(page: Page): Promise<PropState | null> {
  const raw = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-props]');
    return el?.dataset.props ?? null;
  });
  if (raw === null) return null;
  const drawn = Number(/drawn:(\d+)/.exec(raw)?.[1] ?? -1);
  const pending = Number(/pending:(\d+)/.exec(raw)?.[1] ?? -1);
  return { drawn, pending };
}

async function openEditor(page: Page): Promise<void> {
  // The built page is the game client since spec 254 and builds no tab strip at
  // all; this harness drives the Map editor tab, so it asks the workbench back.
  await page.goto(`http://localhost:${String(PORT)}/?client=workbench`, { waitUntil: 'load' });
  await page.click('button:has-text("Map editor")');
  await page.waitForSelector('canvas:visible', { timeout: 60_000 });
}

async function main(): Promise<void> {
  // What the map actually holds, read the same way the editor reads it, so the
  // target is the document's own answer rather than a number typed in here.
  const doc = loadMapFile().doc;
  const map = loadMap(doc);
  const layerId = doc.layers[0]?.id ?? 'ground';
  const props = map.store.props(layerId);
  const regions = propRegions(props);
  console.log(`maps/arena/ holds ${String(props.length)} props in ${String(regions.size)} regions`);

  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    detached: true,
  });
  let browser: Browser | undefined;
  try {
    await waitForServer(`http://localhost:${String(PORT)}/`);
    browser = await chromium.launch({
      args: CHROMIUM_ARGS,
      ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await openEditor(page);

    // The open. Read as soon as the readout exists at all: the eager field
    // composed everything before the first frame could run, so "the first frame
    // that reports anything already holds every instance" is exactly the
    // regression this guards.
    let first: PropState | null = null;
    for (let i = 0; i < 200 && first === null; i++) {
      first = await propState(page);
      if (first === null) await page.waitForTimeout(50);
    }
    if (first === null) {
      check('the editor publishes what it has drawn', false, 'no data-props on the page');
    } else {
      check(
        'the field opens deferred: the first frame owes regions rather than holding them',
        first.pending > 0,
        `drawn ${String(first.drawn)}, pending ${String(first.pending)}`,
      );
      check(
        'and it opens with far less than the whole map composed',
        first.drawn < props.length,
        `${String(first.drawn)} of ${String(props.length)} instances`,
      );
    }

    // The fill. This container paints a few frames a second under software GL
    // and one region is ~55ms of composition, so a whole map of regions is tens
    // of seconds here -- polled generously, because a short wait would report a
    // working fill as a stalled one.
    let last: PropState | null = first;
    let settled = false;
    for (let i = 0; i < 600; i++) {
      await page.waitForTimeout(250);
      last = await propState(page);
      if (last && last.pending === 0) {
        settled = true;
        break;
      }
    }
    check(
      'the fill finishes: nothing is left owed',
      settled,
      last ? `pending ${String(last.pending)}` : 'no reading',
    );
    check(
      'and the trees are actually on the scene graph, not merely composed',
      (last?.drawn ?? 0) > 0,
      `${String(last?.drawn ?? 0)} instances attached`,
    );
    // An instance is a *part* of a prop -- a trunk, a frond tier -- so there are
    // more of them than there are props. What would mean the fill dropped
    // something is fewer.
    check(
      'every prop in the map is represented',
      (last?.drawn ?? 0) >= props.length,
      `${String(last?.drawn ?? 0)} instances for ${String(props.length)} props`,
    );

    // Panning must not undo it: `refreshPropsWithin` marks regions composed, and
    // getting that wrong shows up as a field that re-composes forever.
    await page.mouse.move(550, 400);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(2000);
    const after = await propState(page);
    check(
      'zooming out leaves the field composed rather than re-owing it',
      after !== null && after.pending === 0,
      after ? `pending ${String(after.pending)}, drawn ${String(after.drawn)}` : 'no reading',
    );

    check('the page logged no errors', errors.length === 0, errors[0] ?? '');
  } finally {
    await browser?.close();
    if (server.pid !== undefined) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }

  console.log(failures.length === 0 ? '\nall checks passed' : `\n${String(failures.length)} check(s) failed`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

await main();
