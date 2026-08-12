/**
 * Photograph the refusal stack in the real page (spec 143).
 *
 * Everything the stack *decides* -- what lives, for how long, in what order,
 * with what count -- is pure and asserted in `error-log.test.ts`. What no
 * headless test can see is the half that made this spec worth writing: that the
 * column is pinned by its bottom edge and grows upward, that the pixel font is
 * legible in red over grass, and that a line of it does not run off the side of
 * the frame or land under the window buttons.
 *
 *   npm run build && npx tsx scripts/preview-refusals.ts
 *
 * Serves `dist/` rather than the dev server, so what is photographed is what
 * ships. Writes .claude/screenshots/refusals*.png.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4321;

/** The same browser the other previews drive: no GPU here, so software GL. */
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
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

/**
 * What the stack is saying, top line first.
 *
 * Read off `data-text`, which the HUD writes beside the SVG it draws, so this
 * is the string that was rendered rather than one this script composed.
 */
async function readStack(page: Page): Promise<string[]> {
  return page.$$eval('[data-error-stack] [data-text]', (nodes) =>
    nodes.map((node) => node.getAttribute('data-text') ?? ''),
  );
}

/** Where each line of the stack actually sits, in CSS pixels. */
async function stackBoxes(
  page: Page,
): Promise<{ text: string; top: number; bottom: number; right: number }[]> {
  return page.$$eval('[data-error-stack] [data-text]', (nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return {
        text: node.getAttribute('data-text') ?? '',
        top: box.top,
        bottom: box.bottom,
        right: box.right,
      };
    }),
  );
}

/** A rectangle of a screenshot, so the close-up is the same frame as the wide shot. */
function crop(shot: Buffer, x: number, y: number, width: number, height: number): PNG {
  const source = PNG.sync.read(shot);
  const out = new PNG({ width, height });
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const from = ((y + row) * source.width + (x + column)) * 4;
      const to = (row * width + column) * 4;
      out.data[to] = source.data[from] ?? 0;
      out.data[to + 1] = source.data[from + 1] ?? 0;
      out.data[to + 2] = source.data[from + 2] ?? 0;
      out.data[to + 3] = source.data[from + 3] ?? 255;
    }
  }
  return out;
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

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
      // The unit importer's travel notices are a standing report about the pig's
      // clips, not a fault in this page -- `preview-studio.ts` skips them too.
      if (message.type() === 'error' && !message.text().startsWith('[units]')) {
        problems.push(message.text());
      }
    });

    // Pinned seed, for the same reason `preview-world.ts` pins one.
    await page.goto(`http://localhost:${PORT}/?seed=20260806`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });
    await waitForTick(page, 150);
    await page.mouse.move(640, 400);

    // Two refusals that are not the same refusal, because losing the first of
    // two is what the single line did wrong.
    //
    // Mend is a self-cast: a press asks for it outright, with nothing to aim
    // (`aim.ts`). Six presses inside its wind-up is one cast and five refusals,
    // and they arrive from the *server* rather than from the client's own
    // cooldown table -- which is the path worth photographing, since it is the
    // one that crosses the wire.
    for (let press = 0; press < 6; press++) {
      await page.keyboard.press('Digit7');
      await page.waitForTimeout(60);
    }
    // ...and then a *second* kind of refusal from the same ability, which is
    // the case the one-line notice could not show at all: once the wind-up has
    // finished, Mend is on a ten-second cooldown, so the next press is refused
    // for a different reason and takes a line of its own.
    await page.waitForTimeout(2200);
    await page.keyboard.press('Digit7');
    await page.waitForTimeout(250);

    // Read, then photographed, then judged -- in that order and with nothing
    // slow in between. A line lives three and a half seconds, and an earlier
    // draft spent most of that in `$$eval` calls before the shutter, so the
    // picture came out with the older of the two lines already expired.
    const lines = await readStack(page);
    const boxes = await stackBoxes(page);
    // *One* capture, cropped here rather than a second `clip:` screenshot.
    // Two shots are a second apart under software GL, and the first line of a
    // stack that lives three and a half seconds expired between them -- so the
    // close-up came back with one line in it and the wide shot with two.
    const shot = await page.screenshot();
    await writeFile(join(outDir, 'refusals.png'), shot);
    await writeFile(join(outDir, 'refusals-corner.png'), PNG.sync.write(crop(shot, 600, 580, 680, 220)));
    console.log('  wrote refusals.png and refusals-corner.png');

    console.log(`  stack: ${JSON.stringify(lines)}`);
    if (lines.length === 0) problems.push('nothing was said about a refused cast');
    if (lines.length < 2) {
      // The whole complaint against the line this replaces: a second refusal
      // overwrote the first.
      problems.push('two different refusals did not both survive');
    }
    if (!lines.some((line) => /X\d+$/.test(line))) {
      problems.push('a repeat did not coalesce into a count');
    }
    for (const line of lines) {
      if (line !== line.toUpperCase()) problems.push(`"${line}" is not in the font's one case`);
      if (/[a-z]/.test(line)) problems.push(`"${line}" still carries a camelCase code`);
    }

    // The two facts a picture would otherwise have to be squinted at for: the
    // newest line is the bottom one, and every line is clear of the right edge.
    for (let i = 1; i < boxes.length; i++) {
      const above = boxes[i - 1];
      const below = boxes[i];
      if (!above || !below) continue;
      if (below.top <= above.top) {
        problems.push('the stack is not stacking downward in DOM order');
      }
      if (Math.abs(below.right - above.right) > 1) {
        problems.push('the lines are not flush with each other on the right');
      }
    }
    const overflow = boxes.filter((box) => box.right > 1280);
    if (overflow.length > 0) problems.push(`${overflow.length} line(s) run off the right edge`);

    // Clear of the window buttons, which share this corner and are drawn over
    // the stack -- the first run of this script photographed a line of red
    // crossed out by the Bag and Gear buttons, because the gap was computed
    // against one button's height and they are a column of three.
    const windowTop = await page.$$eval('button', (nodes) => {
      const wanted = new Set(['Bag', 'Gear', 'Options']);
      const tops = nodes
        .filter((node) => wanted.has((node.textContent ?? '').trim()))
        .map((node) => node.getBoundingClientRect().top);
      return tops.length > 0 ? Math.min(...tops) : null;
    });
    const lowest = Math.max(...boxes.map((box) => box.bottom));
    console.log(`  stack bottom ${lowest}, window buttons start at ${String(windowTop)}`);
    if (windowTop === null) problems.push('the window buttons were not found to measure against');
    else if (lowest > windowTop) problems.push('the stack overlaps the window buttons');

    // And then it goes away on its own. The old line counted 120 frames; this
    // is a clock, so four seconds is four seconds.
    await page.waitForTimeout(4000);
    const after = await readStack(page);
    console.log(`  after four seconds: ${JSON.stringify(after)}`);
    if (after.length > 0) problems.push(`the stack did not decay: ${after.join(' / ')}`);
  } finally {
    await browser.close();
    server.kill();
  }

  if (problems.length > 0) {
    console.error('\nproblems:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('\nthe stack said its piece and cleared itself');
  }
}

await main();
