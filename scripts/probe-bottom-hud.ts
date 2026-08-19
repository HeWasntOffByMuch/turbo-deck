/**
 * The bottom band, in a real browser (spec 164).
 *
 *   npx tsx scripts/probe-bottom-hud.ts
 *
 * Everything spec 164 decides is asserted in Node -- what fraction the strip is
 * showing, what an empty slot casts, when the overlay is up. What none of those
 * can say is whether any of it was *connected to anything*, which is exactly the
 * failure this repo has shipped before: spec 147's window layout had two green
 * halves and no wire between them for three specs, and spec 158's loot label was
 * computed by one file and drawn by nobody.
 *
 * So this drives the real `createHud` over the dev server (`src/render/hud-probe.html`)
 * and reads the boxes back off the real DOM: the strip is at the bottom of the
 * frame and full width, the fill is the fraction the model says, hovering it
 * shows the exact percentage, the bar is five slots with four of them empty and
 * inert, the pool sits left of the slots and clear of the weapon switch, and the
 * death overlay's button reaches the handler.
 *
 * It writes `.claude/screenshots/bottom-hud.png` (alive) and `bottom-hud-dead.png`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { hudLayout, stripWidth } from '../src/render/iso3d/world/hud-layout.js';
import { ACTION_BAR } from '../src/render/iso3d/world/action-bar.js';
import { xpBar } from '../src/render/iso3d/world/xp-bar.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4327;
const VIEWPORT = { width: 1280, height: 800 };

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

const problems: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
}

async function waitForServer(url: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${url} never came up`);
}

/** One element's box, in CSS pixels, or null when it is not drawn. */
async function box(page: Page, selector: string): Promise<DOMRect | null> {
  const handle = await page.$(selector);
  if (!handle) return null;
  const visible = await handle.evaluate(
    (node) => getComputedStyle(node as HTMLElement).display !== 'none',
  );
  if (!visible) return null;
  return handle.boundingBox() as Promise<DOMRect | null>;
}

async function set(page: Page, overrides: Record<string, unknown>): Promise<void> {
  await page.evaluate((next) => window.hudProbe?.set(next), overrides);
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });

  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  try {
    await waitForServer(`http://localhost:${PORT}/hud-probe.html`);
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.on('pageerror', (error) => problems.push(String(error)));
    // Console errors, minus the one this page is *supposed* to produce.
    //
    // A bare probe page has no favicon, so the browser asks for one and gets a
    // 404 -- and the console line for it says only "Failed to load resource",
    // with the URL nowhere in the message. Filtering on the text would therefore
    // filter every 404 including a real one, so the URLs are collected from the
    // response side and matched up here.
    const notFound: string[] = [];
    page.on('response', (response) => {
      if (response.status() === 404) notFound.push(response.url());
    });
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(`http://localhost:${PORT}/hud-probe.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.hudProbe?.ready === true, undefined, { timeout: 30_000 });

    const layout = hudLayout(false);

    // --- the experience strip --------------------------------------------
    console.log('the experience strip');
    const strip = await box(page, '[data-xp-bar]');
    check(strip !== null, 'the strip is on screen');
    if (strip) {
      check(Math.round(strip.width) === VIEWPORT.width, 'it spans the whole frame');
      check(
        Math.round(strip.y + strip.height) === VIEWPORT.height,
        'it sits on the frame’s bottom edge',
      );
      check(strip.height <= 8, `it is a few pixels tall (${strip.height})`);
    }

    const expected = xpBar(7, 380);
    const fillWidth = await page.evaluate(() => {
      const el = document.querySelector('[data-xp-bar]')?.firstElementChild as HTMLElement | null;
      return el ? el.getBoundingClientRect().width : -1;
    });
    check(
      Math.abs(fillWidth - expected.fraction * VIEWPORT.width) < 2,
      `the fill is the model’s fraction (${expected.percentText})`,
    );

    // Ten marks. Counted off the painted pixels rather than off the markup,
    // because the subdivisions are a repeating gradient and a wrong stop count
    // is invisible to the DOM.
    const marks = await page.evaluate((height: number) => {
      const el = document.querySelector('[data-xp-bar]') as HTMLElement | null;
      if (!el) return -1;
      const image = getComputedStyle(el.children[1] as HTMLElement).backgroundImage;
      void height;
      const stops = image.match(/calc\(([0-9.]+)%/g) ?? [];
      return stops.length > 0 ? Math.round(100 / parseFloat(stops[0]?.slice(5) ?? '0')) : -1;
    }, layout.xpBarHeight);
    check(marks === 10, `it is cut into ten (${marks})`);

    // --- hover ------------------------------------------------------------
    console.log('hovering it');
    check((await box(page, '[data-xp-detail]')) === null, 'the detail is hidden until hovered');
    if (strip) await page.mouse.move(VIEWPORT.width / 2, strip.y + strip.height / 2);
    await page.waitForTimeout(50);
    const detail = await box(page, '[data-xp-detail]');
    check(detail !== null, 'hovering shows it');
    // `data-text` rather than `textContent`: the line is drawn in the game's own
    // font (spec 164), so it is a glyph path and has no text to read.
    const detailText = await page.evaluate(
      () => (document.querySelector('[data-xp-detail]') as HTMLElement | null)?.dataset['text'] ?? '',
    );
    check(detailText.includes(expected.percentText), `it says the exact percentage: ${detailText}`);
    await page.mouse.move(VIEWPORT.width / 2, 200);

    // --- the slots --------------------------------------------------------
    console.log('the action bar');
    const slotBoxes = await page.$$eval('[data-slot]', (nodes) =>
      nodes.map((node) => {
        const element = node as HTMLElement;
        const rect = element.getBoundingClientRect();
        return {
          kind: element.dataset['slotKind'] ?? '',
          ability: element.dataset['ability'] ?? '',
          x: rect.x,
          y: rect.y,
          width: rect.width,
          bottom: rect.bottom,
        };
      }),
    );
    check(slotBoxes.length === ACTION_BAR.length, `there are ${ACTION_BAR.length} slots`);
    check(
      slotBoxes.filter((slot) => slot.ability === '').length === 4,
      'four of them hold nothing',
    );
    check(
      slotBoxes.filter((slot) => slot.kind === 'vial').length === 1,
      'one of them is the vial',
    );
    check(
      slotBoxes.every((slot) => slot.bottom <= VIEWPORT.height - layout.xpBarHeight),
      'they clear the experience strip',
    );

    // An empty slot is inert, and this is the only place that can be checked:
    // the button exists, it is on screen, and clicking it sends nothing.
    const empty = slotBoxes[0];
    if (empty) {
      await page.mouse.click(empty.x + empty.width / 2, empty.y + 10);
      await page.waitForTimeout(30);
    }
    const usedAfterEmpty = await page.evaluate(() => window.hudProbe?.used() ?? []);
    check(usedAfterEmpty.length === 0, 'clicking an empty slot asks for nothing');

    const vial = slotBoxes.find((slot) => slot.kind === 'vial');
    if (vial) {
      await page.mouse.click(vial.x + vial.width / 2, vial.y + 10);
      await page.waitForTimeout(30);
    }
    const usedAfterVial = await page.evaluate(() => window.hudProbe?.used() ?? []);
    check(
      usedAfterVial.join(',') === 'self.hearthdraught',
      `the vial asks for the flask (${usedAfterVial.join(',') || 'nothing'})`,
    );

    // --- the pools --------------------------------------------------------
    console.log('the pools');
    const health = await box(page, '[data-pool="health"]');
    const resource = await box(page, '[data-pool="resource"]');
    check(health !== null && resource !== null, 'both pool bars are on screen');
    const leftmostSlot = Math.min(...slotBoxes.map((slot) => slot.x));
    if (health && resource) {
      check(health.x + health.width <= leftmostSlot, 'the pool sits left of the slots');
      check(health.y < resource.y, 'health is above resource');
      check(
        resource.y + resource.height <= VIEWPORT.height - layout.xpBarHeight,
        'the pool clears the experience strip',
      );
      const weapons = await box(page, '[data-weapon]');
      check(
        weapons === null || weapons.x + weapons.width <= health.x,
        'it clears the weapon switch',
      );
      const label = await page.evaluate(
        () =>
          (document.querySelector('[data-pool="health"] div:last-child') as HTMLElement | null)
            ?.dataset['text'] ?? '',
      );
      check(label === '96 / 140', `health says its numbers (${label})`);

      // Centred on the slot row rather than sharing its floor -- the thing that
      // was wrong on the first cut, and a thing only a browser can settle
      // because it is where two independently-positioned groups ended up.
      const slotTop = Math.min(...slotBoxes.map((slot) => slot.y));
      const slotBottom = Math.max(...slotBoxes.map((slot) => slot.bottom));
      const blockMiddle = (health.y + resource.y + resource.height) / 2;
      check(
        Math.abs(blockMiddle - (slotTop + slotBottom) / 2) <= 1.5,
        `the pool block is centred on the slots (off by ${(blockMiddle - (slotTop + slotBottom) / 2).toFixed(1)}px)`,
      );
    }
    void stripWidth;

    // --- the white chunk -------------------------------------------------
    //
    // The same mechanic the bar over a body has (spec 145): the fill retreats at
    // once and the ground it gave up stays lit for a beat. Only a browser can
    // say whether the band is actually painted -- a white bar stacked behind an
    // opaque fill passes every test in Node and draws nothing, which is exactly
    // what `probe-health-flash.ts` was written for on the floating bars.
    console.log('the white chunk on the pool bar');
    const bandWidths = async (): Promise<{ fill: number; ghost: number }> =>
      page.evaluate(() => {
        const track = document.querySelector('[data-pool="health"]');
        const ghost = track?.children[0] as HTMLElement | undefined;
        const fill = track?.children[1] as HTMLElement | undefined;
        return {
          ghost: ghost?.getBoundingClientRect().width ?? -1,
          fill: fill?.getBoundingClientRect().width ?? -1,
        };
      });

    const before = await bandWidths();
    check(
      Math.abs(before.ghost - before.fill) < 1,
      'no chunk while nothing is happening',
    );

    // A blow: same maximum, less health, and a tick clock that has moved on.
    await set(page, {
      entities: [
        { id: 1, kind: 0, typeId: 'player', x: 0, y: 0, z: 0, health: 40, maxHealth: 140, poise: 1 },
      ],
    });
    await page.waitForTimeout(30);
    const struck = await bandWidths();
    check(struck.fill < before.fill - 10, `the fill retreats at once (${Math.round(struck.fill)}px)`);
    check(
      struck.ghost > struck.fill + 10,
      `the white holds the ground it gave up (${Math.round(struck.ghost)}px behind ${Math.round(struck.fill)}px)`,
    );
    check(Math.abs(struck.ghost - before.fill) < 2, 'the chunk starts where the fill was');

    await set(page, {});
    await page.waitForTimeout(30);

    await page.screenshot({ path: join(outDir, 'bottom-hud.png') });
    console.log('  wrote bottom-hud.png');

    // --- the player's own status row (spec 189) ---------------------------
    //
    // Everything this row decides is asserted in Node by `status-marks.test.ts`.
    // What none of it can say is whether the row is wired to anything, which is
    // the exact failure mode spec 189 was written against: the floating marks
    // had a complete green test suite beside a mark that could not tell a player
    // what it meant.
    //
    // The rig draws at tick 400, so every expiry below is that plus a window.
    console.log('the status row');
    const barsBefore = await box(page, '[data-pool="health"]');
    await set(page, {
      entities: [
        {
          id: 1,
          kind: 0,
          typeId: 'player',
          x: 0,
          y: 0,
          z: 0,
          health: 96,
          maxHealth: 140,
          poise: 1,
          statuses: [
            // Flow: stacking, so it draws a count, and 2.5s left.
            { wire: 0, stacks: 2, expiresAtTick: 400 + 150 },
            // Prepared: the indefinite one. It must draw no timer at all.
            { wire: 2, stacks: 1, expiresAtTick: 0xffffffff },
            // Slowed: does not stack, so no count, and 1.5s left.
            { wire: 8, stacks: 1, expiresAtTick: 400 + 90 },
          ],
        },
      ],
    });
    await page.waitForTimeout(50);

    const row = await box(page, '[data-bar="selfStatuses"]');
    check(row !== null, 'the row is drawn when the player carries something');

    const statusRow = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-self-status]'))
        .filter((node) => getComputedStyle(node as HTMLElement).display !== 'none')
        .map((node) => {
          const element = node as HTMLElement;
          const children = Array.from(element.children) as HTMLElement[];
          return {
            id: element.dataset['selfStatus'] ?? '',
            title: element.title,
            count: (children[0]?.querySelector('div')?.textContent ?? '').trim(),
            timer: (children[1]?.textContent ?? '').trim(),
            width: element.getBoundingClientRect().width,
          };
        }),
    );

    check(statusRow.length === 3, `all three marks are drawn (${String(statusRow.length)})`);

    const flow = statusRow.find((mark) => mark.id === 'flow');
    const prepared = statusRow.find((mark) => mark.id === 'prepared');
    const slowed = statusRow.find((mark) => mark.id === 'slowed');

    check(flow?.timer === '2.5', `a finite status counts down (${flow?.timer ?? 'none'})`);
    check(flow?.count === '2', `a stacking status shows its count (${flow?.count ?? 'none'})`);
    check(slowed?.timer === '1.5', `and so does the second one (${slowed?.timer ?? 'none'})`);
    check(slowed?.count === '', 'a status that cannot stack shows no count');

    // The headline rule of the whole feature, and the one that is easiest to
    // get wrong silently: what arrives for Prepared is the u32 truncation of
    // `MAX_SAFE_INTEGER - tick`, so a timer drawn from it would read in days.
    check(
      prepared !== undefined && prepared.timer === '',
      `an indefinite status shows no timer at all (${prepared?.timer ?? 'no mark'})`,
    );

    // Hovering says what it does, from the one writer.
    check(
      (flow?.title ?? '').startsWith('Flow\n'),
      'the mark is titled with its own name',
    );
    check(
      (flow?.title ?? '').includes('Stacks up to 3 times.'),
      'the tooltip carries the Technical Description',
    );
    check(
      (prepared?.title ?? '').includes('Lasts until it is spent.'),
      'and says the indefinite one has no clock',
    );
    check(
      !(slowed?.title ?? '').toLowerCase().includes('poise'),
      'no internal pool name reaches a player',
    );

    // The rule the floating row already obeys, asserted for this one: the block
    // is anchored by its bottom, so a status appearing grows it upward and the
    // bars a player is reading hold still.
    const barsAfter = await box(page, '[data-pool="health"]');
    check(
      barsBefore !== null &&
        barsAfter !== null &&
        Math.abs(barsBefore.y - barsAfter.y) < 0.5,
      `the health bar does not move when the row appears (by ${
        barsBefore && barsAfter ? Math.abs(barsBefore.y - barsAfter.y).toFixed(1) : '?'
      }px)`,
    );

    await page.screenshot({ path: join(outDir, 'bottom-hud-statuses.png') });
    console.log('  wrote bottom-hud-statuses.png');

    await set(page, {});
    await page.waitForTimeout(30);
    check(
      (await box(page, '[data-bar="selfStatuses"]')) === null,
      'the row goes away with the last status',
    );

    // --- death ------------------------------------------------------------
    console.log('dying');
    check((await box(page, '[data-death]')) === null, 'no overlay while alive');
    await set(page, {
      entities: [
        { id: 1, kind: 0, typeId: 'player', x: 0, y: 0, z: 0, health: 0, maxHealth: 140, poise: 1 },
      ],
    });
    await page.waitForTimeout(50);
    const overlay = await box(page, '[data-death]');
    check(overlay !== null, 'the overlay is up at zero health');
    const banner = await page.evaluate(
      () => (document.querySelector('[data-death] div') as HTMLElement | null)?.dataset['text'] ?? '',
    );
    // Every word on screen is the game's own face now, so nothing in the band
    // has text content at all -- a `textContent` check here would pass on an
    // empty string.
    const strayText = await page.evaluate(() => {
      const band = Array.from(
        document.querySelectorAll('[data-slot],[data-pool],[data-respawn],[data-xp-detail]'),
      );
      return band
        .map((node) => (node as HTMLElement).innerText.trim())
        .filter((text) => text.length > 0);
    });
    check(
      strayText.length === 0,
      `nothing in the band is set in the browser's font (${strayText.join(' | ') || 'none'})`,
    );
    check(banner === 'YOU ARE DEAD', `it says so: "${banner}"`);
    const bannerBox = await box(page, '[data-death] > div:first-child');
    check(
      bannerBox !== null && bannerBox.width > VIEWPORT.width / 4,
      `the words are big (${Math.round(bannerBox?.width ?? 0)}px wide)`,
    );

    await page.screenshot({ path: join(outDir, 'bottom-hud-dead.png') });
    console.log('  wrote bottom-hud-dead.png');

    const button = await box(page, '[data-respawn]');
    check(button !== null, 'there is a respawn button');
    if (button) {
      await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
      await page.waitForTimeout(30);
    }
    const asked = await page.evaluate(() => window.hudProbe?.respawns() ?? 0);
    check(asked === 1, `pressing it asks the server exactly once (${asked})`);

    // Alive again: the overlay goes when the body does, and nothing here
    // decided that -- the health it was handed did.
    await set(page, {});
    await page.waitForTimeout(50);
    check((await box(page, '[data-death]')) === null, 'the overlay goes when health comes back');
    for (const url of notFound) {
      if (!url.includes('favicon')) problems.push(`404 for ${url}`);
    }
    for (const message of consoleErrors) {
      if (message.includes('Failed to load resource') && notFound.every((u) => u.includes('favicon'))) {
        continue;
      }
      problems.push(message);
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('\nall checks passed');
  }
}

await main();
