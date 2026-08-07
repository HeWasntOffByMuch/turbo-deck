/**
 * What an arrow and a shuriken are shaped like (spec 087).
 *
 * Pure -- no three.js, no DOM -- for the same reason `lobe.ts` is: at the size
 * a shot crosses the frame at, the silhouette is the entire difference between
 * "an arrow went past" and "a dot went past", and a silhouette that carries
 * that much should be checkable in Node rather than by squinting at a frame.
 * What lives here is where the vertices go; `scene.ts` turns that into buffers.
 *
 * Both shapes are derived from the one number the sim knows about a shot -- its
 * `projectile.radius` -- so a bigger shot is the same shot bigger rather than a
 * differently proportioned one, and a row added to the ability table gets a
 * sensible arrow without anybody drawing it.
 */

export interface ShapePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * An arrow, along its own length, nose at +x.
 *
 * Three pieces because that is what reads at this size: a head wide enough to
 * see which way it is pointing, a shaft thin enough that the head is what you
 * see, and fletching to stop the tail dissolving into the background. The
 * proportions are an arrow's real ones flattened -- a real arrow is far too
 * thin to survive being six pixels long.
 */
export interface ArrowProfile {
  readonly shaftLength: number;
  readonly shaftRadius: number;
  readonly headLength: number;
  readonly headRadius: number;
  readonly fletchLength: number;
  /** How far the fletching stands off the shaft, each side. */
  readonly fletchSpan: number;
  /**
   * Nose-to-nock length: what the whole thing occupies along its flight.
   */
  readonly length: number;
  /**
   * How far back from the nose the arrow's midpoint sits.
   *
   * The sim moves a *point*, and the mesh has to be hung off that point rather
   * than off its own nose, or the arrow arrives a body-length before the hit
   * does.
   */
  readonly centreOffset: number;
}

/**
 * How large the drawn arrow is against the proportions below (spec 088).
 *
 * The arrow was drawn at about seven times its collision radius -- longer than
 * a player is wide -- which read as a javelin crossing the screen rather than
 * as an arrow. This is the counterpart of {@link SHURIKEN_DRAW_SCALE}, which
 * exists for the opposite reason: the two thrown weapons are at opposite ends
 * of what survives being drawn at life size.
 */
export const ARROW_DRAW_SCALE = 0.3;

/** An arrow sized for a shot of this radius. */
export function arrowProfile(radius: number): ArrowProfile {
  // Floored so a radius the table forgot, or a zero, still yields an arrow
  // rather than a degenerate mesh that renders as nothing.
  const given = Number.isFinite(radius) && radius > 0 ? radius : 1;
  const r = given * ARROW_DRAW_SCALE;

  const headLength = r * 2.2;
  const headRadius = r * 0.95;
  const shaftLength = r * 5.4;
  const shaftRadius = r * 0.26;
  const fletchLength = r * 1.6;
  const fletchSpan = r * 0.85;
  const length = headLength + shaftLength;

  return {
    shaftLength,
    shaftRadius,
    headLength,
    headRadius,
    fletchLength,
    fletchSpan,
    length,
    centreOffset: length / 2,
  };
}

/** Points on a shuriken's star. */
export const SHURIKEN_POINTS = 4;

/** How far in the valleys between the points come, as a fraction of the tips. */
export const SHURIKEN_WAIST = 0.42;

/**
 * How much larger the drawn plate is than the shot's collision radius.
 *
 * A star at life size is a genuinely small object -- six world units against a
 * player's sixteen -- and at the distance the camera sits it disappears. The
 * arrow gets away with a life-size thickness because it is *long*; the star has
 * only its width, so it is drawn generously.
 *
 * This is the one place a projectile's drawn extent and its hit radius part
 * company on purpose, and it is a look: `projectileHits` is unaffected, and
 * what stops a star is still the six units the server flew.
 */
export const SHURIKEN_DRAW_SCALE = 1.9;

/** The radius to draw the plate at, for a shot of this collision radius. */
export function shurikenDrawRadius(radius: number): number {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 1;
  return r * SHURIKEN_DRAW_SCALE;
}

/**
 * The closed outline of a shuriken, in its own plane, centred on the origin.
 *
 * `2 * points` vertices alternating outer and inner radius, starting at the
 * outer vertex on +x. The inner radius is a *fraction* of the outer rather than
 * its own number, so the star keeps its bite at every size: a fixed inner
 * radius turns a small shuriken into a square and a large one into a caltrop.
 */
export function shurikenOutline(radius: number, points: number = SHURIKEN_POINTS): ShapePoint[] {
  const outer = Number.isFinite(radius) && radius > 0 ? radius : 1;
  const count = Number.isFinite(points) && points >= 3 ? Math.floor(points) : SHURIKEN_POINTS;
  const inner = outer * SHURIKEN_WAIST;

  const out: ShapePoint[] = [];
  for (let i = 0; i < count * 2; i++) {
    // Even indices are the tips, odd ones the valleys between them.
    const r = i % 2 === 0 ? outer : inner;
    const angle = (Math.PI * i) / count;
    out.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }
  return out;
}

/** How thick the plate is, so it catches a highlight edge-on rather than vanishing. */
export function shurikenThickness(radius: number): number {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 1;
  return r * 0.16;
}

/**
 * Turns of a shuriken per second in flight.
 *
 * Fast enough to read as thrown, slow enough that the four points do not
 * strobe into a disc at 60Hz -- a full turn is four points past the eye, so
 * this is about 30 tips a second.
 */
export const SHURIKEN_SPIN_TURNS_PER_SECOND = 7.5;
