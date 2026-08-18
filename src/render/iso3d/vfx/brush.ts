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

import { MARK_REACH } from './meshes.js';
import type { Curve } from './curve.js';
import type { EffectDefinition, Emitter, Priority, StrokeDecay } from './types.js';
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
  /**
   * Dominant strokes. **One**, almost always.
   *
   * This is the number the corrective pass turned down hardest. A hit is one
   * gesture; two competing marks read as two hits and a dozen small ones read as
   * confetti.
   */
  readonly strokes?: number;
  /** Medium marks that agree with the primary. 2-5. */
  readonly splashes?: number;
  /** Chunky dabs of paint. 3-8. */
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
  /**
   * Upward acceleration, world units per second squared. 0 for paint.
   *
   * The knob a spatter that *hangs* is built from: set `gravity` to nothing and
   * `drift` to a little, and the marks stop falling and start floating apart.
   */
  readonly drift?: number;
  /**
   * How much the marks wander, world units per second squared. 0 for paint.
   *
   * Only worth having beside `drift`: a formation of marks all lifting at the
   * same rate is a formation, and what makes a cloud come apart is that the
   * field pushing it differs at each of their positions.
   */
  readonly turbulence?: number;
  /**
   * The fraction of its peak size a mark ends at. Near 1 for paint, which dries
   * where it lands; well under it for something that thins away to nothing.
   */
  readonly shrinkTo?: number;
  /**
   * How a mark leaves (spec 161): pulled back toward its own root, or broken up
   * where it lies.
   *
   * `retract` for a hit, which is over in a few ticks and reads as a flick.
   * `fizzle` for anything held long enough to be watched -- retract played
   * slowly is the brush retracing its own path backwards, which reads as the
   * stroke being un-painted rather than as anything thinning away.
   */
  readonly decay?: StrokeDecay;
  /**
   * How much the shorter-lived layers are held toward the full lifetime, 0..1.
   *
   * At 0 the three layers die in order -- the flick first, then the medium
   * marks, then the dabs -- which is right for a hit, where the gesture lands
   * and the debris outlives it. At 1 they all end together.
   *
   * The lever a *dissipating* spatter is actually made of, and the one that was
   * missing at first: shrinking a mark and fading it early does nothing if the
   * mark it is happening to is already dead. With the primary living less than
   * two thirds of the window there was nothing left to watch fizzle by the time
   * the fizzling started.
   */
  readonly linger?: number;
  /**
   * When the fade begins, as a fraction of life.
   *
   * Late by default and deliberately: paint is opaque, and the geometry is
   * already retracting from its root by then (spec 159), so alpha has very
   * little to do. Early is what makes a mark *dissipate* rather than dry.
   */
  readonly fadeFrom?: number;
  /** Bright saturated crimson, for the smaller fresh marks. */
  readonly bright?: PaletteKey;
  /** The strong middle red the primary body is drawn in. */
  readonly mid?: PaletteKey;
  /** Dark burgundy, where a mark dries. */
  readonly deep?: PaletteKey;
  /** Darkest, for the dabs' tails. */
  readonly ink?: PaletteKey;
  readonly priority?: Priority;
}

/**
 * A blow that throws paint (specs 158, 159).
 *
 * **One gesture, then a few more, then a scatter.** Spec 158 built this as three
 * emitters of a dozen small marks and it read as a cloud of red chips; the
 * correction is that a hit is a *composition*, and the composition is dominated
 * by a single stroke. One primary that carries the whole direction and most of
 * the visual mass, two to four medium marks that agree with it, and a handful of
 * dabs. Nine pieces in total, each of them big enough to read.
 *
 * ## Everything is thrown through a `fan`
 *
 * Not a cone. A cone is about local +Y, so a spatter authored with one throws
 * paint at the sky whatever direction the blow came from -- which is what
 * `hit_blood` has always done, and it works there because a *ribbon* of drops
 * falling under gravity reads as a spray from any angle. A mark, though, points
 * where it was thrown, and a mark pointing up when the blow came from the left
 * is simply wrong. `fan` is local +X, biased toward the middle, lifted a little
 * out of the ground plane (`shapes.ts`).
 *
 * The angles are the brief's and they are tight on purpose: the primary within a
 * few degrees of the bearing, the secondaries inside about 35, and only the
 * dabs allowed to stray. Randomness modifies a composition here; it does not
 * replace one.
 *
 * ## The motion is in the shape, not in the transform
 *
 * The primary mark *draws out along its own path* over the first three ticks and
 * then *retracts from its root*, both in the vertex shader off the particle's
 * age (`batches.ts`). What the size curve does is far less than it looks: a mark
 * animated by scaling alone is a decal being switched on, which is the single
 * most reliable tell of cheap procedural VFX.
 */
export function bloodHit(params: BloodHitParams): EffectDefinition {
  const s = params.scale;
  const bias = Math.min(1, Math.max(0, params.bias ?? 0.72));
  const spread = params.spread ?? 0.62;
  const life = params.lifetimeTicks ?? 34;
  const velocity = params.velocity ?? s * 7;
  const drag = params.drag ?? 5.5;
  const gravity = params.gravity ?? -900;
  const drift = params.drift ?? 0;
  const turbulence = params.turbulence ?? 0;
  const shrinkTo = Math.max(0.02, params.shrinkTo ?? 0.94);
  const linger = Math.min(1, Math.max(0, params.linger ?? 0));
  const decay = params.decay ?? 'retract';
  /** A layer's lifetime, in ticks, with `linger` pulling it toward the full span. */
  const lives = (from: number, to: number): readonly [number, number] => [
    Math.round(life * (from + (1 - from) * linger)),
    Math.round(life * (to + (1 - to) * linger)),
  ];
  const fadeFrom = Math.min(0.98, Math.max(0.05, params.fadeFrom ?? 0.85));
  const strokeLength = params.strokeLength ?? 1;
  const strokeWidth = params.strokeWidth ?? 1;
  const bright = params.bright ?? 'bloodBright';
  const mid = params.mid ?? 'bloodFresh';
  const deep = params.deep ?? 'bloodDeep';
  const ink = params.ink ?? 'bloodInk';

  // A tight fan for the primary, a looser one for the medium marks, and only the
  // dabs allowed to go wide. `bias` moves all three together, so one number is
  // "how much does this hit point somewhere".
  const aimed = spread * (1 - bias * 0.82);
  const scattered = spread * (1 - bias * 0.3);
  const loose = spread * (1.6 - bias * 0.3);

  // A stroke's size IS its length; the mesh carries the width as a proportion of
  // it, so a wider mark is a shorter one drawn at the same size. `strokeWidth` is
  // therefore a divisor, and it is expressed that way rather than as a second
  // length because width is the number a person tuning this can actually see.
  const primary = s * 3.1 * strokeLength;
  const narrow = 1 / Math.max(0.25, strokeWidth);

  /**
   * A size curve: born a little under its peak, at it a third of the way in,
   * and ending at `shrinkTo` of it.
   *
   * One helper because the three layers were three hand-written curves that had
   * to agree about the same two decisions, and a variant that changes how a mark
   * ends has to change all three or it changes none of them.
   */
  const sizeCurve = (peak: number, born: number): Curve => ({
    keys: [
      [0, peak * born],
      [0.35, peak],
      // A hold before the fall, and it is only visible on a variant that shrinks
      // hard: with `shrinkTo` near 1 this key is within 3% of the peak. Without
      // it the mist thinned linearly from a third of the way in and was gone by
      // half its own life -- which is a mark that vanishes rather than one that
      // dissipates, and the difference is whether anybody sees it happen.
      [0.62, peak * (0.55 + 0.45 * shrinkTo)],
      [1, peak * shrinkTo],
    ],
  });

  /** Hold, then go. Where the hold ends is what tells drying from dissipating. */
  const alphaCurve = (): Curve => ({ keys: [[0, 1], [fadeFrom, 1], [1, 0]] });

  // Always present, and free when they are zero: the sim skips turbulence below
  // an amplitude of 0 and an acceleration of 0 adds nothing to the step.
  const wander = { amplitude: turbulence, frequency: 0.055 } as const;
  const lift = { x: 0, y: drift, z: 0 } as const;

  const emitters: Emitter[] = [
    // (a) THE mark. One. It carries the direction and most of the visual mass,
    // and every other layer here exists to keep it company.
    {
      id: 'primary',
      shape: { kind: 'fan', angle: aimed * 0.28, radius: s * 0.04, rise: 0.12 },
      emission: { kind: 'burst', count: Math.max(1, params.strokes ?? 1) },
      lifetimeTicks: lives(0.46, 0.6),
      speed: [velocity * 0.9, velocity * 1.3],
      spreadRadians: aimed * 0.14,
      gravity: gravity * 0.14,
      drag,
      velocityScale: { keys: [[0, 1], [0.3, 0.16], [1, 0.04]] },
      // Nearly flat: the *shape* extends and retracts (spec 159), so a size curve
      // that also swung about would be two animations fighting.
      size: sizeCurve(primary * narrow, 0.92),
      // Opaque while it matters. Overlapping translucent marks make a third
      // colour at every crossing that is in neither of them, which is the
      // watercolour look this is not; and the fade at the end is short because
      // the geometry is already retracting by then.
      alpha: alphaCurve(),
      acceleration: lift,
      turbulence: wander,
      color: { stops: [[0, bright], [0.55, bright], [0.8, mid], [1, deep]] },
      render: 'mesh',
      mesh: { shape: 'brush-slash' },
      blend: 'alpha',
      strokeDecay: decay,
    },
    // (b) The medium marks: within about 35 degrees of the bearing, so they
    // reinforce the gesture instead of arguing with it.
    {
      id: 'secondary',
      shape: { kind: 'fan', angle: scattered, radius: s * 0.1, rise: 0.28 },
      emission: { kind: 'burst', count: params.splashes ?? 3 },
      lifetimeTicks: lives(0.55, 0.78),
      speed: [velocity * 0.55, velocity * 1.35],
      spreadRadians: scattered * 0.2,
      // Light. These are aimed marks and their direction is the information they
      // carry; enough gravity to turn one mid-flight makes it a vertical mark
      // that says nothing about where the blow came from.
      gravity: gravity * 0.2,
      drag: drag * 0.8,
      velocityScale: { keys: [[0, 1], [0.35, 0.2], [1, 0.05]] },
      size: sizeCurve(s * 1.62, 0.93),
      alpha: alphaCurve(),
      acceleration: lift,
      turbulence: wander,
      color: { stops: [[0, bright], [0.5, mid], [1, deep]] },
      render: 'mesh',
      mesh: { shape: 'brush-flick' },
      blend: 'alpha',
      strokeDecay: decay,
    },
    // (c) The dabs. Chunky, dark, tumbling in *world* space rather than held to
    // the camera -- which is where this effect's sense of depth comes from, and
    // which only works because a brush mesh is a shallow shell rather than a
    // plane (`stroke.ts`).
    {
      id: 'fragments',
      shape: { kind: 'fan', angle: loose, radius: s * 0.14, rise: 0.42 },
      emission: { kind: 'burst', count: params.droplets ?? 5 },
      lifetimeTicks: lives(0.68, 1),
      speed: [velocity * 0.3, velocity * 0.95],
      spreadRadians: loose * 0.35,
      gravity,
      drag: drag * 0.35,
      angularVelocity: [-4, 4],
      velocityScale: { keys: [[0, 1], [0.4, 0.4], [1, 0.18]] },
      size: sizeCurve(s * 0.42, 0.81),
      alpha: alphaCurve(),
      acceleration: lift,
      turbulence: wander,
      color: { stops: [[0, bright], [0.5, mid], [0.85, deep], [1, ink]] },
      render: 'mesh',
      mesh: { shape: 'brush-dab' },
      blend: 'alpha',
      strokeDecay: decay,
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
  /** How far the burst reaches, in world units. The one size knob. */
  readonly radius: number;
  /** Major strokes across the whole burst. The brief's 8-14. */
  readonly radialCount?: number;
  /** Length of a major stroke, as a fraction of `radius`: [min, max]. */
  readonly strokeLength?: readonly [min: number, max: number];
  /** Thickness of a major stroke, relative to the authored mark: [min, max]. */
  readonly strokeThickness?: readonly [min: number, max: number];
  /** World units per second the strokes leave at, per unit of radius. */
  readonly expansionSpeed?: number;
  /** Darker transitional shapes that emerge behind the fire. 0 for none. */
  readonly debris?: number;
  /** Painterly smoke masses. 0 for none. */
  readonly smoke?: number;
  /**
   * Ticks before the smoke starts.
   *
   * Late by default, because smoke that is already there when the flash goes off
   * is smoke that was drawn rather than made. Early is what a *smoulder* is: the
   * fire barely gets its moment before the mass rolls over it.
   */
  readonly smokeDelayTicks?: number;
  /**
   * Ticks the smoke lives, [min, max].
   *
   * Decoupled from `lifetimeTicks` on purpose, and this is the pair of numbers a
   * lingering variant is actually made of: `lifetimeTicks` then governs the
   * fire alone, so the two halves can be moved in opposite directions -- a
   * shorter blaze under a mass that hangs about long after it.
   */
  readonly smokeLifeTicks?: readonly [min: number, max: number];
  /** Ticks the longest-lived FIRE mark lasts. The smoke has its own. */
  readonly lifetimeTicks?: number;
  /** Pale yellow, golden, orange, burnt orange, brown, soot. */
  readonly palette?: BrushExplosionPalette;
  /** Drive a real point light off the flash. */
  readonly light?: boolean;
  readonly priority?: Priority;
}

export interface BrushExplosionPalette {
  readonly hot: PaletteKey;
  readonly warm: PaletteKey;
  readonly mid: PaletteKey;
  readonly burnt: PaletteKey;
  readonly deep: PaletteKey;
  readonly soot: PaletteKey;
}

/**
 * The ramp, as six named layers rather than a gradient (spec 159).
 *
 * The brief's scheme: near-white yellow at the centre, golden yellow on the
 * inner strokes, orange outside them, burnt orange on the transitional shapes,
 * deep warm brown and soot for the smoke. Six *layers*, and the word is doing
 * work -- each one is separate geometry drawn at its own time, not a darker
 * pattern laid over a brighter shape.
 */
export const EXPLOSION_PALETTE: BrushExplosionPalette = {
  hot: 'fireCore',
  warm: 'boltYellow',
  mid: 'fireBody',
  burnt: 'paintBurnt',
  deep: 'paintBrown',
  soot: 'paintSoot',
};

/**
 * Where the burst's lobes point, in the effect's own frame.
 *
 * Irregular on purpose and by construction. The gaps between them are 1.40,
 * 1.32, 1.55 and 2.01 radians, so the composition has two clusters and one
 * clear hole in it whichever way the whole thing is turned -- and the whole
 * thing IS turned, per play, out of the seed (`brushExplosionRequest`).
 *
 * This replaces a single `cone`, and the reason is the one failure the previous
 * version could not be tuned out of: a cone samples directions uniformly, so
 * however different the individual marks are, twelve of them come out evenly
 * spaced and the silhouette is a radial star. Asymmetry has to be *composed*.
 */
const LOBES = [0.34, 1.74, 3.06, 4.61] as const;

/**
 * An explosion painted rather than simulated (specs 158, 159).
 *
 * Six layers, each with its own delay, so the thing unfolds instead of arriving:
 *
 *  1. **flash** -- 4 short thick near-white marks, additive, 3-6 ticks. Light.
 *  2. **major** -- 3 large dominant strokes out of one lobe, golden.
 *  3. **mid** -- 4 medium strokes out of a second lobe, low and wide, orange.
 *  4. **rise** -- 3 medium strokes out of a third, aimed upward.
 *  5. **ground** -- 3 wide low strokes out of a fourth, burnt orange, spreading.
 *  6. **transitional** -- darker brown shapes emerging among the fire.
 *  7. **smoke** -- painted masses that expand, rise, turn and come apart.
 *
 * ## Why the lobes rather than a spread
 *
 * Because "irregular and asymmetrical" is a property of a *composition* and
 * cannot be got out of a sampler. Four fans with different bearings, counts,
 * pitches, lengths and colours give clusters where the lobes are and gaps
 * between them; a single cone with a wide angle gives an even spray that reads
 * as a star no matter how good the individual marks are. This is the difference
 * between painting an explosion and generating one.
 *
 * ## Why the darker layers are separate geometry
 *
 * Because the alternative is a pattern laid over the bright shapes, and at any
 * resolution that reads as dirt on the screen rather than as depth in the
 * picture. `transitional` and `smoke` are their own marks, drawn later, in their
 * own colours, in front of the fire.
 */
export function brushExplosion(params: BrushExplosionParams): EffectDefinition {
  const r = params.radius;
  const palette = params.palette ?? EXPLOSION_PALETTE;
  const life = params.lifetimeTicks ?? 78;
  const [lengthShort, lengthMax] = params.strokeLength ?? [0.62, 1.25];
  const [thickMin, thickMax] = params.strokeThickness ?? [0.75, 1.35];
  const expansion = params.expansionSpeed ?? 4.5;
  const debris = params.debris ?? 3;
  const smoke = params.smoke ?? 6;
  const smokeDelay = Math.max(0, Math.round(params.smokeDelayTicks ?? 16));
  const [smokeMin, smokeMax] = params.smokeLifeTicks ?? [Math.round(life * 0.5), Math.round(life * 0.84)];
  // 8..14, the brief's range for phase B, clamped rather than trusted: this is
  // the number a person retunes, and a zero here is an explosion with no
  // explosion in it.
  const majors = Math.max(8, Math.min(14, Math.round(params.radialCount ?? 13)));

  // Split across the four lobes, unevenly. The largest lobe gets the dominant
  // strokes; the rest get progressively less, which is what makes one side of
  // the burst heavier than the other.
  const share = (fraction: number): number => Math.max(1, Math.round(majors * fraction));
  const reach = r * lengthMax;
  const thickness = 2 / (thickMin + thickMax);
  // The shortest a lobe is allowed to be, as a fraction of the longest. A lobe's
  // own `length` multiplier is clamped into [short, 1] so retuning the range
  // moves every lobe together rather than only the longest.
  const short = Math.max(0.2, Math.min(1, lengthShort / Math.max(0.01, lengthMax)));
  const span = (want: number): number => Math.max(short, Math.min(1, want));

  /** One lobe of major strokes. The five differ only in these numbers. */
  const lobe = (
    id: string,
    at: number,
    count: number,
    opts: {
      readonly angle: number;
      readonly rise: number;
      readonly delay: number;
      readonly length: number;
      readonly from: PaletteKey;
      readonly to: PaletteKey;
      readonly life: readonly [number, number];
      readonly speed?: number;
    },
  ): Emitter => ({
    id,
    shape: { kind: 'fan', angle: opts.angle, radius: r * 0.13, rise: opts.rise, bearing: at },
    emission: { kind: 'burst', count, delayTicks: opts.delay },
    lifetimeTicks: [Math.round(opts.life[0]), Math.round(opts.life[1])],
    speed: [r * expansion * 0.35 * (opts.speed ?? 1), r * expansion * (opts.speed ?? 1)],
    spreadRadians: 0.16,
    // Heavy, but not immovable: the marks are mostly stopped inside a few ticks
    // and the shape's own extension does the expanding, so what the little
    // surviving travel buys is separation between marks rather than from the
    // centre. `burst` (spec 125) found the same thing about spikes.
    drag: 11,
    angularVelocity: [-1.1, 1.1],
    velocityScale: { keys: [[0, 1], [0.28, 0.22], [1, 0.05]] },
    size: {
      keys: [
        [0, reach * opts.length * thickness * 0.86],
        [0.35, reach * opts.length * thickness],
        [1, reach * opts.length * thickness * 0.92],
      ],
    },
    // Opaque while it matters. The geometry retracts from the root over the last
    // third of the life (`batches.ts`), so there is very little for alpha to do.
    alpha: { keys: [[0, 1], [0.82, 1], [1, 0]] },
    color: { stops: [[0, opts.from], [0.45, opts.from], [1, opts.to]] },
    render: 'mesh',
    mesh: { shape: 'brush-slash' },
    blend: 'alpha',
    offset: { x: 0, y: r * 0.05, z: 0 },
  });

  const emitters: Emitter[] = [
    // (1) The flash: compact, pale, and gone before anything else is fully born.
    {
      id: 'flash',
      shape: { kind: 'fan', angle: 2.3, radius: r * 0.05, rise: 0.35 },
      emission: { kind: 'burst', count: 4 },
      lifetimeTicks: [3, 6],
      speed: [r * 0.5, r * 1.4],
      spreadRadians: 0.6,
      drag: 18,
      size: { keys: [[0, r * 0.5], [0.4, r * 0.62], [1, r * 0.5]] },
      alpha: { keys: [[0, 1], [0.55, 0.95], [1, 0]] },
      color: { stops: [[0, palette.hot], [0.65, palette.hot], [1, palette.warm]] },
      render: 'mesh',
      mesh: { shape: 'brush-slash' },
      // The one additive layer. Light, not pigment, and it has four ticks to say
      // so before the paint takes over.
      blend: 'additive',
      offset: { x: 0, y: r * 0.06, z: 0 },
    },

    // (2)-(5) The burst, as four lobes with nothing in common but the grammar.
    lobe('major', LOBES[0], share(0.26), {
      angle: 0.52,
      rise: 0.42,
      delay: 2,
      length: span(1),
      from: palette.warm,
      to: palette.mid,
      life: [Math.round(life * 0.2), Math.round(life * 0.36)],
    }),
    lobe('mid', LOBES[1], share(0.32), {
      angle: 0.74,
      rise: 0.1,
      delay: 3,
      length: span(0.74),
      from: palette.mid,
      to: palette.burnt,
      life: [Math.round(life * 0.24), Math.round(life * 0.4)],
      speed: 1.25,
    }),
    lobe('rise', LOBES[2], share(0.24), {
      angle: 0.46,
      rise: 0.92,
      delay: 4,
      length: span(0.86),
      from: palette.warm,
      to: palette.mid,
      life: [Math.round(life * 0.24), Math.round(life * 0.38)],
      speed: 0.85,
    }),
    lobe('ground', LOBES[3], share(0.22), {
      angle: 0.92,
      rise: -0.04,
      delay: 5,
      length: span(0.66),
      from: palette.mid,
      to: palette.burnt,
      life: [Math.round(life * 0.24), Math.round(life * 0.38)],
      speed: 1.4,
    }),
  ];

  if (debris > 0) {
    // (6) The transitional layer, and the reason it exists as geometry: the
    // darker parts of a painted explosion are *shapes*, laid over the bright
    // ones by a hand that changed brushes. Rendered late, in burnt orange going
    // to brown, among the fire rather than after it.
    emitters.push({
      id: 'transitional',
      shape: { kind: 'fan', angle: 1.5, radius: r * 0.2, rise: 0.12, bearing: LOBES[1] + 0.5 },
      emission: { kind: 'burst', count: debris, delayTicks: 9 },
      lifetimeTicks: [Math.round(life * 0.24), Math.round(life * 0.4)],
      speed: [r * 1.1, r * 2.6],
      spreadRadians: 0.5,
      gravity: -r * 7,
      drag: 2.4,
      angularVelocity: [-3.5, 3.5],
      size: { keys: [[0, r * 0.5], [0.4, r * 0.62], [1, r * 0.54]] },
      alpha: { keys: [[0, 1], [0.8, 1], [1, 0]] },
      color: { stops: [[0, palette.burnt], [0.5, palette.deep], [1, palette.deep]] },
      render: 'mesh',
      mesh: { shape: 'brush-flick' },
      blend: 'alpha',
    });
  }

  if (smoke > 0) {
    // (7) The mass. Each particle is already a lobed cloud -- three broad strokes
    // crossing in one mesh (`meshes.ts`) -- so a handful of them is a chunky
    // painted silhouette rather than a bead cluster, and they turn freely in
    // world space rather than facing the camera.
    emitters.push({
      id: 'smoke',
      shape: { kind: 'sphere', radius: r * 0.34 },
      emission: { kind: 'burst', count: smoke, delayTicks: smokeDelay },
      offset: { x: 0, y: r * 0.3, z: 0 },
      lifetimeTicks: [Math.max(1, Math.round(smokeMin)), Math.max(1, Math.round(smokeMax))],
      speed: [r * 0.8, r * 2],
      spreadRadians: 1.5,
      drag: 3.2,
      // The rise, and deliberately slight: a painted mass that climbs like a
      // chimney is a chimney. About a third of a radius over its life.
      acceleration: { x: 0, y: r * 0.95, z: 0 },
      // Slow. A cloud that spins reads as a wheel.
      angularVelocity: [-0.55, 0.55],
      // What makes the clumps *separate* rather than expand as one ball: they are
      // born inside one sphere and pushed apart by a field that differs at each
      // of their positions.
      turbulence: { amplitude: r * 0.85, frequency: 0.05 },
      size: { keys: [[0, r * 0.52], [0.4, r * 0.95], [1, r * 1.15]] },
      // In, hold, out. No dither anywhere: a mass thins by shrinking and by
      // going quiet, not by having pixels taken out of it.
      alpha: { keys: [[0, 0], [0.16, 0.96], [0.62, 0.9], [1, 0]] },
      // Deep warm brown for most of its life and only soot at the very end.
      // Soot from the start made a black hole in the picture rather than a
      // painted mass -- a dark shape still has to have a colour.
      color: { stops: [[0, palette.burnt], [0.3, palette.deep], [1, palette.soot]] },
      render: 'mesh',
      mesh: { shape: 'brush-blot' },
      blend: 'alpha',
      // Broken up where it lies, like the mist (spec 161), and for a stronger
      // reason: retract shortens a mark from one end, and on a cloud lobe --
      // which is a lens rather than a flick, and has no root the eye can point
      // at -- that reads as the mass being eaten from one side. It is also the
      // longest-lived mark in the library by a distance, so it is the one with
      // the most time to be noticed doing it.
      strokeDecay: 'fizzle',
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

// --- the placed mark ---------------------------------------------------------

export interface BrushCrossParams {
  readonly id: string;
  /** Each stroke's length in world units, tip to tip. The one size knob. */
  readonly arm: number;
  /** Ticks the first stroke lasts. The second is held a beat past it. */
  readonly lifetimeTicks?: number;
  /** The bright end of the ramp, where a mark is freshest. */
  readonly bright?: PaletteKey;
  /** Where it dries. */
  readonly deep?: PaletteKey;
  readonly priority?: Priority;
}

/**
 * Two rolls, in radians, in the card plane (spec 175).
 *
 * A quarter turn apart to within three degrees, and the pair tilted a few off
 * upright. Exactly 90 and exactly symmetrical is a multiplication sign; what a
 * person's cross has is two strokes that nearly agree, and the cheapest way to
 * say so is to author the disagreement rather than hope the bank supplies it --
 * the bank varies a mark's outline and never its angle.
 *
 * The second is past a half turn, which is the same *line* drawn the other way,
 * and it is the one number here that was arrived at by looking. A mark is broad
 * at its root and runs out to a point, so two arms rolled to +-45 both put their
 * weight at the bottom and the cross reads as a bird: a heavy V with two thin
 * legs above it. Turning one of them over spreads the weight along a diagonal --
 * one stroke heaviest at the bottom left, the other at the top right -- which is
 * what two marks made by a hand actually look like, and the whole difference
 * between a cross and a starburst.
 */
export const CROSS_ROLLS = [0.86, Math.PI - 0.66] as const;

/**
 * A cross where somebody pointed (spec 175).
 *
 * Two marks and nothing else. Not a burst with two marks in it: every other
 * builder here layers a gesture with company, because a hit and a blast are
 * events with debris, and a *mark* has none -- anything scattered around this
 * one would be paint that came off the brush, which is the one thing that did
 * not happen. The whole cue is the two strokes crossing and then leaving.
 *
 * ## Both are placed, not thrown
 *
 * `speed` is zero and there is no fan, no gravity and no drag. The shape is
 * `brush-mark`, which is centred on its own origin and takes the roll it is
 * given, so the two arms actually cross instead of opening out of one point --
 * and so the cross is the same cross from every seat in the room, where a mark
 * aimed down its own travel would be a cross the camera's azimuth decided the
 * angle of.
 *
 * ## The stagger is the hand
 *
 * The two strokes are born together and the second outlives the first by a
 * couple of ticks, which is two ticks of one arm still there after the other has
 * gone. Ending on the same frame is a stamp; ending a beat apart is a hand that
 * drew one and then the other.
 */
export function brushCross(params: BrushCrossParams): EffectDefinition {
  const arm = params.arm;
  const life = params.lifetimeTicks ?? 18;
  const bright = params.bright ?? 'sparkHot';
  const deep = params.deep ?? 'auraSelected';

  const stroke = (index: number, roll: number, ticks: number): Emitter => ({
    id: `stroke_${index === 0 ? 'a' : 'b'}`,
    shape: { kind: 'point' },
    emission: { kind: 'burst', count: 1 },
    lifetimeTicks: [ticks, ticks],
    // It was put there. Nothing about a placed mark travels, and a mark that
    // drifted off the point would be answering a question about somewhere else.
    speed: [0, 0],
    // A constant, which is the whole reason this is a curve at all: `rotation`
    // is the only channel that reaches `iRotation`, and `iRotation` is the roll
    // the card mode turns the mark by.
    rotation: { keys: [[0, roll], [1, roll]] },
    // Nearly flat, and for the reason every mark in this file has a flat one:
    // the shape draws itself out and takes itself back (specs 159, 161), and a
    // size curve swinging about underneath that is two animations fighting.
    size: { keys: [[0, arm * 0.94], [0.3, arm], [1, arm * 0.96]] },
    // Opaque nearly to the end. The mark leaves by retracting, and an alpha fade
    // that outran it would turn a stroke being finished into a stroke being
    // turned down.
    alpha: { keys: [[0, 1], [0.72, 1], [1, 0]] },
    color: { stops: [[0, bright], [0.6, bright], [1, deep]] },
    render: 'mesh',
    mesh: { shape: 'brush-mark' },
    blend: 'alpha',
    // Fizzle, and it is the one place this parts company with spec 161's rule.
    // That rule reads "retract for anything fast", and it is a rule about marks
    // that were *thrown*: a retract walks an eroding threshold from the root to
    // the tip and pulls the spine after it, which on a mark rooted at its butt
    // is the flick finishing. On a mark rooted at its middle the same motion
    // drags it toward its own tip -- so the cross comes apart into two corners
    // and slides off the point it was put on, in the last four ticks, which is
    // the one thing a confirmation must not do. A fizzle moves the spine not at
    // all: the gaps open through the marks and the cross dries where it lies.
    strokeDecay: 'fizzle',
  });

  return {
    id: params.id,
    priority: params.priority ?? 2,
    cullDistance: 1400,
    emitters: CROSS_ROLLS.map((roll, index) => stroke(index, roll, life + index * 2)),
  };
}

/**
 * How long each arm of the order cross is, in world units (spec 175).
 *
 * Forty: about a body and a quarter across, which at the gameplay zoom is a
 * mark thirty-odd pixels long and four or five wide. Below about thirty the
 * stroke's width falls under two pixels and the paint reads as a scratch; above
 * about forty-five its reach passes the sigil a selected unit stands in, and a
 * confirmation the size of an ability is a confirmation that looks like one.
 */
export const ORDER_MARK_ARM = 40;

/**
 * The order cross in world units: how far it reaches from where it was put.
 *
 * Exported from here because it is a fact about the *effect* rather than about
 * the terrain -- a call site that has to hold a mark clear of a hillside must not
 * also have to know how a mark is authored.
 *
 * It answers two questions that are not the same question: how wide a patch of
 * ground the mark covers, and how far it hangs *below* its own origin. A bounding
 * radius is exactly right for the first and an over-estimate for the second,
 * since it is the answer for an arm pointing straight down and these two are at
 * 45 degrees. The over-estimate is five percent at the authored rolls -- `the
 * cross` in `brush.test.ts` measures the real drop and says so -- which is a
 * world unit and a half of extra daylight, and nowhere near worth a second
 * constant that would have to be re-measured every time an angle moved.
 */
export const ORDER_MARK_REACH = ORDER_MARK_ARM * MARK_REACH;

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
  /**
   * The one that never lands: a spatter that hangs and thins away.
   *
   * Nothing falls. `gravity` is off outright and a gentle `drift` replaces it,
   * so the marks lift instead of dropping, and `turbulence` pushes them apart on
   * the way -- a formation of marks all rising at one rate is a formation, and
   * what makes it read as dissipating is that they stop agreeing with each
   * other.
   *
   * The end is where the work is. A paint mark holds its size and its alpha
   * almost to the last tick, because paint dries where it lands; this one
   * shrinks to a seventh of its peak and starts fading at a third of its life,
   * so it thins from both ends at once while the geometry retracts from its root
   * (spec 159). The result fizzles out in the air rather than arriving anywhere.
   *
   * Slower and looser than the standard hit as well: a third off the throwing
   * speed and much more drag, because something that is going to hang has to
   * stop first, and a wider spread, since nothing is holding it in line.
   */
  bloodHit({
    id: 'blood_hit_brush_mist',
    scale: 24,
    splashes: 4,
    droplets: 6,
    spread: 0.86,
    bias: 0.6,
    // Longer than a paint hit, and for the same reason the smoulder is longer
    // than a blast: lingering is the request. At the standard 34 ticks the
    // primary lives 16 and the whole thing was over before the fizzle could be
    // watched -- which is a mark that vanishes, not one that dissipates.
    lifetimeTicks: 58,
    velocity: 24 * 4.6,
    drag: 8.5,
    gravity: 0,
    drift: 26,
    turbulence: 62,
    // Broken up where it lies rather than pulled back toward its root (spec
    // 161). Retract is what a fast hit wants; held over a second it is the
    // brush retracing its own path backwards, and a spatter that dissipates by
    // un-painting itself is a spatter running in reverse.
    decay: 'fizzle',
    // All three layers held near the full span, so there is something in the air
    // for the whole of the fizzle rather than one straggling dab at the end.
    linger: 0.6,
    // Both gentler than they were, because the break-up is doing the work now.
    // Stacking a hard shrink and an early fade on top of it took the whole mark
    // faint at once, which reads as the effect being turned down rather than as
    // paint coming apart.
    shrinkTo: 0.42,
    // Late, so alpha is not racing the break-up. The geometry coming apart is
    // the thing being watched; a fade that outruns it turns a decomposition into
    // the effect being turned down.
    fadeFrom: 0.86,
  }),

  bloodHit({
    id: 'blood_hit_brush_heavy',
    scale: 36,
    // Still ONE dominant mark. A killing blow is a bigger gesture, not two
    // gestures -- the loud variant grows the primary and adds company to it.
    strokes: 1,
    splashes: 5,
    droplets: 8,
    strokeLength: 1.15,
    spread: 0.78,
    bias: 0.66,
    lifetimeTicks: 40,
  }),

  brushExplosion({ id: 'explosion_brush_small', radius: 34, radialCount: 8, debris: 2, smoke: 4, lifetimeTicks: 62 }),

  /**
   * The smoulder: smoke almost at once, and long after the fire is out.
   *
   * The same six layers in the same order -- this is not a second explosion, it
   * is this one with its two halves pulled apart. The fire is cut to a little
   * over half its usual life so the bright phase is a flare rather than a
   * blaze; the smoke starts on tick 3, while the major strokes are still
   * arriving, and lives four to six times as long as any of them.
   *
   * That overlap is the whole look. Standard, the fire has its moment and the
   * smoke arrives afterwards to clear up; here the mass rolls over the fire
   * while it is still burning, which is what a charge going off in something
   * that catches looks like. It runs about two seconds rather than one and a
   * quarter, and it is the one preset here that deliberately sits outside the
   * brief's window -- lingering is the request.
   */
  brushExplosion({
    id: 'explosion_brush_smoulder',
    radius: 62,
    radialCount: 11,
    lifetimeTicks: 46,
    debris: 4,
    smoke: 9,
    smokeDelayTicks: 3,
    smokeLifeTicks: [74, 116],
    light: true,
  }),
  brushExplosion({ id: 'explosion_brush', radius: BRUSH_EXPLOSION_RADIUS, light: true }),
  brushExplosion({
    id: 'explosion_brush_large',
    radius: 96,
    radialCount: 14,
    debris: 5,
    smoke: 8,
    lifetimeTicks: 86,
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
  /**
   * Paint that never lands: the spatter hangs, thins and fizzles out instead of
   * falling. For anything that does not bleed the way a body does.
   *
   * Chosen over the intensity split rather than beside it, so there is one mist
   * and not two: a heavier hit on something that does not bleed is a *bigger*
   * mist, which `scale` already says.
   */
  readonly dissipates?: boolean;
  readonly seed: number;
}

export interface BrushExplosionInput {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** How far the burst should reach, in world units. */
  readonly radius?: number;
  readonly intensity?: number;
  /**
   * Smoke almost at once, and long after the fire is out.
   *
   * Its own preset rather than a size, because the counts and the two halves'
   * lifetimes all move together -- the same reason `radius` picks a preset
   * rather than scaling one.
   */
  readonly smoulder?: boolean;
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
  const mist = input.dissipates === true;
  const heavy = !mist && intensity >= HEAVY_HIT_INTENSITY;
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
    id: mist ? 'blood_hit_brush_mist' : heavy ? 'blood_hit_brush_heavy' : 'blood_hit_brush',
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
 * A bearing in [0, 2pi) from a seed, well mixed.
 *
 * The same avalanche `VfxRng.reset` uses, and for the same reason it gives:
 * small, structured seeds have to be spread before any of their bits mean
 * anything.
 */
function bearingFromSeed(seed: number): number {
  let s = seed >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
  return ((s ^ (s >>> 16)) >>> 0) / 4294967296 * Math.PI * 2;
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
  const preset = input.smoulder
    ? // One smoulder at one authored size, scaled to whatever was asked for. A
      // second and third of them would be three presets whose only difference is
      // a number `scale` already carries.
      { id: 'explosion_brush_smoulder', radius: 62 }
    : radius < 46
      ? { id: 'explosion_brush_small', radius: 34 }
      : radius < 78
        ? { id: 'explosion_brush', radius: BRUSH_EXPLOSION_RADIUS }
        : { id: 'explosion_brush_large', radius: 96 };

  return {
    id: preset.id,
    x: input.x,
    y: input.y,
    z: input.z,
    // The composition is fixed and asymmetric (`LOBES`), so what makes two
    // explosions look like two explosions rather than one stamped twice is
    // which way that composition is *facing*. Drawn off the seed, so it is
    // still a pure function of the call and two clients see the same blast --
    // and *mixed* rather than shifted, because callers seed from counters and
    // structured ids, and a plain bit-slice gave six multiples of one number
    // three bearings between them.
    rotation: bearingFromSeed(input.seed),
    // Intensity enters through the *cube root*, so doubling it is a visibly
    // bigger blast rather than a blast twice as wide -- a linear intensity makes
    // 2 fill the screen and 0.5 disappear.
    scale: (radius / preset.radius) * Math.cbrt(intensity),
    seed: input.seed,
  };
}
