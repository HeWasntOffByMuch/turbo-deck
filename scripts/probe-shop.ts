/**
 * Talk to a merchant and buy something, in the shipped page (spec 249).
 *
 * Every rule about this is green in Node -- the temperament, the claim on the
 * body, the reveal, the reply that names a vendor, the server's reach check,
 * and the mount's own open-and-keep-open logic (`ui-screens.test.ts`). What none
 * of them can see is the **wiring**: whether a press on a reply button in a real
 * browser reaches `showShopFor`, and whether the window that opens is still
 * there a second later. A shop that opens and shuts again passes every one of
 * those tests.
 *
 *   npm run build && npx tsx scripts/probe-shop.ts
 *
 * Two things make it honest. The merchant is **found by the cursor**, not by a
 * guessed screen position: the pointer is swept until `data-crosshair` reads
 * `bubble`, which is the game's own answer to "that is somebody you can talk
 * to". And the window is checked **twice** -- once as soon as it opens and again
 * after a full second -- because the failure being looked for is a window that
 * appears and then closes itself, and a single look right after the click reads
 * exactly like success.
 *
 * Serves `dist/` rather than the dev server, so what is probed is what ships.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4337;
/**
 * The game server this probes against.
 *
 * `?server=` rather than the in-tab loopback, and that is the whole point of
 * the flag being here (spec 249). The bug this exists to catch is a *stale
 * answer* -- two shop requests in flight and the older one landing last -- and
 * over a loopback both answers arrive in one batch before the next frame is
 * drawn, so the last one wins and the page looks perfect. It needs a socket.
 */
const GAME_PORT = 4338;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
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

/** Which windows the interface says are open. */
async function openWindows(page: Page): Promise<readonly string[]> {
  const text = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-ui-windows]');
    return host?.dataset['uiWindows'] ?? '';
  });
  return text.split(',').filter((id) => id !== '');
}

/**
 * The shop window's box, in UI pixels, or null when it is not open.
 *
 * Measured as well as counted, because "open" and "visible" are two claims and
 * only the second is the one a player makes. A window placed before its stock
 * arrived is placed from a screen that has never been handed anything -- which
 * on a loopback cannot happen and over a socket is a whole round trip.
 */
async function shopBox(page: Page): Promise<Box | null> {
  const text = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-ui-frames]');
    return host?.dataset['uiFrames'] ?? '';
  });
  for (const entry of text.split(';')) {
    const [id, rect] = entry.split(':');
    if (id !== 'shop' || !rect) continue;
    const [x, y, width, height] = rect.split(',').map(Number);
    if (x === undefined || y === undefined || width === undefined || height === undefined) return null;
    return { x, y, width, height };
  }
  return null;
}

/** The bubble: whether it is up, and where its replies are, in UI pixels. */
async function dialogue(page: Page): Promise<{ open: boolean; replies: Box[]; line: string }> {
  const text = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-ui-dialogue]');
    return host?.dataset['uiDialogue'] ?? '';
  });
  const [open, rects, line] = text.split('|');
  const replies: Box[] = [];
  for (const entry of (rects ?? '').split(';')) {
    const [, rect] = entry.split(':');
    if (!rect) continue;
    const [x, y, width, height] = rect.split(',').map(Number);
    if (x === undefined || y === undefined || width === undefined || height === undefined) continue;
    replies.push({ x, y, width, height });
  }
  return { open: open === 'true', replies, line: line ?? '' };
}

async function toCss(page: Page, at: { x: number; y: number }): Promise<{ x: number; y: number } | null> {
  const uiWidth = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-ui-viewport]');
    return Number((host?.dataset['uiViewport'] ?? '').split('x')[0]);
  });
  if (!Number.isFinite(uiWidth) || uiWidth <= 0) return null;
  return page.evaluate(
    ([ux, uy, width]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-ui-canvas]');
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const per = rect.width / (width ?? 1);
      return { x: rect.left + (ux ?? 0) * per, y: rect.top + (uy ?? 0) * per };
    },
    [at.x, at.y, uiWidth] as const,
  );
}

async function crosshair(page: Page): Promise<string> {
  return page.evaluate(() => {
    const node = document.querySelector<HTMLElement>('[data-crosshair]');
    return node?.dataset['crosshair'] ?? 'none';
  });
}

/** Every body the world has drawn, with its screen box. */
async function bodies(page: Page): Promise<{ id: string; x: number; y: number }[]> {
  return page.$$eval('[data-entity]', (nodes) =>
    nodes.map((node) => {
      const box = (node as HTMLElement).getBoundingClientRect();
      return { id: (node as HTMLElement).dataset['entity'] ?? '', x: box.left + box.width / 2, y: box.bottom };
    }),
  );
}

/**
 * Where the body is, in world units (spec 256).
 *
 * `data-self-at` is the sim's own answer -- what the *server* moved the body to,
 * rather than this file's arithmetic on a click -- and it is rounded to whole
 * units, which is a hundredth of the walk being measured.
 */
async function selfAt(page: Page): Promise<{ x: number; y: number }> {
  const text = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-self-at]');
    return host?.dataset['selfAt'] ?? '';
  });
  const [x, y] = text.split(',').map(Number);
  return { x: x ?? 0, y: y ?? 0 };
}

/**
 * Hover every body until the game says one of them is somebody to talk to.
 *
 * The cursor is the game's own answer (spec 246's bubble mark), so this cannot
 * disagree with what a right-click will do -- which a guessed screen offset
 * from the player's own position very much can.
 */
async function findTalkable(page: Page): Promise<{ x: number; y: number } | null> {
  const seen = new Set<string>();
  const look = async (x: number, y: number): Promise<boolean> => {
    await page.mouse.move(x, y);
    await page.waitForTimeout(70);
    const art = await crosshair(page);
    seen.add(art);
    return art === 'bubble';
  };

  // The bodies the HUD has drawn a holder for, first: cheap and exact.
  const found = await bodies(page);
  console.log(`  ${found.length} bodies have a HUD holder`);
  for (const body of found) {
    for (const dy of [0, -12, -24, -36]) if (await look(body.x, body.y + dy)) return { x: body.x, y: body.y + dy };
  }

  // Then a sweep of the frame. A friendly body draws no health bar, so it may
  // have no holder to aim at -- and the cursor is the only thing that knows.
  //
  // Ordered outward from the middle, which is where the camera keeps the
  // player: a merchant close enough to talk to is close enough to be near the
  // centre, so the one worth finding is found in a second or two rather than
  // after a raster scan of the whole frame.
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  const centre = { x: size.width / 2, y: size.height / 2 };
  const points: { x: number; y: number }[] = [];
  for (let y = 120; y < size.height - 120; y += 28) {
    for (let x = 160; x < size.width - 160; x += 28) points.push({ x, y });
  }
  points.sort(
    (a, b) =>
      Math.hypot(a.x - centre.x, a.y - centre.y) - Math.hypot(b.x - centre.x, b.y - centre.y),
  );
  for (const point of points) {
    if (await look(point.x, point.y)) return point;
  }
  console.log(`  the cursor only ever read: ${[...seen].join(', ')}`);
  return null;
}

/**
 * Press reply `index`, and say whether the press registered.
 *
 * The box is re-read immediately before the click and the *line* is checked
 * afterwards, because the speaker walks: the bubble is anchored to a moving
 * body, this environment paints at about five frames a second, and a click
 * aimed at where a button was three frames ago lands on the world. Without the
 * line check a missed click is indistinguishable from a shop that refused to
 * open -- which is exactly how the first version of this probe reported one as
 * the other.
 */
async function pressReply(page: Page, index: number): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = await dialogue(page);
    const reply = before.replies[index];
    if (!reply) {
      await page.waitForTimeout(150);
      continue;
    }
    const css = await toCss(page, {
      x: reply.x + Math.floor(reply.width / 2),
      y: reply.y + Math.floor(reply.height / 2),
    });
    if (!css) return false;
    await page.mouse.move(css.x, css.y);
    await page.mouse.down();
    await page.waitForTimeout(40);
    await page.mouse.up();
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(120);
      const after = await dialogue(page);
      if (after.line !== before.line) return true;
    }
    console.log(`  (the press missed the reply; trying again)`);
  }
  return false;
}

async function main(): Promise<void> {
  const problems: string[] = [];
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const game = spawn('node', ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(GAME_PORT) },
    detached: true,
  });
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`  [page error] ${msg.text()}`);
    });
    await waitForServer(`http://localhost:${GAME_PORT}/`);
    await page.goto(`http://localhost:${PORT}/?server=ws://localhost:${GAME_PORT}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });
    await waitForTick(page, 30);

    // **One click, from wherever the merchant was first spotted** (spec 256).
    //
    // This used to walk first, and said so: the client sent a `Talk` whatever
    // the distance, the server refused it past `talkRadius`, and the refusal is
    // silent -- so a right-click from across the square did nothing at all and
    // the probe had to order its own walk between attempts. That walk is the
    // thing being checked now, so doing it by hand would hide exactly the
    // feature this asserts.
    const found = await findTalkable(page);
    if (!found) {
      problems.push('no body on screen answered the pointer with the talk cursor');
      throw new Error(problems.join('; '));
    }
    console.log(`  a merchant is at (${found.x.toFixed(0)}, ${found.y.toFixed(0)}) and the cursor says so`);

    // Back off first, so the one click below is provably from out of range.
    //
    // Without it the run is at the mercy of where the spawn pad sits: land
    // inside `talkRadius` and the click asks immediately, the bubble opens, and
    // the probe reports a working approach having never made one -- which is
    // the shape of check that goes on passing after the feature is removed. The
    // ground opposite the merchant, because the camera keeps the player in the
    // middle of the frame, so that is directly away from it.
    const frame = page.viewportSize() ?? { width: 1280, height: 800 };
    const behind = {
      x: Math.min(frame.width - 40, Math.max(40, frame.width - found.x)),
      y: Math.min(frame.height - 40, Math.max(40, frame.height - found.y)),
    };
    const stood = await selfAt(page);
    await page.mouse.click(behind.x, behind.y, { button: 'right' });
    await page.waitForTimeout(2500);
    const walkFrom = await selfAt(page);
    console.log(
      `  backed off ${Math.hypot(walkFrom.x - stood.x, walkFrom.y - stood.y).toFixed(0)} units first`,
    );

    // The merchant has moved on screen, so it is found again rather than
    // clicked where it used to be.
    const at = (await findTalkable(page)) ?? found;
    let bubble = { open: false, replies: [] as Box[], line: '' };
    await page.mouse.click(at.x, at.y, { button: 'right' });
    // Poll: this environment paints at about five frames a second under
    // software GL, every readout is published from the frame, and the order now
    // has a walk in front of it -- the merchant can be most of the arena away,
    // so this waits out a walk rather than a round trip.
    for (let i = 0; i < 120 && !bubble.open; i++) {
      await page.waitForTimeout(150);
      bubble = await dialogue(page);
    }
    if (!bubble.open) {
      problems.push('right-clicking the merchant never opened a bubble');
      throw new Error(problems.join('; '));
    }
    console.log('  the bubble is up');
    // The walk is the claim, so it is measured rather than assumed: a probe
    // that happened to spawn inside `talkRadius` would report a working
    // approach without one having happened, and would go on reporting one if
    // the order were removed again.
    const walkedTo = await selfAt(page);
    const walked = Math.hypot(walkedTo.x - walkFrom.x, walkedTo.y - walkFrom.y);
    console.log(`  the body walked ${walked.toFixed(0)} units to get there`);
    if (walked < 1) {
      problems.push('the bubble opened without the body walking: the approach was never made');
    }

    // Wait for the replies, which are withheld while the line is still typing.
    for (let i = 0; i < 80 && bubble.replies.length === 0; i++) {
      await page.waitForTimeout(150);
      bubble = await dialogue(page);
    }
    if (bubble.replies.length === 0) {
      problems.push('the line finished typing and offered no replies');
      throw new Error(problems.join('; '));
    }
    console.log(`  ${bubble.replies.length} replies offered`);

    if (!(await pressReply(page, 0))) {
      problems.push('the first reply could not be pressed');
      throw new Error(problems.join('; '));
    }

    // Did it ever open?
    let opened = false;
    for (let i = 0; i < 40; i++) {
      if ((await openWindows(page)).includes('shop')) { opened = true; break; }
      await page.waitForTimeout(100);
    }
    if (!opened) {
      problems.push('pressing the shop reply never opened the shop window');
      throw new Error(problems.join('; '));
    }
    console.log('  the shop opened');

    // ...and is it still open? This is the whole probe: a window that opens and
    // shuts itself again is what "it only flashes" means, and the check above
    // passes just as happily over it.
    const samples: string[] = [];
    const boxes: string[] = [];
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(150);
      samples.push((await openWindows(page)).includes('shop') ? 'open' : 'shut');
      const box = await shopBox(page);
      boxes.push(box ? `${box.width}x${box.height}` : '-');
    }
    console.log(`  over the next ~1.8s: ${samples.join(' ')}`);
    console.log(`  its box:             ${boxes.join(' ')}`);
    if (samples.some((s) => s === 'shut')) {
      problems.push(`the shop closed itself after opening: ${samples.join(' ')}`);
    } else {
      console.log('  ...and it stayed open');
    }
    // Open and unreadable is the other way this fails, and it is the one a
    // count of open windows cannot see: a window placed before its stock
    // arrived is sized from a screen that was never handed anything.
    const settled = boxes.at(-1) ?? '-';
    const [w, h] = settled.split('x').map(Number);
    if (!w || !h || w < 160 || h < 120) {
      problems.push(`the shop window settled at ${settled}, which is too small to be a shop`);
    } else {
      console.log(`  ...at ${settled}, which is a readable window`);
    }

    // --- and again, which is the case a player actually hits ---------------
    // Shutting the list and pressing the reply a second time. Worth its own
    // look because closing tells the server to stop sending a shop, and that
    // answer is in flight while the next request goes out.
    await page.keyboard.press('Escape');
    for (let i = 0; i < 20; i++) {
      if (!(await openWindows(page)).includes('shop')) break;
      await page.waitForTimeout(100);
    }
    console.log(`  closed with Escape; windows now: ${(await openWindows(page)).join(',') || '(none)'}`);

    // --- and again, from a fresh conversation -----------------------------
    // The second open is worth its own look because closing a shop is itself a
    // request, and its answer is in flight while the next one goes out. Started
    // fresh rather than continued: the line the first press left us on offers a
    // way out and a way round, not a way back in, so pressing "the first reply"
    // there would be testing the script rather than the shop.
    await page.keyboard.press('Escape');
    for (let i = 0; i < 20 && (await dialogue(page)).open; i++) await page.waitForTimeout(100);
    console.log('  left the conversation');

    let reopened = false;
    for (let round = 0; round < 4 && !reopened; round++) {
      const spot = await findTalkable(page);
      if (!spot) break;
      await page.mouse.click(spot.x, spot.y, { button: 'right' });
      let back = await dialogue(page);
      for (let i = 0; i < 20 && back.replies.length === 0; i++) {
        await page.waitForTimeout(150);
        back = await dialogue(page);
      }
      if (back.replies.length === 0) continue;
      if (!(await pressReply(page, 0))) continue;
      for (let i = 0; i < 14 && !reopened; i++) {
        await page.waitForTimeout(120);
        reopened = (await openWindows(page)).includes('shop');
      }
    }
    if (!reopened) {
      problems.push('the shop could not be opened again from a second conversation');
    } else {
      const second: string[] = [];
      const secondBoxes: string[] = [];
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(150);
        second.push((await openWindows(page)).includes('shop') ? 'open' : 'shut');
        const box = await shopBox(page);
        secondBoxes.push(box ? `${box.width}x${box.height}` : '-');
      }
      console.log(`  second open, over ~1.8s: ${second.join(' ')}`);
      console.log(`  its box:                 ${secondBoxes.join(' ')}`);
      if (second.at(-1) !== 'open') {
        problems.push(`the shop did not stay open the second time: ${second.join(' ')}`);
      } else {
        console.log('  ...and the second open stayed too');
      }
    }
  } finally {
    await browser.close();
    server.kill();
    // Its own process group, so the whole tree goes: `node --import tsx` is one
    // process, but a stray listener would hold the port for the next run --
    // which `probe-admin-console.ts` records reporting as a green run against
    // older code.
    if (game.pid !== undefined) {
      try {
        process.kill(-game.pid, 'SIGTERM');
      } catch {
        game.kill();
      }
    }
  }

  if (problems.length > 0) {
    console.error('\nproblems:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nthe shop opens from a conversation and stays open.');
}

void main();
