/**
 * A family's skeleton document, measured off a rig (spec 115).
 *
 * `assets/units/biped.skeleton.json` has been provisional since spec 107 -- the
 * bone contract written down, `bindPose: null`, and a comment saying the first
 * real rig would fill it in. Nothing did. There was no code anywhere that could
 * turn a rigged `.glb` into a skeleton document, so the promise in that comment
 * was a promise to a person, and every export had to be handed a skeleton that
 * already existed. A brand-new rig family therefore could not be exported at
 * all: the route looked for `<family>.skeleton.json`, did not find one, and
 * refused.
 *
 * This is the missing half. Given the rigged mesh it produces the document: the
 * joint list in the skin's own order, the hierarchy from the node tree, the bind
 * pose as it was actually measured, and the standard sockets mapped onto
 * whatever the rig calls its hands and head.
 *
 * ## What it will not invent
 *
 * `canonicalHeight` is passed in, because it is a decision about this *game* --
 * the height a body is drawn at -- and no fact about the file implies it. The
 * bone budget likewise. Everything else here is read.
 *
 * Pure, and part of the deterministic core.
 */

import { error, pointer, warning, type Issue } from './issues.js';
import { nodePosition, type GlbBinary, type GlbReadNode } from './glb-read.js';
import { readNodeTree, readSkinnedMesh } from './glb-read.js';
import { detectNaming, findRole, type BoneRole, type NamingSpec } from './naming.js';
import type { BindBone, Skeleton, SkeletonBone, SkeletonSocket } from './types.js';

/**
 * The sockets a biped gets, by the **role** each hangs off (spec 120).
 *
 * A role rather than a bone name, because there are two vocabularies in the tree
 * and this list has to work in both: `weapon.main` is the right hand whether the
 * rig calls it `mixamorig:RightHand` or `R_Hand`. Naming the bones directly is
 * what shipped a pig with no weapon socket at all.
 *
 * A socket whose bone is absent is left out rather than pointed at something
 * else -- the validator would refuse a socket naming a bone that does not exist,
 * and quietly re-homing `weapon.main` onto whatever is nearby would put a sword
 * through somebody's elbow.
 */
const STANDARD_SOCKETS: readonly { readonly id: string; readonly role: BoneRole }[] = [
  { id: 'weapon.main', role: 'rightHand' },
  { id: 'weapon.off', role: 'leftHand' },
  { id: 'fx.cast', role: 'rightHand' },
  { id: 'fx.body', role: 'chest' },
  { id: 'anchor.head', role: 'head' },
];

export interface DeriveOptions {
  /** The family id, e.g. `biped2`. */
  readonly id: string;
  /** The `.glb` this was measured out of, relative to the unit directory. */
  readonly source: string;
  /** The height this game draws a body at. A decision, not a measurement. */
  readonly canonicalHeight: number;
  readonly boneBudget?: { readonly min: number; readonly max: number };
  /** Carried through when filling in an existing provisional document. */
  readonly sockets?: readonly SkeletonSocket[];
  /**
   * The naming spec the rig was *asked for*, used only when the bones answer to
   * no vocabulary at all. Detection off the rig wins whenever it is certain, so
   * this is a fallback for the document's own record and never an override.
   */
  readonly naming?: NamingSpec;
  readonly comment?: string;
}

export interface DerivedSkeleton {
  readonly skeleton: Skeleton | null;
  readonly issues: readonly Issue[];
  /** What the rig is actually tall, so the import scale can be worked out. */
  readonly measuredHeight: number;
}

export function skeletonFromRig(glb: GlbBinary, options: DeriveOptions): DerivedSkeleton {
  const nodes = readNodeTree(glb);
  const mesh = readSkinnedMesh(glb);
  if (mesh === null || mesh.jointNodes.length === 0) {
    return {
      skeleton: null,
      issues: [error('skeleton.rig.absent', '', 'the .glb has no skin, so there is no rig to measure')],
      measuredHeight: 0,
    };
  }

  const issues: Issue[] = [];
  const joints = new Set(mesh.jointNodes);
  const ordered = orderParentsFirst(mesh.jointNodes, nodes);
  if (ordered === null) {
    return {
      skeleton: null,
      issues: [error('skeleton.rig.cycle', '', 'the rig hierarchy has a cycle, so no bone order exists')],
      measuredHeight: 0,
    };
  }

  /** A joint's parent *within the skin*, skipping nodes that are not joints. */
  const jointParent = (index: number): string | null => {
    let at = nodes[index]?.parent ?? null;
    let guard = nodes.length;
    while (at !== null && guard-- > 0) {
      // A rig commonly hangs its root under an Armature node that is not itself
      // a joint. Walking past those is what makes the derived root the actual
      // root rather than "the bone whose parent happens to be missing".
      if (joints.has(at)) return nodes[at]?.name ?? null;
      at = nodes[at]?.parent ?? null;
    }
    return null;
  };

  const bones: SkeletonBone[] = [];
  const bindBones: BindBone[] = [];
  for (const index of ordered) {
    const node = nodes[index];
    if (!node) continue;
    bones.push({ name: node.name, parent: jointParent(index) });
    bindBones.push({
      name: node.name,
      translation: [node.translation[0], node.translation[1], node.translation[2]],
      rotation: [node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]],
      scale: [node.scale[0], node.scale[1], node.scale[2]],
    });
  }

  const roots = bones.filter((bone) => bone.parent === null);
  if (roots.length !== 1) {
    issues.push(
      error(
        'skeleton.rig.roots',
        pointer('bones'),
        `the rig has ${roots.length} root bones (${roots.map((bone) => `"${bone.name}"`).join(', ')}), and a ` +
          'skeleton has exactly one. A rig with two roots is usually two rigs in one file.',
      ),
    );
  }

  // What the rig *is*, not what was hoped for (spec 120). Recording a guess is
  // how `biped.skeleton.json` came to claim the mixamo contract while carrying
  // `L_Hand`, `Spine02` and `Hip` -- a document that validated, and three
  // separate consumers that silently found nothing in it.
  const boneNames = bones.map((bone) => bone.name);
  const detected = detectNaming(boneNames);
  const naming: NamingSpec = detected === 'unknown' ? (options.naming ?? 'tripo') : detected;
  if (detected === 'unknown') {
    issues.push(
      warning(
        'skeleton.rig.naming',
        pointer('naming'),
        `the bone names match neither vocabulary this project reads, so this is recorded as "${naming}" -- the ` +
          'spec the rig was asked for. Sockets, the facing probe and the bind-pose check all look bones up by ' +
          'name and will find nothing on it. Check the rig before spending on clips.',
      ),
    );
  }

  const sockets =
    options.sockets ??
    STANDARD_SOCKETS.flatMap((socket): SkeletonSocket[] => {
      const bone = findRole(boneNames, naming, socket.role);
      return bone === null ? [] : [{ id: socket.id, bone }];
    });

  const skeleton: Skeleton = {
    ...(options.comment === undefined ? {} : { $comment: options.comment }),
    formatVersion: 1,
    id: options.id,
    naming,
    upAxis: '+Y',
    forwardAxis: '+X',
    canonicalHeight: options.canonicalHeight,
    // The measured count when nobody supplied one, rather than the hand-authored
    // 15..30 the mixamo contract was written around. A real generated rig has
    // twist bones -- 43 on the first one through here -- so that default made a
    // derived document fail its own validator the moment it was written, and
    // export refused a unit for being the shape it actually is. A family's bone
    // count is a measurement like its bind pose; `compareToFamily` is what holds
    // the next rig to it.
    boneBudget: options.boneBudget ?? { min: bones.length, max: bones.length },
    bones,
    sockets,
    bindPose: { source: options.source, bones: bindBones },
  };

  return { skeleton, issues, measuredHeight: heightOf(nodes, joints) };
}

/**
 * How far a *new* rig differs from the family's established contract.
 *
 * The point of a rig family is that one clip library serves every unit in it, so
 * unit two arriving with a different bone list is not a variation -- it is a
 * clip set that will be applied to bones that are not there. Reported by name,
 * both directions, because "missing 3, extra 3" is usually a renaming and
 * "missing 3" alone is usually a simpler rig.
 */
export function compareToFamily(established: Skeleton, derived: Skeleton): readonly Issue[] {
  const have = new Set(derived.bones.map((bone) => bone.name));
  const want = new Set(established.bones.map((bone) => bone.name));
  const missing = [...want].filter((name) => !have.has(name));
  const extra = [...have].filter((name) => !want.has(name));

  const issues: Issue[] = [];
  if (missing.length > 0) {
    issues.push(
      error(
        'skeleton.family.missing',
        pointer('bones'),
        `this rig is missing ${missing.length} bone(s) the "${established.id}" family has: ` +
          `${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}. The family's clips drive those ` +
          'bones, and on this rig they would drive nothing.',
      ),
    );
  }
  if (extra.length > 0) {
    issues.push(
      warning(
        'skeleton.family.extra',
        pointer('bones'),
        `this rig has ${extra.length} bone(s) the "${established.id}" family does not: ` +
          `${extra.slice(0, 6).join(', ')}${extra.length > 6 ? ', …' : ''}. Nothing in the family's clips will ` +
          'move them, so they will hold their bind pose.',
      ),
    );
  }

  // Order matters as much as membership: the family's array order is what
  // "canonical" means, and a clip retargeted against one order applied to
  // another puts a forearm's curve on a shin.
  if (missing.length === 0 && extra.length === 0) {
    const sameOrder = established.bones.every((bone, index) => derived.bones[index]?.name === bone.name);
    if (!sameOrder) {
      issues.push(
        warning(
          'skeleton.family.order',
          pointer('bones'),
          `this rig has the family's bones in a different order. Nothing here reorders them, and a clip bound by ` +
            'index rather than by name would land on the wrong limb.',
        ),
      );
    }
  }
  return issues;
}

/**
 * Joint node indices, parents before children.
 *
 * The skin's own order is usually already that, and is left alone when it is --
 * "canonical order" is a fact about the family and reshuffling it gratuitously
 * would make two exports of the same rig disagree. Only a rig that violates the
 * validator's parent-first rule is sorted, and then stably.
 */
function orderParentsFirst(jointNodes: readonly number[], nodes: readonly GlbReadNode[]): number[] | null {
  const joints = new Set(jointNodes);
  const depth = new Map<number, number>();
  for (const index of jointNodes) {
    let at: number | null = index;
    let steps = 0;
    let guard = nodes.length + 1;
    while (at !== null && guard-- > 0) {
      const parent: number | null = nodes[at]?.parent ?? null;
      if (parent !== null && joints.has(parent)) steps += 1;
      at = parent;
    }
    if (guard < 0) return null;
    depth.set(index, steps);
  }
  const ordered = [...jointNodes];
  const alreadyFine = ordered.every((index, at) => {
    const parent = nodes[index]?.parent ?? null;
    return parent === null || !joints.has(parent) || ordered.indexOf(parent) < at;
  });
  if (alreadyFine) return ordered;
  return ordered.sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0));
}

/** The rig's own height, bottom joint to top joint. */
function heightOf(nodes: readonly GlbReadNode[], joints: ReadonlySet<number>): number {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const index of joints) {
    const node = nodes[index];
    if (!node) continue;
    const y = nodePosition(node)[1];
    low = Math.min(low, y);
    high = Math.max(high, y);
  }
  return Number.isFinite(low) && Number.isFinite(high) ? high - low : 0;
}
