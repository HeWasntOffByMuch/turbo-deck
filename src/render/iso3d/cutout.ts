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
 * Three, because there is no one right answer and imposing one was the wrong
 * call. A stipple matches the retro pass's own grain but is noisy on a large
 * hole; a hard edge is quiet and reads as a clean bite; and somebody who would
 * rather the rock simply stayed put should be able to say so.
 */
export type CutoutStyle = 'hard' | 'stipple' | 'off';

export const CUTOUT_STYLES: readonly CutoutStyle[] = ['hard', 'stipple', 'off'];

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
 * Sized off the body rather than off the screen.
 *
 * A unit is 55.65 units tall (`DEFAULT_CANONICAL_HEIGHT`), so `inner` is about
 * one body wide -- enough to see the whole of one and what it is doing, and
 * small enough that a formation still reads as solid. The fade is half that
 * again, which is the difference between a hole and a soft eye.
 */
export const CUTOUT_DEFAULTS: CutoutParams = {
  inner: 58,
  outer: 96,
  depthBias: 12,
  // A clean bite rather than the stipple. The dither is the closer match to the
  // retro pass's own grain, but over a hole this size it reads as static across
  // a third of the frame, and it should not be what anybody gets without
  // choosing it.
  style: 'hard',
};

/** No cut at all: what every view that never writes the uniforms gets. */
export const CUTOUT_OFF: CutoutParams = { inner: 0, outer: 0, depthBias: 0, style: 'off' };

/** What the style is worth to the shader, which has no strings. */
export function styleCode(style: CutoutStyle): number {
  return style === 'stipple' ? 1 : style === 'hard' ? 0 : -1;
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
export function cutoutCoverage(frag: ViewPoint, body: ViewPoint, params: CutoutParams): number {
  const { inner, outer, depthBias } = params;
  if (params.style === 'off') return 1;
  // A zero radius is off, not a degenerate circle. Checked first so an unwritten
  // uniform costs one compare rather than a divide by zero.
  if (!(outer > 0)) return 1;
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
export function cutoutDiscards(coverage: number, style: CutoutStyle, x: number, y: number): boolean {
  if (style === 'off') return false;
  if (coverage >= 1) return false;
  // A hard cut takes the whole soft band with it. Half-covered is inside the
  // hole, not on its edge -- an edge drawn by a coverage test is the stipple.
  if (style === 'hard') return coverage < 1;
  return coverage <= bayer4(x, y);
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
uniform vec3 uCutBody;
uniform vec4 uCutParams; // inner, outer, depthBias, style (-1 off, 0 hard, 1 stipple)
varying vec3 vCutView;

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
`;

/**
 * Written where the vertex stage already has the view position to hand.
 * Appended after `#include <project_vertex>`, which is where `mvPosition`
 * exists.
 */
export const CUTOUT_VERTEX_APPLY = /* glsl */ `
vCutView = mvPosition.xyz;
`;

/**
 * The discard itself, injected at the very top of the fragment body so a cut
 * fragment costs nothing further.
 */
export const CUTOUT_APPLY = /* glsl */ `
{
  float cov = cutoutCoverage();
  if (cov < 1.0) {
    // Hard takes the whole soft band, so the rim is clean and there is no noise
    // inside it; stipple dithers the band instead.
    if (uCutParams.w < 0.5) discard;
    else if (cov <= cutoutBayer4(gl_FragCoord.xy)) discard;
  }
}
`;
