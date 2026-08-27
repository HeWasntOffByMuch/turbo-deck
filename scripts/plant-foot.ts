/**
 * Solve the pig's combat stance, rather than author it (specs 143, 244).
 *
 *   npx tsx scripts/plant-foot.ts
 *
 * Spec 143 wrote this to stop the planted foot sliding, and it did: the left
 * ankle went from 0.19 rig units of drift to 0.013. What it could not see is
 * that it measured every target against *the guard key's own feet*, so wherever
 * that hand-authored pose put them was, by construction, correct. It put them
 * behind the pig and in the air -- the pelvis 157% of the way along its own
 * support span, past the leading toe, with both feet 0.03 above the ground the
 * idle stands on and the right foot climbing to 0.077 above it during the beat
 * documented as a brace. A foot that does not slide is not the same claim as a
 * foot that is standing on something.
 *
 * So spec 244 states the stance in world terms instead: where each foot is on
 * the floor, and how far the heel is off it. The guard is solved with everything
 * else rather than being the reference everything else is solved against, which
 * is what makes the answer a function of the brief and the rig alone -- the old
 * arrangement had the printed numbers depend on the numbers already pasted in.
 *
 * ## What the rig will and will not allow
 *
 * Measured off the bind pose: the left leg's thigh is 0.2337 and its shin
 * 0.1329, a reach of 0.3667, and its hip stands 0.3660 above the bind ankle. The
 * right is 0.1930 + 0.1495 = 0.3426 against a drop of 0.3415. **Both legs are
 * straight in bind and stand exactly as tall as they are long**, and `glb.ts`
 * refuses to write a translation channel because the server owns where a body
 * is -- so the root cannot drop to meet a bent knee.
 *
 * On this rig, therefore, **knee bend and foot height are the same quantity**.
 * Every degree costs altitude, a deep stance is not available at any price, and
 * the only two things actually free are where the foot is on the ground and how
 * far the heel rides above it. Those are the brief; the bend is read back out.
 *
 * The heel is the whole of the budget. This pig's foot is 0.0176 long and its
 * bind attitude already slopes 27 degrees down to the toe, so the ankle can rise
 * at most 0.0108 before the foot is vertical -- and that 0.0108 is worth about
 * 20 degrees of knee. Which is why the brief spends it where the leg is loaded
 * and leaves it at zero everywhere else.
 *
 * ## The four terms
 *
 * Same shape as `scripts/solve-grip.ts`: state the requirement, solve it
 * numerically, print the numbers to paste in, and let a test assert the property
 * rather than the numbers.
 *
 *  - **the miss**, against two points per foot -- the **ankle** and the **toe**
 *    -- because pinning the ankle alone leaves the foot free to pivot about it,
 *    and a foot that spins on the spot is the same lie as a foot that slides.
 *  - **the strain**, a price per degree of bend away from the guard, because a
 *    leg is a linkage and an unpenalised solve pins the foot perfectly by
 *    snapping the knee straight.
 *  - **the knee floor**, one-sided below {@link MIN_KNEE_BEND}. A ceiling is
 *    already imposed by the ground; what needs saying is that a leg may not lock
 *    out, which the old solve did at 10.4 degrees on the braced rear leg.
 *  - **the knee lead**, and this one is not optional. Six knobs put two points
 *    where they are asked, and one direction is left over: the leg may swivel
 *    about the line from its hip to its ankle, taking the knee out sideways or
 *    -- with nothing to stop it -- backwards. That freedom is exactly the
 *    unnatural bend, so the knee is required to point where a knee points.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyRotations, type BoneTurns, type PoseTable } from '../src/units/clip-author.js';
import { clipDurationOf, clipPoseAt } from '../src/units/clip-sample.js';
import { readNodeTree, splitGlb, type GlbReadNode } from '../src/units/glb-read.js';
import { PIG_STRIKE, STRIKE_KEY_MS } from '../src/units/pig-strike.js';
import {
  bodyFrame,
  boneNode,
  fromBodyFrame,
  intoBodyFrame,
  namingOf,
  worldPosition,
  type BodyFrame,
  type PoseAxis,
  type Vec3,
} from '../src/units/pose.js';
import { poseWorldMatrices } from '../src/units/skin.js';
import { legOf, legStanceOf, type Leg, type Side } from '../src/units/stance.js';
import type { BoneRole } from '../src/units/naming.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = join(repoRoot, 'assets', 'units', 'pig_a_pose_full');
const CLIP_DIR = join(repoRoot, 'assets', 'units', 'clips');

type KeyLabel = keyof typeof STRIKE_KEY_MS;

/** The knobs one leg is allowed to use, in the order they are printed. */
function knobsFor(side: Side): readonly { role: BoneRole; axis: PoseAxis }[] {
  const upLeg = `${side}UpLeg` as BoneRole;
  const leg = `${side}Leg` as BoneRole;
  const foot = `${side}Foot` as BoneRole;
  return [
    { role: upLeg, axis: 'lateral' },
    { role: upLeg, axis: 'forward' },
    { role: upLeg, axis: 'up' },
    { role: leg, axis: 'lateral' },
    { role: foot, axis: 'lateral' },
    { role: foot, axis: 'up' },
  ];
}

/** What one foot is asked to do at one key. */
interface FootBrief {
  /**
   * The ankle's fore-aft offset from the pelvis, in rig units.
   *
   * From the *pelvis* rather than from the hip joint, because balance is a
   * claim about the body's weight against its own base -- and because the hip
   * joint is not a fixed point: it sits 0.115 off the pelvis's axis, so the
   * swing's own yaw walks it 0.05 fore and aft across the clip.
   */
  readonly along: number;
  /**
   * How far the heel comes up, in degrees of foot pitch past its bind attitude.
   *
   * The toe stays on the floor either way. This is what buys knee bend on a rig
   * that cannot lower its hips, and it is what "the knee travels forward over
   * the foot" costs when the pelvis is not allowed to travel with it.
   *
   * Degrees rather than the rig units the ankle actually rises, because the
   * budget here is **anatomical and not geometric** and only one of the two says
   * so. Written as a height it looked generous: this foot is 0.0176 long, so the
   * ankle can rise 0.0108 before it is directly over the toe, and that 0.0108 is
   * worth 20 degrees of knee -- exactly the compression this stance wants. It is
   * also a foot standing at 79 degrees to the floor. A pointe is not a heel
   * lift, and the ankle would have had to turn 52 degrees to reach it. In
   * degrees the same budget reads as what it is: this pig's foot already slopes
   * 27 degrees down to the toe, and past about 30 more it is on tiptoe.
   */
  readonly heel: number;
}

/**
 * The stance, key by key, in world terms.
 *
 * The left is the support leg: it is planted at the guard and stays there, and
 * every number in its column is the same number, because the whole claim about
 * this foot is that it does not move. What moves is the heel, which comes up as
 * the body drives over it -- the pelvis yaws 45 degrees between the load and the
 * follow-through and carries the left hip 0.05 backwards with it, so a leg that
 * did nothing would be *straightening* into the blow. It was: 30.4 degrees at
 * the guard, 28.7 at the load, and the beat the weight is meant to sink into was
 * the beat the knee was least bent.
 *
 * The right is the wielding side and steps: back to brace, then through and past
 * the left as the blow lands. Its numbers are what the floor leaves, which is
 * less than spec 143 claimed -- that step was measured with the foot in the air,
 * and a foot in the air can be as far back as you like.
 */
const STANCE: Record<KeyLabel, Record<Side, FootBrief>> = {
  guard: { left: { along: 0.015, heel: 10 }, right: { along: -0.043, heel: 12 } },
  rise: { left: { along: 0.015, heel: 11 }, right: { along: -0.09, heel: 22 } },
  coil: { left: { along: 0.015, heel: 14 }, right: { along: -0.125, heel: 30 } },
  load: { left: { along: 0.015, heel: 14 }, right: { along: -0.13, heel: 30 } },
  contact: { left: { along: 0.015, heel: 22 }, right: { along: -0.015, heel: 20 } },
  follow: { left: { along: 0.015, heel: 22 }, right: { along: -0.008, heel: 16 } },
  settle: { left: { along: 0.015, heel: 10 }, right: { along: -0.043, heel: 12 } },
};

/**
 * The bend below which a leg reads as locked, in degrees.
 *
 * Not a taste: the idle -- the pose this pig spends its life in and the one all
 * three combat clips cross-fade from -- carries a median of 10.5 degrees on the
 * left and 15.4 on the right, and a *combat* stance that stood straighter than
 * standing about would be the wrong way round. 14 clears the idle's own left
 * knee and is reachable at every key of the brief above.
 */
const MIN_KNEE_BEND = 14;

/**
 * How much of the knee's offset from the hip-to-ankle line has to be forward.
 *
 * A fraction rather than a distance, because the offset itself is set by how
 * bent the knee is -- a nearly straight leg has almost none, and a length here
 * would quietly demand a bend the ground cannot pay for. 0.9 is "the knee points
 * forward, give or take the 25 degrees of splay a stance has anyway".
 */
const MIN_LEAD_FRACTION = 0.9;

/**
 * What a degree of bend is worth, in rig units of travel.
 *
 * Without this the solve is exact and the answer is nonsense: it pins the foot
 * to a thousandth of a unit by rotating the hip 73 degrees, because the leg is a
 * linkage and a linkage has many ways to put a point somewhere. A real leg
 * reaches the shortest way it can.
 *
 * The right leg is asked to move a third of a body, so the same weight would be
 * the solver arguing with the brief. It gets a third of it: enough to keep the
 * knee out of the linkage's stranger corners, not enough to resist the step.
 */
const PER_DEGREE: Record<Side, number> = { left: 0.0004, right: 0.0006 };

/**
 * And what one is worth in the guard's own solve, which is nearly nothing.
 *
 * The strain exists to pick among the poses that reach a target, and to hold the
 * other six keys near the stance they are a departure from. The guard has no
 * such pose to be near: its anchor is the bind, which is a straight-legged
 * A-pose, so at the full weight the term is an argument *against the stance* --
 * measured, it came to ten times the miss it was competing with, and the solver
 * bought a leg 11 degrees straighter than asked for by standing 0.0045 off the
 * floor. Small rather than zero, because it is also what keeps the descent out
 * of the linkage's stranger corners on the way there.
 */
const PER_DEGREE_GUARD = 0.00005;

/** What a degree of shortfall on the two one-sided rules is worth, likewise. */
const PER_DEGREE_LOCKED = 0.004;
const PER_UNIT_SIDEWAYS = 0.6;

function main(): void {
  const glb = splitGlb(new Uint8Array(readFileSync(join(UNIT_DIR, 'pig_a_pose_full.glb'))));
  const nodes = readNodeTree(glb);
  const naming = namingOf(nodes);
  if (naming === 'unknown') throw new Error('the pig rig is in no vocabulary this project reads');
  const frame = bodyFrame(nodes, naming);
  if (!frame) throw new Error('the pig rig has no measurable body frame');
  const rig = { nodes, naming } as const;

  const need = (role: BoneRole): GlbReadNode => {
    const node = boneNode(nodes, naming, role);
    if (!node) throw new Error(`the pig rig has no ${role}`);
    return node;
  };
  const at = (world: readonly (readonly number[])[], index: number): Vec3 => {
    const m = world[index] ?? [];
    return [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0];
  };
  const place = (point: Vec3): { right: number; up: number; forward: number } => intoBodyFrame(frame, point);

  const legs: Record<Side, Leg> = { left: legOf(nodes, naming, 'left'), right: legOf(nodes, naming, 'right') };

  const floor = idleFloor(nodes, frame, legs);
  const pelvis = place(worldPosition(need('hips'))).forward;

  const key = (label: KeyLabel): PoseTable => {
    const found = PIG_STRIKE.keys.find((entry) => entry.label === label);
    if (!found) throw new Error(`the strike has no ${label} key`);
    return found.turns;
  };

  console.log(`\n  the floor the idle stands on: left toe ${floor.left.toFixed(4)}, right ${floor.right.toFixed(4)}`);
  console.log(`  the pelvis, which does not move: ${pelvis.toFixed(4)}\n`);
  console.log('  along is the ankle against that pelvis, heel is degrees of foot pitch past bind,');
  console.log('  and bend is what the ground and the reach leave once both are paid for.\n');

  /** Every key's answer, so the paste-ready block can be printed in one piece. */
  const answers: Record<string, string[]> = {};

  for (const side of ['left', 'right'] as const) {
    const knobs = knobsFor(side);
    const leg = legs[side];
    const bind = {
      ankle: place(worldPosition(nodes[leg.ankle] as GlbReadNode)),
      toe: place(worldPosition(nodes[leg.toe] as GlbReadNode)),
    };
    /** Ankle minus toe, in the sagittal plane: the foot, as a rigid thing. */
    const back = { forward: bind.ankle.forward - bind.toe.forward, up: bind.ankle.up - bind.toe.up };
    const reach = Math.hypot(back.forward, back.up);

    /**
     * Where the two ends of the foot are asked to be.
     *
     * The toe is the ground contact and is placed first; the ankle then hangs
     * off it at the foot's own length, swung up by however much heel the brief
     * asks for. Stating it in that order is what makes "the heel comes up" a
     * rotation of a rigid foot about its toe rather than a foot that stretches.
     */
    const pitch = Math.asin(Math.min(1, back.up / reach));
    const targetOf = (brief: FootBrief): { ankle: Vec3; toe: Vec3 } => {
      const rise = reach * Math.sin(Math.min(Math.PI / 2, pitch + (brief.heel * Math.PI) / 180));
      const run = Math.sqrt(Math.max(0, reach * reach - rise * rise));
      const ankle = { right: bind.ankle.right, up: floor[side] + rise, forward: pelvis + brief.along };
      return {
        ankle: fromBodyFrame(frame, ankle),
        toe: fromBodyFrame(frame, {
          right: bind.toe.right,
          up: floor[side],
          forward: ankle.forward + run,
        }),
      };
    };

    const withKnobs = (turns: PoseTable, values: readonly number[]): PoseTable => {
      const out: Record<string, BoneTurns> = { ...(turns as Record<string, BoneTurns>) };
      knobs.forEach((knob, index) => {
        out[knob.role] = { ...(out[knob.role] ?? {}), [knob.axis]: values[index] ?? 0 };
      });
      return out as PoseTable;
    };

    const posedOf = (turns: PoseTable, values: readonly number[]) => {
      const world = poseWorldMatrices(nodes, keyRotations(rig, withKnobs(turns, values)));
      return { world, ankle: at(world, leg.ankle), toe: at(world, leg.toe) };
    };

    const gap = (a: Vec3, b: Vec3): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const missOf = (posed: { ankle: Vec3; toe: Vec3 }, want: { ankle: Vec3; toe: Vec3 }): number =>
      Math.sqrt((gap(posed.ankle, want.ankle) + gap(posed.toe, want.toe)) / 2);

    const cost = (
      turns: PoseTable,
      values: readonly number[],
      brief: FootBrief,
      anchor: readonly number[],
      perDegree: number,
    ): number => {
      const posed = posedOf(turns, values);
      let bend = 0;
      for (let index = 0; index < values.length; index += 1) {
        bend += ((values[index] ?? 0) - (anchor[index] ?? 0)) ** 2;
      }
      const knee = legStanceOf(frame, leg, posed.world);
      const locked = Math.max(0, MIN_KNEE_BEND - knee.bend);
      const sideways = Math.max(0, (MIN_LEAD_FRACTION - knee.lead) * knee.offset);
      return (
        missOf(posed, targetOf(brief)) ** 2 +
        perDegree ** 2 * bend +
        (PER_DEGREE_LOCKED * locked) ** 2 +
        (PER_UNIT_SIDEWAYS * sideways) ** 2
      );
    };

    const settle = (
      turns: PoseTable,
      brief: FootBrief,
      anchor: readonly number[],
      perDegree: number,
    ): readonly number[] => {
      let values = [...anchor];
      let best = cost(turns, values, brief, anchor, perDegree);
      // Coordinate descent with a shrinking step, from the anchor. Six angles
      // and a smooth objective: a gradient would be faster and this runs in
      // under a second. It starts small, because the answer is near where it
      // starts and a wide first step is how it found the 73-degree hip.
      for (let step = 2; step > 0.01; step /= 2) {
        let improving = true;
        while (improving) {
          improving = false;
          for (let index = 0; index < values.length; index += 1) {
            for (const direction of [step, -step]) {
              const trial = [...values];
              trial[index] = (trial[index] ?? 0) + direction;
              const score = cost(turns, trial, brief, anchor, perDegree);
              if (score < best - 1e-12) {
                best = score;
                values = trial;
                improving = true;
              }
            }
          }
        }
      }
      return values;
    };

    // The guard first, anchored at bind -- "a leg keeps its shape and bends only
    // as much as the ground makes it" -- and then everything else anchored at
    // the guard, which is the pose they are all a departure from. Both anchors
    // are outside this file's own output, so the script is idempotent: run it
    // twice and it prints the same numbers, where anchoring on the key's current
    // values ratchets the knee a few degrees every time.
    const rest = settle(key('guard'), STANCE.guard[side], new Array<number>(knobs.length).fill(0), PER_DEGREE_GUARD);

    console.log(`  the ${side} leg\n`);
    for (const label of Object.keys(STRIKE_KEY_MS) as KeyLabel[]) {
      const brief = STANCE[label][side];
      const values = label === 'guard' ? rest : settle(key(label), brief, rest, PER_DEGREE[side]);
      const posed = posedOf(key(label), values);
      const knee = legStanceOf(frame, leg, posed.world);
      const round = (value: number): number => Math.round(value * 10) / 10 + 0;
      const named = (index: number): string => `${knobs[index]?.axis ?? '?'}: ${round(values[index] ?? 0)}`;
      console.log(
        `  ${label.padEnd(8)} miss ${missOf(posed, targetOf(brief)).toFixed(4)} bend ${knee.bend.toFixed(1).padStart(5)} ` +
          `lead ${knee.lead.toFixed(2)}`,
      );
      (answers[label] ??= []).push(
        `    ${side}UpLeg: { ${named(0)}, ${named(1)}, ${named(2)} },\n` +
          `    ${side}Leg: { ${named(3)} },\n` +
          `    ${side}Foot: { ${named(4)}, ${named(5)} },`,
      );
    }
    console.log('');
  }

  // Printed as the block rather than as six numbers a line, because the answer
  // is thirty-six of them and the failure mode of a table this size is a
  // transcription nobody can see: a leg is still a leg with one digit wrong.
  console.log('  paste into pig-strike.ts:\n');
  for (const label of Object.keys(STRIKE_KEY_MS) as KeyLabel[]) {
    if (label === 'settle') continue;
    console.log(`  ${label === 'guard' ? 'STRIKE_GUARD_LEGS = {' : `${label}: {`}`);
    console.log((answers[label] ?? []).join('\n'));
    console.log(label === 'guard' ? '  } as const satisfies PoseTable;\n' : '  },');
  }
}

/**
 * The height each foot rests at in the idle, which is the floor.
 *
 * Measured rather than typed, and off the *idle* rather than off the bind pose,
 * for the reason the guard is documented as being close to the idle in the first
 * place: it is the pose the game shows, the pose all three combat clips
 * cross-fade from, and therefore the one a viewer's eye takes the ground from. A
 * combat stance whose feet rest higher than the idle's is a body hovering, and
 * it does not matter that a constant somewhere would have called that zero.
 *
 * The median across the clip, because an idle shifts its weight -- the pig picks
 * each foot up a little -- and the height it *rests* at is what is wanted rather
 * than the lowest it ever reaches.
 */
function idleFloor(
  nodes: readonly GlbReadNode[],
  frame: BodyFrame,
  legs: Record<Side, Leg>,
): Record<Side, number> {
  const glb = splitGlb(new Uint8Array(readFileSync(join(CLIP_DIR, 'idle.glb'))));
  const duration = clipDurationOf(glb);
  const seen: Record<Side, number[]> = { left: [], right: [] };
  const samples = 200;
  for (let index = 0; index <= samples; index += 1) {
    const world = poseWorldMatrices(nodes, clipPoseAt(glb, nodes, (duration * index) / samples));
    for (const side of ['left', 'right'] as const) {
      const m = world[legs[side].toe] ?? [];
      seen[side].push(intoBodyFrame(frame, [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0]).up);
    }
  }
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  return { left: median(seen.left), right: median(seen.right) };
}

main();
