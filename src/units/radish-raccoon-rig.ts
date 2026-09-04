/**
 * The radish raccoon's skeleton, and the skin that binds the mesh to it.
 *
 * The mesh arrived auto-rigged onto the `biped` family's 41 bones and the rig
 * was unusable: measured off the file, `R_Calf` sits at x -0.325 on a body whose
 * widest point is 0.497 and whose right foot is at x 0.235 -- a knee a body's
 * width outside the animal, with `R_ThighTwist02` and `R_CalfTwist01` out there
 * with it. That is the ordinary failure of a humanoid auto-rig on a creature
 * with no visible legs: there is nothing limb-shaped for it to find, so it puts
 * the chain where the silhouette is widest, which here is the tail.
 *
 * So the skeleton is authored instead, and it is authored for *this* animal
 * rather than trimmed from the biped: a radish body with the legs and arms
 * buried in it, a raccoon head with ears, a root tail, and three leaves. Every
 * position below was measured off the mesh -- the foot centroids, the paw
 * centroids, the ear slabs, the tail's centreline sliced along x, and each
 * leaf blade's own base-to-tip axis -- and `scripts/measure-radish-raccoon.ts`
 * re-derives them, so a re-generated mesh is a re-measure rather than a guess.
 *
 * Two decisions are worth knowing before touching it.
 *
 * **It is tripo-named, and that is not decoration.** `naming.ts` claims a
 * vocabulary only when every signature role resolves -- hips, spine, head, both
 * hands, both feet -- and a rig that answers to neither vocabulary is `unknown`,
 * which costs the facing measurement, the bind-pose measurement and every
 * weapon socket. The seven bones that carry those roles are therefore named the
 * way the family's other rigs name them (`Hip`, `Spine01`, `Head`, `L_Hand`,
 * `R_Hand`, `L_Foot`, `R_Foot`) even where the anatomy is a stretch: this
 * creature's "hand" is a mitten. The bones the biped vocabulary has no role for
 * at all -- the ears, the tail and the leaves -- are named plainly and posed by
 * name (`PoseKey.bones`), because inventing a `tail` role for one family is a
 * row in a shared table that only one file could ever resolve.
 *
 * **Bind rotations are identity.** A generated rig's are not, and `clip-author`
 * carries a comment about exactly the bug that causes; an authored rig has no
 * reason to inherit it. Every bone is a pure translation at bind, so a bone's
 * local frame is the world frame, `intoLocalFrame` is a no-op, and an inverse
 * bind matrix is a translation by minus the bone's rest position.
 *
 * Pure, and part of the deterministic core: the `.glb` it describes is
 * committed, so the same table has to produce the same bytes.
 */

/** Where a bone sits at bind, in the re-centred mesh frame. World units. */
export type Rest = readonly [number, number, number];

export interface RigBone {
  readonly name: string;
  /** Parent bone name, or null for the root. */
  readonly parent: string | null;
  /** World-space rest position. Bind rotation is identity for every bone. */
  readonly rest: Rest;
  /**
   * The part this bone binds vertices from.
   *
   * A vertex is labelled with a part and then weighted along that part's chain,
   * so a leaf vertex can never pick up the body bone nearest it in space --
   * which, on a creature whose leaves fold back over its own head, is most of
   * them.
   */
  readonly part: PartId;
}

export type PartId =
  | 'body'
  | 'head'
  | 'earL'
  | 'earR'
  | 'crown'
  | 'leafA'
  | 'leafB'
  | 'leafC'
  | 'tail'
  | 'armL'
  | 'armR'
  | 'legL'
  | 'legR';

/**
 * What the mesh is translated by before anything else reads it.
 *
 * Tripo centres a model on its *bounding box*, and this animal's box is set by
 * a tail reaching x -0.497 behind it and a paw reaching 0.497 in front -- so the
 * body itself sits at x 0.23, and the renderer, which places a unit at its own
 * mesh origin and never re-centres (`unit-rig.ts` applies the import scale and
 * nothing else), would draw the animal 13 world units in front of the entity
 * it is. The offset is the mid-point of the two foot centroids and the body
 * core, which is the ground the creature actually stands on.
 *
 * `y` is untouched: the feet are already at 0, which is where a unit's floor
 * belongs, and moving it would move `meshHeight` and with it the import scale.
 */
export const MESH_OFFSET: Rest = [-0.230, 0, 0.035];

const at = (x: number, y: number, z: number): Rest => [x + MESH_OFFSET[0], y + MESH_OFFSET[1], z + MESH_OFFSET[2]];

/**
 * The rig, parents before children.
 *
 * `validate.ts` requires that ordering and the skin's joint list is written in
 * this order, so this array is the canonical bone order for the family.
 */
export const RADISH_RACCOON_BONES: readonly RigBone[] = [
  { name: 'Root', parent: null, rest: at(0.230, 0.000, -0.035), part: 'body' },

  // Body. Two bones rather than one so the run can carry a bob that the legs
  // are not the whole of, and no more than two: this animal is a sphere, and a
  // third joint inside it is a place for the silhouette to crease.
  { name: 'Hip', parent: 'Root', rest: at(0.195, 0.215, -0.020), part: 'body' },
  { name: 'Spine01', parent: 'Hip', rest: at(0.215, 0.330, -0.020), part: 'body' },

  // Head. The pivot is set back from the face (measured centroid 0.420, 0.443)
  // and inside the ball, so a nod swings the muzzle and the ears rather than
  // shearing the front off the radish.
  { name: 'Head', parent: 'Spine01', rest: at(0.285, 0.425, -0.020), part: 'head' },
  { name: 'L_Ear', parent: 'Head', rest: at(0.300, 0.520, -0.205), part: 'earL' },
  { name: 'R_Ear', parent: 'Head', rest: at(0.312, 0.520, 0.120), part: 'earR' },

  // The greens. `Crown` hangs off the body rather than the head: all three
  // blades base within 0.09 of (0.185, 0.66, 0.02), which is directly over the
  // body's core and well behind the face, so they are the radish's top and not
  // the raccoon's hair however much they read as hair.
  { name: 'Crown', parent: 'Spine01', rest: at(0.200, 0.600, 0.010), part: 'crown' },
  { name: 'Leaf_A_01', parent: 'Crown', rest: at(0.194, 0.662, -0.028), part: 'leafA' },
  { name: 'Leaf_A_02', parent: 'Leaf_A_01', rest: at(0.115, 0.788, -0.205), part: 'leafA' },
  { name: 'Leaf_B_01', parent: 'Crown', rest: at(0.171, 0.668, 0.052), part: 'leafB' },
  { name: 'Leaf_B_02', parent: 'Leaf_B_01', rest: at(0.184, 0.715, 0.240), part: 'leafB' },
  { name: 'Leaf_C_01', parent: 'Crown', rest: at(0.187, 0.656, 0.044), part: 'leafC' },
  { name: 'Leaf_C_02', parent: 'Leaf_C_01', rest: at(0.130, 0.830, 0.080), part: 'leafC' },

  // The tail is the root of the radish and is the longest thing on the animal:
  // 0.49 from base to tip against a 0.55 body. Four bones, so it can carry a
  // travelling wave rather than swinging as a stick.
  { name: 'Tail01', parent: 'Hip', rest: at(-0.100, 0.160, 0.110), part: 'tail' },
  { name: 'Tail02', parent: 'Tail01', rest: at(-0.200, 0.145, 0.220), part: 'tail' },
  { name: 'Tail03', parent: 'Tail02', rest: at(-0.300, 0.158, 0.250), part: 'tail' },
  { name: 'Tail04', parent: 'Tail03', rest: at(-0.400, 0.180, 0.310), part: 'tail' },

  // Arms. The shoulders are inside the body -- there is no visible upper arm on
  // this animal, only a mitten stuck to the front of a sphere -- so the chain is
  // short and nearly straight, which is what "short arms that go straight" is
  // as a rig. Both are measured: the paws are at 0.408,-0.262 and 0.469,0.058,
  // and they are not mirror images because the sculpt is not.
  { name: 'L_Upperarm', parent: 'Spine01', rest: at(0.310, 0.272, -0.170), part: 'armL' },
  { name: 'L_Forearm', parent: 'L_Upperarm', rest: at(0.3639, 0.2390, -0.2206), part: 'armL' },
  { name: 'L_Hand', parent: 'L_Forearm', rest: at(0.408, 0.212, -0.262), part: 'armL' },
  { name: 'R_Upperarm', parent: 'Spine01', rest: at(0.330, 0.278, 0.070), part: 'armR' },
  { name: 'R_Forearm', parent: 'R_Upperarm', rest: at(0.4064, 0.2456, 0.0634), part: 'armR' },
  { name: 'R_Hand', parent: 'R_Forearm', rest: at(0.469, 0.219, 0.058), part: 'armR' },

  // Legs. The same shape one axis down: the thigh is buried, the whole visible
  // limb is the foot, and the toe is what the facing measurement reads.
  { name: 'L_Thigh', parent: 'Hip', rest: at(0.198, 0.150, -0.185), part: 'legL' },
  { name: 'L_Calf', parent: 'L_Thigh', rest: at(0.1991, 0.0906, -0.1927), part: 'legL' },
  { name: 'L_Foot', parent: 'L_Calf', rest: at(0.200, 0.042, -0.199), part: 'legL' },
  { name: 'L_ToeBase', parent: 'L_Foot', rest: at(0.268, 0.024, -0.190), part: 'legL' },
  { name: 'R_Thigh', parent: 'Hip', rest: at(0.228, 0.150, 0.142), part: 'legR' },
  { name: 'R_Calf', parent: 'R_Thigh', rest: at(0.2319, 0.0917, 0.1431), part: 'legR' },
  { name: 'R_Foot', parent: 'R_Calf', rest: at(0.235, 0.044, 0.144), part: 'legR' },
  { name: 'R_ToeBase', parent: 'R_Foot', rest: at(0.302, 0.028, 0.150), part: 'legR' },
];

/** The family this rig establishes. */
export const RADISH_RACCOON_FAMILY = 'radish_raccoon';

/** Bone index by name, in the canonical order above. */
export const BONE_INDEX: ReadonlyMap<string, number> = new Map(
  RADISH_RACCOON_BONES.map((bone, index) => [bone.name, index]),
);

/** The bones of one part, in rig order. */
export function bonesOfPart(part: PartId): readonly RigBone[] {
  return RADISH_RACCOON_BONES.filter((bone) => bone.part === part);
}

/**
 * The tip a chain's last bone points at, so it has a direction to be posed
 * about.
 *
 * A leaf's last bone, the tail's last bone and a toe all have no child, and
 * `flexAxis` falls back to the body's lateral axis for a bone with none --
 * which would hinge a leaf tip sideways when what a leaf does is nod. These are
 * the measured tips of each chain, and the rig writer adds no node for them:
 * they are read by the pose maths, not skinned to.
 */
export const CHAIN_TIPS: Readonly<Record<string, Rest>> = {
  Leaf_A_02: at(0.057, 0.830, -0.394),
  Leaf_B_02: at(0.093, 0.633, 0.431),
  Leaf_C_02: at(0.021, 0.996, 0.081),
  Tail04: at(-0.490, 0.270, 0.400),
  L_Ear: at(0.230, 0.700, -0.220),
  R_Ear: at(0.215, 0.700, 0.145),
};
