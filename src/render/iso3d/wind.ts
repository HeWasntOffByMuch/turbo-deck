/**
 * The weather (spec 074). One wind vector, read by three shaders: the tree
 * sway, the streak layer over the ground, and the water.
 *
 * Pure -- no three.js, no DOM, no clock -- for two reasons. The first is that
 * the numbers below are the art direction, and a number that decides how the
 * world looks should be checkable in Node rather than by squinting at a frame.
 * The second is that a GLSL expression nobody can execute is a place for a typo
 * to live forever: {@link windAt} and {@link bayer4} are shader functions
 * written out in TypeScript, term for term, so the shape of the motion and the
 * dither pattern are unit-tested even though the thing that runs is a string.
 *
 * `wind-uniforms.ts` holds the three.js half: the uniform objects every
 * material shares *by reference*, so "one source of truth" is mechanical rather
 * than a promise.
 *
 * ## On units
 *
 * This world is not metric. A full-grown fir stands 128 world units tall and a
 * terrain cell is 22 across, so a world unit is somewhere around 8cm. Every
 * frequency below is in seconds and is taken from the reference as-is; every
 * *distance* has been divided through by that scale, which is why
 * {@link WindConfig.travel} is not the 0.06/unit the brief quotes. At 0.06 the
 * travelling wave would have a 105-unit wavelength -- shorter than one tree's
 * crown is wide -- and a grove would shimmer at random instead of leaning
 * together. See {@link WIND} for what it is instead.
 *
 * ## Composition order
 *
 * The GLSL fragments below are concatenated, and they are not independent:
 * `GLSL_WIND` first (it declares the uniforms), then `GLSL_NOISE` (it declares
 * `n2`), then `GLSL_STREAK` (it uses both). {@link glslWindChunk} assembles them
 * in that order so no caller has to remember it.
 */

export interface WindConfig {
  /** Wind direction on the XZ plane. Unit length; `dirZ` is world Z, not Y. */
  readonly dirX: number;
  readonly dirZ: number;
  /** Radians of lean at the crown when `wind()` reads 1. */
  readonly strength: number;
  /**
   * Radians of phase the wave picks up per world unit travelled along `dir`.
   * This is what makes neighbouring trees lag rather than tick together.
   */
  readonly travel: number;
  /** How fast the streak layer scrolls downwind, world units per second. */
  readonly streakSpeed: number;
  /** World units per streak feature, across the flow. */
  readonly streakScale: number;
  /** How far the streak layer may lift or drop albedo, as a fraction. */
  readonly streakContrast: number;
}

/**
 * The wave's spatial period, in world units.
 *
 * The one number in this file that had to be chosen rather than converted, and
 * it is a genuine trade-off in both directions. The brief's 0.06 radians per
 * unit assumes a metric world and gives a 105-unit wavelength here -- narrower
 * than one fir's crown, so adjacent trees would sit at opposite phase and a
 * grove would shimmer rather than lean. Push it much wider than this and a
 * whole screen of forest moves as one, which is a clock, not a wave.
 *
 * 600 puts a little over one full gust across the default view (the camera sees
 * roughly 640x400 units), a third of a cycle between neighbouring trees at the
 * ~200 units the scatter settles at, and a tenth of a second between two trees
 * only 20 units apart.
 */
export const WAVE_LENGTH = 600;

/**
 * Compass bearing, degrees, of the direction the wind blows towards.
 *
 * The direction is a *look* decision, not a physical one. The camera is fixed
 * isometric and looks down the world's +X/+Z diagonal, so a wind along that
 * diagonal pushes the trees almost straight towards or away from the viewer,
 * where a six-degree lean is worth a couple of pixels and reads as nothing at
 * all. -45 degrees is the perpendicular diagonal: every scrap of the
 * displacement lands across the screen, which is the only direction an
 * orthographic camera can show it in.
 *
 * Stated as the bearing rather than as a vector because the vector then comes
 * out exactly unit-length, and because the weather panel's direction slider
 * (spec 075) is in the same units -- so its default position and this are one
 * number rather than two that have to be kept agreeing.
 */
export const WIND_BEARING_DEG = -45;

/** The unit direction a compass bearing in degrees points along, on the XZ plane. */
export function windDirection(bearingDeg: number): { x: number; z: number } {
  const radians = (bearingDeg * Math.PI) / 180;
  return { x: Math.cos(radians), z: Math.sin(radians) };
}

const HOME = windDirection(WIND_BEARING_DEG);

/** The weather the world is art-directed for, and what every knob resets to. */
export const WIND: WindConfig = {
  dirX: HOME.x,
  dirZ: HOME.z,
  /**
   * 0.10 rad = 5.7 degrees of lean at the crown at full gust, which puts the
   * tip of a 128-unit fir 12.7 units downwind: 9.9% of its height, the middle
   * of the 8-12% the reference measures.
   */
  strength: 0.1,
  travel: (2 * Math.PI) / WAVE_LENGTH,
  streakSpeed: 62,
  streakScale: 190,
  streakContrast: 0.055,
};

/**
 * What the weather panel is allowed to ask for (spec 075).
 *
 * Bounds, not suggestions. Strength is capped at 2.5x the art-directed lean
 * because the bend is an arc about the base and the crown of a 128-unit fir
 * swings 31 units at that setting -- already past what the inflated instance
 * bounding spheres were sized for, and well past anything that still reads as a
 * conifer rather than as a whip. Zero is allowed and is the honest way to see
 * the world without weather.
 */
export const WIND_LIMITS = {
  /** Multiplier on `WIND.strength`. 1 is the art direction. */
  minStrength: 0,
  maxStrength: 2.5,
  /** Multiplier on the shared clock's rate. 0 freezes the weather mid-gust. */
  minSpeed: 0,
  maxSpeed: 3,
} as const;

/**
 * How visible a wind blowing along `bearingDeg` will be, in `[0, 1]`.
 *
 * The camera is fixed isometric looking down the world's +X/+Z diagonal, so
 * displacement along that diagonal projects to almost nothing: a tree leaning
 * six degrees straight at the viewer moves about two pixels. The panel shows
 * this beside the direction slider rather than letting someone dial in a wind
 * that is working perfectly and looks broken.
 */
export function screenVisibility(bearingDeg: number): number {
  const dir = windDirection(bearingDeg);
  return Math.abs((dir.x - dir.z) / Math.SQRT2);
}

/** Angular frequencies of the three sway harmonics, radians/second. */
const OMEGA = [2.2, 4.4, 6.9] as const;
/** Their amplitudes. They sum to 1, so `windAt` peaks at the gust envelope. */
const AMPLITUDE = [0.6, 0.25, 0.15] as const;
/** Phase offsets, so the three do not all cross zero together at t = 0. */
const PHASE = [0, 1.3, 2.7] as const;
/** How much further along the wave each harmonic travels than the first. */
const TRAVEL_SCALE = [1, 1.7, 2.3] as const;

/** The gust envelope: a slow swell the three harmonics ride inside. */
const GUST_OMEGA = 0.25;
const GUST_BASE = 0.65;
const GUST_SWING = 0.35;
const GUST_TRAVEL_SCALE = 0.3;

/** The dominant harmonic's frequency in Hz -- what the eye actually reads. */
export const DOMINANT_HZ = OMEGA[0] / (2 * Math.PI);
/** The gust envelope's frequency in Hz. */
export const GUST_HZ = GUST_OMEGA / (2 * Math.PI);
/** The largest `|windAt|` can ever be: every harmonic peaking under a full gust. */
export const WIND_MAX = GUST_BASE + GUST_SWING;

/**
 * The wind at a point, at a time. The shader's `windAt()`, term for term.
 *
 * Sampled at a **tree's origin**, never per vertex: a canopy whose every leaf
 * sampled the field where it happens to be does not lean, it shears sideways
 * off its own trunk. That is the whole reason this takes a point rather than
 * being folded into the vertex maths.
 */
export function windAt(config: WindConfig, x: number, z: number, t: number): number {
  const travel = (x * config.dirX + z * config.dirZ) * config.travel;
  const gust = GUST_BASE + GUST_SWING * Math.sin(t * GUST_OMEGA - travel * GUST_TRAVEL_SCALE);
  let sum = 0;
  for (let i = 0; i < OMEGA.length; i++) {
    sum += Math.sin(t * (OMEGA[i] ?? 0) - travel * (TRAVEL_SCALE[i] ?? 0) + (PHASE[i] ?? 0)) * (AMPLITUDE[i] ?? 0);
  }
  return gust * sum;
}

/**
 * The lag, in seconds, between the wind at two points `distance` apart along
 * the wind axis. What acceptance asks for when it asks whether neighbouring
 * trees are out of phase.
 */
export function phaseLagSeconds(config: WindConfig, distance: number): number {
  return (distance * config.travel) / (OMEGA[0] ?? 1);
}

/**
 * How stiff a tree is: thick trunks under short crowns barely move.
 *
 * Scale-free on purpose -- a sapling and a full-grown fir of the same species
 * are the same geometry at two scales, and scaling a tree up does not make it
 * more flexible. Only a genuinely stouter trunk does.
 */
export function stiffness(trunkRadius: number, height: number): number {
  if (height <= 0) return 1;
  return 1 / (1 + trunkRadius / height);
}

/**
 * The lean, in radians, of a vertex `bend` of the way up a tree.
 *
 * Quadratic in `bend`, which is what turns a rotation into a curve: the base is
 * pinned, the lower trunk barely moves, and the crown carries nearly all of the
 * angle.
 */
export function bendAngle(config: WindConfig, wind: number, stiff: number, bend: number): number {
  const w = Math.min(1, Math.max(0, bend));
  return config.strength * wind * stiff * w * w;
}

/**
 * How far downwind the tip of a tree `height` tall can be pushed, world units.
 *
 * `strengthMultiplier` is what the weather panel is dialled to (spec 075). It
 * defaults to 1, the art direction — but the *bounding spheres* are inflated
 * against {@link WIND_LIMITS}`.maxStrength` rather than against 1, because a
 * player who turns the wind up must not be rewarded with trees popping out at
 * the edge of the frame. Sizing bounds for the default and then allowing 2.5x
 * of it is the same bug as not inflating them at all, only rarer and therefore
 * harder to find.
 */
export function maxTipDisplacement(config: WindConfig, height: number, strengthMultiplier = 1): number {
  return height * Math.sin(config.strength * strengthMultiplier * WIND_MAX);
}

/**
 * The 4x4 ordered-dither threshold at a pixel, in `[0, 1)`. The shader's
 * `bayer4()`, term for term.
 *
 * Written arithmetically rather than as a lookup because GLSL ES 1.00 -- which
 * is what three.js compiles to unless a material asks otherwise -- has neither
 * bitwise operators nor guaranteed dynamic indexing in a fragment shader. The
 * expression is the standard construction (interleave `x ^ y` with `y`, then
 * reverse the bits) with every bit op written as `mod`/`floor`.
 */
export function bayer4(x: number, y: number): number {
  const px = ((Math.floor(x) % 4) + 4) % 4;
  const py = ((Math.floor(y) % 4) + 4) % 4;
  const x0 = px % 2;
  const x1 = Math.floor(px / 2);
  const y0 = py % 2;
  const y1 = Math.floor(py / 2);
  const u0 = (x0 + y0) % 2;
  const u1 = (x1 + y1) % 2;
  return (u0 * 8 + y0 * 4 + u1 * 2 + y1) / 16;
}

/**
 * The water surface's palette and thresholds (spec 074, part 2).
 *
 * Exactly four colours, and every threshold is a world-unit distance from the
 * shore -- converted from the reference's metres at this world's ~13 units to
 * the metre. Nothing here is view-dependent: the camera angle never changes, so
 * a fresnel term has one answer and that answer is already in the palette.
 */
export const WATER = {
  /** The two deep tones. `mid` is the ring the shallow band sits inside. */
  deep: 0x1e6f8c,
  mid: 0x2f93ab,
  /** The bright band that hugs the coast, and the foam on top of it. */
  shallow: 0x63cfd8,
  foam: 0xdff4f4,
  /** The largest shore distance the R8 field can encode, world units. */
  shoreRange: 260,
  /** Shore distance the `deep -> mid` step falls at, world units. */
  midEdge: 117,
  /** ...and the `mid -> shallow` step. */
  shallowEdge: 46,
  /** How far the noise field may push a band edge in or out, world units. */
  edgeWobble: 78,
  /** How far the Bayer dither may push it. Sub-band, on purpose. */
  edgeDither: 20,
  /** Foam reaches this far out at the crest of the travelling pulse... */
  foamEdge: 12,
  foamSwing: 8,
  /** ...and never past here, so a pulse cannot flood the shallows. */
  foamLimit: 33,
  /** How fast the foam pulse travels, radians/second and radians/world unit. */
  foamOmega: 1.6,
  foamTravel: 0.09,
  /** World units per feature of the warp field the squiggles come from. */
  fieldScale: 22,
  /** How far the domain warp may drag a sample, world units. */
  fieldWarp: 23,
  /** Isolines per unit of field. */
  isoLines: 5,
  /** Half-width of an isoline, in field units. */
  isoWidth: 0.035,
  /** How much brighter an isoline is than the band it crosses. */
  isoGain: 1.22,
} as const;

/** GLSL for a float literal, at enough precision that the inlining is lossless. */
function f(value: number): string {
  return value.toFixed(8);
}

/**
 * `windAt()`, and the three uniforms every weather shader reads.
 *
 * Nearly everything here is *inlined* from {@link WIND} rather than declared as
 * a uniform, because it is art direction baked at build time: the harmonics,
 * their amplitudes, the gust envelope and the wave's spatial period are the
 * look, and none of them is a knob.
 *
 * The exceptions are the three the weather panel (spec 075) drives. Direction
 * and strength have to be uniforms because they are the two the player can
 * feel: which way the world leans, and how hard. Time is a uniform because it
 * is a clock. They are declared here, once, so the trees, the ground and the
 * sea cannot be handed different weather.
 */
export const GLSL_WIND = /* glsl */ `
uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uWindStrength;

const float WIND_TRAVEL = ${f(WIND.travel)};

float windAt(vec2 originXZ, float t) {
  float travel = dot(originXZ, uWindDir) * WIND_TRAVEL;
  float gust = ${f(GUST_BASE)} + ${f(GUST_SWING)} * sin(t * ${f(GUST_OMEGA)} - travel * ${f(GUST_TRAVEL_SCALE)});
  return gust * ( sin(t * ${f(OMEGA[0])} - travel)                                       * ${f(AMPLITUDE[0])}
                + sin(t * ${f(OMEGA[1])} - travel * ${f(TRAVEL_SCALE[1])} + ${f(PHASE[1])}) * ${f(AMPLITUDE[1])}
                + sin(t * ${f(OMEGA[2])} - travel * ${f(TRAVEL_SCALE[2])} + ${f(PHASE[2])}) * ${f(AMPLITUDE[2])} );
}
`;

/**
 * Value noise, the domain-warped field the water's squiggles are isolines of,
 * and the 4x4 Bayer threshold that stipples the band edges.
 *
 * `n2` is plain hashed value noise with a smoothstep fade. `smoothstep` inside
 * the *noise* is fine and necessary; the ban on it is about the colour bands,
 * which must be `step`.
 */
export const GLSL_NOISE = /* glsl */ `
const float FIELD_SCALE = ${f(1 / WATER.fieldScale)};
const float FIELD_WARP = ${f(WATER.fieldWarp)};

float hash21(vec2 p) {
  vec2 q = fract(p * vec2(127.1, 311.7));
  q += dot(q, q + 34.23);
  return fract(q.x * q.y * 43758.5453);
}

float n2(vec2 p) {
  vec2 i = floor(p);
  vec2 fr = fract(p);
  vec2 u = fr * fr * (3.0 - 2.0 * fr);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// The field the surface squiggles are isolines of. The warp is the whole trick:
// sampling noise at a point that is itself drifting through another noise field
// makes the isolines pinch off, merge and reconnect, where a field sampled at a
// scrolling point would only slide past rigidly.
float warpedField(vec2 p, float t) {
  vec2 w = vec2(n2(p * FIELD_SCALE + t * 0.05),
                n2(p * FIELD_SCALE + 31.4 - t * 0.04)) - 0.5;
  return n2((p + w * FIELD_WARP) * (FIELD_SCALE * 1.5) + vec2(0.0, t * 0.03));
}

// 4x4 ordered dither in [0, 1), indexed by screen pixel. Arithmetic rather than
// a table: GLSL ES 1.00 has no bitwise operators and no guaranteed dynamic
// indexing in a fragment shader. Mirrored by bayer4() in wind.ts.
float bayer4(vec2 fragCoord) {
  vec2 p = mod(floor(fragCoord), 4.0);
  float x0 = mod(p.x, 2.0);
  float x1 = floor(p.x * 0.5);
  float y0 = mod(p.y, 2.0);
  float y1 = floor(p.y * 0.5);
  float u0 = mod(x0 + y0, 2.0);
  float u1 = mod(x1 + y1, 2.0);
  return (u0 * 8.0 + y0 * 4.0 + u1 * 2.0 + y1) / 16.0;
}
`;

/**
 * The streak layer (spec 074, part 3): a faint scrolling grain multiplied into
 * albedo, sampled at world XZ shifted downwind by the same wind and the same
 * clock the trees lean to.
 *
 * It is the smallest piece of code here and does most of the work of making
 * this one weather system rather than two effects: the ground and the sea carry
 * the same shadow of moving air across the coastline, which is what stops the
 * water reading as a separate object dropped into the scene.
 */
export const GLSL_STREAK = /* glsl */ `
const float STREAK_SCALE = ${f(1 / WIND.streakScale)};
const float STREAK_SPEED = ${f(WIND.streakSpeed)};
const float STREAK_CONTRAST = ${f(WIND.streakContrast)};

// Multiplier for albedo at a world point: 1 +- STREAK_CONTRAST.
float windStreak(vec2 worldXZ, float t) {
  vec2 p = worldXZ - uWindDir * (t * STREAK_SPEED);
  // Stretched along the wind, so the grain reads as streaks being dragged
  // rather than as blobs drifting: one octave squashed 4:1 across the flow.
  vec2 along = vec2(dot(p, uWindDir), dot(p, vec2(-uWindDir.y, uWindDir.x)));
  float n = n2(vec2(along.x * 0.25, along.y) * STREAK_SCALE);
  return 1.0 + (n - 0.5) * 2.0 * STREAK_CONTRAST;
}
`;

/**
 * Everything a shader needs to read the weather, in dependency order. Callers
 * paste this in rather than assembling the three fragments themselves.
 */
export function glslWindChunk(): string {
  return `${GLSL_WIND}\n${GLSL_NOISE}\n${GLSL_STREAK}\n`;
}
