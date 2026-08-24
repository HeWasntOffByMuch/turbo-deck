// Dev-only: judge the painted effects, in a 3D scene, at full resolution
// (spec 159). `npx tsx scripts/preview-brush-vfx.ts`
//
// Drives `src/render/brush-scene.html` -- a lit low-poly scene with a dummy in
// it, MSAA on, no retro pass and no palette -- and writes two sheets:
//
//   .claude/screenshots/brush-blood.png       the hit: lifecycle, bearings, seeds
//   .claude/screenshots/brush-explosion.png   the blast: lifecycle, bearings, seeds
//   .claude/screenshots/brush-shot.png        the ember shot in flight, and where
//                                             it lands (spec 218)
//
// ## Why the shot is on this sheet rather than one of its own
//
// Because it is judged on the same two questions. `shot_ember` is a state played
// on a moving body -- the affliction's shape, which is what argued
// `preview-afflictions-vfx.ts` into a harness of its own -- but what a fireball
// is judged on is exactly what a hit and a blast are judged on: whether the
// paint is silhouettes or stipple, and whether two seeds are two paintings by
// one artist. The one thing it needs that neither of the others does is
// *motion*, and that is one call into the rig rather than a second definition of
// crisp.
//
// ## Why this replaced the old harness
//
// The first version of this drove `vfx-probe.html`, which renders into a 240x150
// buffer and lets CSS blow it up four times with `image-rendering: pixelated`.
// That page exists to prove particles are *inside* the low-resolution buffer, so
// it reports stair-stepped edges and pixel clusters about anything at all --
// including the ground. Judging brushwork through it produced a review that was
// mostly about the harness. This one renders the same effects the way a person
// looking at the shapes needs to see them.
//
// ## What it measures
//
// Four claims a picture makes badly and a number makes well:
//
//   - **no stipple.** The fraction of ink pixels that are *isolated* -- a lit
//     pixel with fewer than two lit neighbours. A dithered fill is roughly half
//     isolated pixels; a filled silhouette is a few percent, all boundary.
//   - **mass is in a few big pieces.** The largest connected ink region as a
//     share of all ink. A cloud of fragments scores low; one dominant stroke
//     with company scores high.
//   - **asymmetry.** For the explosion, how far the ink's centre of mass sits
//     from the blast origin, and how uneven the ink is around it. A radial star
//     is centred and even.
//   - **variation, and family.** How much two seeds differ, and that they all
//     differ by a similar amount -- different paintings by one artist.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4327;
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const VIEW_W = 480;
const VIEW_H = 360;
const COLUMNS = 6;

/** Six seeds that are not consecutive integers, for the reason `rng.ts` gives. */
const SEEDS = [20260810, 917331, 4242, 60817, 1180339, 271828];

interface Tile {
  readonly label: string;
  readonly png: PNG;
  /** The identical frame with nothing playing, so the ink can be isolated. */
  readonly base: PNG;
  readonly particles: number;
  readonly draws: number;
}

interface Row {
  readonly title: string;
  readonly check?: 'seeds' | 'bearings';
  readonly tiles: Tile[];
}

/**
 * Whether a pixel is the effect rather than the scene.
 *
 * Against a **baseline of the same frame with nothing playing**, rather than
 * against a colour rule. The first version tested "is this pixel warm", which
 * counted the grass, the trunks and the dummy, and could not see dark smoke at
 * all -- so every measurement was of the scene plus a bit of effect. A
 * difference against the identical camera is exact, catches the near-black
 * smoke, and needs no assumptions about the palette.
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

function sheet(rows: readonly Row[]): PNG {
  const out = new PNG({ width: VIEW_W * COLUMNS, height: VIEW_H * rows.length });
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
  const bloodRows: Row[] = [];
  const boomRows: Row[] = [];
  const shotRows: Row[] = [];

  try {
    await waitForServer(`http://localhost:${PORT}/brush-scene.html`);
    const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } });
    const logs: string[] = [];
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));
    await page.goto(`http://localhost:${PORT}/brush-scene.html`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.brushScene !== undefined, undefined, { timeout: 30_000 });
    // The page's own loop must not advance the sim while a script is scrubbing
    // it: a screenshot taken between a `step` and a paint would be a different
    // tick from the one that was asked for.
    await page.evaluate(() => {
      window.brushScene?.setPaused(true);
      // The controls are for a person driving this by hand; a contact sheet of
      // them is a contact sheet of a toolbar.
      window.brushScene?.setChrome(false);
    });

    interface Shot {
      readonly label: string;
      readonly kind: 'blood' | 'explosion' | 'shot';
      readonly seed: number;
      readonly ticks: number;
      /**
       * `shot` only: which effect to fly.
       *
       * An id rather than a look, so this harness owns no copy of `SHOT_ART`
       * and can be pointed at a second shot's paint the day there is one -- the
       * same argument the rig's own `affliction(id, ...)` makes about
       * `AFFLICTION_ART`.
       */
      readonly effectId?: string;
      /** `shot` only: how far back the flight begins, so it fits the frame. */
      readonly launch?: number;
      /** `shot` only: world units a second, along the flight. */
      readonly speed?: number;
      readonly from?: number;
      readonly radius?: number;
      readonly intensity?: number;
      readonly dissipates?: boolean;
      readonly smoulder?: boolean;
      readonly azimuth?: number;
      readonly elevation?: number;
      readonly halfHeight?: number;
    }

    /** Wait for the compositor to have actually drawn what was just rendered. */
    const painted = async (): Promise<void> => {
      // Two frames, not one. `page.screenshot` grabs the compositor's surface,
      // and the first version of this took the shot before the surface had the
      // new render in it -- which produced forty-eight byte-identical tiles and
      // a report claiming every seed looked the same. The page's own loop draws
      // on every animation frame, so waiting two is enough and does not advance
      // the sim, which is paused.
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
    };

    /** Shots run one at a time: they share one page and one paused clock. */
    const series = async (shots: readonly Shot[]): Promise<Tile[]> => {
      const out: Tile[] = [];
      for (const shot of shots) out.push(await take(shot));
      return out;
    };

    const take = async (shot: Shot): Promise<Tile> => {
      // The empty frame first, from exactly this camera. Everything measured
      // downstream is a difference against it.
      await page.evaluate((input) => {
        const api = window.brushScene;
        if (!api) return;
        api.clear();
        api.look({
          ...(input.azimuth === undefined ? {} : { azimuth: input.azimuth }),
          ...(input.elevation === undefined ? {} : { elevation: input.elevation }),
          halfHeight: input.halfHeight ?? 150,
        });
        api.draw();
      }, shot);
      await painted();
      const baseBuffer = await page.locator('#brush-canvas').screenshot();

      const report = await page.evaluate((input) => {
        const api = window.brushScene;
        if (!api) return { particles: 0, drawCalls: 0, ticks: 0 };
        api.clear();
        if (input.kind === 'blood') {
          api.blood({
            seed: input.seed,
            ...(input.from === undefined ? {} : { from: input.from }),
            ...(input.intensity === undefined ? {} : { intensity: input.intensity }),
            ...(input.dissipates === undefined ? {} : { dissipates: input.dissipates }),
          });
        } else if (input.kind === 'shot') {
          api.shot(input.effectId ?? 'shot_ember', {
            seed: input.seed,
            ...(input.radius === undefined ? {} : { radius: input.radius }),
            ...(input.launch === undefined ? {} : { from: input.launch }),
            ...(input.speed === undefined ? {} : { speed: input.speed }),
          });
        } else {
          api.explosion({
            seed: input.seed,
            ...(input.radius === undefined ? {} : { radius: input.radius }),
            ...(input.intensity === undefined ? {} : { intensity: input.intensity }),
            ...(input.smoulder === undefined ? {} : { smoulder: input.smoulder }),
          });
        }
        return api.step(input.ticks);
      }, shot);
      await painted();
      const buffer = await page.locator('#brush-canvas').screenshot();
      return {
        label: shot.label,
        png: PNG.sync.read(buffer),
        base: PNG.sync.read(baseBuffer),
        particles: report.particles,
        draws: report.drawCalls,
      };
    };

    // --- blood ------------------------------------------------------------
    const bloodTicks = [2, 4, 7, 12, 18, 26];
    bloodRows.push({
      title: 'the hit over its own life (ticks; the whole thing is 34)',
      tiles: await series(
        bloodTicks.map((tick) => ({ label: `t=${tick}`, kind: 'blood' as const, seed: SEEDS[0] ?? 1, ticks: tick, from: 0.6, halfHeight: 90 })),
      ),
    });
    bloodRows.push({
      title: 'the same hit from six camera bearings',
      check: 'bearings',
      tiles: await series(
        Array.from({ length: COLUMNS }, (_, i) => ({
          label: `cam ${Math.round((i / COLUMNS) * 360)}deg`,
          kind: 'blood' as const,
          seed: SEEDS[0] ?? 1,
          ticks: 7,
          from: 0.6,
          azimuth: (i / COLUMNS) * Math.PI * 2,
          halfHeight: 90,
        })),
      ),
    });
    bloodRows.push({
      title: 'six attack bearings, the paint following each',
      tiles: await series(
        Array.from({ length: COLUMNS }, (_, i) => ({
          label: `hit ${Math.round((i / COLUMNS) * 360)}deg`,
          kind: 'blood' as const,
          seed: SEEDS[i % SEEDS.length] ?? 1,
          ticks: 7,
          from: (i / COLUMNS) * Math.PI * 2,
          halfHeight: 90,
        })),
      ),
    });
    // The variant, over its own life. Its whole claim is about what happens at
    // the END -- nothing lands, and it thins away in the air -- so it is
    // photographed further into its life than the standard hit, where by tick 26
    // there is nothing left to see.
    bloodRows.push({
      title: 'the mist variant over its life: nothing falls, it thins away',
      tiles: await series(
        [6, 16, 24, 31, 38, 46].map((tick) => ({
          label: `mist t=${tick}`,
          kind: 'blood' as const,
          seed: SEEDS[0] ?? 1,
          ticks: tick,
          from: 0.6,
          dissipates: true,
          halfHeight: 110,
        })),
      ),
    });

    bloodRows.push({
      title: 'six seeds, one bearing',
      check: 'seeds',
      tiles: await series(
        SEEDS.map((seed, i) => ({ label: `#${i}`, kind: 'blood' as const, seed, ticks: 7, from: 0.6, halfHeight: 90 })),
      ),
    });

    // --- explosion --------------------------------------------------------
    const boomTicks = [3, 8, 14, 24, 40, 62];
    boomRows.push({
      title: 'the blast over its own life (ticks; the whole thing is 86)',
      tiles: await series(
        boomTicks.map((tick) => ({ label: `t=${tick}`, kind: 'explosion' as const, seed: SEEDS[0] ?? 1, ticks: tick, radius: 70, halfHeight: 170 })),
      ),
    });
    boomRows.push({
      title: 'the same blast from six camera bearings',
      check: 'bearings',
      tiles: await series(
        Array.from({ length: COLUMNS }, (_, i) => ({
          label: `cam ${Math.round((i / COLUMNS) * 360)}deg`,
          kind: 'explosion' as const,
          seed: SEEDS[0] ?? 1,
          ticks: 14,
          radius: 70,
          azimuth: (i / COLUMNS) * Math.PI * 2,
          halfHeight: 170,
        })),
      ),
    });
    boomRows.push({
      title: 'six seeds, one camera',
      check: 'seeds',
      tiles: await series(
        SEEDS.map((seed, i) => ({ label: `#${i}`, kind: 'explosion' as const, seed, ticks: 14, radius: 70, halfHeight: 170 })),
      ),
    });
    // The smoulder, sampled across a window twice as long as the standard
    // blast's, because that is the difference: the fire is out by tick 46 and
    // the mass is still going at 110.
    boomRows.push({
      title: 'the smoulder variant: smoke at once, and long after the fire',
      tiles: await series(
        [4, 10, 22, 52, 84, 106].map((tick) => ({
          label: `smoulder t=${tick}`,
          kind: 'explosion' as const,
          seed: SEEDS[0] ?? 1,
          ticks: tick,
          radius: 70,
          smoulder: true,
          halfHeight: 190,
        })),
      ),
    });

    boomRows.push({
      title: 'three sizes, and the smoke that outlives them',
      tiles: await series([
        { label: 'r=34', kind: 'explosion', seed: SEEDS[1] ?? 1, ticks: 12, radius: 34, halfHeight: 110 },
        { label: 'r=70', kind: 'explosion', seed: SEEDS[2] ?? 1, ticks: 14, radius: 70, halfHeight: 170 },
        { label: 'r=110', kind: 'explosion', seed: SEEDS[3] ?? 1, ticks: 16, radius: 110, halfHeight: 240 },
        { label: 'smoke t=34', kind: 'explosion', seed: SEEDS[2] ?? 1, ticks: 34, radius: 70, halfHeight: 170 },
        { label: 'smoke t=52', kind: 'explosion', seed: SEEDS[2] ?? 1, ticks: 52, radius: 70, halfHeight: 170 },
        { label: 'smoke t=72', kind: 'explosion', seed: SEEDS[2] ?? 1, ticks: 72, radius: 70, halfHeight: 170 },
      ]),
    });

    // --- the ember shot (spec 218) ----------------------------------------
    //
    // The ball's own radius is 9 and it travels 273 units a second, so a tick is
    // half a radius: by tick 20 it has crossed ten shot-lengths and everything
    // behind it is the trail. That is why the samples run *early* -- the fire is
    // renewed continuously and looks the same at tick 40 as at tick 12, and the
    // only thing that changes across a flight is how much smoke is behind it.
    //
    // The camera is much tighter than either sheet above, and for the reason
    // `preview-afflictions-vfx.ts` gives about its own: a blast is a hundred
    // units across and needs room, and this is an 18-unit ball with sixty units
    // of smoke behind it. Framed like a blast it is half a percent of the tile,
    // which is *less subject than the seeds check needs difference*, so every
    // measurement below would be a measurement of grass.
    const FLIGHT_FRAME = 62;
    const LAUNCH = 74;
    const flightTicks = [2, 5, 9, 13, 18, 24];
    shotRows.push({
      title: 'the shot in flight (ticks; the trail is what grows, not the ball)',
      tiles: await series(
        flightTicks.map((tick) => ({
          label: `t=${tick}`,
          kind: 'shot' as const,
          seed: SEEDS[0] ?? 1,
          ticks: tick,
          radius: 9,
          launch: LAUNCH,
          halfHeight: FLIGHT_FRAME,
        })),
      ),
    });
    // No `bearings` check on this row, and that is a statement rather than an
    // omission: that check asks whether the ink survives being looked at from
    // anywhere, which is the right question about a blast and the wrong one
    // about a thing with a *direction*. Seen down the line of flight a trail is
    // behind the ball and hidden by it, and it should be -- an arrow's streak
    // does the same. What the row is for is the other half: that the ball reads
    // from every seat, including the one where the trail does not.
    shotRows.push({
      title: 'the same flight from six camera bearings (end-on, the trail hides)',
      tiles: await series(
        Array.from({ length: COLUMNS }, (_, i) => ({
          label: `cam ${Math.round((i / COLUMNS) * 360)}deg`,
          kind: 'shot' as const,
          seed: SEEDS[0] ?? 1,
          ticks: 16,
          radius: 9,
          launch: LAUNCH,
          azimuth: (i / COLUMNS) * Math.PI * 2,
          halfHeight: FLIGHT_FRAME,
        })),
      ),
    });
    shotRows.push({
      title: 'six seeds, one flight',
      check: 'seeds',
      tiles: await series(
        SEEDS.map((seed, i) => ({
          label: `#${i}`,
          kind: 'shot' as const,
          seed,
          ticks: 16,
          radius: 9,
          launch: LAUNCH,
          halfHeight: FLIGHT_FRAME,
        })),
      ),
    });
    // Standing still against travelling, which is the one comparison that can
    // fail while every tile above looks right: at speed 0 the trail is laid on
    // top of the ball and the whole thing is a bonfire. The two columns are the
    // same effect, the same seed and the same tick.
    shotRows.push({
      title: 'a fireball is not a bonfire: the same effect at rest and at speed',
      tiles: await series([
        { label: 'v=0 t=9', kind: 'shot', seed: SEEDS[1] ?? 1, ticks: 9, radius: 9, launch: 0, speed: 0, halfHeight: FLIGHT_FRAME },
        { label: 'v=0 t=18', kind: 'shot', seed: SEEDS[1] ?? 1, ticks: 18, radius: 9, launch: 0, speed: 0, halfHeight: FLIGHT_FRAME },
        { label: 'v=273 t=9', kind: 'shot', seed: SEEDS[1] ?? 1, ticks: 9, radius: 9, launch: LAUNCH, halfHeight: FLIGHT_FRAME },
        { label: 'v=273 t=18', kind: 'shot', seed: SEEDS[1] ?? 1, ticks: 18, radius: 9, launch: LAUNCH, halfHeight: FLIGHT_FRAME },
        // ...and the landing it draws, which has no smoke in it at all.
        //
        // By **id**, and through the same standing-still path, rather than
        // through the rig's `explosion()` helper: that one goes via
        // `brushExplosionRequest`, which picks a preset by size and would hand
        // back `explosion_brush_small` -- a different effect, with smoke in it,
        // photographed under this one's label. `scale: 1` because since spec 218
        // `scene.addEffect` plays an authored effect at its authored size, and
        // this sheet has to show what the game shows.
        {
          label: 'burst t=6',
          kind: 'shot',
          effectId: 'ranged.ember.impact',
          seed: SEEDS[4] ?? 1,
          ticks: 6,
          radius: 1,
          launch: 0,
          speed: 0,
          halfHeight: 70,
        },
        {
          label: 'burst t=16',
          kind: 'shot',
          effectId: 'ranged.ember.impact',
          seed: SEEDS[4] ?? 1,
          ticks: 16,
          radius: 1,
          launch: 0,
          speed: 0,
          halfHeight: 70,
        },
      ]),
    });

    const shaderProblems = logs.filter((line) => /error|could not compile|shader/i.test(line) && !/favicon|404/i.test(line));
    if (shaderProblems.length > 0) problems.push(...shaderProblems);
  } finally {
    await browser.close();
    server.kill();
  }

  writeFileSync(join(shots, 'brush-blood.png'), PNG.sync.write(sheet(bloodRows)));
  writeFileSync(join(shots, 'brush-explosion.png'), PNG.sync.write(sheet(boomRows)));
  writeFileSync(join(shots, 'brush-shot.png'), PNG.sync.write(sheet(shotRows)));
  console.log(`wrote ${join(shots, 'brush-blood.png')}`);
  console.log(`wrote ${join(shots, 'brush-explosion.png')}`);
  console.log(`wrote ${join(shots, 'brush-shot.png')}`);

  const report = (rows: readonly Row[], what: string): void => {
    console.log(`\n== ${what} ==`);
    for (const row of rows) {
      console.log(`\n  ${row.title}`);
      const stats = row.tiles.map((tile) => measure(tile.png, tile.base));
      row.tiles.forEach((tile, i) => {
        const s = stats[i];
        if (!s) return;
        console.log(
          `    ${tile.label.padEnd(13)} ${String(tile.particles).padStart(3)} marks  ${tile.draws} draws  ` +
            `ink ${(s.ink * 100).toFixed(2)}%  isolated ${(s.isolated * 100).toFixed(1)}%  ` +
            `biggest ${(s.biggest * 100).toFixed(0)}%  pieces ${s.pieces}`,
        );
      });

      // No stipple, anywhere. A dither fill is about half isolated pixels; a
      // filled silhouette is its boundary only. 20% is a wide margin either way.
      const lit = stats.filter((s) => s.ink > 0.0015);
      const worstIsolated = lit.length > 0 ? Math.max(...lit.map((s) => s.isolated)) : 0;
      console.log(`    -> most stippled tile: ${(worstIsolated * 100).toFixed(1)}% isolated pixels`);
      if (worstIsolated > 0.2) problems.push(`${row.title}: ${(worstIsolated * 100).toFixed(0)}% isolated pixels -- stipple`);

      if (row.check === 'bearings') {
        const inks = stats.map((s) => s.ink);
        const ratio = Math.max(...inks) > 0 ? Math.min(...inks) / Math.max(...inks) : 0;
        console.log(`    -> thinnest bearing keeps ${(ratio * 100).toFixed(0)}% of the fattest one's ink`);
        if (ratio < 0.4) problems.push(`${row.title}: ink varies ${(ratio * 100).toFixed(0)}% across bearings`);
      }

      if (row.check === 'seeds') {
        let worst = 1;
        let best = 0;
        for (let a = 0; a < row.tiles.length; a++) {
          for (let b = a + 1; b < row.tiles.length; b++) {
            const left = row.tiles[a];
            const right = row.tiles[b];
            if (!left || !right) continue;
            const d = difference(left.png, right.png);
            worst = Math.min(worst, d);
            best = Math.max(best, d);
          }
        }
        console.log(`    -> seeds differ between ${(worst * 100).toFixed(2)}% and ${(best * 100).toFixed(2)}% of the tile`);
        if (worst < 0.004) problems.push(`${row.title}: two seeds are near-identical`);
        // The other half of "variation": every pair differing by a similar
        // amount is what "the same artist" means. One pair ten times more
        // different than another is a second art style sneaking in.
        if (best > worst * 12) problems.push(`${row.title}: seed variation is uneven (${(best / worst).toFixed(1)}x)`);
      }
    }
  };

  report(bloodRows, 'blood');
  report(boomRows, 'explosion');
  report(shotRows, 'shot');

  // The blast must not be a radial star. A star is centred on its own origin and
  // even all round; a composition of lobes is not.
  const boomBearings = boomRows.find((row) => row.check === 'bearings');
  if (boomBearings) {
    const stats = boomBearings.tiles.map((tile) => measure(tile.png, tile.base));
    const offsets = stats.map((s) => Math.hypot(s.offsetX, s.offsetY));
    const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
    console.log(`\n  explosion ink sits ${mean.toFixed(1)}px off centre on average (a radial star sits on it)`);
    if (mean < 6) problems.push(`the explosion is centred on its own origin (${mean.toFixed(1)}px) -- it may be a radial star`);
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
