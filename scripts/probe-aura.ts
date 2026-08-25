/**
 * Is the aura ring actually on the ground, in the real Play tab? (spec 222)
 *
 *   npx tsx scripts/probe-aura.ts
 *
 * Everything spec 222 decides is asserted in Node already: the pass's arithmetic
 * (`sim/aura-field.test.ts`), the field end to end through the real `step`
 * (`sim/active-skills.test.ts`), the ring's radius against the field's own
 * (`world/auras.test.ts`), and the driver's whole start/stop/evict/forget
 * lifecycle (`world/aura-vfx.test.ts`). None of that can say whether any of it
 * is **connected to anything** -- and this is the one feature in the repo where
 * that is not a hypothetical: `aurasFor` has had a decision function, a tracker,
 * eight authored effects and *no caller* since spec 121, for a hundred specs,
 * with a complete green suite beside it the entire time. Spec 215's probe says
 * so in as many words. This spec is the one that plugs it in, so this is the
 * script that has to prove it.
 *
 * So it drives the real thing: the shipped page over a real dev server, a real
 * in-tab `GameServer` (`?seed=`, no `?server`), the real `?field=` developer
 * path -- `aura-vfx.ts`'s `fieldsWantedByQuery`, read by `view.ts` and turned
 * into `server.triggerEvent('field', ...)` on the player's own position -- the
 * real `AuraVfx` driver, the real particle system, and a real screenshot.
 *
 * What it reads is `data-auras`, and the one thing that makes it evidence is
 * where that number comes from: `scene.heldAuras()`, which is the **driver's own
 * held set**, so a ring that was wanted and refused by the effect budget, or
 * evicted by the instance pool, reads as absent. Counting the replicated
 * statuses instead would report what was asked for and tell nobody whether it
 * arrived -- the same distinction `data-held-weapons` and `data-prop-regions`
 * are both published under, and for the same reason.
 *
 * The control matters as much as the measurement. A page loaded *without*
 * `?field=` has to read zero: a probe whose "after" is right and whose "before"
 * was never checked cannot tell a working driver from one that puts a ring under
 * everything.
 *
 * It writes `.claude/screenshots/aura-in-game.png`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { SCORCHED_EARTH } from '../src/server/data/aura-fields.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4338;
const VIEWPORT = { width: 1280, height: 800 } as const;
/** The same shipped map every session; nothing here depends on which seed. */
const SEED = 20260806;

/**
 * How far the sim is run before anything is read.
 *
 * The trigger tops up every `FORCED_AFFLICTION_EVERY_TICKS` (180) and fires on
 * the first pass, so three seconds is several tops-up rather than a race with
 * the first -- and it is long enough for the world to have streamed in, which is
 * what the ring is drawn on.
 */
const SETTLE_TICK = 300;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
/** Software WebGL: there is no GPU in CI or in an agent's container. */
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

const problems: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
}

async function waitForServer(url: string, timeoutMs = 40_000): Promise<void> {
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

/** Waits until the sim has actually run `ticks` ticks, and says so if it never does. */
async function waitForTick(page: Page, ticks: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const text = (await page.textContent('body')) ?? '';
    last = Number(/tick (\d+)/.exec(text)?.[1] ?? -1);
    if (last >= ticks) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`sim never reached tick ${ticks} (last seen: ${last})`);
}

/**
 * What the page says is wearing a ring, off the scene graph's own held set.
 *
 * Found by the attribute rather than by an id, which is how `probe-walk-back.ts`
 * reads its neighbours in the same readout: which element `view.ts` hangs these
 * on is not a contract, and the attribute is.
 */
async function aurasDrawn(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-auras]');
    return Number(root?.dataset['auras'] ?? -1);
  });
}

/**
 * Loads the world with an optional `&field=`, and waits for it to be worth
 * reading.
 *
 * The pointer is parked off the world for `probe-afflictions.ts`'s stated
 * reason: a stray hover brightens whatever body it lands on, and the screenshot
 * this writes is meant to show a ring rather than a highlight.
 */
async function load(page: Page, withField: boolean): Promise<void> {
  const query = withField ? `?seed=${SEED}&field=scorchedEarth` : `?seed=${SEED}`;
  await page.goto(`http://localhost:${PORT}/${query}`, { waitUntil: 'load' });
  // `attached` rather than `visible`: the world's canvas is drawn at a reduced
  // backing resolution and stretched by CSS, which spends most of a load looking
  // small. `data-world-ready` below is the signal that actually matters.
  await page.waitForSelector('canvas', { state: 'attached', timeout: 60_000 });
  await page.waitForSelector('[data-world-ready="true"]', { timeout: 120_000 });
  await waitForTick(page, SETTLE_TICK);
  await page.mouse.move(4, 4);
}

/**
 * The dev server, in its own process group.
 *
 * `node_modules/.bin/vite` rather than `npx vite`, which sidesteps
 * `probe-admin-console.ts`'s problem: `npx` is a wrapper, and a SIGTERM to it
 * leaves the grandchild holding the port -- so the *next* run of this script
 * would silently measure a stale build.
 */
function runDevServer(): ChildProcess {
  return spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    detached: true,
  });
}

function stopDevServer(child: ChildProcess | null): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  // Refused rather than joined: anything already answering here would be
  // measured instead of the code in the tree, and every check would pass or fail
  // against a build nobody is looking at.
  const occupied = await fetch(`http://localhost:${PORT}/`)
    .then(() => true)
    .catch(() => false);
  if (occupied) {
    console.error(`something is already answering on port ${PORT}. Stop it, or change PORT.`);
    process.exit(1);
  }

  const server = runDevServer();
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
      // The unit loader shouts about the pig's clips carrying root travel on
      // every boot. It predates this probe and has nothing to do with auras;
      // `preview-paint.ts` and `probe-afflictions.ts` both carry the same filter.
      if (message.type() === 'error' && !message.text().startsWith('[units]')) {
        problems.push(message.text());
      }
    });

    console.log(`control (no ?field), after ${String(SETTLE_TICK)} ticks`);
    await load(page, false);
    const before = await aurasDrawn(page);
    console.log(`  data-auras = ${String(before)}`);
    check(before === 0, 'nothing wears a ring when nothing has a field');

    console.log(`?field=scorchedEarth, after ${String(SETTLE_TICK)} ticks`);
    await load(page, true);
    const after = await aurasDrawn(page);
    console.log(`  data-auras = ${String(after)}`);
    check(after >= 1, 'the player wears a ring once they are carrying the field');

    // The ring is `hardStop`, so it must come down with the status rather than
    // outliving it: an aura particle is given `HELD` ticks -- ten minutes -- and
    // one left running is an instance slot held for the session. The trigger's
    // window is `FIELD_DEMO_TICKS`, and the page tops it up on a cadence well
    // inside that, so this is checked by loading the control *after* the field
    // page rather than by waiting one out.
    console.log('control again, to prove the ring is not simply always on');
    await load(page, false);
    const again = await aurasDrawn(page);
    console.log(`  data-auras = ${String(again)}`);
    check(again === 0, 'a fresh session with no field wears no ring');

    await load(page, true);
    await page.screenshot({ path: join(outDir, 'aura-in-game.png') });
    console.log(`\nwrote ${join(outDir, 'aura-in-game.png')}`);
    console.log(
      `the ring is authored at ${String(SCORCHED_EARTH.radius)} world units, ` +
        `which is the field's own reach -- so what is inside it is what burns.`,
    );
  } finally {
    await browser.close();
    stopDevServer(server);
  }

  if (problems.length > 0) {
    console.error(`\n${String(problems.length)} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\nOK: the aura is drawn in the game, and only when something is carrying a field.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
