import { describe, expect, it } from 'vitest';
import {
  CAVITY_FULL_TURN,
  cavityShade,
  cellCavity,
  cellTurn,
  edgeCurvature,
  type CornerSample,
} from './curvature.js';

/**
 * A corner of the paraboloid `y = curve * (x² + z²)`, in world coordinates, with
 * the normal that surface actually has there.
 *
 * A real surface rather than hand-written normals, because the whole measure is a
 * claim about how normals vary over a surface: fixtures with invented normals can
 * be made to prove anything, and a sign error would survive them.
 *
 * `curve > 0` is a bowl (concave up, a hollow); `curve < 0` is a dome.
 */
function paraboloid(x: number, z: number, curve: number): CornerSample {
  // dy/dx = 2*curve*x, dy/dz = 2*curve*z; the upward normal is (-dy/dx, 1, -dy/dz).
  const nx = -2 * curve * x;
  const nz = -2 * curve * z;
  const length = Math.hypot(nx, 1, nz);
  return {
    x,
    y: curve * (x * x + z * z),
    z,
    nx: nx / length,
    ny: 1 / length,
    nz: nz / length,
  };
}

/** The four corners of the `size`-wide cell whose near corner is (x0, z0). */
function cell(
  x0: number,
  z0: number,
  size: number,
  curve: number,
): [CornerSample, CornerSample, CornerSample, CornerSample] {
  return [
    paraboloid(x0, z0, curve),
    paraboloid(x0 + size, z0, curve),
    paraboloid(x0, z0 + size, curve),
    paraboloid(x0 + size, z0 + size, curve),
  ];
}

const FLAT: CornerSample = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };

describe('edgeCurvature', () => {
  it('is zero across a flat span, whatever the span is', () => {
    const a = { ...FLAT };
    const b = { ...FLAT, x: 7, z: -3 };
    expect(edgeCurvature(a, b)).toBe(0);
  });

  it('refuses a degenerate edge rather than dividing by zero', () => {
    // Not hypothetical: the sampler jitters every corner off the lattice, and a
    // cell at a layer's edge can collapse.
    expect(edgeCurvature(FLAT, { ...FLAT })).toBe(0);
    expect(Number.isFinite(edgeCurvature(FLAT, { ...FLAT, nx: 1, ny: 0 }))).toBe(true);
  });
});

describe('cellTurn', () => {
  it('is exactly zero on a plane, at any tilt', () => {
    // A slope is not a fold. If this were nonzero every hillside in the world
    // would darken, which is the failure that would look most like "the effect
    // is working" from a distance.
    for (const [nx, ny, nz] of [[0, 1, 0], [0.6, 0.8, 0], [0.3, 0.9, -0.3]] as const) {
      const length = Math.hypot(nx, ny, nz);
      const n = { nx: nx / length, ny: ny / length, nz: nz / length };
      const plane = (x: number, z: number): CornerSample => ({
        x,
        z,
        // On the plane through the origin with this normal.
        y: -(n.nx * x + n.nz * z) / n.ny,
        ...n,
      });
      const turn = cellTurn(plane(0, 0), plane(10, 0), plane(0, 10), plane(10, 10), 10);
      expect(turn).toBeCloseTo(0, 12);
    }
  });

  it('is negative in a hollow and positive on a dome', () => {
    // The sign, asserted against a real surface. Backwards, this shades the
    // ridges instead of the hollows -- which still looks like curvature shading,
    // just lit from somewhere impossible.
    expect(cellTurn(...cell(-0.5, -0.5, 1, 0.05), 1)).toBeLessThan(0);
    expect(cellTurn(...cell(-0.5, -0.5, 1, -0.05), 1)).toBeGreaterThan(0);
  });

  it('measures the same fold the same way at any cell size', () => {
    // The *same fold*, meaning the whole world scaled up: doubling the spacing
    // halves the surface's curvature coefficient. Note this is not invariance to
    // sampling a fixed surface more coarsely -- that genuinely does turn more per
    // cell, and the measure is per cell on purpose.
    const fine = cellTurn(...cell(-0.5, -0.5, 1, 0.05), 1);
    const coarse = cellTurn(...cell(-1, -1, 2, 0.025), 2);
    expect(coarse).toBeCloseTo(fine, 6);
  });

  it('grows with the depth of the fold', () => {
    const shallow = Math.abs(cellTurn(...cell(-0.5, -0.5, 1, 0.02), 1));
    const deep = Math.abs(cellTurn(...cell(-0.5, -0.5, 1, 0.2), 1));
    expect(deep).toBeGreaterThan(shallow * 5);
  });

  it('reads a fold running diagonally across the cell', () => {
    // Averaged over four edges rather than taken from one, so a crease that does
    // not happen to run along the grid still registers.
    const diagonal = (x: number, z: number): CornerSample => {
      // A trough along x = z: y = (x - z)^2 / 4.
      const d = (x - z) / 2;
      const nx = -d;
      const nz = d;
      const length = Math.hypot(nx, 1, nz);
      return { x, y: d * d, z, nx: nx / length, ny: 1 / length, nz: nz / length };
    };
    const turn = cellTurn(diagonal(0, 0), diagonal(1, 0), diagonal(0, 1), diagonal(1, 1), 1);
    expect(turn).toBeLessThan(-0.1);
  });
});

describe('cellCavity', () => {
  it('is zero on flat ground and on a ridge', () => {
    expect(cellCavity(FLAT, { ...FLAT, x: 1 }, { ...FLAT, z: 1 }, { ...FLAT, x: 1, z: 1 }, 1)).toBe(0);
    expect(cellCavity(...cell(-0.5, -0.5, 1, -0.05), 1)).toBe(0);
  });

  it('rises with the fold and saturates at one', () => {
    const shallow = cellCavity(...cell(-0.5, -0.5, 1, 0.02), 1);
    const deep = cellCavity(...cell(-0.5, -0.5, 1, 0.1), 1);
    expect(shallow).toBeGreaterThan(0);
    expect(deep).toBeGreaterThan(shallow);
    expect(cellCavity(...cell(-0.5, -0.5, 1, 5), 1)).toBe(1);
  });

  it('reaches full strength at the documented turn', () => {
    // The reference is a number in the spec, so it is worth one assertion that
    // the code agrees with what is written down.
    const corners = cell(-0.5, -0.5, 1, 0.05);
    const turn = cellTurn(...corners, 1);
    expect(cellCavity(...corners, 1, -turn)).toBe(1);
    expect(cellCavity(...corners, 1, CAVITY_FULL_TURN)).toBeCloseTo(-turn / CAVITY_FULL_TURN, 12);
  });

  it('survives a zero reference without producing a NaN', () => {
    expect(cellCavity(...cell(-0.5, -0.5, 1, 0.05), 1, 0)).toBe(0);
  });
});

describe('the chunk boundary', () => {
  it('measures a cell identically from either side of a seam', () => {
    // The seam claim, asserted rather than argued. A chunk's corner grid is one
    // wider than its cell grid, so corners on a boundary are stored by both
    // chunks that share them -- which means a cell's four corners are always
    // inside its own chunk and the arithmetic cannot depend on which chunk it
    // arrived in.
    //
    // Simulated the way it actually happens: two Float32Arrays holding the same
    // corner values at different offsets, because the real inputs are Float32 and
    // a comparison done in doubles would hide a rounding difference that the game
    // would show.
    const corners = cell(-0.5, -0.5, 1, 0.05);
    const pack = (offset: number): Float32Array => {
      const out = new Float32Array((offset + 4) * 6);
      corners.forEach((c, i) => {
        out.set([c.x, c.y, c.z, c.nx, c.ny, c.nz], (offset + i) * 6);
      });
      return out;
    };
    const unpack = (buffer: Float32Array, index: number): CornerSample => ({
      x: buffer[index * 6] ?? 0,
      y: buffer[index * 6 + 1] ?? 0,
      z: buffer[index * 6 + 2] ?? 0,
      nx: buffer[index * 6 + 3] ?? 0,
      ny: buffer[index * 6 + 4] ?? 0,
      nz: buffer[index * 6 + 5] ?? 0,
    });

    const left = pack(0);
    const right = pack(9);
    const fromLeft = cellCavity(unpack(left, 0), unpack(left, 1), unpack(left, 2), unpack(left, 3), 22);
    const fromRight = cellCavity(unpack(right, 9), unpack(right, 10), unpack(right, 11), unpack(right, 12), 22);
    expect(fromLeft).toBe(fromRight);
    expect(fromLeft).toBeGreaterThan(0);
  });
});

describe('cavityShade', () => {
  it('leaves flat ground exactly alone', () => {
    expect(cavityShade(0, 1)).toBe(1);
    expect(cavityShade(0.7, 0)).toBe(1);
  });

  it('darkens in proportion to strength', () => {
    expect(cavityShade(1, 0.35)).toBeCloseTo(0.65, 12);
    expect(cavityShade(0.5, 0.4)).toBeCloseTo(0.8, 12);
  });

  it('never brightens, whatever it is handed', () => {
    for (const cavity of [-3, -0.1, 0, 0.5, 1, 4]) {
      expect(cavityShade(cavity, 0.5)).toBeLessThanOrEqual(1);
      expect(cavityShade(cavity, 0.5)).toBeGreaterThanOrEqual(0.5);
    }
  });
});
