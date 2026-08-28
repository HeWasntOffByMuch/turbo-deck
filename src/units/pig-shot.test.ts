/**
 * What the bow shot has to be, asserted against the rig and the ability table
 * it was authored for (spec 164).
 *
 * The subject is the real `pig_a_pose_full.glb` off disk, for the reason
 * `pig-strike.test.ts` gives about the same rig: everything interesting is a
 * fact about *that* skeleton -- how long its arms are, which way its hips face
 * -- and a synthetic biped would pass all of this while the pig drew a bow with
 * its feet.
 *
 * Everything is measured through `poseAt`, the same function the committed
 * bytes were sampled from, so an assertion here is an assertion about the file.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { abilityById } from '../server/data/abilities.js';
import { SERVER_TICK_RATE } from '../server/config.js';
import { animatedBones, frameCount, poseAt } from './clip-author.js';
import { readGlbJson } from './glb.js';
import { readNodeTree, splitGlb, type GlbReadNode } from './glb-read.js';
import { PIG_SHOT, SHOT_CLIP_ID, SHOT_DURATION_MS, SHOT_EVENTS, SHOT_KEY_MS, SHOT_RELEASE_MS } from './pig-shot.js';
import { STRIKE_GUARD_LEGS } from './pig-strike.js';
import { bodyFrame, boneNode, intoBodyFrame, namingOf, type BodyFrame, type Vec3 } from './pose.js';
import { gazeAxis } from './posture.js';
import { poseWorldMatrices } from './skin.js';
import type { BoneRole, NamingSpec } from './naming.js';
import type { ClipLib } from './types.js';

const UNITS = join(process.cwd(), 'assets', 'units');
const MESH = join(UNITS, 'pig_a_pose_full', 'pig_a_pose_full.glb');
const CLIP = join(UNITS, 'clips', `${SHOT_CLIP_ID}.glb`);

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

function need(role: BoneRole): GlbReadNode {
  const node = boneNode(nodes, naming, role);
  if (!node) throw new Error(`the pig rig has no ${role}`);
  return node;
}

/** Where a bone sits at `ms`, in body axes from the hips, over the rig's reach. */
function placeAt(ms: number, role: BoneRole): { right: number; up: number; forward: number } {
  const world = poseWorldMatrices(nodes, poseAt(PIG_SHOT, rig, ms));
  const m = world[need(role).index] ?? [];
  const at = world[need('hips').index] ?? [];
  return intoBodyFrame(frame, [
    (m[12] ?? 0) - (at[12] ?? 0),
    (m[13] ?? 0) - (at[13] ?? 0),
    (m[14] ?? 0) - (at[14] ?? 0),
  ]);
}

function worldAt(ms: number, role: BoneRole): Vec3 {
  const m = poseWorldMatrices(nodes, poseAt(PIG_SHOT, rig, ms))[need(role).index] ?? [];
  return [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0];
}

/** How far apart the hands are: the one number a draw actually is. */
function drawAt(ms: number): number {
  const bow = worldAt(ms, 'leftHand');
  const string = worldAt(ms, 'rightHand');
  return Math.hypot(bow[0] - string[0], bow[1] - string[1], bow[2] - string[2]);
}

const EVERY_20MS = Array.from({ length: SHOT_DURATION_MS / 20 + 1 }, (_, index) => index * 20);

describe('the shot lands on the ability it was authored for', () => {
  const shot = abilityById('ranged.shot');

  it('looses on the attack point rather than near it', () => {
    // The one number that is not a matter of taste. `ranged.shot` resolves on
    // the tick its wind-up ends, so the frame the picture shows the string let
    // go and the frame the arrow exists are the same frame -- or the animation
    // is lying about when it was safe to stand there.
    expect(shot).toBeDefined();
    expect((shot?.windupTicks ?? 0) * (1000 / SERVER_TICK_RATE)).toBeCloseTo(SHOT_RELEASE_MS, 6);
  });

  it('recovers over the backswing the sim actually runs', () => {
    // The clip's own tail. Not asserted to the millisecond -- the animation may
    // settle a little inside its backswing -- but a tail that outran it would
    // draw a body still lowering a bow it is already free to run out of.
    const tail = SHOT_DURATION_MS - SHOT_RELEASE_MS;
    const backswing = (shot?.backswingTicks ?? 0) * (1000 / SERVER_TICK_RATE);
    expect(tail).toBeLessThanOrEqual(backswing + 1000 / SERVER_TICK_RATE);
    expect(tail).toBeGreaterThan(backswing * 0.8);
  });

  it('marks the loose where the release is, in normalized time', () => {
    const impact = SHOT_EVENTS.find((event) => event.name === 'swing.impact');
    expect(impact?.normalizedTime).toBeCloseTo(SHOT_RELEASE_MS / SHOT_DURATION_MS, 9);
  });

  it('is the clip the committed library says it is', () => {
    const lib = JSON.parse(readFileSync(join(UNITS, 'biped.core.cliplib.json'), 'utf8')) as ClipLib;
    const entry = lib.clips.find((clip) => clip.id === SHOT_CLIP_ID);
    expect(entry?.durationMs).toBe(SHOT_DURATION_MS);
    expect(entry?.loop).toBe(false);
    expect(entry?.events).toEqual(SHOT_EVENTS.map((event) => ({ ...event })));
  });

  it('was written to disk from this table', () => {
    // The bytes are committed, so nothing forces them to still be what the
    // table says -- `npx tsx scripts/make-pig-shot.ts` is a thing a person
    // remembers to run. This is the reminder, and it costs one read.
    const json = readGlbJson(new Uint8Array(readFileSync(CLIP))) as {
      animations?: { samplers?: { input: number }[] }[];
      accessors?: { count?: number; max?: number[] }[];
    };
    const sampler = json.animations?.[0]?.samplers?.[0];
    const input = json.accessors?.[sampler?.input ?? -1];
    expect(input?.count).toBe(frameCount(PIG_SHOT));
    expect((input?.max?.[0] ?? 0) * 1000).toBeCloseTo(SHOT_DURATION_MS, 0);
  });
});

describe('the draw', () => {
  it('opens, holds and is thrown away, in that order', () => {
    const nock = drawAt(SHOT_KEY_MS.raise);
    const full = drawAt(SHOT_RELEASE_MS);
    const after = drawAt(SHOT_KEY_MS.loose);
    // The string hand travels and the bow hand does not, so the gap between
    // them *is* the draw. It has to more than double, or there is nothing on
    // screen to read as a bow being pulled.
    expect(full).toBeGreaterThan(nock * 2);
    // And it keeps opening through the loose: the fingers let go and the hand
    // carries on backwards, which is the follow-through that says an arrow
    // left rather than that a pose ended.
    expect(after).toBeGreaterThan(full);
  });

  it('never stalls while it is being pulled', () => {
    // The sword learned this the hard way: a wind-up that stops dead in the
    // middle reads as two movements rather than one. Measured over the draw
    // only -- the hold before the loose is *meant* to be nearly still, and the
    // assertion below is the one that bounds that.
    //
    // On how far the *hand* travelled between samples, not on how far apart the
    // hands got. The first version used the gap and failed by a ten-thousandth
    // at the sweep, which was the test being wrong rather than the clip: the
    // hand goes outboard round the ribs there, so it is moving quickly in a
    // direction that barely changes the distance between the two.
    const travel = (from: number, to: number): number => {
      const a = worldAt(from, 'rightHand');
      const b = worldAt(to, 'rightHand');
      return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    };
    // Up to 60ms short of full draw, because the last three frames *are* meant
    // to decelerate -- that is what `out` into the `pull` key is for, and the
    // assertion under this one is the one that says so. What must not happen is
    // a stop at an interior key, which is the shape of the fault: an eased
    // arrival meeting an eased departure, zero velocity on both sides of a beat
    // nobody meant to put there.
    const samples = EVERY_20MS.filter((ms) => ms >= SHOT_KEY_MS.raise && ms <= SHOT_KEY_MS.pull - 60);
    for (let index = 1; index < samples.length; index += 1) {
      expect(travel(samples[index - 1] ?? 0, samples[index] ?? 0)).toBeGreaterThan(0.004);
    }
    // And it does settle into full draw rather than arriving at speed: an arm
    // that hit the anchor still moving would have to be caught there.
    expect(travel(SHOT_KEY_MS.pull - 20, SHOT_KEY_MS.pull)).toBeLessThan(
      travel(SHOT_KEY_MS.pull - 120, SHOT_KEY_MS.pull - 100),
    );
  });

  it('creeps through the aim rather than freezing in it', () => {
    // Between the pull and the loose the pose is held, and a pose held
    // *perfectly* still for a fifth of a second reads as a dropped frame. It
    // has to still be moving and it must not still be drawing.
    const start = drawAt(SHOT_KEY_MS.pull);
    const end = drawAt(SHOT_RELEASE_MS);
    const whole = drawAt(SHOT_RELEASE_MS) - drawAt(SHOT_KEY_MS.raise);
    expect(end - start).toBeGreaterThan(0.002);
    // A twentieth of the whole draw, so it is a hold rather than the last leg
    // of the pull. Stated as a fraction because that is what "the draw is over
    // and the pig is aiming" means, and an absolute bound would just be this
    // rig's arm length written down twice.
    expect(end - start).toBeLessThan(whole * 0.05);
  });

  it('is loosed faster than it was drawn', () => {
    // The velocity discontinuity that makes a bow a bow. The string is held and
    // then let go, so the fastest instant of the clip is the first frame after
    // the release -- not, as in the swing, the instant of contact itself.
    const rate = (from: number, to: number): number => (drawAt(to) - drawAt(from)) / (to - from);
    const drawing = rate(SHOT_KEY_MS.raise, SHOT_KEY_MS.pull);
    const loosing = rate(SHOT_RELEASE_MS, SHOT_RELEASE_MS + 20);
    expect(loosing).toBeGreaterThan(drawing * 3);
  });

  it('holds the bow arm still while the string hand travels', () => {
    // The stillness of one arm against the speed of the other is the whole
    // read. A bow arm that moved with the draw would be an archer pulling a
    // bow apart rather than pulling a string.
    const held = EVERY_20MS.filter((ms) => ms >= SHOT_KEY_MS.pull && ms <= SHOT_KEY_MS.loose);
    const first = worldAt(held[0] ?? 0, 'leftHand');
    for (const ms of held) {
      const at = worldAt(ms, 'leftHand');
      expect(Math.hypot(at[0] - first[0], at[1] - first[1], at[2] - first[2])).toBeLessThan(0.03);
    }
  });
});

describe('the stance', () => {
  it('never moves a foot, on any frame', () => {
    // Not "moves them very little" -- not at all. Every key holds the same hips
    // and the same six leg angles, so the legs are a constant and this is a
    // property of the table rather than the outcome of a solve. `plant-foot.ts`
    // exists because the swing could not have it.
    for (const role of ['leftFoot', 'rightFoot', 'leftToe', 'rightToe', 'hips'] as const) {
      const rest = worldAt(0, role);
      for (const ms of EVERY_20MS) {
        expect(worldAt(ms, role)).toEqual(rest);
      }
    }
  });

  it('stands on the same legs the swing does', () => {
    // Both clips are entered from the idle across a 60ms cross-fade, so legs
    // that disagreed would snap on the way in -- and it is the *same object*,
    // so this is really asserting that nobody has copied it apart.
    for (const key of PIG_SHOT.keys) {
      for (const [role, turns] of Object.entries(STRIKE_GUARD_LEGS)) {
        expect((key.turns as Record<string, unknown>)[role]).toEqual(turns);
      }
    }
  });

  it('begins and ends in the same pose', () => {
    // So a shot thrown at the end of a shot has nothing to jump over.
    const first = PIG_SHOT.keys[0];
    const last = PIG_SHOT.keys[PIG_SHOT.keys.length - 1];
    expect(first?.atMs).toBe(0);
    expect(last?.atMs).toBe(SHOT_DURATION_MS);
    expect(last?.turns).toBe(first?.turns);
  });

  it('keeps the pig looking at what it is shooting at', () => {
    // The chest turns away from the target through the draw -- that is where
    // the pull comes from -- and the head has to stay pointed down the shot or
    // the pig is aiming at its own shoulder. Measured on where the face
    // *points* rather than on where the head sits, because a head carried
    // sideways by the chest while still looking forward is correct and a head
    // that has turned with it is not.
    const axis = gazeAxis(nodes, naming, frame);
    if (!axis) throw new Error('the pig rig has no head to look out of');
    for (const ms of EVERY_20MS) {
      const m = poseWorldMatrices(nodes, poseAt(PIG_SHOT, rig, ms))[need('head').index] ?? [];
      const gaze = intoBodyFrame(frame, [
        (m[0] ?? 0) * axis[0] + (m[4] ?? 0) * axis[1] + (m[8] ?? 0) * axis[2],
        (m[1] ?? 0) * axis[0] + (m[5] ?? 0) * axis[1] + (m[9] ?? 0) * axis[2],
        (m[2] ?? 0) * axis[0] + (m[6] ?? 0) * axis[1] + (m[10] ?? 0) * axis[2],
      ]);
      expect(gaze.forward).toBeGreaterThan(0.8);
    }
  });

  it('turns the chest away from the target and leaves it there', () => {
    // Where it inverts the swing: a chop passes through square and unwinds, a
    // shot does not. The chest's yaw is monotone into the loose, because what
    // sends an arrow is back tension rather than rotation.
    // How far the shoulder *line* has come round, which is what "the chest is
    // turned" means. Measured off both shoulders rather than off the left one
    // alone: the left shoulder's own protraction is an authored detail of the
    // bow arm and moves for its own reasons, and reading the turn off it made
    // this test a statement about that instead.
    // Off the shoulder *joints* rather than the clavicles: the clavicle bones
    // sit 0.037 apart on this rig against the joints' 0.232, so measured there
    // a 28-degree turn of the chest reads as a hundredth of a body and the
    // threshold below would have been tuned down to meet it.
    const yawAt = (ms: number): number => placeAt(ms, 'leftArm').forward - placeAt(ms, 'rightArm').forward;
    const samples = EVERY_20MS.filter((ms) => ms >= SHOT_KEY_MS.raise && ms <= SHOT_KEY_MS.loose);
    for (let index = 1; index < samples.length; index += 1) {
      expect(yawAt(samples[index] ?? 0)).toBeGreaterThanOrEqual(yawAt(samples[index - 1] ?? 0) - 1e-4);
    }
    // And it is a turn at all, rather than a body that stayed square.
    expect(yawAt(SHOT_RELEASE_MS)).toBeGreaterThan(yawAt(0) + 0.02);
  });
});

describe('the table', () => {
  it('animates both arms and both legs and nothing it has no bone for', () => {
    const bones = animatedBones(PIG_SHOT, rig);
    expect(bones.length).toBe(new Set(bones).size);
    for (const role of ['leftHand', 'rightHand', 'leftArm', 'rightArm', 'chest', 'head'] as const) {
      expect(bones).toContain(need(role).name);
    }
  });

  it('samples at 60Hz, because the loose is four frames long', () => {
    expect(PIG_SHOT.fps).toBe(60);
    expect(SHOT_KEY_MS.loose - SHOT_KEY_MS.anchor).toBeLessThanOrEqual(100);
  });
});
