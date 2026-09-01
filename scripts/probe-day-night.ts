/**
 * Whether the world clock is wired to anything (spec 263).
 *
 * The half no headless test can reach, and on this feature that is not a
 * formality. Every rule about the cycle is asserted in Node -- the segment
 * table, the hour, `darkness`, the resolver, the flag -- and all of it would go
 * on passing beside a `scene.ts` that never called `resolveSkyHours`, which is
 * exactly the shape of what spec 176 found for markers and spec 254 for the
 * shipped frame. Worse, the failure is invisible: a scene still lit by
 * `FIXED_DAYLIGHT` looks *correct*, just permanently mid-afternoon, which is the
 * bug this spec exists to fix.
 *
 * So it drives the shipped `dist/` build past the title screen and asks three
 * things a green suite cannot:
 *
 *  1. **The default is the world's clock.** With no query at all the readout has
 *     to say so and has to say `pinned` nowhere -- because a page that ignored
 *     the clock and a page that pinned it would both look stable.
 *  2. **`?clock=` reaches the frame.** `data-world-clock` is published from the
 *     clock the frame actually drew with rather than from the tick, so a pin
 *     that parsed and reached nothing reads as absent here.
 *  3. **The sky is actually darker at night**, measured off the canvas. This is
 *     the one that matters: the first two are the readout agreeing with itself,
 *     and only the pixels say the hour reached a light.
 *
 * The measurement is the **middle of the frame** rather than the whole of it,
 * because the HUD, the tab chrome and the title's leftovers are not the world --
 * and it is a *ratio* between two loads of the same page rather than an absolute
 * brightness, which has nothing to be wrong about: the retro pass quantizes, the
 * grade is off, and what is being asked is only "did night come out darker".
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4353;
const VIEWPORT = { width: 900, height: 620 } as const;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
/** Software WebGL: there is no GPU in CI or in an agent's container. */
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

/**
 * Polled rather than waited out, which every probe in this tree has had to learn
 * separately: this environment paints the page at about five frames a second
 * under software GL, and the readout is published from the frame -- so a fixed
 * wait reads the state before the frame that would have set it.
 */
async function readoutUntil(page: Page, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = (await page.getAttribute('[data-world-clock]', 'data-world-clock')) ?? '';
    if (last !== '') return last;
    await page.waitForTimeout(250);
  }
  return last;
}

/**
 * Mean luminance of the middle of the frame, in [0, 1], with the picture kept.
 *
 * Off a **screenshot** rather than off the canvas, which was the first cut and
 * silently read 0.0000 for every hour: a WebGL context this renderer builds
 * without `preserveDrawingBuffer` has nothing left in its drawing buffer once
 * the frame is composited, so `drawImage` from it copies a cleared surface.
 * Every check passed except the one that mattered, and it failed identically at
 * noon and at midnight -- which is what "measuring nothing" looks like when the
 * comparison is a ratio. `probe-exempt.ts` and `probe-living-ground.ts` both
 * take screenshots for this reason.
 *
 * The middle half rather than the whole frame, because the HUD and the tab
 * chrome are not the world.
 */
async function worldBrightness(page: Page, name: string): Promise<number> {
  const shot = await page.screenshot();
  const png = PNG.sync.read(shot);
  await writeFile(join(outDir, name), shot);

  const cropW = Math.floor(png.width / 2);
  const cropH = Math.floor(png.height / 2);
  const x0 = Math.floor((png.width - cropW) / 2);
  const y0 = Math.floor((png.height - cropH) / 2);

  let sum = 0;
  for (let y = y0; y < y0 + cropH; y++) {
    for (let x = x0; x < x0 + cropW; x++) {
      const i = (y * png.width + x) * 4;
      sum += (0.2126 * (png.data[i] ?? 0) + 0.7152 * (png.data[i + 1] ?? 0) + 0.0722 * (png.data[i + 2] ?? 0)) / 255;
    }
  }
  return sum / (cropW * cropH);
}

interface Look {
  readonly readout: string;
  readonly brightness: number;
}

async function open(browser: Browser, query: string, name: string): Promise<Look> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(`http://localhost:${PORT}/${query}`, { waitUntil: 'domcontentloaded' });

  // The shipped page opens on the title screen (spec 255) and the world behind
  // it is running, but a half-transparent overlay would be measured along with
  // the sky -- so Start is pressed rather than waited out.
  const start = page.locator('[data-title-entry="start"]');
  try {
    await start.waitFor({ state: 'visible', timeout: 60_000 });
    await start.click();
  } catch {
    // `?client=workbench` never draws one, which is not an error here.
  }

  const readout = await readoutUntil(page);
  // Long enough for the world to have streamed in and the camera to have
  // settled: what is being compared is two frames of the same scene.
  await page.waitForTimeout(6000);
  const brightness = await worldBrightness(page, name);
  await page.close();
  return { readout, brightness };
}

function phaseOf(readout: string): string {
  return /phase=(\w+)/.exec(readout)?.[1] ?? '';
}

async function main(): Promise<void> {
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    throw new Error('no dist/index.html -- run `npm run build` first');
  }

  await mkdir(outDir, { recursive: true });
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
    const shipped = await open(browser, '', 'day-night-default.png');
    console.log(`  data-world-clock  ${shipped.readout || 'ABSENT'}`);
    console.log(`  world brightness  ${shipped.brightness.toFixed(4)}`);
    // A fresh server is at tick 0, which is the first tick of Day -- so the
    // shipped page opens in daylight and, crucially, says it is *not* pinned.
    check(shipped.readout !== '', 'the shipped page publishes data-world-clock');
    check(phaseOf(shipped.readout) === 'day', 'it opens in the day phase, as a fresh world does');
    check(!shipped.readout.includes('pinned'), 'and it is on the world clock rather than pinned');

    console.log('\npinned to the middle of the night (?clock=night):');
    const night = await open(browser, '?clock=night', 'day-night-night.png');
    console.log(`  data-world-clock  ${night.readout || 'ABSENT'}`);
    console.log(`  world brightness  ${night.brightness.toFixed(4)}`);
    check(phaseOf(night.readout) === 'night', 'the pin reaches the frame the page drew with');
    check(night.readout.includes('pinned'), 'and the readout says it is pinned');
    check(night.readout.includes('darkness=1.00'), 'darkness is at the top of its range');
    check(night.readout.includes('sun=down'), 'and the sun is below the horizon');

    console.log('\npinned to noon (?clock=12):');
    const noon = await open(browser, '?clock=12', 'day-night-noon.png');
    console.log(`  data-world-clock  ${noon.readout || 'ABSENT'}`);
    console.log(`  world brightness  ${noon.brightness.toFixed(4)}`);
    check(phaseOf(noon.readout) === 'day', 'an hour pins as readily as a phase name');
    check(noon.readout.includes('darkness=0.00'), 'and noon is the bottom of the darkness range');

    console.log('\nwhat the hour did to the picture:');
    const ratio = noon.brightness > 0 ? night.brightness / noon.brightness : 1;
    console.log(`  night / noon      ${ratio.toFixed(3)}`);
    // The one check that says the hour reached a light rather than only a
    // readout. Generous on purpose: what is being asked is "darker", and the
    // exact figure is a property of the ramp somebody is allowed to retune.
    check(night.brightness >= 0 && noon.brightness >= 0, 'both frames were sampled');
    check(ratio < 0.75, 'night comes out markedly darker than noon, on the canvas');
  } finally {
    await browser.close();
    server.kill();
  }

  console.log('');
  if (problems.length > 0) {
    console.log(`${String(problems.length)} problem(s):`);
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('the world clock reaches the shipped frame.');
    console.log('wrote .claude/screenshots/day-night-{default,night,noon}.png');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
