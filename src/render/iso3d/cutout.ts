/**
 * Cutting a hole in whatever stands between the camera and a body (spec 126).
 *
 * The camera is orthographic, fixed at an isometric pitch, and parked 6000
 * units back. Formations (specs 123-125) put 60 to 200 units of solid rock in
 * that world, so a body beside a tier, in a gully, or in a walled courtyard is
 * simply behind it. The camera cannot move -- everything about the look is built
 * on it not moving -- so the geometry gives way instead.
 *
 * The rule is one line: a fragment is cut when it is **nearer the camera than
 * the body** and **within a radius of it across the view**. Both halves are in
 * *view* space, which is what makes the hole world-sized rather than
 * pixel-sized: the same cut at any resolution, in any shape of window, with no
 * aspect correction to get wrong.
 *
 * As with `wind.ts`, the GLSL below is a string and the TypeScript beside it is
 * its twin, with a test that walks a sweep of positions through both and
 * demands they agree. A shader expression nobody can execute is where a typo
 * lives forever.
 *
 * Pure: no three.js, no DOM, no clock.
 */

/**
 * How the cut is drawn.
 *
 * Four, because there is no one right answer and imposing one was the wrong
 * call twice over. A stipple matches the retro pass's own grain but is noisy;
 * `ghost` keeps dark strata on the vertical faces so the wall still reads;
 * `hard` is a plain quiet opening; and somebody who would rather the rock stayed
 * put should be able to say so.
 *
 * `hard` is the default now that the hole is a porthole rather than a crater.
 * `ghost` was the default for one round and was worse than it sounds: cutting a
 * tier's *top* exposes the inside of a hollow shell, and banding the far faces
 * of it reads as a birdcage rather than as a wall.
 */
export type CutoutStyle = 'ghost' | 'hard' | 'stipple' | 'off';

export const CUTOUT_STYLES: readonly CutoutStyle[] = ['ghost', 'hard', 'stipple', 'off'];

/**
 * How tall one band of the ghost is, in world units, and how much of it is
 * kept.
 *
 * Sized against a tier: the editor's default tier stands 70 units, so a 20-unit
 * band puts three or four strata on a face -- enough to read its height and its
 * edges, few enough to see straight through. The duty cycle is what is *left*,
 * so a quarter of the wall survives and three quarters of the body behind it is
 * visible.
 */
export const GHOST_BAND_PERIOD = 20;
export const GHOST_BAND_DUTY = 0.18;

/**
 * How level a surface has to be before the bands are abandoned and it is simply
 * cut, as `abs(worldNormal.y)`.
 *
 * Banding on world height is the right idea on a *wall*, where a 4-unit stratum
 * is a 4-unit stripe. On a tier's flat top it is a disaster: the whole surface
 * shares one height, so a band either swallows all of it or none, and anything
 * gently sloping turns into bars metres wide fanning across the screen. Only
 * the vertical faces carry the strata; the tops give way cleanly, which is also
 * what they should do, since a roof is not a thing you walk into.
 */
export const GHOST_MAX_UP = 0.55;
/** How far the kept bands are pushed toward black, so they read as a section. */
export const GHOST_DARKEN = 0.55;

/**
 * How far above the feet the floor guard still protects, in world units.
 *
 * Not a tolerance for its own sake. The body's `groundY` is sampled from the
 * heightfield at a point, while the surface under it is drawn from *jittered*
 * corners a fraction off that lattice, so the two disagree by a hair -- and an
 * exact comparison then cuts the very ground the body is standing on, in a ring
 * around its feet, straight through to the sky. A shin's worth of margin also
 * spares the low lip a tier leaves where it meets the floor, which is never
 * what is hiding anybody.
 */
export const FOOT_MARGIN = 6;

export interface CutoutParams {
  /** Fully cut within this, in world units measured across the view. */
  readonly inner: number;
  /** Untouched beyond this. Between the two the fragment stipples out. */
  readonly outer: number;
  /**
   * How far in front of the body a fragment must be before it counts as
   * hiding it.
   *
   * Without it the ground a body is standing *on* flickers: its own footing is
   * within a hair of its depth, and half the fragments under it fall on the
   * near side of the comparison.
   */
  readonly depthBias: number;
  readonly style: CutoutStyle;
}

/**
 * Where the body's feet are, in world Y.
 *
 * The cut needs this quite apart from the view-space maths, for two separate
 * reasons that happen to want the same number:
 *
 * - **Nothing below the feet is ever cut.** Ground in front of a body does
 *   technically hide its shins under this camera, and cutting it opened a hole
 *   straight through the world to the sky. The floor is not the problem and
 *   must not be the casualty.
 * - **The ghost's bands are horizontal**, measured in world Y, so they read as
 *   strata standing at a height rather than as a screen-space pattern sliding
 *   across the rock as the camera tracks.
 */
export interface BodyPlace {
  /** Chest height in *view* space: the centre of the hole. */
  readonly view: ViewPoint;
  /** The ground the body is standing on, in *world* Y. */
  readonly footY: number;
}

/**
 * Sized off the body rather than off the screen.
 *
 * A unit is 55.65 units tall (`DEFAULT_CANONICAL_HEIGHT`), so `inner` is about
 * one body wide -- enough to see the whole of one and what it is doing, and
 * small enough that a formation still reads as solid. The fade is half that
 * again, which is the difference between a hole and a soft eye.
 */
export const CUTOUT_DEFAULTS: CutoutParams = {
  // A porthole, not a crater.
  //
  // These started at 58/96 -- a hole 190 units across, nearly four bodies wide.
  // It answered "where is my unit" and then asked a worse one: the wall it took
  // out is still solid to walk into, and with that much of it gone there was
  // nothing left on screen to say where. At 26/40 the opening is about one body
  // across, so the unit is plainly visible and the wall either side of it is
  // still standing to be read.
  inner: 26,
  outer: 40,
  depthBias: 12,
  style: 'hard',
};

/** No cut at all: what every view that never writes the uniforms gets. */
export const CUTOUT_OFF: CutoutParams = { inner: 0, outer: 0, depthBias: 0, style: 'off' };

/** What the style is worth to the shader, which has no strings. */
export function styleCode(style: CutoutStyle): number {
  return style === 'stipple' ? 2 : style === 'hard' ? 1 : style === 'ghost' ? 0 : -1;
}

/**
 * How far up the line toward the camera is worth looking, in world units, and
 * how coarsely.
 *
 * `MARCH_RISE` is the tallest thing that could plausibly be standing between a
 * body and this camera -- a couple of tiers plus the hill they sit on. Past that
 * the ray is above the world and nothing further can hide anything. The step is
 * a cell and a half, which is finer than any wall this world can build: a tier
 * is dozens of cells across, so a step cannot pass through one unnoticed.
 */
export const MARCH_RISE = 420;
export const MARCH_STEP = 33;
/**
 * How far above the terrain the line has to clear before it counts as open.
 *
 * The body stands *on* ground, so the first samples up the line are close to
 * the surface it is standing on -- and on a slope facing the camera they can
 * graze it. Without the clearance a unit walking up any hillside toward the
 * camera declares itself hidden by the hill it is climbing.
 */
export const MARCH_CLEARANCE = 8;

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Is anything actually standing between this body and the camera? (spec 128)
 *
 * The cut used to fire whenever there was rock *in front of* the body, which is
 * not the same question and is wrong most of the time: stand on an open ledge
 * with a wall a little nearer the camera but off to one side, and a bite is
 * taken out of that wall for no reason at all.
 *
 * Answered off the heightfield rather than off the geometry. A raycast into the
 * terrain mesh would work and costs thousands of triangle tests a frame; this
 * walks the line from the body toward the camera and asks the same `heightAt`
 * the sim uses whether the ground has risen above it. Two dozen samples, no
 * meshes, no GL, and pure -- so it is tested in Node rather than in a
 * screenshot.
 */
export function bodyIsHidden(
  body: WorldPoint,
  toCamera: WorldPoint,
  heightAt: (x: number, z: number) => number,
): boolean {
  // Straight down the barrel of an orthographic camera that never tilts: if it
  // is not rising, no amount of marching finds anything above the ray.
  if (toCamera.y <= 1e-4) return false;
  const maxT = MARCH_RISE / toCamera.y;
  for (let t = MARCH_STEP; t <= maxT; t += MARCH_STEP) {
    const y = body.y + toCamera.y * t;
    const ground = heightAt(body.x + toCamera.x * t, body.z + toCamera.z * t);
    if (ground > y + MARCH_CLEARANCE) return true;
  }
  return false;
}

/**
 * Ease the opening toward where it should be, per second.
 *
 * The answer above is a yes or a no, and a hole that snaps into existence the
 * instant a body steps behind a corner reads as a glitch rather than as the
 * view getting out of the way. Scaling the radii by this makes it an iris.
 */
export const CUTOUT_EASE_PER_SECOND = 7;

export function easeCutout(current: number, hidden: boolean, dt: number): number {
  const target = hidden ? 1 : 0;
  const k = Math.min(1, Math.max(0, dt) * CUTOUT_EASE_PER_SECOND);
  const next = current + (target - current) * k;
  // Snap the last sliver, so an opening that is meant to be shut is shut and
  // the pick is not left able to click through a hole nobody can see.
  return Math.abs(next - target) < 0.01 ? target : next;
}

export interface ViewPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Coverage in [0, 1] for one fragment: 1 draws it, 0 removes it.
 *
 * View space is right-handed with the camera looking down -z, so a *smaller*
 * `z` is further away and a larger one is nearer. "In front of the body" is
 * therefore `frag.z > body.z + bias`.
 */
export function cutoutCoverage(frag: ViewPoint, body: ViewPoint, params: CutoutParams, fragWorldY?: number, footY?: number): number {
  const { inner, outer, depthBias } = params;
  if (params.style === 'off') return 1;
  // A zero radius is off, not a degenerate circle. Checked first so an unwritten
  // uniform costs one compare rather than a divide by zero.
  if (!(outer > 0)) return 1;
  // The floor is never the problem. Ground at or below the body's feet is what
  // it is standing on and what everything around it is standing on, and cutting
  // it opens a hole through the world to the sky.
  if (fragWorldY !== undefined && footY !== undefined && fragWorldY <= footY + FOOT_MARGIN) return 1;
  // Behind the body, or level with it, hides nothing.
  if (frag.z <= body.z + depthBias) return 1;

  const dx = frag.x - body.x;
  const dy = frag.y - body.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance >= outer) return 1;
  if (distance <= inner) return 0;
  return (distance - inner) / (outer - inner);
}

/**
 * Whether this fragment is thrown away, given its coverage and where it is.
 *
 * The one place the three styles differ. `hard` takes everything the fade band
 * would have softened, so the hole has a clean rim and no noise in it; `stipple`
 * dithers the band against a Bayer threshold; `off` never discards, which is
 * also what a zero radius gives.
 */
export function cutoutDiscards(
  coverage: number,
  style: CutoutStyle,
  x: number,
  y: number,
  fragWorldY = 0,
  upness = 0,
): boolean {
  if (style === 'off') return false;
  if (coverage >= 1) return false;
  // A hard cut takes the whole soft band with it. Half-covered is inside the
  // hole, not on its edge -- an edge drawn by a coverage test is the stipple.
  if (style === 'hard') return true;
  if (style === 'ghost') return !inGhostBand(fragWorldY, upness);
  return coverage <= bayer4(x, y);
}

/** Whether this height falls in one of the ghost's kept strata. */
export function inGhostBand(worldY: number, upness = 0): boolean {
  // A surface facing the sky carries no strata: see `GHOST_MAX_UP`.
  if (Math.abs(upness) > GHOST_MAX_UP) return false;
  const t = worldY / GHOST_BAND_PERIOD;
  return t - Math.floor(t) < GHOST_BAND_DUTY;
}

/**
 * The 4x4 Bayer threshold for a pixel, in [0, 1).
 *
 * Sixteen distinct levels over the block, so a coverage of 0.5 removes half the
 * fragments in a scatter rather than clipping a diagonal band out of them.
 */
export function bayer4(x: number, y: number): number {
  const table = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const i = (((y % 4) + 4) % 4) * 4 + (((x % 4) + 4) % 4);
  return (table[i] ?? 0) / 16;
}

/**
 * Uniforms and helpers, injected after `#include <common>` in the fragment
 * stage. `vCutView` is written by the vertex half below.
 */
export const CUTOUT_PROLOGUE = /* glsl */ `
uniform vec4 uCutBody;  // xyz: chest in view space. w: the feet, in world Y.
uniform vec4 uCutParams; // inner, outer, depthBias, style (-1 off, 0 ghost, 1 hard, 2 stipple)
uniform vec4 uCutGhost;  // band period, duty, darken, foot margin
uniform float uCutMaxUp; // above this the surface is level and is simply cut
varying vec3 vCutView;
varying float vCutWorldY;
varying float vCutUp;

float cutoutBayer4(vec2 p) {
  vec2 c = mod(p, 4.0);
  int i = int(c.y) * 4 + int(c.x);
  float t = 0.0;
  if (i == 0) t = 0.0;  else if (i == 1) t = 8.0;  else if (i == 2) t = 2.0;  else if (i == 3) t = 10.0;
  else if (i == 4) t = 12.0; else if (i == 5) t = 4.0; else if (i == 6) t = 14.0; else if (i == 7) t = 6.0;
  else if (i == 8) t = 3.0;  else if (i == 9) t = 11.0; else if (i == 10) t = 1.0; else if (i == 11) t = 9.0;
  else if (i == 12) t = 15.0; else if (i == 13) t = 7.0; else if (i == 14) t = 13.0; else t = 5.0;
  return t / 16.0;
}

float cutoutCoverage() {
  float inner = uCutParams.x;
  float outer = uCutParams.y;
  float bias = uCutParams.z;
  if (uCutParams.w < 0.0) return 1.0;
  if (outer <= 0.0) return 1.0;
  // The floor is never the problem, and cutting it opens a hole to the sky.
  // The margin is load-bearing: the body's ground height is sampled off the
  // lattice and the surface is drawn from jittered corners, so an exact test
  // cuts a ring out of the floor the body is standing on.
  if (vCutWorldY <= uCutBody.w + uCutGhost.w) return 1.0;
  if (vCutView.z <= uCutBody.z + bias) return 1.0;
  float d = length(vCutView.xy - uCutBody.xy);
  if (d >= outer) return 1.0;
  if (d <= inner) return 0.0;
  return (d - inner) / (outer - inner);
}
`;

/** Carried through the vertex stage. Appended after `#include <common>` there. */
export const CUTOUT_VERTEX_PROLOGUE = /* glsl */ `
varying vec3 vCutView;
varying float vCutWorldY;
varying float vCutUp;
`;

/**
 * Written where the vertex stage already has the view position to hand.
 * Appended after `#include <project_vertex>`, which is where `mvPosition`
 * exists.
 */
export const CUTOUT_VERTEX_APPLY = /* glsl */ `
vCutView = mvPosition.xyz;
vCutWorldY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;
vCutUp = normalize( mat3( modelMatrix ) * objectNormal ).y;
`;

/**
 * The discard itself, injected at the very top of the fragment body so a cut
 * fragment costs nothing further.
 */
export const CUTOUT_APPLY = /* glsl */ `
{
  float cov = cutoutCoverage();
  if (cov < 1.0) {
    float style = uCutParams.w;
    if (style < 0.5) {
      // Ghost: keep a stratum every period world units, darkened, so the wall
      // still reads as a wall you would walk into.
      // A level surface carries no strata -- one height across the whole of it
      // makes a band either swallow it or miss it, and a gentle slope turns the
      // stripes into bars metres wide.
      if (abs(vCutUp) > uCutMaxUp) discard;
      float band = fract(vCutWorldY / uCutGhost.x);
      if (band >= uCutGhost.y) discard;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.0), uCutGhost.z);
    } else if (style < 1.5) {
      discard;
    } else if (cov <= cutoutBayer4(gl_FragCoord.xy)) {
      discard;
    }
  }
}
`;
