/**
 * What a pivot does to a body's extremities (spec 139).
 *
 * The sim turns a body by yawing it about the point the server put it on:
 * `scene.ts` sets `group.rotation.y = -facing` on a group whose origin is that
 * point, and that is the whole of the drawn turn. So anything the pose holds out
 * away from that origin travels on a circle, and how violent a turn looks is a
 * property of two numbers that live nowhere near each other -- the turn rate in
 * `CHARACTERS`, and how far the pose reaches.
 *
 * The pig is the case that made this worth naming. Its run clip pitches the
 * torso 36 degrees forward, which puts the snout 28 units in front of a pivot
 * that a 16-unit collider is centred on, and at the rate a fresh character was
 * turning at the extremities swept at 2.20x the speed the animal can run. Every
 * number in that sentence was individually defensible.
 *
 * This module is the arithmetic of that, and nothing else: hand it a lever arm
 * and a turn rate and it says what the point does. Pure, dependency-free and
 * tested headlessly, so the relationship is checked by `npm test` even though
 * measuring a real body needs a loader, a skinned mesh and a probe script
 * (`scripts/probe-turn-swing.ts`).
 */

const DEG = Math.PI / 180;

/**
 * How fast a body's extremities may travel, as a multiple of its own move speed.
 *
 * A ratio rather than a constant so it survives a re-tune of either number, and
 * expressed against the body's *own* speed because that is the comparison a
 * player is actually making: a snout that crosses the screen faster than the
 * animal can run does not read as a turn, it reads as a glitch.
 *
 * Two, because twice is a line somebody can defend and 1.72 is not. The pig's
 * run pose sits at 1.72 with the turn rate spec 139 set, and sat at 2.20 with
 * the one it replaced -- so this gate is what that change did, held in place,
 * and it sits between the two with room on both sides rather than hugging
 * whichever number happens to be current.
 *
 * The 0.28 of headroom left is worth reading rather than banking: the run pose is
 * the closest to the line because its pivot sits 6.3 units behind the body's own
 * centre, and recentring it -- deliberately out of scope in 139 -- is what would
 * buy real margin here.
 */
export const MAX_SWEEP_RATIO = 2;

/** A turn of half a circle: the reversal that reads worst. */
export const REVERSAL_DEGREES = 180;

/** What one pose of one body holds out away from the pivot. */
export interface PoseReach {
  readonly clipId: string;
  /** The furthest any drawn vertex gets from the pivot, in world units. */
  readonly reach: number;
  /** The body's own XZ centre relative to the pivot, in world units. */
  readonly centre: { readonly x: number; readonly z: number };
}

/** How that pose behaves when the body turns. */
export interface PoseSweep extends PoseReach {
  /** Tangential speed of the furthest point, in world units per second. */
  readonly speed: number;
  /** As a multiple of the body's own move speed. */
  readonly ratio: number;
  /** How far the furthest point is displaced by a reversal, in world units. */
  readonly reversal: number;
  /** How far the pivot sits from the body's own centre, in world units. */
  readonly offset: number;
  readonly withinBudget: boolean;
}

/**
 * The speed a point `reach` from the pivot travels at, while the body turns.
 *
 * `omega * r`, with the rate converted once. Negative or non-finite inputs
 * answer zero rather than propagating: this is a measurement, and a probe that
 * reported `NaN` as a pass would be worse than one that reported nothing.
 */
export function sweepSpeed(reach: number, degreesPerSecond: number): number {
  if (!Number.isFinite(reach) || !Number.isFinite(degreesPerSecond)) return 0;
  if (reach <= 0) return 0;
  return reach * Math.abs(degreesPerSecond) * DEG;
}

/**
 * How far a point `reach` from the pivot is *displaced* by a turn of `degrees`.
 *
 * The chord, `2r sin(theta/2)`, not the arc. The arc is how far the point
 * travels and the chord is how far it ends up from where it started, and it is
 * the chord that reads as a swing -- a body that comes all the way round and
 * back has moved nothing, however much distance its snout covered.
 *
 * Beyond half a circle the chord shortens again, which is correct and worth
 * knowing: the worst reversal is exactly 180 degrees.
 */
export function sweepDisplacement(reach: number, degrees: number): number {
  if (!Number.isFinite(reach) || !Number.isFinite(degrees)) return 0;
  if (reach <= 0) return 0;
  const swept = Math.min(Math.abs(degrees), 360);
  return 2 * reach * Math.abs(Math.sin((swept * DEG) / 2));
}

/** How long a turn of `degrees` takes, at a rate in degrees per second. */
export function turnSeconds(degrees: number, degreesPerSecond: number): number {
  const rate = Math.abs(degreesPerSecond);
  if (!Number.isFinite(rate) || rate <= 0) return Infinity;
  if (!Number.isFinite(degrees)) return 0;
  return Math.abs(degrees) / rate;
}

/**
 * Everything a pose's reach implies, against the body that is wearing it.
 *
 * `moveSpeed` is what the ratio is measured against, so a body with no speed at
 * all -- a training dummy, a prop -- is reported as within budget whatever it
 * reaches. It cannot travel, so nothing about it can look fast.
 */
export function sweepOf(
  pose: PoseReach,
  degreesPerSecond: number,
  moveSpeed: number,
): PoseSweep {
  const speed = sweepSpeed(pose.reach, degreesPerSecond);
  const ratio = Number.isFinite(moveSpeed) && moveSpeed > 0 ? speed / moveSpeed : 0;
  return {
    ...pose,
    speed,
    ratio,
    reversal: sweepDisplacement(pose.reach, REVERSAL_DEGREES),
    offset: Math.hypot(pose.centre.x, pose.centre.z),
    withinBudget: ratio <= MAX_SWEEP_RATIO,
  };
}

/** The pose that swings worst, which is the one worth reporting on. */
export function widestSweep(sweeps: readonly PoseSweep[]): PoseSweep | null {
  let worst: PoseSweep | null = null;
  for (const sweep of sweeps) {
    if (worst === null || sweep.ratio > worst.ratio) worst = sweep;
  }
  return worst;
}
