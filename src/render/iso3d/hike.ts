/**
 * The settings behind the *A Short Hike* look (spec 093), and the colour
 * transfer the passes that read them are built on.
 *
 * Pure -- no three.js and no DOM -- so it runs and is tested headlessly, the
 * same arrangement `retro.ts` has with `RetroPass`: the shape the control panel
 * edits and the reference maths the shaders transcribe live here, and the
 * three.js half reads them.
 *
 * ## Why one object with every field already in it
 *
 * The look is about ten pieces -- low-resolution rendering, corrected normals,
 * depth and normal buffers, edge detection, posterization, a distance
 * treatment, baked curvature, shadows -- landing one commit at a time, and each
 * one changes what every pixel is. Ten pieces that can only be looked at
 * together cannot be judged at all: a frame that looks wrong after the seventh
 * is a frame with seven suspects. So each gets its own switch, and every switch
 * defaults off.
 *
 * The fields for steps that have not landed yet are declared here anyway,
 * inert, rather than appearing one per commit. The value of this object is that
 * a reader can see in one place what the arc does and what state the frame is
 * in; an object describing only the past cannot do that. Each field says which
 * step wires it.
 *
 * Thresholds, palette steps and distances are data here and never constants
 * compiled into shader source, so they can be tuned from the panel rather than
 * from a rebuild.
 */

import { DEFAULT_CREASE_ANGLE } from './shading.js';

/**
 * A single buffer the debug view may draw on its own, instead of the finished
 * frame (spec 093). Wired by step 4 onward, as each buffer starts to exist.
 */
export const HIKE_DEBUG_VIEWS = [
  /** The finished frame. */
  'off',
  /** Linear depth, near black to far white. */
  'depth',
  /** View-space normals, as the usual signed-to-unit RGB. */
  'normals',
  /** The combined edge mask, white on black. */
  'edges',
  /** Lit colour as it stands before quantization. */
  'color',
  /** The curvature baked into vertex colours, on its own. */
  'curvature',
] as const;
export type HikeDebugView = (typeof HIKE_DEBUG_VIEWS)[number];

/**
 * The virtual buffers the panel offers (spec 095).
 *
 * Data rather than a pair of sliders, because only a handful of sizes are worth
 * looking at and an arbitrary one is mostly a way to end up at an aspect the
 * camera framing was never tuned for. All 16:9, so the letterbox is the only
 * thing that changes shape with the window.
 */
export const VIRTUAL_SIZES = [
  { id: '320x180', width: 320, height: 180 },
  { id: '384x216', width: 384, height: 216 },
  { id: '480x270', width: 480, height: 270 },
  { id: '640x360', width: 640, height: 360 },
] as const;

/** The size step 3 opens at, and the one `HIKE_OFF` carries. */
export const DEFAULT_VIRTUAL_SIZE = '480x270';

/** A named virtual size, falling back to the default rather than throwing. */
export function virtualSizeById(id: string): { readonly width: number; readonly height: number } {
  const found = VIRTUAL_SIZES.find((size) => size.id === id);
  if (found) return found;
  return VIRTUAL_SIZES.find((size) => size.id === DEFAULT_VIRTUAL_SIZE) ?? { width: 480, height: 270 };
}

/**
 * The palettes the frame can be quantized onto (spec 098).
 *
 * Data, and deliberately not shader source: the pass uploads whichever of these
 * is chosen as a texture, so trying another one is a dropdown rather than a
 * rebuild. Sixteen entries is the ceiling the shader loops to.
 *
 * ## A palette needs values, not just hues
 *
 * The first version of these was the world's albedo colours straight out of
 * `palette.ts` -- the foliage greens, trunk brown, stone, water, sky. It
 * destroyed the picture, and the reason is worth writing down because it is not
 * obvious and the frame still looked stylized: those are the colours a surface
 * is *painted*, and the frame being quantized is the colours a surface is *lit*.
 * Lighting spends most of its range below the albedo, so nearly every pixel fell
 * beneath the darkest entry and snapped to the same green -- trees and ground
 * came out one flat shape.
 *
 * So each palette is a few hue families across a few values: the world's own
 * colours scaled toward black for shadow and mixed toward white for highlight.
 * The hues are still the game's; what is added is the range the lighting
 * actually occupies.
 */
export const HIKE_PALETTES = [
  { id: 'none', colors: null },
  {
    // Four families -- foliage, earth, stone, water -- across four values each.
    id: 'world',
    colors: [
      0x2c3d16, 0x4c6826, 0x7fae3f, 0xa5c779,
      0x462e16, 0x784e26, 0xc8823f, 0xd9a479,
      0x45423b, 0x777165, 0xc6bda9, 0xd8d2c4,
      0x1b444a, 0x2f757f, 0x4ec3d4, 0x8ad8e3,
    ],
  },
  {
    // The same four families at two values each: fewer colours, harder steps.
    id: 'eight',
    colors: [
      0x3f5a30, 0xa8c25a, 0x6b4a28, 0xc8823f,
      0x5a5750, 0xc6bda9, 0x2f757f, 0x8ad8e3,
    ],
  },
] as const;

/** The palette id the panel opens at: none, so the frame is the one that shipped. */
export const DEFAULT_PALETTE_ID = 'none';

/** A named palette's colours, or null for even steps. Unknown ids fall back to null. */
export function paletteById(id: string): readonly number[] | null {
  return HIKE_PALETTES.find((p) => p.id === id)?.colors ?? null;
}

/**
 * Every switch and every threshold in the hike look.
 *
 * Read once per frame and applied; nothing here is game state and nothing here
 * decides an outcome. See `HIKE_OFF` for the values the build opens at.
 */
export interface HikeSettings {
  // --- step 2: normals and shading ---------------------------------------

  /**
   * Share and average normals across curved surfaces, splitting them only at
   * hard creases, cap rims and seams.
   *
   * Off by default and likely to stay that way: everything but the terrain
   * surface is flat-shaded deliberately (spec 018, and spec 077 rebuilt the
   * lobed tree non-indexed precisely to keep its facets). The look being
   * imitated is flat-shaded too -- it gets its shape from facets and outlines,
   * not from smooth gradients. This exists so the choice can be seen rather
   * than assumed.
   */
  readonly smoothNormals: boolean;
  /**
   * Faces meeting at a sharper angle than this stay split rather than averaging
   * together, in radians. Only consulted while `smoothNormals` is on.
   *
   * The tessellation, not this number, is what decides whether smoothing reaches
   * anything -- `shading.ts` carries the table of what meets at what angle, and
   * why going much above the default turns a tapered trunk into a dome.
   */
  readonly creaseAngle: number;
  /**
   * Rotate the normal along with the wind's vertex displacement.
   *
   * Flat shading hides the need for this, because the face normal is re-derived
   * per fragment from the displaced position -- which is why it has never been
   * a visible bug. Under `smoothNormals` the geometry would bend while the
   * lighting stood still.
   */
  readonly swayNormals: boolean;

  // --- step 3: the offscreen low-resolution pipeline ----------------------

  /**
   * Render the scene at a fixed virtual resolution into an offscreen buffer and
   * upscale it by whole pixels, letterboxing the remainder.
   *
   * The play view already renders small and lets CSS stretch the canvas, but at
   * a *fractional* factor and at a resolution that changes with the window's
   * aspect -- so pixels come out unevenly doubled, which is most of why the
   * current frame does not read as pixel art.
   */
  readonly lowRes: boolean;
  /** The virtual buffer's width in pixels. Never changes with the window. */
  readonly virtualWidth: number;
  /** The virtual buffer's height in pixels. Never changes with the window. */
  readonly virtualHeight: number;
  /**
   * Snap the camera to whole virtual pixels each frame, so the world does not
   * shimmer between them as the view follows the player.
   *
   * Applied to the matrix the scene is *drawn* with and never to the one
   * picking is done against -- a snapped pick drifts by up to a pixel at the
   * snap boundary, and picking is the one part of the renderer that feeds the
   * sim.
   */
  readonly snapCamera: boolean;

  // --- step 4: the depth and normal buffers -------------------------------

  /**
   * Write linear depth and view-space normals alongside colour, at the virtual
   * resolution. Normals are octahedral in RGBA8 rather than in a float target,
   * so nothing depends on a float render target extension being present.
   */
  readonly buffers: boolean;

  // --- step 5: edge detection ---------------------------------------------

  /** Find outlines from the depth and normal buffers. Requires `buffers`. */
  readonly edges: boolean;
  /**
   * How far a neighbour must sit off the plane reconstructed from its own
   * normal and depth to count as an edge, in world units.
   *
   * Measured against that plane rather than against a raw depth difference, so
   * a surface seen at a glancing angle -- where depth changes fast across the
   * screen with no edge present -- does not draw a line down its middle.
   */
  readonly depthEdgeThreshold: number;
  /** How far two neighbouring normals must diverge to count as an edge, 0..1. */
  readonly normalEdgeThreshold: number;
  /**
   * Whether the far plane may generate an edge.
   *
   * Off means the background is masked, which is the sane default: with it on,
   * every silhouette in the world is rimmed against the sky whether or not the
   * look wants that.
   */
  readonly outlineAgainstSky: boolean;
  /**
   * The line's colour, as a packed `0xRRGGBB`.
   *
   * A constant, composited over the frame rather than multiplied into it: a line
   * whose colour depends on what it crosses fades out over dark ground, which is
   * exactly where a silhouette needs it most.
   */
  readonly outlineColor: number;
  /** How opaque the line is, 0..1. */
  readonly outlineStrength: number;

  // --- step 6: posterize and dither ---------------------------------------

  /**
   * The palette to quantize onto, as packed `0xRRGGBB`, or null for the evenly
   * spaced steps per channel the retro filter has always used.
   *
   * Data, never shader source: a palette compiled into GLSL is a palette that
   * needs a rebuild to try. The pass uploads it as a one-row texture.
   *
   * There is no separate `posterize` switch, and no `levels`, `dither` or
   * `ditherStrength` here either. Spec 038's filter already owns all four and
   * already has sliders for them; a second set in this object would be two knobs
   * for one thing, and the interesting question -- steps or palette -- is
   * answered by whether this is null.
   */
  readonly palette: readonly number[] | null;

  // --- step 7: the distance / ink treatment -------------------------------

  /**
   * Fog and desaturate the fills as they recede, flatten their shading toward
   * albedo, and composite the outlines afterward at a constant dark value.
   *
   * The compositing order is the whole effect: fogging the lines along with the
   * fills gives haze, and distant shapes go soft. Fogging only the fills leaves
   * geometry that has lost its gradient but kept its line -- a flat tone bounded
   * by ink, which is the thing being imitated.
   */
  readonly ink: boolean;
  /**
   * How far *past the camera's focus point* the treatment starts, in world units.
   *
   * Past the focus, not away from the camera, and the difference is the whole
   * setting. This camera is orthographic and parked a fixed 6,000 units back
   * however close it is looking; a frame at the default zoom spans about 700
   * units of depth, all of it near 6,000. So distance-from-the-camera is
   * dominated by a constant that has nothing to do with the scene, and a ramp
   * expressed in it either misses the whole frame or swallows it -- which is what
   * the first version of this did, treating every pixel at full strength and
   * reading as a filter over the picture rather than as distance.
   *
   * Measured from the focus, 0 is the ground under the player and the numbers
   * mean what they say. It also survives the Distance slider and the zoom, both
   * of which move the absolute depth of everything without changing what is near
   * or far *in the frame*.
   */
  readonly inkStart: number;
  /** How far past the focus it reaches full strength. */
  readonly inkEnd: number;
  /** How far toward grey the fills go at full strength, 0..1. */
  readonly inkDesaturate: number;
  /**
   * How far the lit colour is flattened toward one tone at full strength, 0..1.
   *
   * Named for "lerp toward flat albedo", which is what it is for; what it does is
   * hold the hue and normalize the luminance, because a surface whose pixels
   * share a luminance has no shading gradient left. See `ink.ts` for why that is
   * the goal met rather than the method followed.
   */
  readonly inkFlatten: number;
  /** How far the fill drifts toward the sky at full strength, 0..1. */
  readonly inkFog: number;
  /** Multiplier on normal-edge sensitivity at full strength, so far-off shapes keep their line. */
  readonly inkEdgeGain: number;
  /**
   * Edge neighbours a pixel needs before its outline is drawn at full strength,
   * counted in the eight around it. 0 disables the test.
   *
   * The brief asked for this as an *on-screen size* threshold, to stop small
   * distant props flickering. Under an orthographic camera there is no such
   * thing: screen size does not change with distance, so a pebble is the same
   * few pixels at the back of the map as at the player's feet and "small because
   * distant" is not a category that exists here.
   *
   * The flicker it names is real, though, and it is about *isolation*: an outline
   * a pixel or two long has nothing holding it steady, so it blinks as the
   * geometry crosses a sample boundary. A line belonging to a real silhouette has
   * neighbours along it. So the test is coherence rather than size, which targets
   * the same artefact by the property that actually predicts it.
   */
  readonly outlineMinNeighbours: number;

  // --- step 8: baked curvature / cavity ------------------------------------

  /** Darken vertex colours where adjacent face normals diverge sharply. */
  readonly curvature: boolean;
  /** How dark the sharpest crease goes, 0..1. */
  readonly curvatureStrength: number;

  // --- step 9: shadows ------------------------------------------------------

  /**
   * Filter the shadow map with a Poisson-disc PCF kernel instead of taking one
   * unfiltered comparison per pixel.
   *
   * Off by default, and that is a real choice rather than caution: spec 045
   * picked `BasicShadowMap` at a low resolution *so that* every shadow edge
   * lands on a texel boundary and stays hard, on the argument that a soft
   * penumbra would be the one smooth thing in a posterized frame. This makes
   * the other option available without quietly taking it.
   */
  readonly softShadows: boolean;
  /** PCF kernel radius in shadow-map texels. */
  readonly shadowPcfRadius: number;

  // --- debugging -------------------------------------------------------------

  /** Draw one intermediate buffer on its own instead of the finished frame. */
  readonly debug: HikeDebugView;
}

/**
 * Everything off, and every threshold at the value its step will open at.
 *
 * This is the state the build ships in until a switch is thrown, and it must
 * render identically to the build before any of spec 093 landed -- identically
 * in the strong sense, since with every pass skipped there is nothing between
 * the scene and the canvas that was not there before.
 */
export const HIKE_OFF: HikeSettings = {
  smoothNormals: false,
  creaseAngle: DEFAULT_CREASE_ANGLE,
  swayNormals: false,

  lowRes: false,
  virtualWidth: 480,
  virtualHeight: 270,
  snapCamera: false,

  buffers: false,

  edges: false,
  depthEdgeThreshold: 6,
  // 0.55, not the 0.35 spec 097 opened at. The terrain surface is a lattice of
  // quads whose corners are jittered off the grid, so neighbouring cells differ
  // by a few degrees everywhere -- enough to fire at 0.35 and speckle open ground
  // with lines that belong to no feature. 0.55 is above that chatter and well
  // below the ~90 degrees a real crease turns through.
  normalEdgeThreshold: 0.55,
  outlineAgainstSky: false,
  outlineColor: 0x1a1a22,
  outlineStrength: 1,

  palette: null,

  ink: false,
  // Relative to the focus, and sized to the frame: at the default zoom the view
  // reaches about 350 units past the player before the top edge, so the ramp
  // starts just beyond them and is nearly complete at the horizon. Zooming out
  // widens the frame without moving these, which is right -- a wider view should
  // show more of the far treatment, not rescale it.
  inkStart: 80,
  inkEnd: 380,
  inkDesaturate: 0.55,
  inkFlatten: 0.8,
  inkFog: 0.45,
  inkEdgeGain: 2.2,
  outlineMinNeighbours: 2,

  curvature: false,
  curvatureStrength: 0.35,

  softShadows: false,
  shadowPcfRadius: 1.5,

  debug: 'off',
};

// --- the colour transfer ----------------------------------------------------

/**
 * Where the sRGB transfer function switches from its linear foot to its power
 * curve, on each side. The two are stated separately because the encoded knee
 * is not the encoded value of the linear one to the precision that matters, and
 * rounding one into the other is exactly the sort of near-miss that shows up
 * later as an edge threshold needing a strange number.
 */
const SRGB_KNEE_LINEAR = 0.0031308;
const SRGB_KNEE_ENCODED = 0.04045;
const SRGB_SLOPE = 12.92;
const SRGB_ALPHA = 0.055;
const SRGB_GAMMA = 2.4;

/**
 * Linear working space -> sRGB display space.
 *
 * The real piecewise transfer, not the `pow(1/2.2)` approximation of it. The
 * approximation is off by up to about 0.02 in the darks, which is a whole
 * palette step at twelve levels and a visible band edge in the wrong place.
 *
 * This is the reference the GLSL in the passes mirrors term for term; a shader
 * expression nobody can execute is where a typo lives forever, which is the
 * same reason `wind.ts` keeps its transcription beside the source.
 */
export function srgbEncode(linear: number): number {
  if (linear <= SRGB_KNEE_LINEAR) return linear * SRGB_SLOPE;
  return (1 + SRGB_ALPHA) * Math.pow(linear, 1 / SRGB_GAMMA) - SRGB_ALPHA;
}

/**
 * `srgbEncode` as GLSL, for the passes that write display-space pixels.
 *
 * One definition rather than a copy per pass, because there are now several and
 * they have to agree: the retro pass encodes the lit frame, and the outline pass
 * has to encode its constants to lay them over the result. Every number is
 * interpolated from the constants above, so the shader cannot drift from the
 * reference by someone editing one of them.
 */
export function glslSrgbEncodeChunk(): string {
  return /* glsl */ `
// Linear working space -> sRGB display space (the exact piecewise transfer,
// matching what the renderer would have applied drawing straight to the canvas).
vec3 toSRGB(vec3 c) {
  vec3 low = c * ${SRGB_SLOPE};
  vec3 high = pow(c, vec3(${(1 / SRGB_GAMMA).toFixed(8)})) * ${1 + SRGB_ALPHA} - ${SRGB_ALPHA};
  return mix(high, low, step(c, vec3(${SRGB_KNEE_LINEAR})));
}
`;
}

/** sRGB display space -> linear working space. The exact inverse of `srgbEncode`. */
export function srgbDecode(encoded: number): number {
  if (encoded <= SRGB_KNEE_ENCODED) return encoded / SRGB_SLOPE;
  return Math.pow((encoded + SRGB_ALPHA) / (1 + SRGB_ALPHA), SRGB_GAMMA);
}

/**
 * A packed `0xRRGGBB` as its three linear channels.
 *
 * The same journey `new THREE.Color(hex)` takes a palette constant on, written
 * out so a test can hold three.js to it: every colour in this renderer is
 * authored as an sRGB hex and has to reach the lighting maths as linear.
 */
export function unpackLinear(hex: number): readonly [number, number, number] {
  return [
    srgbDecode(((hex >> 16) & 0xff) / 255),
    srgbDecode(((hex >> 8) & 0xff) / 255),
    srgbDecode((hex & 0xff) / 255),
  ];
}
