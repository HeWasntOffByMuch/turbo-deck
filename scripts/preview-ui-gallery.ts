// Dev-only: drive the widget gallery in a real browser (spec 123).
// `npx tsx scripts/preview-ui-gallery.ts`
//
// Two things only a browser can answer, and both of them matter.
//
// First: whether `canvas2d` and the software rasterizer actually agree. Every
// golden image in the suite is the software backend's output, so if the browser
// draws something else, the goldens are checking a picture nobody sees. The page
// renders the same tree through both and compares them pixel by pixel; this
// script reports the verdict. It is the assertion that would have caught spec
// 101's failure, where every offscreen measurement was right and the screen was
// black.
//
// Second: the frame budget. `src/ui/` may not read a clock -- lint forbids it,
// and a timing assertion on shared CI hardware is a flaky test waiting to happen
// -- so the milliseconds are measured here, in the place they are real.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4337;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/** The brief's budget: full UI update + draw under this, with everything open. */
const BUDGET_MS = 1.5;

interface Probe {
  frameMs: number;
  drawCalls: number;
  viewport: { width: number; height: number };
  scale: number;
  matchesRaster: boolean;
  firstMismatch: string | null;
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('server never came up');
}

const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});

let failed = false;
try {
  await waitForServer(`http://localhost:${PORT}/`);
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    // A missing favicon is not a rendering failure and never has been.
    if (message.type() === 'error' && !message.text().includes('favicon')) errors.push(message.text());
  });

  const outDir = join(root, '.claude', 'screenshots');
  mkdirSync(outDir, { recursive: true });

  // Both scenes: the widget gallery (spec 123) and the six-window one (spec 124).
  // The budget the brief states is "six windows open", so the second is the one
  // the number actually belongs to.
  for (const scene of ['widgets', 'windows', 'keys', 'bag', 'play'] as const) {
    const query = scene === 'widgets' ? '' : `?scene=${scene}`;
    await page.goto(`http://localhost:${PORT}/ui-gallery.html${query}`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    await page.waitForTimeout(2200);
    await page.screenshot({ path: join(outDir, `ui-${scene}.png`) });

    // Hover something, so a hovered state is in the photograph too.
    await page.mouse.move(200, 120);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, `ui-${scene}-hover.png`) });

    const probe = (await page.evaluate(() => (globalThis as { __uiProbe?: Probe }).__uiProbe ?? null)) as Probe | null;

    console.log(`--- ${scene} ---`);
    if (!probe) {
      console.log('FAIL  the page never published a probe -- it probably threw before its first frame');
      failed = true;
      continue;
    }
    console.log(`viewport    ${probe.viewport.width}x${probe.viewport.height} UI px at scale ${probe.scale}`);
    console.log(`draw calls  ${probe.drawCalls}`);
    console.log(`frame       ${probe.frameMs.toFixed(3)} ms (median of 120), budget ${BUDGET_MS} ms`);
    console.log(`backends    ${probe.matchesRaster ? 'canvas2d matches the software rasterizer' : `MISMATCH at ${probe.firstMismatch}`}`);

    if (!probe.matchesRaster) {
      console.log('FAIL  the browser draws something the goldens do not describe');
      failed = true;
    }
    if (probe.frameMs > BUDGET_MS) {
      // Reported, not fatal: this runs under swiftshader on whatever the CI box
      // is, and a soft number is worth having without being worth failing on.
      console.log(`NOTE  over the ${BUDGET_MS} ms budget here; if a real machine agrees, build the WebGL backend`);
    }
  }

  if (errors.length > 0) {
    console.log('\npage errors:');
    for (const error of errors.slice(0, 5)) console.log(`  ${error}`);
    failed = true;
  }

  console.log(`\nwrote .claude/screenshots/ui-{widgets,windows,keys,bag,play}.png`);
  await browser.close();
} finally {
  server.kill();
}

process.exit(failed ? 1 : 0);
