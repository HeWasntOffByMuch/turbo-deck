/**
 * How high a placed mark has to sit so it never goes into the ground (spec 175).
 *
 * Pure -- the heightfield is injected and there is no clock in it -- and it is
 * its own file rather than three lines in `scene.ts` for the reason spec 153
 * gives about every indicator that was ever laid on this terrain: getting it
 * wrong is invisible on the flat ground a change is checked on, and obvious only
 * on the hillside somebody plays on later. A sweep of gradients against a sweep
 * of camera pitches is a test; a click on a slope is a bug report.
 *
 * ## The two halves
 *
 * The mark is a card in the **view** plane, so how far it hangs below its own
 * origin is decided by the camera and not by the terrain -- {@link markLift}.
 * What it hangs over is decided by the terrain and not by the camera --
 * {@link markClearance}. Neither can answer the other's half, which is why they
 * are two functions and not one.
 */

import type { HeightAt } from './ground-decal.js';

/**
 * How many points around the mark are asked about the ground.
 *
 * Eight and the centre. The mark is a disc of radius `reach` seen from above, so
 * what could rise into it is the ground anywhere inside that disc -- and a ring
 * plus the middle is the same shape `projectDecal` already samples per vertex,
 * at a spacing (about three quarters of `reach` between neighbours at 40 units)
 * comfortably inside the heightfield's own 22-unit cells.
 */
export const CLEARANCE_SAMPLES = 8;

/**
 * A hair of daylight between the mark and the ground it clears.
 *
 * The same two units the flat wavefront was laid at before this spec, kept for
 * the same reason: coincident surfaces at a grazing angle are where z-fighting
 * lives, and this camera looks along a very grazing angle indeed.
 */
export const MARK_MARGIN = 2;

/**
 * The **highest** ground within `reach` of a point.
 *
 * The highest, not the ground at the middle. What a mark clips is the ground
 * beside it: a click at the foot of a bank has perfectly ordinary ground under
 * its own centre and a wall of it a few units away, and a clearance measured at
 * the centre would put half the cross inside the bank.
 */
export function markClearance(x: number, z: number, reach: number, heightAt: HeightAt): number {
  let high = heightAt(x, z);
  const radius = Math.max(0, reach);
  if (radius === 0) return high;
  for (let i = 0; i < CLEARANCE_SAMPLES; i++) {
    const angle = (i / CLEARANCE_SAMPLES) * Math.PI * 2;
    const here = heightAt(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
    if (here > high) high = here;
  }
  return high;
}

/**
 * How far above that ground the mark's origin goes, given where the camera is.
 *
 * `cameraUpY` is the y component of the camera's own up vector, which is what
 * the card's plane is built from in the mesh shader -- so this is the same
 * quantity the GPU uses rather than an approximation of it. A point of the card
 * sits at `a` along camera right and `b` along camera up, and camera right has
 * no y in it at all because this camera never rolls; so the point's height is
 * `b * cameraUpY` exactly, and no point of the card has a `b` beyond `reach`.
 *
 * It falls out of that bound that the mark lies down as the camera does: the
 * pitch slider reaches 85 degrees, where `cameraUpY` is 0.09 and the cross sits
 * all but on the ground it is marking, and 10 degrees, where the card is nearly
 * upright and the whole reach is owed.
 */
export function markLift(reach: number, cameraUpY: number, margin = MARK_MARGIN): number {
  return Math.max(0, reach) * Math.min(1, Math.abs(cameraUpY)) + margin;
}

/**
 * Where a mark's origin goes: the ground it has to clear, plus how far it hangs.
 *
 * One length answering two questions -- how wide a patch of ground is asked
 * about, and how far the mark hangs below its own origin. They are not the same
 * question and a bounding radius is only *safe* for the second rather than
 * exact, which is fine here and would not be for a bigger mark: the over-lift is
 * five percent of the drop at the cross's authored rolls, measured in
 * `brush.test.ts` rather than assumed here.
 */
export function markOriginY(
  x: number,
  z: number,
  reach: number,
  cameraUpY: number,
  heightAt: HeightAt,
): number {
  return markClearance(x, z, reach, heightAt) + markLift(reach, cameraUpY);
}
