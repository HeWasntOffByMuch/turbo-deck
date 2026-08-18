/**
 * How high a placed mark has to sit so it never goes into the ground (spec 175).
 *
 * Pure -- the heightfield is injected and there is no clock in it -- and it is
 * its own file rather than three lines in `scene.ts` for the reason spec 153
 * gives about every indicator that was ever laid on this terrain: getting it
 * wrong is invisible on the flat ground a change is checked on, and obvious only
 * on the hillside somebody plays on later. A sweep over every gradient the map
 * has is a test; a click on a slope is a bug report.
 *
 * ## Why there is no camera in here
 *
 * Because the mark is **flat**. `ORIENT.ground` lays it in the world's XZ plane
 * with a stroke's arch bulging along world up, and a stroke's arch is never
 * negative -- so no part of the mark is below its own origin, from any seat in
 * the room, and the whole question collapses to "how high is the ground under
 * it". An upright card would need a second length for how far it hangs below
 * itself and a camera vector to scale that by; a mark painted on the floor needs
 * neither, which is most of the argument for painting it on the floor.
 */

import type { HeightAt } from './ground-decal.js';

/**
 * How many points around the mark are asked about the ground.
 *
 * Eight and the centre. The mark is a disc of radius `reach` seen from above, so
 * what could rise into it is the ground anywhere inside that disc -- and a ring
 * plus the middle is the same shape `projectDecal` already samples per vertex.
 * Neighbours on the ring are `2r sin(pi/8)` apart, which at the order cross's
 * 21-unit reach is sixteen units and inside the heightfield's own 22-unit cells:
 * there is no ground feature between two samples that is not also sampled.
 */
export const CLEARANCE_SAMPLES = 8;

/**
 * A hair of daylight between the mark and the ground it clears.
 *
 * The same two units the wavefront this replaces was laid at, kept for the same
 * reason: coincident surfaces at a grazing angle are where z-fighting lives, and
 * this camera looks along a very grazing angle indeed.
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
 * Where a flat mark's origin goes: over the highest ground it covers, by a hair.
 *
 * The whole placement, and it is one addition because the mark is horizontal. A
 * plane at `max(ground) + margin` is at or above every point of ground beneath
 * it *by construction* -- there is no gradient term, no sampling fudge and
 * nothing to be right about between the samples, which is the one property spec
 * 153's draped decals cannot have and pay for with a per-vertex projection.
 *
 * What it costs is the other side of the same coin: on a hillside the mark is on
 * the ground at its uphill edge and floating over the downhill one, by however
 * far the ground fell across it. For a mark this size that is a couple of units
 * on anything walkable and only becomes visible on the steepest faces of the
 * map, which is the trade a click confirmation is worth and a range indicator is
 * not.
 */
export function markOriginY(x: number, z: number, reach: number, heightAt: HeightAt): number {
  return markClearance(x, z, reach, heightAt) + MARK_MARGIN;
}
