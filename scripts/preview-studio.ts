/**
 * Drive the Studio tab in a real browser (spec 109).
 *
 *   npm run build && npx tsx scripts/preview-studio.ts
 *
 * Two things here can only be checked in a browser, and both are the sort that
 * pass every unit test while being broken on screen.
 *
 * The first is the constraint the brief puts above everything else: **Play and
 * Map editor must keep working unchanged.** A fifth entry in the tab array is a
 * two-line diff that cannot fail a typecheck and cannot fail a headless test,
 * because every tab is a canvas or a DOM tree that only exists once something
 * mounts it. So this clicks all five and asserts each one actually put something
 * in the page.
 *
 * The second is that the Studio tab's own failure path is legible. It runs with
 * no authoring server behind it, which is the state a reader will first meet it
 * in, and the panel has to say "start `npm run server`" rather than sitting
 * blank or throwing into the console.
 *
 * Serves `dist/` rather than the dev server, so what is driven is what ships --
 * and deliberately without the dev proxy, so the offline path is the real one.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4325;
const VIEWPORT = { width: 1280, height: 900 };

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
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${url} never came up`);
}

/** Clicks a tab by its label and waits for the shell to mount it. */
async function openTab(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForTimeout(700);
}

/** How much is actually on screen under the tab bar. */
async function mountedSize(page: Page): Promise<{ nodes: number; canvases: number }> {
  return page.evaluate(() => {
    const app = document.getElementById('app');
    if (!app) return { nodes: 0, canvases: 0 };
    const visible = Array.from(app.children).filter((child) => {
      const style = getComputedStyle(child as HTMLElement);
      return style.display !== 'none';
    });
    let nodes = 0;
    for (const child of visible) nodes += child.querySelectorAll('*').length;
    return { nodes, canvases: app.querySelectorAll('canvas').length };
  });
}

/** A plausible reference image: a pale figure on a plain dark backdrop. */
function referencePng(size = 640): Buffer {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) << 2;
      const inside = Math.abs(x - size / 2) < size * 0.18 && Math.abs(y - size / 2) < size * 0.34;
      const [r, g, b] = inside ? [225, 205, 170] : [18, 18, 26];
      png.data[index] = r;
      png.data[index + 1] = g;
      png.data[index + 2] = b;
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function main(): Promise<void> {
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    throw new Error('no dist/ -- run `npm run build` first');
  }
  await mkdir(outDir, { recursive: true });

  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const failures: string[] = [];

  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });
    const page = await browser.newPage({ viewport: VIEWPORT });

    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`uncaught: ${error.message}`));

    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(1500);

    // --- the constraint: the other four tabs still mount ---------------------
    for (const label of ['Play', 'Movement sandbox', 'Rig debug', 'Map editor']) {
      await openTab(page, label);
      const size = await mountedSize(page);
      if (size.nodes === 0 && size.canvases === 0) {
        failures.push(`${label} mounted nothing`);
      }
      console.log(`  ${label}: ${size.nodes} nodes, ${size.canvases} canvas(es)`);
    }

    // --- the new tab ---------------------------------------------------------
    await openTab(page, 'Studio');
    // The preview loads a real .glb and compiles the retro pass, which takes
    // longer than a tab switch.
    await page.waitForTimeout(2000);
    const studio = await mountedSize(page);
    if (studio.nodes < 20) failures.push(`Studio mounted only ${studio.nodes} nodes`);
    console.log(`  Studio: ${studio.nodes} nodes, ${studio.canvases} canvas(es)`);

    // --- the preview actually loaded a model ---------------------------------
    //
    // The one thing that cannot be checked in Node: whether three's GLTFLoader
    // accepts the .glb this repo writes by hand. A wrong buffer offset or a
    // mismatched inverse bind matrix loads as an exploded cloud of triangles and
    // every headless assertion about the file still passes.
    const previewStatus = await page.locator('#app').innerText();
    const stats = /(\d+) triangles, (\d+) bones, (\d+) vertices/.exec(previewStatus);
    if (!stats) {
      failures.push(`the preview reported no model stats -- it did not load. Panel said: ${previewStatus.slice(0, 300)}`);
    } else {
      console.log(`  reference unit: ${stats[1]} triangles, ${stats[2]} bones, ${stats[3]} vertices`);
      if (Number(stats[2]) !== 25) failures.push(`expected 25 bones on the mixamo contract, got ${stats[2]}`);
      if (Number(stats[1]) < 50) failures.push(`only ${stats[1]} triangles -- the mesh did not come through`);
    }
    for (const [needle, why] of [
      ['state machine', 'the state graph is missing'],
      ['action timings', 'the timing panel is missing'],
      ['parameters', 'the parameter panel is missing'],
      ['trigger basic.attack', 'the action trigger button is missing'],
    ] as const) {
      if (!previewStatus.toLowerCase().includes(needle)) failures.push(why);
    }

    const text = (await page.locator('#app').innerText()).toLowerCase();
    for (const [needle, why] of [
      ['ingest', 'the ingest section is missing'],
      ['generate', 'the generate section is missing'],
      ['library', 'the library section is missing'],
      ['preview', 'the preview section is missing'],
      ['export', 'the export section is missing'],
      ['admin token', 'the token field has no label'],
    ] as const) {
      if (!text.includes(needle)) failures.push(why);
    }

    // The checklist the image checker deliberately does not pretend to measure.
    if (!text.includes('check these yourself')) {
      failures.push('the manual checklist is not shown');
    }

    // --- a bad token produces an actionable message, not silence -------------
    //
    // Which message depends on the environment, and deliberately so: with no
    // authoring server behind the preview it is "start `npm run server`", and
    // with one running it is "paste a token". Both are correct and both are the
    // point -- what is being checked is that a failure names its remedy rather
    // than leaving a blank panel or a stack trace in the console. Asserting one
    // exact string would make this pass or fail on whether a server happens to
    // be up, which is a property of the machine and not of the code.
    await page.locator('input[type=password]').fill('not-a-real-token');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.waitForTimeout(1500);
    const afterConnect = (await page.locator('#app').innerText()).toLowerCase();
    const remedies = ['npm run server', 'paste the admin token'];
    if (!remedies.some((remedy) => afterConnect.includes(remedy))) {
      failures.push('a rejected token produces no message saying what to do about it');
    }

    // --- a poll must not repaint what somebody is reading or typing ----------
    //
    // The queue is re-read every couple of seconds, and rebuilding the DOM on
    // each poll wiped any selection in progress -- which meant the one thing
    // this panel is for, copying an error out of it, was the thing it broke.
    // Two seconds is longer than the poll interval, so if a repaint were still
    // happening it would happen inside this window.
    await page.evaluate(() => {
      const target = document.querySelector('#app section p');
      if (!target) return;
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    const selectedBefore = await page.evaluate(() => getSelection()?.toString() ?? '');
    if (selectedBefore.length < 10) failures.push('could not select text in the studio panel at all');
    await page.waitForTimeout(2600);
    const selectedAfter = await page.evaluate(() => getSelection()?.toString() ?? '');
    if (selectedAfter !== selectedBefore) {
      failures.push(`a poll destroyed the text selection: "${selectedBefore.slice(0, 40)}" became "${selectedAfter.slice(0, 40)}"`);
    }

    // The same for a field being typed into: a rebuilt input loses focus and
    // the caret, which on a form somebody is filling in is maddening. Needs a
    // real image, since the form only exists once one has been dropped -- and
    // dropping one also exercises decode, measure and check in a real browser.
    await page.locator('#app input[type=file][accept="image/*"]').setInputFiles({
      name: 'reference.png',
      mimeType: 'image/png',
      buffer: referencePng(),
    });
    await page.waitForTimeout(1200);
    const ingested = await page.locator('#app').innerText();
    if (!ingested.includes('640x640')) failures.push('the dropped image was not measured');
    if (!ingested.includes('no transparency')) failures.push('the image checker said nothing about a clean opaque image');

    const unitField = page.locator('#app input[placeholder="unit id"]').first();
    if ((await unitField.count()) === 0) {
      failures.push('no unit id field after dropping an image');
    } else {
      await unitField.fill('grunt');
      await page.waitForTimeout(2600);
      const stillFocused = await page.evaluate(
        () => (document.activeElement as HTMLInputElement | null)?.placeholder === 'unit id',
      );
      if (!stillFocused) failures.push('a poll stole focus from the unit id field');
      if ((await unitField.inputValue()) !== 'grunt') failures.push('a poll cleared what was typed into the unit id field');
    }

    await page.screenshot({ path: join(outDir, 'studio.png'), fullPage: true });
    console.log(`  wrote ${join('.claude', 'screenshots', 'studio.png')}`);

    // A failed fetch to a server that is not running logs a network error the
    // page cannot suppress; that one is expected here and is not a defect.
    const unexpected = consoleErrors.filter(
      (message) => !/failed to load resource|net::ERR_|fetch/i.test(message),
    );
    for (const message of unexpected) failures.push(`console error: ${message}`);

    await browser.close();
  } finally {
    server.kill();
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('all five tabs mount, and the studio panel reads correctly with no server behind it');
}

await main();
