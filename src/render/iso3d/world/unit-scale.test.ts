import { describe, expect, it } from 'vitest';
import skeletonDoc from '../../../../assets/units/biped.skeleton.json' with { type: 'json' };
import { CRITTERS } from '../../critters/index.js';
import { validateSkeleton } from '../../../units/validate.js';
import { PLAYER_CRITTER, PLAYER_FIGURE } from './appearance.js';

/**
 * The one number that ties an authored unit to the world it stands in (spec
 * 107).
 *
 * `canonicalHeight` in `biped.skeleton.json` is what every generated mesh is
 * scaled against. A generated rig arrives around one or two units tall and a
 * body in this world is around fifty-six, so the import scale is a factor of
 * thirty or more -- which makes this the single most likely way the first
 * imported unit shows up invisible or the size of a hill.
 *
 * So it is not a constant somebody typed. It is *the height the renderer already
 * draws a player at*, and this test is what stops the two from drifting apart:
 * retune `PLAYER_FIGURE.bodyScale` or swap the player's species and this fails
 * here, in Node, rather than in a screenshot of a unit standing waist-deep in
 * the ground.
 */
describe('the biped skeleton canonical height', () => {
  it('is the height the play view actually draws a player at', () => {
    const species = CRITTERS[PLAYER_CRITTER];
    // The scene's own top-of-head expression, from `WorldScene.syncBodies`
    // where it positions the health bar: the metrics are what the skeleton is
    // built from, so this is the height rather than a measurement of it.
    const drawnHeight = (species.metrics.headY + species.metrics.headRadius) * PLAYER_FIGURE.bodyScale;
    expect(skeletonDoc.canonicalHeight).toBeCloseTo(drawnHeight, 6);
  });

  it('is in world units, not metres', () => {
    // A guard against somebody "fixing" this to 1.8 after reading a mixamo doc.
    // A terrain chunk is 616 units across and a player body is a few dozen.
    expect(skeletonDoc.canonicalHeight).toBeGreaterThan(10);
    expect(skeletonDoc.canonicalHeight).toBeLessThan(200);
  });

  it('describes a rig facing the way every other rig in the scene faces', () => {
    // Every rig in `src/render/iso3d/` is built facing +x with up +y, and the
    // scene drives all of them with the same `group.rotation.y = -facing`. An
    // imported unit that disagrees would be the only thing in the world walking
    // sideways.
    expect(skeletonDoc.upAxis).toBe('+Y');
    expect(skeletonDoc.forwardAxis).toBe('+X');
  });

  it('is a document the validator accepts', () => {
    // Asserted here as well as in the units suite because this test is the one
    // that fails when somebody edits the file for scale reasons.
    const result = validateSkeleton(skeletonDoc);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });
});
