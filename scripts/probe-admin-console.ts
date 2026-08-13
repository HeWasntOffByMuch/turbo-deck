/**
 * The admin console, driven in a real browser (spec 153):
 * `npx tsx scripts/probe-admin-console.ts`
 *
 * Everything the feature *decides* is asserted in Node -- the arithmetic in
 * `progress.test.ts`, the routing in `admin.test.ts`, the wire in
 * `codec.test.ts`. What none of them can say is whether any of it is connected
 * to anything: the console is a static HTML file with a hand-written codec, so
 * its encoder is not the server's encoder and no test in the suite imports it.
 * The first version of this page shipped with a working protocol and a table that
 * was never wired to the actions beside it, and every test passed.
 *
 * So this stands up the real server, attaches real bots, loads the real page,
 * clicks the real buttons and reads the numbers back out of the real DOM.
 *
 * It asserts what the page is for:
 *  - a live count that arrives without anybody clicking refresh,
 *  - a selection that survives the poll that lands a second later,
 *  - each of the six actions changing the number it claims to change,
 *  - and every action refusing to send anything with nothing selected.
 */

import { chromium, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { signToken } from '../src/server/admin/auth.js';

const PORT = Number(process.env['PORT'] ?? 8799);
const SECRET = 'probe-admin-console-secret';
const BOTS = 3;

interface Row {
  readonly playerId: string;
  readonly level: number;
  readonly experience: number;
  readonly skillPoints: number;
  readonly health: number;
  readonly dead: boolean;
  readonly selected: boolean;
}

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

/**
 * A child this probe can actually kill.
 *
 * Two things here were each learned by getting them wrong. It runs
 * `node_modules/.bin/tsx` rather than `npx tsx`, and it runs the child in its own
 * process group (`detached`) so {@link stop} can signal the *group*: `npx` is a
 * wrapper that spawns the real process as a grandchild, and a SIGTERM to the
 * wrapper leaves the grandchild holding the port. The first version of this probe
 * did exactly that, and the run after a failed one connected to the *previous*
 * run's leaked server -- same port, same secret -- and reported every check
 * green while measuring a process built from older code. A probe that can
 * silently measure the wrong server is worse than no probe.
 */
function run(script: string, args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn('node_modules/.bin/tsx', [script, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout?.on('data', () => {
    // Swallowed: the server's boot chatter is not what this probe is measuring.
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.log(`  [child] ${text}`);
  });
  return child;
}

function stop(child: ChildProcess | null): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

async function waitFor<T>(what: string, attempt: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await attempt();
    if (result !== null) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The table as the operator sees it: read off the DOM, never off the socket. */
async function readRows(page: Page): Promise<Row[]> {
  return page.$$eval('#players tbody tr', (rows) =>
    rows.map((row) => {
      const cells = Array.from(row.querySelectorAll('td'), (cell) => cell.textContent ?? '');
      const fraction = (cells[2] ?? '').split('/');
      const health = (cells[4] ?? '').split('/');
      return {
        playerId: row.querySelector('.id')?.textContent ?? '',
        level: Number(cells[1]),
        experience: Number(fraction[0]),
        skillPoints: Number(cells[3]),
        health: Number(health[0]),
        dead: row.className.includes('dead'),
        selected: row.className.includes('selected'),
      };
    }),
  );
}

const rowFor = (rows: readonly Row[], playerId: string): Row | null =>
  rows.find((row) => row.playerId === playerId) ?? null;

/** Wait until the polled table says something, without clicking anything. */
async function untilRow(
  page: Page,
  playerId: string,
  accepts: (row: Row) => boolean,
  what: string,
): Promise<Row> {
  return waitFor(what, async () => {
    const row = rowFor(await readRows(page), playerId);
    return row && accepts(row) ? row : null;
  });
}

async function main(): Promise<void> {
  // Refused rather than joined. If anything already answers on this port, this
  // probe would measure it instead of the server it is about to start, and every
  // check would pass against code that is not the code in the tree.
  const occupied = await fetch(`http://localhost:${PORT}/admin`)
    .then(() => true)
    .catch(() => false);
  if (occupied) {
    console.log(`something is already serving port ${PORT}. Stop it, or set PORT.`);
    process.exit(1);
  }

  const server = run('src/server/index.ts', [], {
    PORT: String(PORT),
    ADMIN_SECRET: SECRET,
  });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  let bots: ChildProcess | null = null;

  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });

    // The server warms route planning before it listens, which is about a second
    // on a real map plus tsx's compile -- so the bots are started *after* it
    // answers. They do not retry a refused connection, and a race here reads as
    // "the live count never filled in".
    await waitFor('the server to answer', async () => {
      try {
        const response = await fetch(`http://localhost:${PORT}/admin`);
        return response.ok ? true : null;
      } catch {
        return null;
      }
    }, 120_000);
    bots = run(
      'scripts/server-bot.ts',
      ['--count', String(BOTS), '--url', `ws://localhost:${PORT}`],
      {},
    );

    await page.goto(`http://localhost:${PORT}/admin`);
    await page.fill('#token', signToken({ sub: 'probe', role: 'admin' }, SECRET, Date.now()));
    await page.click('#connect');

    console.log('\nliveness');
    await waitFor('authentication', async () =>
      (await page.textContent('#status')) === 'connected' ? true : null,
    );
    check('the token is accepted', true);

    // Nothing is clicked between the connect and this read: if the count fills
    // in, the poll is what filled it.
    const online = await waitFor('the live count', async () => {
      const text = (await page.textContent('#count'))?.trim() ?? '';
      const count = Number(text.split(/\s+/)[0]);
      return Number.isFinite(count) && count >= BOTS ? count : null;
    });
    check(`the count arrives without a refresh click (${online} online)`, online >= BOTS);

    const rows = await readRows(page);
    check(`${BOTS} bots are in the table`, rows.length >= BOTS, `saw ${rows.length}`);
    const target = rows[0]?.playerId ?? '';
    check('a row carries a player id', target.length > 0);

    console.log('\nnothing selected');
    check('no player is selected on load', rows.every((row) => !row.selected));
    const disabled = await page.$$eval(
      '#card ~ .panel button',
      (buttons) => buttons.every((button) => (button as HTMLButtonElement).disabled),
    );
    check('every action bound to a selection is disabled', disabled);

    console.log('\nselection');
    await page.click(`#players tbody tr:has-text("${target}")`);
    check('clicking a row selects it', (rowFor(await readRows(page), target))?.selected === true);
    check(
      'the card names the selected player',
      (await page.textContent('#card'))?.includes(target) === true,
    );
    // The poll lands once a second; a rebuild that dropped the selection would
    // show up here and nowhere else.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    check(
      'the selection survives two polls',
      (rowFor(await readRows(page), target))?.selected === true,
    );

    const before = await untilRow(page, target, () => true, 'the selected row');
    console.log(`\nediting ${target} (level ${before.level}, ${before.experience} xp)`);

    // --- give levels ---
    await page.fill('#levelAmount', '4');
    await page.click('button[data-act="giveLevels"]');
    const levelled = await untilRow(page, target, (row) => row.level === before.level + 4, 'four levels');
    check(`give levels: ${before.level} -> ${levelled.level}`, levelled.level === before.level + 4);
    check(
      `four levels grant four skill points (${before.skillPoints} -> ${levelled.skillPoints})`,
      levelled.skillPoints === before.skillPoints + 4,
    );

    // --- give experience ---
    await page.fill('#xpAmount', '17');
    await page.click('button[data-act="giveXp"]');
    const xpAdded = await untilRow(page, target, (row) => row.experience >= levelled.experience + 17, 'experience');
    check(`give experience: ${levelled.experience} -> ${xpAdded.experience}`, xpAdded.experience >= 17);

    // --- reset experience ---
    await page.click('button[data-act="resetXp"]');
    const xpReset = await untilRow(page, target, (row) => row.experience === 0, 'experience back to zero');
    check('reset xp leaves the level alone', xpReset.level === xpAdded.level);
    check('reset xp zeroes the experience', xpReset.experience === 0);

    // --- give an item ---
    // Through the catalog the page was sent, so this also proves the reply arrived.
    const catalog = await page.$$eval('#itemId option', (options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
    check(`the item catalog arrived (${catalog.length} items)`, catalog.length > 0);
    await page.selectOption('#itemId', catalog[0] ?? '');
    await page.fill('#itemCount', '1');
    await page.click('button[data-act="giveItem"]');
    const gave = await waitFor('the give to be answered', async () => {
      const text = (await page.textContent('#log')) ?? '';
      if (text.includes('giveItem: gave')) return 'ok';
      if (text.includes('giveItem:') && text.includes('bag')) return 'full';
      return null;
    });
    check(`give item is answered (${gave})`, gave === 'ok' || gave === 'full');

    // --- reset level: confirmed, and the confirm is honoured both ways ---
    page.once('dialog', (dialog) => void dialog.dismiss());
    await page.click('button[data-act="resetLevel"]');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    check(
      'a dismissed confirm resets nothing',
      (rowFor(await readRows(page), target))?.level === xpReset.level,
    );

    page.once('dialog', (dialog) => void dialog.accept());
    await page.click('button[data-act="resetLevel"]');
    const reset = await untilRow(page, target, (row) => row.level === 1, 'level back to 1');
    check('reset level puts the character at level 1', reset.level === 1);
    check('reset level re-derives the skill points', reset.skillPoints === 1, `saw ${reset.skillPoints}`);

    // Photographed here rather than at the end: this is the page an operator
    // actually works in -- a live table, a selected row and a populated card.
    // The kick below is the last check because it empties all three.
    await page.screenshot({ path: '.claude/screenshots/admin-console.png', fullPage: true });

    // --- kill ---
    await page.click('button[data-act="kill"]');
    const killed = await untilRow(page, target, (row) => row.dead || row.health <= 0, 'a dead body');
    check('kill zeroes the health', killed.health <= 0);
    check('a dead player is marked in the table', killed.dead);
    // The server puts them back on their feet on its own -- there is no admin
    // action for it, and a kill that stuck would be a bug in the death path.
    const revived = await untilRow(page, target, (row) => row.health > 0, 'the respawn');
    check('the server respawns them at full health', revived.health > 0);

    // --- kick, last, because it takes the row away ---
    await page.fill('#reason', 'probed');
    await page.click('button[data-act="kick"]');
    await waitFor('the row to leave', async () =>
      rowFor(await readRows(page), target) === null ? true : null,
    );
    check('kick drops the player out of the live table', true);
    check(
      'the card says the selection is gone rather than acting on it',
      (await page.textContent('#card'))?.includes('no longer online') === true,
    );
    const goneDisabled = await page.$$eval(
      '#card ~ .panel button',
      (buttons) => buttons.every((button) => (button as HTMLButtonElement).disabled),
    );
    check('actions are disabled again once the selection is gone', goneDisabled);

    console.log('\nthe page itself');
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    const refusals = ((await page.textContent('#log')) ?? '').match(/select a player first/g) ?? [];
    check('nothing was ever sent with an empty player id', refusals.length === 0);

    console.log('\nwrote .claude/screenshots/admin-console.png');
  } finally {
    await browser.close();
    stop(bots);
    stop(server);
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
