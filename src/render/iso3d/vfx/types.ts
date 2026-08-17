/**
 * What an effect *is* (spec 118).
 *
 * The contract this format exists to enforce is that adding an effect is editing
 * a table. A call site says `vfx.play('hit_metal_spark', { ... })` and nothing
 * else; every decision about how that looks -- how many particles, how fast, what
 * colour, what it does when it hits the ground, what it spawns when it dies --
 * lives here, in data, and can be retuned in the Studio tab and written back out
 * as JSON without a rebuild.
 *
 * Everything is `readonly`, and the registry is frozen once compiled. A runtime
 * override (`tint`, `scale`, `seed`) travels on the *play call* and multiplies
 * into the definition; nothing ever writes back into it. Two effects played from
 * one definition cannot influence each other, which is the property that makes
 * "same seed, same look" survive a busy fight.
 */

import type { Curve, Gradient } from './curve.js';
import type { PaletteKey } from './palette.js';
import type { FluidKind } from './splat.js';
import type { MeshShape } from './meshes.js';

/** Where in the emitter's local frame a particle is born, and which way it goes. */
export type EmitterShape =
  | { readonly kind: 'point' }
  | { readonly kind: 'sphere'; readonly radius: number; readonly shell?: boolean }
  | { readonly kind: 'hemisphere'; readonly radius: number; readonly shell?: boolean }
  | { readonly kind: 'cone'; readonly angle: number; readonly radius: number }
  | { readonly kind: 'box'; readonly halfX: number; readonly halfY: number; readonly halfZ: number }
  | { readonly kind: 'circle'; readonly radius: number; readonly shell?: boolean }
  /**
   * The surface of whatever the effect is attached to. Resolved by the caller's
   * surface sampler; with nothing attached it degrades to `point`, which is what
   * makes a burning-unit definition safe to preview in isolation.
   */
  | { readonly kind: 'mesh' }
  /**
   * A swept arc in the ground plane -- the slash. `sweep` is the total angle
   * covered, centred on the emitter's rotation, and particles are laid along it
   * in emission order rather than at random, so a swing reads as a swing.
   */
  | { readonly kind: 'arc'; readonly radius: number; readonly sweep: number }
  /**
   * Thrown along the emitter's own bearing (spec 158) -- local +X, the axis the
   * effect's `rotation` turns, biased toward the middle of the spread and lifted
   * out of the ground plane by `rise`.
   *
   * The shape a spatter needs and the one the format could not express: `cone`
   * is about local +Y and `circle` is radial in the ground plane, so between
   * them there was no way to say "away from the attacker, and a bit upward".
   */
  | { readonly kind: 'fan'; readonly angle: number; readonly radius: number; readonly rise: number };

export type Emission =
  /** All at once, optionally after a delay. The one-shot. */
  | { readonly kind: 'burst'; readonly count: number; readonly delayTicks?: number }
  /** Steady, until the effect is stopped. */
  | { readonly kind: 'rate'; readonly perSecond: number }
  /** Rate over the emitter's own life, then done. Ignition, dissipation. */
  | { readonly kind: 'ramp'; readonly perSecond: Curve; readonly overTicks: number };

/**
 * How a particle is drawn.
 *
 * `axis-billboard` is the isometric default for anything meant to stand up out
 * of the ground -- a flame, a smoke column. A full billboard leans with the
 * camera and a standing thing that leans reads as falling over.
 */
export type RenderMode =
  | 'billboard'
  | 'stretched'
  | 'axis-billboard'
  | 'ground-quad'
  | 'ribbon'
  | 'mesh';

/**
 * `dither-cutout` is the pixel-look blend: no partial alpha at all, just an
 * ordered-dither threshold against the particle's alpha, so a fade happens as a
 * thinning weave of solid pixels rather than as a translucent smear the
 * quantizer then bands.
 */
export type Blend = 'alpha' | 'additive' | 'dither-cutout';

/** A runtime-generated sprite sheet. Nothing is ever fetched. */
export interface SpriteSpec {
  readonly sheet: string;
  readonly frames: number;
  readonly fps: number;
  readonly randomStart?: boolean;
  /** Hold the last frame instead of looping. Flipbook explosions want this. */
  readonly once?: boolean;
}

/**
 * A stain left where a particle lands.
 *
 * Separate from `onCollide`, which plays another *effect*. A decal is not an
 * effect -- it outlives every particle in the system, it is owned by a map chunk
 * rather than by an emitter, and it is what the gore setting switches off.
 */
export interface DecalSpec {
  readonly fluid: FluidKind;
  /** World units across, before the effect's own scale. */
  readonly size: readonly [min: number, max: number];
  /** 0..1. Not every drop that lands leaves a mark. */
  readonly chance: number;
}

export interface CollisionSpec {
  /** Fraction of speed kept on bounce. 0 comes to rest on the ground. */
  readonly restitution: number;
  /** Fraction of tangential speed lost per bounce. */
  readonly friction: number;
  readonly maxBounces: number;
  /** Effect played at the contact point, once per bounce. Blood becomes a decal here. */
  readonly onCollide?: string;
  /** Kill the particle on first contact instead of bouncing. */
  readonly dieOnCollide?: boolean;
  /** Leave a stain at the contact point. */
  readonly decal?: DecalSpec;
}

export interface SubEmitterSpec {
  readonly onSpawn?: string;
  readonly onDeath?: string;
}

/**
 * The cheap fake that lets fire tint the geometry near it.
 *
 * Not a real light: the renderer reads the live list and drives a small fixed
 * pool of `PointLight`s from the brightest few, because a scene with one light
 * per ember is a scene that recompiles every material.
 */
export interface LightSpec {
  readonly color: PaletteKey;
  readonly intensity: Curve;
  readonly radius: number;
  /** Only the effect's first particle carries the light. Default true. */
  readonly leadOnly?: boolean;
}

export interface SoundSpec {
  readonly cue: string;
  readonly on: 'start' | 'burst' | 'collide';
}

export interface Emitter {
  readonly id: string;
  readonly shape: EmitterShape;
  readonly emission: Emission;
  /** Ticks. A range; each particle draws its own. */
  readonly lifetimeTicks: readonly [min: number, max: number];
  /** World units per second along the shape's direction. */
  readonly speed: readonly [min: number, max: number];
  /** Radians of cone half-angle applied on top of the shape's own direction. */
  readonly spreadRadians?: number;
  /** World units per second squared. Negative is down. */
  readonly gravity?: number;
  /** Fraction of velocity shed per second. */
  readonly drag?: number;
  /** Radians per second. */
  readonly angularVelocity?: readonly [min: number, max: number];
  readonly turbulence?: { readonly amplitude: number; readonly frequency: number };
  /** Constant world-space push. The updraft inside a flame. */
  readonly acceleration?: { readonly x: number; readonly y: number; readonly z: number };

  readonly size: Curve;
  readonly alpha: Curve;
  readonly color: Gradient;
  readonly rotation?: Curve;
  /** Multiplies velocity over life. Distinct from drag: authored, not physical. */
  readonly velocityScale?: Curve;
  /** Length/width ratio for `stretched`, scaled by speed. */
  readonly stretch?: number;
  /**
   * World units a `ribbon` particle must travel before it lays down another
   * sample. Distance, never time -- the rule `world/trail.ts` arrived at, because
   * a streak sampled per frame is a third as long at 144Hz as it is at 48Hz.
   */
  readonly ribbonSpacing?: number;
  /**
   * Width at a `ribbon`'s tail as a fraction of its head. Default 0.15.
   *
   * The knob that decides whether a streak reads as a comet or as a bar, and it
   * is width rather than alpha on purpose (spec 139): the frame is quantized to
   * a few levels, so a fade along a three-pixel streak arrives as a hard notch
   * where geometry that narrows simply narrows.
   */
  readonly ribbonTaper?: number;

  readonly render: RenderMode;
  readonly blend: Blend;
  readonly sprite?: SpriteSpec;
  /**
   * Which solid a `mesh` particle is (spec 123). Required when `render` is
   * `mesh` -- an emitter that asks for a mesh and names no shape is how this
   * silently fell back to a billboard for a whole spec.
   */
  readonly mesh?: { readonly shape: MeshShape };
  readonly collision?: CollisionSpec;
  readonly subEmitters?: SubEmitterSpec;
  readonly light?: LightSpec;
  readonly sound?: SoundSpec;

  /** Local offset from the effect's origin. */
  readonly offset?: { readonly x: number; readonly y: number; readonly z: number };
  /** Emit in world space and stop following the effect once born. Default true. */
  readonly worldSpace?: boolean;
}

/**
 * Priority decides what survives pressure. 0 is ambient decoration and goes
 * first; 3 is readable information -- a boss telegraph, a channel aura -- and is
 * never dropped, because a player who cannot see a telegraph is a player who
 * cannot play.
 */
export type Priority = 0 | 1 | 2 | 3;

export interface EffectDefinition {
  readonly id: string;
  readonly priority: Priority;
  readonly emitters: readonly Emitter[];
  /** Beyond this many world units from the viewpoint the effect is not spawned. */
  readonly cullDistance?: number;
  /** Ticks after which a continuous effect stops itself. 0 means until stopped. */
  readonly durationTicks?: number;
  /**
   * Kill this effect's particles the moment it is stopped, rather than letting
   * them live out their lives (spec 124).
   *
   * The default is right for a thing that was *thrown* -- a fire trail should
   * finish burning after the caster stops running. It is wrong for a thing that
   * is *shown*: an aura holds one particle for ten minutes, and a soft stop
   * would leave the sigil on the ground long after the status ended.
   */
  readonly hardStop?: boolean;
}

// --- the play call -----------------------------------------------------------

export type AttachSpec =
  | { readonly kind: 'world' }
  | { readonly kind: 'entity'; readonly entityId: number }
  | { readonly kind: 'socket'; readonly entityId: number; readonly socket: string }
  /**
   * Born at the attachment, then left behind. Sparks that fly off a moving unit
   * and stay where they land -- the case neither pure world-space nor pure
   * parenting gets right.
   */
  | { readonly kind: 'detach'; readonly entityId: number; readonly socket?: string };

export interface PlayOptions {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Radians about Y. The direction a slash sweeps, a spatter throws. */
  readonly rotation?: number;
  readonly attach?: AttachSpec;
  readonly tint?: PaletteKey;
  /** 0..1. How far toward the tint. Default 1 when a tint is given. */
  readonly tintStrength?: number;
  readonly scale?: number;
  /**
   * Required. The look is a function of this, and a caller that does not care
   * still has to say what it does not care about -- a default here would be a
   * hidden global, and two clients would quietly disagree about what they saw.
   */
  readonly seed: number;
}

export interface VfxLimits {
  readonly maxParticles: number;
  readonly maxInstances: number;
  /** Below this fraction of free capacity, low-priority spawns are refused. */
  readonly pressureFloor: number;
}

export interface VfxStats {
  liveParticles: number;
  liveInstances: number;
  /** Effects refused since the last reset, by reason. */
  refusedBudget: number;
  refusedDistance: number;
  refusedUnknown: number;
  /** Emitters currently throttled rather than stopped. */
  throttled: number;
}
