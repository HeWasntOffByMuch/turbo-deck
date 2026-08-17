/**
 * What makes a brush mark a brush mark (spec 158).
 *
 * Every assertion here is against the *silhouette* rather than against the
 * buffers, because the silhouette is the whole claim. `position` holds the spine
 * and the outline is put back by `strokeOutline` -- the same expression the
 * shader computes before it adds its own per-instance layer -- so these hold the
 * shape the GPU will actually draw, in Node, with no canvas.
 *
 * The failure this file exists to catch is the common procedural-VFX one: a
 * stroke that is really a tapered rectangle with some noise on it. A tapered
 * rectangle passes "it has a width curve" and "it has vertices" and every other
 * check somebody writes by looking at the code rather than at the shape.
 */

import { describe, expect, it } from 'vitest';
import {
  brushStrokeMesh,
  strokeNodes,
  strokeOutline,
  strokeWidthAt,
  STROKE_DEFAULTS,
  STROKE_UV_STRIDE,
  type StrokeMeshData,
} from './stroke.js';

/** Half-widths per node, left and right, as positive magnitudes. */
function halves(mesh: StrokeMeshData): { left: number[]; right: number[] } {
  const nodes = strokeNodes(mesh);
  const left: number[] = [];
  const right: number[] = [];
  for (let n = 0; n < nodes; n++) {
    left.push(Math.abs(mesh.strokeUv[n * 2 * STROKE_UV_STRIDE + 1] ?? 0));
    right.push(Math.abs(mesh.strokeUv[(n * 2 + 1) * STROKE_UV_STRIDE + 1] ?? 0));
  }
  return { left, right };
}

function widths(mesh: StrokeMeshData): number[] {
  const nodes = strokeNodes(mesh);
  const out: number[] = [];
  for (let n = 0; n < nodes; n++) out.push(strokeWidthAt(mesh, n));
  return out;
}

describe('brushStrokeMesh', () => {
  it('builds exactly the geometry its segment count implies', () => {
    for (const segments of [4, 7, 12]) {
      const mesh = brushStrokeMesh({ segments });
      const nodes = segments + 1;
      expect(strokeNodes(mesh)).toBe(nodes);
      expect(mesh.positions.length).toBe(nodes * 2 * 3);
      expect(mesh.normals.length).toBe(nodes * 2 * 3);
      expect(mesh.strokeUv.length).toBe(nodes * 2 * STROKE_UV_STRIDE);
      expect(mesh.indices.length).toBe(segments * 6);
      for (const index of mesh.indices) expect(index).toBeLessThan(nodes * 2);
    }
  });

  it('runs `along` from 0 to 1, up, once, and gives every vertex a unit side', () => {
    const mesh = brushStrokeMesh({ segments: 9 });
    const nodes = strokeNodes(mesh);
    let previous = -1;
    for (let n = 0; n < nodes; n++) {
      for (const edge of [0, 1]) {
        const at = (n * 2 + edge) * STROKE_UV_STRIDE;
        const along = mesh.strokeUv[at] ?? -1;
        expect(along).toBeCloseTo(n / (nodes - 1), 6);
        const sideLength = Math.hypot(mesh.strokeUv[at + 2] ?? 0, mesh.strokeUv[at + 3] ?? 0);
        expect(sideLength).toBeCloseTo(1, 5);
      }
      const along = mesh.strokeUv[n * 2 * STROKE_UV_STRIDE] ?? -1;
      expect(along).toBeGreaterThan(previous);
      previous = along;
    }
    expect(previous).toBeCloseTo(1, 6);
  });

  it('is not a rectangle: the width moves along the mark', () => {
    // The one assertion the failure mode this file exists for cannot pass with a
    // constant-width band, whatever noise is on its edges.
    const w = widths(brushStrokeMesh({ segments: 12 }));
    const interior = w.slice(1, -1);
    const min = Math.min(...interior);
    const max = Math.max(...interior);
    expect(min).toBeGreaterThan(0);
    expect(max / min).toBeGreaterThan(1.6);
  });

  it('is not symmetric: the two edges are drawn from different noise', () => {
    // Mirrored edges are what make a hand-drawn shape look machined, and they
    // are also what you get for free if the width is one number per node.
    const { left, right } = halves(brushStrokeMesh({ segments: 14 }));
    let disagreements = 0;
    let worst = 0;
    for (let n = 1; n < left.length - 1; n++) {
      const a = left[n] ?? 0;
      const b = right[n] ?? 0;
      const scale = Math.max(a, b, 1e-6);
      const relative = Math.abs(a - b) / scale;
      worst = Math.max(worst, relative);
      if (relative > 0.06) disagreements += 1;
    }
    expect(worst).toBeGreaterThan(0.15);
    expect(disagreements).toBeGreaterThan(left.length * 0.3);
  });

  it('is fattest near its shoulder rather than at its middle or its butt', () => {
    const mesh = brushStrokeMesh({ segments: 16, shoulder: 0.18, jagged: 0, edgeNoise: 0.05, skips: 0 });
    const w = widths(mesh);
    let peak = 0;
    for (let n = 1; n < w.length; n++) if ((w[n] ?? 0) > (w[peak] ?? 0)) peak = n;
    const at = peak / (w.length - 1);
    // Off the very end, and well short of halfway: a brush touches down thin,
    // swells where the bristles bed in, and runs out from there.
    expect(at).toBeGreaterThan(0.05);
    expect(at).toBeLessThan(0.4);
  });

  it('tapers, for every seed', () => {
    // Fifty rather than one, because "it tapers" is a claim about the family and
    // a single seed that happens to taper says nothing about the next one.
    for (let seed = 1; seed <= 50; seed++) {
      const w = widths(brushStrokeMesh({ seed, segments: 12 }));
      const nodes = w.length;
      const early = w.slice(1, Math.max(2, Math.round(nodes * 0.25)));
      const late = w.slice(Math.round(nodes * 0.9));
      const earlyMean = early.reduce((a, b) => a + b, 0) / early.length;
      const lateMean = late.reduce((a, b) => a + b, 0) / late.length;
      expect(lateMean, `seed ${seed}`).toBeLessThan(earlyMean * 0.5);
    }
  });

  it('bends, rather than running straight from butt to tip', () => {
    const mesh = brushStrokeMesh({ segments: 12 });
    const nodes = strokeNodes(mesh);
    const spineAt = (n: number): [number, number] => [
      mesh.positions[n * 2 * 3] ?? 0,
      mesh.positions[n * 2 * 3 + 1] ?? 0,
    ];
    const [x0, y0] = spineAt(0);
    const [x1, y1] = spineAt(nodes - 1);
    const [mx, my] = spineAt(Math.floor(nodes / 2));
    // Distance from the midpoint to the chord between the ends. A straight chain
    // gives zero and fails.
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy) || 1;
    const off = Math.abs((mx - x0) * dy - (my - y0) * dx) / length;
    expect(off).toBeGreaterThan(0.01);
  });

  it('has corners in its bend rather than a constant curvature', () => {
    // A smooth arc is a segment of a circle, and a segment of a circle is what a
    // swept quad already looks like. `kink` is what stops it being one; with the
    // kink off the second difference of the spine is nearly constant.
    const secondDifferences = (kink: number): number[] => {
      const mesh = brushStrokeMesh({ segments: 16, kink });
      const nodes = strokeNodes(mesh);
      const x = (n: number): number => mesh.positions[n * 2 * 3] ?? 0;
      const out: number[] = [];
      for (let n = 1; n < nodes - 1; n++) out.push(x(n + 1) - 2 * x(n) + x(n - 1));
      return out;
    };
    const spreadOf = (values: number[]): number => Math.max(...values) - Math.min(...values);
    expect(spreadOf(secondDifferences(0.02))).toBeGreaterThan(spreadOf(secondDifferences(0)) * 4);
  });

  it('breaks the mark where the bristles ran dry', () => {
    const body = (skips: number): number[] => {
      const mesh = brushStrokeMesh({ seed: 4242, segments: 24, skips });
      const nodes = strokeNodes(mesh);
      const out: number[] = [];
      // The body of the stroke only: the tip narrows anyway, and a test that
      // measured it would pass on the taper alone.
      for (let n = 0; n < nodes; n++) {
        const t = n / (nodes - 1);
        if (t >= 0.15 && t <= 0.72) out.push(strokeWidthAt(mesh, n));
      }
      return out;
    };
    const solid = body(0);
    const dry = body(3);
    const solidFloor = Math.min(...solid) / Math.max(...solid);
    const dryFloor = Math.min(...dry) / Math.max(...dry);
    expect(dryFloor).toBeLessThan(solidFloor * 0.5);
    expect(dryFloor).toBeLessThan(0.35);
  });

  it('is a pure function of its spec, and answers to the seed', () => {
    const a = brushStrokeMesh({ seed: 77 });
    const b = brushStrokeMesh({ seed: 77 });
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.strokeUv)).toEqual(Array.from(b.strokeUv));

    const other = brushStrokeMesh({ seed: 78 });
    expect(Array.from(other.strokeUv)).not.toEqual(Array.from(a.strokeUv));
  });

  it('draws a lens blunt at both ends and a taper pointed at one', () => {
    const lens = widths(brushStrokeMesh({ profile: 'lens', segments: 14, edgeNoise: 0.05, jagged: 0, skips: 0 }));
    const taper = widths(brushStrokeMesh({ profile: 'taper', segments: 14, edgeNoise: 0.05, jagged: 0, skips: 0 }));
    const tip = (w: number[]): number => (w[w.length - 1] ?? 0) / Math.max(1e-6, Math.max(...w));
    const butt = (w: number[]): number => (w[0] ?? 0) / Math.max(1e-6, Math.max(...w));
    // A dab has two blunt ends; a flick has a butt and a point. Measured at the
    // *tip*, because both profiles start off their peak and only one of them
    // runs out -- and running the fray on a lens gave every droplet a pointed
    // far end, which is a direction on the one shape that must not have one.
    expect(tip(lens)).toBeGreaterThan(0.3);
    expect(butt(lens)).toBeGreaterThan(0.3);
    expect(tip(taper)).toBeLessThan(0.1);
  });

  it('reaches further than it is wide, and stays inside its own unit box', () => {
    const mesh = brushStrokeMesh({ segments: 12 });
    const outline = strokeOutline(mesh);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let v = 0; v < outline.length / 2; v++) {
      const x = outline[v * 2] ?? 0;
      const y = outline[v * 2 + 1] ?? 0;
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    expect(maxY - minY).toBeGreaterThan((maxX - minX) * 2);
    // `iSize` is the mark's length, so anything much outside a unit box means a
    // stroke draws bigger than it says it is.
    expect(maxY - minY).toBeLessThan(1.2);
    expect(maxX - minX).toBeLessThan(1);
  });

  it('never produces a negative or non-finite half-width', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const mesh = brushStrokeMesh({ seed, skips: 2 });
      for (const w of widths(mesh)) {
        expect(Number.isFinite(w)).toBe(true);
        expect(w).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('defaults to a taper, so an unspecified mark is a stroke rather than a blob', () => {
    expect(STROKE_DEFAULTS.profile).toBe('taper');
    expect(STROKE_DEFAULTS.width).toBeLessThan(0.3);
  });
});
