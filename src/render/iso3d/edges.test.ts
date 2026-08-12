import { describe, expect, it } from 'vitest';
import { glslEdgeChunk, normalRobertsCross, planeDeviation, robertsCross, type ViewPoint } from './edges.js';

/**
 * A point on a plane through `origin` with view-space `normal`, at screen offset
 * (x, y). Depth runs along -z, so a point at distance d sits at z = -d.
 */
function onPlane(
  normal: readonly [number, number, number],
  origin: ViewPoint,
  x: number,
  y: number,
): ViewPoint {
  const [nx, ny, nz] = normal;
  const dot = nx * origin.x + ny * origin.y + nz * -origin.depth;
  const depth = (nx * x + ny * y - dot) / nz;
  return { x, y, depth };
}

const unit = (v: readonly [number, number, number]): readonly [number, number, number] => {
  const len = Math.hypot(...v);
  return [v[0] / len, v[1] / len, v[2] / len];
};

describe('planeDeviation', () => {
  it('is zero for a surface square to the camera', () => {
    const n: readonly [number, number, number] = [0, 0, 1];
    const neighbour: ViewPoint = { x: 10, y: 4, depth: 500 };
    const centre = onPlane(n, neighbour, 12, 4);
    expect(planeDeviation(centre, neighbour, n)).toBeCloseTo(0, 9);
  });

  it('is zero for a steeply angled surface, which is the whole point', () => {
    // Ground seen at a glancing angle changes depth fast across the screen with
    // no edge present. A raw depth difference would call this an edge everywhere;
    // measured against the neighbour's own plane it is flat, because it is.
    for (const tilt of [0.2, 0.5, 0.8, 0.95]) {
      const n = unit([0, tilt, Math.sqrt(1 - tilt * tilt)]);
      const neighbour: ViewPoint = { x: -30, y: 20, depth: 900 };
      for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1], [3, 0]] as const) {
        const centre = onPlane(n, neighbour, neighbour.x + dx, neighbour.y + dy);
        expect(planeDeviation(centre, neighbour, n)).toBeCloseTo(0, 6);
      }
    }
  });

  it('reports a step at its true size in world units', () => {
    // The claim that makes the threshold meaningful: 6 units of step reads as 6,
    // wherever it is in the frame and whatever the surface is doing.
    const n: readonly [number, number, number] = [0, 0, 1];
    const neighbour: ViewPoint = { x: 0, y: 0, depth: 400 };
    for (const step of [1, 6, 40]) {
      const centre = onPlane(n, neighbour, 1, 1);
      const stepped: ViewPoint = { ...centre, depth: centre.depth + step };
      expect(planeDeviation(stepped, neighbour, n)).toBeCloseTo(step, 9);
    }
  });

  it('reads the same at the front of the map as at the back', () => {
    // No perspective divide, so no depth-dependent scaling. This is the property
    // the orthographic camera buys and the reason one threshold is enough.
    const n = unit([0.3, 0.4, 0.86]);
    const near: ViewPoint = { x: 0, y: 0, depth: 100 };
    const far: ViewPoint = { x: 0, y: 0, depth: 8000 };
    const stepAt = (base: ViewPoint): number => {
      const centre = onPlane(n, base, 2, -1);
      return planeDeviation({ ...centre, depth: centre.depth + 6 }, base, n);
    };
    expect(stepAt(near)).toBeCloseTo(6, 6);
    expect(stepAt(far)).toBeCloseTo(6, 6);
  });

  it('signs a step toward the camera opposite to one away from it', () => {
    // Signed, so a Roberts cross over the result cancels on a smooth ramp instead
    // of accumulating.
    const n: readonly [number, number, number] = [0, 0, 1];
    const neighbour: ViewPoint = { x: 0, y: 0, depth: 300 };
    const flat = onPlane(n, neighbour, 1, 0);
    expect(planeDeviation({ ...flat, depth: flat.depth + 5 }, neighbour, n)).toBeGreaterThan(0);
    expect(planeDeviation({ ...flat, depth: flat.depth - 5 }, neighbour, n)).toBeLessThan(0);
  });

  it('declines to answer for a surface turned edge-on', () => {
    // Its plane is parallel to the view direction, so the reconstruction divides
    // by almost nothing and invents a number. Left to the normal term, which is
    // exactly the case that one is good at.
    const edgeOn: readonly [number, number, number] = [1, 0, 0];
    const neighbour: ViewPoint = { x: 0, y: 0, depth: 300 };
    expect(planeDeviation({ x: 1, y: 0, depth: 900 }, neighbour, edgeOn)).toBe(0);
  });
});

describe('robertsCross', () => {
  it('takes the larger diagonal, never the sum', () => {
    // A corner fires on both diagonals. Summing scores it twice an edge, so any
    // threshold that keeps edges thin blobs the corners.
    const corner = robertsCross(1, 0, 1, 0);
    const edge = robertsCross(1, 0, 0, 0);
    expect(corner).toBe(1);
    expect(edge).toBe(1);
    expect(corner).toBe(edge);
  });

  it('is zero on a field that is not changing', () => {
    expect(robertsCross(3, 3, 3, 3)).toBe(0);
  });

  it('cancels on a smooth ramp, because the deviations are signed', () => {
    // Opposite corners of a ramp deviate by equal and opposite amounts.
    expect(robertsCross(0, 0, 0.2, 0.2)).toBeCloseTo(0, 12);
  });

  it('is symmetric in each diagonal', () => {
    expect(robertsCross(2, 5, 1, 1)).toBe(robertsCross(5, 2, 1, 1));
  });
});

describe('normalRobertsCross', () => {
  const up: readonly [number, number, number] = [0, 1, 0];
  const at: readonly [number, number, number] = [0, 0, 1];

  it('is zero across a surface with one normal', () => {
    expect(normalRobertsCross(up, up, up, up)).toBe(0);
  });

  it('grows with the angle between the diagonals', () => {
    const slight = normalRobertsCross(at, unit([0.1, 0, 1]), at, at);
    const sharp = normalRobertsCross(at, up, at, at);
    expect(sharp).toBeGreaterThan(slight);
  });

  it('reaches 2 for opposed normals, so the threshold has a known range', () => {
    expect(normalRobertsCross(at, [0, 0, -1], at, at)).toBeCloseTo(2, 9);
  });

  it('takes the larger diagonal here too', () => {
    expect(normalRobertsCross(at, up, at, at)).toBe(normalRobertsCross(at, at, at, up));
  });
});

describe('glslEdgeChunk', () => {
  it('declares what the pass calls', () => {
    const glsl = glslEdgeChunk();
    expect(glsl).toContain('float planeDeviation(');
    expect(glsl).toContain('float robertsCross(');
    expect(glsl).toContain('float normalRobertsCross(');
  });

  it('combines with max, in both crosses', () => {
    // The one line whose alternative -- a sum -- compiles perfectly and looks
    // almost right.
    expect(glslEdgeChunk()).toContain('return max(abs(a - b), abs(c - d));');
    expect(glslEdgeChunk()).toContain('return max(length(a - b), length(c - d));');
  });

  it('reconstructs the plane the same way the reference does', () => {
    expect(glslEdgeChunk()).toContain('float d = dot(normal, vec3(nXY, -nDepth));');
    expect(glslEdgeChunk()).toContain('/ normal.z');
  });
});
