/**
 * What a monster's rig is *built* with (spec 152).
 *
 * `appearance.ts` beside this answers which rig draws a body. This answers what
 * that rig is made of: how big it is drawn, how it carries itself, what shape
 * and colour it is. Until this file there was no answer -- every monster in the
 * arena was `new MechRig(typeId)`, which is the default tuning at size 1 in
 * `enemyColor`'s fallback, because that function switches on `brawler`,
 * `skitter` and `brute`: three sim type names no row in `MONSTERS` has used
 * since spec 062. Four enemies, one silhouette, one colour.
 *
 * The split this file exists to hold is that **a sim number has one home and it
 * is not here**. How fast a body moves, how fast it turns, how wide it is and
 * how much it can take are the server's, replicated, and read out of `MONSTERS`;
 * how big it is *drawn* and what it is made of are the renderer's and are read
 * out of here. {@link MechRigTuning} is the rule rather than a convention: it is
 * the rig's tuning minus `moveSpeed` and `turnRate`, the two fields that live on
 * `MechTuning` only because the movement sandbox needed somewhere to hang its
 * two sim overrides and that the rig itself has never read. A table that could
 * name them would be a second place to write down how fast a monster moves, and
 * the two would disagree the first time either was edited.
 *
 * Total by construction, like `appearanceOf`: a type id with no row gets `null`
 * and draws exactly what it draws today. Adding an enemy's look is adding a row.
 *
 * Pure: no three.js. It says what to build, not how -- `MechTuning` is imported
 * as a type and erased, so nothing in the world view's pure half reaches the rig
 * module. `scene.ts` merges the overrides onto `defaultMechTuning()` at the one
 * place a rig is actually constructed.
 */

import type { MechAppearance, MechBodyShape, MechTuning } from '../rigs.js';
import { PALETTE } from '../palette.js';

export type { MechAppearance, MechBodyShape };

/**
 * The cosmetic half of a mech's tuning: every field except the two sim inputs.
 *
 * A `Partial`, because a look states what it changes. Everything it is silent
 * about stays at `defaultMechTuning()`, which is what makes a row reviewable --
 * six numbers somebody tuned, rather than twenty-four somebody copied.
 */
export type MechRigTuning = Partial<Omit<MechTuning, 'moveSpeed' | 'turnRate'>>;

export interface MonsterLook {
  /**
   * The shape and the colours, in the record the rig reads live.
   *
   * The same type the movement sandbox's colour wells write into, so what
   * somebody tunes over there is what gets pasted in here -- rather than a
   * second shape that has to be mapped across and can drift.
   */
  readonly appearance: MechAppearance;
  readonly tuning: MechRigTuning;
}

/**
 * The small spider (spec 152): the movement sandbox's spider at the values it
 * was tuned to, in black.
 *
 * The six numbers are the whole row. `sizeScale` makes it small; `coxaReach` 0
 * collapses the hip segment so each leg is a bare knee reaching out of the body,
 * and `femurScale` 1.05 gives that leg back its height at the knee; `raisedLegs`
 * 0 keeps every foot working rather than one held up in a recovery hold, which
 * on a body this small reads as a limp; and the two gains all but flatten the
 * pitch and the bank, because a chassis leaning into its own acceleration is a
 * vehicle and this is meant to scuttle.
 */
const SMALL_SPIDER: MonsterLook = {
  appearance: {
    shape: 'sphere',
    // Legs the same black as the body rather than the rig's darkened default:
    // a body at 0x141418 has nothing left to darken toward.
    bodyColor: PALETTE.enemySpider,
    legColor: PALETTE.enemySpider,
  },
  tuning: {
    sizeScale: 0.6,
    raisedLegs: 0,
    pitchGain: 0.0006,
    rollGain: 0.03,
    coxaReach: 0,
    femurScale: 1.05,
  },
};

// A Map rather than a record, for the reason `appearanceOf` is a switch: a type
// id arrives off the wire, and `LOOKS['constructor']` on an object literal
// answers with something that is not a look at all.
const LOOKS: ReadonlyMap<string, MonsterLook> = new Map([['small_spider', SMALL_SPIDER]]);

/**
 * The look for a monster type, or `null` to build it the way it is built today.
 *
 * Both records are copied on the way out. Two bodies of the same type must not
 * share either: `MechRig` holds both live and re-reads them every frame, so one
 * shared record would mean recolouring one spider recoloured the whole nest.
 */
export function monsterLookFor(typeId: string): MonsterLook | null {
  const look = LOOKS.get(typeId);
  if (look === undefined) return null;
  return { appearance: { ...look.appearance }, tuning: { ...look.tuning } };
}

/** Every type id with a look, for a test or a panel. Sorted, so it is stable. */
export function monsterLookIds(): readonly string[] {
  return [...LOOKS.keys()].sort();
}
