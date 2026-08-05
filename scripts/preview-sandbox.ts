/**
 * Screenshot the two tuning sandboxes (spec 066), for the same reason
 * `preview-world.ts` exists: their pure half is tested headlessly and their
 * three.js half is not testable at all without a GPU and a DOM.
 *
 *   npx tsx scripts/preview-sandbox.ts
 *
 * Drives the real page: switch to the tab, right-click the ground to send the
 * unit walking, cycle the archetype, hop, and photograph each into
 * `.claude/screenshots/`. Requires a build first (`npm run build`); it serves
 * `dist/` rather than the dev server, so what is photographed is what ships.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4321;

/** Prefer a browser already on the box; otherwise let Playwright find its own. */
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

/**
 * The status line each sandbox keeps above its canvas -- unit, archetype, gait.
 * Read off its own element rather than out of the body text: the tuning panel
 * next to it is a thousand characters of slider labels with no line breaks.
 */
async function statusLine(page: Page): Promise<string> {
  const line = page.locator('div').filter({ hasText: /^(Unit: |Rig debug · )/ }).last();
  return ((await line.textContent()) ?? '(no status line)').trim();
}

/**
 * Send the unit walking. The sandbox canvases sit in the ordinary page flow, so
 * the click point is measured off the canvas itself rather than guessed at in
 * viewport coordinates -- and off the *visible* one, since the tabs that are
 * hidden keep their canvases mounted.
 */
async function walk(page: Page, dx: number, dy: number): Promise<void> {
  const box = await page.locator('canvas:visible').first().boundingBox();
  if (!box) throw new Error('no visible canvas to click');
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { button: 'right' });
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
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');

    // --- Movement sandbox ---------------------------------------------------
    await page.getByRole('button', { name: 'Movement sandbox' }).click();
    // Terrain, vegetation and the prop field are built before the first frame,
    // and under software WebGL that is seconds rather than milliseconds.
    await page.waitForTimeout(4000);
    await shoot(page, 'sandbox-movement');
    console.log(`  ${await statusLine(page)}`);

    await walk(page, -160, 60);
    await page.waitForTimeout(700);
    await shoot(page, 'sandbox-walking');
    console.log(`  ${await statusLine(page)}`);

    // C cycles the movement archetype (and loads its preset into the sliders).
    await page.keyboard.press('KeyC');
    await page.waitForTimeout(200);
    console.log(`  after C: ${await statusLine(page)}`);

    // The hooded robe, and J to hop it: the cloth is the reason this tab exists.
    await page.getByRole('button', { name: 'Hooded robe' }).click();
    await page.waitForTimeout(1200);
    await walk(page, 150, -40);
    await page.waitForTimeout(500);
    await page.keyboard.press('KeyJ');
    await page.waitForTimeout(250);
    await shoot(page, 'sandbox-robe-jump');
    console.log(`  ${await statusLine(page)}`);

    // --- Rig debug ----------------------------------------------------------
    await page.getByRole('button', { name: 'Rig debug' }).click();
    await page.waitForTimeout(2500);
    await shoot(page, 'sandbox-rig-debug');
    console.log(`  ${await statusLine(page)}`);

    // Right-click in the top-down (left) viewport to walk, so the leg overlays
    // are photographed mid-gait rather than standing.
    await walk(page, -150, 90);
    await page.waitForTimeout(600);
    await shoot(page, 'sandbox-rig-walking');

    // Slow-mo is what the viewport is for: the same gait, one tenth the speed.
    await page.getByRole('button', { name: '0.1×' }).click();
    await page.waitForTimeout(600);
    await shoot(page, 'sandbox-rig-slowmo');
    console.log(`  ${await statusLine(page)}`);

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
