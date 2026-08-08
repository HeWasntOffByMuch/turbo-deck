/**
 * Finding outlines in the depth and normal buffers (spec 097).
 *
 * Pure -- no three.js and no DOM -- so the two expressions that are easy to get
 * silently wrong can be run against numbers instead of eyeballed in a frame.
 * `glslEdgeChunk()` is the transcription the pass actually executes, held to the
 * same answers by `edges.test.ts`.
 *
 * ## Why the depth test reconstructs a plane
 *
 * The obvious depth edge test is "did depth change more than a threshold between
 * neighbouring pixels", and it does not work. Ground seen at a glancing angle --
 * which, in an isometric view, is most of the ground -- changes depth fast across
 * the screen with no edge present at all, so any threshold low enough to catch a
 * real step draws lines all over the hillsides, and any threshold high enough to
 * leave the hillsides alone misses the steps.
 *
 * So the comparison is not against the neighbour's depth but against the *plane*
 * the neighbour lies in: take its normal and its depth, extend that surface to
 * this pixel, and ask how far the actual depth here is from where the surface
 * said it would be. On any flat surface, at any angle, that deviation is zero.
 * At a genuine discontinuity it is the size of the step. Which is what makes a
 * single threshold, in world units, mean the same thing everywhere in the frame.
 *
 * ## Why one threshold is enough
 *
 * Because the camera is orthographic. There is no perspective divide, so depth is
 * linear in world units from near to far and a step of 6 units reads as 6 units
 * whether it is at the player's feet or at the back of the map. Under a
 * perspective camera the same threshold would have to be scaled by depth, which
 * is where the usual pile of tuning constants comes from. This is the one place
 * the projection makes life simpler, and it is worth taking.
 */

/** A point on the screen, in view-space world units from the view axis. */
export interface ViewPoint {
  /** Horizontal and vertical offset from the centre of the frame, world units. */
  readonly x: number;
  readonly y: number;
  /** Distance along the view axis, world units. Always positive. */
  readonly depth: number;
}

/**
 * Below this, a surface is edge-on to the camera and its plane says nothing about
 * what depth a neighbouring pixel should have -- the plane is parallel to the
 * view direction, so the reconstruction divides by almost nothing and produces an
 * arbitrarily large answer.
 *
 * Those pixels are left to the normal term, which is exactly the case it is good
 * at: a surface turned edge-on is a surface whose normal differs sharply from
 * whatever is beside it.
 */
const MIN_FACING = 1e-3;

/**
 * How far `centre` sits from the plane `neighbour` lies in, in world units along
 * the view axis.
 *
 * Signed, so that a Roberts cross over the result can tell a step up from a step
 * down and cancel on a smooth ramp. Zero on any flat surface however steeply it
 * is angled, which is the entire point.
 *
 * `normal` is the neighbour's view-space normal, where +z points at the camera.
 */
export function planeDeviation(
  centre: ViewPoint,
  neighbour: ViewPoint,
  normal: readonly [number, number, number],
): number {
  const [nx, ny, nz] = normal;
  if (Math.abs(nz) < MIN_FACING) return 0;

  // The neighbour's view-space position. Depth runs along -z, so a point at
  // distance d sits at z = -d.
  const dot = nx * neighbour.x + ny * neighbour.y + nz * -neighbour.depth;
  // Solve dot(normal, (centre.x, centre.y, -t)) = dot for t: the depth this
  // surface would have here if it simply carried on.
  const expected = (nx * centre.x + ny * centre.y - dot) / nz;
  return centre.depth - expected;
}

/**
 * The Roberts cross of four diagonal samples: the larger of the two diagonal
 * differences.
 *
 * `max` rather than a sum or a length, and that is the whole reason to say so
 * out loud. Adding the two diagonals means a corner -- where both of them fire --
 * scores twice as high as an edge, so any threshold that keeps the edges thin
 * blobs the corners, and any threshold that keeps the corners tight loses the
 * edges. Taking the larger leaves both at the same strength.
 *
 * Arguments are the two diagonal pairs: (a, b) is one diagonal and (c, d) the
 * other.
 */
export function robertsCross(a: number, b: number, c: number, d: number): number {
  return Math.max(Math.abs(a - b), Math.abs(c - d));
}

/**
 * The Roberts cross over four normals, as the larger of the two diagonal
 * distances.
 *
 * Distance between unit vectors rather than the angle between them: it is
 * monotonic in the angle, so a threshold on one is a threshold on the other, and
 * it costs a subtract instead of an inverse cosine per tap.
 */
export function normalRobertsCross(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  d: readonly [number, number, number],
): number {
  const dist = (
    p: readonly [number, number, number],
    q: readonly [number, number, number],
  ): number => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  return Math.max(dist(a, b), dist(c, d));
}

/**
 * The GLSL the edge pass runs, mirroring the functions above term for term.
 *
 * Needs `decodeOctahedral` in scope -- the pass emits `glslOctahedralChunk()`
 * before this.
 */
export function glslEdgeChunk(): string {
  return /* glsl */ `
// See planeDeviation in edges.ts. Signed, and zero on a flat surface at any
// angle -- which is what lets one world-unit threshold serve the whole frame.
float planeDeviation(vec2 centreXY, float centreDepth, vec2 nXY, float nDepth, vec3 normal) {
  if (abs(normal.z) < ${MIN_FACING}) return 0.0;
  float d = dot(normal, vec3(nXY, -nDepth));
  float expected = (normal.x * centreXY.x + normal.y * centreXY.y - d) / normal.z;
  return centreDepth - expected;
}

// The larger of the two diagonals, never their sum: a corner fires on both, and
// adding them makes every corner twice an edge and therefore blobby.
float robertsCross(float a, float b, float c, float d) {
  return max(abs(a - b), abs(c - d));
}

float normalRobertsCross(vec3 a, vec3 b, vec3 c, vec3 d) {
  return max(length(a - b), length(c - d));
}
`;
}
