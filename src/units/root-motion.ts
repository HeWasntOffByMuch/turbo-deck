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
 *
 * ## What counts, measured (spec 118)
 *
 * That rule asks which *bone* a track is on, and a generated rig has no reason
 * to obey it: the pig's auto-rig baked the whole stride onto `Hip`, one node
 * below the root, and the clip validated clean while the body slid. So there is
 * a second rule below, asked of the values instead of the name —
 * {@link trackTravel} and {@link withoutTravel}. A cycle ends where it began, so
 * a translation track whose last key is not its first is carrying travel
 * wherever it sits, and only the component *along* that displacement is the
 * fault. The two rules do not compete: the first deletes tracks on nodes that
 * exist to position the body, the second corrects the one component of a
 * posing bone that is positioning it by accident.
 */

import { readAccessor, splitGlb } from './glb-read.js';

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

/** The loose shapes {@link travelChannels} reads out of a file it did not write. */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Root translation channels in a clip's glTF JSON.
 *
 * Tolerant of a malformed document rather than throwing on one: a file this
 * cannot read is a problem for the validator that *parsed* it, and a checker
 * that throws would replace that file's real error with this one's.
 */
export function rootMotionChannels(
  gltf: unknown,
  /** The root and everything above it -- see {@link rootMotionTrackNames}. */
  roots: string | readonly string[],
): readonly RootMotionChannel[] {
  const wanted = new Set(typeof roots === 'string' ? [roots] : roots);
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
      if (!wanted.has(bone)) continue;
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
export function rootMotionTrackNames(
  trackNames: readonly string[],
  /**
   * The skeleton's root **and every node above it**.
   *
   * A list rather than one name, because a real rig puts the travel on a node
   * the skin does not deform: `Root` sits above `Hip`, carries the character
   * across the floor, and is not one of the skin's joints. Checking only the
   * topmost *joint* then finds nothing, strips nothing, and reports a clean
   * import while the body slides away from where the server put it -- which is
   * exactly what shipped. Everything at or above the root positions the body;
   * nothing at or above it poses the body.
   */
  roots: string | readonly string[],
): readonly string[] {
  const wanted = new Set(typeof roots === 'string' ? [roots] : roots);
  return trackNames.filter((name) => {
    if (!name.endsWith('.position')) return false;
    const target = name.slice(0, -'.position'.length);
    // `.bones[Hips]` and `Hips` are the same bone said two ways.
    const scoped = /\[([^\]]+)\]$/.exec(target);
    return wanted.has(scoped?.[1] ?? target);
  });
}

/**
 * The net displacement a translation track ends on (spec 118).
 *
 * The rule above asks *which bone* a track is on and refuses to look anywhere
 * else. That was enough while every rig here carried its travel on the root,
 * and it is not a rule a generated rig has any reason to obey: the pig's
 * auto-rig leaves `Root` animated in rotation only and bakes the whole stride
 * onto `Hip`, one node *below* the root, where nothing was looking. The clip
 * validated clean and the body slid 160 world units forward per cycle.
 *
 * So this is the same rule asked of the *values* rather than of the name. A
 * cycle ends where it began; a translation track whose last key is not its first
 * went somewhere and did not come back, and that is travel wherever in the rig
 * it sits. It is a measurement, so it cannot be fooled by a rig that names its
 * bones differently, and it does not have to be told which convention produced
 * the file.
 *
 * The axis comes back with the distance because the correction needs it: what
 * runs along the travel is the travel, and what is perpendicular to it is the
 * bob, the sway and the crouch that the run is made of.
 */
export interface Travel {
  readonly distance: number;
  /** Unit vector along the net displacement, or zero when there is none. */
  readonly axis: readonly [number, number, number];
}

const NO_TRAVEL: Travel = { distance: 0, axis: [0, 0, 0] };

/** First-to-last displacement of a flat `[x,y,z, x,y,z, ...]` track. */
export function trackTravel(values: ArrayLike<number>): Travel {
  const keys = Math.floor(values.length / 3);
  if (keys < 2) return NO_TRAVEL;
  const last = (keys - 1) * 3;
  const d: [number, number, number] = [
    (values[last + 0] ?? 0) - (values[0] ?? 0),
    (values[last + 1] ?? 0) - (values[1] ?? 0),
    (values[last + 2] ?? 0) - (values[2] ?? 0),
  ];
  const distance = Math.hypot(d[0], d[1], d[2]);
  if (distance === 0) return NO_TRAVEL;
  return { distance, axis: [d[0] / distance, d[1] / distance, d[2] / distance] };
}

/**
 * The same keys with the travel taken out, and nothing else touched.
 *
 * Two steps, and the second is the one that is easy to leave out.
 *
 *  1. **Remove the ramp.** Subtract the net displacement, spread across the
 *     clip, so the last key lands back on the first and the loop closes.
 *  2. **Re-centre along the travel axis.** After step 1 the run's hips sit half
 *     a metre of rig space ahead of the idle's, because the retarget's ramp
 *     started from wherever the stride happened to begin. Left there, the body
 *     jumps ~29 world units the moment the blend crosses between them. So the
 *     along-axis component is slid until its mean is the bone's *rest* value,
 *     which is the one thing every clip of a rig agrees about.
 *
 * Only the along-axis component is touched. The perpendicular components come
 * through key for key, which is what keeps the vertical bob of a walk, the side
 * sway of an idle and the crouch a run holds its hips in -- all of which a
 * plain "delete the translation track" throws away along with the fault.
 *
 * `times` is used to spread the ramp when the keys are not evenly spaced. It is
 * optional because the loop closes either way; without it the ramp is spread by
 * key index, which is exact for the uniformly-baked output every retarget
 * produces.
 */
export function withoutTravel(
  values: ArrayLike<number>,
  rest: readonly [number, number, number],
  times?: ArrayLike<number>,
): number[] {
  const out = Array.from(values, Number);
  const travel = trackTravel(values);
  if (travel.distance === 0) return out;

  const keys = Math.floor(out.length / 3);
  const [ax, ay, az] = travel.axis;
  const span = times === undefined ? 0 : (times[keys - 1] ?? 0) - (times[0] ?? 0);

  let alongTotal = 0;
  for (let key = 0; key < keys; key += 1) {
    const at = key * 3;
    const u =
      times !== undefined && span > 0
        ? ((times[key] ?? 0) - (times[0] ?? 0)) / span
        : keys > 1
          ? key / (keys - 1)
          : 0;
    out[at + 0] = (out[at + 0] ?? 0) - ax * travel.distance * u;
    out[at + 1] = (out[at + 1] ?? 0) - ay * travel.distance * u;
    out[at + 2] = (out[at + 2] ?? 0) - az * travel.distance * u;
    alongTotal += (out[at + 0] ?? 0) * ax + (out[at + 1] ?? 0) * ay + (out[at + 2] ?? 0) * az;
  }

  const shift = (rest[0] * ax + rest[1] * ay + rest[2] * az) - alongTotal / keys;
  for (let key = 0; key < keys; key += 1) {
    const at = key * 3;
    out[at + 0] = (out[at + 0] ?? 0) + ax * shift;
    out[at + 1] = (out[at + 1] ?? 0) + ay * shift;
    out[at + 2] = (out[at + 2] ?? 0) + az * shift;
  }
  return out;
}

/** One node that goes somewhere over a clip and does not come back. */
export interface TravelChannel {
  readonly animation: string;
  readonly node: string;
  readonly distance: number;
}

/**
 * Every travelling translation channel in a clip's `.glb`, measured.
 *
 * The offline half of the rule, in the same file as the runtime half for the
 * same reason {@link rootMotionChannels} is: the gate and the importer must not
 * be able to disagree about what counts. This one has to read the *binary*
 * chunk, because a channel's displacement is in its accessor rather than in the
 * JSON -- which is precisely why nothing measured it until now.
 *
 * `minimum` is the caller's, because how far is far depends on what the rig was
 * exported at. Below it a channel is the noise a retarget leaves behind rather
 * than a stride.
 */
export function travelChannels(bytes: Uint8Array, minimum: number): readonly TravelChannel[] {
  const glb = splitGlb(bytes);
  const nodes = list(glb.json['nodes']).map(record);
  const animations = list(glb.json['animations']).map(record);

  const found: TravelChannel[] = [];
  for (const animation of animations) {
    const samplers = list(animation['samplers']).map(record);
    for (const channel of list(animation['channels']).map(record)) {
      const target = record(channel['target']);
      if (target['path'] !== 'translation') continue;
      const nodeIndex = target['node'];
      const sampler = samplers[Number(channel['sampler'])];
      if (typeof nodeIndex !== 'number' || sampler === undefined) continue;
      const output = sampler['output'];
      if (typeof output !== 'number') continue;

      const travel = trackTravel(readAccessor(glb, output));
      if (travel.distance < minimum) continue;
      found.push({
        animation: nameOf(animation['name']),
        node: nameOf(nodes[nodeIndex]?.['name']),
        distance: travel.distance,
      });
    }
  }
  return found;
}

/** One line a person can act on: which clip, which bone, and how far it went. */
export function travelMessage(unitId: string, clipId: string, node: string, distance: number): string {
  return (
    `${unitId}/${clipId}: "${node}" travels ${distance.toFixed(3)} over the clip and does not come back. ` +
    `The server owns where a body is, so the travel is taken out at import and the rest of the bone's ` +
    `motion is kept -- the clip will play in place. Re-export it with the travel locked if that is not ` +
    `what you meant.`
  );
}

/** One line a person can act on: which clip, which bone, and what to do. */
export function rootMotionMessage(unitId: string, clipId: string, bones: readonly string[]): string {
  return (
    `${unitId}/${clipId}: the clip animates ${bones.map((bone) => `"${bone}"`).join(', ')} in translation. ` +
    `The server owns where a body is, so root motion is stripped at import -- ` +
    `the clip will play in place. Re-export it with the root locked if that is not what you meant.`
  );
}

/**
 * The same document with its root translation channels taken out.
 *
 * Stripping at import was always the plan and is not enough on its own: the
 * *committed* clip still carries the travel, so `npm run validate:units` fails
 * on every generated clip, and the asset in the repository is not the thing the
 * game plays. Both are fixed by baking it out once, at export, where the file is
 * written anyway.
 *
 * Channels only. The sampler and its accessor are left where they are, orphaned
 * but valid -- pruning them means rebuilding the buffer, and a rewrite that
 * touches the binary chunk is a much larger promise than this needs to make.
 * The bytes cost nothing at runtime; three loads the channels, not the file.
 */
export function withoutRootMotion(
  gltf: Record<string, unknown>,
  roots: string | readonly string[],
): { readonly json: Record<string, unknown>; readonly removed: readonly RootMotionChannel[] } {
  const removed = rootMotionChannels(gltf, roots);
  if (removed.length === 0) return { json: gltf, removed };

  const wanted = new Set(typeof roots === 'string' ? [roots] : roots);
  const nodes = Array.isArray(gltf['nodes']) ? (gltf['nodes'] as { name?: unknown }[]) : [];
  const animations = Array.isArray(gltf['animations']) ? (gltf['animations'] as Record<string, unknown>[]) : [];

  const stripped = animations.map((animation) => {
    const channels = Array.isArray(animation['channels'])
      ? (animation['channels'] as { target?: { node?: unknown; path?: unknown } }[])
      : [];
    return {
      ...animation,
      channels: channels.filter((channel) => {
        const index = channel.target?.node;
        if (typeof index !== 'number' || channel.target?.path !== 'translation') return true;
        const name = nodes[index]?.name;
        return !wanted.has(typeof name === 'string' ? name : '');
      }),
    };
  });
  return { json: { ...gltf, animations: stripped }, removed };
}
