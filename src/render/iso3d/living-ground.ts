/**
 * The living ground (spec 250): what the grass surface is made of, at four
 * scales, and what the wind does to the pattern rather than to the plane.
 *
 * Pure -- no three.js, no DOM, no clock -- for the two reasons `wind.ts` gives.
 * The numbers below are the art direction, and a number that decides how the
 * world looks should be checkable in Node rather than by squinting at a frame;
 * and a GLSL expression nobody can execute is where a typo lives forever, so
 * the four decisions worth asserting are written out in TypeScript beside the
 * source that is compiled.
 *
 * `terrain-living.ts` holds the three.js half: the uniform objects, the setters
 * the weather panel writes through, and the material patch.
 *
 * ## What this is not
 *
 * It is not grass. Nothing is instanced, nothing is displaced, no geometry
 * changes and no vertex moves -- the ground is exactly the triangles it was.
 * Everything here happens to `diffuseColor` between `#include <color_fragment>`
 * and the lighting, which is where the three patches already on this material
 * live.
 *
 * ## The four scales
 *
 * This world is not metric; a terrain cell is 22 units across and a world unit
 * is somewhere around 8cm (see `wind.ts`). Every scale below is quoted in world
 * units with the metres beside it, because the brief this was built from is in
 * metres and the code is not.
 *
 * - **macro**, {@link LivingGroundConfig.macroScale}: patches of different green
 *   tens of metres across. This is the layer that stops a clearing reading as a
 *   painted plane, and the only one big enough to see from the far edge of the
 *   frame.
 * - **meso**, {@link LivingGroundConfig.detailScale}: brush-stroke clumps about
 *   a metre across, swept downwind and bent by the macro field so they curve.
 * - **wind**, {@link LivingGroundConfig.gustScale} and
 *   {@link LivingGroundConfig.windScale}: a broad front crossing the ground, and
 *   thin curved trails that are only visible *inside* a front, so they arrive
 *   and leave with it.
 * - **micro**, {@link LivingGroundConfig.microScale}: sparse specks, both tails
 *   of one noise field, so most of the ground is left empty.
 *
 * ## Relative, never absolute
 *
 * The four authored colours are a **base** and three tones stated against it,
 * and what the shader adds is `tone - base`. That is the whole reason spec 043's
 * per-cell mottling survives: both grass tones take the same shift, so the cell
 * pattern underneath is preserved instead of painted over. It is also why a map
 * whose grass was retuned keeps working -- move `TERRAIN_COLORS.grass` and move
 * {@link LivingGroundConfig.base} with it, and every tone follows.
 *
 * ## Which pixels it reaches
 *
 * There is no material id in the ground's vertex format -- a cell's material is
 * spent at mesh time on choosing one of two colours -- and adding one means a
 * new attribute, a mesher change and a change to what the map worker transfers.
 * None of that is needed, because **grass is the only material in
 * `TERRAIN_COLORS` whose green channel dominates both of the others.** So the
 * mask is a chromaticity test on the albedo the patch is handed, which is
 * exactly the vertex colour, because this patch is applied last and therefore
 * runs first (see `terrain-living.ts`). `living-ground.test.ts` asserts the
 * separation against the palette itself, so retuning a material across the line
 * fails there rather than in a screenshot.
 *
 * ## One wind
 *
 * Direction and clock are `uWindDir` and `uWindTime`, shared by reference from
 * `wind-uniforms.ts`. There is no second wind direction and no second clock --
 * spec 074's rule, and the reason the trees, the sea and the ground cannot be
 * handed different weather. What this layer adds is a speed *multiplier* of its
 * own and its own scales, so the ground's fronts do not lock to the streak's.
 */

import { srgbDecode, srgbEncode } from './hike.js';

// --- the parameters ---------------------------------------------------------

/**
 * Every knob on the living ground.
 *
 * All of these are uniforms rather than compiled-in constants -- which is the
 * opposite of the choice `wind.ts` makes, and deliberately. There the harmonics
 * and the gust envelope are the look and none of them is a knob; here the whole
 * point is that the look is tuned against a running frame, so every field can be
 * written while the game is up. The numbers that are *shape* rather than taste
 * -- aspect ratios, elongations, the width of a threshold -- are in
 * {@link LIVING_GROUND_SHAPE} and are compiled in.
 *
 * Colours are packed sRGB hex, like everything in `palette.ts`; the uniforms
 * carry them decoded to linear, because that is the space the shader adds in.
 */
export interface LivingGroundConfig {
  /**
   * The master. 0 is the ground exactly as it was before this landed, at no
   * per-pixel cost -- the shader branches on it, and a uniform branch is
   * coherent across the whole draw.
   */
  readonly amount: number;

  /**
   * The tone the other three are stated against. The mean of
   * `TERRAIN_COLORS.grass`, so unmodulated ground shows the colour the mesher
   * already gave it.
   */
  readonly base: number;
  /** Mossy green: the deep half of the macro variation. */
  readonly dark: number;
  /** Sunlit yellow-green: the bright half, and what a gust and a stroke lift toward. */
  readonly light: number;
  /** Straw: the occasional dry patch, and where a steep face goes. */
  readonly dry: number;

  /** World units per macro lattice cell. Patches read about twice this across. */
  readonly macroScale: number;
  /** How far the macro tones displace the ground's own colour, 0..1. */
  readonly macroStrength: number;

  /** World units across a brush stroke. Its length is this over `strokeStretch`. */
  readonly detailScale: number;
  /** How far a stroke lifts the colour under it, 0..1. */
  readonly detailStrength: number;
  /** How much of the ground carries strokes at all, 0..1. Higher is busier. */
  readonly detailDensity: number;

  /** World units between wind trails, across the flow. */
  readonly windScale: number;
  /** The ground layer's drift, as a multiple of its own art-directed speed. */
  readonly windSpeed: number;
  /** How much brighter the pattern goes along a trail, 0..1. */
  readonly windStrength: number;

  /** World units between gust fronts, along the flow. */
  readonly gustScale: number;
  /**
   * How hard a front's edge is, 0..1. 0 leaves the raw noise gradient; 1 is a
   * step. This is the number that decides whether the layer survives the retro
   * pass -- see {@link LIVING_GROUND_SHAPE.gustEdgeSoft}.
   */
  readonly gustContrast: number;
  /**
   * How far a front lifts and drops the grass, 0..1, as a fraction of the
   * distance to the light tone.
   *
   * **Two-sided**, so a front brightens its leading half and dims behind it and
   * the meadow's mean brightness does not move -- `GLSL_STREAK` states the same
   * rule for the same reason: a one-sided front repaints the whole world darker
   * to animate a fraction of it.
   */
  readonly gustBrightness: number;

  /** World units per micro lattice cell. */
  readonly microScale: number;
  /** How far a speck lifts or drops the colour under it, 0..1. */
  readonly microStrength: number;

  /** Cosine of the slope at which the ground starts drying out. 1 is flat. */
  readonly slopeStart: number;
  /** Cosine at which it is fully dry and carries no strokes. Below `slopeStart`. */
  readonly slopeEnd: number;
  /** How far a steep face browns and drains, 0..1. */
  readonly slopeStrength: number;

  /**
   * How far ground under cover darkens and enriches, 0..1.
   *
   * **Ships at 0, and the field it would read is not built.** There is no prop
   * distance field in this renderer and building one is a system of its own
   * (spec 250 puts it out of scope); `grassShelterAt` in the GLSL returns 0.0
   * and is the one function to fill in the day there is one. The colour
   * arithmetic that consumes it is written and tested, so what lands then is a
   * function body rather than a feature.
   */
  readonly shelter: number;
}

/**
 * The weather the clearing is art-directed for, and what the panel's Reset
 * restores.
 *
 * Every scale is quoted with the metres beside it because the brief is metric
 * and this world is not: a terrain cell is 22 units and a unit is about 8cm.
 */
export const LIVING_GROUND: LivingGroundConfig = {
  amount: 1,

  /**
   * The mean of `TERRAIN_COLORS.grass`'s two tones, so ground the macro field
   * leaves alone is exactly the colour the mesher painted.
   */
  base: 0x92b247,
  /** Moss in the hollows. */
  dark: 0x66883a,
  /** Sun on the high ground. Yellow-green, in the palette's warm register. */
  light: 0xb5c95a,
  /** Straw. Between the meadow and `TERRAIN_COLORS.dirt`, nearer the meadow. */
  dry: 0xbda86a,

  /**
   * 110 units, so a patch reads about 220 across -- 17m, the top of the 5-20m
   * the brief asks for, with the second octave at 2.37x supplying the bottom.
   * The camera sees roughly 640x400 units, so that is three patches across the
   * frame: enough that the ground is plainly not one colour, few enough that it
   * still reads as one material.
   */
  macroScale: 110,
  /**
   * 0.55.
   *
   * What that is worth is the reason it is not lower. The full dark-to-light
   * swing at this strength moves the red channel 0.18 in linear, against a retro
   * band of about 0.10 at the grass's own brightness -- so the macro variation
   * is worth about one and a half colour steps and survives quantization on its
   * own. That is spec 074's lesson, arrived at the hard way there: a modulation
   * smaller than half a band is rounded away over the whole frame, and no amount
   * of dithering carries it. `living-ground.test.ts` guards the relationship.
   *
   * It is also about 1.7x the amplitude of the per-cell two-tone mottle
   * underneath it, at five times the scale, which is the right way round -- the
   * large-scale variation should lead and the cell noise should texture it.
   */
  macroStrength: 0.55,

  /**
   * 10 units across a stroke -- 0.8m, in the middle of the 0.3-2m band -- which
   * with `strokeStretch` is about 48 units long. At the default zoom that is
   * roughly 17 by 40 pixels: a brush mark you can see, and nowhere near fine
   * enough to shimmer.
   */
  detailScale: 10,
  /**
   * 0.34, which is the smallest value at which a bright stroke and the dark
   * counter-stroke between them are a whole colour step apart -- the floor every
   * mark in this file is held to, and the one the test states for all four
   * scales at once. Inside a gust the strokes go half again as far, and that gap
   * is the feature: quiet when nothing is happening, stepping forward when the
   * wind crosses, which is what "calm when stationary, alive when the wind moves
   * through it" has to mean for a layer that never moves.
   */
  detailStrength: 0.34,
  /**
   * 0.32, and it came down from 0.45 when the noise underneath it was fixed.
   *
   * Worth recording, because it is the same story as the gust's amplitude one
   * paragraph up and it happened at the same moment. Every threshold in this
   * file was first tuned against a field whose hash was degenerate on integer
   * lattice corners -- badly under-dispersed, p50 at 0.39 against a proper
   * 0.50 -- so the cuts had to be generous to let anything through at all. With
   * a hash that behaves, those same cuts passed nearly everything and the meadow
   * came back marbled: continuous whorls of light and dark, which is a procedural
   * noise pattern and the exact thing the look is meant to avoid. The empty
   * ground between the marks is the feature.
   */
  detailDensity: 0.32,

  /** 55 units between trails, so several run through the frame at once. */
  windScale: 55,
  windSpeed: 1,
  /**
   * 0.55. A trail is only ever seen multiplied by the front it is inside, so
   * this is the peak of something that spends most of its life at zero.
   */
  windStrength: 0.55,

  /**
   * 150 units between fronts along the flow, about two across the frame -- the
   * same reasoning `WIND.gustScale` records, and deliberately a different number
   * from it. Two layers of front at the same period would beat against each
   * other; at 150 against the streak's 130, and at a different drift speed, they
   * read as one moving air mass with structure in it.
   */
  gustScale: 150,
  /**
   * 0.7, which puts the transition at about 30% of the noise range and leaves
   * flat ground either side of a front. Softer than the streak's, and it can
   * afford to be: this front modulates a *pattern* that already has hard edges
   * of its own, where the streak modulates flat albedo and has nothing else to
   * carry it across a colour band.
   */
  gustContrast: 0.7,
  /**
   * 0.40, and this is the number the first cut got wrong -- it shipped at an
   * effective 0.157 and `probe-living-ground.ts` could not find the gust at all
   * against four walking animals.
   *
   * The arithmetic it now clears: two-sided, the front swings the grass 0.8 of
   * the way to the light tone, which is 0.111 in linear green against a retro
   * band of about 0.13 at the grass's own brightness. So a front is worth about
   * 0.85 of a colour step and crosses one on its own -- spec 074's lesson,
   * arrived at there by shipping a streak layer at a quarter of a step and
   * finding it invisible. For scale, that streak's own swing on this ground is
   * about 0.68 of a step, so the two layers are the same order and neither
   * drowns the other.
   */
  gustBrightness: 0.4,

  /** 5 units, so a speck is three or four pixels. Below this it would crawl. */
  microScale: 5,
  /**
   * 0.55, on the roughly eighth of the ground the two tails of one noise field
   * reach.
   *
   * High for something called subtle, and it is the third time the same
   * arithmetic has decided a number in this file: at 0.3 a speck moved the green
   * channel 0.042 in linear against a half-band of 0.070, so every one of them
   * was rounded away and the layer was doing nothing at all. What keeps this
   * restrained is the **threshold**, not the amplitude -- the brief's rule is
   * empty space between details, and that is enforced by only an eighth of the
   * ground being touched. A speck that is there should be worth seeing.
   */
  microStrength: 0.55,

  /**
   * cos 20 degrees. Above the few degrees the jittered lattice wobbles by on
   * ground that is dead flat (the same chatter `normalEdgeThreshold` had to be
   * raised past), and well below anything a player would call a hill.
   */
  slopeStart: 0.94,
  /** cos ~45 degrees, comfortably inside `MAX_WALK_SLOPE`'s 67. */
  slopeEnd: 0.7,
  slopeStrength: 0.7,

  shelter: 0,
};

/**
 * What the weather panel is allowed to ask for.
 *
 * Bounds rather than suggestions, in the register `WIND_LIMITS` set. The scales
 * are floored well away from zero because every one of them is inverted in the
 * shader.
 */
export const LIVING_GROUND_LIMITS = {
  minScale: 2,
  maxMacroScale: 400,
  maxDetailScale: 60,
  maxMicroScale: 30,
  maxWindScale: 300,
  maxGustScale: 600,
  /** Every 0..1 knob. Above 1 the colours leave the palette they were chosen in. */
  minStrength: 0,
  maxStrength: 1,
  /** The ground layer's drift, as a multiple of the art direction. 0 freezes it. */
  minSpeed: 0,
  maxSpeed: 3,
} as const;

/**
 * The numbers that are shape rather than taste, compiled into the shader.
 *
 * Split out from {@link LivingGroundConfig} on `wind.ts`'s rule: a value that
 * decides what kind of thing this is -- how elongated a stroke is, how wide a
 * threshold -- is art direction baked at build time, and a panel row for it is a
 * row nobody will ever move usefully. They are data here rather than literals in
 * the GLSL so that a reader can see the whole shape in one object and a test can
 * assert against it.
 */
export const LIVING_GROUND_SHAPE = {
  /**
   * Green dominance -- `g - max(r, b)` in linear -- below which ground is not
   * grass, and above which it fully is.
   *
   * Measured off `palette.ts` rather than chosen. The two grass tones read 0.148
   * and 0.172; the next highest anything else reaches is snow at 0.031, and
   * every other material is at or below zero. So the window sits in a gap five
   * times its own width, which is what makes a chromaticity test a safe stand-in
   * for the material id the vertex format does not carry.
   */
  grassMaskLow: 0.06,
  grassMaskHigh: 0.11,

  /** The macro field's second octave, and how the two are weighted. */
  macroOctave: 2.37,
  macroWeight: 0.65,
  /** So the two octaves cannot sit on the same lattice corners. */
  macroOffset: 41.7,
  /**
   * Where the combined macro field is read as fully dark and fully light.
   *
   * **Symmetric about 0.5, and that is load-bearing rather than tidy.** The
   * noise is symmetric about its own middle, so a window that is not puts the
   * *average* of the ground somewhere other than the authored colour -- which is
   * repainting the whole meadow to vary a part of it, the mistake
   * `GLSL_STREAK` records making in the other direction. `living-ground.test.ts`
   * asserts the pair rather than the consequence.
   */
  macroLow: 0.26,
  macroHigh: 0.74,

  /** The dry field: its own octave of the macro scale, and how sparse it is. */
  dryOctave: 0.61,
  dryOffset: 113.4,
  dryCut: 0.62,
  drySoft: 0.2,
  /** How much of the macro strength a dry patch is allowed to spend. */
  dryShare: 0.8,

  /**
   * How far a stroke is stretched along its own direction. 0.5 makes it twice
   * as long as it is wide, which reads as a mark made by something rather than
   * as a blob -- and no longer than that, because a stroke long enough to meet
   * its neighbours is a grain in the ground rather than a stroke on it.
   */
  strokeStretch: 0.5,
  /** The clump field that breaks the strokes up, as an octave of the stroke scale. */
  clumpOctave: 0.38,
  clumpOffset: 7.7,
  /** A clump multiplies the stroke field by `base + gain * clump`. */
  clumpBase: 0.55,
  clumpGain: 0.9,
  /** The stroke threshold at density 0 and at density 1, and its softness. */
  strokeCutHigh: 0.78,
  strokeCutLow: 0.44,
  strokeSoft: 0.14,
  /**
   * How much of the stroke strength the darker counter-strokes take.
   *
   * Well under half, and deliberately not symmetric with the bright ones: the
   * dark tail lands *between* the light marks, so at parity the two tails meet
   * and there is no untouched ground left anywhere -- which is a texture rather
   * than a scatter of marks.
   */
  strokeShade: 0.35,
  /** How far a steep face suppresses strokes, at full slope. */
  strokeSlopeCut: 0.75,

  /**
   * How much wider a gust front is across the flow than along it. Below 1 the
   * fronts lie across the wind, which is what makes them fronts -- `WIND` states
   * the same thing for the same reason, at 0.35.
   */
  gustAspect: 0.3,
  /** Half-width of a front's transition at contrast 0, and at contrast 1. */
  gustEdgeSoft: 0.4,
  gustEdgeHard: 0.04,
  /**
   * How much *again* a stroke brightens inside the leading half of a front, on
   * top of the tint the whole meadow takes.
   *
   * The tint is what makes a front legible over bare ground and this is what
   * makes the pattern step forward inside it -- which is the brief's ask, a
   * *pattern* that comes alive rather than a plane that changes brightness.
   * Leading half only: a stroke that dimmed behind the front would read as the
   * grass thinning out rather than as the light moving on.
   */
  gustStrokeGain: 0.9,

  /** The ground layer's own drift, world units per second, before `windSpeed`. */
  driftSpeed: 46,
  /**
   * How far the macro field may bend a stroke off the wind axis, radians.
   *
   * 0.30 -- about seventeen degrees each way -- and it was 0.8 until the noise
   * was fixed. A rotation field that swings a full quadrant over the macro scale
   * does not read as a combed meadow, it reads as **circulation**: the strokes
   * close into whorls a couple of hundred units across and the ground turns into
   * marbled paper. Seventeen degrees is enough that strokes over one patch lie
   * differently from the next without any of them curling round.
   */
  flowBend: 0.3,
  /** How far a trail is stretched along the flow. */
  trailStretch: 0.2,
  /** How far the macro field drags a trail sideways, as a fraction of `windScale`. */
  trailWarp: 1.6,
  /** How wide a trail's ridge is, as a fraction of the ridge function's range. */
  trailWidth: 0.22,

  /** Where each tail of the micro field starts, and how soft it is. */
  microCut: 0.8,
  microSoft: 0.12,
  /** How much of the micro strength the dark clumps take against the light tips. */
  microDarkShare: 0.8,

  /** How far a steep face is drained of colour, at full slope strength. */
  slopeDesaturate: 0.45,
  /** How much of the dry tone a steep face takes, at full slope strength. */
  slopeDry: 0.85,

  /**
   * The lattice period every noise sample is wrapped to, in cells.
   *
   * Two jobs, and the second is the one that made it necessary. It bounds what
   * `hash21` is handed: the gust and the trail are sampled at a position that
   * *scrolls with the clock*, so without a wrap their input grows without limit
   * and the field quantizes after a long session -- which is the caveat
   * `advanceWind` already writes down for the sway. And it bounds the world
   * coordinate, which on a grown map reaches five figures.
   *
   * The cost is that each field repeats every `period * scale` units: 2,560 for
   * the micro specks and 5,120 for the strokes, which is four and eight screens.
   * Every other field's period is larger than the map. The wrap is applied to
   * the *lattice corner* rather than to the sample point, so the field is
   * continuous across it rather than seamed -- that is the whole difference
   * between this and a `mod` in front of `n2`.
   */
  noisePeriod: 512,
} as const;

// --- the reference maths ----------------------------------------------------

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!(edge1 > edge0)) return x >= edge1 ? 1 : 0;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * How much of this albedo is grass, in `[0, 1]`. The shader's `grassMask()`.
 *
 * Green dominance rather than hue, because dominance is one subtraction and a
 * `max`, where hue is a branch and an atan. Takes **linear** channels, which is
 * what the vertex colours are (`terrain-arrays.ts` decodes them at mesh time)
 * and what `diffuseColor` carries.
 */
export function grassMask(r: number, g: number, b: number): number {
  const green = g - Math.max(r, b);
  return smoothstep(LIVING_GROUND_SHAPE.grassMaskLow, LIVING_GROUND_SHAPE.grassMaskHigh, green);
}

/**
 * Where the macro field sits between the dark tone and the light one, **signed**:
 * -1 is fully mossy, +1 is fully sunlit, and 0 is the colour the map painted.
 * The shader's `macroTone()`.
 *
 * The two octaves are weighted rather than averaged, so the larger one leads.
 *
 * Signed rather than a 0..1 mix parameter, because the two are not the same
 * thing at the middle: `mix(toDark, toLight, 0.5)` is the *midpoint of the two
 * tones*, which is only zero if the palette happens to be symmetric in linear
 * space, and a palette chosen for how a moss and a sunlit green look has no
 * reason to be. Signed, ordinary ground is displaced by exactly nothing, and
 * "the layer varies the map's colour rather than replacing it" is arithmetic
 * instead of an aspiration.
 */
export function macroTone(m1: number, m2: number): number {
  const s = LIVING_GROUND_SHAPE;
  const macro = m1 * s.macroWeight + m2 * (1 - s.macroWeight);
  return smoothstep(s.macroLow, s.macroHigh, macro) * 2 - 1;
}

/**
 * A gust front, from the raw noise under it. The shader's `gustFront()`.
 *
 * Contrast pushes a gradient into an edge with flat ground either side of it,
 * which is what `WIND.gustEdge` records at length: quantization destroys
 * gradients and preserves edges, so sharpening a front is worth more than any
 * amount of extra amplitude and unlike amplitude it costs no mottling.
 */
export function gustFront(raw: number, contrast: number): number {
  const s = LIVING_GROUND_SHAPE;
  const edge = s.gustEdgeSoft + (s.gustEdgeHard - s.gustEdgeSoft) * clamp01(contrast);
  return smoothstep(0.5 - edge, 0.5 + edge, raw);
}

/** Half-width of a front's transition, in noise units, at this contrast. */
export function gustEdgeWidth(contrast: number): number {
  const s = LIVING_GROUND_SHAPE;
  return s.gustEdgeSoft + (s.gustEdgeHard - s.gustEdgeSoft) * clamp01(contrast);
}

/**
 * How steep this ground is, from 0 (flat enough to be a meadow) to 1 (dry
 * face). The shader's `slopeSteepness()`.
 *
 * `normalY` is the world normal's up component: 1 is level, 0 is a wall.
 */
export function slopeSteepness(normalY: number, start: number, end: number): number {
  return 1 - smoothstep(end, start, normalY);
}

/**
 * How far one step of the retro pass's palette reaches in **linear** space, at
 * the brightness this linear value already sits at.
 *
 * The band is a fixed step of the *encoded* range, so what it is worth in the
 * space the shader adds in depends on where on the curve the surface sits --
 * which is why `terrain-streak.ts`'s check, made against the encoded value,
 * could only ever be an approximation. This one is exact for an unlit surface,
 * and conservative for a lit one: lighting scales a surface down, sRGB is
 * compressive, so a band down there is narrower still.
 */
export function linearBandStep(linear: number, levels: number): number {
  const encoded = srgbEncode(clamp01(linear));
  const step = 1 / Math.max(1, levels - 1);
  return srgbDecode(Math.min(1, encoded + step)) - clamp01(linear);
}

/** A packed sRGB hex as the three linear channels, the way three.js decodes one. */
export function linearOf(hex: number): readonly [number, number, number] {
  return [
    srgbDecode(((hex >> 16) & 0xff) / 255),
    srgbDecode(((hex >> 8) & 0xff) / 255),
    srgbDecode((hex & 0xff) / 255),
  ];
}

/**
 * The shader's `grassHash()` and `grassNoise()`, term for term.
 *
 * Transcribed for the reason `wind.ts` transcribes `windAt`: what the gust field
 * *does over time* is the one claim about this layer that cannot be measured in
 * a browser here. `probe-living-ground.ts` found out the hard way that the
 * shared wind clock does not advance in a headless page at all -- with this
 * layer switched off, the weather at its maximum speed and the weather stilled
 * change the same number of pixels over six seconds, so the trees are not
 * swaying either. That is why `preview-world.ts` only ever asserts on wind
 * *strength*, which is a uniform, and why the clean numbers there are said to
 * live in `preview-wind.ts`, which drives its own clock.
 *
 * So the front's motion is asserted here, over the arithmetic, where a clock is
 * an argument.
 */
function grassHash(x: number, y: number): number {
  const fract = (v: number): number => v - Math.floor(v);
  let a = fract(x * 0.1031);
  let b = fract(y * 0.1031);
  let c = fract(x * 0.1031);
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += d;
  b += d;
  c += d;
  return fract((a + b) * c);
}

/** Value noise on a lattice wrapped to {@link LIVING_GROUND_SHAPE.noisePeriod}. */
export function grassNoise(x: number, y: number): number {
  const period = LIVING_GROUND_SHAPE.noisePeriod;
  const wrap = (v: number): number => ((v % period) + period) % period;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const wx = wrap(ix);
  const wy = wrap(iy);
  const a = grassHash(wx, wy);
  const b = grassHash(wrap(wx + 1), wy);
  const c = grassHash(wx, wrap(wy + 1));
  const d = grassHash(wrap(wx + 1), wrap(wy + 1));
  const top = a + (b - a) * ux;
  return top + (c + (d - c) * ux - top) * uy;
}

/**
 * The signed gust front at a world point and a time, in `[-1, 1]`: the shader's
 * `front`, which is what the whole meadow takes as a tint.
 *
 * `dirX`/`dirZ` are the shared wind direction, and `t` the shared clock -- the
 * two things this layer reads rather than owns.
 */
export function gustFrontAt(
  x: number,
  z: number,
  dirX: number,
  dirZ: number,
  t: number,
  config: LivingGroundConfig = LIVING_GROUND,
): number {
  const s = LIVING_GROUND_SHAPE;
  const travel = t * s.driftSpeed * config.windSpeed;
  const dx = x - dirX * travel;
  const dz = z - dirZ * travel;
  const along = dx * dirX + dz * dirZ;
  const across = dx * -dirZ + dz * dirX;
  const freq = 1 / Math.max(1, config.gustScale);
  return gustFront(grassNoise(along * freq, across * s.gustAspect * freq), config.gustContrast) * 2 - 1;
}

/** How many times the fragment stage samples the noise field. Asserted, not counted by hand. */
export const LIVING_GROUND_SAMPLES = 8;

// --- the GLSL ---------------------------------------------------------------

/** GLSL for a float literal, at enough precision that the inlining is lossless. */
function f(value: number): string {
  return value.toFixed(8);
}

/**
 * Everything the ground's fragment stage needs to draw the living surface.
 *
 * **Every name in here is prefixed, and that is not style.** This chunk is
 * pasted into a global namespace it shares with three.js's own includes, with
 * the wind chunk and with the detail chunk -- and the first version of it
 * shipped a `GUST_ASPECT` that `GLSL_STREAK` already declared. What that costs
 * is a *fragment shader that does not compile*, on the ground materials only, in
 * a browser: every test in Node passes, the terrain draws nothing, and the only
 * thing in the tree that can see it is `npx tsx scripts/probe-shading.ts`, which
 * is where it was in fact caught. `terrain-living.test.ts` asserts that every
 * name this declares is declared exactly once in the assembled shader, so the
 * next collision fails in `npm test` instead.
 *
 * **Not self-contained, and cannot be.** It reads `hash21` and the two wind
 * uniforms, which `glslWindChunk()` declares -- exactly the relationship
 * `GLSL_STREAK` has with `GLSL_NOISE` one file over, and stated here for the
 * same reason: the fragments are concatenated in a fixed order and are not
 * independent. `patchTerrainLiving` is applied after `patchTerrainStreak` and
 * will not compile without it.
 *
 * The noise is `n2` with its lattice wrapped rather than `n2` itself -- see
 * {@link LIVING_GROUND_SHAPE.noisePeriod} for why -- so the two are the same
 * field wherever the wrap has not bitten, which is everywhere on this map.
 */
export function glslLivingGround(): string {
  const s = LIVING_GROUND_SHAPE;
  return /* glsl */ `
uniform float uGrassAmount;
uniform vec3 uGrassBase;
uniform vec3 uGrassDark;
uniform vec3 uGrassLight;
uniform vec3 uGrassDry;
uniform float uGrassMacroScale;
uniform float uGrassMacroStrength;
uniform float uGrassDetailScale;
uniform float uGrassDetailStrength;
uniform float uGrassDetailDensity;
uniform float uGrassWindScale;
uniform float uGrassWindSpeed;
uniform float uGrassWindStrength;
uniform float uGrassGustScale;
uniform float uGrassGustContrast;
uniform float uGrassGustBrightness;
uniform float uGrassMicroScale;
uniform float uGrassMicroStrength;
uniform float uGrassSlopeStart;
uniform float uGrassSlopeEnd;
uniform float uGrassSlopeStrength;
uniform float uGrassShelter;

const float GRASS_MASK_LOW = ${f(s.grassMaskLow)};
const float GRASS_MASK_HIGH = ${f(s.grassMaskHigh)};
const float GRASS_PERIOD = ${f(s.noisePeriod)};
const float GRASS_MACRO_OCTAVE = ${f(s.macroOctave)};
const float GRASS_MACRO_WEIGHT = ${f(s.macroWeight)};
const float GRASS_MACRO_OFFSET = ${f(s.macroOffset)};
const float GRASS_MACRO_LOW = ${f(s.macroLow)};
const float GRASS_MACRO_HIGH = ${f(s.macroHigh)};
const float GRASS_DRY_OCTAVE = ${f(s.dryOctave)};
const float GRASS_DRY_OFFSET = ${f(s.dryOffset)};
const float GRASS_DRY_CUT = ${f(s.dryCut)};
const float GRASS_DRY_SOFT = ${f(s.drySoft)};
const float GRASS_DRY_SHARE = ${f(s.dryShare)};
const float GRASS_STROKE_STRETCH = ${f(s.strokeStretch)};
const float GRASS_CLUMP_OCTAVE = ${f(s.clumpOctave)};
const float GRASS_CLUMP_OFFSET = ${f(s.clumpOffset)};
const float GRASS_CLUMP_BASE = ${f(s.clumpBase)};
const float GRASS_CLUMP_GAIN = ${f(s.clumpGain)};
const float GRASS_STROKE_CUT_HIGH = ${f(s.strokeCutHigh)};
const float GRASS_STROKE_CUT_LOW = ${f(s.strokeCutLow)};
const float GRASS_STROKE_SOFT = ${f(s.strokeSoft)};
const float GRASS_STROKE_SHADE = ${f(s.strokeShade)};
const float GRASS_STROKE_SLOPE_CUT = ${f(s.strokeSlopeCut)};
const float GRASS_GUST_ASPECT = ${f(s.gustAspect)};
const float GRASS_GUST_EDGE_SOFT = ${f(s.gustEdgeSoft)};
const float GRASS_GUST_EDGE_HARD = ${f(s.gustEdgeHard)};
const float GRASS_GUST_STROKE_GAIN = ${f(s.gustStrokeGain)};
const float GRASS_DRIFT_SPEED = ${f(s.driftSpeed)};
const float GRASS_FLOW_BEND = ${f(s.flowBend)};
const float GRASS_TRAIL_STRETCH = ${f(s.trailStretch)};
const float GRASS_TRAIL_WARP = ${f(s.trailWarp)};
const float GRASS_TRAIL_WIDTH = ${f(s.trailWidth)};
const float GRASS_MICRO_CUT = ${f(s.microCut)};
const float GRASS_MICRO_SOFT = ${f(s.microSoft)};
const float GRASS_MICRO_DARK_SHARE = ${f(s.microDarkShare)};
const float GRASS_SLOPE_DESATURATE = ${f(s.slopeDesaturate)};
const float GRASS_SLOPE_DRY = ${f(s.slopeDry)};

// A hash of a lattice corner, and it is this layer's own rather than the wind
// chunk's hash21 -- which is the one place this file does not reuse what is
// already in the shader, so the reason is worth stating.
//
// hash21 opens with fract(p * vec2(127.1, 311.7)), and every corner handed
// to it is an **integer**. For integer n, fract(n * 127.1) is fract(0.1 * n)
// up to rounding -- a ten-step staircase -- so the hash is strongly correlated
// along both axes and its features repeat about every ten cells. Measured on the
// gust field that is not a subtlety: whole screens came back saturated at one
// end of the front, so the meadow pulsed as one instead of having a boundary
// cross it, which is spec 074's own "the ground read as changing colour rather
// than as having something cross it" arriving by a different door.
//
// This is Hoskins' hash12: no trig, so nothing here is implementation-defined
// the way a sin-based hash is (the reason bayer4 is written arithmetically),
// and well distributed on exactly the integer inputs a lattice hands it.
//
// hash21 is left alone. It is the water's and the streak layer's, its
// behaviour there is what those looks were tuned against, and changing it would
// retune two shipped features to fix a third.
float grassHash(vec2 cell) {
  vec3 p3 = fract(vec3(cell.x, cell.y, cell.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Value noise with its lattice wrapped to GRASS_PERIOD cells, so that a sample
// position which scrolls with the clock cannot grow without bound. Wrapping the
// *corner* rather than the sample point is what keeps it continuous -- a mod()
// in front of the noise would put a seam every period.
float grassNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 fr = fract(p);
  vec2 u = fr * fr * (3.0 - 2.0 * fr);
  vec2 w = mod(cell, GRASS_PERIOD);
  float a = grassHash(w);
  float b = grassHash(mod(w + vec2(1.0, 0.0), GRASS_PERIOD));
  float c = grassHash(mod(w + vec2(0.0, 1.0), GRASS_PERIOD));
  float d = grassHash(mod(w + vec2(1.0, 1.0), GRASS_PERIOD));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Grass is the only material in the palette whose green channel dominates both
// of the others, which is what lets a chromaticity test stand in for the
// material id the vertex format does not carry. Mirrored by grassMask() in
// living-ground.ts, which asserts the separation against the palette itself.
float grassMask(vec3 albedo) {
  return smoothstep(GRASS_MASK_LOW, GRASS_MASK_HIGH, albedo.g - max(albedo.r, albedo.b));
}

// -1 mossy, +1 sunlit, 0 exactly the colour the map painted. Signed rather than
// a mix parameter so the middle of the field displaces nothing at all -- see
// macroTone() in living-ground.ts.
float grassMacroTone(float m1, float m2) {
  return smoothstep(GRASS_MACRO_LOW, GRASS_MACRO_HIGH, m1 * GRASS_MACRO_WEIGHT + m2 * (1.0 - GRASS_MACRO_WEIGHT)) * 2.0 - 1.0;
}

// A gradient pushed into an edge with flat ground either side. Quantization
// destroys gradients and preserves edges (spec 074), so this is worth more than
// amplitude and costs no mottling.
float grassGustFront(float raw, float contrast) {
  float edge = mix(GRASS_GUST_EDGE_SOFT, GRASS_GUST_EDGE_HARD, clamp(contrast, 0.0, 1.0));
  return smoothstep(0.5 - edge, 0.5 + edge, raw);
}

float grassSlopeSteepness(float normalY, float start, float end) {
  return 1.0 - smoothstep(end, start, normalY);
}

// The forest-edge seam (spec 250). There is no prop distance field in this
// renderer, so this is 0.0 and uGrassShelter ships at 0 -- but everything that
// consumes it below is written and tested, so the day a field exists this is a
// function body rather than a feature. Whatever fills it in must return 0 in the
// open and 1 under cover, from world position alone.
float grassShelterAt(vec3 worldPos) {
  return 0.0;
}

// Everything above, composed. Returns the albedo the rest of the ground's
// patches -- the rock blend, the triplanar detail, the creases, the streak --
// then ride on top of.
vec3 livingGround(vec3 albedo, vec3 worldPos, vec3 worldNormal, float t) {
  float grass = grassMask(albedo) * uGrassAmount;
  if (grass <= 0.0) return albedo;

  vec2 p = worldPos.xz;

  // --- macro: patches of green tens of metres across -----------------------
  float macroFreq = 1.0 / max(1.0, uGrassMacroScale);
  float m1 = grassNoise(p * macroFreq);
  float m2 = grassNoise(p * macroFreq * GRASS_MACRO_OCTAVE + GRASS_MACRO_OFFSET);
  float dryField = grassNoise(p * macroFreq * GRASS_DRY_OCTAVE + GRASS_DRY_OFFSET);
  float tone = grassMacroTone(m1, m2);

  // --- slope: read before anything spends it -------------------------------
  float steep = grassSlopeSteepness(worldNormal.y, uGrassSlopeStart, uGrassSlopeEnd);

  // --- wind: one front crossing the ground, trails living inside it --------
  vec2 across = vec2(-uWindDir.y, uWindDir.x);
  vec2 drift = p - uWindDir * (t * GRASS_DRIFT_SPEED * uGrassWindSpeed);
  vec2 flow = vec2(dot(drift, uWindDir), dot(drift, across));
  float gustFreq = 1.0 / max(1.0, uGrassGustScale);
  float gust = grassGustFront(grassNoise(vec2(flow.x, flow.y * GRASS_GUST_ASPECT) * gustFreq),
                         uGrassGustContrast);

  // The stroke axis: the wind, bent by the macro field. One rotation, and it is
  // the whole of "swept curves" -- strokes over one patch comb together and the
  // next patch combs somewhere else, which is what a meadow does and what a
  // fixed direction cannot.
  float bend = (m1 - 0.5) * 2.0 * GRASS_FLOW_BEND;
  float cb = cos(bend);
  float sb = sin(bend);
  vec2 dir = vec2(uWindDir.x * cb - uWindDir.y * sb, uWindDir.x * sb + uWindDir.y * cb);
  vec2 side = vec2(-dir.y, dir.x);

  // Trails: the ridge of a field dragged sideways by the macro field, so the
  // lines curve. Sideways and not along -- a line displaced along its own length
  // does not appear to move at all, which is the aperture problem the streak's
  // grain already runs into. Multiplied by the front, so a trail arrives and
  // leaves with the gust rather than standing there.
  float trailFreq = 1.0 / max(1.0, uGrassWindScale);
  vec2 warped = drift + side * ((m2 - 0.5) * uGrassWindScale * GRASS_TRAIL_WARP);
  float tf = grassNoise(vec2(dot(warped, dir) * GRASS_TRAIL_STRETCH, dot(warped, side)) * trailFreq);
  float ridge = 1.0 - abs(tf * 2.0 - 1.0);
  float trail = smoothstep(1.0 - GRASS_TRAIL_WIDTH, 1.0, ridge) * gust;

  // --- meso: the brush strokes the wind lights up --------------------------
  float detailFreq = 1.0 / max(1.0, uGrassDetailScale);
  float stroke = grassNoise(vec2(dot(p, dir) * GRASS_STROKE_STRETCH, dot(p, side)) * detailFreq);
  float clump = grassNoise(p * detailFreq * GRASS_CLUMP_OCTAVE + GRASS_CLUMP_OFFSET);
  float broken = GRASS_CLUMP_BASE + GRASS_CLUMP_GAIN * clump;
  float cut = mix(GRASS_STROKE_CUT_HIGH, GRASS_STROKE_CUT_LOW, clamp(uGrassDetailDensity, 0.0, 1.0));
  float strokes = smoothstep(cut, cut + GRASS_STROKE_SOFT, stroke * broken);
  // The other tail of the same field, so the counter-strokes cost no sample and
  // land between the bright ones rather than under them.
  float shade = smoothstep(cut, cut + GRASS_STROKE_SOFT, (1.0 - stroke) * broken);

  // --- micro: sparse specks, both tails of one field -----------------------
  float microFreq = 1.0 / max(1.0, uGrassMicroScale);
  float micro = grassNoise(p * microFreq);
  float tips = smoothstep(GRASS_MICRO_CUT, GRASS_MICRO_CUT + GRASS_MICRO_SOFT, micro);
  float motes = smoothstep(GRASS_MICRO_CUT, GRASS_MICRO_CUT + GRASS_MICRO_SOFT, 1.0 - micro);

  // --- compose, as offsets from the authored base --------------------------
  // Relative and never absolute: both of the mesher's two grass tones take the
  // same shift, so spec 043's per-cell mottling survives underneath instead of
  // being painted over.
  vec3 toDark = uGrassDark - uGrassBase;
  vec3 toLight = uGrassLight - uGrassBase;
  vec3 toDry = uGrassDry - uGrassBase;

  // Signed: the light tone above the middle, the dark one below it, and nothing
  // at all at the middle. The min() carries the sign, so toDark -- which is
  // itself a negative offset -- is added rather than subtracted.
  vec3 delta = (toLight * max(tone, 0.0) - toDark * min(tone, 0.0)) * uGrassMacroStrength;

  float dry = smoothstep(GRASS_DRY_CUT, GRASS_DRY_CUT + GRASS_DRY_SOFT, dryField) * (1.0 - steep);
  delta = mix(delta, toDry, dry * uGrassMacroStrength * GRASS_DRY_SHARE);

  // The front, two-sided about the middle: it lifts the grass ahead of itself
  // and drops it behind, so the meadow's mean brightness does not move. A
  // one-sided front repaints the whole world to animate a part of it, which is
  // the mistake GLSL_STREAK records not making.
  float front = (gust - 0.5) * 2.0;
  delta += toLight * front * uGrassGustBrightness * (1.0 - steep);

  // ...and the pattern takes it a second time, so a stroke steps forward inside
  // a front rather than merely riding the tint under it. That is the brief's
  // distinction and the whole reason this is not just a brighter streak layer:
  // what comes alive is the grass, not the plane.
  float lit = 1.0 + max(front, 0.0) * GRASS_GUST_STROKE_GAIN;
  float strokeAmount = uGrassDetailStrength * (1.0 - steep * GRASS_STROKE_SLOPE_CUT);
  delta += toLight * strokes * strokeAmount * lit;
  delta += toDark * shade * strokeAmount * GRASS_STROKE_SHADE;

  // The trails, in their own right rather than only through the strokes: they
  // are thin curved lines and they have to be legible crossing bare ground, or
  // the one part of this that reads as *moving air* is only visible where the
  // brush marks already are.
  delta += toLight * trail * uGrassWindStrength * (1.0 - steep);

  delta += toLight * tips * uGrassMicroStrength;
  delta += toDark * motes * uGrassMicroStrength * GRASS_MICRO_DARK_SHARE;

  // Steep ground goes browner, and carries fewer strokes because strokeAmount
  // above already took them off it.
  delta = mix(delta, toDry * GRASS_SLOPE_DRY, steep * uGrassSlopeStrength);

  // The seam. Zero today; the arithmetic is what lands with the field.
  delta += (toDark - toDry * 0.35) * grassShelterAt(worldPos) * uGrassShelter;

  vec3 result = albedo + delta * grass;

  // Draining is done to the finished colour rather than to the offset, because
  // what a steep face loses is saturation and not a tone -- and the tone under
  // it is the map's, which this layer never gets to replace.
  float drained = steep * uGrassSlopeStrength * grass * GRASS_SLOPE_DESATURATE;
  float luma = dot(result, vec3(0.2126, 0.7152, 0.0722));
  result = mix(result, vec3(luma), drained);

  return max(result, vec3(0.0));
}
`;
}
