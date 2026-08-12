/**
 * Measure the white chunk on a real health bar, in a real browser (spec 143).
 *
 *   npm run build && npx tsx scripts/probe-health-flash.ts
 *
 * `health-bar.test.ts` proves the rule -- one chunk per burst, held then drained
 * -- as arithmetic over a time it is handed. What it cannot prove is that the
 * HUD hands it the right time, that the two bands are stacked the way the CSS
 * thinks, or that a chunk is ever *drawn*: a bar whose white band sat behind an
 * opaque track would pass every test in Node and show nothing on screen.
 *
 * So this drives the shipped page, picks a fight, and samples the two bands'
 * widths off the real DOM every animation frame -- the widths, not a screenshot,
 * because a chunk is a number of pixels and reading it back is an equality test
 * rather than a threshold on a photograph. The picture beside it is for a person.
 *
 * Serves `dist/` rather than the dev server, for the same reason
 * `preview-world.ts` does: what is measured is what ships.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { FLASH_DRAIN_MS, FLASH_HOLD_MS } from '../src/render/iso3d/world/health-bar.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4323;

const CHROMIUM_PATH = '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'];

/** How long to watch a fight for, in ms. Long enough for several bursts. */
const WATCH_MS = 9_000;

/**
 * How much wider the white must be than the fill to count as drawn, as a
 * fraction of the track. Below this it is a rounding difference between two
 * percentage widths rather than a chunk anybody can see.
 */
const VISIBLE = 0.01;

interface Sample {
  readonly t: number;
  readonly id: string;
  readonly health: number;
  readonly ghost: number;
}

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server never came up at ${url}`);
}

/** Where every body with a bar is, and which one is us. */
async function bars(page: Page): Promise<{ id: string; x: number; y: number; self: boolean }[]> {
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
 * Watch every bar on screen for `ms`, one sample per animation frame.
 *
 * The widths are read as *fractions of the track* rather than as pixels, since
 * that is what the HUD writes and what the pure field decided; a percentage
 * string parsed back is the same number that went in.
 */
async function watchBars(page: Page, ms: number): Promise<Sample[]> {
  // Written as a loop over an awaited frame rather than a recursive callback:
  // a *named* function inside `page.evaluate` is compiled with esbuild's
  // `__name` helper, which does not exist in the page and throws on the first
  // call. Every function crossing into the browser here is anonymous.
  return page.evaluate(async (duration) => {
    const samples: { t: number; id: string; health: number; ghost: number }[] = [];
    const start = performance.now();
    while (performance.now() - start < duration) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now() - start;
      for (const node of Array.from(document.querySelectorAll('[data-entity]'))) {
        const holder = node as HTMLElement;
        if (holder.style.display === 'none') continue;
        const track = holder.firstElementChild;
        const ghost = track?.children[0] as HTMLElement | undefined;
        const fill = track?.children[1] as HTMLElement | undefined;
        if (!ghost || !fill) continue;
        samples.push({
          t: now,
          id: holder.dataset['entity'] ?? '',
          health: parseFloat(fill.style.width) / 100,
          ghost: parseFloat(ghost.style.width) / 100,
        });
      }
    }
    return samples;
  }, ms);
}

/** One body's samples, in order. */
function forBody(samples: readonly Sample[], id: string): Sample[] {
  return samples.filter((sample) => sample.id === id);
}

/** The stretches where a body was showing white, as [first, last] sample pairs. */
function flashes(track: readonly Sample[]): { start: number; end: number; peak: number }[] {
  const runs: { start: number; end: number; peak: number }[] = [];
  let open: { start: number; end: number; peak: number } | null = null;
  for (const sample of track) {
    const showing = sample.ghost - sample.health > VISIBLE;
    if (showing) {
      if (!open) open = { start: sample.t, end: sample.t, peak: sample.ghost - sample.health };
      else {
        open.end = sample.t;
        open.peak = Math.max(open.peak, sample.ghost - sample.health);
      }
    } else if (open) {
      runs.push(open);
      open = null;
    }
  }
  if (open) runs.push(open);
  return runs;
}

/**
 * Right-click bodies until one of them is being attacked (spec 070).
 *
 * The bars are read for their pixels rather than the camera projection being
 * re-derived here, for the reason `preview-world.ts` gives: arithmetic in a
 * harness tests the harness's copy of the projection, and clicking what is on
 * screen is the question a player asks.
 */
async function pickAFight(page: Page): Promise<boolean> {
  for (const target of (await bars(page)).filter((bar) => !bar.self)) {
    await page.mouse.click(target.x, target.y + 40, { button: 'right' });
    await page.waitForTimeout(400);
    // The status block is one element of several lines (`white-space:pre`), so
    // the target line is matched *inside* its text rather than at the start of
    // it -- looking for a div whose text begins "target" finds nothing, and
    // reports a fight that is happening as one that is not.
    const readout = await page.$$eval('div', (nodes) => {
      for (const node of nodes) {
        const line = /^target .*$/m.exec(node.textContent ?? '');
        if (line) return line[0];
      }
      return '';
    });
    if (readout && !/no target/.test(readout)) {
      console.log(`  ${readout}`);
      return true;
    }
  }
  return false;
}

/** What the sampled bars did, per body, and whether any of it is wrong. */
function reportFlashes(samples: readonly Sample[], problems: string[]): void {
  let drawn = 0;
  for (const id of [...new Set(samples.map((sample) => sample.id))]) {
    const runs = flashes(forBody(samples, id));
    if (runs.length === 0) continue;
    drawn += runs.length;
    const longest = runs.reduce((best, run) => (run.end - run.start > best.end - best.start ? run : best));
    console.log(
      `  entity ${id}: ${runs.length} flash(es), longest ${Math.round(longest.end - longest.start)}ms, ` +
        `biggest chunk ${(longest.peak * 100).toFixed(1)}% of the bar`,
    );
    // The whole point of the throttle: a burst is one chunk. A flash that
    // outran hold+drain by a wide margin would mean the window is being
    // restarted per hit and never resolving -- which is what a debounce here
    // would look like, and it is the failure worth a red run rather than a
    // shrug, since a body under sustained fire would hold white forever.
    const ceiling = (FLASH_HOLD_MS + FLASH_DRAIN_MS) * 3;
    if (longest.end - longest.start > ceiling) {
      problems.push(
        `entity ${id} held white for ${Math.round(longest.end - longest.start)}ms, over the ${ceiling}ms ceiling`,
      );
    }
  }
  console.log(`  flashes drawn: ${drawn}`);
  if (drawn === 0) problems.push('no bar ever drew a white chunk during the fight');
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    throw new Error('no dist/ -- run `npm run build` first');
  }

  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  const problems: string[] = [];
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
      // The unit importer reports root motion it stripped on every load
      // (spec 118). It is advisory, it is about the assets rather than about
      // this page, and it is what the console looks like when everything is
      // working -- so it is not a problem with the bars.
      if (message.type() === 'error' && !message.text().startsWith('[units]')) {
        problems.push(message.text());
      }
    });

    // Pinned seed, like every other harness here: a world that moved between
    // runs cannot tell a regression from a Tuesday.
    await page.goto(`http://localhost:${PORT}/?seed=20260806`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });
    await page.waitForTimeout(1_500);

    if (!(await pickAFight(page))) problems.push('never got a target to attack');

    // Sample every frame while that fight runs, and say what the bars did.
    const samples = await watchBars(page, WATCH_MS);
    reportFlashes(samples, problems);

    // Then pick another fight for the picture. Two fights rather than one,
    // because a Grazer does not survive nine seconds of Slash -- by the end of
    // the sampling run every bar left on screen is at full health with nothing
    // to show, and a picture taken then is of a bar that is merely red.
    if (!(await pickAFight(page))) problems.push('nothing left to fight for the picture');

    // Clipped to the bar rather than the whole frame, and the clip is chosen
    // from the same poll that found the chunk. A full-page shot costs more than
    // the flash lasts under software GL -- the poll would report a chunk and
    // the picture would be of the bar half a second later, drained and red,
    // which is exactly what the first run of this produced.
    let caught: { x: number; y: number; chunk: number } | null = null;
    for (let attempt = 0; attempt < 600 && !caught; attempt++) {
      caught = await page.evaluate((visible) => {
        for (const node of Array.from(document.querySelectorAll('[data-entity]'))) {
          const holder = node as HTMLElement;
          const track = holder.firstElementChild;
          const ghost = track?.children[0] as HTMLElement | undefined;
          const fill = track?.children[1] as HTMLElement | undefined;
          if (!ghost || !fill) continue;
          const chunk = parseFloat(ghost.style.width) - parseFloat(fill.style.width);
          if (chunk > visible * 100) {
            return { x: holder.offsetLeft, y: holder.offsetTop, chunk: chunk / 100 };
          }
        }
        return null;
      }, VISIBLE);
    }
    if (caught) {
      // Freeze the page before photographing it.
      //
      // A screenshot costs a few hundred milliseconds under software GL and the
      // whole flash lasts about six hundred, so a shot taken *after* the poll
      // found a chunk is a picture of the bar half a second later -- drained,
      // red, and proving nothing. Two runs of this produced exactly that.
      //
      // Frozen by stopping the page's *clock*: no timer fires, no animation
      // frame is served, so the bar holds the widths that were measured and the
      // world holds the frame they were measured against. Not by pausing the
      // debugger, which was tried first and is worse than useless here -- it
      // halts the renderer's main thread, and a capture then never returns.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
      // The bar is 52 CSS px wide and hangs by its own middle; a band either
      // side shows the world it has to read against.
      const clip = {
        x: Math.max(0, caught.x - 130),
        y: Math.max(0, caught.y - 70),
        width: 260,
        height: 120,
      };
      // Captured through CDP rather than `page.screenshot`, which settles the
      // page by waiting on an animation frame that a stopped clock never serves.
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...clip, scale: 1 },
      });
      await writeFile(join(outDir, 'health-flash.png'), Buffer.from(shot.data, 'base64'));
      await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance' });
      console.log(`  wrote health-flash.png -- a ${(caught.chunk * 100).toFixed(0)}% chunk showing`);
    } else {
      await page.screenshot({ path: join(outDir, 'health-flash.png') });
      problems.push('never caught a frame with a chunk showing');
    }
  } finally {
    await browser.close();
    server.kill();
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ! ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('  ok');
  }
}

await main();
