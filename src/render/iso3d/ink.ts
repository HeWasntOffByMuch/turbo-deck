/**
 * The distance treatment (spec 103): what happens to a *fill* as it recedes.
 *
 * Pure -- no three.js and no DOM -- so the composition can be run against
 * numbers; `glslInkChunk()` is the transcription the retro pass executes.
 *
 * ## The order is the effect
 *
 * Fogging a frame is ordinary. What makes distant geometry read as ink drawing
 * rather than as haze is that only the **fills** recede: they lose their
 * gradient, lose their colour and drift toward the sky, while the lines over
 * them stay exactly as dark as the lines in the foreground. Fog the lines too
 * and the far hills go soft, which is the usual look and the opposite of this
 * one. So this operates on colour only, and the outline pass composites
 * afterwards at a constant value -- which it already did, for its own reasons.
 *
 * ## Flattening, without an albedo buffer
 *
 * "Lerp toward flat albedo" wants a buffer this renderer does not have, and
 * adding one means reproducing every material's diffuse -- vertex colours,
 * instance colours, the terrain's per-cell tones -- inside a stand-in shader, to
 * recover a number the frame already contains most of.
 *
 * What the flattening is *for* is losing the shading gradient, so a far hillside
 * stops being a lit surface and becomes one tone bounded by a line. That is
 * achievable from the lit colour alone: hold the hue and chroma, and push the
 * luminance toward a constant. A surface whose every pixel has the same
 * luminance has no gradient left, which is the whole of what was wanted. It is
 * an approximation of the stated method and an exact implementation of the
 * stated goal, and it is worth being explicit about which.
 */

/** Rec. 709 luma weights, matching the ones the retro pass already grades with. */
const LUMA: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/** Below this luminance a colour has no hue worth preserving, so scaling it explodes. */
const MIN_LUMA = 1e-3;

export type Rgb = readonly [number, number, number];

export function luminance(c: Rgb): number {
  return c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
}

/**
 * How far into the treatment a pixel at `depth` is, from 0 to 1.
 *
 * Smoothstep rather than a linear ramp: a linear one puts a visible line across
 * the ground where the effect starts, because the eye finds the discontinuity in
 * the *slope* even when the value is continuous.
 */
export function inkAmount(depth: number, start: number, end: number): number {
  if (!(end > start)) return depth >= end ? 1 : 0;
  const t = Math.min(1, Math.max(0, (depth - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

/**
 * Push a colour toward a fixed luminance, keeping its hue and chroma.
 *
 * `amount` 0 leaves it alone, 1 gives every pixel the same luminance -- which is
 * a surface with no shading gradient at all, single-toned and bounded only by
 * whatever line is drawn over it.
 */
export function flattenLuma(c: Rgb, target: number, amount: number): Rgb {
  const lum = luminance(c);
  if (lum < MIN_LUMA) return c;
  const scale = 1 + amount * (target / lum - 1);
  return [c[0] * scale, c[1] * scale, c[2] * scale];
}

/** Drain a colour toward its own grey. */
export function desaturate(c: Rgb, amount: number): Rgb {
  const grey = luminance(c);
  return [
    c[0] + (grey - c[0]) * amount,
    c[1] + (grey - c[1]) * amount,
    c[2] + (grey - c[2]) * amount,
  ];
}

/** Mix a colour toward the sky. */
export function towardFog(c: Rgb, fog: Rgb, amount: number): Rgb {
  return [
    c[0] + (fog[0] - c[0]) * amount,
    c[1] + (fog[1] - c[1]) * amount,
    c[2] + (fog[2] - c[2]) * amount,
  ];
}

/** The knobs the treatment reads, all of them from the config object. */
export interface InkSettings {
  readonly inkStart: number;
  readonly inkEnd: number;
  readonly inkFlatten: number;
  readonly inkDesaturate: number;
  readonly inkFog: number;
}

/**
 * The whole treatment for one fill pixel, at depth `depth`.
 *
 * Flatten, then desaturate, then fog -- in that order and not another. Flattening
 * first is what removes the gradient while there is still chroma to hold onto;
 * doing it after desaturating would be scaling a grey, which is the same
 * operation as fogging and wastes one of the three. Fog last because it is the
 * only one that introduces a colour from outside the pixel, and anything applied
 * after it would be operating on the sky rather than on the surface.
 */
export function inkFill(
  c: Rgb,
  fog: Rgb,
  depth: number,
  target: number,
  settings: InkSettings,
): Rgb {
  const t = inkAmount(depth, settings.inkStart, settings.inkEnd);
  if (t <= 0) return c;
  let out = flattenLuma(c, target, t * settings.inkFlatten);
  out = desaturate(out, t * settings.inkDesaturate);
  return towardFog(out, fog, t * settings.inkFog);
}

/**
 * The GLSL for the above, for the retro pass to splice in ahead of its grade.
 *
 * Mirrors the TypeScript term for term; `ink.test.ts` holds the two together.
 */
export function glslInkChunk(): string {
  return /* glsl */ `
const vec3 INK_LUMA = vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]});

// Smoothstep, not a ramp: a linear one leaves a visible line across the ground
// where the effect starts, because the eye finds the break in the slope.
float inkAmount(float depth, float start, float end) {
  if (end <= start) return depth >= end ? 1.0 : 0.0;
  float t = clamp((depth - start) / (end - start), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// Hold hue and chroma, push luminance toward a constant. A surface whose pixels
// share a luminance has no gradient left, which is what "flat" is for here.
vec3 flattenLuma(vec3 c, float target, float amount) {
  float lum = dot(c, INK_LUMA);
  if (lum < ${MIN_LUMA}) return c;
  return c * (1.0 + amount * (target / lum - 1.0));
}

vec3 inkFill(vec3 c, vec3 fog, float depth, float target,
             float start, float end, float flatten, float desat, float fogAmount) {
  float t = inkAmount(depth, start, end);
  if (t <= 0.0) return c;
  vec3 out0 = flattenLuma(c, target, t * flatten);
  out0 = mix(out0, vec3(dot(out0, INK_LUMA)), t * desat);
  return mix(out0, fog, t * fogAmount);
}
`;
}
