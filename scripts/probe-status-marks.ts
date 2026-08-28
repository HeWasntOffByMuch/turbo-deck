/**
 * The status marks, in a real browser (spec 186).
 *
 *   npx tsx scripts/probe-status-marks.ts
 *
 * Everything spec 186 decides is asserted in Node: what the server packs
 * (`net/delta.test.ts`), what a mark does with it
 * (`world/status-marks.test.ts`), and that the two meet over a real socket
 * (`client/status-wire.test.ts`). What none of them can say is whether any of it
 * was **connected to anything** -- which is exactly the failure this repo has
 * shipped before, twice: spec 121's aura system has a decision function, a
 * tracker, eight authored effects and no caller, and spec 147's window layout
 * had two green halves and no wire between them for three specs.
 *
 * So this drives the real `createHud` over the dev server
 * (`src/render/hud-probe.html`) and reads the row back off the real DOM: that a
 * body with nothing on it draws no row at all, that each status draws its own
 * mark, that the marks come out in wire order however the list arrives, that a
 * stacking one shows its count and a non-stacking one does not, that a passed
 * window draws nothing, and that the row sits above the health bar without
 * moving it.
 *
 * That last one is the check worth having. The holder is anchored by its
 * *bottom*, which is the whole reason a row may be added at the top at all -- the
 * cast bar had to be taken out of flow for precisely this reason (see the note
 * in `hud.ts`), and a regression here moves the thing a player is actually
 * reading every time somebody is Exposed.
 *
 * It writes `.claude/screenshots/status-marks.png`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { STATUS_VISUALS, visualFor } from '../src/server/data/status-visuals.js';
import { StatusId } from '../src/server/sim/statuses.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4331;
const VIEWPORT = { width: 1280, height: 800 };

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** The tick the probe's fabricated view claims to be at. */
const NOW = 400;

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

const wireOf = (id: string): number => {
  const visual = visualFor(id);
  if (!visual) throw new Error(`no visible row for ${id}`);
  return visual.wire;
};

/** Put `statuses` on the probe's one body. */
async function carry(
  page: Page,
  statuses: readonly { wire: number; stacks: number; expiresAtTick: number }[],
): Promise<void> {
  await page.evaluate(
    (next) =>
      window.hudProbe?.set({
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
            statuses: next,
          },
        ],
      }),
    statuses as unknown as Record<string, unknown>[],
  );
  await page.waitForTimeout(60);
}

/** What the row is showing, in the order the DOM has it. */
async function shown(
  page: Page,
): Promise<{ id: string; count: string; opacity: number; x: number }[]> {
  return page.$$eval('[data-status]', (nodes) =>
    nodes
      .filter((node) => getComputedStyle(node as HTMLElement).display !== 'none')
      .map((node) => {
        const element = node as HTMLElement;
        const rect = element.getBoundingClientRect();
        return {
          id: element.dataset['status'] ?? '',
          count: (element.lastElementChild as HTMLElement | null)?.textContent ?? '',
          opacity: Number(getComputedStyle(element).opacity),
          x: rect.x,
        };
      }),
  );
}

/** One element's box, or null when it is not drawn. */
async function box(page: Page, selector: string): Promise<DOMRect | null> {
  const handle = await page.$(selector);
  if (!handle) return null;
  const visible = await handle.evaluate(
    (node) => getComputedStyle(node as HTMLElement).display !== 'none',
  );
  if (!visible) return null;
  return handle.boundingBox() as Promise<DOMRect | null>;
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
    await page.goto(`http://localhost:${PORT}/hud-probe.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.hudProbe?.ready === true, undefined, {
      timeout: 30_000,
    });
    // The per-body holder is drawn from an anchor the scene would normally
    // supply. There is no scene here, so the rig is told where the body is.
    await page.evaluate(() => window.hudProbe?.anchor({ id: 1, x: 560, y: 300 }));
    await page.waitForTimeout(60);

    // --- nothing on the body ----------------------------------------------
    console.log('a body carrying nothing');
    await carry(page, []);
    check((await shown(page)).length === 0, 'draws no marks');
    check((await box(page, '[data-bar="statuses"]')) === null, 'and no row either');
    const restingHealthBar = await box(page, '[data-bar="health"]');
    check(restingHealthBar !== null, 'the health bar is on screen to compare against');

    // --- one status --------------------------------------------------------
    console.log('one status');
    await carry(page, [{ wire: wireOf(StatusId.Exposed), stacks: 1, expiresAtTick: NOW + 200 }]);
    const one = await shown(page);
    check(one.length === 1, `draws one mark (${one.length})`);
    check(one[0]?.id === StatusId.Exposed, `and it is the right one (${one[0]?.id})`);
    check(one[0]?.count === '', 'a status that cannot stack shows no count');

    // The check this probe exists for: the row must not push the bars around.
    const withOneHealthBar = await box(page, '[data-bar="health"]');
    check(
      restingHealthBar !== null &&
        withOneHealthBar !== null &&
        Math.abs(restingHealthBar.y - withOneHealthBar.y) < 0.5,
      'the health bar did not move when the row appeared',
    );

    // --- a stacking one ----------------------------------------------------
    console.log('a stacking status');
    await carry(page, [{ wire: wireOf(StatusId.Flow), stacks: 3, expiresAtTick: NOW + 200 }]);
    const stacked = await shown(page);
    check(stacked[0]?.count === '3', `shows its count (${stacked[0]?.count || 'nothing'})`);

    // --- order -------------------------------------------------------------
    console.log('several at once');
    // Handed in deliberately the wrong order: the picture must not depend on it.
    await carry(page, [
      { wire: wireOf(StatusId.Sundered), stacks: 1, expiresAtTick: NOW + 200 },
      { wire: wireOf(StatusId.Flow), stacks: 2, expiresAtTick: NOW + 200 },
      { wire: wireOf(StatusId.Vulnerable), stacks: 1, expiresAtTick: NOW + 200 },
      { wire: wireOf(StatusId.Momentum), stacks: 1, expiresAtTick: NOW + 200 },
    ]);
    const many = await shown(page);
    check(many.length === 4, `draws all four (${many.length})`);
    check(
      many.map((mark) => mark.id).join(',') ===
        [StatusId.Flow, StatusId.Momentum, StatusId.Vulnerable, StatusId.Sundered].join(','),
      `in wire order (${many.map((mark) => mark.id).join(',')})`,
    );
    check(
      many.every((mark, index) => index === 0 || mark.x > (many[index - 1]?.x ?? 0)),
      'laid out left to right, none stacked on another',
    );

    // --- a passed window ----------------------------------------------------
    console.log('a status that has run out');
    await carry(page, [
      { wire: wireOf(StatusId.Flow), stacks: 1, expiresAtTick: NOW - 1 },
      { wire: wireOf(StatusId.Exposed), stacks: 1, expiresAtTick: NOW + 200 },
    ]);
    const stale = await shown(page);
    check(stale.length === 1, `the passed one is not drawn (${stale.length} left)`);
    check(stale[0]?.id === StatusId.Exposed, 'and the live one still is');

    // --- the fade -----------------------------------------------------------
    console.log('the last few ticks');
    await carry(page, [{ wire: wireOf(StatusId.Flow), stacks: 1, expiresAtTick: NOW + 4 }]);
    const fading = await shown(page);
    check(
      (fading[0]?.opacity ?? 1) < 0.9 && (fading[0]?.opacity ?? 0) > 0,
      `thins out into the end (${fading[0]?.opacity})`,
    );

    // --- the picture ---------------------------------------------------------
    console.log('every row at once');
    await carry(
      page,
      STATUS_VISUALS.map((visual) => ({
        wire: visual.wire,
        stacks: visual.maxStacks,
        expiresAtTick: NOW + 200,
      })),
    );
    const all = await shown(page);
    check(all.length === STATUS_VISUALS.length, `all ${STATUS_VISUALS.length} draw at once`);
    // Every glyph distinct: eight marks that render as the same shape would pass
    // every check above and be one mark as far as a player is concerned.
    const glyphs = await page.$$eval('[data-status]', (nodes) =>
      nodes.map((node) => (node as HTMLElement).firstElementChild?.innerHTML ?? ''),
    );
    check(new Set(glyphs).size === glyphs.length, `every glyph is a different shape`);

    await page.screenshot({ path: join(outDir, 'status-marks.png') });

    // And a crop of the holder itself, at eight times the size.
    //
    // The full frame is the honest picture -- a mark is 13px over a body and
    // that is how big it really is -- but eight glyphs at 13px are unreviewable
    // in a 1280x800 screenshot, and the thing most likely to be wrong about this
    // feature is whether they can be told apart. So the same DOM is re-shot
    // through a scaled viewport rather than by upscaling the pixels, which would
    // only blur what it is meant to show.
    const holder = await box(page, '[data-bar="statuses"]');
    if (holder) {
      const zoom = await browser.newPage({
        viewport: VIEWPORT,
        deviceScaleFactor: 8,
      });
      await zoom.goto(`http://localhost:${PORT}/hud-probe.html`, { waitUntil: 'load' });
      await zoom.waitForFunction(() => window.hudProbe?.ready === true, undefined, {
        timeout: 30_000,
      });
      await zoom.evaluate(() => window.hudProbe?.anchor({ id: 1, x: 560, y: 300 }));
      await carry(
        zoom,
        STATUS_VISUALS.map((visual) => ({
          wire: visual.wire,
          stacks: visual.maxStacks,
          expiresAtTick: NOW + 200,
        })),
      );
      const at = await box(zoom, '[data-bar="statuses"]');
      if (at) {
        await zoom.screenshot({
          path: join(outDir, 'status-marks-zoom.png'),
          clip: { x: at.x - 8, y: at.y - 4, width: at.width + 16, height: at.height + 8 },
        });
      }
      await zoom.close();
    }

    console.log(`\nwrote ${join(outDir, 'status-marks.png')}`);
    console.log(`wrote ${join(outDir, 'status-marks-zoom.png')}`);
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
