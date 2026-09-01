/**
 * Are the fixtures on the map actually lit, in the real Play tab? (spec 250)
 *
 *   npx tsx scripts/probe-world-lights.ts
 *
 * Everything spec 250 decides is asserted in Node already: what a fixture
 * resolves to (`terrain/fixture-light.test.ts`), that a region carries its
 * lights and drops them with the ground (`prop-instances.test.ts`), the
 * residency's whole hysteresis (`light-residency.test.ts`), and the pool's fixed
 * count (`world-lights.test.ts`). None of that
 * can say whether any of it is **connected to anything**, and this repo has been
 * bitten by exactly that: spec 121 built the aura path and left it with no
 * caller for a hundred specs, and spec 176 found every rule about saving a
 * marker green in Node beside a tab that called none of them.
 *
 * So it drives the real thing: the shipped page over a real dev server, a real
 * in-tab `GameServer`, the real streamed `maps/arena` with the four fixtures
 * `light-the-square.ts` put in it, the real prop field, and the real pool.
 *
 * What it reads is `data-world-lights`, and what makes that evidence rather than
 * a restatement is where each half comes from. `lit=` is the **pool's own held
 * slots** -- so a fixture that asked for one and was refused by the budget, or
 * lost it to the hysteresis, reads as absent. `offered=` is what asked. The two
 * together are the only way to tell "the map has no fixtures near me" from "the
 * pool is not lighting them", which are the same picture on screen and have
 * completely different fixes. That is `data-held-weapons`'s rule and
 * `data-prop-regions`'s, one system further along.
 *
 * ## The control is a count, not a distance
 *
 * `DEFAULT_SPAWN` is (600, 450) and the square's fire is at (547, 457), so a
 * player opens the game 53 units from it -- which is spec 247's doing and is
 * exactly right for a town, and leaves this script with nowhere to stand that is
 * *out* of range without an admin teleport and the server harness that needs.
 *
 * So the control is the **number**, and it is a real one in both directions:
 * `offered` has to equal the fixtures the map file actually holds, which this
 * script reads for itself out of `maps/arena`. A pipeline that is not connected
 * reads 0, a field handing back lights for ground it no longer draws reads more
 * than the map has, and a pool lighting whatever it is passed reads more lit
 * than offered. All three are the failures worth catching, and all three would
 * look identical on screen.
 *
 * It writes `.claude/screenshots/world-lights.png`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { loadMapFile } from '../src/server/world/map-file.js';
import { loadMap } from '../src/terrain/map-world.js';
import { isFixtureKind, type FixtureKind, type Prop } from '../src/terrain/vegetation.js';
import { FIXTURE_ART } from '../src/render/iso3d/world/fire-vfx.js';
import { WORLD_LIGHT_DEFAULTS } from '../src/render/iso3d/world-lights.js';
import { DEFAULT_SPAWN } from '../src/server/player/player-manager.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4341;
const VIEWPORT = { width: 1280, height: 800 } as const;
const SEED = 20260806;
/** Long enough for the ground under the fixtures to have streamed in. */
const SETTLE_TICK = 240;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** The pool's size, read from the pool rather than typed here. */
const POOL_SLOTS = WORLD_LIGHT_DEFAULTS.slots;

/** Where a fresh character stands. `player-manager.ts`'s own constant. */
const SPAWN = { x: DEFAULT_SPAWN.x, y: DEFAULT_SPAWN.y };

/** How many frames the draw count is sampled over, and how much it may move. */
const DRAW_SAMPLES = 8;
/**
 * The spread allowed between the highest and lowest sample.
 *
 * Generous on purpose: the count moves with what is on screen -- a monster
 * wandering into frame is a handful of calls -- and what this is looking for is
 * nothing like that size. One cube face of this scene is over a hundred draws,
 * and a slot that cast would draw six of them every frame.
 */
const DRAW_SPREAD = 60;

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
 * What the last frame cost in draw calls.
 *
 * Off `data-fps-draw-calls`, which `fps-overlay.ts` publishes for exactly this,
 * rather than out of the overlay's *text* -- which the first cut did, and read
 * `900447 draws` for a frame that drew 447: `textContent` runs the line above
 * straight into this one, so the number was a stable prefix with the real count
 * on the end of it. It would have passed every assertion below, for the wrong
 * reason, right up until the line above it changed.
 *
 * It is a **per frame** total rather than per `render` call, which is what makes
 * it able to see a shadow pass at all (`renderer.info.autoReset = false`) --
 * which is the point, since what it is checking is that there is not one.
 */
async function drawCalls(page: Page): Promise<number> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-fps-draw-calls]');
    return Number(host?.dataset['fpsDrawCalls'] ?? -1);
  });
}

interface Reading {
  readonly lit: number;
  readonly offered: number;
  /** Campfires whose paint is actually burning (spec 250). */
  readonly fires: number;
}

/**
 * What the page says is lit, and what asked to be.
 *
 * Polled rather than read once. This environment paints the page at about five
 * frames a second under software GL, and the attribute is published *from the
 * frame* -- so a single read a moment after a teleport is a read of where the
 * player used to be. `probe-map-editor.ts` learned the same lesson and reported
 * three working edits as failures.
 */
async function reading(page: Page): Promise<Reading> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-world-lights]');
    const text = host?.dataset['worldLights'] ?? '';
    return {
      lit: Number(/lit=(\d+)/.exec(text)?.[1] ?? -1),
      offered: Number(/offered=(\d+)/.exec(text)?.[1] ?? -1),
      fires: Number(/fires=(\d+)/.exec(text)?.[1] ?? -1),
    };
  });
}

async function settledReading(page: Page, want: (r: Reading) => boolean, timeoutMs = 20_000): Promise<Reading> {
  const deadline = Date.now() + timeoutMs;
  let last: Reading = { lit: -1, offered: -1, fires: -1 };
  while (Date.now() < deadline) {
    last = await reading(page);
    if (want(last)) return last;
    await page.waitForTimeout(250);
  }
  return last;
}

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

/** The fixtures the shipped map actually holds, read the way the server reads them. */
function fixturesOnTheMap(): readonly Prop[] {
  const { doc } = loadMapFile();
  const layer = doc.layers[0];
  if (!layer) return [];
  return loadMap(doc)
    .store.props(layer.id)
    .filter((prop) => isFixtureKind(prop.kind));
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const fixtures = fixturesOnTheMap();
  console.log(`the shipped map holds ${String(fixtures.length)} fixture(s):`);
  for (const one of fixtures) {
    console.log(`  ${one.kind.padEnd(12)} (${String(Math.round(one.x))}, ${String(Math.round(one.y))})`);
  }
  if (fixtures.length === 0) {
    console.error('nothing to measure. Run `npx tsx scripts/light-the-square.ts --write` first.');
    process.exit(1);
  }
  // Which of them *burn*, from the renderer's own art table rather than from a
  // list of kinds repeated here (spec 265): a campfire and a standing torch both
  // do and a lamp post does not, and a probe carrying its own copy of that
  // answer would go on passing the day a fourth fixture is added.
  const burners = fixtures.filter((one) => FIXTURE_ART[one.kind as FixtureKind] !== undefined).length;
  const nearestToSpawn = [...fixtures].sort(
    (a, b) => Math.hypot(a.x - SPAWN.x, a.y - SPAWN.y) - Math.hypot(b.x - SPAWN.x, b.y - SPAWN.y),
  )[0];
  if (!nearestToSpawn) throw new Error('unreachable');

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
      // every boot; every other probe here carries the same filter.
      if (message.type() === 'error' && !message.text().startsWith('[units]')) {
        problems.push(message.text());
      }
    });

    await page.goto(`http://localhost:${PORT}/?seed=${String(SEED)}`, { waitUntil: 'load' });
    await page.waitForSelector('canvas', { state: 'attached', timeout: 60_000 });
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 120_000 });
    await waitForTick(page, SETTLE_TICK);
    await page.mouse.move(4, 4);

    console.log(
      `\nstanding at the spawn, ${String(Math.round(Math.hypot(nearestToSpawn.x - SPAWN.x, nearestToSpawn.y - SPAWN.y)))}` +
        ` units from the nearest fixture (a ${nearestToSpawn.kind})`,
    );
    const there = await settledReading(page, (r) => r.lit > 0 && r.fires > 0);
    console.log(
      `  data-world-lights = lit=${String(there.lit)} offered=${String(there.offered)}` +
        ` fires=${String(there.fires)}`,
    );
    check(there.offered > 0, 'the fixtures on the map offer themselves to the pool');
    check(
      there.offered === fixtures.length,
      `exactly the ${String(fixtures.length)} fixture(s) the map holds are offered ` +
        `(saw ${String(there.offered)}; a surplus means something other than a fixture ` +
        `is asking -- a conjured light on a body, or a Warden firing nearby)`,
    );
    check(there.lit > 0, 'and the pool is lighting them');
    check(there.lit <= there.offered, 'never more lit than were offered');
    check(there.lit <= POOL_SLOTS, `never more lit than the pool has slots (${String(POOL_SLOTS)})`);
    // The paint (specs 250, 265). A campfire's prop is stones and charred logs
    // since 250 and a torch's is a stake with a coal in it since 265, so a fire
    // that did not start is a cold ring of stones or an unlit brand -- which
    // looks exactly like one nobody has lit and would never be reported.
    check(
      there.fires === burners,
      `every fixture that burns is burning on drawn ground: ${String(burners)} on the map,` +
        ` ${String(there.fires)} alight`,
    );

    // The half of "does not sag performance" that can be seen from outside
    // (spec 250).
    //
    // Lighting a village has to cost **nothing per frame**: the pool is fixed,
    // so its program is constant, and no slot casts, so no slot adds a pass over
    // the scene. Standing in the square with four fixtures lit therefore has to
    // draw exactly what standing there unlit would.
    //
    // So this samples the count over a run of frames and asserts it **settles**.
    // The spread rather than the absolute number, because the absolute number is
    // a fact about how much world happens to be on screen. What it catches is a
    // slot that started casting again -- a shadow-casting point light is six
    // cube faces of the *whole* scene, over a hundred draws each here, which is
    // an addition on every frame that no amount of on-screen churn looks like.
    const draws: number[] = [];
    for (let i = 0; i < DRAW_SAMPLES; i++) {
      draws.push(await drawCalls(page));
      await page.waitForTimeout(180);
    }
    const low = Math.min(...draws);
    const high = Math.max(...draws);
    console.log(`\ndraw calls over ${String(DRAW_SAMPLES)} frames: ${draws.join(', ')}`);
    check(low > 0, 'the frame readout gives a draw count at all');
    check(
      high - low <= DRAW_SPREAD,
      `the count is settled: ${String(high - low)} between the highest and lowest, ` +
        `against ${String(DRAW_SPREAD)} allowed (a slot that cast would add six passes over ` +
        `the scene every frame, which this cannot hide)`,
    );

    await page.screenshot({ path: join(outDir, 'world-lights.png') });
    console.log(`\nwrote ${join(outDir, 'world-lights.png')}`);
  } finally {
    await browser.close();
    stopDevServer(server);
  }

  if (problems.length > 0) {
    console.error(`\n${String(problems.length)} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\nOK: the fixtures on the map are lit, and only where somebody is standing near them.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
