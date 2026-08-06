/**
 * The acceptance pass for spec 073, run against a real browser and a real GL
 * context.
 *
 * Everything about the weather that can be answered by arithmetic is answered
 * in `wind.test.ts` and `shore-sdf.test.ts`. What is left is the set of
 * questions that are only about the *frame*: does the trunk stay the same
 * length when it leans, does the shadow lean with it, does the boundary between
 * two chunks of sea show, do the squiggles change topology or only slide. None
 * of those is checkable without drawing something, so this drives
 * `src/render/wind-probe.html` (dev-server only, never in a build), photographs
 * it and reports numbers.
 *
 *   npx vite &            # or let this start one
 *   npx tsx scripts/preview-wind.ts
 *
 * Uses the Vite **dev** server rather than `dist/`, because the probe page is
 * deliberately not part of a production build.
 *
 * A warning about the frame-time number it prints: there is no GPU in an
 * agent's container, so this runs on SwiftShader and every absolute figure is
 * one to two orders of magnitude off what hardware would do. The A/B against a
 * scene with the weather stripped back out is still meaningful -- both halves
 * pay the same software-rasterizer tax -- but read it as a ratio, not as
 * milliseconds.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4321;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/**
 * Where to point the camera. Found by walking `maps/arena.json` for the chunk
 * with the most even mix of water and land, and for a chunk boundary that falls
 * in open sea -- the two places the water has to be looked at.
 */
const COAST = { x: -60, z: 1788 };
/** A chunk boundary with deep water on both sides of it: the seam test. */
const SEAM = { x: 2096, z: 2305 };
/** Bare ground with room for two planted trees, away from the map's own forest. */
const TREES = { x: 400, z: 300 };

/**
 * The two instants the wind at {@link TREES} reaches its extremes, found by
 * sweeping `windAt` over twelve seconds.
 *
 * Chosen rather than picked arbitrarily, because the gust envelope means most
 * moments are quiet ones: an earlier version of this compared frames 0.7s apart
 * inside a lull, measured a tip displacement of under four units, and reported
 * that as "the shadows do not move". They were moving; the measurement was
 * standing in the wrong second.
 */
const GUST = { calm: 5.27, peak: 6.47 };

/**
 * What `src/render/iso3d/wind-probe.ts` hangs on `window`. Declared here rather
 * than imported, because this script runs in Node and the probe runs in the
 * page; the two only ever meet through `page.evaluate`.
 */
interface Probe {
  setTime(seconds: number): void;
  frameMs(): { median: number; mean: number; samples: number };
  reset(): void;
  windTime(): number;
  project(x: number, y: number, z: number): { x: number; y: number };
  programs(): { key: string; attributes: string[] }[];
}

/** The page's globals, as seen from inside a `page.evaluate` callback. */
declare const windProbe: Probe | undefined;

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
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

/** Open the probe with a query string, and wait until it has drawn. */
async function open(browser: Browser, query: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    // A shader that will not link reaches the console and nowhere else, which
    // is the whole reason this listener exists. The browser asking the dev
    // server for a favicon this page does not have is not a problem with it.
    const text = message.text();
    if (message.type() === 'error' && !text.includes('Failed to load resource')) problems.push(text);
  });
  await page.goto(`http://localhost:${PORT}/wind-probe.html?${query}`, { waitUntil: 'load' });
  await page.waitForSelector('body[data-probe-ready="true"]', { timeout: 60_000 });
  // A few frames, so the first-compile cost is behind us.
  await page.waitForTimeout(1500);
  if (problems.length > 0) throw new Error(`probe reported: ${problems.join(' | ')}`);
  return page;
}

/** A screenshot as pixels. */
async function pixels(page: Page): Promise<PNG> {
  return PNG.sync.read(await page.screenshot());
}

function at(png: PNG, x: number, y: number): [number, number, number] {
  const i = (png.width * y + x) * 4;
  return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0];
}

/** How many distinct colours appear inside a rectangle, and the commonest few. */
function palette(png: PNG, x0: number, y0: number, x1: number, y1: number): {
  distinct: number;
  top: { hex: string; share: number }[];
} {
  const counts = new Map<string, number>();
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const [r, g, b] = at(png, x, y);
      const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
      total++;
    }
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([hex, n]) => ({ hex, share: n / total }));
  return { distinct: counts.size, top };
}

/** Pixels that differ between two shots of the same framing. */
function changed(a: PNG, b: PNG, threshold = 6): number {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));
    const dg = Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0));
    const db = Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
    if (Math.max(dr, dg, db) > threshold) n++;
  }
  return n;
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  console.log(`  wrote ${name}.png`);
}

async function setTime(page: Page, seconds: number): Promise<void> {
  await page.evaluate((t) => windProbe?.setTime(t), seconds);
  await page.waitForTimeout(180);
}

async function frameMs(page: Page): Promise<{ median: number; mean: number; samples: number }> {
  await page.evaluate(() => windProbe?.reset());
  await page.waitForTimeout(6000);
  return page.evaluate(() => windProbe?.frameMs() ?? { median: 0, mean: 0, samples: 0 });
}

/** The lake fills the upper left of the coast framing; the rest is forest. */
const LAKE = { x0: 40, y0: 20, x1: 600, y1: 190 } as const;

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  try {
    await waitForServer(`http://localhost:${PORT}/wind-probe.html`);

    // --- 4: the trees, at both extremes of the gust -------------------------
    // Frozen at two instants rather than filmed, because "the frame changed" and
    // "the frame changed the way the wind says" are different questions and only
    // the second one is worth asking.
    const trees = await open(
      browser,
      `at=${TREES.x},${TREES.z}&trees=${TREES.x},${TREES.z}&span=150&retro=0&t=0`,
    );
    console.log('\n4. trees, between the two extremes of the gust');
    await setTime(trees, GUST.calm);
    const leanBack = await pixels(trees);
    await shoot(trees, 'wind-trees-lean-back');
    await setTime(trees, GUST.peak);
    const leanForward = await pixels(trees);
    await shoot(trees, 'wind-trees-lean-forward');
    console.log(`  pixels that move: ${changed(leanBack, leanForward)}`);

    // Canopy shear is the failure this design exists to avoid, and it has one
    // unmistakable symptom: the crown slides off the trunk and bare trunk
    // appears where foliage used to cover it. So the trunk is *counted*. The
    // scatter's whole point (spec 048) is that the trunk stops inside the
    // canopy, so a rise here means the two came apart.
    //
    // Counted only over the stretch of trunk that the canopy is *supposed* to
    // hide -- from the lowest frond up to where the trunk stops (spec 048's
    // whole subject) -- and only in the column the trees stand in, so the dirt
    // path running past them cannot be mistaken for bare wood. The band is
    // located with the probe's own camera rather than by eye.
    const ground = await trees.evaluate(
      ([x, z]) => windProbe?.project(x ?? 0, 0, z ?? 0) ?? { x: 0, y: 0 },
      [TREES.x, TREES.z],
    );
    const crown = await trees.evaluate(
      ([x, z]) => windProbe?.project(x ?? 0, 128, z ?? 0) ?? { x: 0, y: 0 },
      [TREES.x, TREES.z],
    );
    // The tree's own height in screen pixels, so the band scales with the shot.
    const tall = Math.abs(ground.y - crown.y);
    const box = {
      x0: Math.round(ground.x - tall * 0.45),
      x1: Math.round(ground.x + tall * 0.45),
      // From a quarter of the way up (just above the lowest frond) to where the
      // trunk ends, two thirds up.
      y0: Math.round(ground.y - tall * 0.68),
      y1: Math.round(ground.y - tall * 0.2),
    };
    const trunkish = (px: [number, number, number]): boolean =>
      px[0] > px[1] + 25 && px[1] > px[2] && px[0] > 70 && px[0] < 190;
    const trunkPixels = (png: PNG): number => {
      let n = 0;
      for (let y = box.y0; y < box.y1; y++) {
        for (let x = box.x0; x < box.x1; x++) if (trunkish(at(png, x, y))) n++;
      }
      return n;
    };
    const calmTrunk = trunkPixels(leanBack);
    const peakTrunk = trunkPixels(leanForward);
    console.log(`  trunk left bare inside the canopy, leaning back:    ${calmTrunk} px`);
    console.log(`  ...and leaning forward:                             ${peakTrunk} px`);
    await trees.close();

    // Criterion 3, the shadows. Guessing where the shade lands and measuring
    // there is fragile; instead the shade is *found* -- it is exactly the set of
    // pixels that differ between the same frame drawn with the shadow pass on
    // and with it off. Then the question is whether those pixels move.
    console.log('\n3. shadows');
    const framing = `at=${TREES.x},${TREES.z}&trees=${TREES.x},${TREES.z}&span=150&retro=0&t=0`;
    const lit = await open(browser, `${framing}&shadows=1`);
    const unlit = await open(browser, `${framing}&shadows=0`);
    await setTime(lit, GUST.calm);
    await setTime(unlit, GUST.calm);
    const litEarly = await pixels(lit);
    const shade: boolean[] = [];
    const unlitEarly = await pixels(unlit);
    for (let i = 0; i < litEarly.data.length; i += 4) {
      shade.push(Math.abs((litEarly.data[i] ?? 0) - (unlitEarly.data[i] ?? 0)) > 6);
    }
    const shadePixels = shade.filter(Boolean).length;
    // Compared between the two extremes of the gust, so the trees really are in
    // two different places rather than two moments of the same lull.
    let movedShade = 0;
    let movedTrees = 0;
    {
      await setTime(lit, GUST.peak);
      const later = await pixels(lit);
      for (let p = 0; p < shade.length; p++) {
        const i = p * 4;
        if (Math.abs((litEarly.data[i] ?? 0) - (later.data[i] ?? 0)) <= 6) continue;
        if (shade[p]) movedShade++;
        else movedTrees++;
      }
      await shoot(lit, 'wind-tree-shadows');
    }
    // The decisive check, before any pixel counting: a program compiled with
    // `aWindBase` bound is a program that went through the splice.
    const programs = await lit.evaluate(() => windProbe?.programs() ?? []);
    const swaying = programs.filter((p) => p.attributes.includes('aWindBase'));
    console.log(`  programs compiled:                     ${programs.length}`);
    console.log(`  ...carrying the wind attributes:       ${swaying.length}`);
    for (const program of swaying) console.log(`      ${program.key}`);

    console.log(`  pixels the shadow pass darkens:        ${shadePixels}`);
    console.log(`  shaded pixels that move (peak):        ${movedShade} (${((movedShade / Math.max(1, shadePixels)) * 100).toFixed(0)}% of the shade)`);
    console.log(`  everything else that moves (peak):     ${movedTrees}`);
    await lit.close();
    await unlit.close();

    // --- 5/6/7: the water ---------------------------------------------------
    const coast = await open(browser, `at=${COAST.x},${COAST.z}&span=420&retro=0&t=3`);
    await shoot(coast, 'wind-water-coast');
    const coastShot = await pixels(coast);
    console.log('\n6. water palette (retro pass off, so this is the shader alone)');
    // Counting the whole frame's colours would say nothing about the water.
    const band = palette(coastShot, LAKE.x0, LAKE.y0, LAKE.x1, LAKE.y1);
    console.log(`  distinct colours over the lake: ${band.distinct}`);
    for (const entry of band.top) console.log(`    ${entry.hex}  ${(entry.share * 100).toFixed(1)}%`);
    console.log(`  top four cover ${(band.top.slice(0, 4).reduce((n, e) => n + e.share, 0) * 100).toFixed(1)}%`);

    const coastRetro = await open(browser, `at=${COAST.x},${COAST.z}&span=420&retro=1&t=3`);
    await shoot(coastRetro, 'wind-water-coast-retro');
    const retroBand = palette(await pixels(coastRetro), LAKE.x0, LAKE.y0, LAKE.x1, LAKE.y1);
    console.log(`  ...and through the shipped retro pass: ${retroBand.distinct}`);
    await coastRetro.close();

    console.log('\n7. squiggles change topology rather than sliding');
    // "Changed a lot" is not the question -- a scrolled texture changes every
    // pixel too. The question is whether the change is a *rigid shift*. So the
    // best-matching translation over +-24 pixels is searched for, and what is
    // reported is how much of the difference that best shift can explain. A
    // field that slides is almost perfectly explained by one; a field whose
    // loops pinch off and reconnect is not.
    const field: PNG[] = [];
    for (const t of [0, 5]) {
      await setTime(coast, t);
      field.push(await pixels(coast));
    }
    const before = field[0] as PNG;
    const after = field[1] as PNG;
    const residual = (dx: number, dy: number): number => {
      let sum = 0;
      let n = 0;
      for (let y = LAKE.y0 + 24; y < LAKE.y1 - 24; y += 2) {
        for (let x = LAKE.x0 + 24; x < LAKE.x1 - 24; x += 2) {
          const a = at(before, x, y);
          const b = at(after, x + dx, y + dy);
          sum += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
          n++;
        }
      }
      return sum / n;
    };
    let best = { dx: 0, dy: 0, value: Infinity };
    for (let dy = -24; dy <= 24; dy += 2) {
      for (let dx = -24; dx <= 24; dx += 2) {
        const value = residual(dx, dy);
        if (value < best.value) best = { dx, dy, value };
      }
    }
    const still = residual(0, 0);
    console.log(`  pixels that differ over 5s:            ${changed(before, after)}`);
    console.log(`  difference over 5s with no shift:      ${still.toFixed(1)} per pixel`);
    console.log(`  ...best shift (${best.dx}, ${best.dy}) explains only:   ${(100 - (best.value / still) * 100).toFixed(0)}%`);
    console.log(`  residual after the best shift:         ${best.value.toFixed(1)} per pixel`);
    await coast.close();

    console.log('\n5. no seam at a chunk boundary');
    const seam = await open(browser, `at=${SEAM.x},${SEAM.z}&span=260&retro=0&t=2`);
    await shoot(seam, 'wind-water-seam');
    const seamShot = await pixels(seam);
    // Measured *on* the boundary rather than by hunting for an odd-looking
    // column. A chunk edge is a known straight line in world space, so pairs of
    // world points straddling it are sampled and compared against pairs the
    // same distance apart that straddle nothing. A seam makes the first set
    // worse than the second; anything that makes both worse equally (a band
    // edge, the noise) is not a seam.
    //
    // The world points are projected by the *probe's own camera*, so this is
    // not testing a second copy of the projection.
    const project = async (x: number, z: number): Promise<{ x: number; y: number }> =>
      seam.evaluate(([wx, wz]) => windProbe?.project(wx ?? 0, -60, wz ?? 0) ?? { x: -1, y: -1 }, [x, z]);

    /** Mean channel difference between the two sides of a world-space gap. */
    const straddle = async (x: number, z: number, gap: number): Promise<number | null> => {
      const a = await project(x - gap, z);
      const b = await project(x + gap, z);
      const inside = (p: { x: number; y: number }): boolean =>
        p.x >= 0 && p.y >= 0 && p.x < seamShot.width && p.y < seamShot.height;
      if (!inside(a) || !inside(b)) return null;
      const pa = at(seamShot, Math.round(a.x), Math.round(a.y));
      const pb = at(seamShot, Math.round(b.x), Math.round(b.y));
      const watery = (px: [number, number, number]): boolean => px[2] > px[0] + 20 && px[2] > px[1];
      if (!watery(pa) || !watery(pb)) return null;
      return (Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2])) / 3;
    };

    /** Half the world-space gap sampled either side of a line: one cell. */
    const GAP = 11;
    const onBoundary: number[] = [];
    const offBoundary: number[] = [];
    for (let z = SEAM.z - 240; z <= SEAM.z + 240; z += 8) {
      const on = await straddle(SEAM.x, z, GAP);
      if (on !== null) onBoundary.push(on);
      // A control line a third of a chunk away, which crosses no boundary.
      const off = await straddle(SEAM.x - 205, z, GAP);
      if (off !== null) offBoundary.push(off);
    }
    const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    console.log(`  samples across the chunk boundary:  ${onBoundary.length}`);
    console.log(`  mean difference across it:          ${mean(onBoundary).toFixed(2)} / 255 per channel`);
    console.log(`  ...and across open water nearby:    ${mean(offBoundary).toFixed(2)} (${offBoundary.length} samples)`);
    await seam.close();

    // --- part 3: the streak layer over the ground ---------------------------
    // The piece that makes this one weather system rather than two effects. Its
    // whole design is to be nearly invisible, so it is measured against the same
    // scene with the patch stripped out rather than by a threshold picked to
    // suit it: the ground either moves with the wind or it does not.
    console.log('\npart 3. the shared streak layer, over bare ground');
    for (const [label, extra] of [['patched', ''], ['stripped', '&baseline=1']] as const) {
      const land = await open(browser, `at=${TREES.x},${TREES.z}&span=300&retro=0&shadows=0&t=0${extra}`);
      await setTime(land, 0);
      const early = await pixels(land);
      await setTime(land, 3);
      const late = await pixels(land);
      if (label === 'patched') await shoot(land, 'wind-streak-ground');
      console.log(`  ground pixels moving over 3s (${label}): ${changed(early, late, 2)}`);
      await land.close();
    }

    // --- 8: the frame-time budget ------------------------------------------
    console.log('\n8. frame time (SOFTWARE rasterizer -- read the ratio, not the ms)');
    const shipped = await open(browser, `at=${COAST.x},${COAST.z}&span=420`);
    const withWeather = await frameMs(shipped);
    await shipped.close();
    const stripped = await open(browser, `at=${COAST.x},${COAST.z}&span=420&baseline=1`);
    const withoutWeather = await frameMs(stripped);
    await stripped.close();
    console.log(`  with the weather:    ${withWeather.mean.toFixed(3)} ms mean / ${withWeather.median.toFixed(2)} median  (${withWeather.samples} frames)`);
    console.log(`  weather stripped:    ${withoutWeather.mean.toFixed(3)} ms mean / ${withoutWeather.median.toFixed(2)} median  (${withoutWeather.samples} frames)`);
    console.log(`  delta (mean):        ${(withWeather.mean - withoutWeather.mean).toFixed(3)} ms`);
    console.log(`  ratio (mean):        ${(withWeather.mean / Math.max(1e-6, withoutWeather.mean)).toFixed(3)}x`);
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
