/**
 * Read a sign in the shipped page (spec 259).
 *
 * Everything this spec *decides* is pure and asserted in Node -- what a sign
 * says, which post the cursor named, how close the body has to get, what the
 * bubble is handed, and that nothing sounds. This is the half no headless test
 * can reach, and it is the half this repo keeps rediscovering: **the wiring.**
 * A new reading of `world.order` cannot fail a typecheck and cannot fail a
 * headless test, so every rule above could be green beside a `view.ts` that
 * calls none of them -- which is exactly what spec 176 found for markers and
 * spec 224's own probe was written for.
 *
 *   npm run build && npx tsx scripts/probe-sign.ts
 *
 * Three things about how it is staged.
 *
 * **It puts a sign on the map itself**, backing up `maps/arena.json` and
 * restoring it at the end. There is none on the shipped map -- this spec adds
 * the ability to place one, not a village full of them -- and a probe that
 * needed somebody to have placed one first would be a probe nobody runs.
 *
 * **The sign is written before the game server starts, and the page is the
 * built one.** With `?server=` the client's terrain comes off the wire
 * (spec 072), so what the page draws is whatever the *server* loaded from disk
 * -- which means `dist/` needs no rebuild and what is probed is still what
 * ships. Editing the map after a build would be invisible only to the in-tab
 * loopback, which is not what this runs against.
 *
 * **The sign is found with the cursor**, never at a guessed screen point:
 * `data-crosshair` reading `sign` is the game's own answer to "that is
 * something you can read", so the sweep cannot disagree with what the click
 * will do. `probe-shop.ts`'s rule, and it is worth more here, because the mark
 * being drawn at all is one of the things being checked.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { loadMap, parseMap, type Prop } from '../src/terrain/index.js';
import { splitMap } from '../src/terrain/regions.js';
import { DEFAULT_MAP_PATH, loadMapFile } from '../src/server/world/map-file.js';
import { writeSplit } from './split-map.js';
import { DEFAULT_SPAWN } from '../src/server/player/player-manager.js';
import { BUBBLE_LIFT } from '../src/ui/screens/dialogue.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP = join(root, DEFAULT_MAP_PATH);
const BACKUP = join(root, 'maps/.arena-probe-sign-backup');
const PORT = 4341;
const GAME_PORT = 4342;

/** What the sign is placed saying. Distinctive, so a readout cannot half-match. */
const MESSAGE = 'The bridge is out. Take the high road.';

/**
 * How far from the spawn pad the sign stands.
 *
 * Far enough that the body has to **walk**, which is the half of the order this
 * probe exists to check: `SIGN_READ_RADIUS` is under a hundred units, so a sign
 * placed on top of the player would open its bubble with the order never having
 * moved anything and the probe would go on passing after the walk was removed.
 * Near enough that it is on screen at the camera's default framing, since the
 * cursor sweep can only find what is drawn.
 */
const SIGN_OFFSET = 260;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
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

/**
 * Put a sign near the spawn pad, and say where it went.
 *
 * Through the repo's own `loadMapFile` / `splitMap` / `writeSplit`, which is
 * `place-npc.ts`'s chain and for its reason: the store is what files a prop
 * into the right chunk, and the split is what the server reads. A prop written
 * into the wrong chunk is a sign nothing ever streams.
 */
function placeSign(): { x: number; y: number } {
  const document = loadMapFile(DEFAULT_MAP_PATH).doc;
  const loaded = loadMap(document);
  const layer = document.layers[0]?.id;
  if (layer === undefined) throw new Error('the map has no layers');
  const info = loaded.store.layerInfo(layer);
  if (!info) throw new Error('the first layer is not loaded');

  // Tried in a ring, because the spawn village has huts in it and a sign inside
  // one is a sign nothing can see. Solid ground is the only requirement the
  // editor's own tool has; the clearance beside it is this probe's, since a
  // board behind a wall is one the cursor sweep cannot find.
  for (let step = 0; step < 32; step++) {
    const angle = (step / 32) * Math.PI * 2;
    const x = DEFAULT_SPAWN.x + Math.cos(angle) * SIGN_OFFSET;
    const y = DEFAULT_SPAWN.y + Math.sin(angle) * SIGN_OFFSET;
    const col = Math.floor((x - info.origin.x) / loaded.store.cellSize);
    const row = Math.floor((y - info.origin.z) / loaded.store.cellSize);
    if (!loaded.store.cellSolid(layer, col, row)) continue;
    if (loaded.store.propsWithin(layer, x, y, 140).length > 0) continue;
    const prop: Prop = { kind: 'sign', x, y, scale: 1, rotation: 0, tint: 0, text: MESSAGE };
    if (!loaded.store.addProp(layer, prop)) continue;
    // Through the parser before anything is written, the rule `place-npc.ts`
    // and `dev-map-write.ts` both state: the map the server boots from must not
    // be replaceable by something that will not load.
    const split = splitMap(parseMap(JSON.stringify(loaded.store.toDocument())));
    mkdirSync(MAP, { recursive: true });
    writeSplit(MAP, split.manifest, split.regions);
    return { x, y };
  }
  throw new Error('nowhere clear near the spawn pad to stand a sign');
}

async function crosshair(page: Page): Promise<string> {
  return page.evaluate(() => {
    const node = document.querySelector<HTMLElement>('[data-crosshair]');
    return node?.dataset['crosshair'] ?? 'none';
  });
}

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/**
 * The bubble: whether it is up, the line it is showing, and its own box.
 *
 * The **line is punctuation-stripped** by the readout -- `|;:,` all become
 * spaces, because those are the separators the attribute itself is built from
 * -- so what is compared against it downstream has to go through the same
 * flattening. Getting that wrong is how the first run of this probe reported a
 * perfectly correct bubble as showing something else.
 */
async function dialogue(page: Page): Promise<{ open: boolean; line: string; box: Box | null }> {
  const text = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-ui-dialogue]');
    return host?.dataset['uiDialogue'] ?? '';
  });
  const [open, , line, rect] = text.split('|');
  let box: Box | null = null;
  if (rect) {
    const [x, y, width, height] = rect.split(',').map(Number);
    if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
      box = { x, y, width, height };
    }
  }
  return { open: open === 'true', line: line ?? '', box };
}

/** What the readout would make of a string. See {@link dialogue}. */
function flattened(text: string): string {
  return text.replace(/[|;:,]/g, ' ');
}

/** A UI-pixel point in CSS pixels, so the mouse can be aimed at it. */
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

async function orders(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-orders]');
    return host?.dataset['orders'] ?? '';
  });
}

async function selfAt(page: Page): Promise<{ x: number; y: number }> {
  const text = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-self-at]');
    return host?.dataset['selfAt'] ?? '';
  });
  const [x, y] = text.split(',').map(Number);
  return { x: x ?? 0, y: y ?? 0 };
}

/**
 * Sweep the frame until the cursor says it is over a sign.
 *
 * Ordered outward from the middle, which is where the camera keeps the player,
 * so the one worth finding is found in a second or two rather than after a
 * raster scan. Every art the cursor took is remembered, because "it never said
 * `sign`" and "it never said anything" are two different failures: the first is
 * a mark that is not being drawn and the second is a page that is not drawing.
 */
async function findSign(page: Page): Promise<{ point: { x: number; y: number } | null; seen: Set<string> }> {
  const seen = new Set<string>();
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  const centre = { x: size.width / 2, y: size.height / 2 };
  const points: { x: number; y: number }[] = [];
  for (let y = 90; y < size.height - 90; y += 22) {
    for (let x = 120; x < size.width - 120; x += 22) points.push({ x, y });
  }
  points.sort(
    (a, b) => Math.hypot(a.x - centre.x, a.y - centre.y) - Math.hypot(b.x - centre.x, b.y - centre.y),
  );
  for (const point of points) {
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(45);
    const art = await crosshair(page);
    seen.add(art);
    if (art === 'sign') return { point, seen };
  }
  return { point: null, seen };
}

/**
 * Put the committed map back.
 *
 * The whole directory, removed and copied rather than overwritten: a save
 * writes a manifest and a set of region files, and a restore that only replaced
 * what it recognised would leave behind whichever region the sign's own chunk
 * had been split into.
 */
/**
 * Hover down from where the bubble is pointing, and say where the mark caught.
 *
 * The check the first cut of this probe did not have, and the bug it did not
 * catch: the pick volume was built assuming the ground was at world Y zero, so
 * on the arena's terrain -- hundreds of units up -- it sat entirely underneath
 * the sign. The board answered nothing at all, and a ray that passed through
 * the buried column on its way down answered `sign` over open ground. A sweep
 * that only asks "did anything anywhere read sign" reports that as a pass,
 * which is exactly what it did.
 *
 * The anchor is where the game itself says the sign is: the bubble hangs
 * `BUBBLE_LIFT` above the point `projectPoint` returned for the board, so
 * reading it back off the box gives the sign's own screen position without this
 * file guessing one. Scanned **downward**, because the anchor is
 * `SIGN_BUBBLE_LIFT` world units up and the board is just below it.
 */
async function markDistance(page: Page, box: Box): Promise<number> {
  const anchor = await toCss(page, {
    x: box.x + Math.floor(box.width / 2),
    y: box.y + box.height + BUBBLE_LIFT,
  });
  if (!anchor) return Number.POSITIVE_INFINITY;
  for (let down = 0; down <= 320; down += 8) {
    await page.mouse.move(anchor.x, anchor.y + down);
    await page.waitForTimeout(60);
    if ((await crosshair(page)) === 'sign') return down;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * How far below the anchor the mark may be found and still be *on the sign*.
 *
 * **Measured, not chosen.** `SIGN_BUBBLE_LIFT` puts the anchor 18 world units
 * above the top of the board, which at the zoom a conversation frames itself at
 * is a few dozen pixels -- so the mark is found at the anchor itself. With the
 * base assumed to be zero it was found **104 pixels** further down, on the
 * patch of ground the buried column happened to intersect. Both numbers came
 * off this probe against this map; the bound sits between them with room, and
 * a mark a hundred pixels down the screen from the board is not on the board
 * whatever else it is on.
 */
const MARK_ON_SIGN_PX = 48;

function restoreMap(): void {
  if (!existsSync(BACKUP)) return;
  rmSync(MAP, { recursive: true, force: true });
  cpSync(BACKUP, MAP, { recursive: true });
  rmSync(BACKUP, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const problems: string[] = [];
  /** One named assertion, with what was actually seen beside it. */
  const check = (what: string, ok: boolean, detail: string): void => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what} \u2014 ${detail}`);
    if (!ok) problems.push(what);
  };

  // The backup first, and the restore in a `finally` below: a probe that left
  // a sign in the committed map would be a probe that edits the world.
  rmSync(BACKUP, { recursive: true, force: true });
  cpSync(MAP, BACKUP, { recursive: true });
  let sign = { x: 0, y: 0 };
  try {
    sign = placeSign();
  } catch (error) {
    restoreMap();
    throw error;
  }
  console.log(`  a sign stands at (${sign.x.toFixed(0)}, ${sign.y.toFixed(0)}), saying "${MESSAGE}"`);

  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  // Started *after* the map is written, which is the whole staging: with
  // `?server=` the client's terrain comes off the wire, so what the page draws
  // is whatever this process read from disk at boot.
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

    // Through the front door (spec 255). That overlay is `inset: 0`, so every
    // click below lands on it until Start has taken it away -- and the cursor
    // still works through it, so the failure reads as "the sign is right there
    // and clicking it does nothing".
    await page.waitForSelector('[data-title][data-title-ready="true"]', { timeout: 120_000 });
    await page.click('[data-title-entry="start"]', { position: { x: 6, y: 6 } });
    await page.waitForSelector('[data-title]', { state: 'detached', timeout: 30_000 });
    console.log('  through the title screen');
    await waitForTick(page, 30);

    // The control, and it is worth as much as the measurement: a probe whose
    // "after" is right and whose "before" was never checked cannot tell a
    // working feature from a page that marks everything.
    const before = await dialogue(page);
    if (before.open) problems.push('a bubble was already open before anything was clicked');

    let bubble: { open: boolean; line: string; box: Box | null } = { open: false, line: '', box: null };
    let walked = 0;
    let sawMark = false;
    let ordered = '';
    const walkFrom = await selfAt(page);
    const deadline = Date.now() + 420_000;

    for (let attempt = 0; !bubble.open && Date.now() < deadline; attempt++) {
      // Found again on every attempt: the camera follows the body, and this
      // environment paints at about five frames a second under software GL, so
      // a screen point is stale the moment it is measured.
      const { point, seen } = await findSign(page);
      if (!point) {
        console.log(`  (the cursor has only ever read: ${[...seen].join(', ')})`);
        await page.waitForTimeout(1000);
        continue;
      }
      sawMark = true;
      console.log(`  the cursor says "sign" at (${point.x.toFixed(0)}, ${point.y.toFixed(0)})`);
      await page.mouse.click(point.x, point.y, { button: 'right' });

      // `data-orders` is the game's own answer to "the click armed something",
      // and it is what separates a missed click from a walk still in progress
      // -- in a closed bubble those look identical.
      for (let i = 0; i < 8 && !ordered.includes('sign'); i++) {
        await page.waitForTimeout(120);
        ordered = await orders(page);
      }

      // Then wait out a *walk* rather than a round trip, and let the orders say
      // when to stop: there is no message in flight, so the order going away
      // with no bubble is the honest end of the attempt.
      for (let i = 0; i < 900 && !bubble.open; i++) {
        await page.waitForTimeout(150);
        bubble = await dialogue(page);
        if (bubble.open) break;
        const now = await orders(page);
        if (ordered.includes('sign') && !now.includes('sign') && !now.includes('walk')) break;
      }
      const to = await selfAt(page);
      walked = Math.hypot(to.x - walkFrom.x, to.y - walkFrom.y);
      if (!bubble.open) console.log(`  (attempt ${attempt + 1}: orders read "${ordered}", walked ${walked.toFixed(0)})`);
    }

    if (!sawMark) problems.push('no cursor anywhere on screen ever read "sign"');
    if (!ordered.includes('sign')) problems.push('a click on the sign armed no order');
    if (!bubble.open) problems.push('the bubble never opened');

    // **The walk is the feature**, so it is measured rather than assumed: a run
    // that opened the bubble without moving has not seen the order at all and
    // would go on passing after it was removed.
    console.log(`  walked ${walked.toFixed(0)} units to reach it`);
    if (bubble.open && walked < 40) {
      problems.push(`the bubble opened without walking (${walked.toFixed(0)} units)`);
    }

    // And the words are the sign's own, not an NPC's: the readout is what the
    // bubble is *showing*, so a driver that opened somebody else's line would
    // be caught here rather than reported as a working sign.
    const want = flattened(MESSAGE);
    let settled = bubble;
    if (bubble.open) {
      console.log(`  the bubble opens reading: "${bubble.line}"`);
      // The reveal is a character at a time, so it is **waited out** rather
      // than given a constant: a 38-character line at this voice's rate takes
      // several seconds, and this page paints at about five frames a second
      // under software GL. What ends the wait is the line settling, which is
      // also what a player watches for.
      for (let i = 0; i < 200; i++) {
        await page.waitForTimeout(150);
        const now = await dialogue(page);
        if (!now.open) break;
        if (now.line === settled.line && now.line.endsWith(want)) {
          settled = now;
          break;
        }
        settled = now;
      }
      if (!settled.open) problems.push('the bubble closed itself while it was still revealing');
      // `endsWith` rather than an equality, because the readout puts the
      // speaker's name in front of the line -- which is itself worth checking,
      // since a bubble with no speaker draws nothing at all.
      else if (!settled.line.endsWith(want)) {
        problems.push(`the bubble never showed the sign's words: "${settled.line}"`);
      } else if (!settled.line.startsWith('Sign')) {
        problems.push(`the bubble names no speaker: "${settled.line}"`);
      } else {
        console.log(`  and settles on: "${settled.line}"`);
      }
    }

    // --- the two things a screenshot cannot settle ------------------------
    //
    // **The mark is on the sign**, not on the ground near it. This is the check
    // the first cut of this probe did not have, and the bug it did not catch:
    // the pick volume was built assuming the ground was at world Y zero, so on
    // the arena's terrain -- hundreds of units up -- it sat entirely underneath
    // the sign. The board answered nothing at all, and a ray that passed
    // through the buried column on its way down answered `sign` over open
    // ground. A sweep that only asks "did anything anywhere read sign" reports
    // that as a pass, which is exactly what it did.
    //
    // The anchor is where the game itself says the sign is: the bubble hangs
    // `BUBBLE_LIFT` above the point `projectPoint` returns for the board, so
    // reading it back off the box gives the sign's own screen position without
    // this file guessing one. Scanned **downward**, because the anchor is
    // `SIGN_BUBBLE_LIFT` world units up and the board is just below it.
    if (settled.open && settled.box) {
      const away = await markDistance(page, settled.box);
      check(
        'the mark is on the sign the bubble is pointing at',
        away <= MARK_ON_SIGN_PX,
        Number.isFinite(away) ? `${away}px below the anchor` : 'never read sign',
      );
    }

    // **The bubble stays with the sign when the camera zooms in.**
    //
    // Asked as the check above asked over again, rather than by looking at
    // where the box ended up: if the anchor is dropped the bubble falls back to
    // its no-anchor placement -- centred and low -- and a scan down from *that*
    // box's middle finds no sign, whichever corner of the frame it landed in.
    // One assertion for both halves of what zooming can break.
    //
    // What this deliberately does not claim is to reproduce the flip. Measured
    // at the shipped camera limits, the anchor lands within `projectPoint`'s
    // own 80-pixel margin of the top of the frame however far the wheel is
    // turned -- the camera's span floors at 200 and the dialogue framing at
    // 150, and how far the anchor rides above the speaker is a fixed fraction
    // of the frame from there. The reproduction is `bubbleAnchor`'s own test;
    // this is the guard that the mount still calls it.
    if (settled.open) {
      await page.mouse.move(640, 400);
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, -300);
        await page.waitForTimeout(140);
      }
      await page.waitForTimeout(900);
      const zoomed = await dialogue(page);
      check('the bubble is still up after the camera zooms in', zoomed.open, zoomed.line || 'gone');
      const away = zoomed.box === null ? Number.POSITIVE_INFINITY : await markDistance(page, zoomed.box);
      check(
        'and still points at the sign rather than falling to the bottom of the frame',
        away <= MARK_ON_SIGN_PX,
        zoomed.box ? `box at ${zoomed.box.x.toFixed(0)},${zoomed.box.y.toFixed(0)}, mark ${away}px below` : 'no box',
      );
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(120);
      }
      await page.waitForTimeout(900);
      settled = await dialogue(page);
    }

    // And it closes on a press, since a sign has no replies -- pressed on the
    // **bubble's own box** rather than at a guessed offset from the sign: a
    // line with no replies has no other handle, which is why that box is
    // published at all.
    if (settled.open && settled.box) {
      const css = await toCss(page, {
        x: settled.box.x + Math.floor(settled.box.width / 2),
        y: settled.box.y + Math.floor(settled.box.height / 2),
      });
      if (!css) problems.push('the interface canvas could not be found to press the bubble');
      else {
        await page.mouse.click(css.x, css.y);
        let closed = false;
        for (let i = 0; i < 20 && !closed; i++) {
          await page.waitForTimeout(150);
          closed = !(await dialogue(page)).open;
        }
        if (!closed) problems.push('the bubble would not close on a press');
        else console.log('  and it closes on a press');
      }
    } else if (settled.open) {
      problems.push('the bubble is open and publishes no box, so nothing could press it');
    }
  } finally {
    await browser.close();
    server.kill();
    try {
      if (game.pid !== undefined) process.kill(-game.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    restoreMap();
    console.log('  the map is back as it was');
  }

  if (problems.length > 0) {
    console.log(`\nFAIL\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nOK: a sign on the map is marked, walked to, read, and closed');
}

await main();
