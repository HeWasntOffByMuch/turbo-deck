/**
 * The settings behind the *A Short Hike* look (spec 087), and the colour
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
 * frame (spec 087). Wired by step 4 onward, as each buffer starts to exist.
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

  // --- step 6: posterize and dither ---------------------------------------

  /** Quantize the frame to a limited palette. */
  readonly posterize: boolean;
  /**
   * The palette to quantize onto, as packed `0xRRGGBB`, or null for evenly
   * spaced steps per channel.
   *
   * Data, never shader source: a palette compiled into GLSL is a palette that
   * needs a rebuild to try.
   */
  readonly palette: readonly number[] | null;
  /** Steps per channel when `palette` is null. */
  readonly levels: number;
  /**
   * Apply the ordered 4x4 Bayer dither before quantizing, to break up the
   * banding a hard quantize leaves on a gradient.
   */
  readonly dither: boolean;
  /** How far the dither may push a value, in band edges. 1 is a full edge. */
  readonly ditherStrength: number;

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
  /** Distance from the camera at which the treatment starts, in world units. */
  readonly inkStart: number;
  /** Distance at which it reaches full strength. */
  readonly inkEnd: number;
  /** How far toward grey the fills go at full strength, 0..1. */
  readonly inkDesaturate: number;
  /** How far toward flat albedo the lit colour goes at full strength, 0..1. */
  readonly inkFlatten: number;
  /** Multiplier on normal-edge sensitivity at full strength, so far-off shapes keep their line. */
  readonly inkEdgeGain: number;
  /**
   * On-screen size in virtual pixels below which an outline fades out.
   *
   * A prop small enough that its outline lands on one pixel flickers between
   * drawn and not as the camera moves a fraction of a pixel. Fading it below a
   * threshold is cheaper than trying to make that stable.
   */
  readonly inkMinScreenSize: number;

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
 * render identically to the build before any of spec 087 landed -- identically
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
  normalEdgeThreshold: 0.35,
  outlineAgainstSky: false,

  posterize: false,
  palette: null,
  levels: 12,
  dither: false,
  ditherStrength: 0.05,

  ink: false,
  inkStart: 1200,
  inkEnd: 5200,
  inkDesaturate: 0.55,
  inkFlatten: 0.8,
  inkEdgeGain: 2.2,
  inkMinScreenSize: 3,

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
