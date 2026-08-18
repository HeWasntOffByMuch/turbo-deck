/**
 * What makes a brush mark a brush mark (specs 158, 159).
 *
 * Every assertion here is against the *silhouette* rather than against the
 * buffers, because the silhouette is the whole claim. `position` holds the spine
 * and the outline is put back by `strokeOutline` -- the same expression the
 * shader computes before it adds its own per-instance layer -- so these hold the
 * shape the GPU will actually draw, in Node, with no canvas.
 *
 * The failure this file exists to catch is the common procedural-VFX one: a
 * stroke that is really a tapered rectangle, or a symmetrical spearhead, with
 * some noise on it. Both pass "it has a width curve" and "it has vertices" and
 * every other check somebody writes by looking at the code rather than the shape.
 */

import { describe, expect, it } from 'vitest';
import {
  brushStrokeBank,
  brushStrokeMesh,
  centreStrokes,
  STROKE_CENTRE_SHIFT,
  strokeHalfAt,
  strokeNodes,
  strokeOutline,
  strokeWidthAt,
  variedBank,
  NODE_VERTICES,
  STROKE_DEFAULTS,
  STROKE_UV_STRIDE,
  type StrokeMeshData,
} from './stroke.js';

function widths(mesh: StrokeMeshData): number[] {
  const out: number[] = [];
  for (let n = 0; n < strokeNodes(mesh); n++) out.push(strokeWidthAt(mesh, n));
  return out;
}

/** The bounding box of a whole gesture's drawn outline. */
function bounds(mesh: StrokeMeshData): { w: number; h: number; minY: number; maxY: number } {
  const outline = strokeOutline(mesh);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let v = 0; v < outline.length / 2; v++) {
    const x = outline[v * 2] ?? 0;
    const y = outline[v * 2 + 1] ?? 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { w: maxX - minX, h: maxY - minY, minY, maxY };
}

describe('brushStrokeMesh', () => {
  it('builds a whole gesture, not one ribbon', () => {
    // Body, companion streak and flecks in one mesh -- so a particle is one
    // brush movement rather than a piece of one, and the parts travel together.
    const bare = brushStrokeMesh({ companions: 0, flecks: 0, segments: 8 });
    const whole = brushStrokeMesh({ companions: 2, flecks: 3, segments: 8 });
    expect(bare.positions.length).toBe((8 + 1) * NODE_VERTICES * 3);
    expect(whole.positions.length).toBeGreaterThan(bare.positions.length * 1.8);
    // The main ribbon is still first, so a measurement can find it.
    expect(strokeNodes(whole)).toBe(9);
  });

  it('gives every vertex a unit side and an `along` that runs 0 to 1', () => {
    const mesh = brushStrokeMesh({ segments: 9, companions: 1, flecks: 2 });
    const count = mesh.positions.length / 3;
    for (let v = 0; v < count; v++) {
      const at = v * STROKE_UV_STRIDE;
      const along = mesh.strokeUv[at] ?? -1;
      expect(along).toBeGreaterThanOrEqual(0);
      expect(along).toBeLessThanOrEqual(1);
      expect(Math.hypot(mesh.strokeUv[at + 2] ?? 0, mesh.strokeUv[at + 3] ?? 0)).toBeCloseTo(1, 5);
    }
    // The main ribbon spans the whole range, since it is what erodes.
    let previous = -1;
    for (let n = 0; n < strokeNodes(mesh); n++) {
      const along = mesh.strokeUv[n * NODE_VERTICES * STROKE_UV_STRIDE] ?? -1;
      expect(along).toBeGreaterThan(previous);
      previous = along;
    }
    expect(previous).toBeCloseTo(1, 6);
  });

  it('has a crest, so a mark turned edge-on is still a shape', () => {
    // Three vertices per node, and the middle one is off the plane. Without it
    // a world-oriented mark vanishes at some camera angles, which is what makes
    // the hybrid orientation in `meshes.ts` possible at all.
    const mesh = brushStrokeMesh({ bow: 0.5, companions: 0, flecks: 0 });
    const crest = mesh.positions[1 * 3 + 2] ?? 0;
    const left = mesh.positions[0 * 3 + 2] ?? 0;
    const right = mesh.positions[2 * 3 + 2] ?? 0;
    expect(left).toBe(0);
    expect(right).toBe(0);
    expect(crest).toBeGreaterThan(0);
    // Flat when asked, so the arch is a decision rather than a constant.
    expect(brushStrokeMesh({ bow: 0, companions: 0, flecks: 0 }).positions[1 * 3 + 2]).toBe(0);
  });

  it('is not a rectangle: the width moves along the mark', () => {
    const interior = widths(brushStrokeMesh({ segments: 12, companions: 0, flecks: 0 })).slice(1, -1);
    const min = Math.min(...interior);
    const max = Math.max(...interior);
    expect(min).toBeGreaterThan(0);
    expect(max / min).toBeGreaterThan(1.6);
  });

  it('is not a triangle: the width does not fall in a straight line', () => {
    // The one silhouette that says "generated" loudest. Measured as the largest
    // gap between the real width curve and the straight line from root to tip;
    // a linear taper scores zero however much noise is on its edges.
    const w = widths(brushStrokeMesh({ segments: 16, companions: 0, flecks: 0 }));
    const first = w[0] ?? 0;
    const last = w[w.length - 1] ?? 0;
    let worst = 0;
    for (let i = 1; i < w.length - 1; i++) {
      const t = i / (w.length - 1);
      worst = Math.max(worst, Math.abs((w[i] ?? 0) - (first + (last - first) * t)));
    }
    expect(worst / Math.max(...w)).toBeGreaterThan(0.15);
  });

  it('is not a spearhead: the two edges are drawn from different noise', () => {
    // Mirrored edges are what make a hand-drawn shape look machined, and they
    // are also what you get for free if the width is one number per node.
    const mesh = brushStrokeMesh({ segments: 14, companions: 0, flecks: 0 });
    let disagreements = 0;
    let worst = 0;
    for (let n = 1; n < strokeNodes(mesh) - 1; n++) {
      const a = strokeHalfAt(mesh, n, 0);
      const b = strokeHalfAt(mesh, n, 1);
      const relative = Math.abs(a - b) / Math.max(a, b, 1e-6);
      worst = Math.max(worst, relative);
      if (relative > 0.06) disagreements += 1;
    }
    expect(worst).toBeGreaterThan(0.15);
    expect(disagreements).toBeGreaterThan(strokeNodes(mesh) * 0.3);
  });

  it('ends on one side before the other', () => {
    // A terminal point where both edges arrive together is a symmetrical
    // spearhead; one that gives out unevenly is a brush lifting off at an angle.
    const mesh = brushStrokeMesh({ segments: 20, splitTip: 1, companions: 0, flecks: 0 });
    const nodes = strokeNodes(mesh);
    const zeroFrom = (edge: number): number => {
      for (let n = nodes - 1; n >= 0; n--) if (strokeHalfAt(mesh, n, edge) > 1e-5) return n;
      return 0;
    };
    expect(zeroFrom(0)).not.toBe(zeroFrom(1));
  });

  it('is broad at the root and tapers, for every seed', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const w = widths(brushStrokeMesh({ seed, segments: 12, companions: 0, flecks: 0 }));
      const nodes = w.length;
      const early = w.slice(0, Math.max(2, Math.round(nodes * 0.3)));
      const late = w.slice(Math.round(nodes * 0.88));
      const earlyMean = early.reduce((a, b) => a + b, 0) / early.length;
      const lateMean = late.reduce((a, b) => a + b, 0) / late.length;
      expect(lateMean, `seed ${seed}`).toBeLessThan(earlyMean * 0.45);
      // And the root is a root, not a point: a mark that starts at nothing is a
      // leaf. The profile puts it at 0.6 of the peak.
      expect(w[0] ?? 0, `seed ${seed}`).toBeGreaterThan(Math.max(...w) * 0.25);
    }
  });

  it('bends, rather than running straight from root to tip', () => {
    const mesh = brushStrokeMesh({ segments: 12, companions: 0, flecks: 0 });
    const nodes = strokeNodes(mesh);
    const spineAt = (n: number): [number, number] => [
      mesh.positions[n * NODE_VERTICES * 3] ?? 0,
      mesh.positions[n * NODE_VERTICES * 3 + 1] ?? 0,
    ];
    const [x0, y0] = spineAt(0);
    const [x1, y1] = spineAt(nodes - 1);
    const [mx, my] = spineAt(Math.floor(nodes / 2));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy) || 1;
    const off = Math.abs((mx - x0) * dy - (my - y0) * dx) / length;
    expect(off).toBeGreaterThan(0.01);
  });

  it('has corners in its bend rather than a constant curvature', () => {
    const secondDifferences = (kink: number): number[] => {
      const mesh = brushStrokeMesh({ segments: 16, kink, companions: 0, flecks: 0 });
      const x = (n: number): number => mesh.positions[n * NODE_VERTICES * 3] ?? 0;
      const out: number[] = [];
      for (let n = 1; n < strokeNodes(mesh) - 1; n++) out.push(x(n + 1) - 2 * x(n) + x(n - 1));
      return out;
    };
    const spreadOf = (v: number[]): number => Math.max(...v) - Math.min(...v);
    expect(spreadOf(secondDifferences(0.02))).toBeGreaterThan(spreadOf(secondDifferences(0)) * 4);
  });

  it('throws detached pieces past its own tip', () => {
    const bare = bounds(brushStrokeMesh({ flecks: 0, companions: 0 }));
    const thrown = bounds(brushStrokeMesh({ flecks: 3, companions: 0 }));
    // Beyond the body, which is what makes them read as having left the brush
    // rather than as part of the mark.
    expect(thrown.maxY).toBeGreaterThan(bare.maxY * 1.05);
  });

  it('reaches much further than it is wide', () => {
    // The correction spec 159 made hardest. At a half-width of 0.17 a mark came
    // out about 1:2.3 at its widest and read as a petal or a spearhead; a brush
    // dragged quickly is nearer 1:5, and the interest has to come from the bulge
    // and the edges rather than from bulk.
    //
    // Measured across the mark rather than off its bounding box, because a
    // bounding box folds in the *bend* -- a stroke that curls hard is wider in
    // its box while being no thicker, and penalising that would tune the
    // curvature out to satisfy the test.
    const mesh = brushStrokeMesh({ companions: 0, flecks: 0 });
    expect(1 / Math.max(...widths(mesh))).toBeGreaterThan(4);
    // And it stays inside its own unit box, so `iSize` really is its length.
    expect(bounds(mesh).h).toBeLessThan(1.2);
  });

  it('never produces a negative or non-finite half-width', () => {
    for (let seed = 1; seed <= 30; seed++) {
      for (const w of widths(brushStrokeMesh({ seed, companions: 2, flecks: 2 }))) {
        expect(Number.isFinite(w)).toBe(true);
        expect(w).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is a pure function of its spec, and answers to the seed', () => {
    const a = brushStrokeMesh({ seed: 77 });
    expect(Array.from(a.positions)).toEqual(Array.from(brushStrokeMesh({ seed: 77 }).positions));
    expect(Array.from(brushStrokeMesh({ seed: 78 }).strokeUv)).not.toEqual(Array.from(a.strokeUv));
  });

  it('draws a lens blunt at both ends and a taper pointed at one', () => {
    const lens = widths(brushStrokeMesh({ profile: 'lens', segments: 14, companions: 0, flecks: 0 }));
    const taper = widths(brushStrokeMesh({ profile: 'taper', segments: 14, companions: 0, flecks: 0 }));
    const tip = (w: number[]): number => (w[w.length - 1] ?? 0) / Math.max(1e-6, Math.max(...w));
    expect(tip(lens)).toBeGreaterThan(0.25);
    expect(tip(taper)).toBeLessThan(0.08);
  });

  it('defaults to a narrow taper, so an unspecified mark is a stroke', () => {
    expect(STROKE_DEFAULTS.profile).toBe('taper');
    expect(STROKE_DEFAULTS.width).toBeLessThan(0.2);
  });
});

describe('the bank', () => {
  it('tags every vertex with the gesture it belongs to', () => {
    const bank = brushStrokeBank([{ seed: 1 }, { seed: 2 }, { seed: 3 }]);
    expect(bank.variants).toBe(3);
    const seen = new Set(Array.from(bank.variant));
    expect([...seen].sort()).toEqual([0, 1, 2]);
    expect(bank.variant.length).toBe(bank.positions.length / 3);
    for (const index of bank.indices) expect(index).toBeLessThan(bank.variant.length);
  });

  it('never lets one triangle span two gestures', () => {
    // The clip trick in the shader works per *vertex*, so a triangle with
    // vertices from two entries would be clipped on one corner and stretched
    // across the screen on the others.
    const bank = brushStrokeBank([{ seed: 1 }, { seed: 2 }, { seed: 3 }]);
    for (let i = 0; i < bank.indices.length; i += 3) {
      const a = bank.variant[bank.indices[i] ?? 0];
      const b = bank.variant[bank.indices[i + 1] ?? 0];
      const c = bank.variant[bank.indices[i + 2] ?? 0];
      expect(a).toBe(b);
      expect(b).toBe(c);
    }
  });

  it('holds genuinely different shapes, not one shape repeated', () => {
    // The correction spec 159 exists for: spec 158 baked one mark per kind and
    // asked the shader to vary it, and a fan of a dozen came out as one
    // silhouette a dozen times.
    const bank = variedBank({ segments: 9, companions: 0, flecks: 0 }, 8, 4242);
    const outline = strokeOutline(bank);
    // Each entry's own vertex range, compared by its drawn extent.
    const spans: { w: number; h: number }[] = [];
    for (let v = 0; v < bank.variant.length; v++) {
      const which = bank.variant[v] ?? 0;
      const box = (spans[which] ??= { w: 0, h: 0 });
      box.w = Math.max(box.w, Math.abs(outline[v * 2] ?? 0));
      box.h = Math.max(box.h, Math.abs(outline[v * 2 + 1] ?? 0));
    }
    expect(spans.length).toBe(8);
    const widthsSeen = spans.map((s) => s.w);
    expect(Math.max(...widthsSeen) / Math.max(1e-6, Math.min(...widthsSeen))).toBeGreaterThan(1.4);
  });

  it('varies within one grammar rather than inventing a second one', () => {
    // "Different paintings by the same artist." Every entry still tapers, still
    // reaches further than it is wide, and still has a root.
    const bank = variedBank({ segments: 9, companions: 0, flecks: 0 }, 8, 991);
    const perEntry = new Map<number, number[]>();
    for (let v = 0; v < bank.variant.length; v++) {
      const list = perEntry.get(bank.variant[v] ?? 0) ?? [];
      list.push(Math.abs(bank.strokeUv[v * STROKE_UV_STRIDE + 1] ?? 0));
      perEntry.set(bank.variant[v] ?? 0, list);
    }
    for (const [entry, halves] of perEntry) {
      const peak = Math.max(...halves);
      expect(peak, `entry ${entry}`).toBeGreaterThan(0.02);
      expect(peak, `entry ${entry}`).toBeLessThan(0.32);
    }
  });

  it('is a pure function of its own seed', () => {
    expect(Array.from(variedBank({}, 4, 7).positions)).toEqual(Array.from(variedBank({}, 4, 7).positions));
    expect(Array.from(variedBank({}, 4, 8).positions)).not.toEqual(Array.from(variedBank({}, 4, 7).positions));
  });

  it('stays inside the 16-bit index range a batch can upload', () => {
    const bank = variedBank({ segments: 12, companions: 2, flecks: 3 }, 8, 1);
    expect(bank.positions.length / 3).toBeLessThan(65536);
  });
});

describe('the placed mark is centred on its own origin (spec 175)', () => {
  const rooted = variedBank({ flecks: 0 }, 4, 0x3b7d);
  const centred = centreStrokes(rooted);

  it('moves the spine by exactly half a length, along its own axis and nowhere else', () => {
    expect(centred.positions).toHaveLength(rooted.positions.length);
    for (let v = 0; v < rooted.positions.length; v += 3) {
      expect(centred.positions[v]).toBe(rooted.positions[v]);
      expect(centred.positions[v + 1]).toBeCloseTo((rooted.positions[v + 1] ?? 0) - STROKE_CENTRE_SHIFT, 6);
      expect(centred.positions[v + 2]).toBe(rooted.positions[v + 2]);
    }
  });

  it('changes nothing else about the mark', () => {
    // The outline, the gesture coordinate, the bank tags and the winding are all
    // untouched: this is a translation, and a translation that quietly re-rolled
    // the geometry would be a second bank wearing the first one's name.
    expect(Array.from(centred.strokeUv)).toEqual(Array.from(rooted.strokeUv));
    expect(Array.from(centred.indices)).toEqual(Array.from(rooted.indices));
    expect(Array.from(centred.normals)).toEqual(Array.from(rooted.normals));
    expect(centred.variants).toBe(rooted.variants);
    expect(centred.mainNodes).toBe(rooted.mainNodes);
  });

  it('leaves the mark straddling zero rather than standing on it', () => {
    // The whole reason it exists: two of these rooted at one point are a V.
    const ys: number[] = [];
    for (let v = 1; v < centred.positions.length; v += 3) ys.push(centred.positions[v] ?? 0);
    expect(Math.min(...ys)).toBeCloseTo(-STROKE_CENTRE_SHIFT, 6);
    expect(Math.max(...ys)).toBeCloseTo(STROKE_CENTRE_SHIFT, 6);
  });

  it('does not touch the source it was handed', () => {
    const before = Array.from(rooted.positions);
    centreStrokes(rooted);
    expect(Array.from(rooted.positions)).toEqual(before);
  });
});
