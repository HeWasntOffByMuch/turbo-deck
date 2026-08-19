/**
 * A line said in one tab, read in another (spec 189):
 * `npx tsx scripts/probe-chat.ts`
 *
 * Every part of this feature is checked in Node -- the log is a unit test, the
 * screen is a golden through both backends, the mount's wiring is asserted
 * against a fake client -- and none of that can see the thing the spec is
 * actually about, which is that a line one player types reaches another
 * player's screen. That path runs through a real keyboard event, `view.ts`'s
 * key decision, `GameClient.say`, a socket, the server's broadcast and a
 * listener that had no caller in the tree until now.
 *
 * It is exactly the seam spec 134 lost a window to: two halves individually
 * green, joined by one line nothing exercised.
 *
 * Four things here can only be asked in a browser.
 *
 * **Enter reaches the game.** The key is bound in `gameplay` context, so the
 * chat opens only if the interface *declined* the press first -- and once it is
 * open the field takes the same key and the game never sees it. One key, two
 * meanings, no branch anywhere saying so.
 *
 * **Typing does not play the game.** A focused field pushes `textEntry`, which
 * is the whole reason the context stack exists. A `1` typed into the chat must
 * be a one and not a cast, and `w` must not walk.
 *
 * **The log clears the HUD.** `setSafeBottom` measures the pool bars in CSS
 * pixels and the log is placed in UI pixels; nothing in Node holds both, so
 * "the chat is not sitting on top of the player's own health" is a claim only
 * a page can answer.
 *
 * **The line survives the round trip**, with the sender's name on it.
 *
 * It starts its own server and its own dev server, and refuses a port that
 * already answers -- the lesson `probe-admin-console.ts` records: a run after a
 * failed one otherwise connects to the previous run's leaked process and
 * reports every check green while measuring older code.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const GAME_PORT = Number(process.env['PORT'] ?? 8793);
const DEV_PORT = Number(process.env['DEV_PORT'] ?? 5185);
const DEV = `http://localhost:${DEV_PORT}`;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
/** Software WebGL: there is no GPU in CI or in an agent's container. */
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const CONNECT_TIMEOUT_MS = 60_000;
/**
 * How far a body may drift and still count as standing still, in CSS pixels.
 *
 * Not zero: a remote body is interpolated between 20Hz deltas, so its drawn
 * position settles rather than snapping, and the camera is orthographic but the
 * ground is a heightfield. A walk of the length below crosses far more than
 * this.
 */
const STILL_PX = 6;

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
  readonly lines: readonly string[];
  readonly open: boolean;
  readonly input: string;
  readonly rects: string;
  readonly viewport: string;
}

async function readout(page: Page): Promise<Readout> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-ui-windows]');
    return {
      lines: (host?.dataset['uiChat'] ?? '').split(';').filter((line) => line !== ''),
      open: host?.dataset['uiChatOpen'] === 'true',
      input: host?.dataset['uiChatInput'] ?? '',
      rects: host?.dataset['uiChatRects'] ?? '',
      viewport: host?.dataset['uiViewport'] ?? '',
    };
  });
}

/** One `id:x,y,w,h` out of a readout's box list, in UI pixels. */
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
 * A UI-pixel box in CSS pixels -- the inverse of `UiLayer.toUi`, taken from the
 * canvas's own CSS box over the viewport it reports, so the harness never has
 * to know the scale or the device ratio.
 */
async function toCss(page: Page, box: Box): Promise<Box | null> {
  const uiWidth = Number((await readout(page)).viewport.split('x')[0]);
  if (!Number.isFinite(uiWidth) || uiWidth <= 0) return null;
  return page.evaluate(
    ([x, y, width, height, uiW]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-ui-canvas]');
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const per = rect.width / (uiW ?? 1);
      return {
        x: rect.left + (x ?? 0) * per,
        y: rect.top + (y ?? 0) * per,
        width: (width ?? 0) * per,
        height: (height ?? 0) * per,
      };
    },
    [box.x, box.y, box.width, box.height, uiWidth] as const,
  );
}

/**
 * Poll until the readout satisfies a predicate.
 *
 * A poll rather than a fixed wait, and that is not tidiness: this environment
 * paints a real page at about five frames a second under software GL and the
 * readout is published from the frame, so a fixed 200ms wait is less than one
 * frame and reads the state before the keystroke it is checking.
 */
async function waitFor(page: Page, done: (state: Readout) => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (done(await readout(page))) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(150);
  }
}

/**
 * Where a player's body is on screen, from their nameplate.
 *
 * Read on the *other* player's page, deliberately. A camera follows its own
 * player, so Ana's body never moves on Ana's screen however far she walks --
 * measuring there would report "did not move" for a walk that worked. On Ben's
 * screen his camera is still and hers is the thing that moves, and the plate is
 * the one part of another body that has a DOM element to ask.
 */
async function bodyAt(page: Page, name: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((want: string) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>('[data-name]')).find(
      (candidate) => candidate.dataset['name'] === want,
    );
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, name);
}

/** How far a body moved between two readings, in CSS pixels. */
function moved(before: { x: number; y: number } | null, after: { x: number; y: number } | null): number {
  if (!before || !after) return Number.NaN;
  return Math.hypot(after.x - before.x, after.y - before.y);
}

/**
 * The top of the HUD's own bottom furniture, in CSS pixels, and what it is.
 *
 * Everything marked `data-hud-bottom` -- which is what `setSafeBottom`
 * measures, so this asks the same question of the same elements. The name of
 * the lowest one is reported because the first cut of this check measured the
 * *pool bars* and passed, while the log was drawn straight over the weapon
 * switch beside them: a clearance check against the wrong furniture is worse
 * than none, because it reads as evidence.
 */
async function hudBottom(page: Page): Promise<{ top: number; what: string } | null> {
  return page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll<HTMLElement>('[data-hud-bottom]'))
      .map((element) => ({
        top: element.getBoundingClientRect().top,
        what: element.dataset['hudBottom'] ?? '?',
      }))
      .filter((entry) => Number.isFinite(entry.top));
    if (boxes.length === 0) return null;
    return boxes.reduce((lowest, entry) => (entry.top < lowest.top ? entry : lowest));
  });
}

// --- the tabs ----------------------------------------------------------------

async function openTab(browser: Browser, name: string): Promise<Page> {
  // A context apiece, not two pages in one: sessionStorage is per-context, and
  // sharing it would make both tabs the same player.
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  // Generous, and not defensiveness: this environment paints a real page at a
  // few frames a second under software GL, and the second tab is loading the
  // world's meshes while the first is already rendering it. Playwright's 30s
  // default is a measurement of the container rather than of the page.
  page.setDefaultNavigationTimeout(CONNECT_TIMEOUT_MS);
  page.setDefaultTimeout(CONNECT_TIMEOUT_MS);
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

/** Type a line into an open field, one key at a time, as a person would. */
async function type(page: Page, text: string): Promise<void> {
  for (const character of text) {
    await page.keyboard.press(character === ' ' ? 'Space' : character);
    await page.waitForTimeout(20);
  }
}

/**
 * Hold each movement key in turn until the body moves, and report the furthest.
 *
 * Measured on the other player's page, for the reason {@link bodyAt} gives.
 */
async function walksAnyDirection(walker: Page, watcher: Page, them = 'Ana'): Promise<number> {
  let best = 0;
  for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) {
    const before = await bodyAt(watcher, them);
    await walker.keyboard.down(key);
    await walker.waitForTimeout(900);
    await walker.keyboard.up(key);
    await walker.waitForTimeout(300);
    const distance = moved(before, await bodyAt(watcher, them));
    if (Number.isFinite(distance)) best = Math.max(best, distance);
    if (best > STILL_PX) return best;
  }
  return best;
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
    console.log('opening two tabs...');
    const ana = await openTab(browser, 'Ana');
    const ben = await openTab(browser, 'Ben');

    // --- Enter opens the field ------------------------------------------------
    console.log('Enter opens the chat');
    check('nothing is open to start with', !(await readout(ana)).open);
    await ana.keyboard.press('Enter');
    check('Enter opens it', await waitFor(ana, (state) => state.open));
    check('...with no log yet, because nothing has been said', (await readout(ana)).lines.length === 0);
    // Photographed here rather than described: the failure this state used to
    // have -- an empty plate over the world above the field -- is one nothing in
    // the readout can see, because a rectangle with nothing in it reports the
    // same empty line list as no rectangle at all.
    const shots = join(process.cwd(), '.claude', 'screenshots');
    mkdirSync(shots, { recursive: true });
    await ana.waitForTimeout(500);
    await ana.screenshot({ path: join(shots, 'chat-empty.png'), clip: { x: 0, y: 560, width: 520, height: 240 } });

    // --- typing does not play the game ---------------------------------------
    console.log('typing goes into the field, not into the game');
    const parkedBefore = await bodyAt(ben, 'Ana');
    check("Ana's body can be found on Ben's screen", parkedBefore !== null);
    // `w` is bound to walking and `1` to the first bar slot, and the field has
    // to swallow both. Held down rather than tapped, because a held key is what
    // moves a body -- a single press and release is one tick of walking and
    // reads as noise either way.
    await ana.keyboard.down('KeyW');
    await ana.waitForTimeout(900);
    await ana.keyboard.up('KeyW');
    await type(ana, '1 hi');
    check(
      'the keys land in the field',
      await waitFor(ana, (state) => state.input === 'w1 hi'),
      `input: "${(await readout(ana)).input}"`,
    );
    const drift = moved(parkedBefore, await bodyAt(ben, 'Ana'));
    check('...and the body did not walk', drift < STILL_PX, `moved ${drift.toFixed(1)}px`);

    // --- Escape closes without sending ---------------------------------------
    console.log('Escape puts it away without saying anything');
    await ana.keyboard.press('Escape');
    check('Escape closes it', await waitFor(ana, (state) => !state.open));
    check('nothing was said', !(await readout(ben)).lines.some((line) => line.includes('hi')));

    // --- the round trip -------------------------------------------------------
    console.log('a line said in one tab, read in the other');
    await ana.keyboard.press('Enter');
    await waitFor(ana, (state) => state.open);
    await type(ana, 'ready when you are');
    await ana.keyboard.press('Enter');

    check(
      "Ben sees Ana's line, with her name on it",
      await waitFor(ben, (state) => state.lines.some((line) => line === 'Ana: ready when you are')),
      `Ben's log: ${(await readout(ben)).lines.join(' | ')}`,
    );
    // Waited for rather than read once. Both clients are sent the same
    // broadcast, but each publishes its readout from its own frame -- and under
    // software GL a page here paints a few frames a second, so Ben having it
    // says nothing about whether Ana has drawn since.
    check(
      'and Ana sees her own, through the server rather than an echo',
      await waitFor(ana, (state) => state.lines.includes('Ana: ready when you are')),
      `Ana's log: ${(await readout(ana)).lines.join(' | ')}`,
    );
    // Once, not twice: nothing is echoed locally, because the server broadcasts
    // to every connection with a player on it and the sender is one of them.
    check(
      'exactly once',
      (await readout(ana)).lines.filter((line) => line === 'Ana: ready when you are').length === 1,
      `Ana's log: ${(await readout(ana)).lines.join(' | ')}`,
    );
    check('the field closed on send', !(await readout(ana)).open);

    // --- the keyboard comes back ---------------------------------------------
    console.log('the game has the keyboard again');
    // Two questions, and the first is the one with a definite answer. Opening
    // the bag proves the key reached the gameplay path, with no terrain in the
    // way; walking proves the same thing about the keys a player actually holds.
    await ana.keyboard.press('KeyI');
    check(
      'a gameplay key reaches the game',
      await ana
        .waitForFunction(
          () => (document.querySelector<HTMLElement>('[data-ui-windows]')?.dataset['uiWindows'] ?? '').includes('inventory'),
          undefined,
          { timeout: 8000 },
        )
        .then(() => true)
        .catch(() => false),
    );
    await ana.keyboard.press('Escape');

    // Every direction, until one of them moves her. A single direction is a
    // measurement of what she happens to be standing against: the arena has
    // trees, rocks and a palisade, and a body pressed into one of them reports
    // a working keyboard as a broken one. This reported exactly that once.
    const walked = await walksAnyDirection(ana, ben);
    check('...and the movement keys walk again', walked > STILL_PX, `best of four directions: ${walked.toFixed(1)}px`);

    // --- Up recalls what was sent --------------------------------------------
    console.log('Up walks back through what was said');
    await ana.keyboard.press('Enter');
    await waitFor(ana, (state) => state.open);
    await ana.keyboard.press('ArrowUp');
    check(
      'Up brings the last line back',
      await waitFor(ana, (state) => state.input === 'ready when you are'),
      `input: "${(await readout(ana)).input}"`,
    );
    await ana.keyboard.press('ArrowDown');
    check('Down past the end empties it', await waitFor(ana, (state) => state.input === ''));
    await ana.keyboard.press('Escape');

    // --- the log clears the HUD ----------------------------------------------
    console.log('the log is not sitting on the player');
    const logBox = boxNamed((await readout(ana)).rects, 'log');
    check('the log has a box', logBox !== null, (await readout(ana)).rects);
    if (logBox) {
      const css = await toCss(ana, logBox);
      const band = await hudBottom(ana);
      if (!css) check('the log converts to CSS pixels', false);
      else if (!band) check('the HUD publishes furniture to measure against', false);
      else {
        check(
          `the log clears the HUD's bottom furniture (lowest: ${band.what})`,
          css.y + css.height <= band.top + 1,
          `log bottom ${Math.round(css.y + css.height)}, ${band.what} top ${Math.round(band.top)}`,
        );
      }
    }

    const outDir = shots;
    await ana.keyboard.press('Enter');
    await waitFor(ana, (state) => state.open);
    await type(ana, 'and this is what it looks like');
    await ana.waitForTimeout(400);
    await ana.screenshot({ path: join(outDir, 'chat-open.png') });
    await ana.keyboard.press('Escape');
    await ana.waitForTimeout(400);
    await ana.screenshot({ path: join(outDir, 'chat-log.png') });
    await ana.screenshot({ path: join(outDir, 'chat-corner.png'), clip: { x: 0, y: 560, width: 520, height: 240 } });
    console.log('wrote .claude/screenshots/chat-{empty,open,log,corner}.png');
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
