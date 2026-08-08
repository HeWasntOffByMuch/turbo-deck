/**
 * Triplanar projection weights, and the slope/height blend the ground's material
 * boundary is softened with (spec 102).
 *
 * Pure -- no three.js and no DOM -- and the GLSL below is a transcription of the
 * functions above it, held together by `surface-detail.test.ts`. Same arrangement
 * as `wind.ts` and `ink.ts`: a shader expression nobody can execute is where a
 * typo lives forever.
 */

/** How hard a surface commits to one projection axis, by default. */
export const DEFAULT_TRIPLANAR_SHARPNESS = 4;

/**
 * How much of each axis-aligned projection a surface with this normal takes.
 *
 * `pow(|n|, sharpness)`, normalized to sum to one. A vertical cliff has almost no
 * y component, so it is sampled from the two horizontal projections and never
 * from the one that would smear a single row of texels down its whole height --
 * which is the entire reason triplanar exists and the thing a ground-plane UV
 * gets wrong.
 *
 * Total: a zero normal (a degenerate triangle, which this terrain does produce at
 * a layer's edge) would otherwise divide by zero and paint the surface black.
 */
export function triplanarWeights(
  nx: number,
  ny: number,
  nz: number,
  sharpness: number = DEFAULT_TRIPLANAR_SHARPNESS,
): readonly [number, number, number] {
  const wx = Math.pow(Math.abs(nx), sharpness);
  const wy = Math.pow(Math.abs(ny), sharpness);
  const wz = Math.pow(Math.abs(nz), sharpness);
  const total = wx + wy + wz;
  if (!(total > 0)) return [1 / 3, 1 / 3, 1 / 3];
  return [wx / total, wy / total, wz / total];
}

/** Everything the ground's material boundary is drawn from. */
export interface BlendSettings {
  /** Cosine of the slope past which ground reads as rock. 1 is flat, 0 is vertical. */
  readonly slopeStart: number;
  /** Cosine at which it is entirely rock. Below `slopeStart`. */
  readonly slopeEnd: number;
  /** Height at which the height term begins to contribute, world units. */
  readonly heightStart: number;
  /** Height at which the height term is fully on. */
  readonly heightEnd: number;
  /**
   * How far the noise displaces the boundary, as a fraction of the ramp.
   *
   * Bounded by what keeps flat ground flat, and the arithmetic is worth writing
   * down because it is the one relationship between these settings that is not
   * obvious. The displacement is `noise * (slopeStart - slopeEnd)`; ground with no
   * slope at all sits at `normalY = 1`, which is `1 - slopeStart` above the top of
   * the ramp. So dead-flat ground stays soil exactly while
   *
   *   noise <= (1 - slopeStart) / (slopeStart - slopeEnd)
   *
   * which at the shipped 0.85 and 0.5 is 0.43. The panel's slider stops at 0.4.
   * Past it a meadow grows patches of stone, which is not a subtle artefact but
   * does look like a plausible amount of noise until something counts pixels.
   */
  readonly noise: number;
}

/** The largest `noise` that leaves dead-flat ground untouched, for these ramps. */
export function maxNoiseForFlatGround(slopeStart: number, slopeEnd: number): number {
  const ramp = slopeStart - slopeEnd;
  if (!(ramp > 0)) return 0;
  return Math.max(0, (1 - slopeStart) / ramp);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!(edge1 > edge0)) return x >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * How much rock a piece of ground shows, from 0 (soil) to 1 (bare stone).
 *
 * Steep because soil does not sit on a steep face, high because weather strips
 * it -- and displaced by `noise`, which is the part that matters. A pure slope
 * threshold draws a contour line on a heightfield, and a contour line is as
 * regular as the lattice it came from; noise turns it into an edge that follows
 * the terrain without announcing the sampling.
 *
 * `noiseValue` is expected in [0, 1] and is centred here, so noise displaces the
 * boundary in both directions rather than only pushing it one way.
 */
export function rockBlend(
  normalY: number,
  height: number,
  noiseValue: number,
  settings: BlendSettings,
): number {
  const shift = (noiseValue - 0.5) * 2 * settings.noise;
  // Slope: normalY falls from 1 (flat) toward 0 (vertical), so the ramp runs
  // downward and the shift is subtracted to move the boundary the same way it
  // moves the height one.
  //
  // Scaled by the ramp's own width, which is what "a fraction of the ramp" means
  // and what the height term below already did. Applied in absolute normal units
  // instead, a quarter of noise displaced the boundary by 0.25 against a ramp
  // 0.35 wide -- enough to reach ground that is dead flat, so a meadow grew
  // patches of bare stone. It looked like a plausible amount of noise, which is
  // why it needed a pixel count to catch.
  const slopeRamp = settings.slopeStart - settings.slopeEnd;
  const slope = smoothstep(settings.slopeEnd, settings.slopeStart, normalY - shift * slopeRamp);
  const tall = smoothstep(settings.heightStart, settings.heightEnd, height + shift * (settings.heightEnd - settings.heightStart));
  // Either reason is enough for bare rock: a cliff at sea level and a bald
  // summit are both stone, and requiring both would leave each of them soil.
  return Math.min(1, Math.max(0, Math.max(1 - slope, tall)));
}

/**
 * The GLSL for both, for the ground materials to splice in.
 *
 * `triplanarDetail` samples the tile three times and blends by the weights, which
 * is the whole cost of the technique: three texture reads where a UV mapping
 * takes one.
 */
export function glslSurfaceDetail(): string {
  return /* glsl */ `
vec3 triplanarWeights(vec3 n, float sharpness) {
  vec3 w = pow(abs(n), vec3(sharpness));
  float total = w.x + w.y + w.z;
  // A degenerate normal would divide by zero and paint the surface black; this
  // terrain does produce them at a layer's edge.
  if (total <= 0.0) return vec3(0.3333333, 0.3333333, 0.3333333);
  return w / total;
}

float triplanarDetail(sampler2D tile, vec3 worldPos, vec3 worldNormal, float scale, float sharpness) {
  vec3 w = triplanarWeights(worldNormal, sharpness);
  float sx = texture2D(tile, worldPos.zy * scale).r;
  float sy = texture2D(tile, worldPos.xz * scale).r;
  float sz = texture2D(tile, worldPos.xy * scale).r;
  return sx * w.x + sy * w.y + sz * w.z;
}

// Steep because soil does not sit on a steep face, high because weather strips
// it, and displaced by noise so the boundary is not a contour line on a lattice.
float rockBlend(float normalY, float height, float noiseValue,
                float slopeStart, float slopeEnd,
                float heightStart, float heightEnd, float noiseAmount) {
  float shift = (noiseValue - 0.5) * 2.0 * noiseAmount;
  // Scaled by the ramp's width, so the setting is a fraction of it and cannot
  // drag dead-flat ground across the boundary.
  float slope = smoothstep(slopeEnd, slopeStart, normalY - shift * (slopeStart - slopeEnd));
  float tall = smoothstep(heightStart, heightEnd, height + shift * (heightEnd - heightStart));
  return clamp(max(1.0 - slope, tall), 0.0, 1.0);
}
`;
}
