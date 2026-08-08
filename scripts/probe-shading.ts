// Dev-only: prove the smooth-normal and sway-normal shader paths actually
// compile and link on a real GL context (spec 087, step 2).
// Not part of the app. `npx tsx scripts/probe-shading.ts`
//
// Drives `src/render/shading-probe.html` (dev-server only, never in a build),
// which builds the real prop field for all four combinations of step 2's two
// switches and draws each one. This script reads back what it reported and, more
// importantly, everything the page logged: three.js **logs** a failed shader
// compile and carries on rather than throwing, which is exactly the kind of
// failure that ships quietly.
//
// See `src/render/iso3d/shading-probe.ts` for why no unit test can do this, and
// why `preview-trees.ts` -- which rasterises in software and never makes a GL
// context -- cannot either.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

interface ShadingProbeCase {
  readonly label: string;
  readonly programs: number;
  readonly batches: number;
  readonly flatShaded: boolean;
  readonly bounds: readonly number[];
  readonly instances: number;
  readonly litPixels: number;
  readonly triangles: number;
  readonly radius: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4321;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
/** Software WebGL: there is no GPU in CI or in an agent's container. */
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

async function waitForServer(url: string, timeoutMs = 40_000): Promise<void> {
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

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});

let failed = false;
try {
  await waitForServer(`http://localhost:${PORT}/shading-probe.html`);
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });
  const page = await browser.newPage();

  const noise: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') noise.push(message.text());
  });
  page.on('pageerror', (error) => noise.push(`pageerror: ${error.message}`));

  await page.goto(`http://localhost:${PORT}/shading-probe.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.shadingProbe !== undefined, undefined, { timeout: 120_000 });
  const cases = (await page.evaluate(() => window.shadingProbe)) as readonly ShadingProbeCase[];

  // Anything mentioning a shader, a program, a compile or a link is a hard
  // failure; the rest is printed but tolerated.
  const shaderErrors = noise.filter((line) => /shader|glsl|program|compile|link/i.test(line));

  for (const probe of cases) {
    const ok = probe.programs > 0 && probe.batches > 0 && probe.flatShaded && probe.litPixels > 500;
    if (!ok) failed = true;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'}  ${probe.label}\n` +
        `        ${probe.batches} batches, ${probe.instances} instances, ${probe.programs} programs, ` +
        `${probe.triangles} tris, ${probe.litPixels} lit px` +
        `${probe.flatShaded ? '' : ' -- WRONG flatShading on a material'}` +
        `${probe.litPixels === 0 ? `, bounds [${probe.bounds.map((v) => Math.round(v)).join(', ')}] r=${Math.round(probe.radius)}` : ''}`,
    );
  }

  if (shaderErrors.length > 0) {
    failed = true;
    console.log('\nshader trouble the page reported:');
    for (const line of shaderErrors) console.log(`  ${line.split('\n').slice(0, 3).join(' | ')}`);
  }
  const other = noise.filter((line) => !shaderErrors.includes(line));
  if (other.length > 0) {
    console.log('\nother console output:');
    for (const line of other) console.log(`  ${line.split('\n')[0]}`);
  }

  // The contact sheet the page built out of the same buffers it counted, rather
  // than a screenshot of the page: "it linked" and "it looks right" are two
  // different claims, and a screenshot of four live WebGL canvases turned out to
  // hand back an earlier frame -- a picture that disagreed with its own numbers.
  const sheet = await page.evaluate(() => window.shadingProbeSheet ?? '');
  const outDir = join(root, '.claude', 'screenshots');
  mkdirSync(outDir, { recursive: true });
  const shot = join(outDir, 'shading-probe.png');
  const base64 = sheet.replace(/^data:image\/png;base64,/, '');
  if (base64.length === 0) {
    failed = true;
    console.log('\nthe page produced no contact sheet');
  } else {
    writeFileSync(shot, Buffer.from(base64, 'base64'));
    console.log(`\nwrote ${shot}`);
  }

  await browser.close();
} finally {
  vite.kill();
}

if (failed) {
  console.error('\na shader path failed');
  process.exit(1);
}
console.log('\nall four switch combinations compile, link and draw');
