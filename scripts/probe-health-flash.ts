/**
 * Measure the white chunk on a real health bar, in a real browser (spec 145).
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
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { FLASH_DRAIN_MS, FLASH_HOLD_MS, SHAKE_MS } from '../src/render/iso3d/world/health-bar.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4323;

const CHROMIUM_PATH = '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'];

/** How long to watch a fight for, in ms. Long enough for several bursts. */
const WATCH_MS = 9_000;

/**
 * How far the game's clock is slowed for the flinch measurement, and how long
 * in real seconds to watch it for.
 *
 * This environment paints about five frames a second under software GL, whatever
 * the viewport size -- it is the scene update that costs, not the fill -- so a
 * 200ms kick at 15Hz gets one sample, and one sample is not an oscillation. It
 * was measured as zero direction changes on a bar that was flinching perfectly
 * well.
 *
 * So the *page's* clock is slowed instead. The renderer turns elapsed real time
 * into ticks and everything downstream is a function of ticks, so a scaled
 * animation-frame stamp is slow motion and nothing else: the same ticks, the
 * same events, the same kick, spread over eight drawn frames instead of one.
 * The trade is that game seconds cost eight real ones, which is why this runs
 * for a minute to see a couple of swings land.
 */
const TIME_SCALE = 0.125;
const FLINCH_WATCH_MS = 60_000;

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
  /** Where the bar was placed this frame, in CSS pixels (spec 146). */
  readonly left: number;
  readonly top: number;
  /**
   * Where the health track really landed, measured from the pixel the bar was
   * placed at. Constant unless something changed the holder's own height.
   */
  readonly drop: number;
  /** Whether a wind-up bar was showing under it this frame. */
  readonly casting: boolean;
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
    const samples: {
      t: number;
      id: string;
      health: number;
      ghost: number;
      left: number;
      top: number;
      drop: number;
      casting: boolean;
    }[] = [];
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
          // `style.left` rather than `offsetLeft`: the flinch is a couple of
          // pixels and the placement is written to fractions of one, which an
          // integer offset would round away.
          left: parseFloat(holder.style.left || '0'),
          top: parseFloat(holder.style.top || '0'),
          // Where the track *actually* sits, against where the bar was placed.
          // The holder is anchored by its bottom, so anything that changes its
          // height moves the health bar -- and this is the only way to see that
          // from outside: both numbers move together under the flinch, so the
          // difference is the layout on its own.
          drop: (track as HTMLElement).getBoundingClientRect().top - parseFloat(holder.style.top || '0'),
          casting: (holder.children[1] as HTMLElement | undefined)?.style.display !== 'none',
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
 * Whether the bars actually flinched, and how hard (spec 146).
 *
 * A bar is placed over a body that is walking, so it moves anyway -- the thing
 * that tells a kick apart from a stroll is that a kick *reverses*: at 60Hz a
 * 15Hz rattle changes direction two or three times inside its 200ms, and a body
 * crossing the screen never does. So the measurement is direction changes in
 * the window after a blow, against direction changes outside every window.
 */
function reportFlinches(samples: readonly Sample[], scale: number, problems: string[]): void {
  // The samples are stamped in real milliseconds and the kick lasts a fixed
  // number of *game* ones, so the window is the kick divided by the slowdown.
  const window = SHAKE_MS / scale;
  let best = 0;
  let struck = 0;
  let quiet = 0;
  let quietFrames = 0;
  let travelled = 0;
  for (const id of [...new Set(samples.map((sample) => sample.id))]) {
    const track = forBody(samples, id);
    const blows = track.filter((sample, index) => index > 0 && sample.health < (track[index - 1]?.health ?? 0));
    struck += blows.length;
    for (const blow of blows) {
      const during = track.filter((sample) => sample.t >= blow.t && sample.t <= blow.t + window);
      best = Math.max(best, reversals(during));
    }
    // Everything at least a kick away from any blow, as the control.
    const calm = track.filter((sample) => !blows.some((blow) => sample.t >= blow.t && sample.t <= blow.t + window));
    quiet += reversals(calm);
    quietFrames += calm.length;
    for (let i = 1; i < track.length; i++) {
      travelled = Math.max(travelled, Math.abs((track[i]?.left ?? 0) - (track[i - 1]?.left ?? 0)));
    }
  }
  console.log(
    `  ${struck} blow(s) seen; biggest flinch ${best} direction changes in the kick's ${SHAKE_MS}ms ` +
      `(${quiet} in ${quietFrames} unstruck frames, biggest step ${travelled.toFixed(2)}px)`,
  );
  // A run that saw no blows has measured nothing, and saying "no bar flinched"
  // about it would be a harness failure wearing a product failure's clothes.
  if (struck === 0) {
    problems.push('the stepped run never saw a blow land, so the flinch went unmeasured');
    return;
  }
  // Two reversals is one full rattle. One could be a body turning round.
  if (best < 2) problems.push(`no bar ever flinched: best was ${best} direction changes after a blow`);
}

/**
 * Whether a wind-up ever moved the health bar.
 *
 * The cast bar appears under the health bar the moment a body commits to a
 * blow, and the holder both bars live in is anchored by its bottom -- so for as
 * long as the cast bar took part in layout, every wind-up in the game shoved the
 * health bar up by its height and dropped it back when the swing landed. That is
 * invisible to a screenshot and invisible to the widths: it is the *height* of
 * an element that is sometimes there. Measured as the gap between where the bar
 * was placed and where its track really landed, which is constant if and only if
 * nothing changes the holder's height.
 */
function reportSteadiness(samples: readonly Sample[], problems: string[]): void {
  let casting = 0;
  let worst = 0;
  for (const id of [...new Set(samples.map((sample) => sample.id))]) {
    const track = forBody(samples, id);
    casting += track.filter((sample) => sample.casting).length;
    const drops = track.map((sample) => sample.drop);
    const low = Math.min(...drops);
    const high = Math.max(...drops);
    worst = Math.max(worst, high - low);
  }
  console.log(`  bar drift while ${casting} wind-up frames were drawn: ${worst.toFixed(2)}px`);
  if (casting === 0) {
    problems.push('no wind-up bar was ever drawn, so nothing checked whether one moves the bar');
    return;
  }
  // Sub-pixel is the projection landing on a different device pixel; anything
  // approaching the cast bar's own height is it pushing the health bar around.
  if (worst > 1) problems.push(`a wind-up moved the health bar by ${worst.toFixed(2)}px`);
}

/** How many times a run of placements changed direction sideways. */
function reversals(track: readonly Sample[]): number {
  let count = 0;
  let previous = 0;
  for (let i = 1; i < track.length; i++) {
    const step = (track[i]?.left ?? 0) - (track[i - 1]?.left ?? 0);
    // A step of nothing is not a direction; the anchor is written to fractions
    // of a pixel, so anything smaller than this is the projection breathing.
    if (Math.abs(step) < 0.05) continue;
    const direction = Math.sign(step);
    if (previous !== 0 && direction !== previous) count++;
    previous = direction;
  }
  return count;
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

    // A clock the harness can slow down, installed before the page's own script
    // runs. `__timeScale` stays at 1 for everything except the flinch, so the
    // flash measurement and the picture are of a game running at normal speed.
    //
    // Wrapping the animation frame rather than `performance.now` because that is
    // where the renderer reads its elapsed time from -- the stamp the callback is
    // handed. It accumulates a scaled timeline instead of scaling the stamp
    // itself, so slowing down mid-session cannot jump the clock backwards.
    await page.addInitScript(() => {
      const win = window as unknown as { __timeScale: number };
      win.__timeScale = 1;
      const real = window.requestAnimationFrame.bind(window);
      let last: number | null = null;
      let scaled = 0;
      window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
        real((stamp) => {
          if (last === null) last = stamp;
          scaled += (stamp - last) * win.__timeScale;
          last = stamp;
          callback(scaled);
        });
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
    reportSteadiness(samples, problems);

    // Then the flinch, and the picture, both in slow motion (see TIME_SCALE).
    // A second fight for each, because a Grazer does not survive nine seconds
    // of Slash: by the end of a sampling run every bar left on screen is at
    // full health with nothing to show.
    await page.evaluate((scale) => {
      (window as unknown as { __timeScale: number }).__timeScale = scale;
    }, TIME_SCALE);

    if (await pickAFight(page)) {
      reportFlinches(await watchBars(page, FLINCH_WATCH_MS), TIME_SCALE, problems);
    } else {
      problems.push('nothing left to fight for the flinch');
    }

    // The picture, from the same slowed clock. A screenshot costs a few hundred
    // milliseconds under software GL and the whole flash lasts about six
    // hundred, so at full speed the poll found a chunk and the shot came back
    // showing a bar that had already drained -- twice. In slow motion the same
    // flash is five real seconds wide and an ordinary screenshot lands inside
    // it, which beats the two freezes tried before this: pausing the debugger
    // halts the renderer's main thread and the capture never returns at all,
    // and pausing virtual time works but leaves the page's clock racing
    // afterwards, which silently starved the flinch watch of frames.
    if (!(await pickAFight(page))) problems.push('nothing left to fight for the picture');
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
      // The bar is 52 CSS px wide and hangs by its own middle; a band either
      // side shows the world it has to read against.
      await page.screenshot({
        path: join(outDir, 'health-flash.png'),
        clip: {
          x: Math.max(0, caught.x - 130),
          y: Math.max(0, caught.y - 70),
          width: 260,
          height: 120,
        },
        scale: 'css',
      });
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
