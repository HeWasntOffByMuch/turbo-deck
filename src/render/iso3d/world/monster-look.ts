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

import { defaultMechAppearance } from '../rigs.js';
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
   * Whether the leg platform turns with the heading (spec 259).
   *
   * `MechOptions`' own field, surfaced here because it is a *look* in exactly
   * the sense the rest of this row is: it changes nothing the sim reads and
   * everything about what a turn looks like. False is the grey-mech reading --
   * the legs plant in a world-fixed frame and only the turret comes round -- and
   * absent is the spider every body on this rig has always been.
   *
   * The one thing it is not free to be: `MechRig.orientsWithGroupYaw` reports
   * it back, and the scene has to honour that or the group yaw and the turret
   * yaw both apply and the body turns twice as far as it is asked to.
   */
  readonly lowerBodyTurns?: boolean;
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
 * was tuned to.
 *
 * The seven numbers are the whole row. `sizeScale` makes it small and `bodySize`
 * gives the abdomen back a quarter of what that took, so the body reads as a
 * round thing on legs rather than as a bead; `coxaReach` 0 collapses the hip
 * segment so each leg is a bare knee reaching out of the body, and `femurScale`
 * 1.05 gives that leg back its height at the knee; `raisedLegs` 0 keeps every
 * foot working rather than one held up in a recovery hold, which on a body this
 * small reads as a limp; and the two gains all but flatten the pitch and the
 * bank, because a chassis leaning into its own acceleration is a vehicle and
 * this is meant to scuttle.
 */
const SMALL_SPIDER: MonsterLook = {
  appearance: {
    shape: 'sphere',
    // Legs the same colour as the body rather than the rig's darkened default:
    // a body this dark has nothing left to darken toward.
    bodyColor: PALETTE.enemySpider,
    legColor: PALETTE.enemySpider,
  },
  tuning: {
    sizeScale: 0.6,
    bodySize: 1.25,
    raisedLegs: 0,
    pitchGain: 0.0006,
    rollGain: 0.03,
    coxaReach: 0,
    femurScale: 1.05,
  },
};

/**
 * The Warden (spec 259): the sandbox's grey walker, at the values it was tuned
 * to.
 *
 * The appearance is `defaultMechAppearance(PALETTE.walkerBody)` **whole** rather
 * than two hex literals, and that is not a shortcut -- it is what the tuning
 * session produced. The panel reported a body of `969ba4` and legs of `53555a`,
 * which is that palette entry and this function's own 0.55 darkening of it, so
 * naming the function keeps one grey rather than three.
 *
 * `lowerBodyTurns: false` is the line the encounter is about. The legs stay
 * planted in a world-fixed frame and only the turret comes round, so a Warden
 * tracking you during its lock-on is a *head* tracking you over a body that has
 * not moved -- which is what the machine is doing, and what makes the eye the
 * thing to watch. It is also why `yawLag` is 0: on a spider that lag is the body
 * leaning into a turn, and on a turret it is the gun mount refusing to point
 * where it is aimed.
 *
 * The rest is the chassis walking heavily: taller steps and a slower stride than
 * the default, no raised recovery hold, a stiff chassis (a third of the bob, half
 * the pitch), and a leg built out of a knee rather than a hip -- `coxaReach` 0
 * with a short `femurScale`, which is a leg that plants under the body instead
 * of reaching out from it.
 *
 * `moveSpeed` and `turnRate` are deliberately absent, which is this file's
 * standing rule: how fast the Warden walks and turns is `data/monsters.ts`, is
 * replicated, and would be a second answer here. The sandbox panel names them
 * because it is *overriding* the sim, which is a thing a tuning tab does and a
 * content table must not.
 */
const WARDEN: MonsterLook = {
  appearance: defaultMechAppearance(PALETTE.walkerBody),
  lowerBodyTurns: false,
  tuning: {
    sizeScale: 1.1,
    stepLeadWalk: 15,
    stepLeadRun: 28,
    stepHeightWalk: 27,
    stepDurWalk: 0.12,
    stepDurRun: 0.18,
    raisedLegs: 0,
    turnStepBias: 0.8,
    yawLag: 0,
    stepPredict: 0.4,
    comShift: 0,
    bobAmp: 1.5,
    pitchGain: 0.0008,
    rollGain: 0.07,
    coxaReach: 0,
    coxaSwing: 0.95,
    femurScale: 0.7,
  },
};

// A Map rather than a record, for the reason `appearanceOf` is a switch: a type
// id arrives off the wire, and `LOOKS['constructor']` on an object literal
// answers with something that is not a look at all.
const LOOKS: ReadonlyMap<string, MonsterLook> = new Map([
  ['small_spider', SMALL_SPIDER],
  ['warden', WARDEN],
]);

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
  return {
    appearance: { ...look.appearance },
    tuning: { ...look.tuning },
    // A boolean, so there is nothing to copy -- but it is spelled out rather
    // than spread, so a field added to this type is a compile error here rather
    // than a look silently losing half of itself on the way out.
    ...(look.lowerBodyTurns === undefined ? {} : { lowerBodyTurns: look.lowerBodyTurns }),
  };
}

/** Every type id with a look, for a test or a panel. Sorted, so it is stable. */
export function monsterLookIds(): readonly string[] {
  return [...LOOKS.keys()].sort();
}
