/**
 * Put a rig's hand where an author says it goes, and answer with the arm (spec 230).
 *
 * This is `aim-bow.ts`'s solver, lifted out of it so a second clip can use it
 * without a second copy. Nothing about the arithmetic moved: the same cost, the
 * same weights, the same joint limit, the same seeds, the same tidy-up. What
 * moved is the decision about *which* clip and which targets, which is now the
 * caller's -- so `aim-bow.ts` is a table of bow targets and `aim-cast.ts` is a
 * table of cast targets, and the thing that answers them is one function.
 *
 * ## The elbow is derived, not wished for
 *
 * `aim-blade.ts` learned that a hand target and an elbow target are a *linkage*
 * rather than two wishes: asked for a pair 0.071 apart on an arm whose segments
 * are 0.178 and 0.114, its solver split the difference and put the elbow in the
 * ribs rather than reporting that it could not have both.
 *
 * So an author states the hand and a **roll** -- how far round the
 * shoulder-to-hand axis the elbow sits, with zero hanging straight down -- and
 * {@link elbowFor} computes the only elbow consistent with it. A pose that does
 * not close is then impossible to write rather than merely visible later, and
 * what is left to choose is the one thing that genuinely is a choice.
 *
 * ## What it answers with
 *
 * The four angles, and the miss for the hand and for the elbow in rig units,
 * and the elbow's fold in degrees -- because the fold is the number that
 * decides whether an arm reads. On the pig the right arm is 0.178 and 0.114
 * against a body standing 0.998, so a hand closer than about 0.156 to its own
 * shoulder is folded past 120 degrees. Reported rather than remembered.
 *
 * Dev tooling: not part of the build, and not imported by anything under `src/`.
 */

import { readFileSync } from 'node:fs';
import { keyRotations, quatAngle, type BoneTurns, type PoseTable, type Quat } from '../src/units/clip-author.js';
import { readNodeTree, splitGlb } from '../src/units/glb-read.js';
import { bodyFrame, boneNode, intoBodyFrame, namingOf, type PoseAxis, type Vec3 } from '../src/units/pose.js';
import { poseWorldMatrices } from '../src/units/skin.js';
import type { BoneRole } from '../src/units/naming.js';

export type Side = 'left' | 'right';

export interface ArmTarget {
  /** Where the hand goes, `[right, up, forward]` from the hips, over height. */
  readonly hand: Vec3;
  /**
   * Where the elbow sits around the shoulder-to-hand axis, in degrees.
   *
   * 0 hangs it straight down, which is where an arm at rest puts it. Positive
   * carries it toward the body's right.
   */
  readonly roll: number;
}

/** One key of one arm, as the solver left it. */
export interface SolvedArm {
  readonly label: string;
  /** The four {@link ARM_AXES} values, in that order. */
  readonly values: readonly number[];
  /** How far the hand ended up from where it was asked for, in rig units. */
  readonly handMiss: number;
  /** The same for the elbow the roll implied. */
  readonly elbowMiss: number;
  /** How far the elbow is folded, in degrees. 0 is a straight arm. */
  readonly fold: number;
  /** How far the shoulder turned since the key before, in degrees. */
  readonly turn: number;
}

/**
 * What the solve may move.
 *
 * The wrist is not in here, and that is deliberate rather than an omission. A
 * hand's *orientation* is only meaningful against something it is holding, and
 * a solved wrist angle with nothing measuring it is an unconstrained variable
 * dressed up as an answer. Hand angles stay wherever the table's author put
 * them.
 */
export const ARM_AXES: readonly { part: 'Arm' | 'ForeArm'; axis: PoseAxis }[] = [
  { part: 'Arm', axis: 'lateral' },
  { part: 'Arm', axis: 'forward' },
  { part: 'Arm', axis: 'up' },
  { part: 'ForeArm', axis: 'flex' },
];

/** How far an elbow may fold. A pig's arm is short and a draw folds it hard. */
export const ELBOW_RANGE = { min: 0, max: 138 } as const;

/**
 * What a rig unit of misplacement is worth, against a degree of strain.
 *
 * The same exchange rate `aim-blade.ts` uses, and it means the same thing: a
 * tenth of a body out of position costs what thirteen degrees of a wrist bent
 * away from its rest costs. Enough to decide between two arms that reach the
 * place equally well; not enough to bend the pose to satisfy a number typed in
 * a table.
 */
const PER_UNIT = 130;

/**
 * What a degree of shoulder detour costs, against a rig unit of misplacement.
 *
 * Measured as the **angle between the shoulder's rotation at this key and at
 * the one before**, not as a distance in the three authored numbers. Those are
 * an intrinsic euler triple, so the same rotation has more than one spelling
 * and two triples 160 apart can be nearly the same arm -- charging the numbers
 * charges the spelling.
 *
 * It is the term that stops the solve reaching a place by the scenic route.
 * Uncharged, the bow's draw swung the shoulder through 160 degrees between two
 * consecutive keys to gain a hundredth of a unit of reach, which is an elbow
 * thrown round the body on the way to the same anchor. At this weight a
 * 30-degree detour costs what a hundredth of misplacement does.
 */
const PER_DETOUR = 0.03;

export const roleFor = (side: Side, part: 'Arm' | 'ForeArm' | 'Hand'): BoneRole =>
  (side === 'left' ? `left${part}` : `right${part}`) as BoneRole;

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function unit(a: Vec3): Vec3 {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * The one elbow consistent with a shoulder, a hand and a roll.
 *
 * Two spheres intersect in a circle; the roll picks a point on it. The hand is
 * pulled back inside the arm's own reach first rather than the circle being
 * allowed to come out imaginary, so an over-ambitious target degrades into the
 * furthest reachable pose in the same direction instead of into a NaN.
 */
export function elbowFor(shoulder: Vec3, hand: Vec3, upper: number, fore: number, rollDeg: number): Vec3 {
  const span = sub(hand, shoulder);
  const reach = Math.min(Math.max(length(span), Math.abs(upper - fore) + 1e-4), (upper + fore) * 0.9995);
  const along = unit(span);
  const at = (upper * upper + reach * reach - fore * fore) / (2 * reach);
  const radius = Math.sqrt(Math.max(0, upper * upper - at * at));
  const base = add(shoulder, scale(along, at));

  // The circle's own axes: `down` first, so a roll of zero is an arm hanging.
  const down: Vec3 = [0, -1, 0];
  const hanging = unit(sub(down, scale(along, dot(down, along))));
  const sideways = cross(along, hanging);
  const roll = (rollDeg * Math.PI) / 180;
  return add(base, add(scale(hanging, radius * Math.cos(roll)), scale(sideways, radius * Math.sin(roll))));
}

/** One key of the clip being solved: what it is called, and the pose it is. */
export interface SolveKey {
  readonly label: string;
  readonly turns: PoseTable;
}

export interface SolveOptions {
  /** The `.glb` the arm is measured off -- the mesh, so the bind rotations are real. */
  readonly meshPath: string;
  /** How tall the rig stands in its own units, so every target is scale-free. */
  readonly rigHeight: number;
  /**
   * The keys to solve, in clip order.
   *
   * The **first is the anchor**: its arm is read out of the table rather than
   * solved, and every key after it is pulled toward the one before, so
   * consecutive keys stay in the same part of the arm's answer family and a
   * creep does not become a swing. A key with no entry in `targets` is skipped
   * and does not break the chain -- which is how a clip whose last key is the
   * same object as its first avoids being solved twice to two different arms.
   */
  readonly keys: readonly SolveKey[];
  readonly targets: Readonly<Record<string, Readonly<Record<Side, ArmTarget>>>>;
}

/** How long each segment of one arm is, measured off the rig in the anchor pose. */
export interface ArmSegments {
  readonly upper: number;
  readonly fore: number;
}

export interface ArmSolution {
  readonly segments: ArmSegments;
  readonly keys: readonly SolvedArm[];
}

/**
 * Solves both arms over a clip's keys.
 *
 * Reads the mesh, measures the body frame off it, and answers with one entry
 * per side. Everything is in the body's own axes and over the rig's height, so
 * the numbers a caller writes are the numbers `pose.ts` means.
 */
export function solveArms(options: SolveOptions): Record<Side, ArmSolution> {
  const glb = splitGlb(new Uint8Array(readFileSync(options.meshPath)));
  const nodes = readNodeTree(glb);
  const naming = namingOf(nodes);
  if (naming === 'unknown') throw new Error(`${options.meshPath} is in no vocabulary this project reads`);
  const frame = bodyFrame(nodes, naming);
  if (!frame) throw new Error(`${options.meshPath} has no measurable body frame`);
  const rig = { nodes, naming } as const;

  const hips = boneNode(nodes, naming, 'hips');
  if (!hips) throw new Error(`${options.meshPath} has no hips to measure from`);

  const anchor = options.keys[0];
  if (!anchor) throw new Error('a solve needs at least one key');

  const indexOf = (role: BoneRole): number => {
    const node = boneNode(nodes, naming, role);
    if (!node) throw new Error(`the rig has no ${role}`);
    return node.index;
  };

  /** Where a set of roles sit, in body axes from the hips, over rig height. */
  const placesOf = (turns: PoseTable, roles: readonly BoneRole[]): Vec3[] => {
    // One pose evaluation for every role asked about. The obvious shape --
    // `placeOf(turns, role)` -- rebuilds all 43 world matrices per call, and
    // the inner loop asks twice per candidate across some 40,000 candidates a
    // key, which took the solve from a second to minutes.
    const world = poseWorldMatrices(nodes, keyRotations(rig, turns));
    const at = world[hips.index] ?? [];
    return roles.map((role) => {
      const m = world[indexOf(role)] ?? [];
      const into = intoBodyFrame(frame, [
        (m[12] ?? 0) - (at[12] ?? 0),
        (m[13] ?? 0) - (at[13] ?? 0),
        (m[14] ?? 0) - (at[14] ?? 0),
      ]);
      return [
        into.right / options.rigHeight,
        into.up / options.rigHeight,
        into.forward / options.rigHeight,
      ] as Vec3;
    });
  };

  const placeOf = (turns: PoseTable, role: BoneRole): Vec3 => placesOf(turns, [role])[0] as Vec3;

  // Segment lengths off the rig rather than typed in, so `elbowFor` closes on
  // the arm this body actually has.
  const bones = (side: Side): ArmSegments => {
    const shoulder = placeOf(anchor.turns, roleFor(side, 'Arm'));
    const elbow = placeOf(anchor.turns, roleFor(side, 'ForeArm'));
    const hand = placeOf(anchor.turns, roleFor(side, 'Hand'));
    return { upper: length(sub(elbow, shoulder)), fore: length(sub(hand, elbow)) };
  };

  const withAxes = (turns: PoseTable, side: Side, values: readonly number[]): PoseTable => {
    const out: Record<string, BoneTurns> = { ...(turns as Record<string, BoneTurns>) };
    ARM_AXES.forEach((knob, index) => {
      const role = roleFor(side, knob.part);
      out[role] = { ...(out[role] ?? {}), [knob.axis]: values[index] ?? 0 };
    });
    return out as PoseTable;
  };

  /** The shoulder's own offset rotation for a candidate, in degrees-free form. */
  const armQuat = (turns: PoseTable, side: Side, values: readonly number[]): Quat =>
    keyRotations(rig, withAxes(turns, side, values)).get(nodes[indexOf(roleFor(side, 'Arm'))]?.name ?? '') ?? [0, 0, 0, 1];

  /**
   * The same shoulder rotation, spelled with the smallest angles that make it.
   *
   * The three numbers are an *intrinsic euler triple*, so every rotation has
   * infinitely many spellings and a descent has no reason to prefer a tidy one:
   * the bow's draw came back as `lateral: -279.8, up: -103.6`, which is a
   * perfectly good arm and an unreadable row. This re-solves for the nearest
   * equivalent triple to zero, which changes no pose and makes the table
   * something a person can argue with -- the whole reason it is a table of
   * degrees rather than a list of quaternions.
   */
  const tidy = (turns: PoseTable, side: Side, values: readonly number[]): number[] => {
    const want = armQuat(turns, side, values);
    const wrap = (angle: number): number => angle - 360 * Math.round(angle / 360);
    const [l, f, u, flex] = [wrap(values[0] ?? 0), wrap(values[1] ?? 0), wrap(values[2] ?? 0), values[3] ?? 0];
    const score = (candidate: readonly number[]): number =>
      quatAngle(want, armQuat(turns, side, candidate)) ** 2 +
      1e-4 * ((candidate[0] ?? 0) ** 2 + (candidate[1] ?? 0) ** 2 + (candidate[2] ?? 0) ** 2);

    // Seeded from the euler *flip* as well as from the wrapped triple. Any
    // three-axis sequence spells the same rotation a second way -- roughly
    // `(l+180, 180-f, u+180)` -- and a descent started in the wrong basin
    // cannot cross to the other, which is how the bow's sweep came back as
    // `lateral: 140.7, forward: -165.1, up: -156.4` for an arm that is
    // perfectly ordinary.
    let best = [l, f, u, flex];
    let cost = score(best);
    for (const dl of [0, 180, -180]) {
      for (const du of [0, 180, -180]) {
        const seed = [wrap(l + dl), wrap(180 - f), wrap(u + du), flex];
        const found = score(seed);
        if (found < cost) {
          cost = found;
          best = seed;
        }
      }
    }
    for (let step = 90; step > 0.005; step /= 2) {
      let improving = true;
      while (improving) {
        improving = false;
        for (let index = 0; index < 3; index += 1) {
          for (const direction of [step, -step]) {
            const trial = [...best];
            trial[index] = (trial[index] ?? 0) + direction;
            const found = score(trial);
            if (found < cost - 1e-12) {
              cost = found;
              best = trial;
              improving = true;
            }
          }
        }
      }
    }
    return best;
  };

  const solveSide = (side: Side): ArmSolution => {
    const segment = bones(side);
    const out: SolvedArm[] = [];

    let previous = ARM_AXES.map(
      (knob) => (anchor.turns[roleFor(side, knob.part)] as BoneTurns | undefined)?.[knob.axis] ?? 0,
    );
    let previousQuat = armQuat(anchor.turns, side, previous);

    for (const key of options.keys) {
      const target = options.targets[key.label]?.[side];
      if (!target) continue;
      const turns = key.turns;
      const shoulder = placeOf(turns, roleFor(side, 'Arm'));
      const wantElbow = elbowFor(shoulder, target.hand, segment.upper, segment.fore, target.roll);

      const missBy = (values: readonly number[]): { hand: number; elbow: number } => {
        const posed = withAxes(turns, side, values);
        const at = placesOf(posed, [roleFor(side, 'Hand'), roleFor(side, 'ForeArm')]);
        return {
          hand: length(sub(at[0] as Vec3, target.hand)),
          elbow: length(sub(at[1] as Vec3, wantElbow)),
        };
      };

      const cost = (values: readonly number[]): number => {
        const miss = missBy(values);
        const detour = quatAngle(previousQuat, armQuat(turns, side, values));
        return (PER_UNIT * miss.hand) ** 2 + (PER_UNIT * miss.elbow) ** 2 + (PER_DETOUR * detour) ** 2;
      };

      const descendFrom = (seed: readonly number[]): { values: number[]; cost: number } => {
        let values = [...seed];
        let best = cost(values);
        for (let step = 45; step > 0.01; step /= 2) {
          let improving = true;
          while (improving) {
            improving = false;
            for (let index = 0; index < values.length; index += 1) {
              for (const direction of [step, -step]) {
                const trial = [...values];
                const moved = (trial[index] ?? 0) + direction;
                // A joint limit rather than a price: an elbow does not bend
                // backwards at any cost, and an unclamped solve will fold one
                // the wrong way to save a hundredth of a unit of reach.
                if (ARM_AXES[index]?.part === 'ForeArm' && (moved < ELBOW_RANGE.min || moved > ELBOW_RANGE.max)) {
                  continue;
                }
                trial[index] = moved;
                const score = cost(trial);
                if (score < best - 1e-9) {
                  best = score;
                  values = trial;
                  improving = true;
                }
              }
            }
          }
        }
        return { values, cost: best };
      };

      // A grid over the shoulder's two big axes, because an arm reaching a
      // place has genuinely distinct answers -- elbow up or elbow down, swung
      // inside the shoulder or outside it -- separated by ridges a descent will
      // not cross. `aim-blade.ts` found that out by shipping a strike that
      // stopped a hand's width short of the midline.
      const start = ARM_AXES.map(
        (knob, index) => (turns[roleFor(side, knob.part)] as BoneTurns | undefined)?.[knob.axis] ?? previous[index] ?? 0,
      );
      let solved = descendFrom(start);
      for (const lateral of [-90, -45, 0, 45, 90]) {
        for (const forward of [-45, 0, 45]) {
          const seed = [...start];
          seed[0] = lateral;
          seed[1] = forward;
          const found = descendFrom(seed);
          if (found.cost < solved.cost - 1e-9) solved = found;
        }
      }

      const values = tidy(turns, side, solved.values);
      const was = previousQuat;
      previous = [...values];
      previousQuat = armQuat(turns, side, values);
      const miss = missBy(values);
      out.push({
        label: key.label,
        values,
        handMiss: miss.hand,
        elbowMiss: miss.elbow,
        fold: values[3] ?? 0,
        turn: quatAngle(was, previousQuat),
      });
    }

    return { segments: segment, keys: out };
  };

  return { left: solveSide('left'), right: solveSide('right') };
}

/** One solved key, as a row somebody can paste into a pose table. */
export function armRow(side: Side, solved: SolvedArm): string {
  const round = (value: number): number => Math.round(value * 10) / 10 + 0;
  const show = (part: 'Arm' | 'ForeArm'): string => {
    const parts = ARM_AXES.map((knob, index) => (knob.part === part ? `${knob.axis}: ${round(solved.values[index] ?? 0)}` : null))
      .filter((entry): entry is string => entry !== null);
    return `${roleFor(side, part)}: { ${parts.join(', ')} }`;
  };
  return (
    `  ${solved.label.padEnd(7)} hand ${solved.handMiss.toFixed(3)} elbow ${solved.elbowMiss.toFixed(3)}` +
    ` fold ${solved.fold.toFixed(0).padStart(3)} turn ${solved.turn.toFixed(0).padStart(3)}   ` +
    `${show('Arm')}, ${show('ForeArm')},`
  );
}
