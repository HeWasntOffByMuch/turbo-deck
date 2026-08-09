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
    const studio = await mountedSize(page);
    if (studio.nodes < 20) failures.push(`Studio mounted only ${studio.nodes} nodes`);
    console.log(`  Studio: ${studio.nodes} nodes`);

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

    // --- the offline path is legible ----------------------------------------
    // No authoring server is running behind this preview, so pasting a token has
    // to produce "start the server" rather than silence or a stack trace.
    await page.locator('input[type=password]').fill('not-a-real-token');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.waitForTimeout(1200);
    const afterConnect = (await page.locator('#app').innerText()).toLowerCase();
    if (!afterConnect.includes('npm run server')) {
      failures.push('with no server running, the panel does not say to start one');
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
