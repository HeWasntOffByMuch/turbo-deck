/**
 * Two real tabs, one real server (spec 144).
 *
 * The half of the socket path no headless test can see. The `Channel` is
 * covered in Node against the `ws` class, and `planConnection` is a table --
 * but whether the *browser* opens a socket at all depends on the DOM
 * `WebSocket`, on vite's `/ws` proxy actually carrying an upgrade, and on the
 * one branch in `mountWorld` picking the remote path. None of those three exist
 * in Node, and a typecheck cannot fail on any of them.
 *
 * It reads `data-connection` off each page rather than photographing a pixel,
 * for the same reason `probe-exempt.ts` measures colours instead of diffing
 * frames: a screenshot of a connected tab and a disconnected one differ by a
 * banner nobody can assert on.
 *
 * Wants both `npm run server` and `npm run dev` already running; it says so
 * rather than starting them, because a script that boots a server it did not
 * write the port for is how two of these end up fighting over 8787.
 *
 *   npm run server           # terminal one
 *   npm run dev              # terminal two
 *   npx tsx scripts/preview-multiplayer.ts
 */

import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';

const DEV = process.env['DEV_URL'] ?? 'http://localhost:5173';
/** The container's pre-installed browser, as `preview-world.ts` finds it. */
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
/** Software WebGL: there is no GPU in CI or in an agent's container. */
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
/** Long enough for a cold start to stream its chunks in on a loaded machine. */
const CONNECT_TIMEOUT_MS = 30_000;

async function connectionOf(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector<HTMLElement>('[data-connection]')?.dataset['connection'] ?? null);
}

/** The entity id this tab was welcomed as, read off the HUD's debug readout. */
async function openTab(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[${name}] ${message.text()}`);
  });
  page.on('pageerror', (error) => console.error(`[${name}] ${error.message}`));
  await page.goto(`${DEV}/?server&name=${encodeURIComponent(name)}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });
  let failed = false;
  try {
    // Two contexts, not two pages in one -- sessionStorage is per-context here,
    // and sharing it would make both tabs the same player, which is the exact
    // bug this script exists to catch.
    const ana = await openTab(browser, 'Ana');
    const ben = await openTab(browser, 'Ben');

    for (const [name, page] of [['Ana', ana], ['Ben', ben]] as const) {
      await page.waitForFunction(
        () => document.querySelector<HTMLElement>('[data-connection]')?.dataset['connection'] === 'connected',
        undefined,
        { timeout: CONNECT_TIMEOUT_MS },
      );
      console.log(`[${name}] ${await connectionOf(page)}`);
    }

    // The world has to actually arrive, or "connected" is only half the claim.
    for (const [name, page] of [['Ana', ana], ['Ben', ben]] as const) {
      await page.waitForFunction(() => document.querySelector<HTMLElement>('[data-world-ready]') !== null, undefined, {
        timeout: CONNECT_TIMEOUT_MS,
      });
      console.log(`[${name}] world drawn`);
    }

    const ids = await Promise.all(
      [ana, ben].map((page) =>
        page.evaluate(() => window.sessionStorage.getItem('turbo-deck.net.playerId')),
      ),
    );
    console.log(`playerIds: ${ids.join(' , ')}`);
    if (ids[0] === null || ids[1] === null || ids[0] === ids[1]) {
      console.error('FAIL: the two tabs are not two players');
      failed = true;
    }

    // Each tab draws the *other's* name over their body (spec 145). Read off
    // `data-name` rather than the pixels, for the same reason as above.
    for (const [name, page, other] of [['Ana', ana, 'Ben'], ['Ben', ben, 'Ana']] as const) {
      try {
        await page.waitForFunction(
          (want: string) =>
            Array.from(document.querySelectorAll<HTMLElement>('[data-name]')).some(
              (el) => el.dataset['name'] === want,
            ),
          other,
          { timeout: CONNECT_TIMEOUT_MS },
        );
        console.log(`[${name}] sees ${other} by name`);
      } catch {
        console.error(`FAIL: ${name} never saw a nameplate for ${other}`);
        failed = true;
      }
    }

    await ana.screenshot({ path: '.claude/screenshots/multiplayer-ana.png' });
    await ben.screenshot({ path: '.claude/screenshots/multiplayer-ben.png' });
    console.log('wrote .claude/screenshots/multiplayer-{ana,ben}.png');
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Is \`npm run server\` and \`npm run dev\` running? Expected the page at ${DEV}.`);
    failed = true;
  } finally {
    await browser.close();
  }
  if (failed) process.exitCode = 1;
}

await main();
