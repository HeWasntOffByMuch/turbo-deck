/**
 * Screenshot the world view (spec 063), so the three.js half of it is checked by
 * something other than hope.
 *
 * Everything under `src/render/iso3d/world/` that can be tested headlessly is --
 * interpolation, intent, cast bars, appearance. The scene itself needs a GPU and
 * a DOM, so it gets the same treatment the editor's does: drive the real page in
 * a real browser and commit the frames to `.claude/screenshots/`.
 *
 *   npx tsx scripts/preview-world.ts
 *
 * Requires a build first (`npm run build`); it serves `dist/` rather than
 * running the dev server, so what is photographed is what ships.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4319;

/**
 * A Chromium to drive. Prefers a browser already on the box (an agent container
 * ships one at `PLAYWRIGHT_BROWSERS_PATH` that may not match the version this
 * Playwright would download), and otherwise lets Playwright find its own.
 */
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';

/** Software WebGL: there is no GPU in CI or in an agent's container. */
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${url} never came up`);
}

/** The target line the HUD is showing: "no target", or a name and its health. */
async function readTarget(page: Page): Promise<string> {
  const text = (await page.textContent('body')) ?? '';
  return /(no target|target [^\n]*)/.exec(text)?.[1] ?? '';
}

/**
 * Right-clicks around the frame until one of the clicks lands on a body
 * (spec 070).
 *
 * The alternative is arithmetic: project a monster's world position through the
 * camera and click the result, which would be testing this script's copy of the
 * projection rather than the game's picking. Asking the HUD what got targeted
 * is the same question the player asks by looking at it.
 */
interface Bar {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Where every body with a health bar is on screen.
 *
 * The bars are anchored over the bodies and tagged with their entity ids, so
 * reading them is how this script finds something to click. The alternative is
 * re-deriving the camera projection here, which would test this file's copy of
 * it rather than the game's picking.
 */
async function bodiesOnScreen(page: Page): Promise<Bar[]> {
  return page.$$eval('[data-entity]', (nodes) =>
    nodes.map((node) => {
      const element = node as HTMLElement;
      return { id: element.dataset['entity'] ?? '', x: element.offsetLeft, y: element.offsetTop };
    }),
  );
}

/** The pixel to point at for a body, given the bar floating over its head. */
function bodyPoint(bar: Bar): { x: number; y: number } {
  // The footprint fallback in the pick makes the exact offset forgiving.
  return { x: bar.x, y: bar.y + 40 };
}

async function findUnit(page: Page): Promise<Bar | null> {
  for (const bar of await bodiesOnScreen(page)) {
    const point = bodyPoint(bar);
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await page.waitForTimeout(90);
    // The click that found it has *already* targeted it. The player's own bar
    // is in this list too, and right-clicking yourself is a move order -- so a
    // miss here is an answer, not a failure.
    if ((await readTarget(page)).startsWith('target ')) return bar;
  }
  return null;
}

/** The tick the HUD is showing. */
async function readTick(page: Page): Promise<number> {
  const text = (await page.textContent('body')) ?? '';
  return Number(/tick (\d+)/.exec(text)?.[1] ?? -1);
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

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  console.log(`  wrote ${name}.png`);
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const server = spawn(
    'npx',
    ['vite', 'preview', '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: 'ignore' },
  );

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
      if (message.type() === 'error') problems.push(message.text());
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    // Building the world, meshing the terrain and batching the prop field all
    // happen before the first frame, and under software WebGL that is seconds
    // rather than milliseconds -- and it varies enough run to run that a fixed
    // delay photographs a world still starting up. Poll the HUD's own tick
    // counter instead, from here rather than in-page: it is the same fact the
    // player reads, and a failure says which tick it got stuck at.
    await waitForTick(page, 150);

    await shoot(page, 'world-play');

    // Right-click a point on the ground: the move order the game had before the
    // server existed (spec 064). The marker should appear and the figure walk to it.
    await page.mouse.click(420, 560, { button: 'right' });
    await page.waitForTimeout(500);
    await shoot(page, 'world-move-order');
    await page.waitForTimeout(1400);
    await shoot(page, 'world-walking');

    // Commit to a heavy blow and catch the frame mid-wind-up: the bar, and the
    // body turning into the blow at its own turn rate rather than snapping.
    await page.mouse.move(820, 330);
    await page.waitForTimeout(200);
    await page.keyboard.press('Digit2');
    await page.waitForTimeout(220);
    await shoot(page, 'world-windup');

    // ...then call it off. Nothing should be spent: no cooldown, no resource.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await shoot(page, 'world-cancelled');

    // Right-click a body: it becomes the target, the player walks into reach
    // and then swings at it until it is dead (spec 070). Nothing is bound to
    // left-click any more.
    const unit = await findUnit(page);
    if (!unit) {
      console.error('no unit could be targeted by right-clicking; is the field empty?');
      problems.push('right-click targeting found nothing to attack');
    } else {
      // The click that found it is the click that targeted it, so the readout
      // is taken before anything else moves.
      const opened = await readTarget(page);
      await shoot(page, 'world-target');

      // The cursor sitting on a body outlines it -- the thing that says what a
      // click would pick before it is made. Aimed at where the body is *now*:
      // the player is already walking toward it, so the pixel that was over it
      // a screenshot ago is over the grass behind it.
      const moved = (await bodiesOnScreen(page)).find((bar) => bar.id === unit.id);
      if (moved) {
        const point = bodyPoint(moved);
        await page.mouse.move(point.x, point.y);
        await page.waitForTimeout(120);
        await shoot(page, 'world-hover');
      }

      // Long enough to walk into reach and land several blows without a second
      // press: the auto-attack is the whole point.
      await page.waitForTimeout(4000);
      const later = await readTarget(page);
      await shoot(page, 'world-autoattack');
      console.log(`  target on the click:      ${opened}`);
      console.log(`  ...four seconds later:    ${later}`);
      // The order runs itself: no second press was made between those two
      // lines. "no target" means the body it named is dead and the client
      // dropped it, which is the only way an attack order ends by itself.
    }

    // A ground-targeted blast, for the telegraph ring on the terrain.
    await page.keyboard.press('Digit5');
    await page.waitForTimeout(320);
    await shoot(page, 'world-telegraph');

    // Let the fight run a little, then photograph the hotbar: cooldown sweeps
    // (spec 065) and the pixel damage numbers over the bodies.
    await page.waitForTimeout(900);
    await shoot(page, 'world-cooldowns');

    // The player must still be able to walk after all that. Attacking used to
    // root them permanently: being hit cleared the cast server-side without
    // telling the client, which then believed it was casting for good.
    const before = await readTick(page);
    await page.mouse.click(300, 620, { button: 'right' });
    await page.waitForTimeout(1600);
    await shoot(page, 'world-after-combat');
    console.log(`  ticks advanced during the walk: ${(await readTick(page)) - before}`);

    const status = await page.textContent('body');
    console.log('\nHUD read back:', status?.slice(0, 200).replace(/\s+/g, ' '));

    if (problems.length > 0) {
      console.error('\npage reported errors:');
      for (const problem of problems) console.error(`  ${problem}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

await main();
