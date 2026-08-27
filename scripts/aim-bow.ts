/**
 * Put both of the pig's hands where a bow needs them, at each key (spec 164).
 *
 *   npx tsx scripts/aim-bow.ts
 *
 * `aim-blade.ts` solves one arm against a direction the blade has to point.
 * A bow has no direction to state -- there is no bow mesh in this project and
 * the shot's aim is the body's facing, which the server owns -- and it has two
 * arms that are not independent: the bow hand holds a place and the string hand
 * travels away from it. So this states **where each hand is** and solves the
 * shoulder, elbow and wrist of both arms for it.
 *
 * Since spec 230 the solve itself is `arm-solve.ts`, shared with `aim-cast.ts`:
 * a second clip wanted exactly this and a second copy of a descent is a second
 * set of weights to keep in step. What stayed here is the only part that was
 * ever about a bow, which is the table below.
 *
 * ## What it prints
 *
 * The miss for each hand and each elbow, in rig units, and the elbow's fold in
 * degrees, because the fold is the number that decides whether an arm reads. On
 * this rig the right arm is 0.178 and 0.114 against a body standing 0.998, so a
 * hand closer than about 0.156 to its own shoulder is folded past 120 degrees.
 * That is the measurement behind the anchor sitting behind the ear rather than
 * at the jaw, and it is printed rather than remembered.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armRow, solveArms, type ArmTarget, type Side } from './arm-solve.js';
import { PIG_SHOT, SHOT_KEY_MS } from '../src/units/pig-shot.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = join(repoRoot, 'assets', 'units', 'pig_a_pose_full');

type KeyLabel = keyof typeof SHOT_KEY_MS;

/** How tall the rig stands in its own units, so every target is scale-free. */
const RIG_HEIGHT = 0.998;

/**
 * Where each hand is at each key.
 *
 * The bow hand goes out and *stops*, and every number after `pull` is within a
 * hundredth of the one before it -- that stillness is the shot. The string hand
 * does all of the travelling: forward at the nock, back past the ear at full
 * draw, and thrown further back again on the loose as the fingers open.
 *
 * `settle` is deliberately absent: it is the same `STANCE` object as `stance`,
 * so solving it separately would chain it off the loose and answer with a
 * different arm for a pose that is by construction the same one -- and a shot
 * thrown at the end of a shot would have a jump to make.
 */
const TARGETS: Partial<Record<KeyLabel, Record<Side, ArmTarget>>> = {
  stance: {
    left: { hand: [-0.13, 0.22, 0.2], roll: -35 },
    right: { hand: [0.06, 0.23, 0.17], roll: 20 },
  },
  raise: {
    left: { hand: [-0.09, 0.31, 0.27], roll: -30 },
    right: { hand: [0.1, 0.3, 0.2], roll: 30 },
  },
  sweep: {
    left: { hand: [-0.05, 0.345, 0.33], roll: -25 },
    right: { hand: [0.25, 0.38, 0.02], roll: 62 },
  },
  pull: {
    left: { hand: [-0.046, 0.348, 0.342], roll: -24 },
    right: { hand: [0.135, 0.435, -0.175], roll: 72 },
  },
  anchor: {
    left: { hand: [-0.045, 0.35, 0.345], roll: -24 },
    right: { hand: [0.13, 0.44, -0.19], roll: 72 },
  },
  loose: {
    left: { hand: [-0.05, 0.345, 0.335], roll: -24 },
    right: { hand: [0.17, 0.47, -0.28], roll: 66 },
  },
};

function main(): void {
  const solved = solveArms({
    meshPath: join(UNIT_DIR, 'pig_a_pose_full.glb'),
    rigHeight: RIG_HEIGHT,
    keys: PIG_SHOT.keys.map((key) => ({ label: key.label, turns: key.turns })),
    targets: TARGETS as Readonly<Record<string, Readonly<Record<Side, ArmTarget>>>>,
  });

  for (const side of ['left', 'right'] as const) {
    const { segments, keys } = solved[side];
    console.log(
      `\n  the ${side} arm -- upper ${segments.upper.toFixed(3)}, forearm ${segments.fore.toFixed(3)}, ` +
        `reach ${(segments.upper + segments.fore).toFixed(3)}\n`,
    );
    for (const key of keys) console.log(armRow(side, key));
  }
}

main();
