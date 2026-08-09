/**
 * Finding root motion, so it can be complained about (spec 111).
 *
 * The server owns where a body is. A clip that also moves the body fights it
 * every frame: the mesh drifts off the collision capsule, the health bar sits
 * beside the head rather than over it, and the whole thing snaps back the
 * instant the next delta lands. The fix is to strip the translation — every
 * pipeline does — but stripping it *quietly* is how a clip that was authored
 * with a two-metre stride gets shipped as one that moon-walks in place, and
 * nobody finds out until they watch it.
 *
 * So this module's job is not to remove anything. It is to **name** what would
 * be removed, in two places that have nothing else in common:
 *
 *  - {@link rootMotionChannels} reads a clip's glTF JSON, which is what
 *    `npm run validate:units` has to hand and what makes this a CI failure
 *    rather than an observation.
 *  - {@link rootMotionTrackNames} reads three.js track names, which is what the
 *    renderer has to hand at import.
 *
 * Both are pure and both are here rather than beside their callers, because the
 * rule they encode is one rule and it should not be possible for the CI gate and
 * the importer to disagree about what counts.
 *
 * ## What counts
 *
 * A **translation** channel on the **root** bone. Not rotation — a clip that
 * turns the hips is doing its job. Not translation on any other bone — that is
 * a rig doing something unusual (a squash, a shoulder that slides) and refusing
 * it would be this module inventing a rule nobody asked for. Only the root, and
 * only position.
 */

/** One offending channel, named well enough to fix. */
export interface RootMotionChannel {
  /** The animation's name in the file, or `''` when it is unnamed. */
  readonly animation: string;
  readonly bone: string;
  /** Always `translation` today; carried so a message can say what it found. */
  readonly path: string;
}

/** The glTF subset this needs. Shaped loosely because it comes from a file. */
interface GltfIsh {
  readonly nodes?: readonly { readonly name?: unknown }[];
  readonly animations?: readonly {
    readonly name?: unknown;
    readonly channels?: readonly {
      readonly target?: { readonly node?: unknown; readonly path?: unknown };
    }[];
  }[];
}

function nameOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Root translation channels in a clip's glTF JSON.
 *
 * Tolerant of a malformed document rather than throwing on one: a file this
 * cannot read is a problem for the validator that *parsed* it, and a checker
 * that throws would replace that file's real error with this one's.
 */
export function rootMotionChannels(gltf: unknown, rootBone: string): readonly RootMotionChannel[] {
  if (typeof gltf !== 'object' || gltf === null) return [];
  const doc = gltf as GltfIsh;
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const animations = Array.isArray(doc.animations) ? doc.animations : [];

  const found: RootMotionChannel[] = [];
  for (const animation of animations) {
    for (const channel of animation.channels ?? []) {
      const index = channel.target?.node;
      const path = nameOf(channel.target?.path);
      if (typeof index !== 'number' || path !== 'translation') continue;
      const bone = nameOf(nodes[index]?.name);
      if (bone !== rootBone) continue;
      found.push({ animation: nameOf(animation.name), bone, path });
    }
  }
  return found;
}

/**
 * The same rule over three.js track names, which look like `Hips.position`.
 *
 * Three's naming has two forms — a bare `bone.property` and a scoped
 * `.bones[Hips].position` — and both turn up depending on how a file was
 * exported, so both are matched. The property is compared exactly: `.position`
 * is root motion and `.positionSomething` is a track this has no opinion about.
 */
export function rootMotionTrackNames(trackNames: readonly string[], rootBone: string): readonly string[] {
  return trackNames.filter((name) => {
    if (!name.endsWith('.position')) return false;
    const target = name.slice(0, -'.position'.length);
    // `.bones[Hips]` and `Hips` are the same bone said two ways.
    const scoped = /\[([^\]]+)\]$/.exec(target);
    return (scoped?.[1] ?? target) === rootBone;
  });
}

/** One line a person can act on: which clip, which bone, and what to do. */
export function rootMotionMessage(unitId: string, clipId: string, bones: readonly string[]): string {
  return (
    `${unitId}/${clipId}: the clip animates ${bones.map((bone) => `"${bone}"`).join(', ')} in translation. ` +
    `The server owns where a body is, so root motion is stripped at import -- ` +
    `the clip will play in place. Re-export it with the root locked if that is not what you meant.`
  );
}
