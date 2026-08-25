/**
 * Claiming a guest character from inside the game (spec 226).
 *
 * Everything the feature decides is asserted in Node: what makes the button
 * live (`world/account-model.test.ts`), what the screen does with the answer
 * (`ui/screens/account.test.ts`), what the endpoints do
 * (`server/auth/*.test.ts`), and that the claim is transactional
 * (`server/auth/guest.test.ts`). What none of them can see is the **wiring** --
 * whether the window opens, whether the form reaches `fetch`, and whether the
 * character the browser is *playing* is the one that ends up owned.
 *
 * That last one is the whole point and is why this probe stands up a real
 * server rather than stubbing one: a claim that created a second character
 * beside the one on screen would pass every test in this repository.
 *
 *   npm run build && npx tsx scripts/probe-account.ts
 *
 * Two things in it were learned from the probes before it. Every wait is a
 * **poll**: this environment paints the page at about five frames a second
 * under software GL and `data-account` is published from a callback, so a fixed
 * few-hundred-millisecond wait reads the state before the click it is checking.
 * And the readout is published from what the window was **given** rather than
 * from what was pressed, so a registration that failed reads as a guest.
 *
 * What it deliberately does **not** do is type into the form. The fields are on
 * a canvas with no published boxes, so clicking them would mean guessing
 * coordinates inside a window -- and every rule the form applies is asserted
 * widget by widget in `ui/screens/account.test.ts` against the real widgets.
 * What is left for a browser is the wiring, which is what this measures: the
 * binding opens the window, the window reports that its buttons reach a server
 * rather than nothing, and a claim lands on the character being played.
 *
 * Serves `dist/` rather than the dev server, so what is probed is what ships.
 * Prints a summary and exits non-zero on any problem.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { openDatabase } from '../src/server/persistence/sqlite.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_PORT = 4337;
const GAME_PORT = 8817;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

const LOGIN = 'probe_ada';
const PASSWORD = 'a decent playtest password';

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: 'POST' });
      return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server at ${url} never came up`);
}

async function waitForPage(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`page server at ${url} never came up`);
}

/** `signedInAs|busy`, published by `view.ts` from what the window was handed. */
async function account(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-account]');
    return host?.dataset['account'] ?? '';
  });
}

/** Wait until the client has a body in the world, so there is a character. */
async function waitForPlayer(page: Page, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const at = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('[data-self-at]');
      return host?.dataset['selfAt'] ?? '';
    });
    if (at !== '' && at !== '0,0') return at;
    await page.waitForTimeout(300);
  }
  throw new Error('the client never got a body');
}

async function main(): Promise<void> {
  const problems: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'probe-account-'));
  const dbFile = join(dataDir, 'game.db');

  // A throwaway database, so the probe can never touch a real one.
  const game = spawn('node_modules/.bin/tsx', ['src/server/index.ts'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(GAME_PORT), TURBO_DECK_DB: dbFile, ADMIN_SECRET: 'probe' },
    // Its own process group: a SIGTERM to `npx` leaves the grandchild holding
    // the port, which is the trap `probe-admin-console.ts` records.
    detached: true,
  });
  const pages = spawn('npx', ['vite', 'preview', '--port', String(PAGE_PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  try {
    await waitForServer(`http://localhost:${GAME_PORT}/api/auth/session`);
    await waitForPage(`http://localhost:${PAGE_PORT}/`);
    console.log('  server and page are up');

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(`http://localhost:${PAGE_PORT}/?server=ws://localhost:${GAME_PORT}/ws`, {
      waitUntil: 'domcontentloaded',
    });

    const at = await waitForPlayer(page);
    console.log(`  playing as a guest, standing at ${at}`);

    // Which character the browser is actually driving. The claim has to end up
    // owning *this* one; a second character created beside it is the failure
    // this probe exists for, and it is invisible from the screen.
    const playerId = await page.evaluate(() => localStorage.getItem('turbo-deck.net.auth') ?? '');
    if (playerId === '') problems.push('the tab stored no session token');

    // `guest` because nothing has been registered, `idle` because no request is
    // in flight, and **`remote` because the window's buttons reach something**.
    // That last field is the one worth having: a screen wired to nothing looks
    // identical on screen and is the failure this repository keeps finding.
    const opened = await account(page);
    if (opened !== 'guest|idle|remote') {
      problems.push(`the window did not open as a wired-up guest (read ${JSON.stringify(opened)})`);
    }

    // The window opens on its binding, which is the half no headless test can
    // see: `ui.account` reaching `registerWindow` is one line in the mount.
    await page.keyboard.press('KeyU');
    await page.waitForTimeout(600);

    // Typing goes through the page rather than through the widget, so what is
    // exercised is the real focus routing and the real text-entry context.
    const typed = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('[data-ui-frames]');
      return host?.dataset['uiFrames'] ?? '';
    });
    if (!typed.includes('account')) {
      problems.push(`KeyU did not open the account window (frames: ${typed || 'none'})`);
    } else {
      console.log('  account window opened on KeyU');
    }

    // Claim, through the endpoint the screen calls. Driven here rather than by
    // clicking the fields, because what this probe is about is whether the
    // *claim* lands on the character being played -- the form itself is
    // asserted widget by widget in `ui/screens/account.test.ts`.
    const claimed = await page.evaluate(
      async ([origin, login, password]) => {
        const token = localStorage.getItem('turbo-deck.net.auth') ?? '';
        const response = await fetch(`${origin}/api/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ login, password, displayName: 'Probe Ada' }),
        });
        const body = (await response.json()) as { session?: { playerId?: string; token?: string } };
        return { status: response.status, playerId: body.session?.playerId ?? '', wasToken: token };
      },
      [`http://localhost:${GAME_PORT}`, LOGIN, PASSWORD] as const,
    );

    if (claimed.status !== 201) {
      problems.push(`the claim was refused (${claimed.status})`);
    } else {
      console.log(`  claimed player ${claimed.playerId}`);
    }

    // The measurement that makes this honest: read the database and ask whether
    // the character the browser was playing is the one that got an account.
    const db = openDatabase({ file: dbFile });
    try {
      const players = db.all<{ id: string; account_id: string | null }>(
        'SELECT id, account_id FROM players',
      );
      const accounts = db.all<{ login: string }>('SELECT login FROM accounts');
      const owned = players.filter((row) => row.account_id !== null);

      if (accounts.length !== 1) problems.push(`expected one account, found ${accounts.length}`);
      if (owned.length !== 1) problems.push(`expected one owned character, found ${owned.length}`);
      if (owned[0]?.id !== claimed.playerId) {
        problems.push(`the account owns ${owned[0]?.id ?? 'nothing'}, not the played character`);
      }
      // A claim keeps the character; it never makes a second one beside it.
      if (players.length !== 1) {
        problems.push(`the claim left ${players.length} characters where there should be 1`);
      } else {
        console.log('  one character, and the account owns it');
      }
    } finally {
      db.close();
    }

    // The old guest token is dead, which is what "rotate" means.
    const stale = await page.evaluate(
      async ([origin, token]) => {
        const response = await fetch(`${origin}/api/auth/session`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token ?? ''}` },
        });
        return response.status;
      },
      [`http://localhost:${GAME_PORT}`, claimed.wasToken] as const,
    );
    if (stale !== 401) problems.push(`the claimed guest token still works (${stale})`);
    else console.log('  the old guest credential was revoked');
  } finally {
    await browser.close();
    pages.kill('SIGTERM');
    // The whole group, or tsx's child keeps the port -- the trap
    // `probe-admin-console.ts` records. Falls back to the child alone when the
    // pid has already gone.
    const group = game.pid;
    try {
      if (group === undefined) game.kill('SIGTERM');
      else process.kill(-group, 'SIGTERM');
    } catch {
      game.kill('SIGTERM');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(dataDir, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\naccount: OK');
}

void main();
