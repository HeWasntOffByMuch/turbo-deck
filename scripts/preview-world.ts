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
import { chromium, type ElementHandle, type Page } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4319;

/**
 * How far beside a body the "this is bare ground" click lands, in CSS pixels.
 *
 * A body twenty world units across is about eighty pixels wide at the default
 * framing, so this is comfortably past its edge -- and the click is only made
 * when no other bar is within reach of it, so picking nothing means the ground
 * is free rather than that the neighbour was missed too. What the pick's reach
 * *is* belongs to `hover.test.ts`, which pins it exactly; this asks only whether
 * the ground beside a body is still ground once a browser is delivering the
 * clicks (spec 095).
 */
const GAP_OFFSET = 70;

/**
 * How far a candidate pixel must be from every *other* body's bar, in CSS
 * pixels, for a pick there to mean anything.
 *
 * A body is about eighty pixels across at the default framing, so a neighbour
 * whose bar is merely {@link GAP_OFFSET} away still has half its body over the
 * pixel being tried. This is that width plus the offset, which is the distance
 * at which "nothing was picked" is a statement about the ground rather than
 * about which of two bodies got there first.
 */
const GAP_CLEARANCE = 110;

/**
 * How near a body's click point another body may be and still plausibly own it,
 * in CSS pixels.
 *
 * A twenty-unit footprint is forty pixels across the middle at the default
 * framing, so anything nearer than this could legitimately have been what the
 * click picked. Used only to tell "the pick reached too far" apart from "a
 * monster walked onto the pixel between the read and the click" -- the world
 * does not hold still for a screenshot harness.
 */
const DRIFT_MARGIN = 50;

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
  /** True for the local player's own bar, which no click may attack. */
  readonly self: boolean;
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
      return {
        id: element.dataset['entity'] ?? '',
        x: element.offsetLeft,
        y: element.offsetTop,
        self: element.dataset['self'] !== undefined,
      };
    }),
  );
}

/**
 * Every overlay element carrying `attribute`, by the value of it.
 *
 * Read off `style.left` rather than `offsetLeft` because these are placed to
 * fractions of a pixel and the drift being measured is a few of them; elements
 * the HUD has hidden are dropped, since a hidden number's last position is not
 * a position.
 */
async function overlayPoints(
  page: Page,
  attribute: string,
): Promise<Map<string, { x: number; y: number }>> {
  const found = await page.$$eval(
    `[${attribute}]`,
    (nodes, name) =>
      nodes
        .map((node) => node as HTMLElement)
        .filter((element) => element.style.display !== 'none')
        .map((element) => ({
          key: element.getAttribute(name) ?? '',
          x: parseFloat(element.style.left || '0'),
          y: parseFloat(element.style.top || '0'),
        })),
    attribute,
  );
  return new Map(found.map((point) => [point.key, { x: point.x, y: point.y }]));
}

/** The pixel to point at for a body, given the bar floating over its head. */
function bodyPoint(bar: Bar): { x: number; y: number } {
  // The bar hangs at the top of the head, so a drop of forty pixels is inside
  // the column the body stands in whichever monster the field seeded.
  return { x: bar.x, y: bar.y + 40 };
}

/**
 * Click a body at the pixel it is on *now*, and say whether it was still there.
 *
 * The bar is re-read immediately before the click rather than carried over from
 * a screenshot or a readout poll. A body being chased and swung at moves tens of
 * pixels while this harness is reading text off the page, and since spec 095 a
 * pick is the body itself rather than a budget around it -- so a pixel that is a
 * fifth of a second old is a miss, and a miss here is the harness's fault rather
 * than the game's.
 */
async function clickBody(page: Page, id: string, button: 'left' | 'right'): Promise<boolean> {
  const bar = (await bodiesOnScreen(page)).find((candidate) => candidate.id === id);
  if (!bar) return false;
  const point = bodyPoint(bar);
  await page.mouse.click(point.x, point.y, { button });
  return true;
}

/**
 * A pixel {@link GAP_OFFSET} to one side of `bar`, clear of every body including
 * `bar` itself, or null when this frame has no such pixel beside it.
 *
 * Both sides are offered because the monsters are placed by the map (spec 076)
 * rather than seeded in a row, so which side is clear is not knowable in advance.
 */
function gapBeside(bar: Bar, others: readonly Bar[]): { x: number; y: number } | null {
  const point = bodyPoint(bar);
  for (const side of [1, -1]) {
    const candidate = { x: point.x + side * GAP_OFFSET, y: point.y };
    // The body this is beside is excluded: being GAP_OFFSET from it is the
    // whole point, and it is the neighbours that would spoil the answer.
    const neighbours = others.filter((other) => other.id !== bar.id);
    if (nearestBody(candidate, neighbours).distance >= GAP_CLEARANCE) return candidate;
  }
  return null;
}

/**
 * A monster the player's own body is not standing in front of, or null.
 *
 * The player stands in melee contact with whatever it is fighting, and its rig
 * is between the camera and that body -- so the pixel over the monster is a
 * pixel over the *player*, and a click there is a move order however forgiving
 * the pick is. Picking the body furthest from the player's own bar is how this
 * harness asks its question about a monster rather than about occlusion.
 */
function unoccludedBody(bars: readonly Bar[]): Bar | null {
  const me = bars.find((bar) => bar.self);
  let best: Bar | null = null;
  let bestDistance = -1;
  for (const bar of bars) {
    if (bar.self) continue;
    const point = bodyPoint(bar);
    // On screen with room to spare: a bar at the edge is a body half off it.
    if (point.x < 60 || point.x > 1220 || point.y < 60 || point.y > 740) continue;
    const distance = me ? Math.hypot(me.x - bar.x, me.y - bar.y) : 0;
    if (distance <= bestDistance) continue;
    best = bar;
    bestDistance = distance;
  }
  return best;
}

/** The body whose click point is nearest a pixel, and how far off it is. */
function nearestBody(point: { x: number; y: number }, bars: readonly Bar[]): { who: string; distance: number } {
  let best = { who: 'nobody', distance: Infinity };
  for (const bar of bars) {
    const distance = Math.hypot(bar.x - point.x, bar.y + 40 - point.y);
    if (distance < best.distance) best = { who: bar.id, distance };
  }
  return best;
}

/**
 * How far beside a body a right-click can land and still pick it (spec 071).
 *
 * Measured rather than asserted: the body's drawn size depends on the zoom and
 * on which monster the field happened to seed, so the honest thing to report is
 * the number, not a pass against a threshold this script would have to guess.
 * Each attempt drops the target on bare grass first, or a click that picked
 * nothing would look exactly like one that re-picked the same unit.
 */
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

/**
 * Waits until a body's bar stops moving on screen, and returns where it settled.
 *
 * Every click this harness aims at a body is aimed at a *pixel*, and the camera
 * follows the player with 130ms of lag (spec 039) -- so a bar read while the
 * player is still walking names a pixel the body has already left. Polling until
 * two readings agree is the only honest way to ask "where is it now", and it is
 * what separates a forgiving pick that missed from a harness that did.
 */
async function settledBar(page: Page, id: string, timeoutMs = 4000): Promise<Bar | null> {
  const deadline = Date.now() + timeoutMs;
  let last = (await bodiesOnScreen(page)).find((bar) => bar.id === id) ?? null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(120);
    const now = (await bodiesOnScreen(page)).find((bar) => bar.id === id) ?? null;
    if (!now) return null;
    if (last && Math.abs(now.x - last.x) <= 1 && Math.abs(now.y - last.y) <= 1) return now;
    last = now;
  }
  return last;
}

/**
 * The bottom line of the readout: what the next click does (spec 080).
 *
 * Polled rather than read once, because the line is written during a *frame*
 * and this harness runs on software WebGL where a frame is not a formality. A
 * single read a couple of hundred milliseconds after a click was reporting the
 * state before it, which is a stopwatch failing rather than the game.
 */
async function waitForAim(page: Page, wanted: RegExp, timeoutMs = 4000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let seen = '';
  while (Date.now() < deadline) {
    const text = (await page.textContent('body')) ?? '';
    seen =
      /(aiming [^\n]*|[\w ]+: moving into range[^\n]*|right-click ground to move[^\n]*)/.exec(
        text,
      )?.[1] ?? '';
    if (wanted.test(seen)) return seen;
    await page.waitForTimeout(120);
  }
  return seen;
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

/** A screenshot decoded to pixels. Screenshots are PNGs -- comparing the
 * compressed bytes says nothing about what is on screen. */
async function pixelsOf(page: Page): Promise<PNG> {
  return PNG.sync.read(await page.screenshot());
}

/** How many pixels differ between two decoded frames. */
function differingPixels(a: PNG, b: PNG): number {
  let n = 0;
  for (let i = 0; i < a.data.length && i < b.data.length; i += 4) {
    const dr = Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));
    const dg = Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0));
    const db = Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
    if (Math.max(dr, dg, db) > 8) n++;
  }
  return n;
}

/** Mean channel value over a box of a decoded frame, 0-255. */
function meanBrightness(png: PNG, left: number, top: number, width: number, height: number): number {
  let total = 0;
  let n = 0;
  for (let y = Math.max(0, Math.round(top)); y < Math.min(png.height, Math.round(top + height)); y++) {
    for (let x = Math.max(0, Math.round(left)); x < Math.min(png.width, Math.round(left + width)); x++) {
      const i = (y * png.width + x) * 4;
      total += ((png.data[i] ?? 0) + (png.data[i + 1] ?? 0) + (png.data[i + 2] ?? 0)) / 3;
      n++;
    }
  }
  return n > 0 ? total / n : 0;
}

/** A pixel with no body anywhere near it, for parking the cursor. */
function emptyPixel(bars: readonly Bar[]): { x: number; y: number } {
  let best = { x: 640, y: 400 };
  let bestDistance = -1;
  for (let y = 120; y <= 620; y += 40) {
    for (let x = 120; x <= 1160; x += 40) {
      const distance = nearestBody({ x, y }, bars).distance;
      if (distance <= bestDistance) continue;
      best = { x, y };
      bestDistance = distance;
    }
  }
  return best;
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

    // Pinned. Without a `seed` in the query the view falls back to `Date.now()`
    // (`iso3d/seed.ts`), so every run photographed a different world and the
    // checks that depend on where bodies happen to stand -- the forgiving pick
    // most of all -- passed or failed by the clock. A harness whose answer moves
    // between runs cannot tell a regression from a Tuesday.
    await page.goto(`http://localhost:${PORT}/?seed=20260806`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    // Two waits, because they are two different facts.
    //
    // The world is streamed now (spec 072): terrain arrives chunk by chunk and
    // the prop field is batched once the stream settles, all of it *during*
    // frames rather than before the first one. So ticks advance over a world
    // that is still half-drawn, and waiting on the tick counter alone put this
    // harness's clicks into a field where the bodies were not yet where they
    // would end up -- which showed up as right-click targeting "finding
    // nothing". The view says when it is done; wait for that first.
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });
    // ...and then for the sim to have run far enough to be worth photographing.
    // Polled from here rather than in-page: it is the same fact the player
    // reads, and a failure says which tick it got stuck at.
    await waitForTick(page, 150);

    await shoot(page, 'world-play');

    // The spawner overlay (spec 076): open the cog, tick "Spawners", and
    // photograph what the map placed. Every enemy on screen came from one of
    // these markers, so a frame with bodies and no marks would mean the
    // overlay is lying about where they came from.
    await page.click('button[aria-label="View settings"]');
    await page.waitForTimeout(120);
    await page.click('label:has-text("Spawners") input[type=checkbox]');
    await page.waitForTimeout(400);
    const marks = await page.$$eval('div', (nodes) =>
      nodes.filter((n) => / · |^(grazer|stalker|ravager)$/.test(n.textContent ?? '')).length,
    );
    console.log(`  spawner marks drawn: ${marks}`);
    if (marks === 0) problems.push('the spawner overlay drew nothing');
    await shoot(page, 'world-spawners');
    await page.click('label:has-text("Spawners") input[type=checkbox]');
    await page.click('button[aria-label="View settings"]');
    // The weather panel (spec 075): its own button beside the view cog. Opened
    // and driven here rather than trusted, because the sliders write straight
    // into the shared wind uniforms -- a wiring mistake would leave a panel that
    // looks perfect and moves nothing.
    await page.click('button[aria-label="Weather"]');
    await page.waitForTimeout(150);
    await shoot(page, 'world-weather-panel');
    const windSliders = await page.$$('button[aria-label="Weather"] ~ div input[type=range]');
    console.log(`  weather sliders: ${windSliders.length}`);
    const [strengthSlider, , speedSlider] = windSliders;
    if (!strengthSlider || !speedSlider) {
      problems.push('the weather panel is missing its wind strength or speed slider');
    } else {
      const setSlider = async (handle: ElementHandle<SVGElement | HTMLElement>, value: string): Promise<void> => {
        await handle.evaluate((el, v) => {
          const input = el as HTMLInputElement;
          input.value = v === 'max' ? input.max : v;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, value);
        await page.waitForTimeout(400);
      };

      // The world is live, so "the frame changed" is true at any wind at all.
      // Stilling the *clock* first removes every other moving thing the weather
      // owns -- the water, the streaks over the ground -- and leaves the lean as
      // the only thing the strength slider can be changing.
      await setSlider(speedSlider, '0');
      await setSlider(strengthSlider, '0');
      const upright = await pixelsOf(page);
      const uprightAgain = await pixelsOf(page);
      await setSlider(strengthSlider, 'max');
      await shoot(page, 'world-weather-strong');
      const leaning = await pixelsOf(page);

      // Two shots at the same setting are the control. Even stilled, a live
      // world is a noisy place to measure in -- the torch gutters, the monsters
      // walk, and the retro pass redithers all of it -- so this asks only for a
      // clear margin over that floor, not for a clean number. The clean numbers
      // live in `preview-wind.ts`, which draws a frozen scene with nothing in it
      // but ground and trees.
      const control = differingPixels(upright, uprightAgain);
      const swayed = differingPixels(upright, leaning);
      console.log(`  pixels moving with the wind stilled:     ${control}`);
      console.log(`  ...and with the strength at its ceiling: ${swayed} (${(swayed / Math.max(1, control)).toFixed(2)}x)`);
      if (swayed < control * 1.25) problems.push('the wind strength slider did not visibly bend the trees');

      // Put both back, so every later screenshot is the shipped weather.
      await setSlider(strengthSlider, '100');
      await setSlider(speedSlider, '100');
    }
    await page.click('button[aria-label="Weather"]');
    await page.waitForTimeout(120);

    // Right-click a point on the ground: the move order the game had before the
    // server existed (spec 064). The marker should appear and the figure walk to it.
    await page.mouse.click(420, 560, { button: 'right' });
    await page.waitForTimeout(500);
    await shoot(page, 'world-move-order');
    await page.waitForTimeout(1400);
    await shoot(page, 'world-walking');

    // A hotbar press is a question now (spec 080), not the commitment. The
    // shape of the blow goes on the ground and nothing has been asked for
    // until a click answers it.
    await page.mouse.move(820, 330);
    await page.waitForTimeout(200);
    await page.keyboard.press('Digit2');
    const aimed = await waitForAim(page, /^aiming Heavy Blow/);
    await shoot(page, 'world-aim-cone');
    if (!/^aiming Heavy Blow/.test(aimed)) {
      problems.push(`pressing 2 did not start an aim (readout: ${aimed})`);
    }

    // Right-click over an aim means *no*, and only that: it goes away, and
    // nothing was spent, moved toward or attacked.
    const tickAtCancel = await readTick(page);
    await page.mouse.click(820, 330, { button: 'right' });
    const cancelled = await waitForAim(page, /^right-click ground/);
    if (/^aiming /.test(cancelled)) {
      problems.push('right-click did not cancel the aim');
    }
    // ...and it really did move nothing: a cancel that fell through to a move
    // order would have put a marker on the ground and started a walk.
    if (((await page.textContent('body')) ?? '').includes('Heavy Blow: moving into range')) {
      problems.push('right-click turned the aim into an order instead of cancelling it');
    }
    await shoot(page, 'world-aim-cancelled');
    console.log(`  ticks while cancelling an aim: ${(await readTick(page)) - tickAtCancel}`);

    // ...and again, answered this time. Placed close to the body so the confirm
    // is a commitment rather than a walk, which is what this frame is of: the
    // bar, and the body turning into the blow at its own turn rate.
    await page.keyboard.press('Digit2');
    await waitForAim(page, /^aiming Heavy Blow/);
    await page.mouse.click(700, 430);
    // Confirming consumes the aim, so the question comes off the readout --
    // either for an order that is still walking, or because the blow is already
    // committed and the order is spent.
    const confirmed = await waitForAim(page, /^(right-click ground|Heavy Blow: moving)/);
    await shoot(page, 'world-windup');
    if (/^aiming /.test(confirmed)) {
      problems.push('a left-click did not confirm the aim');
    }

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

      // Now the same order, given badly (spec 071): let the body go, then take
      // it again from a pixel that is beside it rather than on it. Done here,
      // before the screenshots, because the alternative is measuring how long
      // the body survived being attacked -- an earlier version of this waited,
      // and reported a failure that was really a dead grazer.
      // Dropped onto grass a short step from the player, directly *away* from
      // the body -- not across the frame, and not next to it either.
      //
      // Letting a target go is a move order, so wherever this click lands is
      // where the player then walks, and the camera follows with 130ms of lag
      // (spec 039): a bar read mid-walk is a pixel the body has already left.
      // A far corner used to be harmless because the field was hand-seeded a
      // couple of body-lengths away; since the map places the monsters (spec
      // 076) that walk carried the body clean off screen. Stepping the other
      // way keeps the frame still *and* keeps the click off the body, which a
      // step toward it would not -- the pick would simply take it again, and
      // "let go" would never have happened.
      const away = (() => {
        const from = bodyPoint(unit);
        const dx = 640 - from.x;
        const dy = 400 - from.y;
        const len = Math.max(1, Math.hypot(dx, dy));
        return { x: 640 + (dx / len) * 110, y: 400 + (dy / len) * 110 };
      })();
      await page.mouse.click(away.x, away.y, { button: 'right' });
      await page.waitForTimeout(400);
      const dropped = await readTarget(page);

      // And the squeeze (spec 095): the ground beside a body belongs to nobody,
      // so a click on it is a move order. This is the half of picking that a
      // player feels as "I cannot walk there", and it only exists once a real
      // browser is delivering the clicks -- the reach itself is pinned in
      // `hover.test.ts`.
      let sloppy = 'the body left the screen before it could be tried';
      // Waited out first: a body still walking is a body whose pixel is stale
      // before the click reaches it.
      if (await settledBar(page, unit.id)) {
        const bars = await bodiesOnScreen(page);
        const now = bars.find((bar) => bar.id === unit.id);
        const gap = now ? gapBeside(now, bars) : null;
        if (!gap) {
          sloppy = 'no body on screen had a clear side to try';
        } else {
          // Nothing is targeted at this point -- the click onto bare grass above
          // let the last one go -- so "no target" here is the ground answering.
          // The click *on* the body that follows is what says the aim was real.
          await page.mouse.click(gap.x, gap.y, { button: 'right' });
          await page.waitForTimeout(130);
          sloppy = await readTarget(page);
          // Re-read before judging: the monsters walk, and a body that stepped
          // onto the pixel between the read and the click is this harness
          // missing rather than the pick reaching.
          const after = nearestBody(gap, await bodiesOnScreen(page));
          console.log(`  the pixel tried was ${Math.round(gap.x)},${Math.round(gap.y)}; nearest body when it landed: ${after.who} at ${Math.round(after.distance)}px`);
          if (sloppy.startsWith('target ')) {
            if (after.distance < DRIFT_MARGIN) {
              sloppy = `${sloppy} -- but ${after.who} had walked to within ${Math.round(after.distance)}px of the pixel`;
            } else {
              problems.push(`a right-click ${GAP_OFFSET}px clear of every body picked ${sloppy}`);
            }
          }

          // And the other direction: a click *on* a body still takes it, so the
          // "no target" above is the ground answering rather than the mouse
          // having stopped working.
          // The click above was a move order, so the player is walking and the
          // camera is following it: every bar on the page is a pixel that is
          // already out of date. Let it come to rest before aiming at one.
          const me = (await bodiesOnScreen(page)).find((bar) => bar.self);
          if (me) await settledBar(page, me.id);
          const onBody = unoccludedBody(await bodiesOnScreen(page));
          if (onBody && (await clickBody(page, onBody.id, 'right'))) {
            await page.waitForTimeout(130);
            const line = await readTarget(page);
            console.log(`  a click on body ${onBody.id} at ${Math.round(onBody.x)},${Math.round(onBody.y + 40)}: ${line}`);
            if (!line.startsWith('target ')) {
              problems.push('a right-click on a body picked nothing');
            }
          }
        }
      }
      await shoot(page, 'world-target');

      // The cursor sitting on a body brightens it (spec 095) -- the thing that
      // says what a click would pick before it is made. Photographed twice, with
      // the cursor off the body and then on it, and the two frames measured:
      // "it looks brighter" is exactly the claim a screenshot alone cannot check,
      // and a highlight nobody can see is the same as no highlight at all. A body
      // the player is not standing in front of, for the same reason the clicks
      // above use one.
      const bars = await bodiesOnScreen(page);
      const lit = unoccludedBody(bars);
      if (lit) {
        const point = bodyPoint(lit);
        const away = emptyPixel(bars);
        await page.mouse.move(away.x, away.y);
        await page.waitForTimeout(200);
        const cold = await pixelsOf(page);
        await page.mouse.move(point.x, point.y);
        await page.waitForTimeout(200);
        const warm = await pixelsOf(page);
        // The body's own pixels: a box the width of its footprint, from over its
        // head down to its feet.
        const before = meanBrightness(cold, point.x - 40, point.y - 40, 80, 90);
        const after = meanBrightness(warm, point.x - 40, point.y - 40, 80, 90);
        console.log(`  body brightness with the cursor off it: ${before.toFixed(1)}, on it: ${after.toFixed(1)}`);
        if (after <= before) {
          problems.push(`hovering a body did not brighten it (${before.toFixed(1)} -> ${after.toFixed(1)})`);
        }
        await shoot(page, 'world-hover');
      }

      // Long enough to walk into reach and land several blows without a second
      // press: the auto-attack is the whole point.
      await page.waitForTimeout(4000);
      const later = await readTarget(page);
      await shoot(page, 'world-autoattack');

      console.log(`  target on the click:            ${opened}`);
      console.log(`  after letting go on bare grass: ${dropped}`);
      console.log(`  after a click ${GAP_OFFSET}px beside it:   ${sloppy}`);
      console.log(`  ...four seconds later:          ${later}`);
      // The order runs itself: no press was made between the last two lines.
      // "no target" means the body it named is dead and the client dropped it,
      // which is the only way an attack order ends by itself.
    }

    // The weapon switch (spec 079). Clicking one is an ordinary equip, and the
    // proof it took is that the *server's* stat block came back naming the new
    // attack -- which is what lights the button. Photographed with a bow in
    // hand so the ranged auto-attack is on screen at all.
    const bow = page.locator('button', { hasText: 'Hunting Bow' }).first();
    if ((await bow.count()) > 0) {
      await bow.click();
      // Polled, not slept on. A fixed 400ms was reading the switch *before* the
      // answer landed: on a loaded page the round trip is comfortably longer
      // than that, and this check spent a long time reporting "clicked Hunting
      // Bow and lit Worn Sword" about a game that was equipping the bow
      // correctly a second later. Same lesson as `waitForAim` above.
      const lit = await waitForLitWeapon(page, 'Hunting Bow');
      console.log(`  weapon after clicking Hunting Bow: ${lit}`);
      if (lit !== 'Hunting Bow') {
        problems.push(`the weapon switch clicked Hunting Bow and lit ${lit}`);
      }

      // The bug this fixes: with a bow in hand the walk came to rest in a band
      // the server would refuse to shoot from, so the player closed and then
      // stood there. Target something and watch its health actually move.
      const mark = await findUnit(page);
      if (mark) {
        await page.waitForTimeout(3500);
        const line = await readTarget(page);
        console.log(`  after 3.5s of ranged auto-attack: ${line}`);
        const health = /(\d+)\/(\d+)/.exec(line);
        // "no target" is a pass: the only way an attack order ends by itself is
        // the body it named being dead.
        if (health && Number(health[1]) >= Number(health[2])) {
          problems.push(`a ranged auto-attack closed but never landed a shot (${line})`);
        }
      } else {
        console.log('  no body to try a ranged auto-attack on');
      }
      await shoot(page, 'world-weapon-switch');
    } else {
      problems.push('the weapon switch is not on the page');
    }

    // A skill that names a body (spec 080): the aim rings what a click would
    // pick, the click orders it, and the player then walks into range and
    // casts without a second press.
    const seekAt = await findUnit(page);
    // Aimed at where the body is *now*, not where the click that found it
    // landed: finding one targets it, so the player is already walking and both
    // pixels have moved on. The same lesson the hover frame above learned.
    const settled = seekAt ? await settledBar(page, seekAt.id) : null;
    if (settled) {
      await page.mouse.move(bodyPoint(settled).x, bodyPoint(settled).y);
      await page.keyboard.press('Digit5');
      const asking = await waitForAim(page, /^aiming Seeking Bolt/);
      if (!/^aiming Seeking Bolt/.test(asking)) {
        problems.push(`pressing 5 did not start a unit aim (readout: ${asking})`);
      }

      // Aimed at where the body is *now*. Starting an aim deliberately does not
      // call off the attack order underneath it -- deciding is not committing --
      // so the player has gone on chasing and swinging for as long as this
      // harness spent waiting for the readout, and the pixel has moved.
      const nowAt = (await bodiesOnScreen(page)).find((bar) => bar.id === settled.id);
      if (!nowAt) {
        console.log('  the body being aimed at died before it could be clicked');
      } else {
        const point = bodyPoint(nowAt);
        await page.mouse.move(point.x, point.y);
        await page.waitForTimeout(160);
        await shoot(page, 'world-aim-unit');
        // Re-read for the click itself: the screenshot above cost a sixth of a
        // second, and the body has been walking through all of it. And aimed at
        // a body the player is not standing in front of -- confirming a
        // unit-named aim needs a unit under the cursor, and the cursor over a
        // body in melee contact is over the player's own rig.
        const clear = unoccludedBody(await bodiesOnScreen(page)) ?? nowAt;
        await page.mouse.move(bodyPoint(clear).x, bodyPoint(clear).y);
        await page.waitForTimeout(120);
        await clickBody(page, clear.id, 'left');
        const taken = await waitForAim(page, /^(right-click ground|Seeking Bolt: moving)/);
        if (/^aiming /.test(taken)) {
          problems.push('a left-click on a body did not confirm the unit aim');
        }
        await page.waitForTimeout(900);
        await shoot(page, 'world-seeking-bolt');
      }
    } else {
      problems.push('no body to aim a unit-targeted skill at');
    }

    // A ground-targeted blast: the aim circle first, then the telegraph ring
    // the cast puts on the terrain.
    await page.mouse.move(760, 340);
    await page.keyboard.press('Digit6');
    await waitForAim(page, /^aiming Quake/);
    await shoot(page, 'world-aim-circle');
    await page.mouse.click(760, 340);
    await page.waitForTimeout(420);
    await shoot(page, 'world-telegraph');

    // ...and now that Quake is on its eight-second cooldown, pressing it again
    // must start nothing. An aim that cannot be thrown is a place to park a
    // press until the timer comes back, which is the queue this refuses.
    await page.mouse.move(700, 500);
    await page.keyboard.press('Digit6');
    const refused = await waitForAim(page, /^aiming Quake/, 900);
    if (/^aiming Quake/.test(refused)) {
      problems.push('a skill on cooldown could still be aimed');
    }
    const said = (await page.textContent('body')) ?? '';
    if (!said.includes('Quake: onCooldown')) {
      problems.push('a press refused on cooldown said nothing about it');
    }
    await shoot(page, 'world-aim-refused');

    // Let the fight run a little, then photograph the hotbar: cooldown sweeps
    // (spec 065) and the pixel damage numbers over the bodies.
    await page.waitForTimeout(900);
    await shoot(page, 'world-cooldowns');

    await damageNumbersHoldTheirGround(page, problems);

    // The player must still be able to walk after all that. Attacking used to
    // root them permanently: being hit cleared the cast server-side without
    // telling the client, which then believed it was casting for good.
    const before = await readTick(page);
    await page.mouse.click(300, 620, { button: 'right' });
    await page.waitForTimeout(1600);
    await shoot(page, 'world-after-combat');
    console.log(`  ticks advanced during the walk: ${(await readTick(page)) - before}`);

    await theInterface(page, problems);

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

/** The brief's budget: a full UI update and draw, under this. */
const UI_BUDGET_MS = 1.5;

/** What the interface has published about itself this frame (spec 131). */
interface UiReadout {
  readonly windows: string;
  readonly bag: string;
  readonly scale: string;
  readonly viewport: string;
  readonly frameMs: string;
  readonly worstMs: string;
}

async function uiReadout(page: Page): Promise<UiReadout> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-ui-windows]');
    return {
      windows: host?.dataset['uiWindows'] ?? '',
      bag: host?.dataset['uiBag'] ?? '',
      scale: host?.dataset['uiScale'] ?? '',
      viewport: host?.dataset['uiViewport'] ?? '',
      frameMs: host?.dataset['uiFrameMs'] ?? '',
      worstMs: host?.dataset['uiWorstMs'] ?? '',
    };
  });
}

/** Polls `read` until it returns something, or gives up and returns null. */
async function waitFor<T>(page: Page, read: () => Promise<T | null>, timeoutMs = 8000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await page.waitForTimeout(150);
  }
  return null;
}

/** Polls until the open windows read `wanted`, and reports what it settled on. */
async function waitForWindows(page: Page, wanted: string, timeoutMs = 4000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let seen = '';
  while (Date.now() < deadline) {
    seen = (await uiReadout(page)).windows;
    if (seen === wanted) return seen;
    await page.waitForTimeout(100);
  }
  return seen;
}

/**
 * What the UI canvas actually has on it, in CSS pixels.
 *
 * Read back off the canvas rather than inferred from the readout, because those
 * are two different claims: the readout says a window is *open*, and this says
 * pixels were *drawn*. Spec 101 shipped a correct mask over a pass that cleared
 * the canvas before blending it, and every offscreen measurement was right while
 * the screen was black -- so "the model says so" is not evidence about a picture.
 *
 * Returns the painted bounding box, converted to page coordinates so a click can
 * be aimed at it, and the count of pixels that are not transparent.
 */
async function paintedBox(
  page: Page,
): Promise<{ painted: number; x: number; y: number; width: number; height: number } | null> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-ui-canvas]');
    if (!canvas) return null;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let painted = 0;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let i = 3, pixel = 0; i < data.length; i += 4, pixel += 1) {
      if (data[i] === 0) continue;
      painted += 1;
      const x = pixel % canvas.width;
      const y = (pixel - x) / canvas.width;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const box = canvas.getBoundingClientRect();
    if (maxX < 0) return { painted: 0, x: 0, y: 0, width: 0, height: 0 };
    // Device pixels back to page ones. The canvas is pinned to the tab's corner,
    // so its own rect is the whole conversion.
    const sx = box.width / canvas.width;
    const sy = box.height / canvas.height;
    return {
      painted,
      x: box.left + minX * sx,
      y: box.top + minY * sy,
      width: (maxX - minX + 1) * sx,
      height: (maxY - minY + 1) * sy,
    };
  });
}

/**
 * The interface, in the game (spec 131).
 *
 * Five phases of `src/ui/` existed with nothing in the Play tab calling any of
 * it, so what this checks is the mount rather than the widgets: that a key opens
 * a window, that the bag it draws is the bag the *server* sent, that a click on
 * a window is not also a move order and a click beside one still is, and that
 * Escape shuts the window before gameplay hears it.
 *
 * The window ruler is the spawner overlay -- fixed world points with a DOM
 * element each, so a camera that panned moved them and a camera that did not
 * left them exactly where they were. Same instrument the damage-number check
 * uses, for the same reason: it measures the world rather than this file's guess
 * about the world.
 */
async function theInterface(page: Page, problems: string[]): Promise<void> {
  await page.keyboard.press('Escape');
  const before = await uiReadout(page);
  if (before.windows !== '') {
    problems.push(`the interface came up with ${before.windows} already open`);
  }
  if ((await paintedBox(page))?.painted !== 0) {
    problems.push('the UI canvas had pixels on it with nothing open');
  }

  // The spawner overlay on, as the ruler. Set rather than toggled: the damage
  // number check before this one turns it on and returns early when it has
  // nothing to measure, leaving it on -- and a blind toggle then turns the ruler
  // off and every measurement below reports "no marks on screen".
  await setSpawners(page, true);

  const opened = await pressAndWait(page, 'KeyI', 'inventory');
  if (opened !== 'inventory') {
    problems.push(`pressing the inventory key opened "${opened}"`);
    return;
  }
  await shoot(page, 'world-inventory');

  const box = await paintedBox(page);
  if (!box || box.painted === 0) {
    problems.push('the inventory opened and the UI canvas stayed blank');
    return;
  }
  console.log(`  UI canvas: ${box.painted} pixels painted over ${Math.round(box.width)}x${Math.round(box.height)}`);

  // The bag it draws is the bag the server sent, and not the gallery's demo bag
  // -- which is a real risk, because the two hold overlapping items on purpose.
  //
  // Asserted on the *unworn* half of the starting kit, deliberately. A weapon is
  // not stable: this script clicks the HUD's weapon switch earlier, which is an
  // ordinary equip, so by now whichever weapon it chose is on the character and
  // the one it replaced is back in the bag. The greaves and the salve are never
  // touched by anything above.
  const bag = (await uiReadout(page)).bag;
  console.log(`  bag on screen: ${bag}`);
  for (const name of ["Traveller's Greaves", 'Minor Salve']) {
    if (!bag.includes(name)) {
      problems.push(`the bag on screen is missing ${name} from the server's starting kit: "${bag}"`);
    }
  }

  // How far the camera wanders on its own over the same window of time, with no
  // click at all.
  //
  // Measured rather than assumed, and it is the difference between a check and a
  // coin toss. The player is not necessarily at rest when this block begins --
  // a standing attack order chases in fits, still for a moment and moving again
  // -- so an absolute threshold reads that wandering as motion the click caused.
  // Every number below is judged against this one.
  const drift = await cameraMovedBy(page, null);
  const margin = 4;
  console.log(`  camera drifts ${drift === null ? '?' : drift.toFixed(1)}px on its own`);

  // A click on the window is not also a move order. Aimed at the middle of what
  // was actually painted, so it cannot miss the window by a layout change.
  const still = await cameraMovedBy(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  if (still === null || drift === null) {
    console.log('  no measurement: the spawner ruler is off screen');
  } else if (still > drift + margin) {
    problems.push(
      `a right-click on an open window moved the camera ${still.toFixed(1)}px, against ${drift.toFixed(1)}px of drift`,
    );
  } else {
    console.log(`  click on the window: camera moved ${still.toFixed(1)}px`);
  }

  // ...and a click beside it still moves, so mounting the interface has not
  // eaten the game. The pixel has to be clear of every body and outside the
  // window: a click on a monster is an attack order, and one already in range
  // does not walk anywhere at all.
  const ground = await clearGroundPixel(page, box);
  const walked = ground === null ? null : await cameraMovedBy(page, ground);
  if (ground === null) {
    console.log('  no measurement: no clear ground beside the window this frame');
  } else if (walked === null || drift === null) {
    console.log('  no measurement: the spawner ruler is off screen');
  } else if (walked <= drift + margin) {
    problems.push(
      `a right-click beside the window moved the camera only ${walked.toFixed(1)}px, against ${drift.toFixed(1)}px of drift`,
    );
  } else {
    console.log(`  click beside the window: camera moved ${walked.toFixed(1)}px`);
  }

  await escapeGoesToTheWindowFirst(page, problems);

  // The interface follows the tab, at a whole-number scale. A resize is the one
  // thing that can put a UI pixel on a fraction of a device pixel, which is the
  // rule the whole `frame.ts` exists to keep.
  const tab = page.viewportSize() ?? { width: 1280, height: 800 };
  const beforeResize = (await uiReadout(page)).viewport;
  await page.setViewportSize({ width: 1024, height: 700 });
  // Polled rather than slept on. The interface follows the tab from its own
  // frame, and this page renders a software-WebGL world: under load a frame here
  // can take most of a second, so a fixed wait is sometimes a frame and sometimes
  // none -- which showed up as a resize check that passed four runs out of five.
  const resized = await waitFor(page, async () => {
    const read = await uiReadout(page);
    return read.viewport !== beforeResize ? read : null;
  });
  if (!resized) {
    problems.push(`the interface never followed the tab down from ${beforeResize}`);
    await page.setViewportSize({ width: tab.width, height: tab.height });
    return;
  }
  const scale = Number(resized.scale);
  if (!Number.isInteger(scale) || scale < 1) {
    problems.push(`the UI scale is not a whole number after a resize: "${resized.scale}"`);
  } else {
    console.log(`  after resize: scale ${scale}, viewport ${resized.viewport}`);
  }
  const canvasFits = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-ui-canvas]');
    if (!canvas) return null;
    const host = canvas.parentElement;
    if (!host) return null;
    return { css: canvas.getBoundingClientRect().width, host: host.clientWidth };
  });
  // Never wider than the tab, and never short by a whole UI pixel: the remainder
  // is dropped rather than half a UI pixel being drawn (`uiFrame`).
  if (canvasFits && (canvasFits.css > canvasFits.host || canvasFits.css <= canvasFits.host - scale)) {
    problems.push(`the UI canvas is ${canvasFits.css}px in a ${canvasFits.host}px tab at scale ${scale}`);
  }
  const backTo = resized.viewport;
  await page.setViewportSize({ width: tab.width, height: tab.height });
  await waitFor(page, async () => ((await uiReadout(page)).viewport !== backTo ? true : null));

  // The budget, measured where it is real: the interface's own update and draw,
  // with two windows open over a live fight.
  //
  // The pointer is walked across them throughout, and that is required rather
  // than realism for its own sake. A still interface is not redrawn at all, so a
  // measurement taken over a window nobody is touching times a few hundred
  // frames of doing nothing and reports 0.00ms however slow the drawing is.
  // Moving the cursor changes what is hovered, which is what makes each of these
  // frames a full update *and* draw.
  await pressAndWait(page, 'KeyI', 'inventory');
  await pressAndWait(page, 'KeyC', 'inventory,character');
  const over = await paintedBox(page);
  for (let step = 0; step < 40 && over; step += 1) {
    await page.mouse.move(
      over.x + (over.width * ((step * 7) % 20)) / 20,
      over.y + (over.height * ((step * 11) % 20)) / 20,
    );
    await page.waitForTimeout(60);
  }
  const read = await uiReadout(page);
  const cost = Number(read.frameMs);

  // Reported, and deliberately not asserted on. The brief's budget is asserted
  // in `preview-ui-gallery.ts`, which is where it can be measured soundly: that
  // page has nothing on the thread but the interface. Here a software-WebGL
  // world is rendering into the same frame on a container with no GPU, and the
  // same code has read 1.4ms and 2.2ms on consecutive runs with a worst frame of
  // four and a half seconds -- a number that says what the machine was doing
  // rather than what the interface costs. A red harness that means "the box was
  // busy" is a harness people learn to ignore.
  //
  // What *is* asserted is that a number came back at all, because a zero here
  // would mean the interface never drew a frame while two windows were open.
  console.log(
    `  UI frame with two windows open: ${cost.toFixed(2)}ms median, ${read.worstMs}ms worst` +
      ` (asserted at ${UI_BUDGET_MS}ms by preview-ui-gallery.ts, on a quieter thread)`,
  );
  if (!Number.isFinite(cost) || Number(read.worstMs) <= 0) {
    problems.push('the interface never reported a frame cost');
  }
  await shoot(page, 'world-ui-windows');

  // Put the world back the way the rest of the script expects it.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await setSpawners(page, false);
}

/** Put the spawner overlay in a known state, whatever it was in before. */
async function setSpawners(page: Page, on: boolean): Promise<void> {
  await page.click('button[aria-label="View settings"]');
  await page.waitForTimeout(120);
  const box = page.locator('label:has-text("Spawners") input[type=checkbox]');
  if ((await box.isChecked()) !== on) await box.click();
  await page.click('button[aria-label="View settings"]');
  await page.waitForTimeout(300);
}

/** Press a key and wait for the interface to report the windows it opened. */
async function pressAndWait(page: Page, code: string, wanted: string): Promise<string> {
  await page.keyboard.press(code);
  return waitForWindows(page, wanted);
}

/**
 * How far the camera moved after a right-click at this pixel, in CSS pixels.
 *
 * Null when the ruler is not on screen. Sampled until it settles rather than
 * after a fixed wait: how far a step gets in half a second depends on the
 * machine, and this one is running the world on software WebGL.
 */
async function cameraMovedBy(page: Page, click: { x: number; y: number } | null): Promise<number | null> {
  await waitForStillCamera(page);
  const before = await overlayPoints(page, 'data-spawner');
  if (before.size === 0) return null;
  if (click) await page.mouse.click(click.x, click.y, { button: 'right' });

  let moved = 0;
  for (let waited = 0; waited < 1600; waited += 200) {
    await page.waitForTimeout(200);
    const after = await overlayPoints(page, 'data-spawner');
    let worst = 0;
    for (const [key, start] of before) {
      const end = after.get(key);
      if (!end) continue;
      worst = Math.max(worst, Math.hypot(end.x - start.x, end.y - start.y));
    }
    moved = Math.max(moved, worst);
    if (moved > 4) break;
  }
  return moved;
}

/**
 * Wait until the camera has stopped, so the next measurement starts from rest.
 *
 * A move order given earlier is still being walked when this block begins, and
 * the travel left in it reads as motion the click under test caused -- which is
 * exactly the difference between "a click on a window is not a move order" and
 * "a click on a window moved the camera four pixels".
 */
async function waitForStillCamera(page: Page, timeoutMs = 4000): Promise<void> {
  let last = await overlayPoints(page, 'data-spawner');
  for (let waited = 0; waited < timeoutMs; waited += 150) {
    await page.waitForTimeout(150);
    const now = await overlayPoints(page, 'data-spawner');
    let moved = 0;
    for (const [key, start] of last) {
      const end = now.get(key);
      if (end) moved = Math.max(moved, Math.hypot(end.x - start.x, end.y - start.y));
    }
    last = now;
    if (moved < 1) return;
  }
}

/**
 * A pixel that is bare ground, outside `avoid`, or null.
 *
 * Both halves matter. A click on a body is an *attack* order, and a body already
 * within reach is attacked without walking a step -- so a "did the game still
 * hear that" measurement aimed at a monster reports a camera that never moved
 * and looks exactly like a mounted interface having eaten the game.
 */
async function clearGroundPixel(
  page: Page,
  avoid: { x: number; y: number; width: number; height: number },
): Promise<{ x: number; y: number } | null> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const bodies = await bodiesOnScreen(page);
  // Across the middle band: above it is sky at this camera pitch and below it is
  // the HUD, and neither is ground a right-click can be given to.
  for (const fx of [0.8, 0.7, 0.6, 0.9, 0.5]) {
    for (const fy of [0.35, 0.45, 0.25, 0.55]) {
      const point = { x: viewport.width * fx, y: viewport.height * fy };
      if (
        point.x >= avoid.x - GAP_OFFSET &&
        point.x <= avoid.x + avoid.width + GAP_OFFSET &&
        point.y >= avoid.y - GAP_OFFSET &&
        point.y <= avoid.y + avoid.height + GAP_OFFSET
      ) {
        continue;
      }
      const clear = bodies.every((bar) => {
        const at = bodyPoint(bar);
        return Math.hypot(at.x - point.x, at.y - point.y) > GAP_CLEARANCE;
      });
      if (clear) return point;
    }
  }
  return null;
}

/**
 * Escape shuts the window before gameplay hears it (spec 131).
 *
 * Measured against a *pending aim*, which is the only observable that can tell
 * the two apart: if the first Escape reached gameplay it would throw the aim
 * away, and if the second one did not, the aim would still be up. Soft when the
 * aim never starts -- a skill on cooldown is a fact about the fight, not a
 * failure of the ordering.
 */
async function escapeGoesToTheWindowFirst(page: Page, problems: string[]): Promise<void> {
  const open = await pressAndWait(page, 'KeyI', 'inventory');
  if (open !== 'inventory') {
    console.log('  no measurement: the inventory would not reopen');
    return;
  }
  await page.mouse.move(760, 340);
  await page.keyboard.press('Digit6');
  if (!/^aiming/.test(await waitForAim(page, /^aiming/, 1200))) {
    console.log('  no measurement: nothing was off cooldown to aim');
    await page.keyboard.press('Escape');
    return;
  }

  await page.keyboard.press('Escape');
  const closed = await waitForWindows(page, '');
  if (closed !== '') {
    problems.push(`Escape left "${closed}" open`);
    return;
  }
  if (!/^aiming/.test(await waitForAim(page, /^aiming/, 600))) {
    problems.push('Escape closed the window and threw the aim away as well');
    return;
  }
  console.log('  Escape closed the window and left the aim alone');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (/^aiming/.test((await page.textContent('body')) ?? '')) {
    problems.push('a second Escape with no window open never reached gameplay');
  } else {
    console.log('  ...and the second one reached gameplay');
  }
}

/**
 * Which weapon the switch is showing as held.
 *
 * Read off the lit border rather than off a class, because that border is the
 * whole claim being checked: it is set from the *equipment* the server
 * replicates (spec 126), so a button that lights is the server having answered.
 */
async function litWeapon(page: Page): Promise<string> {
  return page.evaluate(() => {
    // Found by `data-weapon` rather than by a style the switch happens to use
    // (spec 094): the compact switch centres its icons and has no text at all,
    // so "the button whose text-align is left" named nothing and the button's
    // own text is not always its name. The lit *border* is still what is being
    // read, because that border is the claim -- it is written from
    // `stats.basicAttackId`, so a button that lights is the server having
    // answered.
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('[data-weapon]'));
    const lit = buttons.find((button) => button.style.borderColor === 'rgb(255, 207, 107)');
    return lit?.getAttribute('aria-label') ?? 'nothing';
  });
}

/**
 * Waits for the switch to light `wanted`, and reports what it settled on.
 *
 * Returns the last thing it saw when the wait runs out, so a genuine failure
 * still names the weapon that is lit rather than saying "timed out".
 */
async function waitForLitWeapon(page: Page, wanted: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let seen = '';
  while (Date.now() < deadline) {
    seen = await litWeapon(page);
    if (seen === wanted) return seen;
    await page.waitForTimeout(120);
  }
  return seen;
}

/**
 * A damage number belongs to the ground it landed on, not to the glass
 * (spec 096).
 *
 * The one fact only a real browser can settle, because it needs a real camera
 * that really moves. The spawner marks are the ruler: fixed world points with a
 * DOM element each, so whatever the pan did to them it must have done to every
 * number too. Horizontally only -- a number is also rising up the screen over
 * its own life, and that motion is deliberate.
 *
 * The old bug is a `drift` equal to the pan: numbers that stayed exactly where
 * they were on the glass while the world slid out from under them.
 *
 * Measured on a **killing** blow specifically, because that is the only case
 * the old anchor could not answer at all. A number over a body that is still
 * alive and standing still panned correctly even then -- it was riding the
 * body's own anchor -- so a fight in progress is not a test of anything. The
 * moment the victim despawns there is no anchor left, and the number the player
 * most wants to read is the one that starts sliding across the map.
 */
async function damageNumbersHoldTheirGround(page: Page, problems: string[]): Promise<void> {
  // The overlay off means no ruler, so switch it back on for the measurement.
  await page.click('button[aria-label="View settings"]');
  await page.waitForTimeout(120);
  await page.click('label:has-text("Spawners") input[type=checkbox]');
  await page.click('button[aria-label="View settings"]');
  await page.waitForTimeout(300);

  const unit = await findUnit(page);
  if (!unit) {
    console.log('  no body left to land a damage number on');
    return;
  }

  // The fight has to start before it can end. Without this, a `findUnit` that
  // picked nothing leaves the readout already saying "no target", and the wait
  // below would take that for a kill and measure an empty screen.
  let engaged = false;
  for (let waited = 0; waited < 3000 && !engaged; waited += 60) {
    await page.waitForTimeout(60);
    engaged = (await readTarget(page)).startsWith('target ');
  }
  if (!engaged) {
    console.log('  no measurement: the attack order never took');
    return;
  }

  // Now wait for the order to finish the body off. The client drops a target
  // the moment it dies, so "no target" is the kill -- and polled this closely,
  // the blow that did it is a number a few frames old and good for half a
  // second yet, which is the window the pan has to happen in.
  let before = new Map<string, { x: number; y: number }>();
  for (let waited = 0; waited < 20_000; waited += 60) {
    await page.waitForTimeout(60);
    if (!(await readTarget(page)).startsWith('no target')) continue;
    before = await overlayPoints(page, 'data-damage-id');
    break;
  }
  const marksBefore = await overlayPoints(page, 'data-spawner');
  if (before.size === 0 || marksBefore.size === 0) {
    console.log(
      `  no measurement: ${before.size} numbers over the kill, ${marksBefore.size} spawner marks`,
    );
    return;
  }

  const moved = (
    from: Map<string, { x: number; y: number }>,
    to: Map<string, { x: number; y: number }>,
  ): number[] => {
    const deltas: number[] = [];
    for (const [key, start] of from) {
      const end = to.get(key);
      if (end) deltas.push(end.x - start.x);
    }
    return deltas;
  };

  // Walk, which is what pans the camera. Held keys rather than a move order: a
  // right-click has to find a pixel that is neither a HUD button nor ground the
  // route planner refuses, and either one reads here as a camera that did not
  // move. Escape first, because the blow that did the killing is a wind-up the
  // body is still standing in, and since spec 094 those are long.
  await page.keyboard.press('Escape');
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyD');

  // Sampled until the camera has actually moved rather than after a fixed wait:
  // how far a step gets in 400ms depends on the machine, and this one is running
  // the world on software WebGL.
  let pan: number[] = [];
  let numbers: number[] = [];
  let camera = 0;
  for (let waited = 0; waited < 1500 && Math.abs(camera) < 12; waited += 150) {
    await page.waitForTimeout(150);
    pan = moved(marksBefore, await overlayPoints(page, 'data-spawner'));
    numbers = moved(before, await overlayPoints(page, 'data-damage-id'));
    if (pan.length === 0 || numbers.length === 0) break;
    camera = pan.reduce((sum, delta) => sum + delta, 0) / pan.length;
  }
  await page.keyboard.up('KeyW');
  await page.keyboard.up('KeyD');

  if (pan.length === 0 || numbers.length === 0) {
    console.log('  no measurement: nothing survived the pan to compare');
    return;
  }
  console.log(`  camera panned ${camera.toFixed(1)}px, over ${numbers.length} damage numbers`);
  if (Math.abs(camera) < 12) {
    console.log('  no measurement: the camera barely moved');
    return;
  }
  const drift = Math.max(...numbers.map((delta) => Math.abs(delta - camera)));
  console.log(`  worst number drift against the ground: ${drift.toFixed(1)}px`);
  if (drift > 6) {
    problems.push(
      `a damage number drifted ${drift.toFixed(1)}px against the ground during a ${camera.toFixed(0)}px pan`,
    );
  }

  await page.click('button[aria-label="View settings"]');
  await page.waitForTimeout(120);
  await page.click('label:has-text("Spawners") input[type=checkbox]');
  await page.click('button[aria-label="View settings"]');
}

await main();
