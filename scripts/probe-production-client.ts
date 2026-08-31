/**
 * Whether the page that ships is the game rather than the workbench (spec 253).
 *
 * Everything the spec *decides* is pure and asserted in Node -- which build a
 * URL asks for, which tabs survive the filter, when the tuning popovers are
 * built. What no headless test can reach is the half that is actually worth
 * checking, and it is the half this repo keeps rediscovering: a rule can be
 * green in `npm test` beside a `main.ts` and a `view.ts` that call none of it.
 * `visibleTabs` had a complete test file for sixty specs while spec 176 found
 * the editor writing to a world nothing could save into, and `layout-store.ts`
 * passed every one of its own tests while nothing in the shipped build imported
 * it.
 *
 * So this drives the built page twice, `probe-map-editor.ts`'s shape and for its
 * reason -- once with no query at all, where every bench, popover and readout
 * must be **gone**, and once with `?client=workbench`, where all of them must
 * come back. The second pass is what makes the first mean something: a page
 * that failed to mount, or a selector that matches nothing because it was
 * misspelled, scores a flawless zero on the first pass alone.
 *
 *   npm run build && npx tsx scripts/probe-production-client.ts
 *
 * Serves `dist/` rather than the dev server, because the question is precisely
 * what `vite build` produces. Prints a summary and exits non-zero on any
 * problem.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4348;

/** The same browser the other previews drive: no GPU here, so software GL. */
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/**
 * The six benches, by the label their button carries.
 *
 * By label because that is all a button has -- `main.ts` sets `textContent` and
 * gives them no id and no `data-tab` -- so this is the same handle every other
 * harness in `scripts/` reaches for, and a tab renamed without this list moving
 * fails here rather than silently passing.
 */
const BENCH_TABS = ['Movement sandbox', 'Rig debug', 'Map editor', 'Studio', 'VFX', 'SFX'];

/** How many of {@link TUNING_MENUS} a bench really draws. See the note there. */
const BENCH_MENUS = 7;

/**
 * The popovers, by the `aria-label` `settings-menu.ts` gives each one.
 *
 * Eight names for seven buttons: the sun menu is called `Day and night` or
 * `Light` depending on whether the player-lights panel was built beside it, so
 * a bench is expected to answer to seven of these eight and never to both.
 */
const TUNING_MENUS = [
  'View settings',
  'Day and night',
  'Light',
  'Player lights',
  'Retro filter',
  'Hike look',
  'Weather',
  'Effects',
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

/**
 * Wait for the world to actually be running.
 *
 * Off the readout's tick, which is written every frame whether or not the
 * readout is *shown* -- the property `hud.ts` has kept since spec 094 and the
 * one that lets this harness have a clock in the build that hides it. Without
 * it every count below is a measurement of a page that had not mounted, which
 * is the same answer a working game build gives.
 */
async function waitForTick(page: Page, ticks: number, timeoutMs = 90_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const text = (await page.textContent('body')) ?? '';
    last = Number(/tick (\d+)/.exec(text)?.[1] ?? -1);
    if (last >= ticks) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(`sim never reached tick ${ticks} (last seen: ${last})`);
}

interface Frame {
  /** Bench tab buttons present in the DOM, by label. */
  readonly benchTabs: readonly string[];
  /** Tuning popover buttons present in the DOM, by aria-label. */
  readonly menus: readonly string[];
  /** Whether the readout element exists at all. It always should. */
  readonly readoutPresent: boolean;
  /** What the readout says about itself: `'on'`, `'off'`, or absent. */
  readonly readout: string;
  /** Whether a tab strip was drawn at all, game tab included. */
  readonly playTab: boolean;
  /** Whether the title screen is up (spec 254). */
  readonly title: boolean;
  /** Whether it has finished loading and is offering its menu. */
  readonly titleReady: boolean;
  /** `shown` / `hidden` / `''` -- whether the interface's own layer is drawn. */
  readonly uiHud: string;
  /** Whether the DOM half of the HUD is laid out on screen. */
  readonly domHud: boolean;
  /** Which framework windows are open, by id. */
  readonly windows: string;
  /** Which of the two logotype halves the title screen settled on. */
  readonly titleLogo: string;
  /** Whether the frame-time meter is drawn. */
  readonly meterShown: boolean;
  /** Whether the meter is still publishing its numbers. It always should. */
  readonly meterPublishes: boolean;
}

async function readFrame(page: Page): Promise<Frame> {
  return page.evaluate(
    ([benches, menus]) => {
      const buttons = Array.from(document.querySelectorAll('button'));
      // Every label a button might answer to, flattened here rather than read
      // through a helper: `tsx` compiles this closure with esbuild, and a named
      // inner function arrives in the page referencing a `__name` helper that
      // was left behind on this side of the boundary.
      const texts = buttons.map((button) => button.textContent?.trim() ?? '');
      const labels = buttons.map(
        (button) => button.getAttribute('aria-label') ?? button.getAttribute('title') ?? '',
      );
      const status = document.querySelector<HTMLElement>('[data-stats-readout]');
      const meter = document.querySelector<HTMLElement>('[data-fps]');
      return {
        benchTabs: (benches ?? []).filter((label) => texts.includes(label)),
        menus: (menus ?? []).filter((label) => labels.includes(label)),
        playTab: texts.includes('Play'),
        title: document.querySelector('[data-title]') !== null,
        titleReady:
          document.querySelector<HTMLElement>('[data-title]')?.dataset['titleReady'] === 'true',
        // On the interface canvas, which is what publishes it; `data-ui-windows`
        // is on the world root two elements up.
        uiHud: document.querySelector<HTMLElement>('[data-ui-canvas]')?.dataset['uiHud'] ?? '',
        // `offsetParent` is null for a `display:none` subtree, which is the
        // question -- and not the same question as "is it in the document".
        domHud:
          document.querySelector<HTMLElement>('[data-hud-bottom]')?.offsetParent != null,
        windows:
          document.querySelector<HTMLElement>('[data-ui-windows]')?.dataset['uiWindows'] ?? '',
        titleLogo:
          document.querySelector<HTMLElement>('[data-title-logo]')?.dataset['titleLogo'] ?? 'none',
        readoutPresent: status !== null,
        readout: status?.dataset['statsReadout'] ?? '',
        // Read off the computed style rather than the inline one, so "never
        // shown" and "shown and then hidden by something else" are the same
        // answer -- which is what a player sees.
        meterShown: meter !== null && getComputedStyle(meter).display !== 'none',
        meterPublishes: meter?.dataset['fpsValue'] !== undefined,
      };
    },
    [BENCH_TABS, TUNING_MENUS] as const,
  );
}

/** Poll a frame reading until it satisfies `want`, or give up. */
async function waitFor(
  page: Page,
  want: (frame: Frame) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (want(await readFrame(page))) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function open(browser: Browser, query: string): Promise<{ page: Page; frame: Frame }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/${query}`, { waitUntil: 'domcontentloaded' });
  await waitForTick(page, 60);
  // A couple of frames past the first tick, because the tab strip and the
  // settings corner are built during the mount and the meter needs a measured
  // frame before it draws anything at all.
  await page.waitForTimeout(500);
  return { page, frame: await readFrame(page) };
}

async function main(): Promise<void> {
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    throw new Error('no dist/index.html -- run `npm run build` first');
  }

  const problems: string[] = [];
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  try {
    await waitForServer(`http://localhost:${PORT}/`);

    console.log('the shipped page, with nothing asked for:');
    const shipped = await open(browser, '');
    console.log(`  bench tabs      ${shipped.frame.benchTabs.length} of ${BENCH_TABS.length}`);
    console.log(`  tuning popovers ${shipped.frame.menus.length}`);
    console.log(`  readout         ${shipped.frame.readout || 'absent'}`);
    console.log(`  frame-time meter ${shipped.frame.meterShown ? 'drawn' : 'not drawn'}`);
    console.log(`  title screen    ${shipped.frame.title ? `up (logo: ${shipped.frame.titleLogo})` : 'absent'}`);
    console.log(`  interface       canvas ${shipped.frame.uiHud || 'unpublished'}, DOM ${shipped.frame.domHud ? 'shown' : 'hidden'}`);

    if (shipped.frame.benchTabs.length > 0) {
      problems.push(`the shipped page offers benches: ${shipped.frame.benchTabs.join(', ')}`);
    }
    // And no strip at all rather than a strip with one button on it: one tab is
    // not a choice, so `showsTabButtons` draws nothing (spec 140).
    if (shipped.frame.playTab) {
      problems.push('the shipped page still draws a tab strip, with Play alone on it');
    }
    if (shipped.frame.menus.length > 0) {
      problems.push(`the shipped page draws tuning popovers: ${shipped.frame.menus.join(', ')}`);
    }
    if (shipped.frame.readout !== 'off') {
      problems.push(`the shipped page opens with the readout "${shipped.frame.readout || 'absent'}"`);
    }
    if (shipped.frame.meterShown) {
      problems.push('the shipped page opens with the frame-time meter drawn');
    }
    // Hidden is not silent: the three cost probes read these attributes, and a
    // meter that stopped publishing when it stopped drawing would take them
    // with it. Checked here rather than trusted, because it is the one thing
    // that made the default safe to move.
    if (!shipped.frame.meterPublishes) {
      problems.push('the hidden meter stopped publishing data-fps-*, which the cost probes read');
    }
    if (!shipped.frame.readoutPresent) {
      problems.push('the readout element is gone entirely, and half the harnesses use it as a clock');
    }
    // The front door (spec 254). Checked before anything is pressed, because
    // its whole claim is that it is what the page opens on.
    if (!shipped.frame.title) {
      problems.push('the shipped page did not open on the title screen');
    } else {
      // Polled rather than waited out, this repo's rule for every harness that
      // reads a state the frame publishes: the world streams for several
      // seconds under software GL, and the menu does not exist until it has.
      // Waited out with a constant, this pressed a button that was not there
      // yet -- which is a timeout, not a failed feature.
      // Neither half of the interface may be on screen while the front door is
      // -- a skill bar over a title screen is the interface of a game that has
      // not started, and it was over the loading screen before it too.
      if (shipped.frame.uiHud !== 'hidden') {
        problems.push(`the interface layer was "${shipped.frame.uiHud || 'unpublished'}" behind the title screen`);
      }
      if (shipped.frame.domHud) {
        problems.push('the DOM HUD was on screen behind the title screen');
      }

      const ready = await waitFor(shipped.page, (frame) => frame.titleReady, 120_000);
      if (!ready) {
        problems.push('the title screen never finished loading, so Start never appeared');
      } else {
        // Options has to *work* from the menu, which is the whole reason the
        // overlay is transparent to the pointer and sits under the interface
        // canvas: the window is drawn above the title art and hears the pointer
        // through the world canvas underneath it.
        // Polled, not waited out. `data-ui-windows` is published from the
        // frame, and this environment paints a real page at about four frames
        // a second under software GL -- a constant here reads the state before
        // the frame that would have changed it, which is how this probe
        // reported a working Escape as a stuck window.
        await shipped.page.click('[data-title-entry="options"]', { position: { x: 6, y: 6 } });
        const opened = await waitFor(shipped.page, (f) => f.windows.includes('options'), 15_000);
        if (!opened) {
          problems.push('Options did nothing when pressed on the title screen');
        } else {
          // And it has to be *usable*, not merely drawn: Escape is the
          // framework's own close, so a window that takes it is a window the
          // player can reach.
          await shipped.page.keyboard.press('Escape');
          const closed = await waitFor(shipped.page, (f) => !f.windows.includes('options'), 15_000);
          if (!closed) {
            problems.push('the options window opened over the title screen but could not be closed');
          }
        }
        // Start has to reach the world, and the overlay has to go: an `inset:0`
        // element that stays behind eats every click of the game underneath it,
        // which is the failure `loading-overlay.ts` names.
        // Pressed off-centre for a reason worth keeping: a word set in
        // `pixelTextSvg` is an SVG path hit-tested against its filled geometry,
        // so a press at the exact middle of START can land in the gap between
        // two letters. The button takes its own box now (its children are out
        // of the hit test), and this stays as the harder case.
        await shipped.page.click('[data-title-entry="start"]', { position: { x: 6, y: 6 } });
        const gone = await waitFor(shipped.page, (f) => !f.title, 15_000);
        if (!gone) problems.push('pressing Start left the title screen up');
        const back = await waitFor(shipped.page, (f) => f.uiHud === 'shown', 15_000);
        if (!back) problems.push('the interface did not come back when play began');
      }
    }

    // Started, not forbidden (spec 253): the readout opens hidden and the
    // binding still reaches it, so a player who is asked for numbers can
    // produce them. Worth pressing rather than reasoning about, because
    // "opens hidden" and "cannot be shown" are the same first frame.
    await shipped.page.keyboard.press('F3');
    await shipped.page.waitForTimeout(400);
    const toggled = await readFrame(shipped.page);
    console.log(`  after F3        readout ${toggled.readout || 'absent'}`);
    if (toggled.readout !== 'on') {
      problems.push(`F3 did not bring the readout back in the shipped client (${toggled.readout || 'absent'})`);
    }
    await shipped.page.context().close();

    // The control. Every check above is an absence, and a page that failed to
    // mount -- or a label misspelled in the two lists at the top of this file --
    // passes all of them.
    console.log('\nthe same build, with ?client=workbench:');
    const bench = await open(browser, '?client=workbench');
    console.log(`  bench tabs      ${bench.frame.benchTabs.length} of ${BENCH_TABS.length}`);
    console.log(`  tuning popovers ${bench.frame.menus.length}`);
    console.log(`  readout         ${bench.frame.readout || 'absent'}`);

    const missing = BENCH_TABS.filter((label) => !bench.frame.benchTabs.includes(label));
    if (missing.length > 0) {
      problems.push(`?client=workbench did not bring back: ${missing.join(', ')}`);
    }
    if (bench.frame.menus.length < BENCH_MENUS) {
      problems.push(
        `?client=workbench brought back ${bench.frame.menus.length} tuning popovers, not ${BENCH_MENUS}`,
      );
    }
    if (!bench.frame.playTab) {
      problems.push('?client=workbench brought back the benches but drew no tab strip');
    }
    // And no front door on a bench: a menu between a developer and the thing
    // they opened the bench to look at is a click every reload.
    if (bench.frame.title) problems.push('?client=workbench opened on the title screen');
    if (bench.frame.readout !== 'on') {
      problems.push(`?client=workbench opened with the readout "${bench.frame.readout || 'absent'}"`);
    }
    await bench.page.context().close();
  } finally {
    await browser.close();
    server.kill();
  }

  if (problems.length > 0) {
    console.error('\nproblems:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nthe build ships the game, and says so; ?client=workbench is the way back.');
}

await main();
