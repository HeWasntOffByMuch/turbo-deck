/**
 * Whether the editor's ground window actually meshes and evicts (spec 212).
 *
 * The half no headless test can reach. `ground-residency.test.ts` asserts the
 * window over every camera position there is -- what is owed, what is dropped,
 * that the two can never fight -- and not one of those can say whether the frame
 * loop calls any of it. An editor that opens instantly over an empty world
 * passes all of them, and so does one that meshes the whole map anyway.
 *
 *   npm run build && npx tsx scripts/probe-editor-ground.ts
 *
 * What it measures, off `data-ground`:
 *
 * - **The open is a window, not the world.** Far fewer chunks meshed than the
 *   map holds, and more than none.
 * - **The ledger and the scene graph agree.** `held` is what the residency
 *   believes; `meshed` is `pickTargets.length`, which is what is really drawn
 *   *and* what the cursor raycasts against. A window that meshed nothing and
 *   said it had would read as working from the ledger alone.
 * - **Widening the view meshes more, and narrowing it drops what it left.**
 *   Eviction has no other observable and is the half spec 208 called the
 *   counterpart nobody had written.
 *
 * Picking is deliberately not checked here: `probe-map-editor.ts` already
 * places a marker by clicking the ground and reads it back out of the saved
 * file, which is a stronger statement about the raycast than anything this
 * could add -- and it is the test that fails if a window leaves a hole under
 * the cursor.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4330;

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

interface GroundState {
  readonly meshed: number;
  readonly held: number;
  readonly of: number;
}

async function groundState(page: Page): Promise<GroundState | null> {
  const raw = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-ground]');
    return el?.dataset.ground ?? null;
  });
  if (raw === null) return null;
  const read = (field: string): number => Number(new RegExp(`${field}:(\\d+)`).exec(raw)?.[1] ?? -1);
  return { meshed: read('meshed'), held: read('held'), of: read('of') };
}

/**
 * Poll until the fill has stopped moving.
 *
 * This container paints a few frames a second under software GL, so a fixed
 * wait is less than one frame and would read a half-filled window as a settled
 * one -- the mistake `probe-drop.ts` records making.
 */
async function settle(page: Page, forMs = 12_000): Promise<GroundState | null> {
  let last: GroundState | null = null;
  let same = 0;
  for (let i = 0; i < forMs / 250; i++) {
    await page.waitForTimeout(250);
    const now = await groundState(page);
    if (now && last && now.meshed === last.meshed && now.held === last.held) {
      if (++same >= 4) return now;
    } else {
      same = 0;
    }
    last = now;
  }
  return last;
}

async function main(): Promise<void> {
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

    await page.goto(`http://localhost:${String(PORT)}/`, { waitUntil: 'load' });
    await page.click('button:has-text("Map editor")');
    await page.waitForSelector('canvas:visible', { timeout: 60_000 });

    const opened = await settle(page);
    if (!opened) {
      check('the editor publishes what ground it has meshed', false, 'no data-ground on the page');
    } else {
      console.log(`the map holds ${String(opened.of)} chunks`);
      check(
        'the open meshes some ground',
        opened.meshed > 0,
        `${String(opened.meshed)} chunk surfaces on the scene graph`,
      );
      check(
        'and meshes a window rather than the world',
        opened.meshed < opened.of,
        `${String(opened.meshed)} of ${String(opened.of)} chunks`,
      );
      check(
        'the ledger and the scene graph agree about what is drawn',
        opened.held === opened.meshed,
        `held ${String(opened.held)}, meshed ${String(opened.meshed)}`,
      );
    }

    // Widen the view. More ground is framed, so more has to be meshed -- and
    // this is also the state eviction is measured against. The zoom is
    // exponential in the wheel delta, so this is a few notches rather than a
    // saturating one: filling the *whole* map is minutes under software GL at
    // ~5.7ms a chunk, and proving eviction does not need it.
    await page.mouse.move(550, 400);
    await page.mouse.wheel(0, 1000);
    const wide = await settle(page, 90_000);
    check(
      'zooming out meshes more ground',
      (wide?.meshed ?? 0) > (opened?.meshed ?? 0),
      `${String(opened?.meshed ?? 0)} -> ${String(wide?.meshed ?? 0)}`,
    );

    // And all the way back in. A saturating delta lands on the camera's minimum
    // span, which frames less than one chunk -- so the keep window is a handful
    // of chunks and everything the wide view meshed is well outside it. This is
    // the counterpart spec 208 says this path never had: without it the count
    // only ever goes up.
    await page.mouse.wheel(0, -20_000);
    const narrow = await settle(page, 60_000);
    check(
      'zooming back in drops the ground it left behind',
      (narrow?.meshed ?? Number.MAX_SAFE_INTEGER) < (wide?.meshed ?? 0),
      `${String(wide?.meshed ?? 0)} -> ${String(narrow?.meshed ?? 0)}`,
    );
    check(
      'and still holds the ground it is looking at',
      (narrow?.meshed ?? 0) > 0,
      `${String(narrow?.meshed ?? 0)} chunk surfaces`,
    );
    check(
      'the ledger still agrees with the scene graph after an eviction',
      narrow !== null && narrow.held === narrow.meshed,
      narrow ? `held ${String(narrow.held)}, meshed ${String(narrow.meshed)}` : 'no reading',
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
