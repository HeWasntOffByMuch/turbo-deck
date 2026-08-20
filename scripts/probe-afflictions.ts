/**
 * The afflictions, painted onto a real body in the real Play tab (spec 197).
 *
 *   npx tsx scripts/probe-afflictions.ts
 *
 * Everything spec 197 decides is asserted in Node already: `brushAffliction`'s
 * invariants (`vfx/brush.test.ts`), the derived beat against the sim's own
 * resolver, the severity crossover, `AuraTracker` starting and stopping a cling
 * once across an apply/refresh/expire cycle, and the whole thing driven twice
 * through `presentation-only.test.ts` -- once with the driver ticking and once
 * without -- to prove it changes nothing about the authoritative state. None of
 * that can say whether any of it is **connected to anything**, which is exactly
 * the failure this repo has shipped before: spec 121's whole aura system has a
 * decision function, a tracker, eight authored effects and no caller to this
 * day, because nothing ever called `aurasFor` from `scene.ts`. Spec 197's own
 * problem statement names the same trap three more times over -- an
 * `EmitterShape` whose `mesh` kind had never once resolved to anything but a
 * point, an `attach` hook `scene.ts` never wired, and a driver class with a
 * constructor and no instance anywhere in the tree. A green suite sits beside
 * every one of those just as happily as it would sit beside this one being
 * unplugged in the same way.
 *
 * So this drives the real thing: a real server in a real tab (`?seed=`, no
 * `?server`, which is `plan.mode !== 'remote'` and the one branch that
 * constructs an in-tab `GameServer`), the real `?afflict=` developer path
 * (`affliction-vfx.ts`'s `afflictionsFromQuery`, read by `view.ts` and turned
 * into `server.triggerEvent('affliction', ...)` calls on the player's own
 * position every `FORCED_AFFLICTION_EVERY_TICKS` ticks), the real
 * `AfflictionVfx` driver, the real particle system, and a real screenshot.
 *
 * ## What "measure" means here, and why a screenshot alone would not do
 *
 * The world is alive even when nobody is doing anything to it: the trees sway,
 * the water moves, a body breathes. Comparing a control frame against an
 * affliction frame pixel-for-pixel would report every one of those as "this is
 * the affliction" -- and worse, the control and each affliction are FOUR
 * separate page loads, so their wind phases are not even the same session's
 * phase offset by a few frames, they are uncorrelated: two swaying canopies
 * photographed at two unrelated moments in real time. A dark tile and a
 * working effect would be exactly as hard to tell apart as a bright one and a
 * broken one.
 *
 * `scripts/preview-paint.ts` solved the adjacent problem (does a brush stroke
 * reach the ground) with a trick worth stealing whole: capture each state
 * *twice*, a beat apart, and only trust a pixel that agreed both times. That
 * throws out everything that moves on its own -- which is most of what a
 * sweeping tree canopy is -- and keeps everything that does not, which is a
 * body standing still wearing paint. This probe does that once per page load
 * (control and each of the three afflictions independently), and then compares
 * each affliction's stable frame against the control's stable frame, counting
 * only pixels both sides agree are reliable.
 *
 * That still leaves scattered noise: a leaf that happens to hold its own pose
 * for one 700ms window and a genuinely different pose in another session's
 * window reads as "changed" and "stable" at once. What tells that apart from
 * paint is shape, not colour -- paint on a body is **one blob**, near the
 * middle of the frame where the camera keeps the player; scattered leaf noise
 * is many small, disconnected specks spread over wherever the trees are. So
 * the number this probe actually judges an affliction on is the **largest
 * 8-connected mass** of changed pixels, the same measurement
 * `scripts/preview-paint.ts` uses to find a stroke's own footprint against the
 * same kind of background noise.
 *
 * One more thing turned out to belong to "the world" in exactly the sense
 * that trips this up, and it took a first, wrong run to find: the **floating
 * damage numbers**. They hover over the body in the same world space the
 * paint clings to, so nothing about "is this inside the HUD" tells them
 * apart from a cling -- and they turned out to be the *larger*, more
 * solidly-connected mass, because five stacks of Poison and a climbing
 * Frostbite ramp both throw a lot of them. The first cut of this probe
 * measured an identical 248x123 box at an identical position with
 * near-identical mean colour for Poison and Frostbite both, which was not two
 * afflictions coincidentally painting the same thing -- it was this probe
 * finding the same stack of pale digits above the body in both runs. So the
 * measured window is anchored on the player's own health-bar position
 * (`selfBarPoint`, the same `data-entity`/`data-self` attributes
 * `preview-world.ts` reads) rather than on the frame's geometric centre, sized
 * to reach the body and the ground under it while stopping short of where a
 * number stack rises to. See `bodyCrop` for the actual margins.
 *
 * ## What only a browser can answer
 *
 * Every one of `afflictionsOn`, `afflictionIsHeavy`, `pulsesLanded` and the
 * driver's own diff logic is exercised in Node against a recording `VfxPlayer`
 * -- a fake that records `play`/`stop` calls. What that cannot say is whether
 * `scene.ts` actually constructs an `AfflictionVfx`, actually calls `.step()`
 * once a frame for a body carrying a status, actually wires the `surface` hook
 * so `{ kind: 'mesh' }` resolves to a point on the body rather than degrading
 * to a bare point at the origin, and whether the compiled particle system
 * actually turns a `play()` call into visible pixels once the game's own
 * palette, retro pass and camera are all doing their own work on top of it.
 * Nothing about that chain can be asserted without a GPU and a DOM.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { glyphRects } from '../src/render/iso3d/world/pixel-font.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');

// 4340 rather than anything already in use: every script under `scripts/`
// that spawns a server names its own port, and a collision would mean this
// probe measuring somebody else's server instead of its own.
const PORT = 4340;
const VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * Pinned rather than `Date.now()`'s fallback (`iso3d/seed.ts`). Every run of
 * this probe loads the same world at the same spawn point, which is what
 * makes "the largest mass grew" a statement about a code change rather than
 * about which monster happened to wander into frame this time.
 */
const SEED = 20260806;

/**
 * Three of the seven, not all seven, per the brief: enough to prove the
 * wiring end to end and to show the range (Burn's warm cling against
 * Frostbite's pale one), and every page load here is genuinely expensive --
 * this environment paints at about 3fps under software GL, a load streams
 * roughly 169 chunks before `[data-world-ready="true"]` fires, and the sim
 * then has to run long enough for a cling to establish and a pulse or two to
 * land, twice over a beat apart for the stability filter. Shock is the one
 * left out rather than any other: its own tell -- an arc jumping to the
 * nearest hostile neighbour -- is Burn's `spreadRadius` mechanism restated on
 * a different row (see `sim/damage-over-time.ts`), so of the three not
 * covered here it is the one whose *wiring* claim is least distinct from one
 * already being exercised. The per-affliction art itself (is Poison green
 * against Corrosion's acid, is Shock's cling actually absent since it does
 * not stack) is `preview-afflictions-vfx.ts`'s job, which already covers all
 * seven against a controlled rig; this script exists to answer a narrower
 * question -- is any of it connected to the real game -- and three answers
 * that as completely as seven would.
 */
const AFFLICTIONS = ['burn', 'poison', 'frostbite'] as const;

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
/** Software WebGL: there is no GPU in CI or in an agent's container. */
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/**
 * How many sim ticks to let run past `[data-world-ready="true"]` before the
 * first of a state's two measurement frames.
 *
 * The re-application cadence lives in `view.ts` as `FORCED_AFFLICTION_EVERY_TICKS`
 * and this probe deliberately does not import it or hard-code its value: the
 * one fact this wait actually depends on is that the *first* application lands
 * on the sim's own first tick (`afflictAgainAtTick` starts at 0), which is
 * true regardless of what the re-application interval is tuned to later. 300
 * ticks is five seconds of sim time -- comfortably past every one of the three
 * afflictions' own pulse interval (the slowest here, Shock, beats every 45
 * ticks), so by the time this fires there have been several pulses and the
 * continuous cling has had time to actually accumulate marks rather than
 * being caught a frame after it started.
 */
const SETTLE_TICK = 300;

/**
 * How different two pixels have to be, summed as squared distance across RGB,
 * to count as "not the same" -- used for two different questions with the
 * same honest threshold. About 24 per channel, the value
 * `scripts/preview-paint.ts` settled on for the same reason: comparing raw
 * colour against a fixed palette loses real change to grading and dithering,
 * so what is measured throughout is *difference*, which has nothing to be
 * wrong about.
 */
const CHANGE_THRESHOLD = 24 * 24 * 3;

/**
 * The floor a largest-connected-mass has to clear to count as paint rather
 * than background noise that happened to hold still in both windows.
 *
 * Not derived from anything in the sim -- there is no authored "how many
 * pixels should this affliction cover at this camera distance" number to
 * check against, so this is a measured floor rather than a designed one.
 * Chosen low enough that a body-sized blob of paint clears it with room to
 * spare and high enough that a handful of coincidentally-agreeing leaves does
 * not. If this probe starts failing because an affliction now paints less
 * (a deliberate toning-down), lower it with a comment saying why; if it stops
 * failing because leaves started passing, raise it instead.
 */
const MIN_MASS_PIXELS = 120;

/** The floor on total changed pixels, alongside the mass floor above. */
const MIN_CHANGED_PIXELS = 300;

type Rgb = readonly [number, number, number];

function distance2(a: Rgb, b: Rgb): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/** A decoded screenshot: pixels, and nothing said yet about which to trust. */
interface Frame {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

/** One state's measurement frame, plus which pixels are trustworthy in it. */
interface Shot extends Frame {
  /**
   * 1 where two captures {@link STILL_GAP_MS} apart agreed within
   * {@link CHANGE_THRESHOLD}; 0 where something in the live world -- a
   * swaying tree, the water, the affliction's own particles mid-flight --
   * moved enough to make this pixel untrustworthy for a cross-session
   * comparison.
   */
  readonly still: Uint8Array;
}

const STILL_GAP_MS = 650;

function pixelAt(buffer: Buffer, index: number): Rgb {
  const p = index * 4;
  return [buffer[p] ?? 0, buffer[p + 1] ?? 0, buffer[p + 2] ?? 0];
}

/**
 * Two screenshots a beat apart, reduced to one frame and a per-pixel
 * reliability mask.
 *
 * The second frame is what gets kept and compared against the other states --
 * chosen over the first for no particular reason except that it is the later
 * of the two, so it is the frame that had the most time to let a cling settle
 * in. The mask is built the same way `scripts/preview-paint.ts`'s `grab` does:
 * two states of the *same* live page, so anything that is still moving after
 * {@link STILL_GAP_MS} is flagged rather than trusted.
 *
 * Used for the **control** state only. Control carries no affliction, so
 * "unstable" there really does mean "background noise" -- a swaying tree, the
 * water -- with nothing else it could mean.
 */
async function settledShot(page: Page): Promise<Shot> {
  const first = PNG.sync.read(await page.screenshot());
  await new Promise((resolve) => setTimeout(resolve, STILL_GAP_MS));
  const second = PNG.sync.read(await page.screenshot());
  const n = second.width * second.height;
  const still = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    still[i] = distance2(pixelAt(first.data, i), pixelAt(second.data, i)) < CHANGE_THRESHOLD ? 1 : 0;
  }
  return { width: second.width, height: second.height, data: second.data, still };
}

/** How many samples an affliction is captured over, and how far apart. */
const BURST_FRAMES = 5;
const BURST_GAP_MS = 200;

/**
 * Several screenshots of a *carrying* state, spread over about a second.
 *
 * Not the same two-frame trick as {@link settledShot}, on purpose. Spec 197's
 * cling is deliberately ephemeral -- "each mark short-lived", authored to live
 * about half a second and be renewed rather than accumulated -- so requiring
 * two samples {@link STILL_GAP_MS} (650ms) apart to show the *exact same*
 * colour, the test that correctly finds a static brush stroke on the ground
 * in `preview-paint.ts`, systematically throws most of a healthy cling away:
 * the specific marks alive at the first sample have mostly expired and been
 * replaced by the second one. That is exactly what happened to Burn in this
 * probe's first working run -- clearly visible by eye in the screenshot, a
 * handful of orange sparks around the hand, and measured at 34 connected
 * pixels because the two-frame test asked the wrong question of it.
 *
 * So a candidate is *sampled* rather than settled: several frames, and a
 * pixel is trusted as "painted here" if it differs from control at *any* of
 * them, not all. Reliability still comes from the control side alone --
 * {@link compareCandidate} only looks at pixels control's own two-frame test
 * called quiet -- so this does not need its own stability mask; what varies
 * between these frames is allowed to vary, because a cling that is visibly
 * present in three frames out of five and absent from the other two is
 * exactly what "renewed rather than accumulated" looks like on screen.
 */
async function burstShot(page: Page): Promise<Frame[]> {
  const frames: Frame[] = [];
  for (let i = 0; i < BURST_FRAMES; i += 1) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, BURST_GAP_MS));
    const png = PNG.sync.read(await page.screenshot());
    frames.push({ width: png.width, height: png.height, data: png.data });
  }
  return frames;
}

/**
 * The largest 8-connected run of `changed`, as a flat index list.
 *
 * Lifted from `scripts/preview-paint.ts`'s function of the same job: a stroke
 * (there) or a cling (here) is one mass, and everything else that happens to
 * have changed is scattered -- a leaf caught at a different phase in one
 * session's pair than another's slips through the stillness filter as a
 * handful of disconnected specks, and area is robust to specks in a way a
 * mean or a bounding radius is not.
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

/** What one affliction's frame looked like against the control, measured. */
interface Comparison {
  readonly totalChanged: number;
  readonly massSize: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** Mean colour of the largest mass, in the affliction's own frame. */
  readonly massColor: Rgb;
  /** Mean colour of every changed pixel, for the same reason. */
  readonly overallColor: Rgb;
}

/** A rectangle in screen pixels, half-open on the right and bottom. */
interface Crop {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * How far beside the player's own health-bar anchor this probe trusts a
 * pixel to be about the player's body, in screen pixels at the default
 * framing.
 *
 * A full-page diff was tried first and measured the wrong thing twice over.
 * Excluding only the HUD's own chrome (the tab bar, spec 164's bottom band)
 * still left the **floating damage numbers** inside the window -- they hover
 * in world space over the body, the same way the paint does, so nothing about
 * "is this inside the HUD" tells them apart. And they turned out to be the
 * larger, more solidly-connected mass: Poison and Frostbite both measured an
 * identical 248x123 box at the identical position with near-identical mean
 * colour, which is not two afflictions coincidentally painting the same
 * thing, it is this probe finding the same stack of pale digits above the
 * body in both runs, because the demo trigger's five stacks of Poison and
 * Frostbite's climbing ramp both throw a lot of them. So the window is
 * anchored on the body itself: {@link ABOVE} stops short of where a number
 * stack rises to (visibly forty-plus pixels above the health bar in the
 * screenshots this probe already took), and {@link BELOW} reaches through the
 * legs, the feet and the ground far enough to catch a downward shed mark
 * (Poison, Corrosion and Decay's rider all fall rather than rise) without
 * reaching the bottom HUD band.
 */
const HALF_WIDTH = 90;
const ABOVE = 10;
const BELOW = 190;

/** The window around `anchor`, clamped to the frame. */
function bodyCrop(anchor: BarPoint, width: number, height: number): Crop {
  return {
    left: Math.max(0, anchor.x - HALF_WIDTH),
    right: Math.min(width, anchor.x + HALF_WIDTH),
    top: Math.max(0, anchor.y - ABOVE),
    bottom: Math.min(height, anchor.y + BELOW),
  };
}

/**
 * `frames` against `control`, restricted to pixels control's own two-frame
 * test called quiet and inside `crop`.
 *
 * A pixel counts as painted if it differs from control at **any** of the
 * burst's frames -- see {@link burstShot} for why "any" rather than "all
 * agree": the cling this is looking for is authored to flicker, and asking
 * every sample to show the identical colour would fail it for being healthy.
 * The colour reported for a painted pixel is the burst's **last** frame,
 * simply because it is the one frame every painted pixel is guaranteed to
 * have a reading in the union from, and it is no less representative of "how
 * this affliction currently looks" than any other sample would be.
 *
 * Null when nothing changed at all -- which is the exact failure this probe
 * exists to catch, so the caller turns a null straight into a FAIL rather
 * than treating "nothing to measure" as "nothing to report".
 */
function compareCandidate(control: Shot, frames: readonly Frame[], crop: Crop): Comparison | null {
  const last = frames[frames.length - 1];
  if (!last) throw new Error('compareCandidate called with no frames');
  if (control.width !== last.width || control.height !== last.height) {
    throw new Error(
      `frame size mismatch: control ${control.width}x${control.height}, candidate ${last.width}x${last.height}`,
    );
  }
  const n = control.width * control.height;
  const changed = new Uint8Array(n);
  let totalChanged = 0;
  let or = 0;
  let og = 0;
  let ob = 0;
  for (let i = 0; i < n; i++) {
    const x = i % control.width;
    const y = (i - x) / control.width;
    if (x < crop.left || x >= crop.right || y < crop.top || y >= crop.bottom) continue;
    if (control.still[i] !== 1) continue;
    const a = pixelAt(control.data, i);
    const paintedInAnyFrame = frames.some((frame) => distance2(a, pixelAt(frame.data, i)) >= CHANGE_THRESHOLD);
    if (!paintedInAnyFrame) continue;
    changed[i] = 1;
    totalChanged += 1;
    const b = pixelAt(last.data, i);
    or += b[0];
    og += b[1];
    ob += b[2];
  }
  if (totalChanged === 0) return null;

  const mass = largestMass(changed, control.width, control.height);
  let mr = 0;
  let mg = 0;
  let mb = 0;
  let minX = control.width;
  let minY = control.height;
  let maxX = -1;
  let maxY = -1;
  for (const i of mass) {
    const [r, g, b] = pixelAt(last.data, i);
    mr += r;
    mg += g;
    mb += b;
    const x = i % control.width;
    const y = Math.floor(i / control.width);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const massSize = mass.length;
  return {
    totalChanged,
    massSize,
    minX: massSize > 0 ? minX : 0,
    minY: massSize > 0 ? minY : 0,
    maxX: massSize > 0 ? maxX : 0,
    maxY: massSize > 0 ? maxY : 0,
    massColor: massSize > 0 ? [mr / massSize, mg / massSize, mb / massSize] : [0, 0, 0],
    overallColor: [or / totalChanged, og / totalChanged, ob / totalChanged],
  };
}

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

/** Waits until the sim has actually run `ticks` ticks, and says so if it never does. */
async function waitForTick(page: Page, ticks: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const text = (await page.textContent('body')) ?? '';
    last = Number(/tick (\d+)/.exec(text)?.[1] ?? -1);
    if (last >= ticks) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`sim never reached tick ${ticks} (last seen: ${last})`);
}

/** Where a body's health bar is on screen. Lifted from `preview-world.ts`. */
interface BarPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Where the local player's own bar is, or null if it is not on screen this
 * frame (a reconnect, or a frame taken before the first delta).
 *
 * `data-entity` and `data-self` are read rather than re-derived from the
 * camera projection, for the reason `preview-world.ts` gives: this asks the
 * same question the player answers by looking at the screen, not this
 * script's own copy of `hud.ts`'s placement arithmetic.
 */
async function selfBarPoint(page: Page): Promise<BarPoint | null> {
  return page.$$eval('[data-entity]', (nodes) => {
    for (const node of nodes) {
      const element = node as HTMLElement;
      if (element.dataset['self'] === undefined) continue;
      return { x: element.offsetLeft, y: element.offsetTop };
    }
    return null;
  });
}

/**
 * Loads the world with an optional `&afflict=` and waits for it to be worth
 * measuring: the world streamed in, the sim run far enough for the affliction
 * to have landed and beaten a few times, and the pointer parked off the world
 * entirely.
 *
 * That last step matters more here than in most probes: nothing in this
 * script clicks or aims at anything, but a stray hover brightens whatever
 * body it happens to land on (spec 095) -- and "the frame is brighter than the
 * control" is exactly the kind of difference this measurement cannot tell
 * apart from paint.
 */
async function load(page: Page, afflict: string | null): Promise<void> {
  const query = afflict === null ? `?seed=${SEED}` : `?seed=${SEED}&afflict=${afflict}`;
  await page.goto(`http://localhost:${PORT}/${query}`, { waitUntil: 'load' });
  // `state: 'attached'` rather than Playwright's default `'visible'`. The
  // world's own canvas is deliberately drawn at a reduced backing resolution
  // (the retro pass's low-res virtual buffer) and stretched to fill the
  // viewport by CSS, which is a legitimate way for a WebGL canvas to spend
  // most of a load looking small before anything is painted into it -- and
  // under real load on a shared machine, waiting for Playwright's stricter
  // visibility actionability check on top of that cost this probe a run that
  // hung past 30s on nothing more than the two facts colliding. `attached` is
  // the fact that actually matters here: `[data-world-ready="true"]` right
  // after this is the authoritative "worth reading pixels from" signal, not
  // this.
  await page.waitForSelector('canvas', { state: 'attached', timeout: 60_000 });
  // Two waits, because they are two different facts (see `preview-world.ts`):
  // the terrain streams in during frames rather than before the first one, and
  // the view says when it is done before the sim is worth reading ticks from.
  // 120s rather than the more usual 60: this probe's own cost is a real one
  // (roughly 169 chunks and several seconds of streaming a load, four times
  // over), and on a shared machine under real contention that cost is not
  // this script's to control -- a generous timeout costs nothing when the
  // load is fast and is the difference between a report and a crash when it
  // is not.
  await page.waitForSelector('[data-world-ready="true"]', { timeout: 120_000 });
  await waitForTick(page, SETTLE_TICK);
  await page.mouse.move(4, 4);
}

async function writeFramePng(frame: Frame, path: string): Promise<void> {
  const png = new PNG({ width: frame.width, height: frame.height });
  frame.data.copy(png.data);
  await writeFile(path, PNG.sync.write(png));
}

// --- the contact sheet --------------------------------------------------------

const CELL_W = 300;
const CELL_H = Math.round((CELL_W * VIEWPORT.height) / VIEWPORT.width);
const GAP = 8;
const LABEL_H = 10;
const SHEET_BG: Rgb = [18, 18, 22];
const INK: Rgb = [232, 236, 242];

/** Nearest-neighbour downscale of one frame into a `CELL_W`x`CELL_H` buffer. */
function downscale(frame: Frame): Buffer {
  const out = Buffer.alloc(CELL_W * CELL_H * 4);
  for (let y = 0; y < CELL_H; y++) {
    const sy = Math.min(frame.height - 1, Math.floor((y / CELL_H) * frame.height));
    for (let x = 0; x < CELL_W; x++) {
      const sx = Math.min(frame.width - 1, Math.floor((x / CELL_W) * frame.width));
      const si = (sy * frame.width + sx) * 4;
      const di = (y * CELL_W + x) * 4;
      out[di] = frame.data[si] ?? 0;
      out[di + 1] = frame.data[si + 1] ?? 0;
      out[di + 2] = frame.data[si + 2] ?? 0;
      out[di + 3] = 255;
    }
  }
  return out;
}

/** Every lit pixel of `text`, drawn with the game's own 5x7 face -- no webfont
 * to fetch, and the same face the HUD itself draws with (`pixel-font.ts`). */
function stampLabel(sheet: PNG, text: string, atX: number, atY: number): void {
  for (const rect of glyphRects(text.toUpperCase())) {
    const x = atX + rect.x;
    const y = atY + rect.y;
    if (x < 0 || y < 0 || x >= sheet.width || y >= sheet.height) continue;
    const i = (y * sheet.width + x) * 4;
    sheet.data[i] = INK[0];
    sheet.data[i + 1] = INK[1];
    sheet.data[i + 2] = INK[2];
    sheet.data[i + 3] = 255;
  }
}

/** Control plus the three afflictions, one labelled row, at a glance. */
async function assembleContactSheet(frames: ReadonlyMap<string, Frame>): Promise<void> {
  const names = ['control', ...AFFLICTIONS];
  const width = names.length * CELL_W + (names.length + 1) * GAP;
  const height = LABEL_H + GAP * 2 + CELL_H;
  const sheet = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    sheet.data[p] = SHEET_BG[0];
    sheet.data[p + 1] = SHEET_BG[1];
    sheet.data[p + 2] = SHEET_BG[2];
    sheet.data[p + 3] = 255;
  }
  names.forEach((name, index) => {
    const frame = frames.get(name);
    if (!frame) return;
    const cellX = GAP + index * (CELL_W + GAP);
    const cellY = LABEL_H + GAP;
    const scaled = downscale(frame);
    for (let y = 0; y < CELL_H; y++) {
      for (let x = 0; x < CELL_W; x++) {
        const si = (y * CELL_W + x) * 4;
        const di = ((cellY + y) * width + (cellX + x)) * 4;
        sheet.data[di] = scaled[si] ?? 0;
        sheet.data[di + 1] = scaled[si + 1] ?? 0;
        sheet.data[di + 2] = scaled[si + 2] ?? 0;
        sheet.data[di + 3] = 255;
      }
    }
    stampLabel(sheet, name, cellX, 1);
  });
  await writeFile(join(outDir, 'afflictions-in-game.png'), PNG.sync.write(sheet));
}

// --- process management -------------------------------------------------------

/**
 * The dev server, in its own process group.
 *
 * Run through `node_modules/.bin/vite` directly rather than `npx vite`, which
 * sidesteps `probe-admin-console.ts`'s whole problem -- `npx` is a wrapper that
 * spawns the real process as a grandchild, and a `SIGTERM` to the wrapper
 * leaves the grandchild holding the port. Kept `detached` and killed by
 * process group anyway, on the same belt-and-braces reasoning that probe
 * keeps: a leaked server on this port would mean the *next* run of this
 * script silently measures a stale build instead of the code in the tree, and
 * that failure is worse than a probe that occasionally over-kills.
 */
function runDevServer(): ChildProcess {
  return spawn(join(root, 'node_modules', '.bin', 'vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    detached: true,
  });
}

function stopDevServer(child: ChildProcess | null): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  // Refused rather than joined -- if anything already answers here, this
  // probe would measure it instead of the server it is about to start, and
  // every check below would pass or fail against code that is not the code
  // in the tree. See `probe-admin-console.ts`'s note on the same check.
  const occupied = await fetch(`http://localhost:${PORT}/`)
    .then(() => true)
    .catch(() => false);
  if (occupied) {
    console.error(`something is already answering on port ${PORT}. Stop it, or change PORT.`);
    process.exit(1);
  }

  const server = runDevServer();
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  const problems: string[] = [];
  const frames = new Map<string, Frame>();

  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
      // The unit loader shouts about the pig's clips carrying root travel
      // every time the page boots (`preview-paint.ts` carries the same
      // filter for the same reason): it predates this probe, has nothing to
      // do with afflictions, and fires on every one of the four loads here
      // (control plus three afflictions), which would otherwise turn a
      // script that measured three honest PASSes into a false FAIL over
      // noise this probe did not create and cannot fix.
      if (message.type() === 'error' && !message.text().startsWith('[units]')) problems.push(message.text());
    });

    console.log('control (no ?afflict, plain seed)');
    await load(page, null);
    // Anchored once, off the control load, and reused for every affliction:
    // the world is deterministic given this seed and no input is ever sent,
    // so the player's body settles at the same screen point every session
    // bar a pixel or two of camera-follow jitter -- which the generous
    // {@link HALF_WIDTH}/{@link BELOW} margins in `bodyCrop` are sized to
    // absorb. Falling back to the frame's own centre rather than throwing:
    // the bar not being on screen yet is itself worth reporting rather than
    // crashing the whole run over.
    const anchor = (await selfBarPoint(page)) ?? { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
    console.log(`  player's own bar anchors the crop at (${anchor.x.toFixed(0)},${anchor.y.toFixed(0)})`);
    const crop = bodyCrop(anchor, VIEWPORT.width, VIEWPORT.height);
    const control = await settledShot(page);
    frames.set('control', control);
    await writeFramePng(control, join(outDir, 'afflictions-in-game-control.png'));
    console.log('  wrote afflictions-in-game-control.png');

    for (const name of AFFLICTIONS) {
      console.log(`\n${name}`);
      await load(page, name);
      const burst = await burstShot(page);
      const last = burst[burst.length - 1];
      if (!last) throw new Error(`${name}: burstShot produced no frames`);
      frames.set(name, last);
      await writeFramePng(last, join(outDir, `afflictions-in-game-${name}.png`));
      console.log(`  wrote afflictions-in-game-${name}.png`);

      const comparison = compareCandidate(control, burst, crop);
      if (!comparison) {
        console.log('  FAIL: indistinguishable from the control frame -- no reliable pixel changed in any sample');
        problems.push(`${name}: no measurable difference from the control frame`);
        continue;
      }

      const massW = comparison.maxX - comparison.minX + 1;
      const massH = comparison.maxY - comparison.minY + 1;
      const round = (c: Rgb): string => c.map((v) => v.toFixed(0)).join(',');
      console.log(`  changed pixels (control quiet, any of ${BURST_FRAMES} samples differs): ${comparison.totalChanged}`);
      console.log(
        `  largest connected mass: ${comparison.massSize}px, ` +
          `box ${massW}x${massH} at (${comparison.minX},${comparison.minY})`,
      );
      console.log(`  mean colour of the mass:       rgb(${round(comparison.massColor)})`);
      console.log(`  mean colour of everything lit: rgb(${round(comparison.overallColor)})`);

      const pass = comparison.massSize >= MIN_MASS_PIXELS && comparison.totalChanged >= MIN_CHANGED_PIXELS;
      console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`);
      if (!pass) {
        problems.push(
          `${name}: largest mass ${comparison.massSize}px / total changed ${comparison.totalChanged}px, ` +
            `under the ${MIN_MASS_PIXELS}px/${MIN_CHANGED_PIXELS}px floor`,
        );
      }
    }

    await assembleContactSheet(frames);
    console.log(`\nwrote ${join(outDir, 'afflictions-in-game.png')}`);

    if (problems.length > 0) {
      console.error(`\n${problems.length} problem(s):`);
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
    } else {
      console.log('\nall three afflictions painted something a browser can actually see');
    }
  } finally {
    await browser.close();
    stopDevServer(server);
  }
}

await main();
