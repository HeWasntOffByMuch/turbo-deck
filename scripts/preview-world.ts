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
 * How far beside a body the deliberately-sloppy click lands, in CSS pixels.
 *
 * Outside the body at the default framing, and comfortably short of the ~110px
 * the seeded grazers stand apart -- so a hit is this body being forgiving
 * rather than the neighbour being picked instead. What the budget *is* belongs
 * to `hover.test.ts`, which pins it exactly; this asks only whether the
 * forgiveness is wired to the mouse at all.
 */
const SLOPPY_OFFSET = 40;

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
      // step toward it would not -- the forgiving pick would simply take it
      // again, and "let go" would never have happened.
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

      let sloppy = 'the body left the screen before it could be tried';
      const beside = await settledBar(page, unit.id);
      if (beside) {
        const point = bodyPoint(beside);
        await page.mouse.click(point.x + SLOPPY_OFFSET, point.y, { button: 'right' });
        await page.waitForTimeout(130);
        sloppy = await readTarget(page);
        if (!sloppy.startsWith('target ')) {
          problems.push(`a right-click ${SLOPPY_OFFSET}px beside a body picked nothing`);
        }
      }
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

      console.log(`  target on the click:            ${opened}`);
      console.log(`  after letting go on bare grass: ${dropped}`);
      console.log(`  after a click ${SLOPPY_OFFSET}px beside it:   ${sloppy}`);
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
      await page.waitForTimeout(400);
      const lit = await litWeapon(page);
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
        await page.mouse.click(point.x, point.y);
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

/**
 * Which weapon the switch is showing as held.
 *
 * Read off the lit border rather than off a class, because that border is the
 * whole claim being checked: it is set from `stats.basicAttackId`, so a button
 * that lights is the server having answered.
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

await main();
