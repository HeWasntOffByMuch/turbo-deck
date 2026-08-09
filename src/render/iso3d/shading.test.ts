import { describe, expect, it } from 'vitest';
import {
  bendNormal,
  decodeOctahedral,
  DEFAULT_CREASE_ANGLE,
  encodeOctahedral,
  facetAngle,
  glslBendNormalChunk,
  glslOctahedralChunk,
  rotateAboutWind,
  weldedNormals,
} from './shading.js';

const DEG = Math.PI / 180;
const crease = (degrees: number): number => Math.cos(degrees * DEG);

/**
 * Fixtures below are wound so that `u x v` -- what `weldedNormals` computes,
 * with `u = b - a` and `v = c - a` -- points *out* of the solid. Getting that
 * backwards is the classic way to write a test that passes on the absolute value
 * of the right answer, so the direction is asserted, not just the axis.
 */

/** A unit cube as a triangle soup, axis-aligned, centred on the origin. */
function cube(): number[] {
  const h = 0.5;
  const corners: [number, number, number][] = [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
  ];
  // Each face wound counter-clockwise seen from outside.
  const faces: [number, number, number, number][] = [
    [4, 5, 6, 7], [1, 0, 3, 2], [5, 1, 2, 6],
    [0, 4, 7, 3], [3, 2, 6, 7], [0, 1, 5, 4],
  ];
  const out: number[] = [];
  for (const [a, b, c, d] of faces) {
    for (const i of [a, b, c, a, c, d]) out.push(...(corners[i] as [number, number, number]));
  }
  return out;
}

/**
 * An open `segments`-sided tube of unit radius and unit height, as a triangle
 * soup. The stand-in for a trunk: what welding does to it is entirely decided by
 * how many sides it has.
 */
function tube(segments: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < segments; s++) {
    const a = (s / segments) * Math.PI * 2;
    const b = ((s + 1) / segments) * Math.PI * 2;
    const p = (angle: number, y: number): [number, number, number] => [Math.cos(angle), y, Math.sin(angle)];
    out.push(...p(a, 0), ...p(b, 1), ...p(b, 0));
    out.push(...p(a, 0), ...p(a, 1), ...p(b, 1));
  }
  return out;
}

/**
 * A cone: `segments` triangles from a base ring up to one shared apex vertex.
 * The apex is the *second* vertex of each triangle, so its slots are 1, 4, 7...
 */
function cone(segments: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < segments; s++) {
    const a = (s / segments) * Math.PI * 2;
    const b = ((s + 1) / segments) * Math.PI * 2;
    out.push(Math.cos(a), 0, Math.sin(a), 0, 1, 0, Math.cos(b), 0, Math.sin(b));
  }
  return out;
}

/** The apex slot of cone triangle `t`. */
const APEX = (t: number): number => t * 3 + 1;

function normalAt(normals: Float32Array, vertex: number): [number, number, number] {
  return [normals[vertex * 3] ?? 0, normals[vertex * 3 + 1] ?? 0, normals[vertex * 3 + 2] ?? 0];
}

describe('facetAngle', () => {
  it('gives the angle the geometry in this world actually meets at', () => {
    // The numbers the crease angle has to be chosen against.
    expect((facetAngle(7) / DEG)).toBeCloseTo(51.43, 2);
    expect((facetAngle(4) / DEG)).toBeCloseTo(90, 6);
  });
});

describe('weldedNormals', () => {
  it('returns one unit normal per vertex', () => {
    const normals = weldedNormals(cube(), crease(30));
    expect(normals.length).toBe(cube().length);
    for (let v = 0; v < normals.length / 3; v++) {
      expect(Math.hypot(...normalAt(normals, v))).toBeCloseTo(1, 6);
    }
  });

  it('keeps a cube hard at every corner', () => {
    // A cube's faces meet at 90 degrees, so nothing may average: every vertex
    // must still carry its own face's axis-aligned normal. Rounding a cube is
    // the single most obvious way to get this wrong.
    const normals = weldedNormals(cube(), crease(30));
    for (let v = 0; v < normals.length / 3; v++) {
      const n = normalAt(normals, v);
      const axes = n.filter((c) => Math.abs(Math.abs(c) - 1) < 1e-5);
      expect(axes.length).toBe(1);
    }
  });

  it('smooths a tube finer than the crease and leaves a coarse one faceted', () => {
    // The whole finding of step 2, as a test. A 7-sided trunk meets at 51.4
    // degrees, so at the default crease it keeps every facet; a 60-sided one
    // meets at 6 and goes smooth.
    const coarse = weldedNormals(tube(7), Math.cos(DEFAULT_CREASE_ANGLE));
    const fine = weldedNormals(tube(60), Math.cos(DEFAULT_CREASE_ANGLE));

    // Slot 2 and slot 6 are the same corner reached from the two quads either
    // side of it -- the only place the answer differs between the two modes.
    expect(normalAt(coarse, 2)).not.toEqual(normalAt(coarse, 6));
    for (let i = 0; i < 3; i++) {
      expect(normalAt(fine, 2)[i] as number).toBeCloseTo(normalAt(fine, 6)[i] as number, 6);
    }

    // And smoothed, it points out from the axis: horizontal, and within one
    // facet of the corner's own radial direction.
    //
    // Within, not equal: this corner is touched by one triangle of the quad on
    // its left and two of the quad on its right -- the diagonal each quad is
    // split along decides that -- so the area-weighted average lands a third of
    // a facet round from the corner rather than exactly on it. Real, correct, and
    // invisible at these angles.
    const angle = (2 * Math.PI) / 60;
    const [nx, ny, nz] = normalAt(fine, 2);
    expect(ny).toBeCloseTo(0, 6);
    expect(Math.hypot(nx, nz)).toBeCloseTo(1, 6);
    const off = Math.acos(nx * Math.cos(angle) + nz * Math.sin(angle));
    expect(off).toBeLessThan(facetAngle(60));
  });

  it('leaves a 7-sided cone tip pointed at the default crease', () => {
    // Welding a cone apex is the artefact worth guarding. All 7 faces meet
    // there, and averaging them gives one normal straight up -- a taper that
    // reads as a melted dome. At 51.4-degree facets the default crease refuses
    // to weld them, which is exactly why the default sits below that.
    const normals = weldedNormals(cone(7), Math.cos(DEFAULT_CREASE_ANGLE));
    const first = normalAt(normals, APEX(0));
    const second = normalAt(normals, APEX(1));
    expect(first).not.toEqual(second);
    // Still leaning outward rather than standing straight up, which is what an
    // averaged apex would do.
    expect(first[1]).toBeLessThan(0.9);
    expect(Math.hypot(first[0], first[2])).toBeGreaterThan(0.3);
  });

  it('breaks a coarse cone tip into groups once the crease passes the facets, rather than doming it', () => {
    // The interesting failure, and not the one you would guess. Averaging all
    // seven faces would give one normal straight up -- a melted dome. That does
    // not happen: each face is compared against its group's *running average*,
    // and once four of the ring have joined, that average has tilted far enough
    // that the fifth fails and starts its own group.
    //
    // So the tip comes out as two shading regions of arbitrary size, which reads
    // blotchy -- worse than either a facet or a dome, and the real reason to keep
    // the crease under the facet angle.
    const normals = weldedNormals(cone(7), crease(70));
    const apexes = [0, 1, 2, 3, 4, 5, 6].map((t) => normalAt(normals, APEX(t)));
    const distinct = new Set(apexes.map((n) => n.join(',')));
    expect(distinct.size).toBeGreaterThan(1);
    expect(distinct.size).toBeLessThan(7);
    // Not a dome: no group ended up pointing straight up.
    for (const n of apexes) expect(n[1]).toBeLessThan(0.95);
  });

  it('splits a sheet at its rim, where the two faces meet head on', () => {
    // Two coincident quads wound opposite ways: a canopy slab's top and
    // underside. They share every position and must share no normal.
    const top = [0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1];
    const bottom = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1];
    const normals = weldedNormals([...top, ...bottom], crease(30));
    expect(normalAt(normals, 0)[1]).toBeCloseTo(1, 6);
    expect(normalAt(normals, 6)[1]).toBeCloseTo(-1, 6);
  });

  it('weights a face by its area, not one vote each', () => {
    // Two faces at a shared vertex, one much larger. The average has to lean
    // toward the big one, or a fan of slivers drags a normal off true.
    const big = [0, 0, 0, 0, 0, 10, 10, 0, 0];
    const sliver = [0, 0, 0, -0.01, 0.01, 0, 0, 0, 0.01];
    const normals = weldedNormals([...big, ...sliver], crease(80));
    expect(normalAt(normals, 0)[1]).toBeGreaterThan(0.9);
  });

  it('welds coincident slots written by different expressions', () => {
    // The ring-closing case the weld grid exists for: `cos(2 pi)` against
    // `cos(0)` are the same corner and need not be the same double.
    const wrapped = tube(24);
    const normals = weldedNormals(wrapped, Math.cos(DEFAULT_CREASE_ANGLE));
    // The last segment's far corner is the first segment's near corner.
    const last = tube(24).length / 3 - 4;
    expect(Math.hypot(...normalAt(normals, last))).toBeCloseTo(1, 6);
  });

  it('ignores degenerate triangles rather than being dragged to zero by them', () => {
    const flat = [0, 0, 0, 0, 0, 1, 1, 0, 0];
    const degenerate = [0, 0, 0, 1, 0, 0, 2, 0, 0];
    const normals = weldedNormals([...flat, ...degenerate], crease(30));
    expect(normalAt(normals, 0)[1]).toBeCloseTo(1, 6);
  });

  it('is deterministic', () => {
    const a = weldedNormals(tube(9), crease(45));
    const b = weldedNormals(tube(9), crease(45));
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('rotateAboutWind', () => {
  it('does nothing at zero angle', () => {
    expect(rotateAboutWind([0.3, 0.5, -0.8], 1, 0, 0)).toEqual([0.3, 0.5, -0.8]);
  });

  it('lays world up onto the wind direction at a quarter turn', () => {
    const [x, y, z] = rotateAboutWind([0, 1, 0], 1, 0, Math.PI / 2);
    expect(x).toBeCloseTo(1, 12);
    expect(y).toBeCloseTo(0, 12);
    expect(z).toBeCloseTo(0, 12);
  });

  it('leaves whatever lies across the wind alone', () => {
    // Wind along +x, so the z component is the across-wind one.
    const [x, y, z] = rotateAboutWind([0, 0, 1], 1, 0, 0.7);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(0, 12);
    expect(z).toBe(1);
  });

  it('preserves length', () => {
    for (const angle of [0.1, 0.5, 1.2, -0.8]) {
      const v = rotateAboutWind([0.6, 0.8, 0], 1, 0, angle);
      expect(Math.hypot(...v)).toBeCloseTo(1, 12);
    }
  });

  it('works on a wind that is not axis-aligned', () => {
    const s = Math.SQRT1_2;
    const [x, y, z] = rotateAboutWind([0, 1, 0], s, s, Math.PI / 2);
    expect(x).toBeCloseTo(s, 12);
    expect(y).toBeCloseTo(0, 12);
    expect(z).toBeCloseTo(s, 12);
  });

  it('composes by adding angles, which is why one rotation carries both bends', () => {
    // The swing and the canopy slab's tilt are rotations in the same plane, so
    // the shader applies angle * (1 + uSwayTilt) once rather than rotating twice.
    const once = rotateAboutWind([0.2, 0.9, 0.3], 1, 0, 0.3 + 0.4);
    const twice = rotateAboutWind(rotateAboutWind([0.2, 0.9, 0.3], 1, 0, 0.3), 1, 0, 0.4);
    for (let i = 0; i < 3; i++) {
      expect(once[i] as number).toBeCloseTo(twice[i] as number, 12);
    }
  });
});

describe('bendNormal', () => {
  it('is the wind rotation, so the shader has one expression to mirror', () => {
    expect(bendNormal([0.1, 0.9, 0.2], 0.6, 0.8, 0.4)).toEqual(rotateAboutWind([0.1, 0.9, 0.2], 0.6, 0.8, 0.4));
  });
});

describe('glslBendNormalChunk', () => {
  it('declares the function the sway shader calls', () => {
    expect(glslBendNormalChunk()).toContain('vec3 rotateAboutWind(vec3 v, float angle)');
  });

  it('transcribes the reference term for term', () => {
    // The GLSL cannot be executed here, so what is checked is that it still says
    // the same thing: the along-wind projection, the two trig terms, and the
    // across-wind component left untouched.
    const glsl = glslBendNormalChunk();
    expect(glsl).toContain('float along = dot(v.xz, uWindDir);');
    expect(glsl).toContain('r.xz += uWindDir * (along * ca + v.y * sa - along);');
    expect(glsl).toContain('r.y = v.y * ca - along * sa;');
  });
});

describe('octahedral normal encoding (spec 100)', () => {
  const dirs: [number, number, number][] = [
    [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
  ];

  it('round-trips the six axes exactly enough to matter', () => {
    for (const dir of dirs) {
      const back = decodeOctahedral(encodeOctahedral(dir));
      for (let i = 0; i < 3; i++) expect(back[i] as number).toBeCloseTo(dir[i] as number, 6);
    }
  });

  it('round-trips both hemispheres, which is the whole reason for the fold', () => {
    // Storing xy and recovering z loses the sign of z. This world is seen from
    // above at an angle, so back-facing normals are half the buffer.
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      // A deterministic spiral over the sphere -- no PRNG needed and no clock.
      const t = (i + 0.5) / 400;
      const z = 1 - 2 * t;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const phi = i * 2.399963229728653;
      const n: [number, number, number] = [r * Math.cos(phi), r * Math.sin(phi), z];
      const back = decodeOctahedral(encodeOctahedral(n));
      const dot = n[0] * back[0] + n[1] * back[1] + n[2] * back[2];
      worst = Math.max(worst, Math.acos(Math.min(1, dot)));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('stays inside the unit square, so nothing clips on the way into a byte', () => {
    for (let i = 0; i < 200; i++) {
      const t = (i + 0.5) / 200;
      const z = 1 - 2 * t;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const phi = i * 2.399963229728653;
      const [u, v] = encodeOctahedral([r * Math.cos(phi), r * Math.sin(phi), z]);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('survives eight-bit quantization to under a degree', () => {
    // The claim that decides whether two bytes is enough. Anything much worse
    // than a degree and the normal edge threshold starts finding edges in flat
    // ground.
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const t = (i + 0.5) / 400;
      const z = 1 - 2 * t;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const phi = i * 2.399963229728653;
      const n: [number, number, number] = [r * Math.cos(phi), r * Math.sin(phi), z];
      const [u, v] = encodeOctahedral(n);
      const quantized: [number, number] = [Math.round(u * 255) / 255, Math.round(v * 255) / 255];
      const back = decodeOctahedral(quantized);
      const dot = n[0] * back[0] + n[1] * back[1] + n[2] * back[2];
      worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, dot))));
    }
    expect((worst * 180) / Math.PI).toBeLessThan(1);
  });

  it('always decodes to a unit vector', () => {
    for (let u = 0; u <= 1.0001; u += 0.1) {
      for (let v = 0; v <= 1.0001; v += 0.1) {
        const n = decodeOctahedral([Math.min(1, u), Math.min(1, v)]);
        expect(Math.hypot(...n)).toBeCloseTo(1, 9);
      }
    }
  });

  it('gives a zero normal something rather than a NaN', () => {
    expect(encodeOctahedral([0, 0, 0])).toEqual([0.5, 0.5]);
    expect(decodeOctahedral([0.5, 0.5])).toEqual([0, 0, 1]);
  });
});

describe('glslOctahedralChunk', () => {
  it('declares both directions', () => {
    const glsl = glslOctahedralChunk();
    expect(glsl).toContain('vec2 encodeOctahedral(vec3 n)');
    expect(glsl).toContain('vec3 decodeOctahedral(vec2 e)');
  });

  it('folds the lower hemisphere the same way the reference does', () => {
    // The one line that is easy to write subtly differently -- note the .yx swap.
    expect(glslOctahedralChunk()).toContain('p = (1.0 - abs(p.yx))');
    expect(glslOctahedralChunk()).toContain('1.0 - abs(f.x) - abs(f.y)');
  });
});
