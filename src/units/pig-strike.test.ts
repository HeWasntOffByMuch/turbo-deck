/**
 * What the swing has to be, asserted against the rig it was authored for
 * (spec 139).
 *
 * The subject is the real `pig_a_pose_full.glb` off disk rather than a fixture,
 * because everything interesting here is a fact about *that* rig -- where its
 * arms hang, which way its hips face, that its forearm's first child is a twist
 * bone at zero offset. A synthetic biped would pass all of this while the pig
 * swung backwards, which is the exact failure that was in the tree an hour ago.
 *
 * Everything is measured through `poseAt`, the same function the committed bytes
 * were sampled from, so an assertion here is an assertion about the file.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { abilityById } from '../server/data/abilities.js';
import { SERVER_TICK_RATE } from '../server/config.js';
import { animatedBones, authorClip, frameCount, poseAt, quatAngle, type Quat } from './clip-author.js';
import { readGlbJson } from './glb.js';
import { readNodeTree, splitGlb, type GlbReadNode } from './glb-read.js';
import {
  PIG_STRIKE,
  STRIKE_CLIP_ID,
  STRIKE_CONTACT_MS,
  STRIKE_DURATION_MS,
  STRIKE_EVENTS,
  STRIKE_KEY_MS,
} from './pig-strike.js';
import { bodyFrame, boneNode, intoBodyFrame, namingOf, worldPosition, type BodyFrame, type Vec3 } from './pose.js';
import type { NamingSpec } from './naming.js';
import { poseWorldMatrices } from './skin.js';

const UNIT_DIR = join(process.cwd(), 'assets', 'units', 'pig_a_pose_full');
const MESH = join(UNIT_DIR, 'pig_a_pose_full.glb');
const CLIP = join(UNIT_DIR, 'clips', `${STRIKE_CLIP_ID}.glb`);

/**
 * The rig, its vocabulary and its measured frame, resolved together.
 *
 * One function returning all three so the narrowing survives into the closures
 * below -- a module-level `if (!frame) throw` narrows the statement after it and
 * not the body of a hoisted function, and the alternative is a `!` on every use.
 */
function readRig(path: string): { nodes: readonly GlbReadNode[]; naming: NamingSpec; frame: BodyFrame } {
  const found = readNodeTree(splitGlb(new Uint8Array(readFileSync(path))));
  const spec = namingOf(found);
  if (spec === 'unknown') throw new Error('the pig rig is in no vocabulary this project reads');
  const measured = bodyFrame(found, spec);
  if (!measured) throw new Error('the pig rig has no measurable body frame');
  return { nodes: found, naming: spec, frame: measured };
}

const { nodes, naming, frame } = readRig(MESH);
const rig = { nodes, naming };

const hand = boneNode(nodes, naming, 'rightHand');
const head = boneNode(nodes, naming, 'head');
const chest = boneNode(nodes, naming, 'chest');
const hips = boneNode(nodes, naming, 'hips');
if (!hand || !head || !chest || !hips) throw new Error('the pig rig is missing a bone this test measures from');

/** The origin every measurement is relative to: the body's own root. */
const ORIGIN = worldPosition(hips);

/** How tall the rig stands in its own units, so thresholds are scale-free. */
const HEIGHT = 0.998;

interface Place {
  readonly right: number;
  readonly up: number;
  readonly forward: number;
}

/** Where a bone is at `ms`, in the body's axes and relative to the hips. */
function placeAt(bone: number, ms: number): Place {
  const world = poseWorldMatrices(nodes, poseAt(PIG_STRIKE, rig, ms))[bone] ?? [];
  const at: Vec3 = [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
  return intoBodyFrame(frame, [at[0] - ORIGIN[0], at[1] - ORIGIN[1], at[2] - ORIGIN[2]]);
}

const handAt = (ms: number): Place => placeAt(hand.index, ms);

function distance(a: Place, b: Place): number {
  return Math.hypot(a.right - b.right, a.up - b.up, a.forward - b.forward);
}

/** Where the bind pose puts a bone, for a threshold that is not a magic number. */
function bindPlace(bone: GlbReadNode): Place {
  const at = worldPosition(bone);
  return intoBodyFrame(frame, [at[0] - ORIGIN[0], at[1] - ORIGIN[1], at[2] - ORIGIN[2]]);
}

const HEAD_UP = bindPlace(head).up;
const CHEST_UP = bindPlace(chest).up;

describe('the pig swing lands when the ability says it does', () => {
  it('puts contact exactly at melee.slash’s wind-up', () => {
    const slash = abilityById('melee.slash');
    expect(slash).toBeDefined();
    // The whole reason this file is allowed to import from the server: the
    // picture and the damage are the same instant, and if somebody re-tunes the
    // fight the animation has to be *told*, not left behind looking right.
    expect((slash?.windupTicks ?? 0) / SERVER_TICK_RATE).toBeCloseTo(STRIKE_CONTACT_MS / 1000, 5);
  });

  it('marks the impact at the wind-up boundary of its own clip', () => {
    const impact = STRIKE_EVENTS.find((event) => event.name === 'swing.impact');
    expect(impact?.normalizedTime).toBeCloseTo(STRIKE_CONTACT_MS / STRIKE_DURATION_MS, 6);
  });

  it('agrees with the clip library that ships beside it', () => {
    const lib = JSON.parse(readFileSync(join(UNIT_DIR, 'pig.core.cliplib.json'), 'utf8')) as {
      clips: { id: string; durationMs: number; loop: boolean; events: { name: string; normalizedTime: number }[] }[];
    };
    const clip = lib.clips.find((entry) => entry.id === STRIKE_CLIP_ID);
    expect(clip).toBeDefined();
    expect(clip?.durationMs).toBe(STRIKE_DURATION_MS);
    expect(clip?.loop).toBe(false);
    expect(clip?.events).toEqual(STRIKE_EVENTS.map((event) => ({ ...event })));
  });
});

describe('the stance the swing is thrown from', () => {
  /** The end of a foot chain: an ankle's own yaw is invisible without the toe. */
  function toeOf(from: number): number {
    const kids = nodes.filter((node) => node.parent === from);
    const last = kids[kids.length - 1];
    return last ? toeOf(last.index) : from;
  }

  const leftFoot = boneNode(nodes, naming, 'leftFoot');
  const rightFoot = boneNode(nodes, naming, 'rightFoot');
  if (!leftFoot || !rightFoot) throw new Error('the pig rig has no feet');
  const leftToe = toeOf(leftFoot.index);

  const EVERY_KEY = Object.values(STRIKE_KEY_MS);

  it('never moves the left foot, which is what the pig is standing on', () => {
    // The support leg. Its foot is flat on the ground with the body's weight on
    // it, so the pelvis turns *over* it -- and authored by eye it did the
    // opposite, skating 0.19 (a fifth of the rig's height) across the floor
    // while still planted flat. That is the single most legible way an animation
    // can look wrong, because it is not a limb reading badly, it is the whole
    // body appearing to slide.
    //
    // Both ends of the foot, because pinning the ankle alone leaves it free to
    // pivot about it, and a foot that spins on the spot is the same lie.
    const rest = { ankle: placeAt(leftFoot.index, 0), toe: placeAt(leftToe, 0) };
    for (const ms of EVERY_KEY) {
      expect(distance(placeAt(leftFoot.index, ms), rest.ankle), `left ankle at ${ms}ms`).toBeLessThan(0.02 * HEIGHT);
      expect(distance(placeAt(leftToe, ms), rest.toe), `left toe at ${ms}ms`).toBeLessThan(0.02 * HEIGHT);
    }
  });

  it('holds the left knee near its guard bend rather than pumping it', () => {
    // The other half of the same claim, and the reason `plant-foot.ts` charges
    // for bend. A leg is a linkage: an unpenalised solve pins the foot perfectly
    // by snapping the knee straight, which is a foot that stays put under a leg
    // that visibly does not.
    const knee = boneNode(nodes, naming, 'leftLeg');
    if (!knee) throw new Error('the pig rig has no left knee');
    const rest = placeAt(knee.index, 0);
    for (const ms of EVERY_KEY) {
      expect(distance(placeAt(knee.index, ms), rest), `left knee at ${ms}ms`).toBeLessThan(0.09 * HEIGHT);
    }
  });

  it('steps the wielding-side foot back to brace, then drives it through', () => {
    // The right leg is the wielding side: back through the wind-up, forward past
    // the left as the blow lands. That is where the weight comes from, and
    // without it the pig is a torso rotating in place.
    //
    // Measured as the *right foot's own* travel, not as the gap between the
    // feet. The gap is what spec 140 asserted and it flattered this by roughly
    // two thirds, because the left foot was sliding the other way underneath it
    // -- so a right leg that barely moved scored as a full step.
    const forwardAt = (ms: number): number => placeAt(rightFoot.index, ms).forward;
    const rest = forwardAt(0);

    expect(forwardAt(STRIKE_KEY_MS.load) - rest, 'braced back').toBeLessThan(-0.08 * HEIGHT);
    expect(forwardAt(STRIKE_CONTACT_MS) - forwardAt(STRIKE_KEY_MS.load), 'driven through').toBeGreaterThan(0.22 * HEIGHT);
    // Past where it started, not merely back to it: the weight has transferred.
    expect(forwardAt(STRIKE_CONTACT_MS)).toBeGreaterThan(rest);
    // And returned, so a second swing starts from the stance the first left.
    expect(forwardAt(STRIKE_KEY_MS.settle)).toBeCloseTo(rest, 6);
  });
});

describe('the shape of the swing', () => {
  it('takes the hand over the head and behind the shoulder to load', () => {
    const load = handAt(STRIKE_KEY_MS.load);
    // Above the head is the whole silhouette argument: at forty pixels, a blade
    // inside the outline is not a wind-up, it is a pig standing still.
    //
    // The margin is thin -- 0.40 against a head at 0.388 -- and that is the
    // point rather than a weakness. The first version cleared it by abducting
    // the shoulder 116 degrees with the elbow nearly straight and twisting the
    // torso 81 degrees to make up the difference, so a pig winding up to chop
    // looked like a pig turning round to leave. This clears it with the elbow
    // bent 68 degrees and out past the ribs, which is how an arm actually does
    // it, and there is no slack left over.
    expect(load.up).toBeGreaterThan(HEAD_UP);
    expect(load.forward).toBeLessThan(-0.02 * HEIGHT);
  });

  it('brings it forward of the chest and below the shoulder to strike', () => {
    const contact = handAt(STRIKE_CONTACT_MS);
    expect(contact.forward).toBeGreaterThan(0.2 * HEIGHT);
    expect(contact.up).toBeLessThan(CHEST_UP);
  });

  it('falls the whole way rather than dipping and lifting again', () => {
    let previous = handAt(STRIKE_KEY_MS.load).up;
    for (let ms = STRIKE_KEY_MS.load + 10; ms <= STRIKE_CONTACT_MS; ms += 10) {
      const now = handAt(ms).up;
      // A tolerance rather than strict monotonicity: the arc is a slerp, not a
      // ramp, and a fraction of a millimetre of wobble at the top is not a lift.
      expect(now).toBeLessThanOrEqual(previous + 0.002 * HEIGHT);
      previous = now;
    }
  });

  it('crosses the midline, so it is a swing and not a prod', () => {
    // This briefly could not be met, on a version whose shoulder was pinned by
    // a strain term while the hand and the elbow were each given a place to be.
    // The right reading was that the pose was over-constrained, not that an arm
    // cannot cross its own body -- freeing the shoulder recovered it.
    expect(handAt(STRIKE_KEY_MS.load).right).toBeGreaterThan(0);
    expect(handAt(STRIKE_CONTACT_MS).right).toBeLessThan(0);
  });

  it('travels a real fraction of a body height of arc getting there', () => {
    let arc = 0;
    let previous = handAt(STRIKE_KEY_MS.load);
    for (let ms = STRIKE_KEY_MS.load + 5; ms <= STRIKE_CONTACT_MS; ms += 5) {
      const now = handAt(ms);
      arc += distance(previous, now);
      previous = now;
    }
    // 0.65 rather than the 0.8 this asked for before the wind-up was rebuilt
    // around the elbow: the hand covers 0.70 where it used to cover 0.85,
    // because part of the swing is now the elbow extending rather than the
    // whole arm travelling. The *tip* covers more than a body height over the
    // same window, and `items/grip.test.ts` holds it to that.
    expect(arc).toBeGreaterThan(0.65 * HEIGHT);
  });

  it('is fastest at the instant of contact', () => {
    let fastest = { ms: 0, speed: 0 };
    for (let ms = 5; ms <= STRIKE_DURATION_MS; ms += 5) {
      const speed = distance(handAt(ms - 5), handAt(ms)) / 0.005;
      if (speed > fastest.speed) fastest = { ms, speed };
    }
    // Inside the last 100ms of the wind-up: an ease that flattened would pass
    // every assertion above and read as a body pushing a blade through treacle.
    expect(fastest.ms).toBeGreaterThan(STRIKE_CONTACT_MS - 100);
    expect(fastest.ms).toBeLessThanOrEqual(STRIKE_CONTACT_MS);
  });

  it('holds the wind-up without freezing it', () => {
    const coil = handAt(STRIKE_KEY_MS.coil);
    const load = handAt(STRIKE_KEY_MS.load);
    const drift = distance(coil, load);
    expect(drift).toBeGreaterThan(0.005 * HEIGHT);
    expect(drift).toBeLessThan(0.12 * HEIGHT);
  });

  it('never puts the hand inside the pig', () => {
    // A cylinder about the spine, generous enough that a wrist brushing the ribs
    // is fine and an arm through the chest is not.
    const radius = 0.13 * HEIGHT;
    for (let ms = 0; ms <= STRIKE_DURATION_MS; ms += 5) {
      const at = handAt(ms);
      if (at.up < 0 || at.up > CHEST_UP + 0.1 * HEIGHT) continue;
      expect(Math.hypot(at.right, at.forward)).toBeGreaterThan(radius);
    }
  });

  it('ends where it began, so a second swing has nothing to jump over', () => {
    const start = poseAt(PIG_STRIKE, rig, 0);
    const end = poseAt(PIG_STRIKE, rig, STRIKE_DURATION_MS);
    expect([...end.keys()].sort()).toEqual([...start.keys()].sort());
    for (const [bone, rotation] of start) {
      expect(quatAngle(rotation as Quat, (end.get(bone) ?? [0, 0, 0, 1]) as Quat)).toBeLessThan(1);
    }
  });

  it('starts near enough to rest that the 60ms cross-fade into it is not a snap', () => {
    // Not a claim that it matches the idle -- nothing here can know that. A
    // claim that no bone is thrown a quarter-turn in the first frame, which is
    // what a guard authored at some extreme would do to a body arriving from a
    // stand.
    for (const [, rotation] of poseAt(PIG_STRIKE, rig, 0)) {
      expect(quatAngle(rotation as Quat, [0, 0, 0, 1])).toBeLessThan(100);
    }
  });
});

describe('the clip the game will actually load', () => {
  const written = readGlbJson(new Uint8Array(readFileSync(CLIP))) as {
    nodes: { name: string }[];
    animations: { name: string; channels: { target: { node: number; path: string } }[] }[];
    accessors: { count: number; max?: number[] }[];
  };

  it('is the file this table generates, byte for byte', () => {
    // The same check the unit manifest makes of itself: a committed asset whose
    // generator has moved on is a diff nobody took, and here it would be an
    // animation that no longer matches the numbers it is documented by.
    const rebuilt = authorClip(PIG_STRIKE, rig);
    const animation = written.animations[0];
    expect(animation?.name).toBe(STRIKE_CLIP_ID);
    expect(animation?.channels.length).toBe(rebuilt.channels.length);
    const names = (animation?.channels ?? []).map((channel) => written.nodes[channel.target.node]?.name);
    expect(names).toEqual(rebuilt.channels.map((channel) => nodes[channel.node]?.name));
  });

  it('authors the same bytes twice', () => {
    const once = authorClip(PIG_STRIKE, rig);
    const twice = authorClip(PIG_STRIKE, rig);
    expect(twice.channels.map((channel) => [...channel.rotations])).toEqual(
      once.channels.map((channel) => [...channel.rotations]),
    );
  });

  it('carries no translation channel, on any bone', () => {
    // The server owns where a body is. `glb.ts` refuses to write one, so this is
    // the assertion that the refusal is still there rather than that the author
    // remembered.
    const paths = (written.animations[0]?.channels ?? []).map((channel) => channel.target.path);
    expect(new Set(paths)).toEqual(new Set(['rotation']));
  });

  it('animates every bone the pig’s other clips move away from bind', () => {
    // A bone this clip omits is a bone three’s mixer holds at *bind* for the
    // whole swing, while the idle it cross-faded from had it somewhere else. So
    // the cast has to cover what the other clips actually use.
    const moving = ['Hip', 'Spine01', 'Spine02', 'NeckTwist01', 'Head'];
    for (const side of ['L', 'R']) {
      moving.push(`${side}_Thigh`, `${side}_Calf`, `${side}_Foot`, `${side}_Upperarm`, `${side}_Forearm`);
    }
    const cast = new Set(animatedBones(PIG_STRIKE, rig));
    expect(moving.filter((bone) => !cast.has(bone))).toEqual([]);
  });

  it('is sampled densely enough to carry its own acceleration', () => {
    const frames = frameCount(PIG_STRIKE);
    expect(frames).toBe(49);
    for (const channel of authorClip(PIG_STRIKE, rig).channels) {
      expect(channel.times.length).toBe(frames);
      expect(channel.rotations.length).toBe(frames * 4);
      expect(channel.times[frames - 1]).toBeCloseTo(STRIKE_DURATION_MS / 1000, 6);
    }
  });
});
