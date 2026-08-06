/**
 * Frame times through a cold start (spec 070 follow-up).
 *
 * Chunk streaming is the first thing this game does that competes with the
 * render loop for the main thread, and "it looks fine in a screenshot" cannot
 * see a 400ms frame. This drives the real page in a real browser and reports
 * the distribution, so a claim about startup smoothness is a measurement rather
 * than a hope.
 *
 *   npm run build && npx tsx scripts/measure-startup.ts
 *
 * Note the numbers are from a software rasteriser (there is no GPU here), so
 * treat them as a *relative* measure: the same scene before and after a change,
 * on the same machine. The absolute milliseconds are pessimistic.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4321;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** How long to watch, in ms. Long enough to cover the whole chunk stream. */
const WATCH_MS = 12_000;

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

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

async function main(): Promise<void> {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    args: CHROMIUM_ARGS,
  });

  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    // Long tasks, not requestAnimationFrame deltas. Headless Chromium has no
    // compositor driving rAF, so frame callbacks barely fire and would report a
    // smooth page no matter what. A long task *is* the thing being complained
    // about: uninterruptible main-thread work, during which nothing draws and
    // no input is handled.
    //
    // Installed before the page's own script runs, so the expensive first
    // seconds are in the sample rather than missed.
    await page.addInitScript(() => {
      const tasks: number[] = [];
      (globalThis as unknown as { __tasks: number[] }).__tasks = tasks;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push(entry.duration);
      }).observe({ entryTypes: ['longtask'] });
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WATCH_MS);

    const frames = await page.evaluate(
      () => (globalThis as unknown as { __tasks: number[] }).__tasks,
    );
    const chunks = await page.evaluate(() => {
      const probe = globalThis as unknown as { __mapChunks?: () => number };
      return probe.__mapChunks?.() ?? -1;
    });

    const sorted = [...frames].sort((a, b) => a - b);
    const over100 = frames.filter((f) => f > 100).length;
    const over250 = frames.filter((f) => f > 250).length;

    process.stdout.write(
      [
        `long tasks:  ${frames.length} over ${WATCH_MS / 1000}s`,
        `chunks held: ${chunks}`,
        `blocked:     ${frames.reduce((a, b) => a + b, 0).toFixed(0)} ms total`,
        `median:      ${percentile(sorted, 50).toFixed(1)} ms`,
        `p95:         ${percentile(sorted, 95).toFixed(1)} ms`,
        `worst:       ${(sorted[sorted.length - 1] ?? 0).toFixed(1)} ms`,
        `> 100 ms:    ${over100} tasks`,
        `> 250 ms:    ${over250} tasks`,
        '',
      ].join('\n'),
    );
  } finally {
    await browser.close();
    server.kill();
  }
}

await main();
