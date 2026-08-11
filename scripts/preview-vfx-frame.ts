// Dev-only: does the VFX tab's preview actually hold the effect it is previewing?
// `npx tsx scripts/preview-vfx-frame.ts`
//
// Two reports this answers, both of which only exist once a browser has laid the
// tab out and driven the camera:
//
//  - an aura was cropped at the top as soon as the camera was raised, because the
//    preview's box was a fixed multiple of the zoom and a ring seen from overhead
//    is twice as tall on screen as one seen edge-on;
//  - half the ground was missing behind a hard horizon, and effects that drifted
//    away from the camera vanished, because the camera orbits at a distance of
//    6000 and its far plane was *also* 6000 -- so the origin sat exactly on it.
//
// Neither is visible to a headless test: `vfx-frame.test.ts` asserts the span is
// big enough, and a span is not a picture.
//
// Which check has teeth, since a green tick that cannot fail is worse than no
// tick: the sky-in-the-corner one is the far plane, and putting the old `6000`
// back makes all three frames fail on it. The top-edge one guards the framing
// half and has *not* been seen to fire -- the tightest zoom the panel offers is
// a half-width of 200 and the widest aura needs about 127, so the fit floor is
// belt-and-braces against a future effect rather than the fix for this report.
// A ring-is-closed check was tried and dropped: the telegraph's ten shafts put
// enough ink above the middle to hide a clipped ring, so it passed on the very
// bug it was written for.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4331;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/** The effect to frame: the widest aura in the library, so the box is worked hardest. */
const EFFECT = 'aura_telegraph';

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`dev server never came up at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The readout panel is drawn over the canvas, so its corner is not scenery. */
const READOUT = { width: 250, height: 165 };

function pixel(png: PNG, x: number, y: number): { r: number; g: number; b: number } {
  const i = (y * png.width + x) * 4;
  return { r: png.data[i] ?? 0, g: png.data[i + 1] ?? 0, b: png.data[i + 2] ?? 0 };
}

function distance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

/**
 * Every pixel that is the effect: not the ground, not the sky, not the readout.
 *
 * The ground colour is read out of the top-left corner rather than named, so this
 * keeps working when the Ground button is cycled.
 */
function effectPixels(png: PNG): { x: number; y: number }[] {
  const ground = pixel(png, 0, 0);
  const found: { x: number; y: number }[] = [];
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (x < READOUT.width && y < READOUT.height) continue;
      const at = pixel(png, x, y);
      if (distance(at, ground) <= 30) continue;
      if (distance(at, SKY) <= 40) continue;
      found.push({ x, y });
    }
  }
  return found;
}

/** Fraction of pixels in a band of rows that are not the frame's top-left colour. */
function inkInBand(png: PNG, from: number, rows: number): number {
  const base = pixel(png, 0, 0);
  let hits = 0;
  for (let y = from; y < from + rows; y++) {
    for (let x = 0; x < png.width; x++) {
      if (x < READOUT.width && y < READOUT.height) continue;
      if (distance(pixel(png, x, y), base) > 30) hits += 1;
    }
  }
  return hits / (rows * png.width);
}

/** The preview's background colour, which is the one thing that is not ground. */
const SKY = { r: 0x8f, g: 0xd6, b: 0xc8 };

function isSky(png: PNG, x: number, y: number): boolean {
  const i = (y * png.width + x) * 4;
  return (
    Math.abs((png.data[i] ?? 0) - SKY.r) +
      Math.abs((png.data[i + 1] ?? 0) - SKY.g) +
      Math.abs((png.data[i + 2] ?? 0) - SKY.b) <
    40
  );
}

async function main(): Promise<void> {
  const shots = join(root, '.claude', 'screenshots');
  if (!existsSync(shots)) mkdirSync(shots, { recursive: true });

  // The binary rather than npx, and stdio ignored: killing the wrapper leaves the
  // server it spawned running, and the open pipes hold this script's own event
  // loop open long after it has finished.
  const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });
  const problems: string[] = [];
  const frames: PNG[] = [];

  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'VFX', exact: true }).click();
    // Scoped to this tab: every tab that has been opened stays in the DOM behind
    // `display:none`, so a bare `canvas` selector finds the Play tab's hidden one.
    await page.waitForSelector('#vfx-studio canvas');
    await page.getByRole('button', { name: EFFECT, exact: true }).click();
    await page.waitForTimeout(1200);

    const canvas = page.locator('#vfx-studio canvas').first();
    frames.push(PNG.sync.read(await canvas.screenshot()));

    // Raise the camera to the highest the panel allows, which is where the
    // cropping was reported. The popover does not have to be *open* -- every
    // control is built at mount and only hidden -- so the slider is written
    // directly rather than through a click path that would break the moment the
    // cog's buttons were relabelled.
    const setSlider = async (label: string, to: 'min' | 'max'): Promise<number> =>
      page.evaluate(
        ([name, end]) => {
          const inputs = Array.from(document.querySelectorAll('#vfx-studio input[type=range]')) as HTMLInputElement[];
          const input = inputs.find((entry) => (entry.parentElement?.textContent ?? '').includes(name as string));
          if (!input) return 0;
          input.value = end === 'min' ? input.min : input.max;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return Number(input.value);
        },
        [label, to] as const,
      );

    const raised = await setSlider('Height', 'max');
    if (raised <= 0) problems.push('could not find the camera Height slider');
    await page.waitForTimeout(1200);
    frames.push(PNG.sync.read(await canvas.screenshot()));

    // And zoomed all the way in, which is where a fixed box crops hardest -- the
    // fit is a *floor*, so the tightest zoom the panel offers must still hold the
    // whole sigil. Without that floor this frame is a ring with its top sliced
    // off, which is the report.
    const zoomed = await setSlider('View span', 'min');
    if (zoomed <= 0) problems.push('could not find the View span slider');
    await page.waitForTimeout(1200);
    frames.push(PNG.sync.read(await canvas.screenshot()));

    frames.forEach((png, index) => {
      const where = ['default camera', `camera at ${raised} degrees`, 'zoomed all the way in'][index] ?? '?';
      // Nothing may touch the top edge: that is what "cut off on top" looks like.
      const top = inkInBand(png, 0, 4);
      if (top > 0.02) problems.push(`${where}: the effect reaches the top edge (${(top * 100).toFixed(1)}% ink)`);
      // And the ground must reach the top of the frame rather than ending in a
      // horizon halfway up, which is what the far-plane clip looked like. The
      // corner is the test: sky there means the ground ran out.
      if (isSky(png, 0, 0)) problems.push(`${where}: sky in the top corner -- the ground stops short`);

      // And something of the effect is actually on screen, so a frame that
      // clipped the lot cannot pass by being uniformly empty.
      const ink = effectPixels(png);
      if (ink.length < 200) problems.push(`${where}: almost nothing of the effect is drawn (${ink.length} pixels)`);
    });
  } finally {
    await browser.close();
    server.kill();
  }

  const first = frames[0];
  if (!first || frames.length < 3) throw new Error('the preview was never photographed');
  const sheet = new PNG({ width: first.width * frames.length, height: first.height });
  frames.forEach((png, index) => {
    const ox = index * first.width;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const src = (y * png.width + x) * 4;
        const dst = (y * sheet.width + ox + x) * 4;
        sheet.data[dst] = png.data[src] ?? 0;
        sheet.data[dst + 1] = png.data[src + 1] ?? 0;
        sheet.data[dst + 2] = png.data[src + 2] ?? 0;
        sheet.data[dst + 3] = 255;
      }
    }
  });
  writeFileSync(join(shots, 'vfx-preview.png'), PNG.sync.write(sheet));
  console.log(`wrote ${join(shots, 'vfx-preview.png')} -- ${EFFECT}: default camera, raised, zoomed in`);

  if (problems.length > 0) {
    console.error(`\nFAILED:\n  - ${problems.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('OK: the sigil is whole at every camera the panel offers, and the ground reaches the top of frame.');
}

await main();
