/**
 * Drive the map editor's material brush in a real browser (spec 179).
 *
 * `paint.ts` is tested headlessly and covers every rule about which cells a
 * stroke changes. What it cannot cover is whether any of it reaches the screen:
 * the mode button, the swatch strip, the drag, the re-mesh, and the Ctrl+Z that
 * takes it back all live in `view.ts` and `panel.ts`, which need a DOM and a GPU.
 *
 *   npm run build && npx tsx scripts/preview-paint.ts
 *
 * Everything here is measured off the **pixels**, because the way this feature
 * fails is exactly "the store changed and the ground did not" -- a material is a
 * colour on the ground and nothing else. Measured as *change* rather than
 * against the palette, for the reason `REPAINTED` gives below. Serves `dist/`
 * rather than the dev server, so what is photographed is what ships. Exits
 * non-zero if a step did not do what it claims.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { PAINT_MATERIALS } from '../src/render/iso3d/editor/paint.js';
import { AUTOSAVE_KEY } from '../src/render/iso3d/editor/persistence.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4327;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
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

const failures: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

type Rgb = readonly [number, number, number];

/** Squared distance in RGB. Only ever compared against another, so no root. */
function distance2(a: Rgb, b: Rgb): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/**
 * How different two pixels have to be to count as repainted.
 *
 * About 24 per channel. Everything here is measured as *change* rather than
 * against `TERRAIN_COLORS` directly, and the first cut of this harness is why:
 * the ground is drawn in flat palette blocks, but they are then shaded by the
 * light and graded and quantized by the retro pass, so a painted pixel is a
 * long way from its palette entry by the time it reaches the screen. Reading
 * each pixel as "whichever entry it is nearest" found dirt perfectly and lost
 * snow completely -- lit and graded, near-white lands closer to `rock` than to
 * `snow`, and the harness reported a working brush as painting nothing.
 *
 * Change has nothing to be wrong about, and it is also the sharper instrument:
 * a cell either took the paint or it did not, which is precisely what the
 * dithered edge is made of.
 */
const REPAINTED = 24 * 24 * 3;

interface Shot {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
  /**
   * False where the pixel moved between two frames taken a beat apart.
   *
   * The editor is not a still: the trees sway, so about 9000 pixels of a
   * 936x799 view change on their own every second. That is a fifth of a paint
   * stroke's own footprint, spread thinly over everything, and it put the
   * measured centre of the first stroke nowhere near the stroke. Sampling each
   * state twice and keeping only the pixels that agree costs one extra
   * screenshot per measurement and takes the sway out exactly, rather than
   * hoping a threshold tells a swaying leaf from fresh paint.
   */
  readonly still: boolean[];
}

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Somewhere the cursor ring cannot be drawn into a measurement.
 *
 * The ring follows the mouse and is drawn on the ground at the brush radius, so
 * a frame taken with the mouse still over the stroke carries a ~120px circle
 * that the frame before it did not -- which is about 1500 pixels, and is
 * exactly the residue that made the first undo measurement look like a tenth of
 * the stroke surviving. Parked over the panel, no measurement contains it.
 */
let park: [number, number] = [0, 0];

async function grab(page: Page, clip: Clip): Promise<Shot> {
  await page.mouse.move(park[0], park[1]);
  await page.waitForTimeout(250);
  const first = PNG.sync.read(await page.screenshot({ clip }));
  await new Promise((resolve) => setTimeout(resolve, 700));
  const second = PNG.sync.read(await page.screenshot({ clip }));
  const still: boolean[] = [];
  for (let i = 0; i < second.width * second.height; i++) {
    const p = i * 4;
    const a: Rgb = [first.data[p] ?? 0, first.data[p + 1] ?? 0, first.data[p + 2] ?? 0];
    const b: Rgb = [second.data[p] ?? 0, second.data[p + 1] ?? 0, second.data[p + 2] ?? 0];
    still.push(distance2(a, b) < REPAINTED);
  }
  return { width: second.width, height: second.height, data: second.data, still };
}

function pixel(shot: Shot, i: number): Rgb {
  const p = i * 4;
  return [shot.data[p] ?? 0, shot.data[p + 1] ?? 0, shot.data[p + 2] ?? 0];
}

/** A pixel counts as repainted only where both frames held it still. */
function tookPaint(before: Shot, after: Shot, i: number): boolean {
  if (!before.still[i] || !after.still[i]) return false;
  return distance2(pixel(before, i), pixel(after, i)) >= REPAINTED;
}

/**
 * Where a stroke landed, found by difference rather than by arithmetic.
 *
 * Which pixel a world point is under depends on the camera, and reproducing the
 * editor's projection here would be testing this file's copy of it rather than
 * the editor's -- so the footprint is measured off the two frames instead. The
 * centre is the mean of the pixels that took the paint, which is robust to the
 * ragged edge the whole feature is about.
 */
interface Blob {
  readonly count: number;
  readonly cx: number;
  readonly cy: number;
  /** Distance from the centre containing 95% of the paint: the stroke's reach. */
  readonly reach: number;
  /** The painted region's bounding box on screen. */
  readonly width: number;
  readonly height: number;
  /** The mean colour the painted ground came out, for telling materials apart. */
  readonly color: Rgb;
}

/**
 * The largest connected run of repainted pixels, 8-connected.
 *
 * A stroke is one mass, and everything else that changed is not: a leaf at the
 * same phase in both frames of one pair and a different one in the next slips
 * through the stillness filter, and a handful of those in the corners of the
 * window is enough to drag a 95th-percentile radius from 89px to 185px -- which
 * put two of the four coverage bands outside the stroke entirely and reported a
 * dithered edge as a dead one. Area is robust to specks; a radius is not, so the
 * specks are dropped rather than tolerated.
 */
function largestMass(changed: Uint8Array, width: number, height: number): number[] {
  const seen = new Uint8Array(changed.length);
  let best: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < changed.length; start++) {
    if (changed[start] !== 1 || seen[start] === 1) continue;
    const mass: number[] = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      mass.push(i);
      const x = i % width;
      const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (changed[j] !== 1 || seen[j] === 1) continue;
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (mass.length > best.length) best = mass;
  }
  return best;
}

function repainted(before: Shot, after: Shot): Blob | null {
  const changed = new Uint8Array(before.width * before.height);
  for (let i = 0; i < changed.length; i++) changed[i] = tookPaint(before, after, i) ? 1 : 0;

  const points: [number, number][] = [];
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (const i of largestMass(changed, before.width, before.height)) {
    const now = pixel(after, i);
    points.push([i % after.width, Math.floor(i / after.width)]);
    sr += now[0];
    sg += now[1];
    sb += now[2];
  }
  if (points.length === 0) return null;
  const n = points.length;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
  }
  const cx = sx / n;
  const cy = sy / n;
  const radii = points.map(([x, y]) => Math.hypot(x - cx, y - cy)).sort((a, b) => a - b);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    count: n,
    cx,
    cy,
    reach: radii[Math.floor(radii.length * 0.95)] ?? 0,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    color: [sr / n, sg / n, sb / n],
  };
}

/** What share of an annulus around `blob` took the paint. */
function coverageInRing(before: Shot, after: Shot, blob: Blob, from: number, to: number): number {
  let hits = 0;
  let total = 0;
  for (let i = 0; i < before.width * before.height; i++) {
    const d = Math.hypot((i % before.width) - blob.cx, Math.floor(i / before.width) - blob.cy);
    if (d < blob.reach * from || d > blob.reach * to) continue;
    // A pixel neither frame held still cannot answer, so it is not counted
    // either way rather than counted as unpainted.
    if (!before.still[i] || !after.still[i]) continue;
    total++;
    if (tookPaint(before, after, i)) hits++;
  }
  return total === 0 ? 0 : hits / total;
}

/**
 * Somewhere with no tree in it, chosen off one frame rather than guessed.
 *
 * The first version of this harness aimed at a fixed fraction of the viewport
 * and landed on a tree: the canopy sways, so it was excluded from every count,
 * and its shadow is stable but too dark to change visibly when the ground under
 * it is repainted -- which read as a stroke only 58% solid in its own middle.
 * Where the props stand depends on the map and the camera, so the aim is
 * *measured*: score each candidate window by how much of it moves on its own
 * (foliage) or is too dark to answer (shadow), and take the quietest.
 */
function clearestGround(shot: Shot, view: Clip, size: number): [number, number] {
  let best: [number, number] = [view.x + view.width / 2, view.y + view.height / 2];
  let bestScore = Infinity;
  const half = size / 2;
  for (const fx of [0.25, 0.35, 0.45, 0.55, 0.65, 0.75]) {
    for (const fy of [0.3, 0.42, 0.54, 0.66]) {
      const cx = Math.round(shot.width * fx);
      const cy = Math.round(shot.height * fy);
      if (cx - half < 0 || cy - half < 0 || cx + half > shot.width || cy + half > shot.height) continue;
      let score = 0;
      for (let y = cy - half; y < cy + half; y++) {
        for (let x = cx - half; x < cx + half; x++) {
          const i = y * shot.width + x;
          const [r, g, b] = pixel(shot, i);
          if (!shot.still[i]) score += 1;
          // Too dark to tell one material from another once it is repainted.
          if (0.2126 * r + 0.7152 * g + 0.0722 * b < 70) score += 1;
        }
      }
      if (score < bestScore) {
        bestScore = score;
        best = [view.x + cx, view.y + cy];
      }
    }
  }
  return best;
}

/**
 * The picture: what the footprint actually was, pixel by pixel.
 *
 * White took the paint, dark grey held still and did not, magenta moved on its
 * own and was therefore excluded from every count. It is the diagnostic for the
 * measurements above -- a core that is not solid is either a stroke that failed
 * or a tree standing in it, and the two look nothing alike here.
 */
async function writeMask(before: Shot, after: Shot, path: string): Promise<void> {
  const png = new PNG({ width: before.width, height: before.height });
  for (let i = 0; i < before.width * before.height; i++) {
    const p = i * 4;
    const unstable = !before.still[i] || !after.still[i];
    const painted = tookPaint(before, after, i);
    png.data[p] = unstable ? 255 : painted ? 255 : 40;
    png.data[p + 1] = unstable ? 0 : painted ? 255 : 40;
    png.data[p + 2] = unstable ? 255 : painted ? 255 : 40;
    png.data[p + 3] = 255;
  }
  await writeFile(path, PNG.sync.write(png));
}

/** One press-and-hold in place: the smallest stroke there is. */
async function stamp(page: Page, at: [number, number]): Promise<void> {
  await page.mouse.move(at[0], at[1]);
  await page.mouse.down();
  // A step, so the loop sees a painting frame at all -- and one small enough
  // that the swept capsule is still essentially the press's own circle.
  await page.mouse.move(at[0] + 1, at[1] + 1);
  await page.waitForTimeout(500);
  await page.mouse.up();
  await page.waitForTimeout(1000);
}

/** Drag across the ground slowly enough that the render loop sees the frames. */
async function drag(page: Page, from: [number, number], to: [number, number], steps = 10): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  await page.waitForTimeout(900);
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
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

    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
      // The unit loader shouts about the pig's clips carrying root travel every
      // time the page boots, which predates this and has nothing to do with the
      // ground. Everything else is this harness's business.
      if (message.type() === 'error' && !message.text().startsWith('[units]')) problems.push(message.text());
    });

    // Start from the baked map every time. The editor autosaves to
    // localStorage and restores it on load, so without this a run measures
    // whatever the *previous* run left behind -- and since the aim below is
    // chosen the same way each time, the second run would press snow onto
    // ground the first run had already painted snow and report a working brush
    // as doing nothing.
    await page.addInitScript((key: string) => {
      window.localStorage.removeItem(key);
    }, AUTOSAVE_KEY);

    // The built page is the game client since spec 252 and builds no tab strip at
    // all; this harness drives the Map editor tab, so it asks the workbench back.
    await page.goto(`http://localhost:${PORT}/?seed=20260806&client=workbench`, { waitUntil: 'load' });
    await page.click('button:has-text("Map editor")');
    // `canvas` alone matches the Play tab's too -- it stays in the DOM, hidden,
    // when a tab is switched away from.
    await page.waitForSelector('canvas:visible', { timeout: 60_000 });
    await page.waitForTimeout(4000);

    // The strip is one button per mode, and `paint` sits beside `terrain`.
    await page.click('button:has-text("paint")');
    await page.waitForTimeout(500);

    check('the paint folder appears when the mode is armed', await page.isVisible('text=Paint'), '');
    check('the shared falloff is on screen for it', await page.isVisible('text=Falloff'), '');
    check('the height brush\'s strength is not', !(await page.isVisible('text=Strength')), '');
    const swatches = await page.$$eval('button', (nodes) => nodes.map((n) => n.textContent ?? ''));
    const missing = PAINT_MATERIALS.filter((m) => !swatches.includes(m));
    check('every material has a swatch', missing.length === 0, missing.join(', '));
    check('water is not among them', !swatches.includes('water'), '');

    await page.screenshot({ path: join(outDir, 'editor-paint-armed.png') });

    const canvas: Clip = await page.$eval('canvas:visible', (c) => {
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    // Clear of the panel on the right, which is not ground and would count as a
    // repaint every time a slider redrew.
    const view: Clip = { ...canvas, width: Math.min(canvas.width, 940) };
    park = [Math.min(canvas.x + canvas.width - 40, view.x + view.width + 120), view.y + 24];

    const survey = await grab(page, view);
    const aim = clearestGround(survey, view, 300);
    console.log(`  aiming at ${aim[0].toFixed(0)},${aim[1].toFixed(0)} — the quietest ground in frame`);

    /** A window on the ground the stroke lands on, rather than the whole frame. */
    const around = (w: number, h: number): Clip => ({
      x: Math.max(view.x, aim[0] - w / 2),
      y: Math.max(view.y, aim[1] - h / 2),
      width: w,
      height: h,
    });
    const patch = around(340, 340);
    const wide = around(760, 340);

    // What the frame still does on its own once the sway has been filtered out,
    // so every count below has something to be "much bigger than". If this is
    // not near zero the measurements after it mean nothing, and this is the
    // number that says so rather than a mystery in the next check.
    const idleA = await grab(page, patch);
    const idleB = await grab(page, patch);
    const noise = repainted(idleA, idleB)?.count ?? 0;
    // Not zero: a leaf caught mid-sway in one of the four frames slips through.
    // What matters is that it is an order of magnitude below a stroke, which is
    // what every count below is compared against.
    check('the idle frame holds still once the sway is filtered', noise < 2000, `${noise} px move on their own`);

    await page.click('button:has-text("snow")');
    await page.waitForTimeout(300);

    const before = await grab(page, patch);
    await stamp(page, aim);
    const after = await grab(page, patch);

    const blob = repainted(before, after);
    check(
      'a press lays the loaded material on the ground',
      blob !== null && blob.count > Math.max(2000, noise * 10),
      blob ? `${blob.count} px, reach ${blob.reach.toFixed(0)}px, against ${noise} idle` : 'nothing was painted',
    );
    await page.screenshot({ path: join(outDir, 'editor-paint-snow.png') });
    await writeMask(before, after, join(outDir, 'editor-paint-mask.png'));
    if (!blob) throw new Error('nothing was painted, so there is nothing left to measure');
    const snowColor = blob.color;

    // The stroke's coverage *profile*, which is the one property of this feature
    // that only exists on screen: one material per cell forbids a blend, so the
    // soft edge has to be a gradient of how much of each band took the paint,
    // and a cookie-cutter circle would be as solid at its rim as in its middle.
    //
    // Stated as a shape rather than as an absolute number in the middle,
    // because the middle is not all paintable: a prop's shadow is too dark to
    // read either way, and ground under the flood line is refused outright and
    // correctly. Both notch the core, neither is the brush, and a threshold
    // there would be a fact about where the trees are.
    const bands = [0, 1, 2, 3].map((i) => coverageInRing(before, after, blob, i * 0.25, (i + 1) * 0.25));
    const [core = 0, , , rim = 0] = bands;
    check(
      'the middle of the stroke is mostly covered',
      core > 0.65,
      bands.map((b) => `${(b * 100).toFixed(0)}%`).join(' → '),
    );
    check(
      'coverage falls off with distance rather than stopping dead',
      bands.every((b, i) => i === 0 || b <= (bands[i - 1] ?? 0) + 0.02),
      bands.map((b) => `${(b * 100).toFixed(0)}%`).join(' → '),
    );
    check(
      'the edge is dithered rather than cut',
      rim > 0.03 && rim < core * 0.5,
      `${(rim * 100).toFixed(0)}% at the rim against ${(core * 100).toFixed(0)}% in the middle`,
    );

    // Ctrl+Z gives the ground back. The undo restores the chunk arrays; that the
    // re-mesh went with them is why the pixels came back too.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(1500);
    const undone = await grab(page, patch);
    const leftBehind = repainted(before, undone)?.count ?? 0;
    check('Ctrl+Z gives the ground back', leftBehind < blob.count * 0.1, `${leftBehind} px left of ${blob.count}`);
    await page.screenshot({ path: join(outDir, 'editor-paint-undone.png') });

    // A second material, so the swatch is shown to be read at the stroke rather
    // than baked in when the mode was armed. Snow and dirt are the two ends of
    // the palette, so what separates them is stated as a direction rather than
    // as a colour: near-white against warm orange survives any grade.
    await page.click('button:has-text("dirt")');
    await page.waitForTimeout(300);
    await stamp(page, aim);
    const dirtShot = await grab(page, patch);
    const dirtBlob = repainted(undone, dirtShot);
    check(
      'a different swatch lays a different material',
      dirtBlob !== null && dirtBlob.count > Math.max(2000, noise * 10),
      dirtBlob ? `${dirtBlob.count} px` : 'nothing was painted',
    );
    if (dirtBlob) {
      const lum = (c: Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const warmth = (c: Rgb): number => c[0] - c[2];
      check(
        'snow came out brighter than dirt, and dirt warmer than snow',
        lum(snowColor) > lum(dirtBlob.color) + 20 && warmth(dirtBlob.color) > warmth(snowColor) + 20,
        `snow ${lum(snowColor).toFixed(0)}/${warmth(snowColor).toFixed(0)}, ` +
          `dirt ${lum(dirtBlob.color).toFixed(0)}/${warmth(dirtBlob.color).toFixed(0)} (luma/warmth)`,
      );
    }
    await page.screenshot({ path: join(outDir, 'editor-paint-dirt.png') });

    // Painting the same place again is idempotent -- the cells are already that
    // material, so nothing is written and nothing on screen moves.
    await stamp(page, aim);
    const again = await grab(page, patch);
    const grew = repainted(dirtShot, again)?.count ?? 0;
    check(
      'painting the same place again changes nothing',
      grew < Math.max(noise * 3, (dirtBlob?.count ?? 0) * 0.05),
      `${grew} px more, against ${noise} idle`,
    );

    // A drag is the gesture this is really used with, and the footprint is the
    // capsule the cursor swept rather than a stamp per frame -- so it comes out
    // elongated along the drag, and by more than a press's own reach.
    await page.click('button:has-text("snow")');
    await page.waitForTimeout(300);
    const beforeDrag = await grab(page, wide);
    await drag(page, [aim[0] - 200, aim[1]], [aim[0] + 200, aim[1]]);
    const dragged = await grab(page, wide);
    const swept = repainted(beforeDrag, dragged);
    check(
      'a drag paints the path it swept, not a stamp',
      swept !== null && swept.width > blob.width + blob.reach && swept.width > swept.height,
      swept ? `${swept.width}x${swept.height}px against a press's ${blob.width}x${blob.height}` : 'nothing painted',
    );
    await page.screenshot({ path: join(outDir, 'editor-paint-drag.png') });

    check('the page logged nothing', problems.length === 0, problems.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  console.log(
    failures.length === 0
      ? '\nall checks passed; wrote .claude/screenshots/editor-paint-*.png'
      : `\n${failures.length} check(s) failed: ${failures.join(', ')}`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

void main();
