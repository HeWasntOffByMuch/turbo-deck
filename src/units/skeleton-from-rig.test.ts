/**
 * Deriving a family's skeleton from a rig (spec 115).
 *
 * Measured against the real committed reference unit, for the same reason
 * `mesh-check.test.ts` is: it is an actual skinned biped on the mixamo contract,
 * so the derived document can be compared with the one the generator wrote by
 * hand. Those two agreeing is the whole claim -- one was authored, one was read
 * back out of the bytes, and if they differ then one of them is wrong.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CANONICAL_HEIGHT } from './canonical-height.js';
import { splitGlb } from './glb-read.js';
import { hasErrors } from './issues.js';
import { compareToFamily, skeletonFromRig } from './skeleton-from-rig.js';
import { validateSkeleton } from './validate.js';
import type { Skeleton } from './types.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const glb = splitGlb(new Uint8Array(readFileSync(join(repoRoot, 'assets', 'units', 'dev', 'mannequin.glb'))));
const authored = JSON.parse(
  readFileSync(join(repoRoot, 'assets', 'units', 'dev', 'biped-dev.skeleton.json'), 'utf8'),
) as Skeleton;

function derive(): Skeleton {
  const result = skeletonFromRig(glb, {
    id: 'biped-dev',
    source: 'mannequin.glb',
    canonicalHeight: DEFAULT_CANONICAL_HEIGHT,
  });
  if (!result.skeleton) throw new Error(`no skeleton derived: ${result.issues.map((i) => i.message).join('; ')}`);
  return result.skeleton;
}

describe('skeletonFromRig (spec 115)', () => {
  it('derives the same bone list, in the same order, as the hand-authored one', () => {
    // One was written; one was read out of the bytes. They have to agree.
    expect(derive().bones).toEqual(authored.bones);
  });

  it('derives the same bind pose the generator authored', () => {
    const derived = derive().bindPose;
    expect(derived?.bones.map((bone) => bone.name)).toEqual(authored.bindPose?.bones.map((bone) => bone.name));
    derived?.bones.forEach((bone, index) => {
      const want = authored.bindPose?.bones[index];
      expect(bone.translation.map((v) => Number(v.toFixed(5))), bone.name).toEqual(
        want?.translation.map((v) => Number(v.toFixed(5))),
      );
    });
  });

  it('derives the same sockets, mapped onto the rig it found', () => {
    expect(derive().sockets).toEqual(authored.sockets);
  });

  it('records the vocabulary the rig is actually named in', () => {
    expect(derive().naming).toBe('mixamo');
  });

  it('produces a document the validator accepts, with no provisional warning', () => {
    const result = validateSkeleton(derive());
    expect(result.value).not.toBeNull();
    expect(result.issues.map((issue) => issue.code)).not.toContain('skeleton.provisional');
  });

  it('takes the canonical height rather than measuring one', () => {
    // The height a body is drawn at is a decision about the game. Nothing about
    // a .glb implies it, and a rig that arrives 1.7 units tall would otherwise
    // make every unit of the family the size of a coin.
    const result = skeletonFromRig(glb, { id: 'x', source: 'm.glb', canonicalHeight: 42 });
    expect(result.skeleton?.canonicalHeight).toBe(42);
    expect(result.measuredHeight).toBeGreaterThan(1);
    expect(result.measuredHeight).toBeLessThan(2);
  });

  it('says so rather than guessing when there is no rig', () => {
    const empty = { json: {}, bin: new Uint8Array(0) };
    const result = skeletonFromRig(empty, { id: 'x', source: 'm.glb', canonicalHeight: 1 });
    expect(result.skeleton).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain('skeleton.rig.absent');
  });

  it('keeps a decision that was already made rather than overwriting it', () => {
    // Filling in a provisional document must not silently re-home its sockets.
    const sockets = [{ id: 'weapon.main', bone: 'mixamorig:LeftHand' }];
    const result = skeletonFromRig(glb, {
      id: 'biped',
      source: 'mannequin.glb',
      canonicalHeight: DEFAULT_CANONICAL_HEIGHT,
      sockets,
      boneBudget: { min: 1, max: 99 },
    });
    expect(result.skeleton?.sockets).toEqual(sockets);
    expect(result.skeleton?.boneBudget).toEqual({ min: 1, max: 99 });
  });
});

describe('a rig on the tripo vocabulary (spec 120)', () => {
  // The real generated rig, because the whole point is that this vocabulary is
  // what the auto-rig returns and not something a fixture can assert into being.
  const pig = splitGlb(
    new Uint8Array(readFileSync(join(repoRoot, 'assets', 'units', 'pig_a_pose_full', 'pig_a_pose_full.glb'))),
  );
  const derived = skeletonFromRig(pig, { id: 'pig', source: 'pig.glb', canonicalHeight: 55.65 }).skeleton;

  it('records tripo rather than the spec that was hoped for', () => {
    expect(derived?.naming).toBe('tripo');
  });

  it('derives the same socket roles the mixamo rig gets, on this rig\'s own bones', () => {
    // The agreement that makes a role-based table a replacement rather than a
    // second code path: same five ids, spelled the way this rig spells them.
    expect(derived?.sockets).toEqual([
      { id: 'weapon.main', bone: 'R_Hand' },
      { id: 'weapon.off', bone: 'L_Hand' },
      { id: 'fx.cast', bone: 'R_Hand' },
      { id: 'fx.body', bone: 'Spine02' },
      { id: 'anchor.head', bone: 'Head' },
    ]);
    expect(derived?.sockets.map((socket) => socket.id)).toEqual(authored.sockets.map((socket) => socket.id));
  });

  it('warns about nothing, where it used to warn that the names were wrong', () => {
    const result = skeletonFromRig(pig, { id: 'pig', source: 'pig.glb', canonicalHeight: 55.65 });
    expect(result.issues.map((issue) => issue.code)).not.toContain('skeleton.rig.naming');
  });
});

describe('compareToFamily (spec 115)', () => {
  it('is silent when the rig is the family', () => {
    expect(compareToFamily(authored, derive())).toEqual([]);
  });

  it('refuses a rig missing bones the family clips drive', () => {
    // The family's one clip library animates every unit in it, so a bone that
    // is not there is a channel driving nothing.
    const short = { ...derive(), bones: derive().bones.slice(0, 20) };
    const issues = compareToFamily(authored, short);
    expect(hasErrors(issues)).toBe(true);
    expect(issues.map((issue) => issue.code)).toContain('skeleton.family.missing');
  });

  it('only warns about bones the family does not have', () => {
    // Extra bones hold their bind pose. Untidy, not broken.
    const extra = {
      ...derive(),
      bones: [...derive().bones, { name: 'mixamorig:Tail', parent: 'mixamorig:Hips' }],
    };
    const issues = compareToFamily(authored, extra);
    expect(hasErrors(issues)).toBe(false);
    expect(issues.map((issue) => issue.code)).toContain('skeleton.family.extra');
  });

  it('notices the same bones in a different order', () => {
    const bones = [...derive().bones];
    const swapped = [bones[1], bones[0], ...bones.slice(2)].filter((bone) => bone !== undefined);
    const issues = compareToFamily(authored, { ...derive(), bones: swapped });
    expect(issues.map((issue) => issue.code)).toContain('skeleton.family.order');
  });
});
