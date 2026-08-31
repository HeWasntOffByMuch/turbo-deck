// Dev-only: photograph the Play tab with the hike switches thrown, the way a
// player throws them (specs 097-106). `npx tsx scripts/preview-hike.ts`
//
// Exists because the outline pass shipped broken in a way none of the offscreen
// checks could see: the mask was correct, and the pass cleared the canvas before
// blending it, so the world went black. Everything measured was right and the
// thing on screen was wrong. This drives the real page and the real controls.
//
// Every switch it throws lives behind the "Hike look" button since spec 107 --
// the ten steps got a popover of their own rather than sharing the view cog's
// with the camera, the clock, the lights and the filter.
//
// It also answers the question the offscreen palette check cannot. That one
// proves every pixel is a palette colour, which is the correctness claim; whether
// sixteen colours are *enough* for this world is a question about the world, and
// the probe's four-tree scene has only a handful of tones in it either way.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4331;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

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

const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['preview', '--port', String(PORT), '--strictPort'], {
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
  // The built page is the game client since spec 253 and builds none of the tuning
  // popovers; this harness drives "Hike look" directly, so it asks the workbench back.
  await page.goto(`http://localhost:${PORT}/?seed=20260806&client=workbench`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(3000);

  const outDir = join(root, '.claude', 'screenshots');
  mkdirSync(outDir, { recursive: true });

  const canvasRect = async (): Promise<{ x: number; y: number; width: number; height: number }> =>
    page.evaluate(() => {
      const r = document.querySelector('canvas')?.getBoundingClientRect();
      return { x: r?.x ?? 0, y: r?.y ?? 0, width: r?.width ?? 1, height: r?.height ?? 1 };
    });

  /**
   * Mean brightness of the drawn frame, so "went black" is a number.
   *
   * From a screenshot rather than from the canvas: reading a WebGL canvas back
   * through `drawImage` gives a blank image unless it was created with
   * `preserveDrawingBuffer`, and the game's is not. That measured 0% with the
   * feature switched off, which is a broken thermometer rather than a cold room.
   */
  const brightness = async (file: string): Promise<number> => {
    const shot = await page.screenshot({ path: file, clip: await canvasRect() });
    const png = PNG.sync.read(shot);
    let sum = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      sum += ((png.data[i] ?? 0) + (png.data[i + 1] ?? 0) + (png.data[i + 2] ?? 0)) / 3;
    }
    return sum / (png.data.length / 4) / 255;
  };

  const before = await brightness(join(outDir, 'world-outlines-off.png'));

  await page.click('button[aria-label="Hike look"]');
  await page.locator('label', { hasText: 'Outlines' }).first().locator('input[type=checkbox]').check();
  await page.click('button[aria-label="Hike look"]');
  await page.waitForTimeout(1200);

  const after = await brightness(join(outDir, 'world-outlines.png'));

  console.log(`brightness off: ${(before * 100).toFixed(1)}%   on: ${(after * 100).toFixed(1)}%`);
  if (after < before * 0.75) {
    failed = true;
    console.log('  FAIL: switching outlines on darkened the whole frame');
  } else if (after >= before * 0.999) {
    failed = true;
    console.log('  FAIL: switching outlines on changed nothing');
  } else {
    console.log('  ok: lines drawn over the picture, picture still there');
  }

  // And the palette, on the real world rather than on the probe's four trees.
  await page.click('button[aria-label="Hike look"]');
  await page.locator('label', { hasText: 'Palette' }).first().locator('select').selectOption('world');
  await page.click('button[aria-label="Hike look"]');
  await page.waitForTimeout(1200);
  await brightness(join(outDir, 'world-palette.png'));

  // The distance treatment, on the real world (spec 103).
  //
  // The claim measured offscreen is that far fills move and near fills do not.
  // On the real page there is no depth buffer to classify by, but there does not
  // need to be: the camera looks down at the ground, so up the screen *is*
  // further away. Comparing the top of the frame with the bottom is the same
  // claim in the only terms a screenshot has.
  await page.click('button[aria-label="Hike look"]');
  await page.locator('label', { hasText: 'Palette' }).first().locator('select').selectOption('none');
  await page.click('button[aria-label="Hike look"]');
  await page.waitForTimeout(800);
  const inkOff = await page.screenshot({ path: join(outDir, 'world-ink-off.png'), clip: await canvasRect() });

  await page.click('button[aria-label="Hike look"]');
  await page.locator('label', { hasText: 'Distance ink' }).first().locator('input[type=checkbox]').check();
  await page.click('button[aria-label="Hike look"]');
  await page.waitForTimeout(1200);
  const inkOn = await page.screenshot({ path: join(outDir, 'world-ink.png'), clip: await canvasRect() });

  /**
   * Mean chroma in the far third of the frame and in the near third.
   *
   * A *statistic per frame* rather than a difference between two, because the
   * world is live: trees sway, the light moves, monsters walk. Differencing two
   * screenshots taken a second apart showed about 19% change everywhere with the
   * treatment off, which says nothing about the treatment at all. Chroma is
   * something the animation barely moves across a whole third of the frame and
   * that draining colour moves a great deal, so it separates the two.
   */
  const bandChroma = (shot: Buffer): { far: number; near: number } => {
    const png = PNG.sync.read(shot);
    let far = 0;
    let farN = 0;
    let near = 0;
    let nearN = 0;
    for (let y = 0; y < png.height; y++) {
      const isFar = y < png.height / 3;
      const isNear = y > (png.height * 2) / 3;
      if (!isFar && !isNear) continue;
      for (let x = 0; x < png.width; x++) {
        const i = (y * png.width + x) * 4;
        const r = png.data[i] ?? 0;
        const g = png.data[i + 1] ?? 0;
        const b = png.data[i + 2] ?? 0;
        const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
        if (isFar) {
          far += chroma;
          farN++;
        } else {
          near += chroma;
          nearN++;
        }
      }
    }
    return { far: farN === 0 ? 0 : far / farN, near: nearN === 0 ? 0 : near / nearN };
  };

  const chromaOff = bandChroma(inkOff);
  const chromaOn = bandChroma(inkOn);
  console.log(
    `distance ink chroma: far ${(chromaOff.far * 100).toFixed(1)}% -> ${(chromaOn.far * 100).toFixed(1)}%, ` +
      `near ${(chromaOff.near * 100).toFixed(1)}% -> ${(chromaOn.near * 100).toFixed(1)}%`,
  );
  if (chromaOn.far > chromaOff.far * 0.85) {
    failed = true;
    console.log('  FAIL: the far third kept its colour, so the treatment did nothing there');
  } else if (chromaOn.near < chromaOff.near * 0.9) {
    failed = true;
    console.log('  FAIL: the near third drained too -- that is a filter, not a distance effect');
  } else {
    console.log('  ok: the distance drains and the foreground keeps its colour');
  }

  // Baked creases, on the real map (spec 104).
  //
  // The offscreen probe uses a synthetic bowl where the answer is known. This
  // asks the only question that scene cannot: whether real terrain has folds in
  // it at all. A measure that is perfectly correct and fires on nothing would
  // pass every check in the probe.
  await page.click('button[aria-label="Hike look"]');
  await page.locator('label', { hasText: 'Distance ink' }).first().locator('input[type=checkbox]').uncheck();
  await page.locator('label', { hasText: 'Outlines' }).first().locator('input[type=checkbox]').uncheck();
  await page.click('button[aria-label="Hike look"]');
  await page.waitForTimeout(800);
  const creaseOff = await page.screenshot({ path: join(outDir, 'world-creases-off.png'), clip: await canvasRect() });

  await page.click('button[aria-label="Hike look"]');
  await page.locator('label', { hasText: 'Creases' }).first().locator('input[type=checkbox]').check();
  await page.click('button[aria-label="Hike look"]');
  await page.waitForTimeout(1200);
  const creaseOn = await page.screenshot({ path: join(outDir, 'world-creases.png'), clip: await canvasRect() });

  const creaseChange = (before: Buffer, after: Buffer): { darker: number; lighter: number; depth: number } => {
    const a = PNG.sync.read(before);
    const b = PNG.sync.read(after);
    let darker = 0;
    let lighter = 0;
    let depth = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const va = ((a.data[i] ?? 0) + (a.data[i + 1] ?? 0) + (a.data[i + 2] ?? 0)) / 3;
      const vb = ((b.data[i] ?? 0) + (b.data[i + 1] ?? 0) + (b.data[i + 2] ?? 0)) / 3;
      if (vb < va - 2) {
        darker++;
        depth += (va - vb) / 255;
      } else if (vb > va + 2) {
        lighter++;
      }
    }
    const total = a.data.length / 4;
    return { darker: darker / total, lighter: lighter / total, depth: darker === 0 ? 0 : depth / darker };
  };

  const creases = creaseChange(creaseOff, creaseOn);
  // The lightened fraction is the world moving between the two shots -- trees
  // sway, monsters walk, the sun turns -- and not the feature, which multiplies
  // by at most one and cannot brighten anything. That claim is asserted properly
  // in the offscreen probe, on a scene that holds still.
  console.log(
    `creases: ${(creases.darker * 100).toFixed(1)}% of the frame darkened by ` +
      `${(creases.depth * 100).toFixed(1)}% ` +
      `(${(creases.lighter * 100).toFixed(1)}% lightened by the world moving between shots)`,
  );
  if (creases.darker < 0.01) {
    failed = true;
    console.log('  FAIL: the real map has no folds the measure can find');
  } else if (creases.darker > 0.6) {
    failed = true;
    console.log('  FAIL: over half the frame darkened -- that is a dimmer, not a crease');
  } else {
    console.log('  ok: folds darkened, the rest of the ground left alone');
  }

  // Soft shadows, on the real map (spec 105).
  //
  // The offscreen probe measures a synthetic box on a plane, where the penumbra
  // can be counted exactly. This asks the question that scene cannot: whether the
  // patched chunk survives the *real* set of materials -- ground, walls, props,
  // units -- since it was spliced into a chunk all of them include and a shader
  // that fails to compile is a logged message rather than an exception.
  await page.click('button[aria-label="Hike look"]');
  await page.locator('label', { hasText: 'Creases' }).first().locator('input[type=checkbox]').uncheck();
  await page.click('button[aria-label="Hike look"]');
  await page.waitForTimeout(800);
  const shadowOff = await page.screenshot({ path: join(outDir, 'world-shadows-hard.png'), clip: await canvasRect() });

  await page.click('button[aria-label="Hike look"]');
  await page.locator('label', { hasText: 'Soft shadows' }).first().locator('input[type=checkbox]').check();
  await page.click('button[aria-label="Hike look"]');
  await page.waitForTimeout(1200);
  const shadowOn = await page.screenshot({ path: join(outDir, 'world-shadows-soft.png'), clip: await canvasRect() });

  const changed = (before: Buffer, after: Buffer): number => {
    const a = PNG.sync.read(before);
    const b = PNG.sync.read(after);
    let count = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const va = ((a.data[i] ?? 0) + (a.data[i + 1] ?? 0) + (a.data[i + 2] ?? 0)) / 3;
      const vb = ((b.data[i] ?? 0) + (b.data[i + 1] ?? 0) + (b.data[i + 2] ?? 0)) / 3;
      if (Math.abs(va - vb) > 2) count++;
    }
    return count / (a.data.length / 4);
  };

  const softened = changed(shadowOff, shadowOn);
  const meanSoft = await brightness(join(outDir, 'world-shadows-soft.png'));
  console.log(
    `soft shadows: ${(softened * 100).toFixed(1)}% of the frame changed, ` +
      `mean brightness ${(meanSoft * 100).toFixed(1)}%`,
  );
  if (softened < 0.005) {
    failed = true;
    console.log('  FAIL: nothing changed, so the filter never reached the real materials');
  } else if (softened > 0.5) {
    failed = true;
    console.log('  FAIL: half the frame changed -- that is not a shadow edge');
  } else {
    console.log('  ok: shadow edges softened, the rest of the frame left alone');
  }

  // Surface detail on the real map (spec 106). The offscreen probe uses a
  // synthetic plateau where the cliff is a known rectangle; this asks whether the
  // patched materials survive the real world's set of them.
  await page.click('button[aria-label="Hike look"]');
  await page.locator('label', { hasText: 'Soft shadows' }).first().locator('input[type=checkbox]').uncheck();
  await page.click('button[aria-label="Hike look"]');
  await page.waitForTimeout(800);
  const detailOff = await page.screenshot({ path: join(outDir, 'world-detail-off.png'), clip: await canvasRect() });

  await page.click('button[aria-label="Hike look"]');
  await page.locator('label', { hasText: 'Surface detail' }).first().locator('input[type=checkbox]').check();
  await page.locator('label', { hasText: 'Rock by slope' }).first().locator('input[type=checkbox]').check();
  await page.click('button[aria-label="Hike look"]');
  await page.waitForTimeout(1200);
  const detailOn = await page.screenshot({ path: join(outDir, 'world-detail.png'), clip: await canvasRect() });

  const tones = (shot: Buffer): number => {
    const png = PNG.sync.read(shot);
    const seen = new Set<number>();
    for (let i = 0; i < png.data.length; i += 4) {
      seen.add(((png.data[i] ?? 0) << 16) | ((png.data[i + 1] ?? 0) << 8) | (png.data[i + 2] ?? 0));
    }
    return seen.size;
  };

  const tonesOff = tones(detailOff);
  const tonesOn = tones(detailOn);
  console.log(`surface detail: ${tonesOff} distinct colours -> ${tonesOn}`);
  if (tonesOn <= tonesOff) {
    failed = true;
    console.log('  FAIL: the texture reached nothing on the real materials');
  } else {
    console.log('  ok: the ground and cliffs carry detail');
  }

  const distinct = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return 0;
    // Counted from a screenshot-equivalent readback is not available here, so the
    // count comes from the script side; this only reports the canvas size.
    return canvas.width * canvas.height;
  });
  console.log(`palette frame written (${distinct} px canvas)`);

  await browser.close();
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
