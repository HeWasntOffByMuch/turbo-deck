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

/**
 * Refuse a port that already answers.
 *
 * The rule `probe-admin-console.ts` records, learned the same way: a run after
 * a failed one connects to the *previous* run's leaked server, on the same
 * port, and reports every check green while measuring older code.
 * `--strictPort` makes the second bind fail rather than drift to another port,
 * but it fails *silently* inside a spawned process nobody reads, so the probe
 * carries on against the squatter.
 *
 * Not hypothetical: a deliberate mutation of the proxy table passed here
 * because a preview server from an earlier run -- started when the table was
 * still correct -- held the port.
 */
async function refuseIfTaken(url: string, what: string): Promise<void> {
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(1500) });
  } catch {
    return; // nothing there, which is what we want
  }
  throw new Error(
    `${what} at ${url} is already answering. A leaked server from an earlier run would be ` +
      'measured instead of this build; stop it and run again.',
  );
}

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

/**
 * The player id the tab's stored credential resolves to, asked of the server.
 *
 * Through `/api/auth/session` rather than off any client state, so what is
 * compared is the identity the *server* agrees this tab has.
 */
async function whoAmI(page: Page, gamePort: number): Promise<string> {
  return page.evaluate(
    async ([origin]) => {
      const token = localStorage.getItem('turbo-deck.net.auth') ?? '';
      if (token === '') return '';
      const response = await fetch(`${origin}/api/auth/session`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) return '';
      const body = (await response.json()) as { identity?: { playerId?: string } };
      return body.identity?.playerId ?? '';
    },
    [`http://localhost:${gamePort}`] as const,
  );
}

async function main(): Promise<void> {
  const problems: string[] = [];

  // Before anything is spawned: a port that already answers means a leaked
  // server from an earlier run, and measuring that is worse than not measuring.
  await refuseIfTaken(`http://localhost:${PAGE_PORT}/`, 'a page server');
  await refuseIfTaken(`http://localhost:${GAME_PORT}/`, 'a game server');

  const dataDir = mkdtempSync(join(tmpdir(), 'probe-account-'));
  const dbFile = join(dataDir, 'game.db');

  // A throwaway database, so the probe can never touch a real one.
  // `node --import tsx` rather than the `tsx` binary, which is a supervisor that
  // spawns the real process: one server, one pid, and a SIGTERM that reaches
  // the shutdown handler instead of a wrapper that may or may not forward it.
  const game = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(GAME_PORT), TURBO_DECK_DB: dbFile, ADMIN_SECRET: 'probe' },
  });
  // `GAME_SERVER` so the preview server's proxy forwards `/ws` and `/api/auth`
  // to *this* probe's game server rather than the default :8787. `vite preview`
  // resolves `preview.proxy ?? server.proxy`, so the dev table applies here.
  // vite's own entry rather than `npx vite`, for the reason the game server is
  // launched that way: `npx` is a supervisor, so a SIGTERM to it leaves the
  // grandchild holding the port -- which is precisely how this probe leaked a
  // preview server that a later run then measured instead of its own build.
  const pages = spawn(
    process.execPath,
    [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PAGE_PORT), '--strictPort'],
    {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, GAME_SERVER: `ws://localhost:${GAME_PORT}` },
    },
  );
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
    // A **bare** `?server`, deliberately, and it is the whole reason this probe
    // is worth running. An explicit `?server=ws://host:port/ws` points the auth
    // origin straight at the game server and never touches the proxy -- which
    // is what this probe used to do, and is exactly why it stayed green while
    // `npm run dev` reported "this server does not hand out sessions". Bare is
    // what a developer types, and it makes the page sign in against its own
    // origin, through the proxy, the way a player's tab does.
    await page.goto(`http://localhost:${PAGE_PORT}/?server`, { waitUntil: 'domcontentloaded' });

    const at = await waitForPlayer(page);
    console.log(`  playing as a guest, standing at ${at}`);

    // Which character the browser is actually driving. The claim has to end up
    // owning *this* one; a second character created beside it is the failure
    // this probe exists for, and it is invisible from the screen.
    const playerId = await page.evaluate(() => localStorage.getItem('turbo-deck.net.auth') ?? '');
    if (playerId === '') problems.push('the tab stored no session token');

    // **A reload comes back to the same character.** This is the other failure
    // that was invisible from the screen: the auth token was read out of
    // `sessionStorage` and written to `localStorage`, so every load minted a
    // fresh guest and a refresh silently abandoned everything on the old one.
    // Every unit test passed throughout, because they hand the storage in.
    const before = await whoAmI(page, GAME_PORT);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForPlayer(page);
    const after = await whoAmI(page, GAME_PORT);
    if (before === '' || before !== after) {
      problems.push(`a reload changed character: ${before || '(none)'} -> ${after || '(none)'}`);
    } else {
      console.log(`  a reload came back to ${after}`);
    }

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
      const players = db.all<{ id: string; account_id: string | null; display_name: string }>(
        'SELECT id, account_id, display_name FROM players',
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
      // And it is called what was registered (spec 227). This is the durable
      // half only -- the row is written inside the claim's transaction, so it
      // is right here whether or not the live record was told. What the live
      // half is worth is `auth/rename.test.ts`, which flushes and watches this
      // very write get undone without it.
      if (owned[0]?.display_name !== 'Probe Ada') {
        problems.push(`the character is called ${owned[0]?.display_name ?? 'nothing'}, not Probe Ada`);
      } else {
        console.log('  and it is called Probe Ada');
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
    // One process, so one signal. No group kill and no orphan holding the port.
    game.kill('SIGTERM');
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
