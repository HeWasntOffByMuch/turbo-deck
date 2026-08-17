/**
 * The painted effects (spec 158): a blood hit and an explosion, built out of
 * brush marks.
 *
 * Builders, not copies -- the discipline `fire`, `puff`, `aura` and `burst` set
 * in `library.ts`. Everything here is a function that returns *config*; there is
 * no behaviour in this file, and adding a variant is a call with different
 * numbers rather than a new code path.
 *
 * ## What makes these read as paint
 *
 * The geometry is `stroke.ts` and the per-instance variation is the mesh shader
 * (`batches.ts`); this file is where the *layering* is decided, and the layering
 * is most of the read. A single burst of marks is a starburst however good each
 * mark is. What says "somebody painted this" is a small number of layers doing
 * different jobs at different speeds: one loud mark that carries the direction,
 * a scatter that says it was violent, chunky dabs that say the medium is paint
 * rather than light, and -- for the explosion -- a mass that outlives all of it
 * and comes apart.
 *
 * ## Blend
 *
 * `dither-cutout` almost throughout, which is only possible since this spec gave
 * the mesh shader the Bayer discard the quad shader has always had. It matters
 * more here than anywhere else in the library: paint is *opaque*, and two
 * translucent marks crossing produce a third colour at the crossing that is in
 * neither of them -- which is exactly the watercolour look this is not. Under
 * the cutout a mark is either there or not, and the fade happens as the weave
 * thins.
 *
 * The one exception is the explosion's opening flash, which is additive because
 * it is light rather than pigment and has four ticks to say so.
 */

import type { EffectDefinition, Emitter, Priority } from './types.js';
import type { PaletteKey } from './palette.js';

// --- the blood hit -----------------------------------------------------------

export interface BloodHitParams {
  readonly id: string;
  /**
   * The nominal size of the whole mark, in world units -- roughly how far the
   * primary stroke reaches. Every other length here is derived from it, so
   * `play(id, { scale })` is the one knob that makes a hit bigger.
   */
  readonly scale: number;
  /** Primary flicks. Two reads as one gesture; above three it is a firework. */
  readonly strokes?: number;
  /** Secondary fragments thrown outward. */
  readonly splashes?: number;
  /** Chunky dabs of paint. */
  readonly droplets?: number;
  /** Length of the primary stroke, as a multiple of `scale`. */
  readonly strokeLength?: number;
  /** Width of the primary stroke, as a multiple of its length. */
  readonly strokeWidth?: number;
  /** Half-angle the secondaries are thrown through, radians. */
  readonly spread?: number;
  /**
   * How tightly everything is held to the blow's own bearing, 0..1. At 1 the
   * whole spatter is a single arrow; at 0 it is a ring and says nothing about
   * where the blow came from.
   */
  readonly bias?: number;
  /** Ticks the longest-lived mark lasts. The effect's whole duration. */
  readonly lifetimeTicks?: number;
  /** World units per second the primary stroke leaves at. */
  readonly velocity?: number;
  /** Fraction of velocity shed per second. High: paint stops in the air. */
  readonly drag?: number;
  /** Downward acceleration on the droplets, world units per second squared. */
  readonly gravity?: number;
  readonly bright?: PaletteKey;
  readonly deep?: PaletteKey;
  readonly ink?: PaletteKey;
  readonly priority?: Priority;
}

/**
 * A blow that throws paint (spec 158).
 *
 * Three layers, at three speeds, and the speeds are the point. The primary
 * stroke is gone in a fifth of a second and is the only thing carrying the
 * direction; the secondaries outlive it by half again and say the blow was
 * violent; the droplets fall out of the bottom of it and are what stops the
 * whole thing reading as a decal that was switched on and off.
 *
 * ## Everything is thrown through a `fan`
 *
 * Not a cone. A cone is about local +Y, so a spatter authored with one throws
 * paint at the sky whatever direction the blow came from -- which is what
 * `hit_blood` has always done, and it works there because a *ribbon* of drops
 * falling under gravity reads as a spray from any angle. A mark, though, points
 * where it was thrown, and a mark pointing up when the blow came from the left
 * is a mark that is simply wrong. `fan` is local +X, biased toward the middle,
 * lifted a little out of the ground plane (`shapes.ts`).
 *
 * ## The motion is one shape used three times
 *
 * `velocityScale` falling from 1 to about a tenth over the first third of a
 * life, on top of real drag. That is the "rapid initial movement followed by
 * drag" the brief asks for, and it is authored rather than physical on purpose:
 * a drag coefficient large enough to stop paint this fast also makes the first
 * two ticks a blur, and the curve lets the mark arrive at full extension and
 * *hold* there while it dries.
 */
export function bloodHit(params: BloodHitParams): EffectDefinition {
  const s = params.scale;
  const bias = Math.min(1, Math.max(0, params.bias ?? 0.72));
  const spread = params.spread ?? 0.95;
  const life = params.lifetimeTicks ?? 40;
  const velocity = params.velocity ?? s * 9;
  const drag = params.drag ?? 5.5;
  const gravity = params.gravity ?? -900;
  const strokeLength = params.strokeLength ?? 1;
  const strokeWidth = params.strokeWidth ?? 1;
  const bright = params.bright ?? 'bloodBright';
  const deep = params.deep ?? 'bloodDeep';
  const ink = params.ink ?? 'bloodInk';

  // A tight fan for the primary, a loose one for everything else. `bias` moves
  // both together, so one number is "how much does this hit point somewhere".
  const aimed = spread * (1 - bias * 0.75);
  const scattered = spread * (1 - bias * 0.35);

  // The brush's own width lives in the mesh (`brush-slash` is authored at 0.15
  // of its length); `strokeWidth` scales the *drawn* mark, which is the only
  // width a person tuning this can see. It reaches the size curve as a
  // proportion, because a stroke's size IS its length and the shape carries the
  // ratio -- so a wider mark is a shorter one drawn at the same size.
  const primary = s * strokeLength;
  const primaryWidth = 1 / Math.max(0.2, strokeWidth);

  const emitters: Emitter[] = [
    // (a) The flick. One violent mark, along the blow, and the whole read.
    {
      id: 'stroke',
      shape: { kind: 'fan', angle: aimed * 0.45, radius: s * 0.05, rise: 0.2 },
      emission: { kind: 'burst', count: params.strokes ?? 2 },
      lifetimeTicks: [Math.round(life * 0.34), Math.round(life * 0.5)],
      speed: [velocity * 0.55, velocity],
      spreadRadians: aimed * 0.3,
      gravity: gravity * 0.25,
      drag,
      // Out of the gate at full speed and stopped inside the first third: paint
      // leaves a brush fast and does not coast.
      velocityScale: { keys: [[0, 1], [0.3, 0.18], [1, 0.05]] },
      // Grows *through* the first three ticks rather than arriving at length.
      // A mark that is full length on the tick it is born is a decal; one that
      // draws out is a gesture.
      size: {
        keys: [
          [0, primary * 0.3 * primaryWidth],
          [0.16, primary * 1.08 * primaryWidth],
          [0.6, primary * primaryWidth],
          [1, primary * 0.86 * primaryWidth],
        ],
      },
      alpha: { keys: [[0, 1], [0.62, 1], [1, 0]] },
      color: { stops: [[0, bright], [0.55, bright], [1, deep]] },
      render: 'mesh',
      mesh: { shape: 'brush-slash' },
      blend: 'dither-cutout',
    },
    // (b) The scatter. Short thick marks and long thin ones from one emitter --
    // the shader's per-instance envelope and stretch are independent, so all
    // four combinations come out of a single burst.
    {
      id: 'splashes',
      shape: { kind: 'fan', angle: scattered, radius: s * 0.09, rise: 0.3 },
      emission: { kind: 'burst', count: params.splashes ?? 7 },
      lifetimeTicks: [Math.round(life * 0.4), Math.round(life * 0.62)],
      speed: [velocity * 0.5, velocity * 1.5],
      spreadRadians: scattered * 0.4,
      // Light. These are aimed marks and their direction is the information they
      // carry, and at 0.45 of the droplets' pull a splash had turned fully
      // downward by the middle of its life -- so the last third of the spatter
      // was a set of vertical marks that said nothing about where the blow came
      // from. Gravity belongs on the dabs, which have weight; a flick of paint
      // is over before it falls.
      gravity: gravity * 0.22,
      drag: drag * 0.75,
      velocityScale: { keys: [[0, 1], [0.35, 0.22], [1, 0.06]] },
      size: {
        keys: [
          [0, s * 0.18],
          [0.2, s * 0.6],
          [0.7, s * 0.52],
          [1, s * 0.34],
        ],
      },
      alpha: { keys: [[0, 1], [0.66, 1], [1, 0]] },
      color: { stops: [[0, bright], [0.4, deep], [1, deep]] },
      render: 'mesh',
      mesh: { shape: 'brush-flick' },
      blend: 'dither-cutout',
    },
    // (c) The dabs. Chunky, dark, tumbling, and falling out from under the rest
    // -- which is the layer that says the medium has weight.
    //
    // Not a liquid simulation and not spheres: `brush-dab` is a blunt-ended lens
    // with a torn edge, so a droplet is a blob of *paint* seen flat-on.
    {
      id: 'droplets',
      shape: { kind: 'fan', angle: scattered * 1.15, radius: s * 0.12, rise: 0.45 },
      emission: { kind: 'burst', count: params.droplets ?? 5 },
      lifetimeTicks: [Math.round(life * 0.6), life],
      speed: [velocity * 0.3, velocity * 0.9],
      spreadRadians: scattered * 0.6,
      gravity,
      drag: drag * 0.3,
      // A slow tumble. Fast enough that two dabs side by side are not one shape
      // twice, slow enough that nothing spins like a propeller.
      angularVelocity: [-3.2, 3.2],
      velocityScale: { keys: [[0, 1], [0.4, 0.4], [1, 0.2]] },
      size: { keys: [[0, s * 0.1], [0.25, s * 0.2], [1, s * 0.15]] },
      alpha: { keys: [[0, 1], [0.7, 1], [1, 0]] },
      color: { stops: [[0, deep], [1, ink]] },
      render: 'mesh',
      mesh: { shape: 'brush-dab' },
      blend: 'dither-cutout',
    },
  ];

  return {
    id: params.id,
    priority: params.priority ?? 2,
    cullDistance: 1500,
    emitters,
  };
}

// --- the explosion -----------------------------------------------------------

export interface BrushExplosionParams {
  readonly id: string;
  /** How far the radial strokes reach, in world units. The one size knob. */
  readonly radius: number;
  /** Strokes in the radial burst. The brief's 8-20. */
  readonly radialCount?: number;
  /** Length of a radial stroke, as a fraction of `radius`: [min, max]. */
  readonly strokeLength?: readonly [min: number, max: number];
  /** Thickness of a radial stroke, relative to the authored mark: [min, max]. */
  readonly strokeThickness?: readonly [min: number, max: number];
  /** World units per second the radial strokes leave at, per unit of radius. */
  readonly expansionSpeed?: number;
  /** Darker fragments thrown clear. 0 for none. */
  readonly debris?: number;
  /** Painted smoke clumps. 0 for none. */
  readonly smoke?: number;
  /** Ticks the longest-lived mark lasts. The effect's whole duration. */
  readonly lifetimeTicks?: number;
  /** Half-angle of the burst. `Math.PI` is a ball; less is a directed jet. */
  readonly spread?: number;
  /** Pale yellow, warm yellow, orange, dark warm brown, and the soot. */
  readonly palette?: BrushExplosionPalette;
  /** Drive a real point light off the flash. */
  readonly light?: boolean;
  readonly priority?: Priority;
}

export interface BrushExplosionPalette {
  readonly hot: PaletteKey;
  readonly warm: PaletteKey;
  readonly mid: PaletteKey;
  readonly deep: PaletteKey;
  readonly soot: PaletteKey;
}

/**
 * The default ramp: pale yellow, warm yellow, orange, dark warm brown, soot.
 *
 * The first three were already in the table under the names the rest of the
 * library uses them by; only the browns were missing (`palette.ts`). Naming this
 * as one object rather than five parameters is what lets a caller say "the same
 * explosion in frost colours" in one substitution.
 */
export const EXPLOSION_PALETTE: BrushExplosionPalette = {
  hot: 'fireCore',
  warm: 'boltYellow',
  mid: 'fireBody',
  deep: 'paintBrown',
  soot: 'paintSoot',
};

/**
 * An explosion painted rather than simulated (spec 158).
 *
 * Four layers that unfold in order, and the order is the effect:
 *
 *  1. **the flash**, four ticks of short thick near-white marks, additive,
 *     barely moving. It is light, so it is the one thing here that is not
 *     pigment;
 *  2. **the radial burst**, 8-20 tapered marks thrown outward, each a different
 *     length and thickness and each bending its own way, growing far faster than
 *     they travel;
 *  3. **the debris**, darker and smaller, thrown further, spinning, falling;
 *  4. **the smoke**, which is not smoke. Overlapping chunky blots that expand,
 *     rise a little, turn slowly and come apart -- because a soft transparent
 *     puff is the single most reliable way to make a stylized effect look like a
 *     particle system.
 *
 * ## Why the strokes grow faster than they move
 *
 * `burst` found this first (spec 125) and the reason is the same: marks that
 * *travelled* separate from the middle and read as a ring of darts leaving,
 * where a concept-art explosion is one shape flowering. So the strokes are
 * thrown hard, stopped by heavy drag inside four ticks, and what actually reads
 * as the blast opening is the size curve. The difference here is that the size
 * curve does not come back down: paint does not retract, it dries and breaks up,
 * which the cutout does for it.
 */
export function brushExplosion(params: BrushExplosionParams): EffectDefinition {
  const r = params.radius;
  const palette = params.palette ?? EXPLOSION_PALETTE;
  const spread = params.spread ?? Math.PI * 0.85;
  const life = params.lifetimeTicks ?? 64;
  const [lengthMin, lengthMax] = params.strokeLength ?? [0.55, 1.15];
  const [thickMin, thickMax] = params.strokeThickness ?? [0.7, 1.4];
  const expansion = params.expansionSpeed ?? 7;
  const debris = params.debris ?? 8;
  const smoke = params.smoke ?? 9;
  // 8..20, the brief's range, clamped rather than trusted: this is the number a
  // person retunes, and a zero here is an explosion with no explosion in it.
  const radial = Math.max(8, Math.min(20, Math.round(params.radialCount ?? 14)));

  // The length range reaches the size curve as its two ends: a mark is at
  // `lengthMin` when it is born and `lengthMax` at full extension, and the
  // shader's per-instance stretch spreads the fan out around that. The thickness
  // range does the same job through the width, which for a stroke is the
  // reciprocal of its drawn size -- the mesh carries the ratio.
  const reach = r * lengthMax;
  const born = r * lengthMin;
  const thickness = 2 / (thickMin + thickMax);

  const emitters: Emitter[] = [
    // (1) The flash. Short, thick, near-white, and over before anything else has
    // finished being born.
    {
      id: 'flash',
      shape: { kind: 'cone', angle: Math.PI, radius: r * 0.04 },
      emission: { kind: 'burst', count: 5 },
      lifetimeTicks: [4, 7],
      speed: [r * 0.4, r * 1.1],
      spreadRadians: 0.5,
      drag: 16,
      size: { keys: [[0, r * 0.3], [0.35, r * 0.62], [1, r * 0.5]] },
      alpha: { keys: [[0, 1], [0.5, 0.9], [1, 0]] },
      color: { stops: [[0, palette.hot], [0.6, palette.hot], [1, palette.warm]] },
      render: 'mesh',
      mesh: { shape: 'brush-slash' },
      // The one additive layer. Light, not pigment, and it has four ticks to
      // say so before the paint takes over.
      blend: 'additive',
      offset: { x: 0, y: r * 0.05, z: 0 },
    },
    // (2) The radial burst. The whole read.
    {
      id: 'radial',
      // The mouth is a sixth of the radius across rather than a point. Every
      // mark starting at one place put fourteen butts on top of each other and
      // the middle of the blast came out as a solid lozenge with spikes on it --
      // the individual marks, which are the whole read, only existed at the
      // edges. Spread the roots and the same fourteen strokes read as fourteen.
      shape: { kind: 'cone', angle: spread, radius: r * 0.16 },
      emission: { kind: 'burst', count: radial },
      lifetimeTicks: [Math.round(life * 0.26), Math.round(life * 0.48)],
      speed: [r * expansion * 0.5, r * expansion],
      spreadRadians: 0.18,
      // Heavy, but not immovable: the size curve still does most of the
      // expanding, and the little travel that survives is what separates the
      // marks from each other rather than from the centre.
      drag: 10,
      angularVelocity: [-1.6, 1.6],
      velocityScale: { keys: [[0, 1], [0.25, 0.2], [1, 0.04]] },
      size: {
        keys: [
          [0, born * thickness * 0.4],
          // Extremely quickly: full reach by a fifth of the life, which at these
          // lifetimes is three or four ticks.
          [0.2, reach * thickness],
          [0.7, reach * thickness * 0.95],
          [1, reach * thickness * 0.8],
        ],
      },
      alpha: { keys: [[0, 1], [0.6, 1], [1, 0]] },
      color: {
        stops: [
          [0, palette.hot],
          [0.22, palette.warm],
          [0.55, palette.mid],
          [1, palette.deep],
        ],
      },
      render: 'mesh',
      mesh: { shape: 'brush-slash' },
      blend: 'dither-cutout',
      offset: { x: 0, y: r * 0.04, z: 0 },
    },
  ];

  if (debris > 0) {
    // (3) Rough painted chunks, not rubble. Thrown further than the burst
    // reaches, turning, and falling out of it.
    emitters.push({
      id: 'debris',
      shape: { kind: 'cone', angle: Math.min(spread, 1.25), radius: r * 0.1 },
      emission: { kind: 'burst', count: debris },
      lifetimeTicks: [Math.round(life * 0.45), Math.round(life * 0.8)],
      // Further than the burst reaches and nowhere near as far as it wants to
      // go: at the first cut these left at nearly twice the radial speed under
      // a tenth of the drag, and `previewFrame` measured the large explosion at
      // 1768 units across -- eighteen radii of mostly empty air with a dozen
      // specks at the edge of it. Debris that outruns its own explosion stops
      // reading as part of it.
      speed: [r * expansion * 0.3, r * expansion * 0.65],
      spreadRadians: 0.55,
      gravity: -r * 16,
      drag: 1.6,
      angularVelocity: [-7, 7],
      size: { keys: [[0, r * 0.1], [0.3, r * 0.16], [1, r * 0.11]] },
      alpha: { keys: [[0, 1], [0.78, 1], [1, 0]] },
      color: { stops: [[0, palette.mid], [0.4, palette.deep], [1, palette.soot]] },
      render: 'mesh',
      mesh: { shape: 'brush-dab' },
      blend: 'dither-cutout',
      // It lands. Debris that sinks through the floor is the one thing that says
      // "particle" out loud -- `burst`'s chunks reached the same conclusion --
      // and without it a chip thrown out of a blast in the air keeps falling for
      // as long as it lives, which measured 1238 units of empty frame.
      collision: { restitution: 0.25, friction: 0.7, maxBounces: 2 },
    });
  }

  if (smoke > 0) {
    // (4) The mass. Chunky blots, overlapping, expanding, rising a little,
    // turning slowly, and gone well before anybody starts waiting for them.
    //
    // Delayed, because smoke that is already there when the flash goes off is
    // smoke that was drawn rather than made.
    emitters.push({
      id: 'smoke',
      shape: { kind: 'sphere', radius: r * 0.28 },
      emission: { kind: 'burst', count: smoke, delayTicks: 4 },
      lifetimeTicks: [Math.round(life * 0.62), life],
      speed: [r * 0.9, r * 2.4],
      spreadRadians: 1.5,
      drag: 3.4,
      // The rise, and it is deliberately slight: a painted mass that climbs like
      // a chimney is a chimney. This lifts it about a third of a radius over its
      // life, which separates the clumps vertically and does nothing more.
      acceleration: { x: 0, y: r * 0.55, z: 0 },
      angularVelocity: [-0.9, 0.9],
      // Turbulence is what makes the clumps *separate* rather than expanding as
      // one ball -- they are born inside one sphere and pushed apart by a field
      // that is different at each of their positions.
      turbulence: { amplitude: r * 0.9, frequency: 0.05 },
      size: { keys: [[0, r * 0.22], [0.45, r * 0.46], [1, r * 0.62]] },
      // In and out. The cutout turns the tail into a thinning weave rather than
      // a translucent smear, which is the difference between a painted mass
      // drying up and a fog machine being switched off.
      alpha: { keys: [[0, 0], [0.14, 0.95], [0.6, 0.8], [1, 0]] },
      color: { stops: [[0, palette.deep], [0.45, palette.soot], [1, palette.soot]] },
      render: 'mesh',
      mesh: { shape: 'brush-blot' },
      blend: 'dither-cutout',
    });
  }

  if (params.light === true) {
    // On the flash and nowhere else: the light is the same event the flash is,
    // and a light hung off the smoke would still be burning when the smoke has
    // finished. (The same shape `burst` uses, and for the same reason.)
    const flash = emitters[0];
    if (flash) {
      emitters[0] = {
        ...flash,
        light: { color: palette.warm, intensity: { keys: [[0, 1.6], [1, 0]] }, radius: r * 5 },
      };
    }
  }

  return {
    id: params.id,
    priority: params.priority ?? 2,
    cullDistance: 1900,
    emitters,
  };
}

// --- the shipped presets -----------------------------------------------------

/** The nominal radius `explosion_brush` is authored at, for the scale maths. */
export const BRUSH_EXPLOSION_RADIUS = 60;

/** Below this intensity a hit plays the light mark, above it the loud one. */
export const HEAVY_HIT_INTENSITY = 1.35;

export const BRUSH_EFFECTS: readonly EffectDefinition[] = [
  // The blow that lands, and the blow that finishes. The same language read
  // louder -- more marks, thrown further, held a little longer -- never a
  // different one, which is the rule the whole hit vocabulary is authored to.
  bloodHit({ id: 'blood_hit_brush', scale: 26 }),
  bloodHit({
    id: 'blood_hit_brush_heavy',
    scale: 38,
    strokes: 3,
    splashes: 11,
    droplets: 8,
    spread: 1.15,
    bias: 0.62,
    lifetimeTicks: 46,
    velocity: 420,
  }),

  brushExplosion({ id: 'explosion_brush_small', radius: 34, radialCount: 9, debris: 5, smoke: 6, lifetimeTicks: 52 }),
  brushExplosion({ id: 'explosion_brush', radius: BRUSH_EXPLOSION_RADIUS, light: true }),
  brushExplosion({
    id: 'explosion_brush_large',
    radius: 96,
    radialCount: 19,
    debris: 12,
    smoke: 12,
    lifetimeTicks: 82,
    light: true,
    priority: 3,
  }),
];

// --- the public API ----------------------------------------------------------

/** A three-component direction, however the caller happens to hold one. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BloodHitInput {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The surface's outward normal. Used to lift the paint clear of the body. */
  readonly normal?: Vec3Like;
  /** The direction the blow was travelling when it landed. */
  readonly incoming?: Vec3Like;
  /** 1 is an ordinary blow. Above {@link HEAVY_HIT_INTENSITY} it is the loud one. */
  readonly intensity?: number;
  readonly seed: number;
}

export interface BrushExplosionInput {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** How far the burst should reach, in world units. */
  readonly radius?: number;
  readonly intensity?: number;
  readonly seed: number;
}

/** An effect id and the options to play it with. What both spawn calls return. */
export interface SpawnRequest {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotation: number;
  readonly scale: number;
  readonly seed: number;
}

/**
 * How far along the surface normal the paint is thrown from.
 *
 * A mark born exactly on a body is a mark half inside it -- the same finding
 * `CONTACT_RADIUS` records in `world/vfx-wire.ts`, and the same fix.
 */
export const NORMAL_LIFT = 4;

/**
 * `SpawnBloodHit`, as a pure request (spec 158).
 *
 * Pure so it can be asserted in Node, and separate from `VfxLayer.spawnBloodHit`
 * for the reason `world/vfx-wire.ts` is separate from the scene: the decision
 * about *what to play* is arithmetic, and arithmetic that needs a GL context to
 * exercise is arithmetic nobody checks.
 *
 * ## The bearing
 *
 * The blow's own direction, turned partway toward the surface normal. Neither
 * alone is right: paint carried purely along the blow disappears into the body
 * it just hit, and paint thrown purely along the normal is a spatter that says
 * nothing about which side the attack came from. Weighted toward the blow,
 * because direction is information and the normal is only there to get the mark
 * out of the surface.
 */
export function bloodHitRequest(input: BloodHitInput): SpawnRequest {
  const intensity = input.intensity ?? 1;
  const heavy = intensity >= HEAVY_HIT_INTENSITY;
  const normal = input.normal;
  const incoming = input.incoming;

  const nx = normal?.x ?? 0;
  const nz = normal?.z ?? 0;
  const ix = incoming?.x ?? 0;
  const iz = incoming?.z ?? 0;

  // 0.55 of the blow plus 0.45 of the normal, each normalised first so a caller
  // handing over an un-normalised velocity does not silently swamp the normal.
  const iLen = Math.hypot(ix, iz);
  const nLen = Math.hypot(nx, nz);
  const bx = (iLen > 1e-4 ? (ix / iLen) * 0.55 : 0) + (nLen > 1e-4 ? (nx / nLen) * 0.45 : 0);
  const bz = (iLen > 1e-4 ? (iz / iLen) * 0.55 : 0) + (nLen > 1e-4 ? (nz / nLen) * 0.45 : 0);
  // Stacked exactly, which happens at point blank: a fixed bearing beats NaN.
  const rotation = bx * bx + bz * bz > 1e-8 ? Math.atan2(bz, bx) : 0;

  // The lift is along the *normal* rather than along the bearing: the point is
  // to clear the surface, and on a glancing blow the bearing runs along it.
  const lift = normal ? NORMAL_LIFT : 0;
  const lz = nLen > 1e-4 ? nz / nLen : 0;
  const lx = nLen > 1e-4 ? nx / nLen : 0;
  const ny = normal?.y ?? 0;

  return {
    id: heavy ? 'blood_hit_brush_heavy' : 'blood_hit_brush',
    x: input.x + lx * lift,
    y: input.y + ny * lift,
    z: input.z + lz * lift,
    rotation,
    // The heavy variant is already bigger, so intensity above the threshold is
    // measured against it rather than compounding onto it -- otherwise a crit
    // gets the loud definition AND a 1.5x, and lands as a different effect.
    scale: heavy ? Math.max(0.7, intensity / HEAVY_HIT_INTENSITY) : Math.max(0.3, intensity),
    seed: input.seed,
  };
}

/**
 * `SpawnBrushExplosion`, as a pure request (spec 158).
 *
 * `radius` is honoured as a *length*, not as a multiplier: the preset is
 * authored at {@link BRUSH_EXPLOSION_RADIUS} and the scale is the ratio, so a
 * caller asking for 120 units gets 120 units whatever the preset is retuned to
 * later. That is the same argument `lengthWorld` makes in `src/items/` -- nobody
 * can check a scale factor and anybody can hold a length up against the world.
 */
export function brushExplosionRequest(input: BrushExplosionInput): SpawnRequest {
  const intensity = Math.max(0.2, input.intensity ?? 1);
  const radius = Math.max(1, input.radius ?? BRUSH_EXPLOSION_RADIUS);
  // Which preset: the one whose authored radius is nearest, so a small blast is
  // fewer marks rather than the same marks shrunk. Counts do not scale with
  // `scale`, and a nine-stroke burst at a third the size is a different picture
  // from a nineteen-stroke one.
  const preset =
    radius < 46
      ? { id: 'explosion_brush_small', radius: 34 }
      : radius < 78
        ? { id: 'explosion_brush', radius: BRUSH_EXPLOSION_RADIUS }
        : { id: 'explosion_brush_large', radius: 96 };

  return {
    id: preset.id,
    x: input.x,
    y: input.y,
    z: input.z,
    rotation: 0,
    // Intensity enters through the *cube root*, so doubling it is a visibly
    // bigger blast rather than a blast twice as wide -- a linear intensity makes
    // 2 fill the screen and 0.5 disappear.
    scale: (radius / preset.radius) * Math.cbrt(intensity),
    seed: input.seed,
  };
}
