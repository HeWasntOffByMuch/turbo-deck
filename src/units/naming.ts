/**
 * The bone vocabularies a rig can be named in, and the one way to look a bone
 * up across them (spec 120).
 *
 * Every rig this project generates is asked for on the `tripo` spec, because a
 * rig built to the mixamo naming spec is refused by every retarget call -- the
 * two specs are a choice between Tripo's animation library and Mixamo's, and a
 * game needs the clips. The reference mannequin is authored and mixamo-named.
 * So there are two vocabularies in the tree at once, permanently, and the
 * format's job is to say which one a document is in rather than to assume.
 *
 * The rule that makes this a table and not a heuristic: a bone's **role** is
 * what every consumer actually wants -- the socket derivation wants "the right
 * hand", the facing probe wants "the left hip", the bind-pose check wants "the
 * arm chain". None of them want a string. So the roles are named once here and
 * each vocabulary says what it calls them; adding a third vocabulary is a
 * column in this file and no change anywhere else.
 *
 * Pure, and part of the deterministic core.
 */

/** A bone naming contract. The `naming` field of a skeleton document. */
export type NamingSpec = 'mixamo' | 'tripo';

/** Every naming contract this project can read, in detection order. */
export const NAMING_SPECS: readonly NamingSpec[] = ['mixamo', 'tripo'];

/**
 * The bones this format needs to be able to find, by what they *are*.
 *
 * Deliberately not exhaustive: a rig has twist bones, fingers and a pelvis that
 * nothing here looks up, and a role nobody resolves is a row that can go stale
 * without a test noticing.
 */
export type BoneRole =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'leftUpLeg'
  | 'leftLeg'
  | 'leftFoot'
  | 'leftToe'
  | 'rightUpLeg'
  | 'rightLeg'
  | 'rightFoot'
  | 'rightToe'
  | 'leftShoulder'
  | 'leftArm'
  | 'leftForeArm'
  | 'leftHand'
  | 'rightShoulder'
  | 'rightArm'
  | 'rightForeArm'
  | 'rightHand';

/**
 * What each vocabulary calls each role, under {@link boneKey}.
 *
 * More than one name per role where a rig may stop short: a leg that ends at
 * the ankle has no toe, and mixamo spells the toe two ways depending on whether
 * the exporter kept the end effector. First match wins, so the preferred name
 * leads.
 */
const VOCABULARY: Record<NamingSpec, Readonly<Record<BoneRole, readonly string[]>>> = {
  mixamo: {
    hips: ['hips'],
    spine: ['spine'],
    chest: ['spine2', 'spine1'],
    neck: ['neck'],
    head: ['head'],
    leftUpLeg: ['leftupleg'],
    leftLeg: ['leftleg'],
    leftFoot: ['leftfoot'],
    // `Toe_End` first: it is the tip and the better lever arm for the facing
    // measurement. `ToeBase` is the fallback for a rig that stops at the ball.
    leftToe: ['lefttoeend', 'lefttoebase'],
    rightUpLeg: ['rightupleg'],
    rightLeg: ['rightleg'],
    rightFoot: ['rightfoot'],
    rightToe: ['righttoeend', 'righttoebase'],
    leftShoulder: ['leftshoulder'],
    leftArm: ['leftarm'],
    leftForeArm: ['leftforearm'],
    leftHand: ['lefthand'],
    rightShoulder: ['rightshoulder'],
    rightArm: ['rightarm'],
    rightForeArm: ['rightforearm'],
    rightHand: ['righthand'],
  },
  // Measured off the rigs the service actually returns, not from its docs. Note
  // `hip` singular, `thigh`/`calf` rather than `upleg`/`leg`, `upperarm` as one
  // word, and a `root` above the hips that mixamo does not have -- every one of
  // these is a near-miss that an `endsWith` against the mixamo table resolves to
  // nothing at all.
  tripo: {
    hips: ['hip'],
    spine: ['spine01'],
    chest: ['spine02', 'spine01'],
    neck: ['necktwist01', 'neck'],
    head: ['head'],
    leftUpLeg: ['lthigh'],
    leftLeg: ['lcalf'],
    leftFoot: ['lfoot'],
    leftToe: ['ltoeend', 'ltoebase', 'ltoe'],
    rightUpLeg: ['rthigh'],
    rightLeg: ['rcalf'],
    rightFoot: ['rfoot'],
    rightToe: ['rtoeend', 'rtoebase', 'rtoe'],
    leftShoulder: ['lclavicle'],
    leftArm: ['lupperarm'],
    leftForeArm: ['lforearm'],
    leftHand: ['lhand'],
    rightShoulder: ['rclavicle'],
    rightArm: ['rupperarm'],
    rightForeArm: ['rforearm'],
    rightHand: ['rhand'],
  },
};

/**
 * The roles a rig must answer to before a vocabulary is claimed as its own.
 *
 * One from each limb plus the spine and head: enough that a rig cannot match by
 * accident, few enough that a rig missing its toes or its clavicles still gets
 * named. Handedness is in here deliberately -- a vocabulary that cannot tell
 * left from right is one this format cannot use.
 */
const SIGNATURE_ROLES: readonly BoneRole[] = [
  'hips',
  'spine',
  'head',
  'leftHand',
  'rightHand',
  'leftFoot',
  'rightFoot',
];

/**
 * A bone name reduced to what two files can be expected to agree on.
 *
 * `mixamorig:LeftFoot`, `mixamorigLeftFoot` and `mixamorig1:LeftFoot` are the
 * same bone said three ways -- three.js sanitises the colon out of its track
 * names, and exporters number the prefix when a scene has carried two rigs.
 * Tripo's own prefix (`tripo::`) is stripped for the same reason. Comparing raw
 * names across two files is how a check silently matches nothing and reports a
 * clean result, which has already happened once in this codebase.
 */
export function boneKey(name: string): string {
  return name
    .replace(/^mixamorig\d*[:_]?/i, '')
    .replace(/^tripo\d*::?/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

/** Whether `name` is the bone `vocabulary` gives `role`. */
function nameIsRole(key: string, naming: NamingSpec, role: BoneRole): boolean {
  // `endsWith` as well as equality because a rig may carry an armature prefix
  // the key normalization leaves attached. The two tables are checked for
  // cross-matching by test: no mixamo name ends with a tripo one or vice versa,
  // which is what makes a loose match safe here.
  return VOCABULARY[naming][role].some((want) => key === want || key.endsWith(want));
}

/**
 * The rig's own name for `role`, or null if it has no such bone.
 *
 * Takes the names as they are in the file and returns one of them, so a caller
 * can put the result straight into a document: a socket has to name the bone
 * the way the rig spells it, not the way this table does.
 */
export function findRole(names: readonly string[], naming: NamingSpec, role: BoneRole): string | null {
  for (const want of VOCABULARY[naming][role]) {
    const hit = names.find((name) => {
      const key = boneKey(name);
      return key === want || key.endsWith(want);
    });
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * The name `naming` prefers for `role`, for a diagnostic that has to spell one.
 *
 * Normalized rather than as a rig writes it, because this is used where there is
 * no rig to ask -- "this file has no leftfoot" names the bone the reader should
 * go looking for.
 */
export function roleName(naming: NamingSpec, role: BoneRole): string {
  // Every role has at least one name in every vocabulary -- the table is a
  // total `Record`, so this is exhaustive by construction rather than by luck.
  return VOCABULARY[naming][role][0] ?? role;
}

/** How many of {@link SIGNATURE_ROLES} `names` answers to under `naming`. */
function signatureScore(names: readonly string[], naming: NamingSpec): number {
  const keys = names.map(boneKey);
  return SIGNATURE_ROLES.filter((role) => keys.some((key) => nameIsRole(key, naming, role))).length;
}

/**
 * Which vocabulary a rig's bones are in, or `unknown`.
 *
 * Every signature role has to resolve, not a majority of them: a partial match
 * is a rig off both contracts, and recording a guess is exactly the failure
 * this module exists to end. When two vocabularies both match in full the
 * fuller one wins, which is a tie-break that should never fire -- the tables
 * are tested for not overlapping.
 */
export function detectNaming(names: readonly string[]): NamingSpec | 'unknown' {
  const full = NAMING_SPECS.filter((naming) => signatureScore(names, naming) === SIGNATURE_ROLES.length);
  const [first, ...rest] = full;
  if (first === undefined) return 'unknown';
  let best = first;
  for (const entry of rest) {
    const total = (spec: NamingSpec): number =>
      (Object.keys(VOCABULARY[spec]) as BoneRole[]).filter((role) => findRole(names, spec, role) !== null).length;
    if (total(entry) > total(best)) best = entry;
  }
  return best;
}
