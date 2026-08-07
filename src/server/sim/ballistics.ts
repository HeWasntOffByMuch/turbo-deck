/**
 * The shape of a thrown thing's path (spec 089).
 *
 * Pure arithmetic, no state, no clock -- part of the deterministic core, and
 * headlessly tested, because an arc is the kind of thing that looks plausible
 * in motion while being quietly wrong at both ends.
 *
 * ## Why the angle comes from the distance
 *
 * A shot leaving at speed `v` under gravity `g` covers `v²·sin(2θ)/g`. That is
 * maximised at `θ = 45°`, where it reaches `Rmax = v²/g`. Anything nearer than
 * `Rmax` can be reached by two angles -- one shallow, one steep -- and a
 * shooter takes the shallow one, because the steep one is a mortar and arrives
 * via the sky. So:
 *
 *     sin(2θ) = d / Rmax                    θ = ½·asin(d / Rmax)
 *     peak    = Rmax/4 · (1 − √(1 − (d/Rmax)²))
 *
 * The consequences are the whole feature. At maximum range the angle is exactly
 * 45° and the peak exactly `Rmax/4`. Near in, `peak ≈ d²/(8·Rmax)` -- quadratic,
 * so a point-blank shot is *flat*, which a fixed arc height can never be: 110
 * units of arc over 40 units of ground is an 84-degree launch.
 *
 * ## What is deliberately not modelled
 *
 * The travel is at constant horizontal speed (see `world.ts`), so this is the
 * ballistic *shape* rather than a ballistic simulation: a real arrow slows as it
 * climbs. Modelling that would change when a shot arrives, and when a shot
 * arrives is a mechanic (spec 079) rather than a look.
 */

/** The steepest a shot ever leaves at: the range-maximising angle. */
export const MAX_LAUNCH_ANGLE = Math.PI / 4;

/** Any of the inputs, made safe. A shot with no reach is a flat one. */
function reach(distance: number, maxRange: number): number {
  if (!Number.isFinite(distance) || !Number.isFinite(maxRange)) return 0;
  if (maxRange <= 0 || distance <= 0) return 0;
  // Past the weapon's own maximum there is no shallower solution left: the shot
  // is already leaving at 45 and simply falls short. Clamped rather than run
  // through a negative square root.
  return Math.min(1, distance / maxRange);
}

/** `arc` held to the 0..1 it means: a fraction of the optimal arc. */
function fraction(arc: number): number {
  if (!Number.isFinite(arc) || arc <= 0) return 0;
  return Math.min(1, arc);
}

/**
 * Peak height above the straight line from launch to target, in world units.
 *
 * `maxRange` is the ability's own range: the farthest it may be aimed is by
 * definition the farthest it can throw, so a weapon states one number and not
 * two that have to be kept agreeing.
 */
export function ballisticPeak(distance: number, maxRange: number, arc: number): number {
  const share = fraction(arc);
  if (share === 0) return 0;
  const u = reach(distance, maxRange);
  if (u === 0) return 0;
  return share * (maxRange / 4) * (1 - Math.sqrt(1 - u * u));
}

/**
 * The angle the shot leaves at, in radians.
 *
 * A symmetric parabola of height `h` over a span `d` leaves at `atan(4h/d)`:
 * `y = 4h·t·(1−t)` has slope `4h/d` at `t = 0`. So this is `ballisticPeak`
 * read back as the thing it is, which is what makes "45 degrees at maximum
 * range" a statement a test can check rather than a claim in a comment.
 */
export function launchAngle(distance: number, maxRange: number, arc: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 0;
  const peak = ballisticPeak(distance, maxRange, arc);
  if (peak <= 0) return 0;
  return Math.atan((4 * peak) / distance);
}

/**
 * Height above the launch-to-target line at a point in the flight (spec 079).
 *
 * A parabola peaking at the midpoint. Pure, and identical on client and server,
 * so the client's interpolation between 20Hz deltas draws the arc the server
 * flew rather than a second one that happens to look similar.
 */
export function arcHeightAt(progress: number, peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return 0;
  const t = Math.min(1, Math.max(0, progress));
  return 4 * peak * t * (1 - t);
}

/**
 * Where a shot is, vertically, at a point in its flight (spec 089).
 *
 * The chord from launch to target, plus the arc over it. **Terrain between the
 * two ends is not an input, and cannot be**: that is the whole point of this
 * signature. Before it, height was the heightfield under the shot plus a bump,
 * so an arrow crossing a dip dived into the dip -- the ground was steering
 * something that had already left the bow.
 */
export function shotHeightAt(
  progress: number,
  launchZ: number,
  targetZ: number,
  peak: number,
): number {
  const t = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  const from = Number.isFinite(launchZ) ? launchZ : 0;
  const to = Number.isFinite(targetZ) ? targetZ : from;
  return from + (to - from) * t + arcHeightAt(t, peak);
}

/**
 * How far off the ground a shot leaves, and how far off it arrives.
 *
 * A shot that starts and finishes at ankle height cannot read as an arc however
 * right the curve is, and the flat ones ploughed the dirt -- which is why spec
 * 087's shuriken trace had to be lifted clear of the ground it was skimming.
 * Roughly a hand at one end and a body's middle at the other.
 */
export const SHOT_LAUNCH_HEIGHT = 26;
export const SHOT_IMPACT_HEIGHT = 18;
