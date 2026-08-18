/**
 * Where the frame's draw calls go (spec 165 follow-up 9):
 * `npx tsx scripts/probe-frame-cost.ts`
 *
 * The frame is CPU-bound rather than fill-bound -- halving the shaded pixels
 * bought nothing -- so what matters is which objects the ~625 draw calls belong
 * to. This loads the real built page against a real server once per variant,
 * waits for the world, stands still, and reads the counters the frame meter
 * already publishes.
 *
 * A/B rather than a profiler, for the reason the `ink` measurement was A/B: the
 * number that decides anything is "how much does the frame lose without this",
 * and taking the thing out answers it directly, on any machine, with no symbols.
 *
 * It reports draws and triangles, which transfer to any GPU, and fps, which does
 * not -- this container rasterises in software. Read the first two.
 */

import { chromium, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const PORT = Number(process.env['PORT'] ?? 8813);
const PAGE_PORT = Number(process.env['PAGE_PORT'] ?? 4323);
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** Each variant takes one contributor out. The diff against `baseline` is the answer. */
const VARIANTS: readonly { readonly label: string; readonly perf: string }[] = [
  { label: 'baseline', perf: '' },
  { label: 'no shadow map', perf: 'noshadow' },
  { label: 'no props', perf: 'noprops' },
  { label: 'no terrain', perf: 'noterrain' },
  { label: 'no shadow + no props', perf: 'noshadow,noprops' },
];

interface Reading {
  label: string;
  calls: number;
  tris: number;
  fps: number;
}

function run(script: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn('node_modules/.bin/tsx', [script], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', () => undefined);
  return child;
}

function stop(child: ChildProcess | null): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function refuseIfTaken(port: number): Promise<void> {
  const alive = await fetch(`http://127.0.0.1:${port}/`).then(
    () => true,
    () => false,
  );
  if (alive) throw new Error(`port ${port} already answers -- a previous run leaked a server`);
}

/** Median of the samples, so one hitch does not decide the row. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function readVariant(page: Page, url: string, label: string): Promise<Reading> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-world-ready]', { timeout: 180_000 });
  // Standing still, and after the loader has stopped: the frame being measured
  // is the one the player spends their time in.
  await sleep(6000);

  const calls: number[] = [];
  const tris: number[] = [];
  const fps: number[] = [];
  for (let i = 0; i < 10; i++) {
    await sleep(700);
    const now = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-fps-draw-calls]');
      return {
        calls: Number(el?.dataset['fpsDrawCalls'] ?? 0),
        tris: Number(el?.dataset['fpsTriangles'] ?? 0),
        fps: Number(el?.dataset['fpsValue'] ?? 0),
      };
    });
    calls.push(now.calls);
    tris.push(now.tris);
    fps.push(now.fps);
  }
  return { label, calls: median(calls), tris: median(tris), fps: median(fps) };
}

async function main(): Promise<void> {
  await refuseIfTaken(PORT);
  await refuseIfTaken(PAGE_PORT);
  const server = run('src/server/index.ts', { PORT: String(PORT), TICK_RATE: '60' });

  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.glb': 'model/gltf-binary',
  };
  const pages = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const file = join('dist', path === '/' ? 'index.html' : path.slice(1));
    readFile(file).then(
      (body) => {
        res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      },
      () => {
        res.writeHead(404);
        res.end();
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
    for (const variant of VARIANTS) {
      const query = `?server=ws://127.0.0.1:${PORT}${variant.perf ? `&perf=${variant.perf}` : ''}`;
      console.log(`  measuring ${variant.label}...`);
      readings.push(await readVariant(page, `http://127.0.0.1:${PAGE_PORT}/${query}`, variant.label));
    }
  } finally {
    await browser.close();
    pages.closeAllConnections();
    pages.close();
    stop(server);
  }

  const base = readings[0];
  console.log('\nvariant                    draws        tris     fps   draws saved');
  for (const row of readings) {
    const saved = base && row !== base ? base.calls - row.calls : 0;
    console.log(
      `${row.label.padEnd(24)} ${String(row.calls).padStart(6)} ${`${(row.tris / 1000).toFixed(0)}k`.padStart(11)} ${row.fps.toFixed(0).padStart(7)}` +
        `${row === base ? '' : `   ${String(saved).padStart(6)} (${((saved / Math.max(1, base?.calls ?? 1)) * 100).toFixed(0)}%)`}`,
    );
  }
  console.log('\ndraws and triangles transfer to any GPU; the fps column is software rasterised and does not.');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
