import { MAX_CLIMB_SLOPE, MAX_WALK_SLOPE, SLOPE_BASELINE } from './constants.js';

/**
 * How steep the ground is at a point (spec 227).
 *
 * The one description of "too steep to stand on", so movement, the router and
 * the editor's overlay cannot answer it differently. Before this there were
 * four numbers claiming to be it -- 0.45, 0.55, 0.6, 0.8 -- two of them under
 * comments asserting agreement with a constant they did not equal, and the only
 * one a designer could see reached nothing at all.
 *
 * **It has to be a fixed baseline, and that is provable rather than a
 * preference.** A stair is flat treads with short steep risers between them:
 * measured over `maps/arena`'s own baked stair, a riser is a gradient of 2.64
 * -- 69 degrees -- over about eight units, while the flight as a whole is 0.6.
 * A smooth 69-degree hillside is 2.64 everywhere. From a single (rise, run)
 * pair over one tick's step the two are indistinguishable, and no allowance
 * separates them at every speed: at 155 units a second a threshold has to sit
 * between 2.7 and 10.5 to tell them apart, and at a grazer's 40 it has to sit
 * between 0.6 and 2.7. Those ranges do not overlap. So the measurement spans a
 * fixed distance or it is not a measurement of the ground.
 *
 * **The gentler side of each axis, not the average of the two.** A plateau's
 * rim is a crease, and `ground-decal.ts` already names why sampling cannot see
 * one: *"a fold is a line and five points can straddle a line"*. A central
 * difference across a rim reports the average of flat ground and a cliff, so a
 * body on a perfectly level plateau would be refused a body's width short of
 * its own edge -- an invisible wall, on flat ground, for a drop it was never
 * going to be allowed to step off anyway. The minimum asks instead whether
 * there is gentle ground on *some* side, which is what standing somewhere
 * actually needs, and it still refuses a sustained slope, where both sides are
 * steep by construction.
 *
 * What it deliberately does not do is refuse a *jump*. That is
 * `MAX_STEP_HEIGHT`'s job, on the step rather than on the ground, and it is why
 * a stair riser and a tier edge are both still decided exactly as they were.
 */

/** The three bands ground falls in. Ordered, so a comparison is meaningful. */
export const GroundGrade = { Walk: 0, Climb: 1, Cliff: 2 } as const;
export type GroundGradeValue = (typeof GroundGrade)[keyof typeof GroundGrade];

/** Which band a gradient is in. */
export function gradeOfSlope(slope: number): GroundGradeValue {
  if (slope > MAX_CLIMB_SLOPE) return GroundGrade.Cliff;
  return slope > MAX_WALK_SLOPE ? GroundGrade.Climb : GroundGrade.Walk;
}

/**
 * The gradient from a centre height and its four neighbours at `baseline`.
 *
 * Split out from the samplers so the terrain-backed and grid-backed callers
 * share the arithmetic rather than each having a copy of the min-of-two rule.
 * `xBaseline` and `yBaseline` are separate because a grid samples at whole
 * cells and cannot always offset by exactly the baseline.
 */
export function slopeFrom(
  centre: number,
  west: number,
  east: number,
  north: number,
  south: number,
  xBaseline: number,
  yBaseline: number,
): number {
  const gx = Math.min(Math.abs(centre - west), Math.abs(east - centre)) / xBaseline;
  const gy = Math.min(Math.abs(centre - north), Math.abs(south - centre)) / yBaseline;
  return Math.hypot(gx, gy);
}

/** The gradient of the ground at a world point, off a height sampler. */
export function groundSlopeAt(
  x: number,
  y: number,
  centre: number,
  heightAt: (x: number, y: number) => number,
  baseline: number = SLOPE_BASELINE,
): number {
  return slopeFrom(
    centre,
    heightAt(x - baseline, y),
    heightAt(x + baseline, y),
    heightAt(x, y - baseline),
    heightAt(x, y + baseline),
    baseline,
    baseline,
  );
}
