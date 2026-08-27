/**
 * What the spell cast has to be, asserted against the rig and the ability table
 * it was authored for (spec 231).
 *
 * The subject is the real `pig_a_pose_full.glb` off disk, for the reason
 * `pig-strike.test.ts` and `pig-shot.test.ts` both give about the same rig:
 * everything interesting is a fact about *that* skeleton -- how long its arms
 * are, where its chest sits, which way its hips face -- and a synthetic biped
 * would pass all of this while the pig cast a spell with its feet.
 *
 * Everything is measured through `poseAt`, the same function the committed
 * bytes were sampled from, so an assertion here is an assertion about the file.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_ABILITIES } from '../server/data/abilities.js';
import { SERVER_TICK_RATE } from '../server/config.js';
import { animatedBones, frameCount, poseAt } from './clip-author.js';
import { readGlbJson } from './glb.js';
import { readNodeTree, splitGlb, type GlbReadNode } from './glb-read.js';
import {
  CAST_CLIP_ID,
  CAST_DURATION_MS,
  CAST_EVENTS,
  CAST_KEY_MS,
  CAST_RELEASE_MS,
  PIG_CAST,
} from './pig-cast.js';
import { PIG_SHOT } from './pig-shot.js';
import { STRIKE_GUARD_LEGS } from './pig-strike.js';
import { bodyFrame, boneNode, intoBodyFrame, namingOf, type BodyFrame } from './pose.js';
import { poseWorldMatrices } from './skin.js';
import type { BoneRole, NamingSpec } from './naming.js';
import type { ClipLib, UnitDef } from './types.js';

const UNITS = join(process.cwd(), 'assets', 'units');
const MESH = join(UNITS, 'pig_a_pose_full', 'pig_a_pose_full.glb');
const CLIP = join(UNITS, 'clips', `${CAST_CLIP_ID}.glb`);

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

type Vec3 = readonly [number, number, number];

/** Where a bone sits at `ms`, in world terms. For distances between bones. */
function worldAt(ms: number, role: BoneRole): Vec3 {
  const m = poseWorldMatrices(nodes, poseAt(PIG_CAST, rig, ms))[need(role).index] ?? [];
  return [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0];
}

/** Where a bone sits at `ms`, in body axes from the hips. For "in front of". */
function placeAt(ms: number, role: BoneRole): { right: number; up: number; forward: number } {
  const world = poseWorldMatrices(nodes, poseAt(PIG_CAST, rig, ms));
  const m = world[need(role).index] ?? [];
  const at = world[need('hips').index] ?? [];
  return intoBodyFrame(frame, [
    (m[12] ?? 0) - (at[12] ?? 0),
    (m[13] ?? 0) - (at[13] ?? 0),
    (m[14] ?? 0) - (at[14] ?? 0),
  ]);
}

function span(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** How far apart the two hands are: what "gathered" and "spread" both mean. */
function apartAt(ms: number): number {
  return span(worldAt(ms, 'leftHand'), worldAt(ms, 'rightHand'));
}

/** How far the two hands are from the chest, averaged: what "extended" means. */
function reachAt(ms: number): number {
  const chest = worldAt(ms, 'chest');
  return (span(worldAt(ms, 'leftHand'), chest) + span(worldAt(ms, 'rightHand'), chest)) / 2;
}

/** How far both hands travelled over the 20ms ending at `ms`. */
function travelAt(ms: number): number {
  const before = Math.max(0, ms - STEP_MS);
  return (
    span(worldAt(ms, 'leftHand'), worldAt(before, 'leftHand')) +
    span(worldAt(ms, 'rightHand'), worldAt(before, 'rightHand'))
  );
}

const STEP_MS = 20;
const EVERY_20MS = Array.from({ length: CAST_DURATION_MS / STEP_MS + 1 }, (_, index) => index * STEP_MS);
const between = (from: number, to: number): number[] => EVERY_20MS.filter((ms) => ms > from && ms <= to);

describe('the cast lands on the wind-up it is being played against', () => {
  it('is authored where every spell in the table can reach it', () => {
    // The one number in the clip that is not a matter of taste. This clip is
    // *shared*, so it is rescaled per ability -- and the pig's `maxTimeScale`
    // is 2, so an ability whose wind-up is more than twice this release, or
    // less than half of it, would have to be dragged past the bound the
    // validator refuses for an authored one. A spell added outside the window
    // fails here rather than shipping as a twitch or as slow motion.
    const unit = JSON.parse(
      readFileSync(join(UNITS, 'pig_a_pose_full', 'pig_a_pose_full.unitdef.json'), 'utf8'),
    ) as UnitDef;
    const cast = ALL_ABILITIES.filter((ability) => ability.castLook !== undefined);
    expect(cast.length).toBeGreaterThan(0);
    for (const ability of cast) {
      const windupMs = ability.windupTicks * (1000 / SERVER_TICK_RATE);
      const rate = CAST_RELEASE_MS / windupMs;
      expect(Math.max(rate, 1 / rate)).toBeLessThanOrEqual(unit.maxTimeScale);
    }
  });

  it('sits inside the window that bound defines', () => {
    // The bound, said the other way round: the release has to be at least half
    // the longest wind-up and at most twice the shortest, or some spell in the
    // table cannot reach it.
    //
    // A *window* rather than the minimax point, deliberately. 850 was picked as
    // the geometric mean of the wind-ups as they stood (spec 231) and the table
    // has moved since -- spec 232 removed the two extremes it was measured
    // against, and the optimum is now 742. Pinning the optimum would mean
    // re-authoring a committed `.glb` every time a spell is added or removed,
    // for a change in the worst stretch of less than a fifth and one nobody can
    // see. What has to stay true is that every spell reaches it, and that is
    // the test above.
    const windups = ALL_ABILITIES.filter((ability) => ability.castLook !== undefined).map(
      (ability) => ability.windupTicks * (1000 / SERVER_TICK_RATE),
    );
    const unit = JSON.parse(
      readFileSync(join(UNITS, 'pig_a_pose_full', 'pig_a_pose_full.unitdef.json'), 'utf8'),
    ) as UnitDef;
    expect(CAST_RELEASE_MS).toBeGreaterThanOrEqual(Math.max(...windups) / unit.maxTimeScale);
    expect(CAST_RELEASE_MS).toBeLessThanOrEqual(Math.min(...windups) * unit.maxTimeScale);
  });

  it('marks the release where it is, in normalized time', () => {
    const impact = CAST_EVENTS.find((event) => event.name === 'swing.impact');
    expect(impact?.normalizedTime).toBeCloseTo(CAST_RELEASE_MS / CAST_DURATION_MS, 9);
  });

  it('is the clip the committed library says it is', () => {
    const lib = JSON.parse(readFileSync(join(UNITS, 'biped.core.cliplib.json'), 'utf8')) as ClipLib;
    const entry = lib.clips.find((clip) => clip.id === CAST_CLIP_ID);
    expect(entry?.durationMs).toBe(CAST_DURATION_MS);
    expect(entry?.loop).toBe(false);
    expect(entry?.events).toEqual(CAST_EVENTS.map((event) => ({ ...event })));
  });

  it('was written to disk from this table', () => {
    // The bytes are committed, so nothing forces them to still be what the
    // table says -- `npx tsx scripts/make-pig-cast.ts` is a thing a person
    // remembers to run. This is the reminder, and it costs one read.
    const json = readGlbJson(new Uint8Array(readFileSync(CLIP))) as {
      animations?: { samplers?: { input: number }[] }[];
      accessors?: { count?: number; max?: number[] }[];
    };
    const sampler = json.animations?.[0]?.samplers?.[0];
    const input = json.accessors?.[sampler?.input ?? -1];
    expect(input?.count).toBe(frameCount(PIG_CAST));
    expect((input?.max?.[0] ?? 0) * 1000).toBeCloseTo(CAST_DURATION_MS, 0);
  });

  it('lands the release on a sampled frame rather than between two', () => {
    // So the pose on the frame the spell exists is the authored pose. The
    // sampler spreads `frameCount` frames evenly over the duration, so this is
    // a statement about the pair of numbers rather than about either.
    const step = CAST_DURATION_MS / (frameCount(PIG_CAST) - 1);
    expect(CAST_RELEASE_MS / step).toBeCloseTo(Math.round(CAST_RELEASE_MS / step), 9);
  });
});

describe('the gather', () => {
  it('brings the hands in to the chest and together', () => {
    // Both halves, because either alone is a different pose: hands that came
    // together without coming in are a body clapping, and hands that came in
    // without coming together are a body folding its arms.
    expect(reachAt(CAST_KEY_MS.gather)).toBeLessThan(reachAt(0) - 0.02);
    expect(apartAt(CAST_KEY_MS.gather)).toBeLessThan(apartAt(0) * 0.6);
  });

  it('holds them there and creeps, rather than freezing', () => {
    // `pig-shot.ts` learned this at its anchor: a pose held perfectly still
    // through a readable commitment reads as a dropped frame rather than as a
    // body holding something back. Every frame of the coil moves, and none of
    // it moves as much as a frame of the extension.
    const coil = between(CAST_KEY_MS.gather, CAST_KEY_MS.focus);
    const fastest = Math.max(...between(CAST_KEY_MS.focus, CAST_KEY_MS.release).map(travelAt));
    for (const ms of coil) {
      expect(travelAt(ms)).toBeGreaterThan(0);
      expect(travelAt(ms)).toBeLessThan(fastest / 4);
    }
  });

  it('keeps closing the hands through the coil', () => {
    // The creep has a direction. Monotone rather than merely small, so a coil
    // that drifted back outwards would fail rather than average out.
    const coil = [CAST_KEY_MS.gather, ...between(CAST_KEY_MS.gather, CAST_KEY_MS.focus)];
    for (let index = 1; index < coil.length; index += 1) {
      expect(apartAt(coil[index] ?? 0)).toBeLessThanOrEqual(apartAt(coil[index - 1] ?? 0) + 1e-6);
    }
  });
});

describe('the release', () => {
  it('puts both hands out in front of the chest', () => {
    // What "extends the arms forward" means, said in the body's own axes: not
    // up, not out to the sides, in front. Half a chest's height clear of it,
    // so an arm merely raised would fail.
    const chest = placeAt(CAST_RELEASE_MS, 'chest');
    for (const role of ['leftHand', 'rightHand'] as const) {
      expect(placeAt(CAST_RELEASE_MS, role).forward - chest.forward).toBeGreaterThan(0.2);
    }
  });

  it('is further from the chest than any frame before it', () => {
    for (const ms of EVERY_20MS.filter((at) => at < CAST_RELEASE_MS)) {
      expect(reachAt(ms)).toBeLessThan(reachAt(CAST_RELEASE_MS));
    }
  });

  it('is the fastest movement of the cast', () => {
    // The strike's rule (`pig-strike.ts`): eased `in`, so the fastest instant
    // is the one the spell lands on. Measured up to the follow-through, which
    // is where the cast ends -- what the recovery does after that is the next
    // test's business.
    const peak = Math.max(...between(CAST_KEY_MS.focus, CAST_KEY_MS.release).map(travelAt));
    for (const ms of between(0, CAST_KEY_MS.focus)) expect(travelAt(ms)).toBeLessThan(peak);
    for (const ms of between(CAST_KEY_MS.release, CAST_KEY_MS.follow)) {
      expect(travelAt(ms)).toBeLessThanOrEqual(peak);
    }
  });

  it('overshoots and spreads rather than stopping where it arrived', () => {
    // A limb that stops where it hit has no weight in it. The hands go further
    // out and *apart*, which is the half that survives at forty pixels.
    expect(reachAt(CAST_KEY_MS.follow)).toBeGreaterThan(reachAt(CAST_RELEASE_MS));
    expect(apartAt(CAST_KEY_MS.follow)).toBeGreaterThan(apartAt(CAST_RELEASE_MS));
  });

  it('recovers more gently than it struck', () => {
    // The reason the clip is 1250ms rather than the swing's shape. A cast's
    // hands travel further coming home than going out -- the push starts from
    // the chest, which is already half way -- so at a 200ms settle the recovery
    // came back four times faster than the extension, which reads as the body
    // being yanked rather than as a follow-through.
    const peak = Math.max(...between(CAST_KEY_MS.focus, CAST_KEY_MS.release).map(travelAt));
    for (const ms of between(CAST_KEY_MS.follow, CAST_DURATION_MS)) {
      expect(travelAt(ms)).toBeLessThanOrEqual(peak);
    }
  });

  it('opens the body out of the coil rather than keeping it turned', () => {
    // Where it inverts the shot. An archer's chest keeps turning the same way
    // through the loose, because what sends an arrow is back tension; a cast is
    // thrown by the torso *un*winding, so the lean has to cross back through
    // upright. Measured on how far the chest is carried in front of the hips.
    const lean = (ms: number): number => placeAt(ms, 'chest').forward;
    expect(lean(CAST_KEY_MS.focus)).toBeGreaterThan(lean(0));
    expect(lean(CAST_RELEASE_MS)).toBeLessThan(lean(0));
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
      for (const ms of EVERY_20MS) expect(worldAt(ms, role)).toEqual(rest);
    }
  });

  it('stands on the same legs the swing and the draw do', () => {
    // All three clips are entered from the idle across a 60ms cross-fade, so
    // legs that disagreed would snap on the way in -- and it is the *same
    // object*, so this is really asserting that nobody has copied it apart.
    for (const key of PIG_CAST.keys) {
      for (const [role, turns] of Object.entries(STRIKE_GUARD_LEGS)) {
        expect((key.turns as Record<string, unknown>)[role]).toEqual(turns);
      }
    }
  });

  it('carries the same hips the draw does', () => {
    // The one number of the stance that is not in the shared object. Asserted
    // against the shot's rather than restated, so the two cannot drift.
    const hipsOf = (turns: unknown): unknown => (turns as Record<string, unknown>)['hips'];
    for (const key of PIG_CAST.keys) expect(hipsOf(key.turns)).toEqual(hipsOf(PIG_SHOT.keys[0]?.turns));
  });

  it('begins and ends in the same pose', () => {
    // So a cast thrown at the end of a cast has nothing to jump over.
    const first = PIG_CAST.keys[0];
    const last = PIG_CAST.keys[PIG_CAST.keys.length - 1];
    expect(first?.atMs).toBe(0);
    expect(last?.atMs).toBe(CAST_DURATION_MS);
    expect(last?.turns).toBe(first?.turns);
  });
});

describe('the table', () => {
  it('animates both arms, the torso and both legs, and nothing it has no bone for', () => {
    const bones = animatedBones(PIG_CAST, rig);
    expect(bones.length).toBe(new Set(bones).size);
    for (const role of ['leftHand', 'rightHand', 'leftArm', 'rightArm', 'chest', 'head', 'leftFoot'] as const) {
      expect(bones).toContain(need(role).name);
    }
  });

  it('samples at 60Hz, because the extension is eight frames long', () => {
    expect(PIG_CAST.fps).toBe(60);
    expect(CAST_RELEASE_MS - CAST_KEY_MS.focus).toBeLessThanOrEqual(150);
  });

  it('is ascending, starts at zero and ends on the duration', () => {
    for (let index = 1; index < PIG_CAST.keys.length; index += 1) {
      expect(PIG_CAST.keys[index]?.atMs).toBeGreaterThan(PIG_CAST.keys[index - 1]?.atMs ?? 0);
    }
    expect(Object.values(CAST_KEY_MS)).toEqual(PIG_CAST.keys.map((key) => key.atMs));
  });
});
