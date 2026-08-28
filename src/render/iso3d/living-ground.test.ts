import { describe, expect, it } from 'vitest';
import {
  LIVING_GROUND,
  LIVING_GROUND_LIMITS,
  LIVING_GROUND_SAMPLES,
  LIVING_GROUND_SHAPE,
  glslLivingGround,
  grassMask,
  gustEdgeWidth,
  gustFrontAt,
  linearBandStep,
  linearOf,
  macroTone,
  slopeSteepness,
} from './living-ground.js';
import { TERRAIN_CLIFF_COLORS, TERRAIN_COLORS } from './palette.js';
import { RETRO_DEFAULTS } from './retro.js';
import { MAX_WALK_ANGLE_DEG } from '../../sim/constants.js';
import { WIND, windDirection, WIND_BEARING_DEG } from './wind.js';

/**
 * The living ground (spec 252).
 *
 * Two of the three things this guards were learned one spec at a time somewhere
 * else in the tree, and both are the reason a layer can be correctly wired,
 * switched on and invisible:
 *
 * - **A modulation smaller than half a colour band is not there.** The retro
 *   pass quantizes each channel to twelve levels, and spec 074's streak layer
 *   shipped at a quarter of a step and was rounded away over the whole frame.
 *   Every amplitude below is measured against a band, and in the space the
 *   shader actually adds in.
 * - **What reaches which material is a claim about the palette**, not about this
 *   file. The mask is a chromaticity test standing in for a material id the
 *   vertex format does not carry, so the separation is asserted against
 *   `palette.ts` itself -- retune a material across the line and it fails here
 *   rather than in somebody's screenshot.
 *
 * The third is that the shader is a generated string nobody can execute in Node,
 * so what can be checked about it -- that it declares what it names, names what
 * it declares, and does not quietly grow a ninth noise sample -- is.
 */

/** GLSL with comments stripped, so prose is not read as code. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

const GLSL = code(glslLivingGround());

const maskOf = (hex: number): number => {
  const [r, g, b] = linearOf(hex);
  return grassMask(r, g, b);
};

describe('which ground the layer reaches', () => {
  it('reads both of the meadow tones as grass', () => {
    for (const hex of TERRAIN_COLORS.grass) expect(maskOf(hex)).toBe(1);
  });

  it('reads every other surface material as not grass', () => {
    // Sand, dirt, rock and water are all red- or blue-dominant, and snow is
    // near-neutral. The nearest miss is snow's cooler tone at 0.031 against a
    // window that opens at 0.06, so the gap is about twice the window's own
    // width on the tight side and five times it on the other.
    for (const [name, pair] of Object.entries(TERRAIN_COLORS)) {
      if (name === 'grass') continue;
      for (const hex of pair) expect(maskOf(hex)).toBeLessThan(0.05);
    }
  });

  it('reads a cut bank as earth, including the one under a meadow', () => {
    // `TERRAIN_CLIFF_COLORS.grass` is the dark of a cut bank -- soil, with the
    // meadow's warmth in it -- and it is red-dominant. The walls are not patched
    // at all, so this is belt and braces; it is here because the day somebody
    // does patch them, the mask has to already be right.
    for (const pair of Object.values(TERRAIN_CLIFF_COLORS)) {
      for (const hex of pair) expect(maskOf(hex)).toBe(0);
    }
  });

  it('leaves the window in the gap it was measured in', () => {
    const s = LIVING_GROUND_SHAPE;
    const dominance = (hex: number): number => {
      const [r, g, b] = linearOf(hex);
      return g - Math.max(r, b);
    };
    const grass = TERRAIN_COLORS.grass.map(dominance);
    const others = Object.entries(TERRAIN_COLORS)
      .filter(([name]) => name !== 'grass')
      .flatMap(([, pair]) => pair.map(dominance));
    expect(Math.min(...grass)).toBeGreaterThan(s.grassMaskHigh);
    expect(Math.max(...others)).toBeLessThan(s.grassMaskLow);
  });
});

describe('the macro variation, against the pass that has to show it', () => {
  /** The strongest channel of the swing, and the band it has to cross there. */
  const swing = (): { moved: number; band: number } => {
    const base = linearOf(LIVING_GROUND.base);
    const dark = linearOf(LIVING_GROUND.dark);
    const light = linearOf(LIVING_GROUND.light);
    let best = { moved: 0, band: Infinity };
    for (let c = 0; c < 3; c++) {
      const moved = ((light[c] ?? 0) - (dark[c] ?? 0)) * LIVING_GROUND.macroStrength;
      const band = linearBandStep(base[c] ?? 0, RETRO_DEFAULTS.levels);
      if (moved / band > best.moved / best.band) best = { moved, band };
    }
    return best;
  };

  it('crosses a colour band on its own', () => {
    // The regression spec 074 shipped, stated as arithmetic. A quantized channel
    // only changes if something moves it more than half a band, and no amount of
    // dithering carries sub-step detail -- so the macro layer has to be worth a
    // step by itself or the clearing goes back to being one flat colour.
    //
    // Measured in *linear*, because that is where the shader adds, and at the
    // grass's own brightness, because a band is a fixed step of the encoded
    // range and is worth a different amount of linear at every point on the
    // curve. Conservative for a lit surface: lighting scales a surface down,
    // sRGB is compressive, and a band down there is narrower still.
    const { moved, band } = swing();
    expect(moved).toBeGreaterThan(band * 0.5);
  });

  it('does not repaint the whole meadow to vary a part of it', () => {
    // The other half of the same idea, and the mistake that is easy to make
    // while fixing the first: an amplitude big enough to see is only tolerable
    // if it is centred. The noise is symmetric about its own middle, so the
    // window it is read through has to be too, or the *average* ground colour
    // moves and the layer is a recolour with variation on top.
    const s = LIVING_GROUND_SHAPE;
    expect(s.macroLow + s.macroHigh).toBeCloseTo(1, 10);
    expect(macroTone(0.5, 0.5)).toBeCloseTo(0, 10);
  });

  it('displaces mossy one way and sunlit the other', () => {
    expect(macroTone(0, 0)).toBeCloseTo(-1, 10);
    expect(macroTone(1, 1)).toBeCloseTo(1, 10);
    // The larger octave leads, so it decides the sign when the two disagree.
    expect(LIVING_GROUND_SHAPE.macroWeight).toBeGreaterThan(0.5);
    expect(macroTone(1, 0)).toBeGreaterThan(macroTone(0, 1));
  });

  it('is worth more than the per-cell mottle it sits over', () => {
    // Spec 043 already varies the ground, at cell scale, between two authored
    // tones. This layer is only worth having if it leads: a larger scale at a
    // *smaller* amplitude would read as the cell noise having got blurrier.
    const [lightCell, darkCell] = TERRAIN_COLORS.grass.map(linearOf);
    const cell = Math.max(...[0, 1, 2].map((c) => Math.abs((lightCell?.[c] ?? 0) - (darkCell?.[c] ?? 0))));
    const { moved } = swing();
    expect(moved).toBeGreaterThan(cell);
    // ...and it must be a genuinely larger *scale*, or it is the same layer twice.
    expect(LIVING_GROUND.macroScale).toBeGreaterThan(22 * 2);
  });
});

describe('the wind over the ground', () => {
  it('shapes a gust into a front with still ground either side of it', () => {
    // Quantization destroys gradients and preserves edges (spec 074), so the
    // front has to be an edge. Stated as: the transition occupies well under
    // half the field's range, which leaves the majority of the ground between
    // two fronts sitting flat at one end or the other rather than permanently
    // mid-ramp.
    const width = 2 * gustEdgeWidth(LIVING_GROUND.gustContrast);
    expect(width).toBeLessThan(0.5);
    // ...and the knob has to reach both answers, or it is not a knob.
    expect(2 * gustEdgeWidth(0)).toBeGreaterThan(0.5);
    expect(2 * gustEdgeWidth(1)).toBeLessThan(0.15);
  });

  it('makes a front worth a colour band, which is what the streak layer was not', () => {
    // The regression this layer very nearly shipped, and the second time spec
    // 074's finding has bitten in this tree. The gust's first cut spent its
    // amplitude through a 0.35 tint of a 0.45 brightness -- 0.157 of the way to
    // the light tone, about a fifth of a colour step -- and the retro pass
    // rounded the whole thing away. `probe-living-ground.ts` could not find it
    // against four walking animals, which is what sent anybody looking.
    //
    // Two-sided, so the swing is twice the setting: what a front is worth is the
    // distance between its bright half and its dim one.
    const base = linearOf(LIVING_GROUND.base);
    const light = linearOf(LIVING_GROUND.light);
    let best = 0;
    for (let c = 0; c < 3; c++) {
      const swing = 2 * ((light[c] ?? 0) - (base[c] ?? 0)) * LIVING_GROUND.gustBrightness;
      const band = linearBandStep(base[c] ?? 0, RETRO_DEFAULTS.levels);
      best = Math.max(best, swing / band);
    }
    expect(best).toBeGreaterThan(0.5);
    // ...and restrained: past about a band and a half a front stops reading as
    // light moving over a meadow and starts reading as the meadow changing
    // colour.
    expect(best).toBeLessThan(1.5);
  });

  it('leaves the meadow the brightness it found it at', () => {
    // A front that only brightened would lift the mean of the whole map by half
    // its amplitude -- repainting the world to animate a fraction of it, which
    // is the rule `GLSL_STREAK` states and the reason its own front is
    // two-sided. Here it is the `(gust - 0.5) * 2.0` that makes it true.
    expect(GLSL).toContain('float front = (gust - 0.5) * 2.0;');
  });

  it('breathes over the meadow without touching its hue', () => {
    // The regression that shipped the moment the fronts were made big enough to
    // blanket a frame. Mixed toward the light tone -- which is markedly redder
    // than the base -- a full-frame front did not brighten the clearing, it
    // turned it yellow. A multiplier scales every channel together, so a hue
    // shift is not something it *can* express, which is the same reason
    // `GLSL_STREAK` applies its own front that way.
    expect(GLSL).toContain('result *= 1.0 + front * uGrassGustBrightness * GRASS_GUST_BREATH');
    expect(GLSL).not.toMatch(/delta \+= toLight \* front/);
    // The strokes keep the tone shift, and are allowed to: a yellower green is
    // what a sunlit tip looks like, and it lands on a twentieth of the ground
    // rather than on all of it.
    expect(GLSL).toContain('delta += toLight * strokes * strokeAmount * lit;');
  });

  it('brightens a stroke only on the front\'s leading half', () => {
    // A stroke that dimmed behind the front would read as the grass thinning
    // out rather than as the light moving on.
    expect(GLSL).toContain('float lit = 1.0 + max(front, 0.0) * GRASS_GUST_STROKE_GAIN;');
  });

  it('lets a trail read over bare ground and not only over the strokes', () => {
    // Otherwise the one part of this that reads as moving air is visible only
    // where the brush marks already are.
    expect(GLSL).toContain('delta += toLight * trail * uGrassWindStrength');
  });

  it('moves a front across the ground as the clock runs', () => {
    // Asserted over the arithmetic rather than in a browser, and that is not a
    // shortcut: `probe-living-ground.ts` established that the shared wind clock
    // does not advance in a headless page at all -- with this layer off, the
    // weather at maximum speed and the weather stilled change the same number
    // of pixels over six seconds, so the trees are not swaying either. A probe
    // there could only ever have reported a working front as a broken one, and
    // very nearly did.
    //
    // What is measured is what a player would see: over one screen of ground
    // (the camera frames roughly 640x400 units), how much of it the front
    // carries across a colour band in two seconds -- the same currency the macro
    // layer is judged in, because a swing the retro pass rounds away is a front
    // nobody sees move.
    const dir = windDirection(WIND_BEARING_DEG);
    const base = linearOf(LIVING_GROUND.base);
    const light = linearOf(LIVING_GROUND.light);
    // The green channel, which is where grass carries its value.
    const perUnit = ((light[1] ?? 0) - (base[1] ?? 0)) * LIVING_GROUND.gustBrightness;
    const half = linearBandStep(base[1] ?? 0, RETRO_DEFAULTS.levels) * 0.5;

    let crossed = 0;
    let samples = 0;
    for (let z = 0; z < 400; z += 4) {
      for (let x = 0; x < 640; x += 4) {
        const before = gustFrontAt(x, z, dir.x, dir.z, 10);
        const after = gustFrontAt(x, z, dir.x, dir.z, 12);
        if (Math.abs(after - before) * perUnit > half) crossed++;
        samples++;
      }
    }
    const share = crossed / samples;
    // A fifth of the visible ground changing tone in two seconds is a front
    // crossing a clearing; a twentieth would be a shimmer nobody reads as wind.
    expect(share).toBeGreaterThan(0.2);
    // ...and not most of it, or the meadow is strobing rather than breathing.
    expect(share).toBeLessThan(0.75);
  });

  it('travels along the wind the trees lean to', () => {
    // Not a second direction: the front is sampled at a point pushed downwind by
    // the shared `uWindDir`, so a bearing change turns the ground and the forest
    // together. Sampling *across* the wind at two times finds the same field
    // sliding past; sampling along it finds it displaced.
    const dir = windDirection(WIND_BEARING_DEG);
    const travel = LIVING_GROUND_SHAPE.driftSpeed * LIVING_GROUND.windSpeed * 2;
    // A point two seconds' travel downwind sees, now, what its upwind neighbour
    // saw then -- which is what "the front moved over the ground" means.
    let matched = 0;
    for (let k = 0; k < 40; k++) {
      const x = k * 17;
      const z = k * 11;
      const then = gustFrontAt(x, z, dir.x, dir.z, 10);
      const now = gustFrontAt(x + dir.x * travel, z + dir.z * travel, dir.x, dir.z, 12);
      if (Math.abs(now - then) < 1e-6) matched++;
    }
    expect(matched).toBe(40);
    // And the drift is the wind's own speed multiplier rather than a second one.
    expect(WIND.streakSpeed).not.toBe(LIVING_GROUND_SHAPE.driftSpeed);
  });

  it('lays its fronts across the wind rather than along it', () => {
    // Below 1 the fronts are wider across the flow than along it, which is what
    // makes them fronts and not blobs -- `WIND.gustAspect` states the same thing
    // for the streak layer.
    expect(LIVING_GROUND_SHAPE.gustAspect).toBeLessThan(1);
  });

  it('does not beat against the streak layer already on this ground', () => {
    // Two fronts at the same period and the same speed are one front with a
    // moire in it. These are deliberately different on both counts; what is
    // asserted is the difference rather than either number, so retuning one
    // without the other fails here.
    expect(LIVING_GROUND.gustScale).not.toBe(130);
    expect(LIVING_GROUND_SHAPE.driftSpeed).not.toBe(62);
  });

  it('drags a trail sideways, which is the only direction that shows', () => {
    // A line displaced along its own length does not appear to move -- the
    // aperture problem the streak's grain runs into and writes down. The warp is
    // a fraction of the trail spacing, so the curvature scales with the feature
    // rather than being an absolute wobble that vanishes at a large scale.
    expect(LIVING_GROUND_SHAPE.trailWarp).toBeGreaterThan(1);
    expect(GLSL).toContain('vec2 warped = drift + side *');
  });

  it('shows a trail only inside a gust', () => {
    // What makes them arrive and leave rather than stand there.
    expect(GLSL).toMatch(/float trail = smoothstep\([^;]*\) \* gust;/);
  });

  it('moves the pattern and never the plane', () => {
    // The brief's hard line and the one thing this layer must not do: the ground
    // is not water. Nothing here writes a vertex, so the check is that the file
    // generates no vertex-stage source at all -- there is no `transformed`, no
    // `position`, and the patch has no vertex half.
    expect(GLSL).not.toContain('transformed');
    expect(GLSL).not.toContain('gl_Position');
  });
});

describe('slope', () => {
  const { slopeStart, slopeEnd } = LIVING_GROUND;

  it('leaves ground the lattice merely jitters alone', () => {
    // The terrain surface is a lattice of quads whose corners are jittered off
    // the grid, so open ground differs by a few degrees everywhere -- the same
    // chatter `normalEdgeThreshold` had to be raised past. Dead-flat meadow must
    // stay meadow.
    for (const degrees of [0, 3, 6, 10]) {
      const normalY = Math.cos((degrees * Math.PI) / 180);
      expect(slopeSteepness(normalY, slopeStart, slopeEnd)).toBe(0);
    }
  });

  it('is fully dry well before the ground stops being walkable', () => {
    // So the treatment is spent on hillsides a player walks up, rather than
    // arriving only on ground the router already refuses.
    const limit = Math.cos((MAX_WALK_ANGLE_DEG * Math.PI) / 180);
    expect(slopeEnd).toBeGreaterThan(limit);
    expect(slopeSteepness(slopeEnd, slopeStart, slopeEnd)).toBe(1);
  });

  it('runs the ramp the right way round', () => {
    expect(slopeStart).toBeGreaterThan(slopeEnd);
    expect(slopeSteepness(1, slopeStart, slopeEnd)).toBe(0);
    expect(slopeSteepness(0, slopeStart, slopeEnd)).toBe(1);
  });
});

describe('the scales, against the sizes the look is described in', () => {
  // A terrain cell is 22 world units and a unit is about 8cm, so a metre is
  // roughly 12.5 units. A value-noise feature reads about two lattice cells
  // across. The brief is in metres; this is the conversion, asserted, so a scale
  // edited to a number that sounds right cannot quietly leave the band.
  const metres = (units: number): number => (units * 2) / 12.5;

  it('puts the colour patches between five and twenty metres', () => {
    expect(metres(LIVING_GROUND.macroScale)).toBeGreaterThan(5);
    expect(metres(LIVING_GROUND.macroScale)).toBeLessThan(20);
  });

  it('puts a brush stroke between a third of a metre and two', () => {
    expect(metres(LIVING_GROUND.detailScale)).toBeGreaterThan(0.3);
    expect(metres(LIVING_GROUND.detailScale)).toBeLessThan(2);
  });

  it('keeps the specks finer than the strokes and coarser than a pixel', () => {
    expect(LIVING_GROUND.microScale).toBeLessThan(LIVING_GROUND.detailScale);
    // The camera sees roughly 640 units across a buffer about 530 wide, so a
    // unit is about 0.83 pixels. Below three pixels a feature crawls rather than
    // reads, whatever its amplitude.
    expect(LIVING_GROUND.microScale * 2 * 0.83).toBeGreaterThan(3);
  });

  it('leaves every scale inside what the panel can ask for', () => {
    const L = LIVING_GROUND_LIMITS;
    expect(LIVING_GROUND.macroScale).toBeLessThanOrEqual(L.maxMacroScale);
    expect(LIVING_GROUND.detailScale).toBeLessThanOrEqual(L.maxDetailScale);
    expect(LIVING_GROUND.microScale).toBeLessThanOrEqual(L.maxMicroScale);
    expect(LIVING_GROUND.windScale).toBeLessThanOrEqual(L.maxWindScale);
    expect(LIVING_GROUND.gustScale).toBeLessThanOrEqual(L.maxGustScale);
    for (const scale of [
      LIVING_GROUND.macroScale, LIVING_GROUND.detailScale, LIVING_GROUND.microScale,
      LIVING_GROUND.windScale, LIVING_GROUND.gustScale,
    ]) {
      expect(scale).toBeGreaterThanOrEqual(L.minScale);
    }
  });

  it('holds every mark to a colour band -- and the strokes only at a gust\'s crest', () => {
    // The rule this file keeps rediscovering, applied to every scale at once so
    // the next one added cannot skip it. The retro pass quantizes to twelve
    // levels; a mark that moves a channel less than half a step is not a subtle
    // mark, it is an absent one -- which is how the macro layer, the gust and the
    // specks were each written the first time.
    //
    // The strokes are the one deliberate exception, and it is the art direction
    // rather than an oversight: a still frame should be calm, so a stroke at rest
    // is worth about half a step and the crest of a gust carries it back over a
    // whole one. Both halves are asserted, because either on its own is a
    // different look -- quiet without the crest is a layer nobody ever sees, and
    // the crest without the quiet is the busy field this replaced.
    const base = linearOf(LIVING_GROUND.base);
    const light = linearOf(LIVING_GROUND.light);
    const dark = linearOf(LIVING_GROUND.dark);
    // Green: where grass carries its value, and the channel every tone here
    // moves most.
    const half = linearBandStep(base[1] ?? 0, RETRO_DEFAULTS.levels) * 0.5;
    const up = (light[1] ?? 0) - (base[1] ?? 0);
    const down = (base[1] ?? 0) - (dark[1] ?? 0);

    const marks = {
      // The macro tones, dark against light.
      macro: (up + down) * LIVING_GROUND.macroStrength,
      // A gust front, bright half against dim half. Multiplicative now, so it is
      // measured against the grass's own green rather than against a tone.
      gust:
        2 * (base[1] ?? 0) * LIVING_GROUND.gustBrightness * LIVING_GROUND_SHAPE.gustBreath,
      // A trail, over the ground beside it.
      trail: up * LIVING_GROUND.windStrength,
      // A speck, against the ground it sits on.
      speck: up * LIVING_GROUND.microStrength,
    };
    for (const [name, swing] of Object.entries(marks)) {
      expect(`${name}: ${(swing / half).toFixed(2)} half-bands`).toBe(
        `${name}: ${Math.max(1, swing / half).toFixed(2)} half-bands`,
      );
    }

    // A bright stroke against the dark counter-stroke between them, with and
    // without the front lighting it.
    const shade = down * LIVING_GROUND_SHAPE.strokeShade * LIVING_GROUND.detailStrength;
    const atRest = up * LIVING_GROUND.detailStrength + shade;
    const atCrest = up * LIVING_GROUND.detailStrength * (1 + LIVING_GROUND_SHAPE.gustStrokeGain) + shade;
    expect(atRest / half).toBeLessThan(1);
    expect(atCrest / half).toBeGreaterThanOrEqual(1);
    // ...and the gap between them is half of what a player reads as the wind
    // arriving -- worth better than half a colour step on its own. The other
    // half is `gustReveal`, which is a change in how *much* grass there is
    // rather than in how bright it is, and no amplitude can express it.
    expect((atCrest - atRest) / half).toBeGreaterThan(0.6);
  });

  it('lets a gust reveal strokes that were not there, not only brighten the ones that were', () => {
    // Brightness alone is a light moving over a fixed pattern. Lowering the
    // threshold is what makes more grass appear inside a front and sink back
    // behind it, which is the thing that reads as wind rather than as exposure.
    expect(LIVING_GROUND_SHAPE.gustReveal).toBeGreaterThan(0);
    expect(GLSL).toContain('float litCut = cut - max(front, 0.0) * GRASS_GUST_REVEAL;');
    // The dark counter-strokes are deliberately *not* revealed: letting both
    // tails in would raise the pattern's contrast rather than bring more grass
    // forward.
    expect(GLSL).toContain('float shade = smoothstep(cut, cut + GRASS_STROKE_SOFT');
  });

  it('leaves ground outside a clump with no strokes on it whatsoever', () => {
    // The clump is a gate rather than a modulation, and this is what that buys,
    // stated as arithmetic rather than as an intention: at the gate's floor the
    // stroke field cannot reach its threshold from *any* value it takes, so that
    // ground carries nothing. Modulated instead, every part of the meadow keeps a
    // faint stroke -- and a faint mark everywhere is a grain, which is exactly
    // what "reads like brushed metal" was.
    const s = LIVING_GROUND_SHAPE;
    // The loosest threshold the panel can ask for, with a gust at full crest.
    const loosestCut = s.strokeCutLow - s.gustReveal;
    // The most the stroke field can produce outside a clump.
    const outsideAClump = 1 * s.clumpBase;
    expect(outsideAClump).toBeLessThan(loosestCut);
  });

  it('leaves empty ground between the details', () => {
    // The brief asks for space between the marks rather than a carpet of them,
    // and this is the number that was wrong when the ground read as brushed
    // metal: both micro sets are tails of one field, so what is *not* blank is
    // at most twice what is past the cut. At the 0.80 this opened at that was
    // two fifths of the meadow.
    const s = LIVING_GROUND_SHAPE;
    expect(2 * (1 - s.microCut)).toBeLessThan(0.3);
    expect(LIVING_GROUND.detailDensity).toBeLessThan(0.7);
    // And the strokes' own threshold has to sit high on a field whose median is
    // 0.5, or the same thing happens one scale up.
    expect(s.strokeCutHigh).toBeGreaterThan(0.85);
  });
});

describe('the generated shader', () => {
  it('samples the noise the number of times it says it does', () => {
    // The whole cost of this layer is hashes, and the one way it grows is
    // somebody adding "just one more" field. The count is a number in the module
    // rather than a comment, so growing it is a deliberate edit.
    const calls = GLSL.split('grassNoise(').length - 1;
    // ...minus the definition itself.
    expect(calls - 1).toBe(LIVING_GROUND_SAMPLES);
    expect(LIVING_GROUND_SAMPLES).toBeLessThanOrEqual(8);
  });

  it('declares every uniform it reads and reads every uniform it declares', () => {
    const declared = [...GLSL.matchAll(/uniform\s+\w+\s+(uGrass\w+);/g)].map((m) => m[1] ?? '');
    expect(declared.length).toBeGreaterThan(0);
    const used = new Set([...GLSL.matchAll(/\b(uGrass\w+)\b/g)].map((m) => m[1] ?? ''));
    for (const name of used) expect(declared).toContain(name);
    for (const name of declared) {
      // Once for the declaration and at least once for a read.
      expect(GLSL.split(name).length - 1).toBeGreaterThan(1);
    }
  });

  it('leans on the wind chunk rather than declaring a second copy of it', () => {
    // `patchTerrainStreak` splices `glslWindChunk()` in before this, and it owns
    // `hash21`, `n2`, `uWindDir` and `uWindTime`. Re-declaring any of them is a
    // redefinition error at compile time, on the ground materials only, in a
    // browser -- which is exactly the failure a Node suite cannot see, so it is
    // asserted as an absence here.
    // It reads `uWindDir` -- the shared direction -- and takes the shared clock
    // as an argument rather than reaching for it, which is what lets the whole
    // chunk be driven from Node with a time in hand. The call site that supplies
    // `uWindTime` is asserted in `terrain-living.test.ts`.
    expect(GLSL).toContain('uWindDir');
    expect(GLSL).not.toMatch(/float\s+hash21\s*\(/);
    expect(GLSL).not.toMatch(/float\s+n2\s*\(/);
    expect(GLSL).not.toMatch(/uniform[^;]*uWind/);
  });

  it('wraps every noise sample onto a lattice it can still be precise about', () => {
    // The gust and the trail are sampled at a position that scrolls with the
    // clock, so without a wrap their input grows without bound and the hash
    // quantizes after a long session. Wrapping the lattice *corner* rather than
    // the sample point is what keeps the field continuous across the seam; a
    // `mod` in front of the sample would put a visible line every period.
    expect(GLSL).toContain('vec2 w = mod(cell, GRASS_PERIOD);');
    expect(GLSL).toContain('grassHash(mod(w + vec2(1.0, 1.0), GRASS_PERIOD))');
    // Every field's repeat is off the far side of anything a player walks.
    const finest = Math.min(LIVING_GROUND.microScale, LIVING_GROUND.detailScale);
    expect(LIVING_GROUND_SHAPE.noisePeriod * finest).toBeGreaterThan(640 * 3);
  });

  it('keeps the forest-edge seam open and inert', () => {
    // Spec 250 puts a prop distance field out of scope and leaves the hook, so
    // what has to be true is that the hook exists, that it is wired to the
    // colour arithmetic, and that it ships doing nothing.
    expect(GLSL).toContain('float grassShelterAt(vec3 worldPos) {');
    expect(GLSL).toContain('grassShelterAt(worldPos) * uGrassShelter');
    expect(LIVING_GROUND.shelter).toBe(0);
  });

  it('costs nothing at all when it is switched off', () => {
    // A uniform branch is coherent across the whole draw, so the master is free
    // rather than merely cheap -- which is what makes `HIKE_OFF`'s question
    // ("what did the frame look like before this") answerable without a rebuild.
    expect(GLSL).toContain('if (grass <= 0.0) return albedo;');
    const guard = GLSL.indexOf('if (grass <= 0.0)');
    expect(GLSL.indexOf('grassNoise(p *')).toBeGreaterThan(guard);
  });
});
