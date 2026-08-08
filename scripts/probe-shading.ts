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

interface BufferProbeCase {
  readonly label: string;
  readonly view: 'depth' | 'normals';
  readonly distinct: number;
  readonly backgroundFraction: number;
  readonly covered: number;
  readonly nearest: number;
  readonly furthest: number;
  readonly facingCamera: number;
  readonly decalLeaked: boolean;
}

interface EdgeProbeCase {
  readonly edgeFraction: number;
  readonly edgeFractionSky: number;
  readonly floorEdgeFraction: number;
  readonly frameMean: number;
  readonly compositeMean: number;
  readonly compositeLines: number;
}

interface PaletteProbeCase {
  readonly distinct: number;
  readonly paletteSize: number;
  readonly onPalette: number;
  readonly distinctStepped: number;
  readonly changedFrame: boolean;
}

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
  const buffers = (await page.evaluate(() => window.bufferProbe)) as readonly BufferProbeCase[];
  const edges = (await page.evaluate(() => window.edgeProbe)) as EdgeProbeCase | undefined;
  const palette = (await page.evaluate(() => window.paletteProbe)) as PaletteProbeCase | undefined;

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

  // The depth/normal buffers (spec 090). Read back through the debug blit,
  // because a depth attachment cannot be read any other way -- which is also why
  // the first thing checked is simply that it is not a constant.
  for (const probe of buffers) {
    const problems: string[] = [];
    if (probe.distinct < 8) {
      problems.push(`only ${probe.distinct} distinct values -- the buffer is a constant, so nothing is bound`);
    }
    if (probe.covered < 0.05) problems.push(`only ${(probe.covered * 100).toFixed(1)}% of the frame is surface`);

    if (probe.decalLeaked) {
      problems.push('a translucent ground decal changed the buffer -- it must contribute nothing');
    }
    // There has to be somewhere with nothing in it, or "the background reads as
    // background" is a claim about a frame that has no background.
    if (probe.backgroundFraction < 0.02) {
      problems.push(`only ${(probe.backgroundFraction * 100).toFixed(1)}% background -- nothing to compare against`);
    }

    if (probe.view === 'depth') {
      // A depth texture that never bound reads as a constant, which the distinct
      // check catches; one bound but never written reads as all far plane, which
      // this does.
      if (probe.nearest >= probe.furthest) problems.push('depth has no range: near and far are the same');
      if (probe.furthest >= 255) problems.push('nothing was written in front of the far plane');
    } else {
      if (probe.facingCamera < 0.6) {
        problems.push(
          `only ${(probe.facingCamera * 100).toFixed(0)}% of surfaces face the camera -- ` +
            'the encode, the decode or the view-space transform is inverted',
        );
      }
    }

    if (problems.length > 0) failed = true;
    const detail =
      probe.view === 'depth'
        ? `near ${probe.nearest}, far ${probe.furthest}`
        : `${(probe.facingCamera * 100).toFixed(0)}% facing camera`;
    console.log(
      `${problems.length === 0 ? 'ok  ' : 'FAIL'}  ${probe.label}\n` +
        `        ${probe.distinct} distinct, ${(probe.covered * 100).toFixed(0)}% surface, ` +
        `${(probe.backgroundFraction * 100).toFixed(0)}% background, ${detail}`,
    );
    for (const problem of problems) console.log(`        ${problem}`);
  }

  // The outline pass (spec 091).
  if (edges) {
    const problems: string[] = [];
    if (edges.edgeFraction < 0.01) problems.push('found no edges at all');
    if (edges.edgeFraction > 0.35) {
      problems.push(`${(edges.edgeFraction * 100).toFixed(0)}% of the frame is edge -- that is a fill, not an outline`);
    }
    // The claim the plane reconstruction exists to make. A raw depth-difference
    // test covers a glancing floor in lines and would score near 100 here;
    // measured against each neighbour's own plane the floor comes back clean.
    //
    // Not zero, and it should not be: a floor pixel one tap away from a trunk has
    // a trunk in its neighbourhood and is correctly an edge. That contact line is
    // the whole of what remains, and it is about 2%.
    if (edges.floorEdgeFraction > 0.06) {
      problems.push(
        `${(edges.floorEdgeFraction * 100).toFixed(0)}% of the flat floor is marked -- ` +
          'the depth test is measuring raw difference, not deviation from the neighbour plane',
      );
    }
    if (edges.edgeFractionSky <= edges.edgeFraction) {
      problems.push('allowing the sky changed nothing, so the background mask is not doing anything');
    }

    // The composite. Turning outlines on must draw lines *over* the picture and
    // not replace it -- the failure that shipped, where the pass cleared the
    // canvas before blending and the world went black with a few lines on it.
    // Everything above measures the mask, and the mask was never the problem.
    if (edges.compositeMean < edges.frameMean * 0.75) {
      problems.push(
        `the frame went from ${(edges.frameMean * 100).toFixed(0)}% to ` +
          `${(edges.compositeMean * 100).toFixed(0)}% brightness -- the outline pass is ` +
          'replacing the picture rather than drawing over it',
      );
    }
    if (edges.compositeLines < 0.005) problems.push('no pixel got darker, so no line was actually composited');
    if (problems.length > 0) failed = true;
    console.log(
      `${problems.length === 0 ? 'ok  ' : 'FAIL'}  edge mask\n` +
        `        ${(edges.edgeFraction * 100).toFixed(1)}% edge, ` +
        `${(edges.edgeFractionSky * 100).toFixed(1)}% with sky, ` +
        `${(edges.floorEdgeFraction * 100).toFixed(1)}% of the flat floor\n` +
        `        composite: ${(edges.frameMean * 100).toFixed(0)}% -> ` +
        `${(edges.compositeMean * 100).toFixed(0)}% brightness, ` +
        `${(edges.compositeLines * 100).toFixed(1)}% of pixels darkened`,
    );
    for (const problem of problems) console.log(`        ${problem}`);
  }

  // Quantizing onto a palette (spec 092).
  if (palette) {
    const problems: string[] = [];
    // The claim, stated the only way it can be. A quantizer that is subtly wrong
    // still produces a stylized-looking frame.
    if (palette.onPalette < 0.999) {
      problems.push(
        `only ${(palette.onPalette * 100).toFixed(2)}% of pixels are a palette colour -- ` +
          'the frame is not on the palette',
      );
    }
    if (palette.distinct > palette.paletteSize) {
      problems.push(`${palette.distinct} distinct colours from a palette of ${palette.paletteSize}`);
    }
    if (!palette.changedFrame) problems.push('the palette changed nothing, so it never reached the shader');
    if (problems.length > 0) failed = true;
    console.log(
      `${problems.length === 0 ? 'ok  ' : 'FAIL'}  palette\n` +
        `        ${palette.distinct} of ${palette.paletteSize} colours used, ` +
        `${(palette.onPalette * 100).toFixed(2)}% on palette ` +
        `(even steps gave ${palette.distinctStepped})`,
    );
    for (const problem of problems) console.log(`        ${problem}`);
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
