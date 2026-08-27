/**
 * Put both of the pig's hands where a cast needs them, at each key (spec 231).
 *
 *   npx tsx scripts/aim-cast.ts
 *
 * `aim-bow.ts` with a different table, over the same `arm-solve.ts`. The bow
 * states where the two hands are because they hold two ends of one object; a
 * cast states it for a different reason, which is that the whole action is
 * **where the hands are relative to the chest**. Solved from shoulder angles by
 * eye, "the hands come together in front of the sternum" is four numbers that
 * are right for one torso lean and wrong for the next, and this clip leans its
 * torso 20 degrees between the coil and the release.
 *
 * ## What the numbers say
 *
 * Every target is `[right, up, forward]` from the hips, over the rig's height,
 * so they are readable as fractions of a body: the chest sits at 0.208 and the
 * shoulders at 0.34, so a hand at `up: 0.24, forward: 0.14` is in front of the
 * sternum, and one at `forward: 0.30` is a body's-width out in front.
 *
 * The **gather** and the **focus** put both hands on the midline and close
 * together, elbows winged out -- a wide, stable silhouette with a small bright
 * spot in the middle of it, which is what has to read at forty pixels. The
 * **release** throws both out in front at chest height, nearly straight but not
 * locked: the folds come back around 25 degrees, and an arm at zero reads as a
 * mannequin rather than as a body that just pushed something.
 *
 * The left hand leads and the right sits a little higher and shorter. That
 * asymmetry is deliberate and it is not decoration -- two arms at identical
 * angles read as one arm drawn twice -- and it is *that* way round because the
 * right hand is the one holding a weapon (`weapon.main`), so a sword thrust
 * straight down the camera would read as a stab rather than as a cast.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armRow, solveArms, type ArmTarget, type Side } from './arm-solve.js';
import { CAST_KEY_MS, PIG_CAST } from '../src/units/pig-cast.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = join(repoRoot, 'assets', 'units', 'pig_a_pose_full');

type KeyLabel = keyof typeof CAST_KEY_MS;

/** How tall the rig stands in its own units, so every target is scale-free. */
const RIG_HEIGHT = 0.998;

/**
 * Where each hand is at each key.
 *
 * `settle` is deliberately absent, for the reason `aim-bow.ts` gives about its
 * own: it is the same `READY` object as `ready`, so solving it separately would
 * chain it off the follow-through and answer with a different arm for a pose
 * that is by construction the same one.
 */
const TARGETS: Partial<Record<KeyLabel, Record<Side, ArmTarget>>> = {
  // Hands up and open in front of the waist -- a body about to do something.
  //
  // This one is a *compromise* and the reason is worth writing down, because the
  // obvious answer is wrong. The idle leaves the hands at [-0.156, 0.058, 0.048]
  // and [0.172, 0.061, 0.033] (measured, off `clips/idle.glb`), and a `ready`
  // authored there would fade into this clip perfectly -- and would put the
  // whole recovery on a much longer journey than the push. Measured that way
  // round, the **settle was four times faster than the extension**: the hands
  // travel 0.33 of a body coming home against 0.13 going out, and a recovery
  // that is the most violent thing in a clip reads as the body being yanked.
  // Half way up costs a little of the entry blend, which the 60ms cross-fade
  // covers and which `pig-shot.ts`'s own bow-ready stance already spends, and
  // buys a release that is the fastest movement in its own animation.
  ready: {
    left: { hand: [-0.185, 0.155, 0.145], roll: -35 },
    right: { hand: [0.18, 0.16, 0.135], roll: 35 },
  },
  // In to the chest, elbows winged out. The chest bone sits at `up: 0.208`, so
  // the hands are at exactly its height and a hand's length in front of it --
  // `forward: 0.175` rather than the 0.13 that "hands on the chest" suggests,
  // because a hand *on* the chest folds this rig's elbow past 130 degrees, which
  // reads as an arm that is broken rather than as one that is gathering. The
  // hands cup something in front instead: the same picture with a joint that
  // closes, at 110 and 99 degrees of fold.
  gather: {
    left: { hand: [-0.058, 0.2, 0.175], roll: -55 },
    right: { hand: [0.058, 0.2, 0.175], roll: 55 },
  },
  // The creep. The hands come a hundredth of a body closer together, a
  // hundredth higher and a hundredth nearer, and the elbows wing further out --
  // small, continuous, and nothing like as fast as what follows it.
  focus: {
    left: { hand: [-0.05, 0.208, 0.17], roll: -62 },
    right: { hand: [0.05, 0.208, 0.17], roll: 62 },
  },
  // Both arms out in front at chest height, and the folds come back at 25
  // degrees on each side -- deliberately not zero, because an arm at full
  // extension reads as a mannequin rather than as a body that just pushed
  // something. The right sits higher and shorter than the left: two arms at
  // identical angles read as one arm drawn twice, and it is that way round
  // because the right hand is the one holding a weapon.
  release: {
    left: { hand: [-0.085, 0.275, 0.307], roll: -15 },
    right: { hand: [0.085, 0.298, 0.272], roll: 15 },
  },
  // A hundred milliseconds past it: further forward, wider, and straighter --
  // 17 and 16 degrees of fold against 25. The hands going *apart* is what makes
  // this read as a follow-through rather than as a second push, and it is the
  // half that survives at forty pixels.
  follow: {
    left: { hand: [-0.115, 0.285, 0.344], roll: -18 },
    right: { hand: [0.115, 0.305, 0.306], roll: 18 },
  },
};

function main(): void {
  const solved = solveArms({
    meshPath: join(UNIT_DIR, 'pig_a_pose_full.glb'),
    rigHeight: RIG_HEIGHT,
    keys: PIG_CAST.keys.map((key) => ({ label: key.label, turns: key.turns })),
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
