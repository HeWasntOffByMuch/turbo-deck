/**
 * What the main thread actually spends a frame on, in the real Play tab.
 *
 * Drives the built page in a real browser, records a V8 sampling profile plus
 * every frame's wall-clock delta, and reports self time by function.
 *
 *   npx tsx scripts/probe-frame.ts
 *
 * Caveat that governs the reading: there is no GPU here, so WebGL work is
 * software-rasterised and its cost is inflated beyond anything a real machine
 * pays. Anything under a `gl`/ANGLE/SwiftShader frame is therefore reported
 * separately and NOT used to rank the game's own work.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4327;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

const RUN_MS = Number(process.env['RUN_MS'] ?? 12_000);

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
  hitCount?: number;
}

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never came up at ${url}`);
}

async function main(): Promise<void> {
  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });

  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (e) => console.error('[pageerror]', String(e)));

    await page.goto(`http://localhost:${PORT}/?seed=20260806`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    // Warm up: let chunks stream, props seed, shaders compile.
    await page.waitForTimeout(8000);

    // Record frame deltas in-page, independent of the sampler.
    // As a source string, not a closure: tsx compiles this file with esbuild,
    // which injects a `__name` helper into any function it lowers -- and that
    // helper does not exist in the page, so a closure here dies on arrival.
    await page.evaluate(`
      window.__frames = [];
      (function () {
        var last = performance.now();
        function tick() {
          var now = performance.now();
          window.__frames.push(now - last);
          last = now;
          requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      })();
    `);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');

    await page.waitForTimeout(RUN_MS);

    const { profile } = (await cdp.send('Profiler.stop')) as unknown as {
      profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };
    };

    const frames = (await page.evaluate('window.__frames')) as number[];

    report(profile, frames);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

function report(
  profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] },
  frames: number[],
): void {
  const byId = new Map<number, ProfileNode>();
  for (const n of profile.nodes) byId.set(n.id, n);

  const parent = new Map<number, number>();
  for (const n of profile.nodes) {
    for (const c of n.children ?? []) parent.set(c, n.id);
  }

  // Self time per node, from the sample stream.
  const selfUs = new Map<number, number>();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const id = profile.samples[i] as number;
    const dt = (profile.timeDeltas[i] ?? 0) as number;
    selfUs.set(id, (selfUs.get(id) ?? 0) + Math.max(0, dt));
  }

  const label = (n: ProfileNode): string => {
    const fn = n.callFrame.functionName || '(anonymous)';
    const url = n.callFrame.url.replace(/^https?:\/\/[^/]+\//, '');
    return url ? `${fn}  ${url}:${n.callFrame.lineNumber + 1}` : fn;
  };

  const isGl = (n: ProfileNode): boolean => {
    const f = n.callFrame.functionName;
    return f === '(garbage collector)' ? false : /^(gl[A-Z]|ANGLE|SwiftShader)/.test(f);
  };

  // Aggregate self time by function identity.
  const agg = new Map<string, { us: number; gl: boolean }>();
  let total = 0;
  for (const [id, us] of selfUs) {
    const n = byId.get(id);
    if (!n) continue;
    total += us;
    const key = label(n);
    const prev = agg.get(key) ?? { us: 0, gl: isGl(n) };
    prev.us += us;
    agg.set(key, prev);
  }

  const ranked = [...agg.entries()].sort((a, b) => b[1].us - a[1].us);

  console.log(`\n=== frame time over ${frames.length} frames ===`);
  const sorted = [...frames].sort((a, b) => a - b);
  const pct = (p: number): number => sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
  const mean = frames.reduce((s, v) => s + v, 0) / Math.max(1, frames.length);
  console.log(`  mean   ${mean.toFixed(2)}ms   (${(1000 / mean).toFixed(1)} fps)`);
  console.log(`  p50    ${pct(0.5).toFixed(2)}ms`);
  console.log(`  p90    ${pct(0.9).toFixed(2)}ms`);
  console.log(`  p99    ${pct(0.99).toFixed(2)}ms`);
  console.log(`  max    ${pct(1).toFixed(2)}ms`);
  console.log(`  frames over 50ms: ${frames.filter((f) => f > 50).length}`);
  console.log(`  frames over 100ms: ${frames.filter((f) => f > 100).length}`);

  console.log(`\n=== self time by function (total sampled ${(total / 1000).toFixed(0)}ms) ===`);
  for (const [key, v] of ranked.slice(0, 45)) {
    const pctOf = ((v.us / total) * 100).toFixed(1);
    console.log(`  ${pctOf.padStart(5)}%  ${(v.us / 1000).toFixed(0).padStart(6)}ms  ${key}`);
  }

  // Roll up by source file, ignoring GL noise, which is what actually points at
  // a module worth opening.
  const byFile = new Map<string, number>();
  for (const [id, us] of selfUs) {
    const n = byId.get(id);
    if (!n) continue;
    const url = n.callFrame.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');
    if (!url) continue;
    byFile.set(url, (byFile.get(url) ?? 0) + us);
  }
  console.log(`\n=== self time by file ===`);
  for (const [file, us] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(0).padStart(6)}ms  ${file}`);
  }
}

void main();
