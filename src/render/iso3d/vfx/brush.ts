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
 * Which way the two arms run, in radians of yaw in the ground plane (spec 175).
 *
 * A quarter turn apart to within three degrees. Exactly 90 and exactly
 * symmetrical is a multiplication sign; what a person's cross has is two strokes
 * that nearly agree, and the cheapest way to say so is to author the
 * disagreement rather than hope the bank supplies it -- the bank varies a mark's
 * outline and never its angle.
 *
 * Near the world axes, and that is the part decided by the *camera*. A flat mark
 * is squashed along the view's own horizontal bearing and untouched across it,
 * which for two arms at a right angle means one of them can be squashed to a
 * third of the other. The default camera looks along 45 degrees, so arms near 0
 * and 90 sit at 45 degrees either side of it and foreshorten by the same amount
 * -- the cross stays a cross. Arms authored at +-45 are the same cross rotated,
 * and at the default seat they are a long stroke with a stub across it.
 *
 * A few degrees off the axes rather than on them, because the heightfield's own
 * cells run along those axes and a mark laid exactly on them reads as snapped to
 * the terrain grid.
 */
export const CROSS_YAWS = [0.13, 1.66] as const;

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
 * `brush-mark`, which lies flat in the ground plane, is centred on its own
 * origin and takes the yaw it is given -- so the two arms actually cross instead
 * of opening out of one point, and the mark is painted on the floor the player
 * clicked rather than suspended over it.
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

  const stroke = (index: number, yaw: number, ticks: number): Emitter => ({
    id: `stroke_${index === 0 ? 'a' : 'b'}`,
    shape: { kind: 'point' },
    emission: { kind: 'burst', count: 1 },
    lifetimeTicks: [ticks, ticks],
    // It was put there. Nothing about a placed mark travels, and a mark that
    // drifted off the point would be answering a question about somewhere else.
    speed: [0, 0],
    // A constant, which is the whole reason this is a curve at all: `rotation`
    // is the only channel that reaches `iRotation`, and `iRotation` is the yaw
    // the ground mode turns the mark by.
    rotation: { keys: [[0, yaw], [1, yaw]] },
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
    emitters: CROSS_YAWS.map((yaw, index) => stroke(index, yaw, life + index * 2)),
  };
}

export interface BrushSwingParams {
  readonly id: string;
  /** How far the blade reaches, in world units. The one size knob. */
  readonly reach: number;
  /** Total angle the swing covers, centred on the effect's bearing. Radians. */
  readonly sweep: number;
  /** How many lobes the sweep is composed of. */
  readonly lobes?: number;
  readonly lifetimeTicks?: number;
  /** How high off the ground the blade passes. A chest, not a pair of boots. */
  readonly lift?: number;
  readonly bright?: PaletteKey;
  readonly mid?: PaletteKey;
  readonly deep?: PaletteKey;
  readonly priority?: Priority;
}

/**
 * A swing, painted (spec 233).
 *
 * ## The false start, because it is the whole reason this looks the way it does
 *
 * The first version of this invented a `brush-sweep` mesh shape and an
 * `ORIENT.groundVelocity` to go with it, and laid the marks **flat on the
 * ground** along an arc. It was wrong in the way that matters: the vocabulary
 * this game paints combat in is marks *in the air* -- `bloodHit` throws
 * `brush-slash` at `cardVelocity`, `brushExplosion` composes lobes of them --
 * and a flat ring on the floor is the same object as the debug disc
 * `scene.addEffect` falls back to, only in paint. Whirlwind at a full turn was
 * literally a painted circle on the ground.
 *
 * So this is built the way the effects it has to sit beside are built, and it
 * needs **no engine change at all**: `fan` already throws marks along a bearing
 * and lifts them out of the ground plane, and `bearing` already lets several of
 * them compose a shape.
 *
 * ## Lobes, not a spread
 *
 * `brushExplosion` states the argument and it holds here: a single wide fan
 * samples directions uniformly, so however different the marks are the
 * silhouette comes out an even star. A swing is composed of a few clusters with
 * gaps between them, and the counts step down across the sweep so one part of
 * it carries more weight than the rest -- which is what a blade accelerating
 * through an arc actually leaves.
 *
 * ## Born out on the arc, not at the body
 *
 * Each lobe is `offset` most of the way out to the reach, so the marks are where
 * the blade was rather than streaming out of the caster's chest. `system.ts`
 * turns an emitter's offset by the effect's rotation, so the whole composition
 * aims with nothing else to do -- the same mechanism that makes a blood hit
 * point away from its attacker.
 */
export function brushSwing(params: BrushSwingParams): EffectDefinition {
  const reach = params.reach;
  const lobes = Math.max(2, params.lobes ?? 5);
  const life = params.lifetimeTicks ?? 26;
  const lift = params.lift ?? reach * 0.22;
  const bright = params.bright ?? 'physicalBone';
  const mid = params.mid ?? 'dustPale';
  const deep = params.deep ?? 'dustStone';
  // Thrown at a fraction of the reach a second: fast enough to read as a blade
  // rather than a puff, and `velocityScale` takes it out almost at once so the
  // marks stop where the blade was instead of sailing off it.
  const velocity = reach * 5.2;

  const emitters: Emitter[] = [];
  for (let index = 0; index < lobes; index += 1) {
    // Across the sweep, centred on the effect's own bearing. A full turn wraps,
    // so the last lobe is not laid on top of the first: the span is divided by
    // the count rather than by the gaps between them.
    const wraps = params.sweep >= Math.PI * 1.98;
    const step = params.sweep / (wraps ? lobes : Math.max(1, lobes - 1));
    const theta = wraps ? index * step : -params.sweep / 2 + index * step;
    // Uneven, so the sweep has weight somewhere rather than being an even star
    // -- `brushExplosion`'s argument, applied along an arc instead of around a
    // point. Every other lobe is a dominant `brush-slash`, and the rest are
    // `brush-flick` company: all-flick reads as petals rather than as an edge,
    // which is what the first render of this sheet showed.
    const heavy = index % 2 === 0;
    emitters.push({
      id: `lobe_${index}`,
      // Out on the arc rather than at the caster (see the header), and lifted to
      // the height a blade actually passes at.
      offset: { x: Math.cos(theta) * reach * 0.72, y: lift, z: Math.sin(theta) * reach * 0.72 },
      // Thrown outward *and along* the turn: half a radian ahead of its own
      // bearing, which is the direction the edge is travelling at that point of
      // the arc. Purely radial marks read as an explosion; purely tangential
      // ones read as a ring.
      shape: { kind: 'fan', angle: 0.5, radius: reach * 0.06, rise: 0.16, bearing: theta + 0.5 },
      emission: { kind: 'burst', count: heavy ? 4 : 2 },
      lifetimeTicks: [Math.round(life * 0.55), life],
      speed: [velocity * 0.7, velocity * 1.15],
      spreadRadians: 0.18,
      // Light, for `bloodHit`'s reason: these marks carry a *direction* and that
      // is the information in them, so enough gravity to turn one mid-flight
      // makes it a vertical mark that says nothing about where the blade went.
      gravity: -260,
      drag: 6,
      velocityScale: { keys: [[0, 1], [0.28, 0.14], [1, 0.03]] },
      // A stroke's size *is* its length. The dominant marks are most of a
      // body across, which is what makes them read as an edge going past rather
      // than as debris coming off one.
      size: (() => {
        const peak = reach * (heavy ? 0.72 : 0.42);
        return { keys: [[0, peak * 0.92], [0.35, peak], [1, peak * 0.9]] } as const;
      })(),
      // Opaque while it matters, like every mark in this file: overlapping
      // translucent strokes make a third colour at every crossing that is in
      // neither of them.
      alpha: { keys: [[0, 1], [0.7, 1], [1, 0]] },
      color: { stops: [[0, bright], [0.5, bright], [0.78, mid], [1, deep]] },
      render: 'mesh',
      mesh: { shape: heavy ? 'brush-slash' : 'brush-flick' },
      blend: 'alpha',
      // Retract, which is spec 161's rule for anything fast: these are thrown
      // marks rooted at their butts, so the erosion walking from root to tip is
      // the stroke being finished rather than the mark sliding off its point.
      strokeDecay: 'retract',
    });
  }

  return {
    id: params.id,
    priority: params.priority ?? 2,
    cullDistance: 1600,
    emitters,
  };
}

export interface BrushShardsParams {
  readonly id: string;
  /** How far the shards reach, in world units. */
  readonly reach: number;
  /** How many. Small and many is the whole idea. */
  readonly count?: number;
  /** Each shard's length, as a fraction of the reach. */
  readonly length?: number;
  readonly lifetimeTicks?: number;
  /** How high off the ground they leave, as a fraction of the reach. */
  readonly lift?: number;
  readonly bright?: PaletteKey;
  readonly mid?: PaletteKey;
  readonly deep?: PaletteKey;
  readonly priority?: Priority;
}

/**
 * Small sharp marks thrown outward: shards (spec 235).
 *
 * The counterpart to {@link brushExplosion} and the reason it is not one.
 * `brushExplosion` composes a few *dominant* strokes into lobes, which is what
 * makes a blast read as a blast -- and at frost colours that composition came
 * out as a handful of big pale sheets, which reads as **water**. What frost
 * wants is the opposite distribution: many small pieces, all going outward, none
 * of them dominant.
 *
 * So the marks are `brush-dab` and `brush-flick` rather than `brush-slash`, they
 * are a fifth the length, and there are four times as many. Nothing here has a
 * lobe: a shatter genuinely is radially even, which is the one case
 * `brushExplosion`'s "asymmetry has to be composed" argument does *not* apply to
 * -- ice breaking has no side it favours.
 *
 * They also **fall**. Gravity is real here where a blast's is nearly off,
 * because that is most of what separates the two: fire goes up and out and
 * burns off in the air, and shards go out and come down.
 */
export function brushShards(params: BrushShardsParams): EffectDefinition {
  const reach = params.reach;
  const count = params.count ?? 26;
  const length = (params.length ?? 0.19) * reach;
  const life = params.lifetimeTicks ?? 30;
  const lift = params.lift ?? 0.1;
  const bright = params.bright ?? 'iceWhite';
  const mid = params.mid ?? 'icePale';
  const deep = params.deep ?? 'iceDeep';

  /** One ring of shards. Two of them, so the sizes are not all one size. */
  const ring = (id: string, marks: number, scale: number, shape: 'brush-dab' | 'brush-flick'): Emitter => ({
    id,
    // `circle` rather than `fan`: radially even on purpose (see the header), and
    // `shell` so they leave from a rim rather than filling a disc.
    shape: { kind: 'circle', radius: reach * 0.08, shell: true },
    emission: { kind: 'burst', count: marks },
    lifetimeTicks: [Math.round(life * 0.5), life],
    speed: [reach * 3.4 * scale, reach * 6.2 * scale],
    // Wide, because a shatter has no bearing to respect.
    spreadRadians: 0.9,
    // Real gravity: shards come down, which is what fire does not do.
    gravity: -1500,
    drag: 3.4,
    velocityScale: { keys: [[0, 1], [0.4, 0.4], [1, 0.12]] },
    size: {
      keys: [
        [0, length * scale * 0.9],
        [0.3, length * scale],
        [1, length * scale * 0.72],
      ],
    },
    alpha: { keys: [[0, 1], [0.62, 1], [1, 0]] },
    color: { stops: [[0, bright], [0.45, mid], [1, deep]] },
    render: 'mesh',
    mesh: { shape },
    blend: 'alpha',
    offset: { x: 0, y: reach * lift, z: 0 },
    // Retract: these are thrown and rooted at their butts, so the erosion
    // walking root to tip is the shard finishing rather than sliding off itself.
    strokeDecay: 'retract',
  });

  return {
    id: params.id,
    priority: params.priority ?? 2,
    cullDistance: 1500,
    emitters: [
      // The flash the break starts with -- one beat, near-white, and gone.
      // Without it the shatter has no *moment*, only a spray.
      {
        id: 'flash',
        shape: { kind: 'circle', radius: reach * 0.05 },
        emission: { kind: 'burst', count: 4 },
        lifetimeTicks: [4, 7],
        speed: [reach * 1.4, reach * 2.6],
        spreadRadians: 1.2,
        size: { keys: [[0, length * 1.5], [1, length * 0.7]] },
        alpha: { keys: [[0, 1], [0.6, 1], [1, 0]] },
        color: { stops: [[0, bright], [1, mid]] },
        render: 'mesh',
        mesh: { shape: 'brush-flick' },
        blend: 'alpha',
        offset: { x: 0, y: reach * lift, z: 0 },
        strokeDecay: 'retract',
      },
      ring('shards', Math.round(count * 0.6), 1, 'brush-flick'),
      ring('splinters', Math.round(count * 0.4), 0.62, 'brush-dab'),
    ],
  };
}

export interface BrushLaneParams {
  readonly id: string;
  /** How far down its own bearing the lane runs. */
  readonly length: number;
  /** How wide, across the bearing. */
  readonly width: number;
  /** How many nodes the run is made of. */
  readonly nodes?: number;
  /** Marks per node. */
  readonly marks?: number;
  readonly lifetimeTicks?: number;
  /** How high off the ground it runs. */
  readonly lift?: number;
  /** Spread the run out into a cone instead, half-angle in radians. */
  readonly cone?: number;
  readonly bright?: PaletteKey;
  readonly mid?: PaletteKey;
  readonly deep?: PaletteKey;
  readonly priority?: Priority;
}

/**
 * Marks strung along a bearing: a lane, or a cone (spec 235).
 *
 * The third composition in this file, and the one the other two could not do.
 * `brushExplosion` throws from a point and `brushSwing` lays along an arc; both
 * are *centred* on where they are played. A lane is not -- it starts at the
 * caster and runs three hundred units away from them, and drawing it as
 * anything centred is what made Arc Lash a violet burst that had nothing to do
 * with the skill.
 *
 * It needs the bearing spec 235 put on the effect message. Before that there was
 * none: `landArea` sends a line's cue at the caster's own feet, so a lane could
 * only ever have pointed one fixed way in world space.
 *
 * ## Nodes, and why they zig
 *
 * The run is a handful of nodes `offset` along +X, each throwing a few marks.
 * Alternate nodes are pushed to opposite sides of the centre line by a fraction
 * of the width, so the run has a kink in it rather than being a ruled line --
 * which is the whole difference between a bolt and a laser, and cannot come out
 * of a sampler because it has to alternate.
 *
 * ## The cone is the same thing spread
 *
 * With `cone` set, a node's offset is turned by an angle that grows along the
 * run instead of being pushed sideways, so the nodes fan out from the origin.
 * One builder rather than two because a cone and a lane differ in exactly that:
 * where the nodes are. What is thrown at each of them is identical.
 */
export function brushLane(params: BrushLaneParams): EffectDefinition {
  const nodes = Math.max(2, params.nodes ?? 6);
  const marks = params.marks ?? 3;
  const life = params.lifetimeTicks ?? 22;
  const lift = params.lift ?? params.width * 0.28;
  // `boltFlash` rather than `boltWhite`: the latter is 0xfffbe0, a *cream*, and
  // on the near end of the run -- where the marks are biggest -- it read as
  // milk rather than as a discharge. The flash white is 0xf4f8ff and carries a
  // blue cast, which is the same near-white the rest of the bolt ramp is built
  // around.
  const bright = params.bright ?? 'boltFlash';
  const mid = params.mid ?? 'boltArc';
  const deep = params.deep ?? 'boltViolet';
  const cone = params.cone ?? 0;

  const emitters: Emitter[] = [];
  for (let index = 0; index < nodes; index += 1) {
    // Along the run, from just off the caster to the far end. Never at zero:
    // a node on top of the caster is a mark inside their own body.
    const along = (index + 1) / nodes;
    const distance = params.length * along;
    // A cone fans; a lane kinks. Alternating rather than drawn, because a zig
    // has to *alternate* -- a random offset per node is a wobble, and a wobble
    // reads as an effect that could not decide where to go.
    const side = cone > 0 ? 0 : (index % 2 === 0 ? 1 : -1) * params.width * 0.34;
    const yaw = cone > 0 ? (index % 2 === 0 ? 1 : -1) * cone * along : 0;
    const x = Math.cos(yaw) * distance;
    const z = Math.sin(yaw) * distance + side;
    // Narrower and shorter at the far end: a bolt is fiercest where it starts,
    // and a cone genuinely does thin out as it spreads.
    const taper = 1 - along * 0.42;
    emitters.push({
      id: `node_${index}`,
      offset: { x, y: lift, z },
      // Thrown *onward*, down the run, so the marks read as travelling rather
      // than as a row of stamps. `bearing` is in the effect's own frame, which
      // its rotation then turns -- so one definition serves every aim.
      shape: { kind: 'fan', angle: 0.42, radius: params.width * 0.12, rise: 0.1, bearing: yaw },
      // Later nodes start later: the run arrives end to end rather than all at
      // once, which is the other half of reading as a bolt rather than a bar.
      emission: { kind: 'burst', count: marks, delayTicks: index },
      lifetimeTicks: [Math.round(life * 0.5), Math.round(life * taper + 4)],
      speed: [params.length * 1.1, params.length * 2.0],
      spreadRadians: 0.22,
      // None. A bolt does not fall, and a cone of acid is over before it could.
      drag: 7,
      velocityScale: { keys: [[0, 1], [0.25, 0.12], [1, 0.02]] },
      size: {
        keys: [
          [0, params.width * 0.78 * taper],
          [0.3, params.width * 0.86 * taper],
          [1, params.width * 0.8 * taper],
        ],
      },
      alpha: { keys: [[0, 1], [0.66, 1], [1, 0]] },
      color: { stops: [[0, bright], [0.42, bright], [0.72, mid], [1, deep]] },
      render: 'mesh',
      mesh: { shape: index % 2 === 0 ? 'brush-slash' : 'brush-flick' },
      blend: 'alpha',
      strokeDecay: 'retract',
    });
  }

  return {
    id: params.id,
    priority: params.priority ?? 2,
    cullDistance: 1800,
    emitters,
  };
}

/**
 * How long each arm of the order cross is, in world units (spec 175).
 *
 * Twenty-eight: a bit under a body across, and comfortably inside the sigil a
 * selected unit already stands in -- this is a confirmation, not an ability. The
 * lower bound is the *stroke*, which is a bit over two world units wide at this
 * length: the game's default zoom puts two or three pixels on a world unit, so
 * much under this and the paint is a scratch rather than a mark.
 */
export const ORDER_MARK_ARM = 28;

/**
 * The order cross in world units: how far it reaches from where it was put.
 *
 * Exported from here because it is a fact about the *effect* rather than about
 * the terrain -- a call site that has to hold a mark clear of a hillside must not
 * also have to know how a mark is authored.
 *
 * How wide a patch of ground it covers, and nothing about height: the mark is
 * horizontal and its arch bulges upward, so it cannot reach below its own origin
 * at all. That is the whole simplification the flat version buys -- the upright
 * one owed a second length for how far it hung below itself, and a camera vector
 * to scale it by. `the cross` in `brush.test.ts` is what holds the claim: no
 * vertex of the mark, at either authored yaw and with every per-instance maximum
 * the shader can apply, is below the plane it is laid in.
 */
export const ORDER_MARK_REACH = ORDER_MARK_ARM * MARK_REACH;

// --- the afflictions ---------------------------------------------------------

/**
 * A body carrying an affliction (spec 215), as paint that clings to it.
 *
 * The fourth builder here and the first that is not an *event*. `bloodHit`,
 * `brushExplosion` and `brushCross` are all a burst thrown at a point and over
 * inside a second and a bit; an affliction stays on a body that is walking
 * around, for four to ten seconds, and is the one damage in this game that
 * outlives the thing that delivered it. That is a different animal, and it gets
 * its own builder rather than a `bloodHit` with the numbers turned down -- a hit
 * that never stops bursting is a body standing inside a permanent spatter.
 *
 * ## Two layers, and they are doing different jobs
 *
 * **The cling** is what says *stained*: marks born on the body's own surface,
 * riding it, barely moving, renewed about twice a second. It is the layer that
 * reads at a glance and the only reason a poisoned body looks different from a
 * burning one across the arena.
 *
 * **The shed** is what says *which*: marks leaving that surface along {@link
 * BrushAfflictionParams.rise}. Direction is information in this vocabulary and
 * up-or-down is the cheapest direction there is -- fire goes up, rot goes down,
 * and nothing has to be read to know which is which.
 *
 * There is deliberately no third layer. The hit has three because it is a
 * *gesture* and needs a dominant mark to carry the bearing; an affliction has no
 * bearing, and the beat that would be its third layer is a separate one-shot
 * ({@link brushAfflictionPulse}) fired on the tick the damage actually lands.
 *
 * ## Four facts about the vocabulary that decide the rest
 *
 * **`worldSpace: false` is the whole of "it clings."** The compiled default is
 * `true` (`compile.ts`), and attaching an effect to an entity moves only the
 * *emission origin* -- so a mark born on a walking body and left in world space
 * is a mark the body immediately walks out of. A parented particle is displaced
 * by its owner's delta each tick, which is a translation and not a rotation: a
 * stain does not turn with a body that spins on the spot. At half a second a
 * mark and twice a second a refresh, that is not a thing anybody can see, and
 * paying for it would mean giving every particle a frame.
 *
 * **The shape choice IS the orientation choice.** `orientOf` gives `brush-blot`
 * `tumble` -- world space, which is where this vocabulary's sense of depth comes
 * from -- `brush-dab` `velocity`, and `brush-slash`/`brush-flick` `cardVelocity`,
 * camera-facing so they always read. A stain on a body should turn with the
 * body's own volume, so the cling is a blot. `brush-mark` is `ground`, flat in
 * XZ, and is therefore the one brush shape that cannot go on a body at all.
 *
 * **`fizzle`, never `retract`.** Spec 161's rule, and this is the case it was
 * written about: a retract walks an eroding threshold from the mark's own root
 * and pulls the spine after it, which played slowly is the brush retracing its
 * own path backwards -- the stroke being *un-painted* rather than anything
 * thinning away. Every mark here is held long enough to be watched.
 *
 * **`blend: 'alpha'`.** Paint is opaque, and two translucent marks crossing make
 * a third colour that is in neither of them. This matters more here than
 * anywhere else in the file, because a cling is *many overlapping marks on one
 * body by construction* -- the one arrangement where a translucent mark is
 * guaranteed to cross another one.
 *
 * ## Lengths are in body radii, not in world units
 *
 * Every length below is a multiple of the effect's own scale, and the driver
 * plays these with `scale` set to the body's footprint radius. The surface hook
 * answers in the same units. So one authored definition fits a spider and a
 * player: the marks land on the body at the right place *and* come out the right
 * size, because `system.ts` multiplies both the shape's local coordinates and
 * the size curve by the instance scale.
 *
 * ## ...but speed, acceleration and turbulence are world units
 *
 * `system.ts` multiplies the shape's local coordinates and the size curve by the
 * instance scale and **nothing else** -- a particle's velocity, the constant push
 * on it and its turbulence amplitude are all integrated in world units per
 * second. That is correct rather than an omission: a big body's paint drips at
 * the same rate as a small one's, because gravity is gravity.
 *
 * It is written down because it is the one asymmetry in this file and the
 * mistake it invites is silent. Authored as if they were radii, every one of
 * these numbers comes out about a hundred times too small, and the result is not
 * an effect that looks wrong -- it is a shed layer that never leaves the surface
 * it was born on, which reads as a cling with more marks in it.
 *
 * The calibration to hold them against is `bloodHit`, in this file: a hit's
 * primary mark leaves at `scale * 7` -- about 180 units a second -- under
 * `gravity: -900`, and the mist that *hangs* rather than falling replaces that
 * with `drift: 26` and `turbulence: 62`. So 26 is a gentle lift, 62 is
 * "the marks come apart", and 900 is a real fall. Everything here is quieter
 * than a hit by design, and sits between those.
 *
 * ## Eighteen effects and no new draw calls
 *
 * A batch is keyed `family:blend:sheet:meshShape` (`compile.ts`), and every
 * emitter here is a `mesh` in `alpha` on one of four marks the file already
 * draws -- `brush-blot` from the explosion's smoke, and `brush-slash`,
 * `brush-flick` and `brush-dab` from the hit. So the whole of this costs the
 * registry **zero** additional batches, which matters because `library.test.ts`
 * caps them at 25 and the table is sitting on that number.
 *
 * Neither `worldSpace` nor `strokeDecay` is in the key, and that is not luck:
 * decay rides as a per-*instance* attribute precisely so two effects can share a
 * mark and end it differently, which is what lets the cling fizzle and the beat
 * retract out of the same geometry.
 */
export interface BrushAfflictionParams {
  readonly id: string;
  /** Marks held on the body, per second. The layer that says "stained". */
  readonly cling?: number;
  /** Marks leaving it, per second. The layer that says which affliction. */
  readonly shed?: number;
  /**
   * Where the shed goes, in **world** units per second squared. Positive rises.
   *
   * The one number that separates the seven at a glance. Fire lifts, every rot
   * falls, and cold barely moves at all. Against `bloodHit`'s `drift: 26` for a
   * gentle lift and its `gravity: -900` for a real fall.
   */
  readonly rise?: number;
  /** How far a shed mark wanders, **world** units per second squared. */
  readonly turbulence?: number;
  /** How fast a shed mark leaves the surface, **world** units per second. */
  readonly shedSpeed?: number;
  /** Ticks a cling mark lives. Short: paint being renewed, not accumulating. */
  readonly clingLife?: readonly [number, number];
  readonly shedLife?: readonly [number, number];
  /** A cling mark's length, in body radii. */
  readonly clingSize?: number;
  /** A shed mark's length, in body radii. */
  readonly shedSize?: number;
  /**
   * The shed's mark, and the choice is an orientation choice (see the header).
   *
   * `brush-dab` takes `velocity`, so it lies along its own travel -- right for
   * anything that drips or falls, where the direction *is* the information.
   * `brush-flick` is `cardVelocity` and streaks, for anything leaving fast.
   * `brush-blot` is `tumble`: it turns in world space and is the roundest mark
   * in the set, which is the only one of the three that can be a **bubble** --
   * a dab rising vertically is a vertical dash, and a dash going up is not a
   * bubble however slowly it moves.
   */
  readonly shedShape?: 'brush-dab' | 'brush-flick' | 'brush-blot';
  /** Palest, for a mark that has just landed. */
  readonly bright: PaletteKey;
  /** The body colour, and most of what is on screen. */
  readonly mid: PaletteKey;
  /** Darkest, where a mark is drying or falling away. */
  readonly deep: PaletteKey;
  readonly priority?: Priority;
  readonly cullDistance?: number;
}

export function brushAffliction(params: BrushAfflictionParams): EffectDefinition {
  const cling = Math.max(0, params.cling ?? 7);
  const shed = Math.max(0, params.shed ?? 3);
  const rise = params.rise ?? 0;
  const turbulence = Math.max(0, params.turbulence ?? 0);
  const shedSpeed = Math.max(0, params.shedSpeed ?? 9);
  const [clingMin, clingMax] = params.clingLife ?? [22, 34];
  const [shedMin, shedMax] = params.shedLife ?? [26, 44];
  const clingSize = params.clingSize ?? 0.62;
  const shedSize = params.shedSize ?? 0.34;
  const shedShape = params.shedShape ?? 'brush-dab';

  const emitters: Emitter[] = [
    // (a) The cling. Born on the body's surface, riding it, barely moving.
    //
    // Its speed is a *trickle* rather than nothing, and that is the difference
    // between paint and wallpaper: at exactly zero every mark sits on the point
    // it was born at and the layer reads as a texture that was always there.
    // A little travel, killed almost immediately by the drag, is a mark being
    // put on -- and it is what lets the same definition read on a body standing
    // still and on one running away from you.
    {
      id: 'cling',
      shape: { kind: 'mesh' },
      emission: { kind: 'rate', perSecond: cling },
      lifetimeTicks: [Math.round(clingMin), Math.round(clingMax)],
      // World units a second, and small: with `drag: 7` a mark sheds almost all
      // of this inside a sixth of a second and travels well under a unit. That
      // is the point -- it is a mark being *put on*, not one going anywhere --
      // and it is the difference between paint and wallpaper. At exactly zero
      // every mark sits on the point it was born at and the layer reads as a
      // texture that was always there.
      speed: [1.5, 5],
      // Nearly a full hemisphere. The surface hook hands back a point and a
      // straight-up direction (`system.ts`), so without this every cling mark on
      // a body would set off in the same direction and the layer would read as a
      // fringe rather than as a coat.
      spreadRadians: 1.5,
      drag: 7,
      angularVelocity: [-0.7, 0.7],
      // Born a little under, at full size a third of the way in, and ending
      // where it started rather than at nothing: paint dries, it does not
      // evaporate, and `fizzle` is what takes this one off the body.
      size: { keys: [[0, clingSize * 0.72], [0.34, clingSize], [1, clingSize * 0.86]] },
      // Opaque for four fifths of its life. The mark is coming apart into
      // islands by then and there is very little left for alpha to do.
      alpha: { keys: [[0, 1], [0.78, 1], [1, 0]] },
      // Born bright and settling on the body colour, and it **never reaches
      // `deep`** -- which is the rule the first cut got wrong. A cling is the
      // layer that has to read, and reading is mostly a question of value: with
      // the ramp running all the way down, a mark spent the back half of its
      // life in the darkest tone the affliction has, and against grass and dirt
      // that is mud. It showed up as Frostbite being far and away the most
      // legible of the seven for no reason anybody had chosen -- its ramp is the
      // only one whose dark end is still light.
      //
      // So the two layers split the ramp between them: the cling lives in the
      // top two tones because it is what is *on* the body, and the shed below
      // takes `mid` to `deep` because it is what is coming *off* it. Which also
      // buys the thing a single ramp could not: the paint on a body and the
      // paint falling from it are different colours, so the two layers separate
      // without either needing a second palette entry.
      color: { stops: [[0, params.bright], [0.35, params.mid], [1, params.mid]] },
      render: 'mesh',
      mesh: { shape: 'brush-blot' },
      blend: 'alpha',
      strokeDecay: 'fizzle',
      // The whole of "it clings". See the header.
      worldSpace: false,
    },
    // (b) The shed. The same surface, and then it leaves.
    //
    // Left in world space on purpose, and it is the one place these two layers
    // disagree: what has come off a body is no longer on it, and a drip that
    // followed the body it fell from would read as being stuck to it.
    {
      id: 'shed',
      shape: { kind: 'mesh' },
      emission: { kind: 'rate', perSecond: shed },
      lifetimeTicks: [Math.round(shedMin), Math.round(shedMax)],
      speed: [shedSpeed * 0.4, shedSpeed * 1.5],
      spreadRadians: 1.15,
      drag: 1.6,
      acceleration: { x: 0, y: rise, z: 0 },
      turbulence: { amplitude: turbulence, frequency: 0.05 },
      angularVelocity: [-1.6, 1.6],
      // Thins as it goes, unlike the cling: this one IS leaving.
      size: { keys: [[0, shedSize * 0.8], [0.3, shedSize], [1, shedSize * 0.42]] },
      alpha: { keys: [[0, 1], [0.6, 1], [1, 0]] },
      // Mid to deep: this one is leaving, and going dark on the way out is what
      // says so. See the cling above for why the two layers divide the ramp.
      color: { stops: [[0, params.mid], [0.45, params.mid], [1, params.deep]] },
      render: 'mesh',
      mesh: { shape: shedShape },
      blend: 'alpha',
      strokeDecay: 'fizzle',
    },
  ];

  return {
    id: params.id,
    // Low, and deliberately the lowest thing this file authors. A cling holds an
    // instance slot for the whole life of the affliction against a budget of
    // 128, so an affliction on a body across the arena is the first thing that
    // should yield and the fight in front of you is the last.
    priority: params.priority ?? 1,
    cullDistance: params.cullDistance ?? 1200,
    // Until stopped. The driver owns the stop, and owes one on despawn: nothing
    // in this system stops itself when the body it is attached to goes away.
    durationTicks: 0,
    // Soft, not hard. A cling mark lives about half a second, so letting the
    // last few dry is what an affliction ending should look like -- the aura's
    // `hardStop` argument was a single particle held for ten minutes, which is
    // not this.
    emitters,
  };
}

/**
 * One beat of an affliction (spec 215): the tick a pulse actually lands.
 *
 * The other half of the pair, and an *event* where {@link brushAffliction} is a
 * state -- the division `world/auras.ts` draws in one line, *"a hit happens; a
 * poison lasts"*. It is played one-shot on the tick the sim's own resolver fires
 * on, which the client can work out from the replicated expiry without anything
 * new crossing the wire, so **the paint and the damage number arrive on the same
 * frame**.
 *
 * That is the entire difference between "there is a green haze on that thing"
 * and "that thing is being poisoned". A cling with no beat is an aura; a beat
 * with no cling is a hit that keeps happening for no visible reason.
 *
 * `brush-slash` and `brush-flick` throughout, because both take `cardVelocity`
 * and therefore always face the camera: a cling may turn away and still read as
 * a stain, and a beat that turned away would be a beat nobody saw. Left in
 * **world space**, unlike the cling: a jolt is thrown *off* a body and should
 * not travel with it.
 */
export interface BrushPulseParams {
  readonly id: string;
  /** Marks thrown. Few: a beat is a punctuation mark, not a burst. */
  readonly marks?: number;
  readonly lifetimeTicks?: number;
  /** **World** units per second squared. Positive rises. */
  readonly rise?: number;
  /** **World** units per second the marks leave at. */
  readonly velocity?: number;
  /** Half-angle thrown through, radians. */
  readonly spread?: number;
  /** A mark's length, in body radii. */
  readonly markSize?: number;
  readonly shape?: 'brush-slash' | 'brush-flick';
  readonly bright: PaletteKey;
  readonly mid: PaletteKey;
  readonly deep: PaletteKey;
  readonly priority?: Priority;
  readonly cullDistance?: number;
}

export function brushAfflictionPulse(params: BrushPulseParams): EffectDefinition {
  const marks = Math.max(1, Math.round(params.marks ?? 3));
  const life = Math.max(4, Math.round(params.lifetimeTicks ?? 14));
  const rise = params.rise ?? 0;
  const velocity = params.velocity ?? 45;
  const spread = params.spread ?? 1.1;
  const markSize = params.markSize ?? 0.85;

  return {
    id: params.id,
    // A step above the cling it beats on. A beat that yielded under pressure
    // while its own cling kept running would be an affliction that visibly
    // stopped doing anything, which is worse than one that is not drawn at all.
    priority: params.priority ?? 2,
    cullDistance: params.cullDistance ?? 1200,
    emitters: [
      {
        id: 'beat',
        shape: { kind: 'mesh' },
        emission: { kind: 'burst', count: marks },
        // A tight band rather than a range: the marks of one beat should read as
        // one event, and a spread of lifetimes turns a punctuation mark into a
        // small shower.
        lifetimeTicks: [Math.round(life * 0.82), life],
        speed: [velocity * 0.55, velocity * 1.25],
        spreadRadians: spread,
        drag: 6.5,
        acceleration: { x: 0, y: rise, z: 0 },
        angularVelocity: [-2.2, 2.2],
        // Full size almost at once and holding: a beat has fourteen ticks to be
        // seen and cannot afford to spend four of them growing.
        size: { keys: [[0, markSize * 0.86], [0.18, markSize], [1, markSize * 0.7]] },
        alpha: { keys: [[0, 1], [0.72, 1], [1, 0]] },
        color: { stops: [[0, params.bright], [0.42, params.bright], [0.72, params.mid], [1, params.deep]] },
        render: 'mesh',
        mesh: { shape: params.shape ?? 'brush-flick' },
        blend: 'alpha',
        // The one place in this feature that retracts rather than fizzles, and
        // for the reason spec 161 gives: this is a flick, over in a few ticks,
        // and a retract is what reads as having been thrown.
        strokeDecay: 'retract',
      },
    ],
  };
}

// --- the paint a shot carries with it ----------------------------------------

/**
 * The marks a projectile wears and the ones it leaves behind (spec 218).
 *
 * A **state**, in exactly the register {@link brushAffliction} is one: played
 * once when the shot comes into view, attached to a body that is moving fast,
 * and stopped once when it despawns. `world/shot-vfx.ts` owns both ends, and
 * owes the stop -- nothing in this system stops itself when the body it is
 * attached to goes away.
 *
 * ## `worldSpace`, read both ways, is the whole thing
 *
 * The compiled default is `true` and attaching an effect moves only the
 * emission *origin*, so the same flag says two opposite things depending on
 * which layer it is on:
 *
 * - `worldSpace: false` on the core is **it clings**. A mark born on the ball
 *   and left in world space is a mark the ball is out of within one tick -- at
 *   273 units a second it moves four and a half units between ticks, which is
 *   half its own radius.
 * - `worldSpace: true` on the trail is **it is left behind**. The emitter's
 *   origin follows the shot and the marks do not, which is a trail by
 *   construction, with nothing tracking anything and no ring buffer of where
 *   the thing has been.
 *
 * That second half is why this is a builder here rather than a `Trail` in
 * `world/shot.ts`. The ribbon that streak is made of is a flat strip laid across
 * the ground plane; smoke is not a ribbon.
 *
 * ## Three layers and no new draw calls
 *
 * A batch is keyed `family:blend:sheet:meshShape` (`compile.ts`) and the
 * compiled registry is sitting on exactly 25 against `library.test.ts`'s cap of
 * 25. `mesh:alpha:brush-blot` already exists (the explosion's smoke, and every
 * affliction cling) and so does `mesh:additive:brush-slash` (the explosion's
 * flash), so all three layers here are free. A fourth mark or any other blend
 * would fail that test -- which is the constraint that chose these three, and
 * is worth writing down rather than rediscovering.
 *
 * ## Radii, and the one asymmetry
 *
 * Every length is a multiple of the effect's own scale and the driver plays with
 * `scale` set to the shot's collision radius, so one definition is a fireball at
 * any size. Speed, acceleration and turbulence are **world** units, because
 * `system.ts` multiplies the shape's local coordinates and the size curve by the
 * instance scale and nothing else. That is right rather than an omission: a
 * bigger fireball's smoke does not rise faster. The calibration is
 * `brushAffliction`'s -- 26 is a gentle lift, 62 is "the marks come apart".
 */
export interface BrushShotParams {
  readonly id: string;
  /** Marks held on the ball, per second. The layer that says "burning". */
  readonly core?: number;
  /** Additive marks over them, per second. The layer that says "light". */
  readonly licks?: number;
  /** Marks laid down and left behind, per second. The trail. */
  readonly trail?: number;
  /** Ticks a core mark lives. Short: the ball is renewed, never accumulated. */
  readonly coreLife?: readonly [min: number, max: number];
  /** Ticks a trail mark lives. This is what "short trail" means in numbers. */
  readonly trailLife?: readonly [min: number, max: number];
  /** How wide the ball of marks is, in shot radii. */
  readonly ball?: number;
  /** A core mark's length, in shot radii. */
  readonly coreSize?: number;
  /** A trail mark's length at its widest, in shot radii. */
  readonly trailSize?: number;
  /** How fast a trail mark drifts off the line, **world** units per second. */
  readonly trailSpeed?: number;
  /** **World** units per second squared. Positive rises. */
  readonly trailRise?: number;
  /** How far a trail mark wanders, **world** units per second squared. */
  readonly trailTurbulence?: number;
  /** Palest, at the middle of the ball. */
  readonly hot: PaletteKey;
  /** The body colour, and most of what is on screen. */
  readonly mid: PaletteKey;
  /** Where a mark is going out. */
  readonly deep: PaletteKey;
  /** The trail, born off the fire. */
  readonly trailFrom: PaletteKey;
  /** ...and thinning away. */
  readonly trailTo: PaletteKey;
  readonly priority?: Priority;
  readonly cullDistance?: number;
}

export function brushShot(params: BrushShotParams): EffectDefinition {
  // The fire outnumbers the smoke, and that ordering is the tuning finding this
  // definition cost. Authored the other way round -- more trail marks than core
  // ones, at similar sizes and similar alpha -- the first cut photographed as a
  // swarm of dark specks with a red dab in front of it: legible as *something*
  // and not as a fireball, because against a mid-green field a near-black mark
  // is a hole and an orange one is a highlight, and there were twice as many
  // holes. See `preview-brush-vfx.ts`'s shot sheet.
  const core = Math.max(0, params.core ?? 40);
  const licks = Math.max(0, params.licks ?? 16);
  const trail = Math.max(0, params.trail ?? 42);
  const [coreMin, coreMax] = params.coreLife ?? [8, 14];
  const [trailMin, trailMax] = params.trailLife ?? [10, 15];
  // Tight, and the word is the whole brief. The marks are three times the
  // radius they are born within, so they overlap into one mass rather than
  // sitting beside each other -- born on a wider shell the same count reads as
  // a handful of separate flames orbiting a gap.
  const ball = params.ball ?? 0.34;
  const coreSize = params.coreSize ?? 1.02;
  // Small, and *many*, which is the other half of the tuning finding. Seven big
  // blots behind the ball read as leaves blowing past it; a dozen small ones
  // overlapping read as a wisp.
  const trailSize = params.trailSize ?? 0.5;
  const trailSpeed = Math.max(0, params.trailSpeed ?? 7);
  const trailRise = params.trailRise ?? 16;
  const trailTurbulence = Math.max(0, params.trailTurbulence ?? 26);

  const emitters: Emitter[] = [
    // (a) The ball. Born on a tight shell rather than through the volume, so
    // the marks crowd the outline instead of piling up in the middle -- the
    // silhouette is what a shot is read by at the size it crosses the frame.
    //
    // A trickle of speed, killed at once by the drag, for `brushAffliction`'s
    // stated reason: at exactly zero every mark sits on the point it was born
    // at and the layer reads as a texture rather than as fire being made.
    {
      id: 'core',
      shape: { kind: 'sphere', radius: ball, shell: true },
      emission: { kind: 'rate', perSecond: core },
      lifetimeTicks: [Math.round(coreMin), Math.round(coreMax)],
      speed: [2, 7],
      spreadRadians: 1.6,
      drag: 8,
      angularVelocity: [-2.4, 2.4],
      // Born nearly full, peaking early and ending a little under: a mark that
      // grew over its life would make the ball pulse at the emission rate.
      size: { keys: [[0, coreSize * 0.82], [0.3, coreSize], [1, coreSize * 0.7]] },
      alpha: { keys: [[0, 1], [0.72, 1], [1, 0]] },
      // The flame ramp, whole -- `fireCore` into the body colour into the deep
      // one. This is the one place the *full* ramp is right where an affliction
      // cling deliberately stops at `mid`: a body wearing fire is a stain and
      // has to stay legible against grass, and a fireball is a thing you look
      // *into*, where the dark end is the depth.
      // **Mostly `mid`**, with `hot` as a flash at birth and `deep` as the last
      // sixth. Both ends were tried longer and both are wrong in the same way:
      // a ball that holds the pale cream reads as light rather than as fire,
      // and one that reaches the deep red early reads as an ember going out.
      // What a flame is, at twenty-five pixels, is a saturated orange mass with
      // something brighter inside it.
      color: { stops: [[0, params.hot], [0.12, params.mid], [0.62, params.mid], [1, params.deep]] },
      render: 'mesh',
      mesh: { shape: 'brush-blot' },
      blend: 'alpha',
      strokeDecay: 'fizzle',
      // It clings. See the header.
      worldSpace: false,
    },
    // (b) The licks. Light rather than pigment, and the difference between a
    // ball that is burning and a ball that is orange. Three or four ticks each
    // and `hot` throughout: an additive mark that ramps down to a body colour
    // is a dim additive mark, which is the one thing additive is bad at.
    {
      id: 'licks',
      shape: { kind: 'sphere', radius: ball * 0.7, shell: true },
      emission: { kind: 'rate', perSecond: licks },
      lifetimeTicks: [3, 6],
      speed: [4, 12],
      spreadRadians: 1.6,
      drag: 9,
      angularVelocity: [-3.4, 3.4],
      size: { keys: [[0, coreSize * 0.42], [0.35, coreSize * 0.52], [1, coreSize * 0.28]] },
      alpha: { keys: [[0, 0.8], [0.5, 0.62], [1, 0]] },
      // Hot into the body colour rather than staying hot. Additive near-white on
      // grass blows out to a flat blob, and the licks are the layer *most* able
      // to do that -- they are the only additive marks on the ball.
      color: { stops: [[0, params.hot], [0.5, params.mid], [1, params.mid]] },
      render: 'mesh',
      mesh: { shape: 'brush-slash' },
      blend: 'additive',
      strokeDecay: 'retract',
      worldSpace: false,
    },
    // (c) The trail. World space, which is the same flag as the core's read the
    // other way round -- the origin follows the shot and these do not.
    //
    // The life is the number the phrase "very short trail" turns into: at 273
    // units a second, fifteen ticks is about 68 units of smoke behind a 9-unit
    // ball. Seven shot-radii, and gone.
    {
      id: 'trail',
      shape: { kind: 'sphere', radius: ball * 0.5 },
      emission: { kind: 'rate', perSecond: trail },
      lifetimeTicks: [Math.round(trailMin), Math.round(trailMax)],
      speed: [trailSpeed * 0.3, trailSpeed],
      spreadRadians: 1.5,
      drag: 2.2,
      acceleration: { x: 0, y: trailRise, z: 0 },
      turbulence: { amplitude: trailTurbulence, frequency: 0.05 },
      angularVelocity: [-1.2, 1.2],
      // Grows as it goes, unlike the ball: smoke expands, and a puff that held
      // its size would read as a string of beads rather than as a column coming
      // apart.
      size: { keys: [[0, trailSize * 0.42], [0.45, trailSize], [1, trailSize * 1.15]] },
      // In, hold, out -- the explosion's smoke curve, and never opaque.
      //
      // Fading *in* is what keeps a mark from appearing on top of the fire it
      // was born in: the emitter's origin is the ball, and at 273 units a second
      // the ball is sixteen units clear by the time this reaches its peak. And
      // the peak is a half rather than the explosion's 0.96, because this smoke
      // is *beside* the thing it is meant to sit behind rather than replacing
      // it -- a translucent plume reads as smoke where an opaque one reads as a
      // hole cut in the field.
      alpha: { keys: [[0, 0], [0.3, 0.55], [0.72, 0.45], [1, 0]] },
      // Held at the pale end for over half its life. The trail's job is to be
      // *cooler than the fire and lighter than the field* -- the two things that
      // make it read as smoke rather than as debris -- and only the last dregs,
      // by which point the alpha is already going, drop toward the dark end.
      color: { stops: [[0, params.trailFrom], [0.58, params.trailFrom], [1, params.trailTo]] },
      render: 'mesh',
      mesh: { shape: 'brush-blot' },
      blend: 'alpha',
      // Broken up where it lies, never pulled back to its root: spec 161's
      // rule, and the explosion's smoke keeps it for the same reason -- a blot
      // has no root the eye can point at, so a retract reads as the mass being
      // eaten from one side.
      strokeDecay: 'fizzle',
    },
  ];

  return {
    id: params.id,
    // A step above a cling and below a telegraph. A shot in the air is
    // information -- it is the thing you are being asked to step out of -- so it
    // should not be the first paint dropped under pressure; a telegraph, which
    // says where a blast is about to be, still outranks it.
    priority: params.priority ?? 2,
    cullDistance: params.cullDistance ?? 1600,
    // Until stopped. The driver owns the stop and owes one on despawn.
    durationTicks: 0,
    emitters,
  };
}

// --- the shipped presets -----------------------------------------------------

// --- the Warden's lance ------------------------------------------------------

export interface BrushBeamParams {
  readonly id: string;
  /** How far the lance reaches. The nodes are strung along this. */
  readonly length: number;
  /** The lane's full width -- what the sparks are thrown out of the sides of. */
  readonly width: number;
  /**
   * How wide the *drawn* beam is, which is narrower than the lane it burns.
   *
   * Two widths because there are two layers and they belong to two things. A
   * **spark** comes off the shaft, so it is sized and thrown against the object
   * you can see; a **scorch** lands on the lane, so it is spread across the
   * ground the sim damages. Sizing both off the lane was right while the beam
   * *was* the lane and drew sparks two thirds as wide as the shaft the moment
   * the shaft became a line through the middle of it.
   */
  readonly beamWidth: number;
  /** How many places along the run throw marks. */
  readonly nodes?: number;
  /**
   * How high the beam is where it leaves the machine, and where it lands.
   *
   * The sparks ride the line rather than a constant height, because since the
   * beam became a shaft out of the head it *slopes*: marks at one height would
   * be coming off the air under it near the machine and out of the ground under
   * it at the far end.
   */
  readonly fromHeight: number;
  readonly toHeight: number;
  readonly lifetimeTicks?: number;
  readonly priority?: Priority;
}

/**
 * How high a ground mark is *born*, before it falls onto the real surface.
 *
 * Not where it ends up: the scorch layer carries `collision`, so where it comes
 * to rest is whatever the scene says the ground is under it. This is only far
 * enough above the muzzle's own height that a mark down-range has somewhere to
 * fall from rather than starting inside a rise.
 */
const BEAM_SCORCH_HEIGHT = 14;

/**
 * The sparks a sustained beam throws, and the ground it burns (spec 262).
 *
 * A sibling of {@link brushLane} rather than a use of it, and the difference is
 * the one thing that file already names: *"alternate nodes are pushed to
 * opposite sides of the centre line ... which is the whole difference between a
 * bolt and a laser"*. A bolt zigs and arrives end to end; a lance is **ruled**,
 * so the nodes here sit dead on the centre line and every one of them fires on
 * the same tick. What moves is the sparks coming off it, not the beam.
 *
 * ## Two layers, and each answers half the brief
 *
 * - **`spark_n`** throws small marks out of the *flanks*, alternating side to
 *   side down the run, with gravity on them so they arc and fall. That is the
 *   "specks flying off the beam": it reads as something being *cut*, because
 *   the marks leave the line rather than travelling along it.
 * - **`scorch_n`** is the ground under it: a flat spray of `brush-mark`, the
 *   one brush shape that lies on the ground rather than facing the camera, at
 *   ground height and going nowhere much. That is the impact where the beam
 *   crosses the ground, and being flat is what stops it competing with the
 *   sparks for the same silhouette.
 *
 * ## What it deliberately is not
 *
 * There is no flash, no smoke and no mass. The beam itself is a ground decal in
 * `world/scene.ts` and it is *continuous*; this is played once per damage
 * pulse, four times a second, so anything with weight to it would stack eight
 * deep over one beam and bury the body standing in it. Every mark here is
 * small, short and thrown clear of the lane's own middle -- the player fighting
 * this has to be able to see themselves inside it.
 */
export function brushBeam(params: BrushBeamParams): EffectDefinition {
  const nodes = Math.max(2, Math.round(params.nodes ?? 6));
  const life = Math.max(4, Math.round(params.lifetimeTicks ?? 20));
  const half = params.width * 0.5;
  const beamHalf = params.beamWidth * 0.5;
  const emitters: Emitter[] = [];

  for (let index = 0; index < nodes; index += 1) {
    // Half a step in from each end, so the run is evenly covered and neither the
    // muzzle nor the far tip gets a cluster the rest of the beam does not have.
    const along = (index + 0.5) / nodes;
    const distance = params.length * along;
    // Which flank this node sprays from. Alternating rather than drawn, for
    // `brushLane`'s reason one function up: a side picked per node at random is
    // a wobble, and a wobble reads as an effect that could not decide.
    const flank = index % 2 === 0 ? 1 : -1;

    emitters.push({
      id: `spark_${index}`,
      // On the beam, which slopes: the cue is played at the machine's feet, so
      // this is a height above them and the line runs from the head's opening
      // down to just off the ground at the far end.
      offset: {
        x: distance,
        y: params.fromHeight + (params.toHeight - params.fromHeight) * along,
        z: 0,
      },
      // Thrown **sideways**, out of the lane, at about a third of its
      // half-width. `bearing` is in the effect's own frame and the effect's
      // rotation turns it, so one definition serves every aim.
      shape: {
        kind: 'fan',
        angle: 0.8,
        radius: beamHalf * 0.7,
        rise: 0.5,
        bearing: (flank * Math.PI) / 2,
      },
      // Every node on the same tick: a laser does not arrive, it is already
      // there. `brushLane`'s staggered delay is what makes a bolt travel, and
      // it is exactly wrong here.
      emission: { kind: 'burst', count: 2 },
      lifetimeTicks: [Math.round(life * 0.55), life],
      speed: [46, 118],
      spreadRadians: 0.5,
      // They fall. The one thing that makes a spark a spark rather than a mote,
      // and the reason this layer is not simply `brushAfflictionPulse` aimed
      // sideways -- that one hangs.
      gravity: -300,
      drag: 2.4,
      angularVelocity: [-3.4, 3.4],
      // In **world units**, like `brushLane`'s and unlike the affliction
      // builders', and getting that wrong is the whole reason the first cut
      // could not be seen. `brushAffliction` authors sizes near 1 because it is
      // played with `scale` set to a body's radius; this is played by
      // `addEffect` at `scale: 1`, so a number authored on the affliction's
      // scale is a mark a fifteenth of the size it was meant to be.
      //
      // About half the shaft, and against the *shaft* rather than the lane. A
      // spark has to be a speck coming off the beam -- the mark is not the
      // weapon -- and `brushLane`'s 0.78 of its own width is right for a bolt
      // that fills its lane and would be a hedge here.
      size: { keys: [[0, beamHalf * 0.6], [0.25, beamHalf * 0.8], [1, beamHalf * 0.5]] },
      alpha: { keys: [[0, 1], [0.6, 1], [1, 0]] },
      // Hot to ember, which is the ramp `sparkHot`/`sparkWarm`/`sparkEmber`
      // exists for. Not the fire ramp: a spark struck off something is metal
      // and grit, and `fireCore`'s cream would make the lance look like it was
      // spraying flame rather than cutting.
      // Ends on a **red** rather than on `sparkEmber`'s 0x8a3418, which is a
      // dark brown: over this game's grass that is a hole in the picture rather
      // than a cooling spark, which is `brushFire`'s own finding about additive
      // embers arrived at from the other direction.
      color: { stops: [[0, 'sparkHot'], [0.28, 'sparkWarm'], [1, 'fireDeep']] },
      render: 'mesh',
      mesh: { shape: 'brush-flick' },
      blend: 'alpha',
      strokeDecay: 'retract',
    });

    emitters.push({
      id: `scorch_${index}`,
      offset: { x: distance, y: BEAM_SCORCH_HEIGHT, z: 0 },
      // Radial in the ground plane, which is what a circle is -- so the spray
      // goes out across the ground from where the beam is standing on it
      // rather than along the beam.
      shape: { kind: 'circle', radius: half * 0.22 },
      emission: { kind: 'burst', count: 3 },
      lifetimeTicks: [Math.round(life * 0.7), Math.round(life * 1.3)],
      speed: [18, 54],
      // **It settles on the real ground**, and this is the one part of this
      // effect that could not be authored as a position.
      //
      // The cue is played at the *muzzle* -- `landArea` sends a lane's effect
      // at the caster's feet -- and these marks are offset up to six hundred
      // units down its local +X. An offset is a position in the effect's frame
      // and the frame is flat, so on any slope a mark six hundred units away is
      // as far off the ground as the ground has moved: floating over a valley,
      // buried in a rise. `collision` is what closes it, because the system
      // asks the *scene* for the height under each particle -- so a mark born
      // inside a hill is clamped onto its surface on its first tick and one
      // born over a dip falls until it lands.
      //
      // `restitution: 0` with one bounce allowed is "come to rest": it settles,
      // `resting` is set, and it lies there for the rest of its life rather
      // than being integrated through the ground or bouncing a scorch mark.
      collision: { restitution: 0, friction: 1, maxBounces: 1 },
      // Enough to bring it down through the height it is born at, and nowhere
      // near enough to read as a thrown thing: what falls here is the mark's
      // first tick, not its arc.
      gravity: -240,
      // Heavy drag: these are marks *on* the ground, so they skid outward and
      // stop rather than travelling.
      drag: 9,
      angularVelocity: [-1.6, 1.6],
      // Broader than a spark and flatter, which is what separates the two
      // layers at a glance: one is grit leaving the beam and one is the ground
      // taking it.
      size: { keys: [[0, half * 0.4], [0.2, half * 0.6], [1, half * 0.44]] },
      alpha: { keys: [[0, 0.95], [0.55, 0.9], [1, 0]] },
      color: { stops: [[0, 'fireAmber'], [0.35, 'fireBody'], [1, 'fireDeep']] },
      render: 'mesh',
      // The one brush shape that lies flat on the ground, which is what makes
      // this read as scorch under the beam rather than as more sparks.
      mesh: { shape: 'brush-mark' },
      blend: 'alpha',
      // `fizzle`, not `retract`: this is a mark left *on* something, and spec
      // 161's rule is that a retract played on one reads as the stroke being
      // un-painted rather than as it burning out.
      strokeDecay: 'fizzle',
    });
  }

  return {
    id: params.id,
    // Two, beside `brushLane` and the affliction beat. The *information* half of
    // this weapon is the ground decal in `world/scene.ts`, which is a mesh and
    // is never subject to the instance budget at all -- so a crowded fight that
    // drops these sparks still draws the beam and still says where not to
    // stand, which is what priority 3 exists to protect.
    priority: params.priority ?? 2,
    // Long, because the effect's origin is the *muzzle* and the paint runs six
    // hundred units away from it: culled on the origin at a shorter distance,
    // a beam whose far end is on screen would draw nothing at all.
    cullDistance: 1800,
    emitters,
  };
}

/** The nominal radius `explosion_brush` is authored at, for the scale maths. */
/**
 * A fire that stands somewhere and keeps burning (spec 250).
 *
 * Every other painted fire in this file is an *event*: a shot crossing the frame,
 * an explosion, a body that caught. This one is a **place** -- it is what a
 * campfire prop is made of, now that the prop itself is stones and charred
 * timber and nothing that moves. So it is the first brush effect authored to be
 * watched rather than glanced at, and the two things that follow from that are
 * the whole of its shape.
 *
 * **It has to loop invisibly.** A one-shot can put everything on screen at once
 * and let the eye fill in the rest; a fire that did would pulse at its own
 * emission rate. So the three layers run at unrelated rates over unrelated
 * lifetimes -- flames a third of a second, embers a second and a half, smoke
 * two and a bit -- and nothing in it is phased off anything else.
 *
 * **It has to read at a glance and cost nothing at distance.** A campfire is a
 * landmark: what says "there is a fire there" from across the arena is the light
 * the fixture throws, not the paint, so this is `priority: 1` -- the first thing
 * to yield when the instance pool is under pressure -- and culls well inside the
 * light's own reach. The prop and its pool of light stay when this goes.
 *
 * ## The three layers
 *
 * **Flames** rise on an updraft and die young. Marks rather than a cone, which
 * is the point of replacing the geometry: a solid can only ever be a picture of
 * one instant of a fire.
 *
 * **Embers** are the layer with real **gravity** on them, and the only one. They
 * are thrown up out of the flame and fall back, which is the single most legible
 * thing a fire does -- an arc is a shape the eye reads as heat rising off
 * something without having to be told. Everything else here rises steadily and
 * would look like smoke whatever colour it was painted.
 *
 * **Smoke** is born above the flame rather than in it, drifts, spreads and goes
 * dark. Few, and that is `brushShot`'s tuning finding rather than taste: against
 * a mid-green field a near-black mark is a hole and an orange one is a
 * highlight, so a fire with as much smoke as flame photographs as a swarm of
 * specks with a fire behind it.
 *
 * Sizes are in **fire radii** -- the effect is played with `scale` set to the
 * fire's own reach -- so one definition is a campfire at 26 and a brazier at 12.
 * Speeds, accelerations and gravity are **not** scaled, for the reason
 * `affliction-vfx.ts` gives about its own: gravity is gravity.
 */
export interface BrushFireParams {
  readonly id: string;
  /** Flame marks a second. */
  readonly flames?: number;
  /** Ember marks a second. Few: an arc is punctuation. */
  readonly embers?: number;
  /** Smoke marks a second. Fewer still. See the header. */
  readonly smoke?: number;
  /** How wide the flame is born, in fire radii. */
  readonly base?: number;
  /** A flame mark's length, in fire radii. */
  readonly flameSize?: number;
  /** A smoke mark's length, in fire radii. */
  readonly smokeSize?: number;
  /** World units a second squared, up, inside the flame. */
  readonly updraft?: number;
  /**
   * How tall this fire is: a multiplier on every world-unit velocity in it.
   *
   * The one thing `scale` cannot do. Playing an effect at a scale multiplies a
   * mark's size and where it is born and deliberately **not** how fast it is
   * thrown -- which is right for a blast, whose whole shape is a velocity, and
   * wrong for a fire, which is a column of a certain height. A torch played at
   * a third of a campfire's scale is three-unit marks climbing the campfire's
   * fifty units: a thin spray, not a small fire.
   *
   * It multiplies the speeds, the updraft, the ember gravity and the turbulence
   * together, and that scales every *distance* in the effect while leaving
   * every *duration* alone: an ember's apex is `v^2 / 2g`, so `k^2 / k = k`,
   * where its time to apex is `v / g` and does not move. So a small fire flickers
   * at the same rate as a large one, which is what keeps the two the same fire.
   */
  readonly reach?: number;
  /** How high the smoke is born above the ground, in fire radii. */
  readonly smokeLift?: number;
  readonly hot?: PaletteKey;
  readonly mid?: PaletteKey;
  readonly deep?: PaletteKey;
  readonly priority?: Priority;
  readonly cullDistance?: number;
}

export function brushFire(params: BrushFireParams): EffectDefinition {
  const flames = Math.max(0, params.flames ?? 26);
  const embers = Math.max(0, params.embers ?? 9);
  // Few, and fewer than the first cut's five. Photographed through
  // `preview-brush-vfx.ts` the smoke was the biggest thing in the tile and the
  // flame a smear under it -- `brushShot`'s finding exactly, one effect along:
  // against a mid-green field a grey mark is a hole and an orange one is a
  // highlight, so equal counts read as smoke with a fire somewhere in it.
  const smoke = Math.max(0, params.smoke ?? 3.5);
  const base = Math.max(0.01, params.base ?? 0.5);
  const flameSize = params.flameSize ?? 0.5;
  const smokeSize = params.smokeSize ?? 0.62;
  const reach = Math.max(0, params.reach ?? 1);
  const updraft = (params.updraft ?? 120) * reach;
  const smokeLift = params.smokeLift ?? 1.6;
  /** A world-unit velocity, at this fire's height. */
  const up = (units: number): number => units * reach;
  const hot = params.hot ?? 'fireCore';
  const mid = params.mid ?? 'fireBody';
  const deep = params.deep ?? 'fireDeep';

  const emitters: Emitter[] = [
    // (a) The flame. Born across the ember bed rather than at a point, so the
    // fire has a *width* at its foot and tapers upward on its own -- a cone
    // emitter would give it a shape decided by an angle rather than by where the
    // logs are.
    {
      id: 'flame',
      shape: { kind: 'circle', radius: base },
      emission: { kind: 'rate', perSecond: flames },
      // Short. A flame is not a thing that travels, it is a thing that is
      // replaced -- and a long-lived mark drifting upward is smoke.
      //
      // Long enough to *be* a column, though, which is the tuning the preview
      // paid for: at the first cut's [15, 26] and 26-46 units a second a mark
      // rose about eighteen units and the marks were fifteen long, so the
      // "column" was one mark tall and read as a puddle of fire. It climbs
      // about fifty now, against a ring of stones thirty across.
      lifetimeTicks: [24, 38],
      speed: [up(40), up(66)],
      // Narrow, so the column stands up. The width comes from the disc it is
      // born on and the turbulence, not from throwing marks sideways.
      spreadRadians: 0.3,
      // The heat. It is what makes the top of the flame move faster than the
      // bottom, which is the difference between fire and a fountain.
      acceleration: { x: 0, y: updraft, z: 0 },
      turbulence: { amplitude: up(26), frequency: 0.055 },
      drag: 1.1,
      angularVelocity: [-2.2, 2.2],
      // Widest low and thinning as it climbs: a flame tapers.
      size: { keys: [[0, flameSize * 0.7], [0.25, flameSize], [1, flameSize * 0.42]] },
      alpha: { keys: [[0, 1], [0.66, 1], [1, 0]] },
      // Pale at the root and deep at the tip, which is the way round a fire
      // actually is and the opposite of what an ember does. The full ramp,
      // unlike an affliction's cling: this is a thing you look *into*, so the
      // dark end is depth rather than mud.
      color: { stops: [[0, hot], [0.3, mid], [1, deep]] },
      render: 'mesh',
      mesh: { shape: 'brush-blot' },
      blend: 'alpha',
      strokeDecay: 'fizzle',
    },
    // (b) The embers. **The layer with gravity on it**, and the only one.
    //
    // Thrown up out of the middle and falling back, which is the shape the eye
    // reads as heat coming off something. `brush-flick` because it takes
    // `cardVelocity` and so always faces the camera and points along its own
    // path: an ember is read by its streak, and one that turned edge-on at the
    // top of its arc would vanish exactly where it is most legible.
    {
      id: 'embers',
      shape: { kind: 'circle', radius: base * 0.55 },
      emission: { kind: 'rate', perSecond: embers },
      lifetimeTicks: [45, 100],
      speed: [up(80), up(150)],
      spreadRadians: 0.5,
      // The arc. Gentle for its speed, so an ember hangs at the top rather than
      // snapping over: at 150 up this apexes about eighty units above the logs,
      // which is well past the flame and is what carries the fire's real height.
      gravity: up(-140),
      drag: 0.5,
      turbulence: { amplitude: up(22), frequency: 0.07 },
      angularVelocity: [-4, 4],
      size: { keys: [[0, 0.26], [0.3, 0.2], [1, 0.09]] },
      // Held, then out: an ember goes out rather than fading, so the alpha
      // stays flat for most of its life and drops at the end.
      alpha: { keys: [[0, 1], [0.7, 0.95], [1, 0]] },
      color: { stops: [[0, hot], [0.25, 'emberGlow'], [1, deep]] },
      render: 'mesh',
      mesh: { shape: 'brush-flick' },
      // **Alpha, not additive**, and the preview is what settled it. An ember is
      // *light*, which is the argument for additive and is the one this file
      // makes for a shot's licks -- but a lick is inside a fireball and an ember
      // is over open ground, and additive over this game's grass is not a warm
      // spark, it is a yellow-green speck. Photographed both ways at the same
      // seed: `brush-shot.png`.
      //
      // It also costs nothing. `brush-flick` in alpha is a batch this table
      // already has, where the additive pair was a twenty-sixth draw call for
      // the whole registry -- so the version that reads better is also the one
      // that does not move a ceiling.
      blend: 'alpha',
      strokeDecay: 'retract',
    },
    // (c) The smoke. Born above the flame, not in it -- smoke that starts at the
    // logs is a fire with a grey core.
    {
      id: 'smoke',
      shape: { kind: 'circle', radius: base * 0.8 },
      offset: { x: 0, y: smokeLift, z: 0 },
      emission: { kind: 'rate', perSecond: smoke },
      lifetimeTicks: [80, 150],
      speed: [up(12), up(26)],
      spreadRadians: 0.55,
      // A third of the flame's. Smoke rises because it is hot, and it stops
      // being hot -- a column that kept accelerating would leave the frame.
      acceleration: { x: 0, y: updraft * 0.3, z: 0 },
      turbulence: { amplitude: up(38), frequency: 0.03 },
      drag: 0.8,
      angularVelocity: [-1.1, 1.1],
      // The only layer that grows. Smoke spreads as it cools, and it is what
      // gives the column a shape that widens where the flame narrows.
      size: { keys: [[0, smokeSize * 0.5], [0.5, smokeSize], [1, smokeSize * 1.5]] },
      // Never fully opaque, and the low start is the point: smoke coming off a
      // fire is thin at its root and thickens as it gathers. Thinner than the
      // first cut at both ends -- see the count above for what the preview said
      // about grey marks on grass.
      alpha: { keys: [[0, 0.3], [0.4, 0.55], [1, 0]] },
      color: { stops: [[0, 'smokeDark'], [0.25, 'smokeLight'], [1, 'smokeLight']] },
      render: 'mesh',
      mesh: { shape: 'brush-blot' },
      blend: 'alpha',
      strokeDecay: 'fizzle',
    },
  ];

  return {
    id: params.id,
    // Ambient, in the sense the type's own comment means: what tells a player
    // there is a fire there is the *light*, which is a fixture and not this. So
    // this is the first thing to yield under instance pressure and the fight in
    // front of you is the last -- the same call `brushAffliction` makes.
    priority: params.priority ?? 1,
    // Well inside the light's own reach. Paint at the far edge of a 420-unit
    // pool is a few pixels; the glow on the ground is what carries that far, and
    // it costs nothing per particle.
    cullDistance: params.cullDistance ?? 1100,
    // Until stopped. The driver owns the stop and owes one when the ground the
    // fire stands on stops being drawn.
    durationTicks: 0,
    emitters,
  };
}

export const BRUSH_EXPLOSION_RADIUS = 60;

/**
 * How wide the ember shot's impact burst is, in world units (spec 218).
 *
 * The radius it is **authored at and drawn at**, which since spec 218 are the
 * same statement: `scene.addEffect` plays an authored effect at scale 1, so a
 * number here is a length on screen rather than an input to a conversion. That
 * matters more than it sounds -- `scale` multiplies a mark's size and *not* its
 * speed, so an explosion played at anything but 1 is marks of one size thrown at
 * another size's velocity, which is a scatter rather than a burst.
 *
 * 34 against a 9-unit shot, and against a player's 16-unit radius: about two
 * bodies across. Small, which is the request, and the same number
 * `explosion_brush_small` is authored at -- so the burst is the vocabulary's own
 * small blast rather than a shrunk large one, which is the distinction
 * `brushExplosionRequest` picks presets by and for the same reason.
 */
export const EMBER_BURST_RADIUS = 34;

/** Below this intensity a hit plays the light mark, above it the loud one. */
export const HEAVY_HIT_INTENSITY = 1.35;

/**
 * How long the dominant mark of an ordinary hit is, in world units (spec 219).
 *
 * A stroke's authored size *is* its length (`stroke.ts` builds the spine over a
 * unit span), and `bloodHit` gives the primary `scale * 3.1` -- so this number
 * times three is the whole gesture, and every other length in the effect is a
 * fraction of it. That is what makes it the one knob worth naming: `velocity` is
 * `scale * 7`, the fan radii are fractions of `scale`, and the medium marks and
 * the dabs are `1.62` and `0.42` of it.
 *
 * Spec 159 authored it at 26, which puts an ordinary swing's mark at **80 units**
 * against a body of ten units' radius -- four body-widths of paint, laid across
 * the target and out the far side, for every blow anybody lands. At 17 the
 * gesture is 53 units: a mark *on* the target rather than one draped over it,
 * and 40% of the painted area.
 *
 * The floor under it was **measured rather than judged**, and it is the one
 * thing about this number that is not taste. `preview-brush-vfx.ts`
 * photographs the same hit from six camera bearings and requires the thinnest
 * to keep 40% of the fattest one's ink -- a mark seen edge-on narrows, and one
 * that disappears from a seat is a blow the player in that seat cannot read.
 * That ratio is scale-dependent in a way the *composition* is not: a pixel
 * counts as ink only once it differs from the ground by a fixed amount, so
 * shrinking the mark does not thin the edge-on view proportionally, it deletes
 * the part of it that was already marginal. Measured: 26 keeps 57%, 20 keeps
 * 53%, 17 keeps 46%, and 15 keeps **36%** and fails -- taking the
 * seed-variation check with it, for the same reason one level down. So this is
 * as small as the mark goes while still reading from every angle, and the run
 * that says so is the sheet beside it.
 */
export const BLOOD_HIT_SCALE = 17;

/**
 * How much bigger a killing blow's mark is (spec 159's 36 against 26).
 *
 * Derived rather than authored a second time, because *"the same language read
 * louder"* is the rule the whole hit vocabulary is built on and two independent
 * numbers are how a family drifts apart: shrink one and the other silently
 * becomes a different effect rather than a louder one.
 */
export const HEAVY_HIT_SCALE = 1.4;

export const BRUSH_EFFECTS: readonly EffectDefinition[] = [
  // The blow that lands, and the blow that finishes. The same language read
  // louder -- more marks, thrown further, held a little longer -- never a
  // different one, which is the rule the whole hit vocabulary is authored to.
  bloodHit({ id: 'blood_hit_brush', scale: BLOOD_HIT_SCALE }),
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
    scale: Math.round(BLOOD_HIT_SCALE * HEAVY_HIT_SCALE),
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
  /**
   * The ember shot's landing (spec 218), and the painted explosion's first
   * caller in the game.
   *
   * Reached by the seam the server has had since spec 062 and no other: a
   * projectile's direct hit pushes `{ effectId: `${ability.id}.impact` }`, and
   * `scene.addEffect` plays it because the registry now knows the id. Nothing
   * was added to the wire and nothing was added to a call site, which is the
   * acceptance criterion `world/vfx-wire.ts` states for the whole arc.
   *
   * **`smoke: 0`, and that is the request read literally.** `debris` stays,
   * because the transitional layer is burnt orange going to brown drawn *among*
   * the fire -- it is what makes a painted explosion painted rather than a
   * radial star -- and with the smoke gone there is no `paintSoot` anywhere in
   * the picture, which is the only place soot appears.
   *
   * **No `light`, and that is a finding rather than a preference.** A light's
   * radius is written straight into the light buffer (`system.ts`) and is the
   * one authored length the instance scale does not touch, so a lit preset is a
   * light sized for whatever radius it happened to be authored at. The three
   * lit presets above are played by nothing, so nothing has ever noticed.
   *
   * Short: 34 ticks against `explosion_brush_small`'s 62. A basic attack lands
   * about once a second, and a burst that is still unfolding when the next one
   * arrives is two bursts nobody can tell apart.
   */
  brushExplosion({
    id: 'ranged.ember.impact',
    radius: EMBER_BURST_RADIUS,
    radialCount: 8,
    debris: 2,
    smoke: 0,
    lifetimeTicks: 34,
  }),

  /**
   * The ember shot in flight (spec 218).
   *
   * Named for the *look* rather than for the ability, because `SHOT_ART` keys on
   * `ProjectileLook` -- two rows throwing the same-looking shot are one picture,
   * the way two abilities firing an arrow already are.
   */
  brushShot({
    id: 'shot_ember',
    // The flame ramp whole, which `palette.ts` calls right for "a thing you look
    // into" -- and a fireball is one, where a *burning body* is not, which is
    // why `affliction_burn` settles on `fireAmber` instead and this does not.
    hot: 'fireCore',
    mid: 'fireBody',
    deep: 'fireDeep',
    // Pale grey, going dark only at the very end. Two earlier choices are worth
    // recording because each failed in its own way and neither was obvious from
    // the numbers -- both scored clean on stipple and on connectedness, and both
    // looked wrong. `smokeDark` (0x3c3733) is not a dark mass against grass, it
    // is a *hole*, and a dozen holes read as a swarm of flies. `paintBurnt` into
    // `smokeLight` fixed the value and broke the hue: a warm brown behind an
    // orange ball reads as leaves blowing past it, because nothing separates the
    // trail from the fire. Cool and light does both.
    trailFrom: 'smokeLight',
    trailTo: 'smokeDark',
  }),
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

  // --- the afflictions (spec 215) --------------------------------------------
  //
  // Seven states rather than seven effects, and the numbers below are the seven
  // characters `data/damage-over-time.ts` authored, read back out as paint. What
  // separates them at a glance is `rise` -- fire is the only one that goes up,
  // and everything that rots goes down -- and after that it is *rate*: Burn is
  // the loudest thing here because it is the shortest and hardest, Decay the
  // quietest because it is the slowest, and Shock is almost silent between its
  // beats on purpose, because "it arrives in jolts" is a statement about the
  // gaps as much as about the jolts.
  //
  // A `_heavy` exists only for the rows that can *get worse* -- the three that
  // stack, and Frostbite, which ramps instead. There is no `_heavy` for Burn or
  // Shock, because there is no state of a body in this game where either is
  // worse than it already is.

  // Burn: the most damage a second in the table and the shortest life, and the
  // only one whose shed *streaks* rather than dripping or drifting.
  //
  // It lifts hardest by a distance -- nearly three times Poison's bubbles, the
  // only other row that goes up at all -- and that gap is what keeps the two
  // apart at a glance: fire is thrown off a body and rot floats off it.
  //
  // Its ramp settles on `fireAmber` rather than `fireBody`, which is the
  // difference between a burning body reading as yellow-into-orange and reading
  // as orange-into-red. The flame effects keep the old ramp; a body on fire is
  // a different subject from a fire, and the thing you want to see on it is the
  // heat rather than the embers.
  // The campfire's fire (spec 250). One row, because everything about how a
  // standing fire is built is in `brushFire`.
  brushFire({ id: 'fire_camp' }),
  // The standing torch's (spec 263), which is that sentence collected: the same
  // three layers, fewer of each, thrown a fraction as far.
  //
  // `reach` is the half spec 250 left out when it said a lit torch was "a second
  // row at a smaller `scale` and nothing else". A scale shrinks a mark and where
  // it is born and not how fast it is thrown, so the row that is *only* a scale
  // is a handful of three-unit marks climbing fifty units out of a bowl -- a
  // pilot light with a spray over it. At 0.42 the flame stands about twenty
  // units above the rim and the embers apex about thirty-five, which is a torch
  // against a body a little over twice that tall.
  //
  // The counts come down with it and by more than the height does. A fire's
  // density is marks per unit of column, so keeping a campfire's twenty-six over
  // two fifths of the height is a solid orange lozenge rather than a flame with
  // gaps you can see the pole through -- and the gaps are the whole of why this
  // is paint. The smoke is two a second: a torch smokes, and a torch that smoked
  // like a bonfire would read as one that is going out.
  brushFire({
    id: 'fire_torch',
    flames: 15,
    embers: 3,
    smoke: 2,
    reach: 0.42,
    // Both down from the campfire's, and both because a short column has
    // nowhere to put its smoke. Born at 1.2 radii rather than 1.6 it leaves the
    // flame's own tip rather than a gap above it, and at 0.52 it is no longer
    // the widest thing in the effect -- photographed at 0.62 the grey marks
    // outweighed the orange ones, which is `brushShot`'s finding about grey on
    // grass and reads as a torch going out rather than one burning.
    smokeSize: 0.52,
    smokeLift: 1.2,
    // Shorter than the campfire's, in the same proportion its light is: what
    // carries a torch to the edge of the frame is the pool it throws, and paint
    // at the far side of a 300-unit reach is a pixel.
    cullDistance: 800,
  }),
  brushAffliction({
    id: 'affliction_burn',
    cling: 22,
    shed: 10,
    rise: 72,
    turbulence: 40,
    shedSpeed: 22,
    clingSize: 0.6,
    clingLife: [16, 26],
    shedLife: [22, 38],
    shedSize: 0.36,
    shedShape: 'brush-flick',
    bright: 'fireCore',
    mid: 'fireAmber',
    deep: 'fireDeep',
  }),
  // Bleed: red, and it falls hard. The heaviest `rise` in the table by
  // magnitude, because a drip that hesitates is not a drip -- and the shortest
  // shed life, since blood is off the body and gone rather than hanging about.
  brushAffliction({
    id: 'affliction_bleed',
    cling: 15,
    shed: 7,
    rise: -260,
    turbulence: 5,
    shedSpeed: 9,
    clingSize: 0.55,
    shedSize: 0.3,
    shedLife: [18, 30],
    bright: 'bloodBright',
    mid: 'bloodFresh',
    deep: 'bloodInk',
  }),
  brushAffliction({
    id: 'affliction_bleed_heavy',
    cling: 28,
    shed: 12,
    rise: -270,
    turbulence: 6,
    shedSpeed: 11,
    clingSize: 0.66,
    shedSize: 0.34,
    shedLife: [18, 32],
    bright: 'bloodBright',
    mid: 'bloodFresh',
    deep: 'bloodInk',
  }),
  // Poison: the weakest rate and the longest life, and the numbers say so. One
  // stack is meant to be *barely worth noticing*, so this is the quietest cling
  // of the seven and the one that changes most when it stacks.
  //
  // It is also the one affliction whose character is in the **shed** rather than
  // in the coat: bubbles, rising off the body and wobbling as they go. That is
  // the only row here with a positive `rise` besides Burn, and the two are not
  // confusable, because fire's lift is four times as hard and its marks streak
  // where these drift. Everything a bubble needs is already in the vocabulary --
  // a small round `brush-dab`, a slow upward push, and enough turbulence that
  // they do not rise in a column -- so nothing about the shape language moves.
  //
  // The coat is deliberately thinner than it was to pay for it. A body that is
  // both coated *and* fizzing reads as two afflictions.
  brushAffliction({
    id: 'affliction_poison',
    cling: 8,
    shed: 9,
    rise: 26,
    turbulence: 22,
    shedShape: 'brush-blot',
    shedSpeed: 5,
    shedSize: 0.26,
    clingSize: 0.5,
    clingLife: [26, 40],
    shedLife: [40, 64],
    bright: 'poisonPale',
    // The cling settles on `mid`, so `mid` is the colour Poison *is* rather
    // than the bottom of its ramp. Leaf green here read as mud on a body at
    // this size, and it put Poison and Corrosion within a shade of each other
    // at the one moment they most need telling apart -- the pale green against
    // Corrosion's saturated chartreuse is the difference that survives the
    // quantizer.
    mid: 'poisonPale',
    deep: 'poisonDeep',
  }),
  brushAffliction({
    id: 'affliction_poison_heavy',
    cling: 16,
    shed: 20,
    rise: 30,
    turbulence: 26,
    shedShape: 'brush-blot',
    shedSpeed: 6,
    shedSize: 0.3,
    clingSize: 0.6,
    clingLife: [28, 44],
    shedLife: [42, 68],
    bright: 'poisonPale',
    // The cling settles on `mid`, so `mid` is the colour Poison *is* rather
    // than the bottom of its ramp. Leaf green here read as mud on a body at
    // this size, and it put Poison and Corrosion within a shade of each other
    // at the one moment they most need telling apart -- the pale green against
    // Corrosion's saturated chartreuse is the difference that survives the
    // quantizer.
    mid: 'poisonPale',
    deep: 'poisonDeep',
  }),
  // Corrosion: acid, and the one that is visibly *doing something to the
  // surface*. The first cut authored it as **pitting** rather than a coat --
  // small marks, renewed twice as fast as anything else -- on the argument that
  // what it eats through is the guard and the armour. The contact sheet said no:
  // it came out at a third of Frostbite's ink and was the one row of the seven
  // you had to look for. Small and fast is *detail*, and this vocabulary's whole
  // rule is silhouette over detail at three hundred pixels tall. It keeps the
  // fast renewal, which is where the sense of something being eaten away comes
  // from, and the marks are the size of everybody else's.
  brushAffliction({
    id: 'affliction_corrosion',
    cling: 17,
    shed: 8,
    rise: -110,
    turbulence: 24,
    shedSpeed: 13,
    clingSize: 0.62,
    clingLife: [18, 30],
    shedLife: [24, 40],
    bright: 'corrodeBright',
    mid: 'corrodeBody',
    deep: 'corrodeDeep',
  }),
  brushAffliction({
    id: 'affliction_corrosion_heavy',
    cling: 32,
    shed: 14,
    rise: -120,
    turbulence: 30,
    shedSpeed: 15,
    clingSize: 0.7,
    clingLife: [18, 32],
    shedLife: [24, 42],
    bright: 'corrodeBright',
    mid: 'corrodeBody',
    deep: 'corrodeDeep',
  }),
  // Shock: almost nothing between the beats, which is the whole design. High
  // turbulence so the little that is there jitters rather than sits, and the
  // loudest pulse in the table to land on top of it. An affliction that
  // "arrives in jolts" has to be *quiet* in between or the jolts are not
  // arrivals.
  brushAffliction({
    id: 'affliction_shock',
    // The highest rate in the table over the shortest life, which is not the
    // contradiction it looks like: what is alive at any instant is about ten
    // marks, the joint fewest of the seven, and each of them lasts an eighth of
    // a second. That is the difference between *thin* and *flickering*, and
    // flickering is what a body between jolts should be doing.
    //
    // The first cut was four a second, which works out at under one live mark --
    // a body between jolts drawn as a body with nothing on it at all. That is
    // not quiet, it is a missing effect. Quiet has to be something you can watch
    // being quiet.
    cling: 30,
    shed: 9,
    rise: 18,
    turbulence: 66,
    shedSpeed: 20,
    clingSize: 0.54,
    clingLife: [8, 16],
    shedLife: [12, 22],
    shedSize: 0.3,
    shedShape: 'brush-flick',
    bright: 'boltFlash',
    mid: 'boltPale',
    deep: 'boltArc',
  }),
  // Frostbite: the one that accumulates. Nothing here moves -- the slowest shed,
  // the least turbulence and the longest-lived cling marks in the table, so what
  // is on the body stays on the body and builds up. `_heavy` is not "more
  // stacks" for this one but *more time*: its ramp is the design, and the tier
  // crosses on how long it has been carried.
  // Sized back into the band its siblings occupy (spec 236).
  //
  // At `clingSize: 0.66` this was the *largest base* in the table -- bigger than
  // poison's, bleed's and corrosion's **heavy** tiers -- and its heavy at 0.82
  // was far above everything. So a body carrying frostbite read as carrying more
  // affliction than a body carrying any other, which is a claim about severity
  // that no rule here is making.
  //
  // What is **not** changed is that its tier crosses on *elapsed* rather than on
  // stacks. That looks like escalation because it is: frostbite is the only row
  // in `data/damage-over-time.ts` with a real ramp (`rampPerSecond: 0.35`,
  // `rampCap: 3`), so it genuinely triples over its life and the paint saying so
  // is the row's whole design (spec 215). The complaint was the size, and only
  // the size.
  brushAffliction({
    id: 'affliction_frostbite',
    cling: 15,
    shed: 3,
    rise: -10,
    turbulence: 3,
    shedSpeed: 4,
    // Between shock's 0.54 and burn's 0.6, where a one-stack affliction belongs.
    clingSize: 0.58,
    clingLife: [34, 52],
    shedLife: [30, 46],
    shedSize: 0.26,
    bright: 'iceWhite',
    mid: 'icePale',
    deep: 'iceDeep',
  }),
  brushAffliction({
    id: 'affliction_frostbite_heavy',
    // Bleed's jump exactly (15 -> 28). It was 34, which is a bigger step up than
    // any other heavy tier takes and on top of a base that was already the
    // widest.
    cling: 28,
    shed: 5,
    rise: -9,
    turbulence: 4,
    shedSpeed: 5,
    // Between bleed's 0.66 and corrosion's 0.7.
    clingSize: 0.68,
    clingLife: [40, 62],
    shedLife: [30, 48],
    shedSize: 0.3,
    bright: 'iceWhite',
    mid: 'icePale',
    deep: 'iceDeep',
  }),
  // Decay: the lowest damage in the table by design, and what it costs you is
  // not the health it takes. So this is the slowest thing here -- long marks,
  // long lives, a drift barely distinguishable from stillness -- and the only
  // desaturated ramp, because Decay is colour draining rather than colour
  // landing.
  brushAffliction({
    id: 'affliction_decay',
    cling: 11,
    shed: 5,
    rise: -28,
    turbulence: 9,
    shedSpeed: 6,
    clingSize: 0.68,
    clingLife: [40, 62],
    shedLife: [44, 70],
    shedSize: 0.32,
    bright: 'decayBright',
    mid: 'decayBody',
    deep: 'decayDeep',
  }),

  // --- the beats -------------------------------------------------------------
  //
  // One per affliction, played on the tick its pulse actually resolves. The
  // shapes are the character: a lick, a spurt, a bloom, a spit, a crack, a
  // crust, a sag.
  brushAfflictionPulse({
    id: 'affliction_burn_pulse',
    marks: 4,
    lifetimeTicks: 13,
    rise: 300,
    velocity: 55,
    spread: 0.9,
    markSize: 0.95,
    bright: 'fireCore',
    mid: 'fireAmber',
    deep: 'fireDeep',
  }),
  brushAfflictionPulse({
    id: 'affliction_bleed_pulse',
    marks: 3,
    lifetimeTicks: 12,
    rise: -380,
    velocity: 75,
    spread: 1,
    markSize: 0.9,
    bright: 'bloodBright',
    mid: 'bloodFresh',
    deep: 'bloodInk',
  }),
  brushAfflictionPulse({
    id: 'affliction_poison_pulse',
    marks: 6,
    lifetimeTicks: 20,
    rise: 60,
    velocity: 22,
    spread: 1.35,
    markSize: 0.6,
    bright: 'poisonPale',
    mid: 'poisonDeep',
    deep: 'poisonMurk',
  }),
  brushAfflictionPulse({
    id: 'affliction_corrosion_pulse',
    marks: 4,
    lifetimeTicks: 15,
    rise: -180,
    velocity: 48,
    spread: 1.15,
    markSize: 0.8,
    bright: 'corrodeBright',
    mid: 'corrodeBody',
    deep: 'corrodeDeep',
  }),
  // The loudest of the seven and the shortest. Slashes rather than flicks, at
  // twice anything else's speed and a third of its life: a jolt has eight ticks
  // to be a jolt, and what it is competing with is its own near-silent cling.
  brushAfflictionPulse({
    id: 'affliction_shock_pulse',
    marks: 5,
    // Ten rather than eight. Still by some way the shortest beat in the table --
    // the next is a third longer again -- but eight ticks is 133ms, which is
    // four frames at 30fps and fewer than that on a frame that stutters. A jolt
    // should be brief; it should not be missable.
    lifetimeTicks: 10,
    rise: 40,
    velocity: 130,
    spread: 1.45,
    markSize: 1.25,
    shape: 'brush-slash',
    bright: 'boltFlash',
    mid: 'boltPale',
    deep: 'boltArc',
  }),
  // Slashes for the opposite reason: not speed but *edge*. Cold is the one
  // affliction whose mark should look like it has a straight side, so this is a
  // slash held almost still for twenty-two ticks -- a crust forming rather than
  // anything thrown.
  brushAfflictionPulse({
    id: 'affliction_frostbite_pulse',
    marks: 5,
    lifetimeTicks: 22,
    rise: -12,
    velocity: 12,
    spread: 1.4,
    markSize: 0.72,
    shape: 'brush-slash',
    bright: 'iceWhite',
    mid: 'icePale',
    deep: 'iceDeep',
  }),
  brushAfflictionPulse({
    id: 'affliction_decay_pulse',
    marks: 3,
    lifetimeTicks: 26,
    rise: -40,
    velocity: 15,
    spread: 1.2,
    markSize: 0.85,
    bright: 'decayBright',
    mid: 'decayBody',
    deep: 'decayDeep',
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
