/**
 * What a critter species *is* (spec 049): proportions, a list of rigid blocks,
 * a few animated sockets, and a colour scheme. Pure data -- no three.js, no DOM
 * -- so a species can be validated, measured and previewed headlessly, and so
 * adding an animal never means writing rendering code.
 *
 * Coordinate frame is the scene's: **standing at the origin, facing +x, up +y**,
 * the figure's left at -z and its right at +z. Distances are world units at
 * `bodyScale == 1`, on the same scale as `cloth/figure.ts` (a ~85-unit character
 * stands about as tall as an 86-unit tree).
 */

import type { FigureMetrics } from '../cloth/figure.js';

/** The species the game ships. Doubles as the sandbox's unit kind. */
export type CritterId = 'pig' | 'cow';

/**
 * A colour slot on a critter.
 *
 * The `coat*` trio follows the player's chosen colour, so two players of the
 * same species are told apart instantly. The rest are anatomy: skin (snout, ear
 * lining, udder) is nudged toward the coat so it still looks like the same
 * animal, while `marking`, `horn`, `hoof` and `eye` are species constants that
 * are *contrast-corrected* against the coat rather than left to collide with it.
 */
export type CoatRole =
  | 'coat'
  | 'coatShade'
  | 'coatLight'
  | 'skin'
  | 'skinDeep'
  | 'marking'
  | 'horn'
  | 'hoof'
  | 'eye';

export const COAT_ROLES: readonly CoatRole[] = [
  'coat',
  'coatShade',
  'coatLight',
  'skin',
  'skinDeep',
  'marking',
  'horn',
  'hoof',
  'eye',
];

/** A full colour scheme: every role resolved to a 24-bit colour. */
export type CoatColors = Record<CoatRole, number>;

/**
 * The primitive a part is cut from. Three shapes cover every animal built so
 * far, and each is a handful of faces so the whole cast stays flat-shaded and
 * low-poly:
 *
 *  - `box`  — an axis-aligned block: torsos, limbs, muzzles.
 *  - `ball` — a faceted ellipsoid (icosahedron): skulls, bellies, cheeks.
 *  - `cone` — a low-segment cone, optionally truncated by {@link PartSpec.taper}:
 *             ears, horns, tails, tapered limbs.
 */
export type PartShape = 'box' | 'ball' | 'cone';

/**
 * One rigid block of an animal, in the local frame of whatever it hangs off.
 *
 * A part is never posed directly: it is parented to a bone or a socket and
 * inherits that node's animation. Which is the point -- the walk cycle is shared
 * across every species precisely because no species describes motion, only
 * shapes hung on things that already move.
 */
export interface PartSpec {
  readonly name: string;
  /** A `BONE` index, or the name of a {@link SocketSpec} on this species. */
  readonly attach: number | string;
  readonly shape: PartShape;
  readonly role: CoatRole;
  /** Full extents (not half-extents) along local x, y, z. */
  readonly size: readonly [number, number, number];
  /** Centre offset from the attachment point. For `cone`, the base's centre. */
  readonly pos: readonly [number, number, number];
  /** Local XYZ-order Euler rotation, radians. */
  readonly rot?: readonly [number, number, number];
  /** Emit a second copy at `-z`, with its x/y rotations negated. */
  readonly mirror?: boolean;
  /**
   * `cone` only: the **+y** end's radius as a fraction of the **−y** base.
   * 0 is a true point, 1 is a cylinder. A cone always narrows upward in its own
   * frame; anything that narrows downward (a limb hanging off a joint) says so
   * with `rot: [0, 0, Math.PI]`, so `size` is always the part's full extent.
   */
  readonly taper?: number;
  /** Facet count. `ball`: icosahedron detail (0 = 20 faces). `cone`: sides. */
  readonly facets?: number;
}

/**
 * Secondary motion for a socket, expressed as amplitudes rather than as code.
 *
 * All of it is driven off numbers the shared walk cycle already produces -- the
 * stride phase, the ground speed, the turn rate -- so ears that flap and a tail
 * that swishes cost a species four numbers and no new animation logic.
 */
export interface WobbleSpec {
  /** Which local axis the socket rotates about. */
  readonly axis: 'x' | 'y' | 'z';
  /** Radians of swing at a full run, driven by the stride cycle. */
  readonly strideAmp: number;
  /** Phase offset in cycles (0..1), so ears and tail are not in lockstep. */
  readonly phase?: number;
  /** Radians of idle sway, faded in as the character comes to rest. */
  readonly idleAmp?: number;
  /** Idle sway rate in Hz. */
  readonly idleHz?: number;
  /** Radians of swing-out per rad/s of turning: a tail thrown by a hard turn. */
  readonly leanAmp?: number;
  /** How fast the socket chases its target (1/s). Low values read as heavy. */
  readonly follow?: number;
}

/**
 * An animated attachment point the skeleton does not provide. Ears, snouts,
 * horns and tails are not bones -- nothing needs them for collision or cloth --
 * but they are exactly what makes one animal read as a different animal, so they
 * get their own nodes hanging off a real bone.
 */
export interface SocketSpec {
  readonly socket: string;
  /** A `BONE` index this socket is parented to. */
  readonly parentBone: number;
  readonly pos: readonly [number, number, number];
  readonly rot?: readonly [number, number, number];
  readonly wobble?: WobbleSpec;
  /**
   * Emit a mirrored twin named `${socket}R` at `-z`, with its x/y rotations and
   * its x/y-axis wobble negated -- so one ear definition makes a matched pair
   * that flaps outward rather than both flapping the same way.
   */
  readonly mirror?: boolean;
}

/** One species: everything needed to build, colour and animate it. */
export interface CritterSpecies {
  readonly id: CritterId;
  readonly name: string;
  /** One line for the unit picker's tooltip. */
  readonly blurb: string;
  /** Proportions. Shares `cloth/figure.ts`'s bone layout, so the gait is shared. */
  readonly metrics: FigureMetrics;
  readonly sockets: readonly SocketSpec[];
  readonly parts: readonly PartSpec[];
  /** The coat this species is shown in before a player picks one. */
  readonly defaultCoat: number;
  /**
   * Species constants for the non-coat roles. Each is a starting point: the
   * derivation contrast-corrects it against the actual coat, so a species does
   * not need a per-coat table.
   */
  readonly accents: Readonly<Partial<Record<CoatRole, number>>>;
}

/**
 * The legibility budget, in world units per screen pixel, for a unit drawn ~64 px
 * tall. A critter stands ~85 units, so 85/64 ~= 1.33 units per pixel.
 */
export const UNITS_PER_PIXEL_AT_64 = 85 / 64;

/**
 * The smallest extent a part may have and still be worth drawing: ~2 px at 64 px
 * unit height. Anything thinner is sub-pixel noise that costs geometry and
 * returns nothing, which is the trap a cozy low-poly style falls into first.
 */
export const MIN_FEATURE_UNITS = 2 * UNITS_PER_PIXEL_AT_64;
