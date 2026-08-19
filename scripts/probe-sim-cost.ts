/**
 * How much of a frame goes on the simulation: `npx tsx scripts/probe-sim-cost.ts`
 *
 * The frame meter grew a `sim` line in spec 189 and this is the half no headless
 * test can see: the real Play tab, the real frame loop, the numbers read back
 * off the DOM rather than off the constants that produced them.
 *
 * Both transports, side by side, because they are the whole argument. Single
 * player is a `GameServer` on this thread, so every body in the world is frame
 * time; a socket leaves only the predictor here, which walks the same colliders
 * per predicted tick and replays its input buffer on a correction. A reading
 * that covered one of them would answer "should the sim move off the thread"
 * with half the evidence.
 *
 * What transfers is the **share**, not the milliseconds. This container paints
 * at a few frames a second under software GL, so the accumulator is pinned at
 * `MAX_CATCH_UP_TICKS` and a frame drains ten ticks where a real one drains two
 * -- which inflates `sim ms/frame` and `t/f` together and leaves the ratio
 * between them honest.
 */

import { chromium, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const PORT = Number(process.env['PORT'] ?? 8819);
const PAGE_PORT = Number(process.env['PAGE_PORT'] ?? 4329);
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Reading {
  readonly label: string;
  readonly frameMs: number;
  readonly simMs: number;
  readonly simWorstMs: number;
  readonly ticksPerFrame: number;
}

function stop(child: ChildProcess | null): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

async function refuseIfTaken(port: number): Promise<void> {
  const alive = await fetch(`http://127.0.0.1:${port}/`).then(
    () => true,
    () => false,
  );
  if (alive) throw new Error(`port ${port} already answers -- a previous run leaked a server`);
}

/** Median, so one hitch does not decide the row. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function read(page: Page, url: string, label: string): Promise<Reading> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-world-ready]', { timeout: 300_000 });
  // Standing still, after the loader has stopped: the frame being measured is
  // the one a player spends their time in, not the one the world arrived on.
  await sleep(8000);

  const frame: number[] = [];
  const sim: number[] = [];
  const worst: number[] = [];
  const ticks: number[] = [];
  for (let i = 0; i < 8; i++) {
    await sleep(900);
    const now = await page.evaluate(
      `(() => {
        const el = document.querySelector('[data-fps-value]');
        const d = el ? el.dataset : {};
        return {
          frame: Number(d.fpsValue ? 1000 / Number(d.fpsValue) : 0),
          sim: Number(d.fpsSim ?? 0),
          worst: Number(d.fpsSimWorst ?? 0),
          ticks: Number(d.fpsTicksPerFrame ?? 0),
        };
      })()`,
    );
    const sample = now as { frame: number; sim: number; worst: number; ticks: number };
    frame.push(sample.frame);
    sim.push(sample.sim);
    worst.push(sample.worst);
    ticks.push(sample.ticks);
  }
  return {
    label,
    frameMs: median(frame),
    simMs: median(sim),
    simWorstMs: median(worst),
    ticksPerFrame: median(ticks),
  };
}

async function main(): Promise<void> {
  await refuseIfTaken(PORT);
  await refuseIfTaken(PAGE_PORT);
  const server = spawn('node_modules/.bin/tsx', ['src/server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), TICK_RATE: '60' },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });

  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.glb': 'model/gltf-binary',
  };
  const pages = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const file = join('dist', path === '/' ? 'index.html' : path.slice(1));
    readFile(file).then(
      (body) => {
        response.writeHead(200, {
          'content-type': types[extname(file)] ?? 'application/octet-stream',
        });
        response.end(body);
      },
      () => {
        response.writeHead(404);
        response.end();
      },
    );
  });
  await new Promise<void>((resolve) => pages.listen(PAGE_PORT, resolve));

  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const readings: Reading[] = [];

  try {
    await sleep(9000);
    readings.push(
      await read(page, `http://127.0.0.1:${PAGE_PORT}/`, 'loopback (server in the tab)'),
    );
    readings.push(
      await read(
        page,
        `http://127.0.0.1:${PAGE_PORT}/?server=ws://127.0.0.1:${PORT}`,
        'socket (predictor only)',
      ),
    );
  } finally {
    await browser.close();
    pages.closeAllConnections();
    pages.close();
    stop(server);
  }

  console.log('\ntransport                        frame     sim   worst    t/f   sim share');
  for (const row of readings) {
    const share = row.frameMs > 0 ? (row.simMs / row.frameMs) * 100 : 0;
    console.log(
      `${row.label.padEnd(30)} ${row.frameMs.toFixed(1).padStart(6)}` +
        ` ${row.simMs.toFixed(2).padStart(7)} ${row.simWorstMs.toFixed(1).padStart(7)}` +
        ` ${row.ticksPerFrame.toFixed(1).padStart(6)} ${`${share.toFixed(1)}%`.padStart(11)}`,
    );
  }
  console.log(
    '\nmilliseconds are this container\'s (software GL, accumulator pinned at MAX_CATCH_UP_TICKS);',
  );
  console.log('the share and the gap between the two rows are what transfer.');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
