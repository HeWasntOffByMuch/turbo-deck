/**
 * Screenshot the world view (spec 063), so the three.js half of it is checked by
 * something other than hope.
 *
 * Everything under `src/render/iso3d/world/` that can be tested headlessly is --
 * interpolation, intent, cast bars, appearance. The scene itself needs a GPU and
 * a DOM, so it gets the same treatment the editor's does: drive the real page in
 * a real browser and commit the frames to `.claude/screenshots/`.
 *
 *   npx tsx scripts/preview-world.ts
 *
 * Requires a build first (`npm run build`); it serves `dist/` rather than
 * running the dev server, so what is photographed is what ships.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4319;

/**
 * A Chromium to drive. Prefers a browser already on the box (an agent container
 * ships one at `PLAYWRIGHT_BROWSERS_PATH` that may not match the version this
 * Playwright would download), and otherwise lets Playwright find its own.
 */
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';

/** Software WebGL: there is no GPU in CI or in an agent's container. */
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

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  console.log(`  wrote ${name}.png`);
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const server = spawn(
    'npx',
    ['vite', 'preview', '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: 'ignore' },
  );

  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    // Long enough for the welcome to land, the world to build and the ambient
    // spawner to put something in frame.
    await page.waitForTimeout(4000);
    await shoot(page, 'world-play');

    // Walk first, while the field is still quiet: the camera trails, the gait
    // runs, and the wind-up shots below want an emptier frame anyway.
    await page.keyboard.down('KeyD');
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(1400);
    await page.keyboard.up('KeyD');
    await page.keyboard.up('KeyS');
    await page.waitForTimeout(150);
    await shoot(page, 'world-walking');

    // Point at open ground away from the figure and commit to a heavy blow, then
    // catch the frame mid-wind-up: the bar, and the moment it means something.
    await page.mouse.move(820, 330);
    await page.waitForTimeout(200);
    await page.keyboard.press('Digit2');
    await page.waitForTimeout(220);
    await shoot(page, 'world-windup');

    // A ground-targeted blast, for the telegraph ring on the terrain.
    await page.keyboard.press('Digit5');
    await page.waitForTimeout(320);
    await shoot(page, 'world-telegraph');

    const status = await page.textContent('body');
    console.log('\nHUD read back:', status?.slice(0, 200).replace(/\s+/g, ' '));

    if (problems.length > 0) {
      console.error('\npage reported errors:');
      for (const problem of problems) console.error(`  ${problem}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

await main();
