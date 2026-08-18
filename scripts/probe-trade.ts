/**
 * A trade between two real players, in two real tabs (spec 134):
 * `npx tsx scripts/probe-trade.ts`
 *
 * This is the one screen a single tab cannot exercise at all. Every other
 * window shows a player their own facts and can be driven from one page; the
 * trade table needs two players, a server between them, and a gesture aimed at
 * somebody else's body. So the parts have always been testable in Node -- the
 * swap is a property test, the screen is a golden, the wire is a loopback
 * harness -- and the *seams between them* were checked by nothing.
 *
 * That is not hypothetical. Spec 132 built the whole exchange and 134 built the
 * whole window, both green, and the two were joined by a line that read only
 * `view.trade` -- which is null by the time a trade has a reason. The ending
 * never drew, the window froze on its last live frame, and its Cancel button
 * asked the server to cancel a trade the server had already forgotten. Every
 * test passed.
 *
 * So this drives the real gesture through the real pointer pipeline: Ana
 * shift-right-clicks Ben's body, Ben accepts the invitation, Ana puts a bow on
 * the table, both accept, and the bags are read back afterwards to see that one
 * bow moved and none were made.
 *
 * It starts its own server and its own dev server, and refuses a port that
 * already answers -- the lesson `probe-admin-console.ts` records: a run after a
 * failed one otherwise connects to the previous run's leaked process and
 * reports every check green while measuring older code.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';

const GAME_PORT = Number(process.env['PORT'] ?? 8791);
const DEV_PORT = Number(process.env['DEV_PORT'] ?? 5183);
const DEV = `http://localhost:${DEV_PORT}`;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
/** Software WebGL: there is no GPU in CI or in an agent's container. */
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const CONNECT_TIMEOUT_MS = 60_000;
/** What Ana puts on the table. In the starting kit, and stacked at one. */
const GOODS = 'Hunting Bow';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// --- the two child processes -------------------------------------------------

/**
 * A child this probe can actually kill: `node_modules/.bin/tsx` rather than
 * `npx tsx`, in its own process group, so a signal reaches the real process
 * instead of a wrapper whose grandchild keeps the port.
 */
function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, [...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout?.on('data', () => {
    // Swallowed: boot chatter is not what this probe measures.
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

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const settle = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    setTimeout(() => settle(false), 1000);
  });
}

async function waitForPort(port: number, what: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await answers(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what} never came up on :${port}`);
}

// --- reading the page --------------------------------------------------------

interface Readout {
  readonly windows: string;
  readonly viewport: string;
  readonly stage: string;
  readonly reason: string;
  readonly rects: string;
  readonly cells: string;
  readonly you: string;
  readonly them: string;
  readonly invited: string;
}

async function readout(page: Page): Promise<Readout> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-ui-windows]');
    return {
      windows: host?.dataset['uiWindows'] ?? '',
      viewport: host?.dataset['uiViewport'] ?? '',
      stage: host?.dataset['uiTradeStage'] ?? '',
      reason: host?.dataset['uiTradeReason'] ?? '',
      rects: host?.dataset['uiTradeRects'] ?? '',
      cells: host?.dataset['uiCellNames'] ?? '',
      you: host?.dataset['uiTradeYou'] ?? '',
      them: host?.dataset['uiTradeThem'] ?? '',
      invited: host?.dataset['uiTradeInvited'] ?? '',
    };
  });
}

/**
 * One `id:x,y,w,h` out of a readout's box list, in UI pixels.
 *
 * Split on the *last* colon, not the first: a bag cell is `bag:3`, so an id can
 * contain one and the coordinates never can.
 */
function boxNamed(list: string, id: string): Box | null {
  for (const entry of list.split(';')) {
    const at = entry.lastIndexOf(':');
    if (at < 0) continue;
    if (entry.slice(0, at) !== id) continue;
    const [x, y, width, height] = entry.slice(at + 1).split(',').map(Number);
    if (x === undefined || y === undefined || width === undefined || height === undefined) return null;
    return { x, y, width, height };
  }
  return null;
}

/**
 * A UI-pixel point in CSS pixels -- the inverse of `UiLayer.toUi`, taken from
 * the canvas's own CSS box over the viewport it reports, so the harness never
 * has to know the scale or the device ratio. The same conversion
 * `probe-window-layout.ts` clicks through.
 */
async function toCss(page: Page, at: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const uiWidth = Number((await readout(page)).viewport.split('x')[0]);
  if (!Number.isFinite(uiWidth) || uiWidth <= 0) throw new Error('no UI viewport to convert against');
  const point = await page.evaluate(
    ([ux, uy, width]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-ui-canvas]');
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const perUiPixel = rect.width / (width ?? 1);
      return { x: rect.left + (ux ?? 0) * perUiPixel, y: rect.top + (uy ?? 0) * perUiPixel };
    },
    [at.x, at.y, uiWidth] as const,
  );
  if (!point) throw new Error('no UI canvas on the page');
  return point;
}

/**
 * Wait until the trade window has stopped moving.
 *
 * A window is *placed* the frame after it opens -- it is sized from what its
 * screen wants, and that is not known until the screen has been laid out once
 * (see `awaitingPlacement`). So the box read the instant a trade appears is the
 * pre-placement one, and a click aimed at it lands on the world behind the
 * window. This probe missed every button that way before it waited.
 */
async function settleRects(page: Page): Promise<string> {
  let last = (await readout(page)).rects;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(120);
    const now = (await readout(page)).rects;
    if (now === last && now !== '') return now;
    last = now;
  }
  return last;
}

/** Press one of the trade table's controls, by name. One attempt. */
async function pressTrade(page: Page, id: string): Promise<boolean> {
  const box = boxNamed(await settleRects(page), id);
  if (!box) return false;
  const at = await toCss(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  return true;
}

/**
 * Press a control until it demonstrably did something.
 *
 * Every press here is retried against a stated success condition rather than
 * assumed, and that is not defensiveness: the window is re-placed whenever the
 * stage changes what it is showing, this environment paints a real page at a
 * few frames a second under software GL, and the two together mean a rect that
 * has looked still for 240ms can still be about to move. A press that missed
 * is silent -- it lands on the world behind the window -- so without a
 * condition the probe reports "clicked Accept" for a click that hit grass.
 */
async function pressUntil(
  page: Page,
  id: string,
  done: (state: Readout) => boolean,
  attempts = 6,
): Promise<boolean> {
  if (done(await readout(page))) return true;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await pressTrade(page, id))) return false;
    for (let settle = 0; settle < 10; settle += 1) {
      await page.waitForTimeout(150);
      if (done(await readout(page))) return true;
    }
  }
  return false;
}

/** Whether a side's line lists this item. */
function offers(line: string, name: string): boolean {
  return (line.split('|')[3] ?? '').includes(name);
}

/** How many coins a side's line says are on the table. */
function coinsOf(line: string): number {
  return Number(line.split('|')[2] ?? '0');
}

/** Whether a side's line says they have accepted. */
function accepted(line: string): boolean {
  return (line.split('|')[1] ?? '') === 'yes';
}

/** The refusals the client is currently drawing (spec 143). */
async function refusals(page: Page): Promise<readonly string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-text]'))
      .map((el) => el.dataset['text'] ?? '')
      .filter((text) => text !== ''),
  );
}

/** Poll until the readout satisfies a predicate, or give up. */
async function waitFor(page: Page, done: (state: Readout) => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(await readout(page))) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

/** Poll until the named window is gone, or give up. */
async function waitForWindowGone(page: Page, id: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await readout(page)).windows.split(',').includes(id)) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function waitForStage(page: Page, want: string, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last = '';
  while (Date.now() < deadline) {
    last = (await readout(page)).stage;
    if (last === want) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`${what}: stage never became "${want}" (last saw "${last}")`);
}

/** What is in the bag, read off the inventory window the tab has open. */
async function bagOf(page: Page): Promise<readonly string[]> {
  return (await readout(page)).cells.split(',').filter((name) => name !== '');
}

function countOf(bag: readonly string[], name: string): number {
  return bag.filter((entry) => entry === name).length;
}

// --- the tabs ----------------------------------------------------------------

async function openTab(browser: Browser, name: string): Promise<Page> {
  // A context apiece, not two pages in one: sessionStorage is per-context, and
  // sharing it would make both tabs the same player -- which is the whole
  // premise this probe rests on.
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`[${name}] ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[${name}] ${message.text()}`);
  });
  await page.goto(`${DEV}/?server&name=${encodeURIComponent(name)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('[data-connection]')?.dataset['connection'] === 'connected',
    undefined,
    { timeout: CONNECT_TIMEOUT_MS },
  );
  await page.waitForFunction(() => document.querySelector('[data-world-ready]') !== null, undefined, {
    timeout: CONNECT_TIMEOUT_MS,
  });
  return page;
}

/**
 * Shift-right-click the other player's body.
 *
 * Aimed off their nameplate, because that is the one thing about another body
 * that has a DOM element and therefore a screen position -- everything else is
 * pixels in a canvas. The plate is anchored above the body, so this walks down
 * from it until the pick lands: a fixed offset would be a measurement of the
 * nameplate's layout rather than of the gesture, and would pass for the wrong
 * reason the day the anchor moves.
 */
async function inviteByPointer(page: Page, them: string): Promise<boolean> {
  await page.waitForFunction(
    (want: string) =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-name]')).some((el) => el.dataset['name'] === want),
    them,
    { timeout: CONNECT_TIMEOUT_MS },
  );
  const plate = await page.evaluate((want: string) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>('[data-name]')).find(
      (candidate) => candidate.dataset['name'] === want,
    );
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.bottom };
  }, them);
  if (!plate) return false;

  // From nothing to something: without this, a sweep run while the tab is still
  // in a trade returns true on its first click and reports an invitation that
  // was refused as "you are already trading".
  if ((await readout(page)).stage !== '') return false;
  for (let down = 0; down <= 90; down += 6) {
    await page.mouse.move(plate.x, plate.y + down);
    await page.keyboard.down('Shift');
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.keyboard.up('Shift');
    for (let settle = 0; settle < 6; settle += 1) {
      await page.waitForTimeout(120);
      if ((await readout(page)).stage !== '') return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  for (const [port, what] of [[GAME_PORT, 'game server'], [DEV_PORT, 'dev server']] as const) {
    if (await answers(port)) {
      console.error(`FAIL: something already answers on :${port} (${what}).`);
      console.error('Refusing to run: this probe would measure that process instead of this code.');
      process.exitCode = 1;
      return;
    }
  }

  let game: ChildProcess | null = null;
  let dev: ChildProcess | null = null;
  let browser: Browser | null = null;
  try {
    console.log(`starting the game server on :${GAME_PORT} and vite on :${DEV_PORT}...`);
    game = run('node_modules/.bin/tsx', ['src/server/index.ts'], { PORT: String(GAME_PORT) });
    dev = run('node_modules/.bin/vite', ['--port', String(DEV_PORT), '--strictPort'], {
      GAME_SERVER: `ws://localhost:${GAME_PORT}`,
    });
    await waitForPort(GAME_PORT, 'the game server');
    await waitForPort(DEV_PORT, 'the dev server');

    browser = await chromium.launch({
      args: CHROMIUM_ARGS,
      ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
    });

    console.log('two tabs, one server');
    const ana = await openTab(browser, 'Ana');
    const ben = await openTab(browser, 'Ben');
    const ids = await Promise.all(
      [ana, ben].map((page) => page.evaluate(() => window.sessionStorage.getItem('turbo-deck.net.playerId'))),
    );
    check('the two tabs are two players', ids[0] !== null && ids[0] !== ids[1], `ids: ${ids.join(' , ')}`);

    // The bag window open in both, because the swap is read off it afterwards.
    for (const page of [ana, ben]) {
      await page.keyboard.press('KeyI');
      await page.waitForTimeout(300);
    }
    const anaBefore = await bagOf(ana);
    const benBefore = await bagOf(ben);
    console.log(`  [Ana] bag: ${anaBefore.join(', ')}`);
    console.log(`  [Ben] bag: ${benBefore.join(', ')}`);
    check(`Ana starts with a ${GOODS}`, countOf(anaBefore, GOODS) > 0);

    // --- the invitation ------------------------------------------------------
    console.log('Ana shift-right-clicks Ben');
    check('the gesture opened a trade', await inviteByPointer(ana, 'Ben'));
    await waitForStage(ben, 'offered', 'Ben');
    check('Ben is asked, not enrolled', (await readout(ben)).stage === 'offered');
    check('the window opened itself on Ben', (await readout(ben)).windows.includes('trade'));

    // --- the request is furnished before it is answered (spec 169) ----------
    check('Ana is not asked to accept her own invitation', (await readout(ana)).invited === 'no');
    check('Ben is the one being asked', (await readout(ben)).invited === 'yes');
    // The sender gets no Accept and no Decline: they are the invitation's own
    // buttons, and the server refuses both from this side.
    const asking = await settleRects(ana);
    check('the sender has no Accept', boxNamed(asking, 'accept') === null);
    check('the sender has no Decline', boxNamed(asking, 'decline') === null);
    check('the sender can still call it off', boxNamed(asking, 'cancel') !== null);
    // ...and the invited side is a spectator until it has answered.
    const asked = await settleRects(ben);
    check('the invited side is offered Accept', boxNamed(asked, 'accept') !== null);
    check('the invited side is offered Decline', boxNamed(asked, 'decline') !== null);
    check('the invited side cannot edit the table', boxNamed(asked, 'bag:0') === null);

    const slot = (await bagOf(ana)).indexOf(GOODS);
    console.log(`Ana puts her ${GOODS} and some coins into the request (bag slot ${slot})`);
    check(
      `the ${GOODS} goes into the request`,
      slot >= 0 && (await pressUntil(ana, `bag:${slot}`, (state) => offers(state.you, GOODS))),
    );
    check('coins go in beside it', await pressUntil(ana, 'addCoin', (state) => coinsOf(state.you) > 0));
    check('it is still an invitation', (await readout(ana)).stage === 'offered');
    // The whole point: Ben is looking at goods and coins before deciding, and
    // reads them as items rather than as slot indices into a bag he cannot see.
    check(
      `Ben sees the ${GOODS} before answering`,
      await pressUntil(ben, 'accept', (state) => offers(state.them, GOODS), 0),
      (await readout(ben)).them,
    );
    check('...and the coins with it', coinsOf((await readout(ben)).them) > 0);

    // The picture worth keeping: a request that arrived with something in it.
    await ben.screenshot({ path: '.claude/screenshots/trade-request.png' });

    console.log('Ben accepts the invitation');
    check(
      'Ben accepting opens the table',
      await pressUntil(ben, 'accept', (state) => state.stage === 'open'),
    );
    await waitForStage(ana, 'open', 'Ana');
    // The request survives being answered rather than being cleared by it.
    check(`the ${GOODS} is still on the table`, offers((await readout(ana)).you, GOODS));

    // --- both accept ---------------------------------------------------------
    console.log('both accept');
    check('Ana accepts', await pressUntil(ana, 'accept', (state) => accepted(state.you)));
    check(
      'Ben is shown that Ana has accepted',
      await pressUntil(ben, 'accept', (state) => accepted(state.them), 0),
      (await readout(ben)).them,
    );
    check('Ben accepts', await pressUntil(ben, 'accept', (state) => state.stage === 'over'));

    // --- the ending ----------------------------------------------------------
    // The whole point of the fix: the server forgets a trade the instant it is
    // over, so a window reading only the live trade has nothing to draw here.
    await waitForStage(ana, 'over', 'Ana');
    check('the ending is drawn rather than the window vanishing', true);
    check('the window is still open on Ana', (await readout(ana)).windows.includes('trade'));
    await ana.screenshot({ path: '.claude/screenshots/trade-ana.png' });

    await ana.waitForTimeout(800);
    const anaAfter = await bagOf(ana);
    const benAfter = await bagOf(ben);
    console.log(`  [Ana] bag: ${anaAfter.join(', ')}`);
    console.log(`  [Ben] bag: ${benAfter.join(', ')}`);
    check(
      `Ana gave up one ${GOODS}`,
      countOf(anaAfter, GOODS) === countOf(anaBefore, GOODS) - 1,
      `${countOf(anaBefore, GOODS)} -> ${countOf(anaAfter, GOODS)}`,
    );
    check(
      `Ben received one ${GOODS}`,
      countOf(benAfter, GOODS) === countOf(benBefore, GOODS) + 1,
      `${countOf(benBefore, GOODS)} -> ${countOf(benAfter, GOODS)}`,
    );
    // The duplication check, counted across both bags rather than trusted from
    // either: a swap that copied the bow leaves each side individually plausible.
    check(
      'no bow was made and none was lost',
      countOf(anaAfter, GOODS) + countOf(benAfter, GOODS) === countOf(anaBefore, GOODS) + countOf(benBefore, GOODS),
    );

    // --- putting the ending away --------------------------------------------
    console.log('Ana closes the ending');
    check('the ending has exactly one button', boxNamed(await settleRects(ana), 'cancel') !== null);
    check('closing it puts it away', await pressUntil(ana, 'cancel', (state) => state.stage === ''));
    // Waited for rather than snapshotted: this environment paints a real page at
    // a few frames a second under software GL.
    check('the window closed', await waitForWindowGone(ana, 'trade'));
    // ...and stays closed. Before the client was given a way to forget the
    // ending, the mount re-opened it on the very next frame -- so this is the
    // assertion that the dismissal actually reached the client, rather than the
    // window having been shut and immediately re-shown.
    await ana.waitForTimeout(1500);
    const after = await readout(ana);
    check('and stays closed', !after.windows.split(',').includes('trade'), `windows: ${after.windows}`);
    check('with no trade left to show', after.stage === '', `stage: ${after.stage}`);

    // --- Escape always gets you out (spec 169) -------------------------------
    // A second trade, left live, and shut with the key rather than the button.
    console.log('a second trade, closed with Escape');
    check('a second trade can be opened', await inviteByPointer(ana, 'Ben'));
    await waitForStage(ben, 'offered', 'Ben');
    // Shut the bag first. Escape closes the *topmost* window -- that is the
    // rule, and it is not the one being tested here -- and Ben has had his bag
    // open since the counting at the top.
    await ben.keyboard.press('KeyI');
    await ben.waitForTimeout(500);
    await ben.keyboard.press('Escape');
    check('Escape shuts the window', await waitForWindowGone(ben, 'trade'));
    // Leaving the table cancels it, so Ana is let go rather than left in a trade
    // she cannot see and unable to start another. She keeps her window, because
    // she did not close it and the ending is the thing she needs to be told.
    check('the other side is told', await waitFor(ana, (state) => state.stage === 'over'));
    check('...with a reason', (await readout(ana)).reason !== '', (await readout(ana)).reason);
    // Ben closed his own window, so he is not shown the ending he caused.
    check('the one who left is not shown it again', (await readout(ben)).stage === '');

    check('Ana can close it', await pressUntil(ana, 'cancel', (state) => state.stage === ''));
    check('and neither is in a trade', (await readout(ana)).stage === '' && (await readout(ben)).stage === '');

    // --- a disconnect ends it and says so ------------------------------------
    console.log('a third trade, ended by Ben closing his tab');
    check('a third trade can be opened', await inviteByPointer(ana, 'Ben'));
    await waitForStage(ben, 'offered', 'Ben');
    await ben.context().close();
    // The survivor is told, rather than left holding a window with an Accept in
    // it for a trade with one player in it.
    const told = await waitFor(ana, (state) => state.stage === 'over');
    check('Ana is told the trade ended', told, `stage: ${(await readout(ana)).stage}`);
    check('...and why', (await readout(ana)).reason !== '', `reason: ${(await readout(ana)).reason}`);
    // Retried like every other press: the window is re-placed when the stage
    // changes, so the rect under a close read a moment earlier may have moved.
    check('and can close it', await pressUntil(ana, 'cancel', (state) => state.stage === ''));
    check('the window is gone', await waitForWindowGone(ana, 'trade'));

    if (failures > 0) {
      // The server's own words for whatever it turned down. A press that missed
      // and a press that was refused look identical from the outside.
      console.log(`  [Ana] refusals: ${(await refusals(ana)).join(' | ')}`);
    }

    console.log('wrote .claude/screenshots/trade-{request,ana}.png');
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    failures += 1;
  } finally {
    await browser?.close();
    stop(dev);
    stop(game);
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

await main();
