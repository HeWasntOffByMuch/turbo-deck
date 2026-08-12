import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { boneKey, detectNaming, findRole, roleName, type BoneRole, type NamingSpec } from './naming.js';

/** The real bone lists, because a table that only matches fixtures proves nothing. */
function bonesOf(path: string): string[] {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { bones: { name: string }[] };
  return doc.bones.map((bone) => bone.name);
}

const PIG = bonesOf('assets/units/biped.skeleton.json');
const MANNEQUIN = bonesOf('assets/units/dev/mannequin-dev.skeleton.json');

describe('boneKey', () => {
  it('reduces the three ways a mixamo bone is spelled to one', () => {
    expect(boneKey('mixamorig:LeftFoot')).toBe('leftfoot');
    expect(boneKey('mixamorigLeftFoot')).toBe('leftfoot');
    expect(boneKey('mixamorig1:LeftFoot')).toBe('leftfoot');
  });

  it('strips the tripo prefix the same way', () => {
    expect(boneKey('tripo::L_Hand')).toBe('lhand');
    expect(boneKey('L_Hand')).toBe('lhand');
  });
});

describe('detectNaming', () => {
  it('reads the real rigs: the pig is tripo, the mannequin is mixamo', () => {
    expect(detectNaming(PIG)).toBe('tripo');
    expect(detectNaming(MANNEQUIN)).toBe('mixamo');
  });

  it('claims nothing for a rig on neither contract', () => {
    // The numbered-limb vocabulary spec 117 was written against: nothing in it
    // says which pair is legs, so no role resolves and no guess is recorded.
    expect(detectNaming(['tripo::Root', 'tripo::Spine_0', 'tripo::0_Left_Limb_0', 'tripo::0_Right_Limb_0'])).toBe(
      'unknown',
    );
    expect(detectNaming([])).toBe('unknown');
  });

  it('needs every signature role, not a majority of them', () => {
    // A mixamo rig with its hands removed is not a mixamo rig this format can
    // use, and half-matching is where a lookup silently returns the wrong bone.
    const handless = MANNEQUIN.filter((name) => !/Hand/.test(name));
    expect(detectNaming(handless)).toBe('unknown');
  });
});

describe('the two vocabularies do not collide', () => {
  // The guarantee that makes the `endsWith` match in `findRole` safe. Some bones
  // genuinely have one name in both contracts -- `Head` is `Head` either way --
  // and that is not a collision. A collision is the same role resolving to a
  // *different* bone depending on which table is consulted, because that is the
  // one that puts a sword in the wrong hand rather than merely finding it twice.
  it('never resolves a role to a different bone under the wrong vocabulary', () => {
    for (const [names, right, wrong] of [
      [PIG, 'tripo', 'mixamo'],
      [MANNEQUIN, 'mixamo', 'tripo'],
    ] as const) {
      const collisions = (Object.keys(ROLE_SET) as BoneRole[])
        .map((role) => ({ role, correct: findRole(names, right, role), crossed: findRole(names, wrong, role) }))
        .filter((entry) => entry.crossed !== null && entry.crossed !== entry.correct);
      expect(collisions).toEqual([]);
    }
  });

  it('resolves no *sided* role across vocabularies at all', () => {
    // Handedness is where a wrong answer is worst and a shared spelling is not
    // plausible: no vocabulary should be able to find the other's left hand.
    const sided: BoneRole[] = ['leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'leftUpLeg', 'rightUpLeg'];
    for (const [names, wrong] of [
      [PIG, 'mixamo'],
      [MANNEQUIN, 'tripo'],
    ] as const) {
      const resolved = sided.map((role) => findRole(names, wrong as NamingSpec, role)).filter((hit) => hit !== null);
      expect(resolved).toEqual([]);
    }
  });
});

/** Every role, as an object so the test above can enumerate them. */
const ROLE_SET: Record<BoneRole, true> = {
  hips: true,
  spine: true,
  chest: true,
  neck: true,
  head: true,
  leftUpLeg: true,
  leftLeg: true,
  leftFoot: true,
  leftToe: true,
  rightUpLeg: true,
  rightLeg: true,
  rightFoot: true,
  rightToe: true,
  leftArm: true,
  leftForeArm: true,
  leftHand: true,
  rightArm: true,
  rightForeArm: true,
  rightHand: true,
};

describe('findRole', () => {
  it('returns the name the rig actually uses, so a socket can name it', () => {
    // Not the table's spelling: a socket that says `rhand` where the rig says
    // `R_Hand` is a socket the validator refuses.
    expect(findRole(PIG, 'tripo', 'rightHand')).toBe('R_Hand');
    expect(findRole(PIG, 'tripo', 'chest')).toBe('Spine02');
    expect(findRole(PIG, 'tripo', 'hips')).toBe('Hip');
    expect(findRole(MANNEQUIN, 'mixamo', 'rightHand')).toBe('mixamorig:RightHand');
  });

  it('finds the same roles on both rigs', () => {
    // The agreement that matters: the roles every consumer needs resolve on a
    // mixamo rig and a tripo one alike, which is what makes a role-based lookup
    // a replacement for a name-based one rather than a second code path.
    const needed: BoneRole[] = [
      'hips',
      'chest',
      'head',
      'leftHand',
      'rightHand',
      'leftFoot',
      'rightFoot',
      'leftUpLeg',
      'rightUpLeg',
      'leftArm',
      'leftForeArm',
    ];
    for (const role of needed) {
      expect(findRole(PIG, 'tripo', role), `pig ${role}`).not.toBeNull();
      expect(findRole(MANNEQUIN, 'mixamo', role), `mannequin ${role}`).not.toBeNull();
    }
  });

  it('does not confuse hip with hips, or a foot with a forearm', () => {
    // The near-misses that made the mixamo table resolve to nothing on a tripo
    // rig, checked in the direction that would put the wrong bone in a socket.
    expect(findRole(['Hips'], 'tripo', 'hips')).toBeNull();
    expect(findRole(['Hip'], 'mixamo', 'hips')).toBeNull();
    expect(findRole(['L_Forearm'], 'tripo', 'leftFoot')).toBeNull();
  });

  it('prefers the toe tip over the ball, which is the better lever arm', () => {
    expect(findRole(['L_ToeBase', 'L_ToeEnd'], 'tripo', 'leftToe')).toBe('L_ToeEnd');
    expect(findRole(['mixamorig:LeftToeBase'], 'mixamo', 'leftToe')).toBe('mixamorig:LeftToeBase');
  });
});

describe('roleName', () => {
  it('spells a role in each vocabulary, for a diagnostic with no rig to ask', () => {
    expect(roleName('mixamo', 'leftFoot')).toBe('leftfoot');
    expect(roleName('tripo', 'leftFoot')).toBe('lfoot');
  });
});
