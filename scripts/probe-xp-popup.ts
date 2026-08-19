/**
 * The reward number, in a real browser (spec 183).
 *
 *   npx tsx scripts/probe-xp-popup.ts
 *
 * Everything this spec decides is asserted in Node -- how a gain is derived from
 * two totals (`xp-gain.test.ts`), and where the two trails are on every frame of
 * their lives (`damage-popup.test.ts`). What neither can say is whether the
 * number is *drawn*, in the colour it was meant to be, which is exactly the
 * failure this repo keeps shipping: spec 158's loot label was computed by one
 * file and drawn by nobody, and spec 182's gore setting had two green halves and
 * no wire between them.
 *
 * So this drives the real `createHud` over `src/render/hud-probe.html`, lands a
 * real blow and earns a real reward at the same world point, and measures the
 * pair off the real DOM. Three things, and each is one the tests cannot reach:
 *
 * - the reward has an element at all, and it holds a bare count;
 * - it sits under the blow's number, in its column, and stays there while the
 *   two rise -- then outlives it by half a second, still climbing;
 * - the number is drawn in the strip's own purple, read out of the SVG fill
 *   rather than out of the constant, so a number that reached the DOM in the
 *   damage palette would fail here.
 *
 * It writes `.claude/screenshots/xp-popup.png`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4329;
const VIEWPORT = { width: 1280, height: 800 };

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** The palette `hud.ts` authors. Duplicated on purpose: a probe that imported
 * the constant would agree with itself whatever the page drew. */
const XP_PURPLE = '#a878e8';
const XP_PURPLE_DARK = '#200d36';

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

/** The centre of one element, or null when it is not drawn. */
async function centre(page: Page, selector: string): Promise<{ x: number; y: number } | null> {
  const handle = await page.$(selector);
  if (!handle) return null;
  const shown = await handle.evaluate(
    (node) => getComputedStyle(node as HTMLElement).display !== 'none',
  );
  if (!shown) return null;
  const box = await handle.boundingBox();
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
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

    // A killing blow and what it was worth, on the same body, on the same
    // frame -- which is the whole case this feature has to survive.
    await page.evaluate(() => {
      window.hudProbe?.hit(38, false);
      window.hudProbe?.reward(24);
    });

    console.log('the reward number');
    const drawn = await page.evaluate(() => {
      const node = document.querySelector('[data-xp-popup]');
      return node ? { html: node.innerHTML, id: (node as HTMLElement).dataset['xpPopup'] } : null;
    });
    check(drawn !== null, 'there is an element for it');
    check(
      (drawn?.html ?? '').includes(XP_PURPLE),
      `it is filled in the strip's purple (${XP_PURPLE})`,
    );
    check(
      (drawn?.html ?? '').includes(XP_PURPLE_DARK),
      `it is outlined in the dark purple (${XP_PURPLE_DARK})`,
    );
    // A bare count and nothing else. Measured as a width rather than as a
    // string, because the page draws paths and not text: at scale 2 the 5x7
    // face puts `24` at about 22px, where the `+24 XP` this replaced was 70.
    const drawnBox = await page.$('[data-xp-popup]').then((node) => node?.boundingBox() ?? null);
    check(
      (drawnBox?.width ?? 0) > 0 && (drawnBox?.width ?? 999) < 40,
      `it is the count alone (${(drawnBox?.width ?? 0).toFixed(0)}px wide)`,
    );

    // The strip along the bottom, read off the computed style rather than off
    // the stylesheet text: the two ends of the palette have to agree.
    const fill = await page.evaluate(() => {
      const strip = document.querySelector('[data-xp-bar]');
      const bar = strip?.firstElementChild as HTMLElement | null;
      return bar ? getComputedStyle(bar).backgroundColor : '';
    });
    // `#c9a6ff` as the browser reports it.
    check(fill === 'rgb(168, 120, 232)', `the strip is the same purple (${fill})`);

    console.log('the column');
    const offsets: { dx: number; dy: number }[] = [];
    for (let sample = 0; sample < 6; sample++) {
      const damage = await centre(page, '[data-damage-id]');
      const xp = await centre(page, '[data-xp-popup]');
      if (!damage || !xp) {
        problems.push('a number went missing mid-flight');
        break;
      }
      offsets.push({ dx: xp.x - damage.x, dy: xp.y - damage.y });
      if (sample === 1) {
        await page.screenshot({ path: join(outDir, 'xp-popup.png') });
        console.log('  wrote xp-popup.png');
      }
      await page.evaluate(() => window.hudProbe?.advance(6));
    }
    check(offsets.length === 6, `both numbers survived the climb (${offsets.length} samples)`);
    check(
      offsets.every((offset) => Math.abs(offset.dx) < 2),
      `it stays in the blow's column: dx ${offsets.map((o) => o.dx.toFixed(0)).join(' ')}`,
    );
    check(
      offsets.every((offset) => offset.dy > 6),
      `and stays under it: dy ${offsets.map((o) => o.dy.toFixed(0)).join(' ')}`,
    );
    const drift = Math.max(...offsets.map((o) => o.dy)) - Math.min(...offsets.map((o) => o.dy));
    check(drift < 4, `holding station rather than converging (${drift.toFixed(1)}px of drift)`);

    console.log('the extra half-second');
    // Past the blow's own life. `NUMBER_LIFE` is 48 frames; 60 is comfortably
    // past it and comfortably short of the reward's 78.
    await page.evaluate(() => window.hudProbe?.advance(30));
    check(
      (await centre(page, '[data-damage-id]')) === null,
      'the blow’s number has gone',
    );
    const alone = await centre(page, '[data-xp-popup]');
    check(alone !== null, 'the reward is still up');
    await page.evaluate(() => window.hudProbe?.advance(6));
    const higher = await centre(page, '[data-xp-popup]');
    check(
      higher !== null && alone !== null && higher.y < alone.y,
      'and still climbing on its own',
    );
    await page.evaluate(() => window.hudProbe?.advance(12));
    check((await centre(page, '[data-xp-popup]')) === null, 'then it goes too');

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
