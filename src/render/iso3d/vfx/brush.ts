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

  const emitters: Emitter[] = [
    // (a) THE mark. One. It carries the direction and most of the visual mass,
    // and every other layer here exists to keep it company.
    {
      id: 'primary',
      shape: { kind: 'fan', angle: aimed * 0.28, radius: s * 0.04, rise: 0.12 },
      emission: { kind: 'burst', count: Math.max(1, params.strokes ?? 1) },
      lifetimeTicks: [Math.round(life * 0.46), Math.round(life * 0.6)],
      speed: [velocity * 0.9, velocity * 1.3],
      spreadRadians: aimed * 0.14,
      gravity: gravity * 0.14,
      drag,
      velocityScale: { keys: [[0, 1], [0.3, 0.16], [1, 0.04]] },
      // Nearly flat: the *shape* extends and retracts (spec 159), so a size curve
      // that also swung about would be two animations fighting.
      size: { keys: [[0, primary * 0.92 * narrow], [0.35, primary * narrow], [1, primary * 0.94 * narrow]] },
      // Opaque while it matters. Overlapping translucent marks make a third
      // colour at every crossing that is in neither of them, which is the
      // watercolour look this is not; and the fade at the end is short because
      // the geometry is already retracting by then.
      alpha: { keys: [[0, 1], [0.86, 1], [1, 0]] },
      color: { stops: [[0, bright], [0.55, bright], [0.8, mid], [1, deep]] },
      render: 'mesh',
      mesh: { shape: 'brush-slash' },
      blend: 'alpha',
    },
    // (b) The medium marks: within about 35 degrees of the bearing, so they
    // reinforce the gesture instead of arguing with it.
    {
      id: 'secondary',
      shape: { kind: 'fan', angle: scattered, radius: s * 0.1, rise: 0.28 },
      emission: { kind: 'burst', count: params.splashes ?? 3 },
      lifetimeTicks: [Math.round(life * 0.55), Math.round(life * 0.78)],
      speed: [velocity * 0.55, velocity * 1.35],
      spreadRadians: scattered * 0.2,
      // Light. These are aimed marks and their direction is the information they
      // carry; enough gravity to turn one mid-flight makes it a vertical mark
      // that says nothing about where the blow came from.
      gravity: gravity * 0.2,
      drag: drag * 0.8,
      velocityScale: { keys: [[0, 1], [0.35, 0.2], [1, 0.05]] },
      size: { keys: [[0, s * 1.5], [0.4, s * 1.62], [1, s * 1.44]] },
      alpha: { keys: [[0, 1], [0.84, 1], [1, 0]] },
      color: { stops: [[0, bright], [0.5, mid], [1, deep]] },
      render: 'mesh',
      mesh: { shape: 'brush-flick' },
      blend: 'alpha',
    },
    // (c) The dabs. Chunky, dark, tumbling in *world* space rather than held to
    // the camera -- which is where this effect's sense of depth comes from, and
    // which only works because a brush mesh is a shallow shell rather than a
    // plane (`stroke.ts`).
    {
      id: 'fragments',
      shape: { kind: 'fan', angle: loose, radius: s * 0.14, rise: 0.42 },
      emission: { kind: 'burst', count: params.droplets ?? 5 },
      lifetimeTicks: [Math.round(life * 0.68), life],
      speed: [velocity * 0.3, velocity * 0.95],
      spreadRadians: loose * 0.35,
      gravity,
      drag: drag * 0.35,
      angularVelocity: [-4, 4],
      velocityScale: { keys: [[0, 1], [0.4, 0.4], [1, 0.18]] },
      size: { keys: [[0, s * 0.34], [0.3, s * 0.42], [1, s * 0.36]] },
      alpha: { keys: [[0, 1], [0.8, 1], [1, 0]] },
      color: { stops: [[0, bright], [0.5, mid], [0.85, deep], [1, ink]] },
      render: 'mesh',
      mesh: { shape: 'brush-dab' },
      blend: 'alpha',
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
  /** Ticks the longest-lived mark lasts. The effect's whole duration. */
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
      emission: { kind: 'burst', count: smoke, delayTicks: 16 },
      offset: { x: 0, y: r * 0.3, z: 0 },
      lifetimeTicks: [Math.round(life * 0.5), Math.round(life * 0.84)],
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
