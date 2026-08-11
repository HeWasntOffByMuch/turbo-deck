import { describe, expect, it } from 'vitest';

import { DEFAULT_CANONICAL_HEIGHT } from '../../units/canonical-height.js';
import {
  bayer4,
  cutoutCoverage,
  cutoutDiscards,
  CUTOUT_APPLY,
  CUTOUT_DEFAULTS,
  CUTOUT_OFF,
  CUTOUT_PROLOGUE,
  CUTOUT_STYLES,
  FOOT_MARGIN,
  GHOST_BAND_PERIOD,
  inGhostBand,
  styleCode,
  type ViewPoint,
} from './cutout.js';

/**
 * The cutaway's arithmetic (spec 126).
 *
 * The GLSL in `cutout.ts` cannot be executed here, so what this pins is the
 * TypeScript twin it is transcribed from -- plus, at the end, that the two
 * really are transcriptions of each other and not two different ideas that
 * drifted apart.
 */

const P = CUTOUT_DEFAULTS;
const body: ViewPoint = { x: 0, y: 0, z: -1000 };
/** In front of the body: view space looks down -z, so nearer is a larger z. */
const inFront = (x: number, y = 0): ViewPoint => ({ x, y, z: body.z + P.depthBias + 50 });

describe('what gets cut', () => {
  it('removes rock directly in front of the body', () => {
    expect(cutoutCoverage(inFront(0), body, P)).toBe(0);
  });

  it('keeps rock the body stands in front of, however close across the view', () => {
    // Same screen position, but further from the camera.
    const behind = { x: 0, y: 0, z: body.z - 200 };
    expect(cutoutCoverage(behind, body, P)).toBe(1);
  });

  it('keeps the ground the body is standing on', () => {
    // Its own footing sits within the bias, which is what the bias is for --
    // without it half the fragments under a body fall on the near side and the
    // floor flickers.
    expect(cutoutCoverage({ x: 0, y: 0, z: body.z + P.depthBias - 1 }, body, P)).toBe(1);
  });

  it('keeps everything beyond the outer radius', () => {
    expect(cutoutCoverage(inFront(P.outer), body, P)).toBe(1);
    expect(cutoutCoverage(inFront(P.outer + 500), body, P)).toBe(1);
  });

  it('fades between the two radii, and only ever upwards', () => {
    let previous = -1;
    for (let d = P.inner; d <= P.outer; d += 1) {
      const cov = cutoutCoverage(inFront(d), body, P);
      expect(cov).toBeGreaterThanOrEqual(previous);
      expect(cov).toBeGreaterThanOrEqual(0);
      expect(cov).toBeLessThanOrEqual(1);
      previous = cov;
    }
    expect(previous).toBeCloseTo(1, 5);
  });

  it('measures the radius across the view, not along one axis', () => {
    const diagonal = (P.inner / Math.SQRT2) * 0.99;
    expect(cutoutCoverage(inFront(diagonal, diagonal), body, P)).toBe(0);
  });

  it('draws the world untouched when the radius is zero', () => {
    // What every view that never writes the uniforms gets -- the map editor
    // has no body in it and must be unaffected.
    for (const d of [0, 10, 100, 5000]) {
      expect(cutoutCoverage(inFront(d), body, CUTOUT_OFF)).toBe(1);
    }
  });
});

describe('the dither threshold', () => {
  it('covers all sixteen levels over a 4x4 block', () => {
    const seen = new Set<number>();
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) seen.add(bayer4(x, y));
    }
    expect(seen.size).toBe(16);
  });

  it('tiles, so the pattern does not walk across the screen', () => {
    expect(bayer4(5, 7)).toBe(bayer4(1, 3));
    expect(bayer4(-3, -1)).toBe(bayer4(1, 3));
  });

  it('removes about half the fragments at half coverage', () => {
    let removed = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        if (0.5 <= bayer4(x, y)) removed++;
      }
    }
    expect(removed).toBe(8);
  });
});

/**
 * The GLSL and the TypeScript, side by side.
 *
 * Not a compile -- nothing here has a GL context -- but a transcription of the
 * shader's own branches, run over the same sweep as the TypeScript. If somebody
 * edits one arm of the coverage rule and not the other, this is what says so.
 */
function glslTranscription(frag: ViewPoint, bodyView: ViewPoint, inner: number, outer: number, bias: number): number {
  if (outer <= 0.0) return 1.0;
  if (frag.z <= bodyView.z + bias) return 1.0;
  const d = Math.hypot(frag.x - bodyView.x, frag.y - bodyView.y);
  if (d >= outer) return 1.0;
  if (d <= inner) return 0.0;
  return (d - inner) / (outer - inner);
}

describe('the shader and the transcription', () => {
  it('agree across a sweep of positions', () => {
    for (let x = -200; x <= 200; x += 7) {
      for (let y = -200; y <= 200; y += 13) {
        for (const dz of [-300, -1, 0, 1, 12, 13, 400]) {
          const frag: ViewPoint = { x, y, z: body.z + dz };
          expect(cutoutCoverage(frag, body, P)).toBeCloseTo(
            glslTranscription(frag, body, P.inner, P.outer, P.depthBias),
            10,
          );
        }
      }
    }
  });

  it('keeps the shader source and the constants in step', () => {
    // The GLSL reads its three numbers out of one vec3 in this order; swapping
    // two of them compiles perfectly and cuts nothing.
    expect(CUTOUT_PROLOGUE).toContain('float inner = uCutParams.x;');
    expect(CUTOUT_PROLOGUE).toContain('float outer = uCutParams.y;');
    expect(CUTOUT_PROLOGUE).toContain('float bias = uCutParams.z;');
    // And the discard has to be a discard, not a fade -- a blended cutout needs
    // sorted terrain, which a chunked mesh does not give.
    expect(CUTOUT_APPLY).toContain('discard');
  });
});

describe('how the hole is drawn', () => {
  it('does not force a stipple on anybody', () => {
    expect(CUTOUT_DEFAULTS.style).not.toBe('stipple');
  });

  it('opens a porthole rather than a crater, so the wall either side still reads', () => {
    // The whole answer to "I cannot see the rock I am about to walk into" is
    // that the opening is about one body across and the wall around it is
    // untouched. A hole four bodies wide takes the landmark away with it.
    expect(CUTOUT_DEFAULTS.outer).toBeLessThan(DEFAULT_CANONICAL_HEIGHT);
    expect(CUTOUT_DEFAULTS.inner).toBeGreaterThan(DEFAULT_CANONICAL_HEIGHT * 0.3);
  });

  it('takes the whole soft band when the cut is clean, so there is no noise in it', () => {
    // Every threshold in the block, so this cannot pass by landing on a lucky
    // pixel: a clean cut discards regardless of where the fragment sits.
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(cutoutDiscards(0.5, 'hard', x, y, 100)).toBe(true);
        expect(cutoutDiscards(0.99, 'hard', x, y, 100)).toBe(true);
      }
    }
  });

  it('dissolves the band when the cut is stippled', () => {
    let kept = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        if (!cutoutDiscards(0.5, 'stipple', x, y)) kept++;
      }
    }
    // Half in, half out -- which is the whole point of the style, and what
    // makes it look different from the clean one.
    expect(kept).toBe(8);
  });

  it('keeps everything when the cut is off, whatever the coverage', () => {
    for (const cov of [0, 0.25, 0.5, 1]) {
      expect(cutoutDiscards(cov, 'off', 0, 0)).toBe(false);
    }
    expect(cutoutCoverage({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1000 }, { ...CUTOUT_DEFAULTS, style: 'off' })).toBe(1);
  });

  it('never discards a fragment nothing is covering', () => {
    for (const style of CUTOUT_STYLES) {
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) expect(cutoutDiscards(1, style, x, y)).toBe(false);
      }
    }
  });

  it('gives the shader a code per style, on the right side of each branch', () => {
    // The GLSL branches on `< 0.0` for off, then `< 0.5` for ghost, then `< 1.5`
    // for hard, with stipple falling through. Every code has to land in exactly
    // one of those, and a renumbering that compiles is a renumbering that draws
    // the wrong style.
    expect(styleCode('off')).toBeLessThan(0);
    expect(styleCode('ghost')).toBe(0);
    expect(styleCode('hard')).toBe(1);
    expect(styleCode('stipple')).toBe(2);
    for (const style of CUTOUT_STYLES) {
      const code = styleCode(style);
      const branch = code < 0 ? 'off' : code < 0.5 ? 'ghost' : code < 1.5 ? 'hard' : 'stipple';
      expect(branch).toBe(style);
    }
  });

  it('starts the shared uniform switched off, so no view inherits a hole', () => {
    expect(CUTOUT_OFF.style).toBe('off');
    expect(styleCode(CUTOUT_OFF.style)).toBeLessThan(0);
  });
});

describe('the floor is never the casualty', () => {
  it('keeps anything at or below the feet, however squarely it is in the way', () => {
    // Dead centre of the hole and nearer the camera than the body -- every other
    // test in this file says that is cut. Being at foot height outranks all of it.
    const frag = inFront(0);
    expect(cutoutCoverage(frag, body, P, 40, 40)).toBe(1);
    expect(cutoutCoverage(frag, body, P, 39.9, 40)).toBe(1);
  });

  it('still cuts what stands above the feet, past the margin', () => {
    expect(cutoutCoverage(inFront(0), body, P, 40 + FOOT_MARGIN + 1, 40)).toBe(0);
  });

  it('spares a shin of margin, since the sampled ground and the drawn one differ', () => {
    // `groundY` comes off the lattice and the surface is drawn from jittered
    // corners, so an exact test cut a ring out of the floor under the body.
    expect(cutoutCoverage(inFront(0), body, P, 40 + FOOT_MARGIN - 0.5, 40)).toBe(1);
  });

  it('is unaffected when no heights are supplied', () => {
    // The heights are optional so the older callers and the sweep below read the
    // same as they always did.
    expect(cutoutCoverage(inFront(0), body, P)).toBe(0);
  });
});

describe('the ghost that shows the wall', () => {
  it('keeps a stratum and drops the rest', () => {
    let kept = 0;
    const step = GHOST_BAND_PERIOD / 100;
    for (let y = 0; y < GHOST_BAND_PERIOD; y += step) {
      if (!cutoutDiscards(0, 'ghost', 0, 0, y)) kept++;
    }
    // A quarter or so survives: enough to read the wall, little enough to see
    // the body through it.
    expect(kept).toBeGreaterThan(15);
    expect(kept).toBeLessThan(40);
  });

  it('bands on world height, so the strata do not slide as the camera tracks', () => {
    // The same height is the same band a hundred periods away.
    for (const y of [0, 3, 7, 13, 19.5]) {
      expect(inGhostBand(y)).toBe(inGhostBand(y + GHOST_BAND_PERIOD * 100));
    }
  });

  it('bands regardless of the pixel, so it is a section and not a dither', () => {
    const insideBand = GHOST_BAND_PERIOD * 0.1;
    for (let py = 0; py < 4; py++) {
      for (let px = 0; px < 4; px++) expect(cutoutDiscards(0, 'ghost', px, py, insideBand)).toBe(false);
    }
  });

  it('never keeps anything at full coverage', () => {
    expect(cutoutDiscards(1, 'ghost', 0, 0, GHOST_BAND_PERIOD * 0.9)).toBe(false);
  });
});
