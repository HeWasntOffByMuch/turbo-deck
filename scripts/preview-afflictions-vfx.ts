// Dev-only: look at the seven afflictions on a body (spec 197).
// `npx tsx scripts/preview-afflictions-vfx.ts`
//
// Drives `src/render/brush-scene.html` -- the judging rig: full resolution,
// MSAA, no retro pass, no palette, a lit scene with a dummy standing in it --
// and writes three sheets:
//
//   .claude/screenshots/afflictions-vfx.png           one row per affliction,
//                                                     columns across its life
//   .claude/screenshots/afflictions-vfx-severity.png  the four heavy clings
//                                                     beside their light ones
//   .claude/screenshots/afflictions-vfx-seeds.png     three seeds each
//
// ## Why a sheet of its own rather than a row on `preview-brush-vfx.ts`
//
// Everything that sheet photographs is an *event*: a hit or a blast, thrown at a
// point and over inside a second. An affliction is the first thing in this
// vocabulary that is a **state** -- it clings to a body that is walking around
// for four to ten seconds -- and it has a second, slower rhythm on top of it,
// the beat that lands on the tick the damage actually resolves. Neither of those
// is a thing one frame can answer, so the columns here are *ticks across a life*
// with the beats fired on their real cadence, which differs per row: Burn every
// 30 ticks, Shock every 45, Decay every 60, straight off `intervalTicks`.
//
// ## What it measures
//
// The same four numbers `preview-brush-vfx.ts` computes, because "crisp" is a
// measurable property of this vocabulary rather than an opinion, and because two
// harnesses answering it two ways would be two definitions of crisp:
//
//   - **no stipple.** The fraction of ink pixels that are *isolated* -- lit,
//     with fewer than two lit neighbours. A dithered or stippled fill is roughly
//     half isolated pixels; a filled silhouette is a few percent, all boundary.
//   - **mass is in a few big pieces.** The largest connected ink region as a
//     share of all ink.
//   - **ink area.** How much of the tile the affliction actually covers, which
//     is the number severity is made of: spec 197's rule is *more paint, never
//     brighter paint*, so a heavy cling that is not measurably more ink than its
//     light one has not implemented the rule it was written for.
//   - **variation between seeds.** Different paintings by one artist.
//
// And the live particle count at every sampled tick, printed beside each tile,
// because the way this feature fails silently is an emitter that spawns nothing
// -- which is a dark tile somebody has to notice and a zero in a log nobody can
// miss. The `mesh` emitter shape degrades to a bare point without a `surface`
// hook, so "the marks are all in one spot at the dummy's feet" is a real failure
// mode with a real number attached: it shows up here as a tiny ink area with one
// enormous connected piece.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { ALL_DOTS, dotDurationTicks } from '../src/server/data/damage-over-time.js';
import { AFFLICTION_ART } from '../src/render/iso3d/world/affliction-vfx.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4334;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const VIEW_W = 480;
const VIEW_H = 360;

/**
 * One camera for the whole run, and that is a measurement decision rather than a
 * saving.
 *
 * Every tile is measured as a *difference* against a frame of the same scene
 * with nothing playing, so a fixed camera means one baseline for eighty-odd
 * tiles instead of one each -- but more importantly it means every ink number on
 * every sheet is against the identical background, so the light-versus-heavy
 * comparison is a comparison of paint and not of what happened to be behind it.
 * The bearing is the page's own default: three quarters on and half a radian up,
 * which is roughly where the game's isometric camera sits. The zoom is tighter
 * than `preview-brush-vfx.ts`'s, and for the opposite reason to that sheet's:
 * a blast is a hundred units across and needs room, where an affliction is a
 * coat of paint on a seventy-unit body and every pixel of frame that is not the
 * body is a pixel of grass being measured against a baseline of grass.
 */
const CAMERA = { azimuth: 0.95, elevation: 0.52, halfHeight: 75 } as const;

/** Three seeds that are not consecutive integers, for the reason `rng.ts` gives. */
const SEEDS = [20260810, 917331, 4242] as const;

/** The tick the severity and seed sheets are photographed at: cling at steady state. */
const STEADY = 40;

/**
 * How tall the dummy is drawn, in pixels of a tile.
 *
 * `DUMMY_RADIUS * DUMMY_HEIGHT_RADII` from `brush-scene.ts` -- 70 world units --
 * through this camera. Restated rather than imported because that module builds
 * a WebGL renderer at import time and Node has no canvas to give it, so it can
 * only ever run in the page. The coupling is stated here instead: it is used for
 * one thing, which is saying whether the paint reached up the body, and a stale
 * number would make that read pessimistically rather than silently pass.
 */
const BODY_PX = 70 * (VIEW_H / (2 * CAMERA.halfHeight));

interface Tile {
  readonly label: string;
  readonly png: PNG;
  readonly particles: number;
  readonly draws: number;
}

interface Row {
  readonly title: string;
  readonly tiles: Tile[];
}

// --- measurement -------------------------------------------------------------
//
// `isInk`, `measure` and `difference` below are copied from
// `scripts/preview-brush-vfx.ts` (spec 159), deliberately and with the comments
// intact. They are not exported from there -- that file runs `await main()` at
// module scope, so importing it would run a whole contact sheet as a side effect
// of asking for a function -- and the alternative, hoisting them into a shared
// module, is a refactor of a working harness in a spec that is about paint. If a
// third preview needs them, that is the moment.

/**
 * Whether a pixel is the effect rather than the scene.
 *
 * Against a **baseline of the same frame with nothing playing**, rather than
 * against a colour rule. A colour rule counts the grass, the trunks and the
 * dummy, and cannot see dark smoke at all. A difference against the identical
 * camera is exact and needs no assumptions about the palette.
 */
function isInk(png: PNG, base: PNG, at: number): boolean {
  const dr = Math.abs((png.data[at] ?? 0) - (base.data[at] ?? 0));
  const dg = Math.abs((png.data[at + 1] ?? 0) - (base.data[at + 1] ?? 0));
  const db = Math.abs((png.data[at + 2] ?? 0) - (base.data[at + 2] ?? 0));
  return Math.max(dr, dg, db) > 14;
}

interface InkStats {
  readonly ink: number;
  /** Isolated lit pixels as a share of ink. The stipple detector. */
  readonly isolated: number;
  /** Largest connected ink blob as a share of ink. */
  readonly biggest: number;
  /** Connected ink regions of at least 24 pixels. */
  readonly pieces: number;
  /** Centre of ink mass, in pixels from the middle of the tile. */
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Measure the ink in a tile.
 *
 * One pass to mark, one to count neighbours, one flood fill for the regions.
 * Slow and completely fine: this runs on a few dozen tiles once.
 */
function measure(png: PNG, base: PNG): InkStats {
  const w = png.width;
  const h = png.height;
  const mask = new Uint8Array(w * h);
  let ink = 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < w * h; i++) {
    if (!isInk(png, base, i * 4)) continue;
    mask[i] = 1;
    ink += 1;
    sumX += i % w;
    sumY += Math.floor(i / w);
  }
  if (ink === 0) return { ink: 0, isolated: 0, biggest: 0, pieces: 0, offsetX: 0, offsetY: 0 };

  // Isolation: a lit pixel with fewer than two lit neighbours in its 4-ring is
  // either a speck or a hairline. A dither fill is half of them by construction;
  // a filled shape is only its own boundary, and a boundary is a line rather
  // than an area, so the fraction stays small.
  let isolated = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let neighbours = 0;
      if (x > 0 && mask[i - 1]) neighbours += 1;
      if (x < w - 1 && mask[i + 1]) neighbours += 1;
      if (y > 0 && mask[i - w]) neighbours += 1;
      if (y < h - 1 && mask[i + w]) neighbours += 1;
      if (neighbours < 2) isolated += 1;
    }
  }

  // Connected regions, iterative so a big blob cannot blow the stack.
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  let biggest = 0;
  let pieces = 0;
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    let size = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const at = stack.pop() as number;
      size += 1;
      const x = at % w;
      const y = Math.floor(at / w);
      const around = [x > 0 ? at - 1 : -1, x < w - 1 ? at + 1 : -1, y > 0 ? at - w : -1, y < h - 1 ? at + w : -1];
      for (const next of around) {
        if (next < 0 || seen[next] || !mask[next]) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    if (size >= 24) pieces += 1;
    biggest = Math.max(biggest, size);
  }

  return {
    ink: ink / (w * h),
    isolated: isolated / ink,
    biggest: biggest / ink,
    pieces,
    offsetX: sumX / ink - w / 2,
    offsetY: sumY / ink - h / 2,
  };
}

/**
 * How far up the body the ink reaches, in pixels, between its 5th and 95th
 * percentile.
 *
 * Beside {@link measure} rather than inside it, because {@link measure} is a
 * verbatim copy of a working harness's and a field added to it would be a
 * divergence somebody has to notice. This one answers a question only this sheet
 * asks, and it is the question the whole rig exists for: **did the marks land on
 * the body, or all in one spot at its feet.**
 *
 * `shape: { kind: 'mesh' }` degrades to a bare point when there is no `surface`
 * hook -- which is what the game itself did for seventy-nine specs -- and the
 * failure is nearly invisible in a thumbnail, because a knot of marks at ankle
 * height is still a knot of marks. It is completely obvious as a number: the
 * dummy stands 70 world units tall, which at this camera is about 126 pixels, so
 * paint spread over a capsule spans most of that and paint born at one point
 * spans a mark's own length.
 *
 * Percentiles rather than the bounding box, because a single shed mark drifting
 * out of frame would otherwise report a perfectly stacked cling as well spread.
 */
function inkSpanY(png: PNG, base: PNG): number {
  const rows: number[] = [];
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (isInk(png, base, (y * png.width + x) * 4)) rows.push(y);
    }
  }
  if (rows.length < 8) return 0;
  const low = rows[Math.floor(rows.length * 0.05)] ?? 0;
  const high = rows[Math.floor(rows.length * 0.95)] ?? 0;
  return high - low;
}

/** The fraction of pixels where two tiles disagree by more than a hair. */
function difference(a: PNG, b: PNG): number {
  const total = Math.min(a.width * a.height, b.width * b.height);
  let differing = 0;
  for (let i = 0; i < total; i++) {
    const at = i * 4;
    const dr = Math.abs((a.data[at] ?? 0) - (b.data[at] ?? 0));
    const dg = Math.abs((a.data[at + 1] ?? 0) - (b.data[at + 1] ?? 0));
    const db = Math.abs((a.data[at + 2] ?? 0) - (b.data[at + 2] ?? 0));
    if (Math.max(dr, dg, db) > 20) differing += 1;
  }
  return differing / total;
}

// --- the run plan ------------------------------------------------------------

/**
 * One tile: an affliction played on the dummy and stepped to a tick, with its
 * beats fired on the way at the row's own cadence.
 *
 * The pulse is optional because two of the three sheets are about the **cling**
 * alone -- severity is a claim about how much paint is held on the body, and a
 * beat landing in one tile and not another would be the loudest thing in the
 * comparison and nothing to do with what is being compared.
 */
interface Shot {
  readonly label: string;
  readonly cling: string;
  readonly pulse?: string;
  /** Ticks between beats. Ignored when there is no pulse. */
  readonly interval: number;
  readonly ticks: number;
  readonly seed: number;
}

async function waitForServer(url: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`dev server never came up at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function sheet(rows: readonly Row[], columns: number): PNG {
  const out = new PNG({ width: VIEW_W * columns, height: VIEW_H * rows.length });
  rows.forEach((row, rowIndex) => {
    row.tiles.forEach((tile, column) => {
      const ox = column * VIEW_W;
      const oy = rowIndex * VIEW_H;
      for (let y = 0; y < VIEW_H; y++) {
        for (let x = 0; x < VIEW_W; x++) {
          const src = (Math.min(tile.png.height - 1, y) * tile.png.width + Math.min(tile.png.width - 1, x)) * 4;
          const dst = ((oy + y) * out.width + ox + x) * 4;
          out.data[dst] = tile.png.data[src] ?? 0;
          out.data[dst + 1] = tile.png.data[src + 1] ?? 0;
          out.data[dst + 2] = tile.png.data[src + 2] ?? 0;
          out.data[dst + 3] = 255;
        }
      }
      for (let x = 0; x < VIEW_W; x++) {
        const dst = (oy * out.width + ox + x) * 4;
        out.data[dst] = 12;
        out.data[dst + 1] = 16;
        out.data[dst + 2] = 20;
      }
      for (let y = 0; y < VIEW_H; y++) {
        const dst = ((oy + y) * out.width + ox) * 4;
        out.data[dst] = 12;
        out.data[dst + 1] = 16;
        out.data[dst + 2] = 20;
      }
    });
  });
  return out;
}

/**
 * The six ticks one affliction is photographed at.
 *
 * Built from the row's own numbers rather than typed out, because the seven
 * cadences differ by a factor of two and a fixed list would put every column of
 * Decay's row between beats and every column of Burn's on top of one. Six
 * moments, each of which is a different question:
 *
 *   1. the cling arriving -- is there anything at all a quarter-second in
 *   2. just before the first beat -- the cling alone, at steady state
 *   3. three ticks after beat 1 -- the beat at full size
 *   4. five ticks after beat 2 -- the beat coming apart, still legible
 *   5. three ticks after a late beat -- does it still read this deep in
 *   6. eighteen ticks after that one -- the gap, which for Shock is the point
 *
 * The late beat is capped at the fifth rather than the last, because Poison's
 * twentieth lands at tick 600 and every tick of that has to be *stepped*: the
 * schedule is played for real, so the picture is of a body that has actually
 * been poisoned for that long rather than one dropped into the middle of it.
 */
function lifeTicks(interval: number, pulses: number): readonly { tick: number; label: string }[] {
  const late = Math.min(pulses, 5);
  return [
    // Sixteen rather than four, and the reason is a real property of a rate
    // emitter rather than a taste in framing: `accrue` banks a fraction of a
    // particle per tick and spawns whole ones, so the slowest cling in the table
    // (Decay, five a second) has banked 0.33 of a mark at tick 4 and has drawn
    // exactly nothing. Six of the seven photographed an empty tile there, and
    // the "no live particles" check below -- which exists to catch an emitter
    // that is spawning nothing -- correctly reported all six. A check that fires
    // on a working effect is worse than no check, because it is read as evidence.
    // At sixteen ticks every row in the table has put its first mark on.
    { tick: 16, label: 't=16 on' },
    { tick: interval - 2, label: `t=${interval - 2} pre` },
    { tick: interval + 3, label: `t=${interval + 3} b1+3` },
    { tick: 2 * interval + 5, label: `t=${2 * interval + 5} b2+5` },
    { tick: late * interval + 3, label: `t=${late * interval + 3} b${late}+3` },
    { tick: late * interval + 18, label: `t=${late * interval + 18} gap` },
  ];
}

async function main(): Promise<void> {
  const shots = join(root, '.claude', 'screenshots');
  if (!existsSync(shots)) mkdirSync(shots, { recursive: true });

  // The binary rather than npx, and stdio ignored: killing the wrapper leaves
  // the server it spawned running, and the open pipes hold this script's own
  // event loop open long after it has finished.
  const server = spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });

  const problems: string[] = [];
  const lifeRows: Row[] = [];
  const severityRows: Row[] = [];
  const seedRows: Row[] = [];
  /** One empty frame, shared: the camera never moves. See {@link CAMERA}. */
  let base: PNG | null = null;

  try {
    await waitForServer(`http://localhost:${PORT}/brush-scene.html`);
    const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } });
    const logs: string[] = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));
    await page.goto(`http://localhost:${PORT}/brush-scene.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.brushScene !== undefined, undefined, { timeout: 30_000 });
    // The page's own loop must not advance the sim while a script is scrubbing
    // it -- this environment paints a real page at a few frames a second under
    // software GL, so a script that *waited* for a tick to arrive would be
    // measuring the renderer's load rather than the effect. Every tick below is
    // stepped explicitly against a stopped clock.
    await page.evaluate((camera) => {
      window.brushScene?.setPaused(true);
      // The controls are for a person driving this by hand; a contact sheet of
      // them is a contact sheet of a toolbar.
      window.brushScene?.setChrome(false);
      window.brushScene?.look(camera);
    }, CAMERA);

    /** Wait for the compositor to have actually drawn what was just rendered. */
    const painted = async (): Promise<void> => {
      // Two frames, not one. `page.screenshot` grabs the compositor's surface,
      // and taking the shot before the surface has the new render in it produces
      // byte-identical tiles and a report claiming every seed looked the same.
      // The page's own loop draws on every animation frame, so waiting two is
      // enough and does not advance the sim, which is paused.
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
    };

    // The empty frame, once. Everything measured downstream is a difference
    // against it.
    await page.evaluate(() => {
      const api = window.brushScene;
      if (!api) return;
      api.clear();
      api.draw();
    });
    await painted();
    base = PNG.sync.read(await page.locator('#brush-canvas').screenshot());

    const take = async (shot: Shot): Promise<Tile> => {
      const report = await page.evaluate((input) => {
        const api = window.brushScene;
        if (!api) return { particles: 0, drawCalls: 0, ticks: 0 };
        api.clear();
        api.affliction(input.cling, { seed: input.seed });
        // The beats, fired on the row's own cadence on the way to the sampled
        // tick, exactly as `AfflictionVfx` fires them off the replicated expiry.
        // Played forward rather than jumped to, because a cling is a *rate*
        // emitter and what a body looks like four beats in is a fact about the
        // four beats having happened.
        let at = 0;
        if (input.pulse !== undefined && input.interval > 0) {
          for (let k = 1; k * input.interval <= input.ticks; k++) {
            const beat = k * input.interval;
            if (beat > at) {
              api.step(beat - at);
              at = beat;
            }
            // The pulse index rides in the seed, as it does in the driver, so
            // successive beats on one body are different paintings rather than
            // the same one played over.
            api.affliction(input.pulse, { seed: input.seed + k * 7919 });
          }
        }
        if (input.ticks > at) api.step(input.ticks - at);
        return api.draw();
      }, shot);
      await painted();
      return {
        label: shot.label,
        png: PNG.sync.read(await page.locator('#brush-canvas').screenshot()),
        particles: report.particles,
        draws: report.drawCalls,
      };
    };

    const series = async (list: readonly Shot[]): Promise<Tile[]> => {
      const out: Tile[] = [];
      for (const shot of list) out.push(await take(shot));
      return out;
    };

    // --- one row per affliction, across its own life ------------------------
    for (const row of ALL_DOTS) {
      const art = AFFLICTION_ART[row.id];
      if (!art) {
        problems.push(`${row.id} has no row in AFFLICTION_ART`);
        continue;
      }
      lifeRows.push({
        title:
          `${row.id}  (beat every ${row.intervalTicks} ticks, ${row.pulses} pulses, ` +
          `life ${dotDurationTicks(row)} ticks)`,
        tiles: await series(
          lifeTicks(row.intervalTicks, row.pulses).map((moment) => ({
            label: moment.label,
            cling: art.cling,
            pulse: art.pulse,
            interval: row.intervalTicks,
            ticks: moment.tick,
            seed: SEEDS[0] ?? 1,
          })),
        ),
      });
    }

    // --- severity: the four that can get worse ------------------------------
    //
    // Light and heavy interleaved at three ticks rather than one row each, so
    // the pair being compared is *side by side* -- the question is whether one
    // is visibly more paint than the other, and two rows an inch apart on a
    // contact sheet is not a comparison anybody makes accurately. No beats at
    // all: a pulse is the brightest thing in the tile and severity is a claim
    // about the cling.
    for (const row of ALL_DOTS) {
      const art = AFFLICTION_ART[row.id];
      if (!art?.heavy) continue;
      const list: Shot[] = [];
      // Three ticks with the cling at steady state, and none of them early. At
      // twelve ticks the light version of every row has put on exactly one mark
      // and the heavy one three, which is a 3x ratio measured on a sample of
      // one -- the light tile's ink rounded to zero and the comparison reported
      // an infinite improvement. Severity is a claim about a coat of paint, so
      // it is measured once there is a coat.
      for (const tick of [STEADY, 90, 150]) {
        list.push({ label: `${row.id} t=${tick}`, cling: art.cling, interval: 0, ticks: tick, seed: SEEDS[0] ?? 1 });
        list.push({ label: `heavy t=${tick}`, cling: art.heavy, interval: 0, ticks: tick, seed: SEEDS[0] ?? 1 });
      }
      severityRows.push({ title: `${row.id}: light / heavy, at three ticks`, tiles: await series(list) });
    }

    // --- three seeds each ---------------------------------------------------
    for (const row of ALL_DOTS) {
      const art = AFFLICTION_ART[row.id];
      if (!art) continue;
      seedRows.push({
        title: `${row.id}: three seeds at t=${STEADY}`,
        tiles: await series(
          SEEDS.map((seed, i) => ({
            label: `#${i}`,
            cling: art.cling,
            interval: 0,
            ticks: STEADY,
            seed,
          })),
        ),
      });
    }

    const shaderProblems = logs.filter((line) => /error|could not compile|shader/i.test(line) && !/favicon|404/i.test(line));
    if (shaderProblems.length > 0) problems.push(...shaderProblems);
  } finally {
    await browser.close();
    server.kill();
  }

  if (!base) throw new Error('no baseline frame was captured');
  const empty = base;

  writeFileSync(join(shots, 'afflictions-vfx.png'), PNG.sync.write(sheet(lifeRows, 6)));
  writeFileSync(join(shots, 'afflictions-vfx-severity.png'), PNG.sync.write(sheet(severityRows, 6)));
  writeFileSync(join(shots, 'afflictions-vfx-seeds.png'), PNG.sync.write(sheet(seedRows, SEEDS.length)));
  console.log(`wrote ${join(shots, 'afflictions-vfx.png')}`);
  console.log(`wrote ${join(shots, 'afflictions-vfx-severity.png')}`);
  console.log(`wrote ${join(shots, 'afflictions-vfx-seeds.png')}`);

  // --- the numbers -----------------------------------------------------------
  //
  // A row of this table is how "crisp" is checked rather than asserted: a
  // dithered or stippled result is a high isolated fraction and a low largest-
  // mass share, and neither of those is a thing a person looking at a thumbnail
  // can be trusted to notice.

  interface Summary {
    readonly id: string;
    readonly marks: number;
    readonly ink: number;
    readonly isolated: number;
    readonly biggest: number;
    readonly pieces: number;
    /** How far up the body the paint reached, as a share of its height. */
    readonly span: number;
    readonly seedVariation: number;
  }
  const summaries: Summary[] = [];

  console.log('\n== the seven, over their own lives ==');
  const spans = new Map<string, number>();
  for (const row of lifeRows) {
    console.log(`\n  ${row.title}`);
    const id = row.title.split(' ')[0] ?? row.title;
    const stats = row.tiles.map((tile) => measure(tile.png, empty));
    const rowSpans = row.tiles.map((tile) => inkSpanY(tile.png, empty));
    row.tiles.forEach((tile, i) => {
      const s = stats[i];
      if (!s) return;
      console.log(
        `    ${tile.label.padEnd(14)} ${String(tile.particles).padStart(4)} marks  ${tile.draws} draws  ` +
          `ink ${(s.ink * 100).toFixed(2)}%  isolated ${(s.isolated * 100).toFixed(1)}%  ` +
          `biggest ${(s.biggest * 100).toFixed(0)}%  pieces ${s.pieces}  ` +
          `spans ${String(rowSpans[i] ?? 0).padStart(3)}px`,
      );
      // The failure this line exists for: an emitter that spawns nothing. It is
      // a dark tile somebody has to notice and a zero in a log nobody can miss.
      if (tile.particles <= 0) problems.push(`${id} had no live particles at ${tile.label}`);
    });
    const lit = stats.filter((s) => s.ink > 0.0015);
    const worstIsolated = lit.length > 0 ? Math.max(...lit.map((s) => s.isolated)) : 0;
    console.log(`    -> most stippled tile: ${(worstIsolated * 100).toFixed(1)}% isolated pixels`);
    // No stipple, anywhere. A dither fill is about half isolated pixels; a
    // filled silhouette is its boundary only. 20% is a wide margin either way.
    if (worstIsolated > 0.2) problems.push(`${row.title}: ${(worstIsolated * 100).toFixed(0)}% isolated pixels -- stipple`);

    // Did the paint go ON the body. The best tile rather than the mean, because
    // the first column is a mark or two by construction and a single mark spans
    // its own length whatever the hook did.
    const reach = Math.max(...rowSpans);
    spans.set(id, reach);
    console.log(`    -> paint reaches ${reach}px up a ${BODY_PX.toFixed(0)}px body (${((reach / BODY_PX) * 100).toFixed(0)}%)`);
    // A third of the body. Generous on purpose: what this is looking for is the
    // collapse -- every mark born at one point, which is what a missing
    // `surface` hook does and what the game shipped for seventy-nine specs.
    if (reach < BODY_PX / 3) {
      problems.push(`${id}: paint spans only ${reach}px of a ${BODY_PX.toFixed(0)}px body -- the surface sample may have collapsed to a point`);
    }
  }

  console.log('\n== severity: more paint, never brighter paint ==');
  for (const row of severityRows) {
    const stats = row.tiles.map((tile) => measure(tile.png, empty));
    console.log(`\n  ${row.title}`);
    for (let i = 0; i + 1 < row.tiles.length; i += 2) {
      const light = stats[i];
      const heavy = stats[i + 1];
      const lightTile = row.tiles[i];
      const heavyTile = row.tiles[i + 1];
      if (!light || !heavy || !lightTile || !heavyTile) continue;
      const ratio = light.ink > 0 ? heavy.ink / light.ink : 0;
      console.log(
        `    ${lightTile.label.padEnd(22)} ink ${(light.ink * 100).toFixed(2)}% (${String(lightTile.particles).padStart(4)} marks)` +
          `   heavy ink ${(heavy.ink * 100).toFixed(2)}% (${String(heavyTile.particles).padStart(4)} marks)   ${ratio.toFixed(2)}x`,
      );
      // The rule spec 197 states, as a measurement. A heavy cling that is not
      // measurably more paint than its light one has not implemented it -- and
      // the failure is invisible in a thumbnail, because "slightly more marks"
      // and "the same marks" look identical at 480 pixels.
      if (ratio < 1.15) {
        problems.push(`${lightTile.label}: heavy is only ${ratio.toFixed(2)}x the light one's ink -- severity does not read`);
      }
    }
  }

  // Variation, measured against the **ink** rather than against the tile.
  //
  // `preview-brush-vfx.ts` compares two seeds as a fraction of the whole frame
  // and asks for 0.4%, which is the right bar for a hit -- a hit fills a quarter
  // of its tile. An affliction covers about a fortieth of that: the paint on a
  // body is a quarter of a percent of this frame, so two completely different
  // paintings can only ever differ by about a quarter of a percent of it, and
  // the absolute bar would fail all seven while measuring nothing. Divided by
  // the ink the two tiles actually carry, the number says what it means -- how
  // much of the paint moved -- and can legitimately exceed 100%, which is what
  // two paintings sharing no pixels looks like.
  console.log('\n== variation between seeds ==');
  const variation = new Map<string, number>();
  for (const row of seedRows) {
    const stats = row.tiles.map((tile) => measure(tile.png, empty));
    const meanInk = stats.reduce((sum, s) => sum + s.ink, 0) / Math.max(1, stats.length);
    let worst = Number.POSITIVE_INFINITY;
    let best = 0;
    for (let a = 0; a < row.tiles.length; a++) {
      for (let b = a + 1; b < row.tiles.length; b++) {
        const left = row.tiles[a];
        const right = row.tiles[b];
        if (!left || !right) continue;
        const d = meanInk > 0 ? difference(left.png, right.png) / meanInk : 0;
        worst = Math.min(worst, d);
        best = Math.max(best, d);
      }
    }
    if (!Number.isFinite(worst)) worst = 0;
    const id = row.title.split(':')[0] ?? row.title;
    variation.set(id, worst);
    console.log(
      `  ${id.padEnd(12)} the closest two seeds move ${(worst * 100).toFixed(0)}% of the paint, ` +
        `the furthest ${(best * 100).toFixed(0)}%  (ink ${(meanInk * 100).toFixed(2)}% of the tile)`,
    );
    // A fifth of the paint. Below that two seeds are the same painting with a
    // couple of marks nudged, which is what a seed that is not reaching the
    // emitter's own generator state looks like.
    if (worst < 0.2) problems.push(`${id}: two seeds move only ${(worst * 100).toFixed(0)}% of the paint`);
  }

  // One line per affliction, over its whole life: the four numbers averaged
  // across the sampled ticks, which is the right summary for a *state* -- an
  // affliction is looked at for seconds, so what matters is what it is like
  // throughout rather than at the one instant somebody chose to photograph.
  for (const row of lifeRows) {
    const id = row.title.split(' ')[0] ?? row.title;
    const stats = row.tiles.map((tile) => measure(tile.png, empty)).filter((s) => s.ink > 0.0015);
    if (stats.length === 0) continue;
    const mean = (pick: (s: InkStats) => number): number => stats.reduce((sum, s) => sum + pick(s), 0) / stats.length;
    summaries.push({
      id,
      marks: Math.round(row.tiles.reduce((sum, tile) => sum + tile.particles, 0) / row.tiles.length),
      ink: mean((s) => s.ink),
      isolated: mean((s) => s.isolated),
      biggest: mean((s) => s.biggest),
      pieces: mean((s) => s.pieces),
      span: (spans.get(id) ?? 0) / BODY_PX,
      seedVariation: variation.get(id) ?? 0,
    });
  }

  console.log('\n== crisp, one line per affliction (means over the sampled ticks) ==');
  console.log(
    `  ${'affliction'.padEnd(12)} ${'marks'.padStart(6)} ${'ink%'.padStart(7)} ${'isolated%'.padStart(10)} ` +
      `${'biggest%'.padStart(9)} ${'pieces'.padStart(7)} ${'body%'.padStart(7)} ${'seedvar%'.padStart(9)}`,
  );
  for (const s of summaries) {
    console.log(
      `  ${s.id.padEnd(12)} ${String(s.marks).padStart(6)} ${(s.ink * 100).toFixed(2).padStart(7)} ` +
        `${(s.isolated * 100).toFixed(1).padStart(10)} ${(s.biggest * 100).toFixed(0).padStart(9)} ` +
        `${s.pieces.toFixed(1).padStart(7)} ${(s.span * 100).toFixed(0).padStart(7)} ` +
        `${(s.seedVariation * 100).toFixed(0).padStart(9)}`,
    );
  }

  if (problems.length > 0) {
    console.error('\nproblems:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('\nall checks passed');
  }
}

await main();
