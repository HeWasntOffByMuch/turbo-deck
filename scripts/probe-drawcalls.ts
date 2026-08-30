/**
 * How much work the renderer asks for per frame, counted rather than timed.
 *
 * The container has no GPU, so timings here are meaningless -- but *counts* are
 * not. Draw calls, program switches, uniform uploads and shader compiles are
 * pure JS bookkeeping, identical on this machine and on a real one, and they are
 * what the Firefox profile's 82% JavaScript is made of.
 *
 *   npx tsx scripts/probe-drawcalls.ts
 *
 * A shader compiled after warm-up is a stall on any machine; a program switch
 * per draw means the scene is not sorted; thousands of draws per frame is a
 * scene that needs batching. Each is visible here.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4328;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/**
 * Counting hooks, installed before any page script runs.
 *
 * Patched onto the prototypes rather than onto an instance, because the page
 * makes its own context and there is nothing to reach for until it does.
 */
const INSTALL = `
(function () {
  var counts = {};
  var frames = [];
  function bump(name) { counts[name] = (counts[name] || 0) + 1; }

  function patch(proto) {
    if (!proto || proto.__patched) return;
    proto.__patched = true;
    var names = [
      'drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced',
      'useProgram', 'bindTexture', 'bindFramebuffer', 'bindVertexArray',
      'shaderSource', 'compileShader', 'linkProgram', 'getUniformLocation',
      'bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D',
      'readPixels', 'getError', 'getParameter', 'finish', 'flush',
      'uniformMatrix4fv', 'uniform1f', 'uniform3f', 'uniform4fv'
    ];
    names.forEach(function (n) {
      var orig = proto[n];
      if (typeof orig !== 'function') return;
      proto[n] = function () { bump(n); return orig.apply(this, arguments); };
    });
  }
  if (window.WebGL2RenderingContext) patch(WebGL2RenderingContext.prototype);
  if (window.WebGLRenderingContext) patch(WebGLRenderingContext.prototype);

  // Snapshot per animation frame.
  var last = performance.now();
  function tick() {
    var now = performance.now();
    frames.push({ dt: now - last, counts: counts });
    last = now;
    counts = {};
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.__glFrames = frames;
})();
`;

/**
 * The same hooks, but bucketing draws between framebuffer binds.
 *
 * A pass is "everything drawn into one target", so the bind is the boundary. It
 * is the only way to tell a scene that is too heavy from a scene that is merely
 * drawn five times.
 */
const INSTALL_PASSES = `
(function () {
  var passes = [];
  var current = { target: 'default', draws: 0, programs: 0, w: 0, h: 0 };
  var frames = [];

  function patch(proto) {
    if (!proto || proto.__patchedPass) return;
    proto.__patchedPass = true;
    ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced'].forEach(function (n) {
      var orig = proto[n];
      if (typeof orig !== 'function') return;
      proto[n] = function () { current.draws++; return orig.apply(this, arguments); };
    });
    var useProgram = proto.useProgram;
    proto.useProgram = function () { current.programs++; return useProgram.apply(this, arguments); };
    var viewport = proto.viewport;
    proto.viewport = function (x, y, w, h) {
      current.w = w; current.h = h;
      return viewport.apply(this, arguments);
    };
    var bindFramebuffer = proto.bindFramebuffer;
    proto.bindFramebuffer = function (target, fb) {
      if (current.draws > 0) passes.push(current);
      current = { target: fb ? 'fbo' : 'canvas', draws: 0, programs: 0, w: 0, h: 0 };
      return bindFramebuffer.apply(this, arguments);
    };
  }
  if (window.WebGL2RenderingContext) patch(WebGL2RenderingContext.prototype);
  if (window.WebGLRenderingContext) patch(WebGLRenderingContext.prototype);

  function tick() {
    if (current.draws > 0) { passes.push(current); current = { target: current.target, draws: 0, programs: 0, w: current.w, h: current.h }; }
    frames.push(passes);
    passes = [];
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  window.__glPasses = frames;
})();
`;

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

interface Frame {
  dt: number;
  counts: Record<string, number>;
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
    await page.addInitScript(INSTALL);
    await page.addInitScript(INSTALL_PASSES);

    // `PERF=` passes a `?perf=` list straight through, so the per-pass table can
    // be taken with a contributor removed and compared against the baseline
    // *within one instrument* -- which `probe-frame-cost.ts` cannot do, since
    // each of its variants is a separate page load and the wandering monsters
    // move the whole-frame count between them by a few tens.
    const perf = process.env['PERF'] ?? '';
    const query = `?seed=20260806${perf ? `&perf=${perf}` : ''}`;
    await page.goto(`http://localhost:${PORT}/${query}`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    // Long warm-up: chunks stream in, props seed, every shader gets compiled.
    await page.waitForTimeout(20_000);

    // Only frames from here on count as steady state.
    await page.evaluate('window.__glFrames.length = 0; window.__glPasses.length = 0');
    await page.waitForTimeout(15_000);

    const frames = (await page.evaluate('window.__glFrames')) as Frame[];
    const passes = (await page.evaluate('window.__glPasses')) as {
      target: string;
      draws: number;
      programs: number;
      w: number;
      h: number;
    }[][];
    report(frames);
    reportPasses(passes);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

function report(frames: Frame[]): void {
  if (frames.length === 0) {
    console.log('no frames captured');
    return;
  }
  console.log(`\n=== steady state, ${frames.length} frames ===`);

  const keys = new Set<string>();
  for (const f of frames) for (const k of Object.keys(f.counts)) keys.add(k);

  const rows = [...keys]
    .map((k) => {
      const vals = frames.map((f) => f.counts[k] ?? 0);
      const total = vals.reduce((s, v) => s + v, 0);
      return { k, mean: total / frames.length, max: Math.max(...vals), total };
    })
    .sort((a, b) => b.mean - a.mean);

  console.log(`\n  ${'gl call'.padEnd(24)} ${'per frame'.padStart(10)} ${'max'.padStart(8)}`);
  for (const r of rows) {
    console.log(`  ${r.k.padEnd(24)} ${r.mean.toFixed(1).padStart(10)} ${String(r.max).padStart(8)}`);
  }

  const draws = frames.map(
    (f) =>
      (f.counts['drawElements'] ?? 0) +
      (f.counts['drawArrays'] ?? 0) +
      (f.counts['drawElementsInstanced'] ?? 0) +
      (f.counts['drawArraysInstanced'] ?? 0),
  );
  const meanDraws = draws.reduce((s, v) => s + v, 0) / draws.length;
  const meanPrograms =
    frames.reduce((s, f) => s + (f.counts['useProgram'] ?? 0), 0) / frames.length;

  console.log(`\n  draw calls per frame : mean ${meanDraws.toFixed(0)}, max ${Math.max(...draws)}`);
  console.log(`  useProgram per frame : mean ${meanPrograms.toFixed(0)}`);
  console.log(
    `  program switches per draw: ${(meanPrograms / Math.max(1, meanDraws)).toFixed(2)}` +
      ` (near 1.0 means the scene is not sorted by material)`,
  );

  const compiles = frames.reduce((s, f) => s + (f.counts['compileShader'] ?? 0), 0);
  const links = frames.reduce((s, f) => s + (f.counts['linkProgram'] ?? 0), 0);
  console.log(`\n  shaders compiled AFTER warm-up: ${compiles}  (links: ${links})`);
  if (compiles > 0) {
    console.log('  ^ every one of these is a multi-ms main-thread stall on a real machine');
    const worst = frames
      .map((f, i) => ({ i, n: f.counts['compileShader'] ?? 0, dt: f.dt }))
      .filter((f) => f.n > 0)
      .slice(0, 10);
    for (const w of worst) console.log(`      frame ${w.i}: ${w.n} compiles, dt ${w.dt.toFixed(0)}ms`);
  }

  const gets = frames.reduce((s, f) => s + (f.counts['getParameter'] ?? 0), 0) / frames.length;
  const errs = frames.reduce((s, f) => s + (f.counts['getError'] ?? 0), 0) / frames.length;
  const reads = frames.reduce((s, f) => s + (f.counts['readPixels'] ?? 0), 0) / frames.length;
  console.log(`\n  synchronous stalls (these flush the GL pipeline):`);
  console.log(`    getParameter per frame : ${gets.toFixed(1)}`);
  console.log(`    getError     per frame : ${errs.toFixed(1)}`);
  console.log(`    readPixels   per frame : ${reads.toFixed(2)}`);
}

function reportPasses(
  frames: { target: string; draws: number; programs: number; w: number; h: number }[][],
): void {
  const withDraws = frames.filter((f) => f.length > 0);
  if (withDraws.length === 0) return;
  // A representative frame: the median by total draws.
  const ranked = [...withDraws].sort(
    (a, b) => a.reduce((s, p) => s + p.draws, 0) - b.reduce((s, p) => s + p.draws, 0),
  );
  const mid = ranked[Math.floor(ranked.length / 2)];
  if (!mid) return;
  console.log(`\n=== one representative frame, pass by pass ===`);
  console.log(
    `  ${'#'.padStart(3)} ${'target'.padEnd(8)} ${'draws'.padStart(8)} ${'programs'.padStart(9)} ${'size'.padStart(12)}`,
  );
  let total = 0;
  mid.forEach((p, i) => {
    total += p.draws;
    console.log(
      `  ${String(i + 1).padStart(3)} ${p.target.padEnd(8)} ${String(p.draws).padStart(8)} ${String(p.programs).padStart(9)} ${`${p.w}x${p.h}`.padStart(12)}`,
    );
  });
  console.log(`  ${''.padStart(3)} ${'TOTAL'.padEnd(8)} ${String(total).padStart(8)}`);
  console.log(`\n  geometry passes over ~the whole scene: ${mid.filter((p) => p.draws > 100).length}`);
}

void main();
