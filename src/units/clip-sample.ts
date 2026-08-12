/**
 * A bought clip's pose at an instant, as offsets against the bind (spec 140).
 *
 * `clip-author.ts` samples a pose this project *wrote*. This samples one it
 * bought: it reads the rotation channels out of a retargeted `.glb` and returns
 * the same `PoseRotations` shape, so `poseWorldMatrices` can be pointed at
 * either and a measurement does not have to care which kind of clip it is
 * looking at.
 *
 * ## Why this exists
 *
 * A weapon socket's calibration is only exactly right at one pose, and choosing
 * *which* pose is the whole decision. It was calibrated against the swing's own
 * guard key -- a pose the pig is in for a few frames of an 800ms clip -- and
 * the pose it is in the rest of the time is `idle`, which nothing could measure
 * because nothing could sample a bought clip. The sword pointed forward for two
 * frames a swing and hung straight down the rest of the time.
 *
 * So: offsets rather than absolute rotations, because that is what the rest of
 * this directory means by a pose, and because it makes the two kinds of clip
 * directly comparable.
 *
 * Pure, and part of the deterministic core.
 */

import { readAccessor, type GlbBinary, type GlbReadNode } from './glb-read.js';
import type { PoseRotations } from './skin.js';

type Quat = readonly [number, number, number, number];

function multiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** Shortest-arc, because a clip's own keys can straddle the antipode. */
function slerp(a: Quat, b: Quat, t: number): Quat {
  let cosine = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let end: Quat = b;
  if (cosine < 0) {
    end = [-b[0], -b[1], -b[2], -b[3]];
    cosine = -cosine;
  }
  if (cosine > 0.9995) {
    const out: [number, number, number, number] = [
      a[0] + (end[0] - a[0]) * t,
      a[1] + (end[1] - a[1]) * t,
      a[2] + (end[2] - a[2]) * t,
      a[3] + (end[3] - a[3]) * t,
    ];
    const length = Math.hypot(...out) || 1;
    return [out[0] / length, out[1] / length, out[2] / length, out[3] / length];
  }
  const theta = Math.acos(Math.min(1, cosine));
  const sin = Math.sin(theta);
  return [
    (a[0] * Math.sin((1 - t) * theta) + end[0] * Math.sin(t * theta)) / sin,
    (a[1] * Math.sin((1 - t) * theta) + end[1] * Math.sin(t * theta)) / sin,
    (a[2] * Math.sin((1 - t) * theta) + end[2] * Math.sin(t * theta)) / sin,
    (a[3] * Math.sin((1 - t) * theta) + end[3] * Math.sin(t * theta)) / sin,
  ];
}

/**
 * Every rotation channel of a clip's first animation, at `seconds`.
 *
 * LINEAR between keys, which is what glTF's default is and what every clip in
 * this project carries -- `glb.ts` writes nothing else and the retarget returns
 * nothing else. A clip using CUBICSPLINE would be sampled slightly wrong here
 * and is not something this tree has.
 *
 * Bones the clip does not animate are absent, which means "leave at bind" to
 * `poseWorldMatrices` -- the same thing the mixer does with them.
 */
export function clipPoseAt(glb: GlbBinary, nodes: readonly GlbReadNode[], seconds: number): PoseRotations {
  const json = glb.json as {
    animations?: { channels?: { sampler: number; target: { node: number; path: string } }[]; samplers?: { input: number; output: number }[] }[];
    nodes?: { name?: string }[];
  };
  const animation = json.animations?.[0];
  const out = new Map<string, Quat>();
  if (!animation?.channels || !animation.samplers) return out;

  const byName = new Map(nodes.map((node) => [node.name, node]));
  for (const channel of animation.channels) {
    if (channel.target.path !== 'rotation') continue;
    const name = json.nodes?.[channel.target.node]?.name;
    const node = name === undefined ? undefined : byName.get(name);
    const sampler = animation.samplers[channel.sampler];
    if (!node || !sampler) continue;

    const times = readAccessor(glb, sampler.input);
    const values = readAccessor(glb, sampler.output);
    if (times.length === 0) continue;

    // The frame at or before `seconds`, and the fraction into the next.
    let index = 0;
    while (index < times.length - 1 && (times[index + 1] ?? 0) <= seconds) index += 1;
    const at = times[index] ?? 0;
    const next = times[index + 1];
    const span = next === undefined ? 0 : next - at;
    const t = span > 0 ? Math.max(0, Math.min(1, (seconds - at) / span)) : 0;

    const key = (frame: number): Quat => [
      values[frame * 4] ?? 0,
      values[frame * 4 + 1] ?? 0,
      values[frame * 4 + 2] ?? 0,
      values[frame * 4 + 3] ?? 1,
    ];
    const absolute = t > 0 ? slerp(key(index), key(index + 1), t) : key(index);

    // An offset, not the value: `bind^-1 * absolute`, so this composes the same
    // way an authored pose does and the two are directly comparable.
    const bind = node.rotation as Quat;
    out.set(node.name, multiply([-bind[0], -bind[1], -bind[2], bind[3]], absolute));
  }
  return out;
}

/** How long a clip's first animation runs, in seconds. */
export function clipDurationOf(glb: GlbBinary): number {
  const json = glb.json as {
    animations?: { samplers?: { input: number }[] }[];
    accessors?: { max?: number[] }[];
  };
  let longest = 0;
  for (const sampler of json.animations?.[0]?.samplers ?? []) {
    longest = Math.max(longest, json.accessors?.[sampler.input]?.max?.[0] ?? 0);
  }
  return longest;
}
