/**
 * Which statuses a player can see, and what each one looks like (spec 186).
 *
 * `sim/statuses.ts` is where *"everything the progression needs to remember
 * about a body between ticks"* goes, and that is deliberately wider than what
 * anybody should be shown. Some of what it remembers is a condition -- Flow
 * building, a target left Exposed -- and some of it is bookkeeping: a 0.2s
 * window Perfect Exit reads, an inverted "your comeback has been spent", the
 * per-spawner farm decay. This table is the line between them.
 *
 * **The rule: the wire carries the conditions somebody could point at, not the
 * timers the sim keeps for itself.** A row here is a promise that a player can
 * act on the mark. Four `StatusId`s and every internal family
 * (`dmg:`, `exposed.bounty`, the restoration keys) are deliberately absent, and
 * absent is the default -- {@link visualFor} answers null for anything with no
 * row, so a status added to the sim is invisible until somebody decides it
 * should not be.
 *
 * `wire` is **append-only**. It is the number that crosses the wire in place of
 * the string id, so renumbering a row silently re-labels every mark on a client
 * that has not been rebuilt. Add at the end; never reuse a retired index.
 *
 * `icon` is a *picture*, in the same register as `ProjectileSpec.look`: nothing
 * under `src/server/sim/` reads it, and it rides no wire. The client looks it up
 * from the id it was sent, because this table is shared code.
 *
 * Pure data.
 */

import { StatusId, ADAPTED_PREFIX } from '../sim/statuses.js';

/** The glyphs `render/iso3d/world/icons.ts` draws for these. */
export type StatusIconId =
  | 'flow'
  | 'momentum'
  | 'prepared'
  | 'attuned'
  | 'exposed'
  | 'vulnerable'
  | 'sundered'
  | 'adapted'
  | 'slowed'
  | 'burn'
  | 'bleed'
  | 'poison'
  | 'corrosion'
  | 'shock'
  | 'frostbite'
  | 'decay'
  | 'scorched'
  | 'light';

/**
 * Which way a status cuts.
 *
 * Colour comes from this and from nothing else -- eight colours over a head is a
 * legend rather than a picture, and a player reading a fight needs "is that good
 * for them or bad for them" long before they need which one it is.
 *
 * It is presentation, and no rule in the sim reads it: a boon is not cleansable
 * and an affliction is not dispellable, because neither of those systems exists.
 */
export type StatusKind = 'boon' | 'affliction';

export interface StatusVisual {
  readonly id: string;
  /** Stable wire index. Append only. */
  readonly wire: number;
  readonly name: string;
  readonly kind: StatusKind;
  readonly icon: StatusIconId;
  /**
   * What the sim will let this reach, so a client can draw "2/3" without being
   * told the ceiling per body. A 1 here means the mark never shows a count.
   */
  readonly maxStacks: number;
  /**
   * What the condition does, in one or two sentences (spec 191).
   *
   * Authored, and the reason is that this row genuinely does not know: what a
   * boon does lives in `sim/blow.ts`, `sim/abilities.ts` and `SCALING`, and
   * there is no field here to derive it from. Everything *around* it -- the
   * stacking rule, the refresh rule, whether a count is drawn, which colour it
   * takes -- is derived by `data/description.ts` from the fields above.
   *
   * **Absent for an affliction** (spec 190's seven), and that is the same rule
   * rather than an exception to it: an affliction *is* a rate, a cadence and a
   * length in `data/damage-over-time.ts`, so `describeStatus` derives its lines
   * from that row and seven sentences here would be a second copy of
   * `damagePerSecond` with nothing keeping it true. The rule is one sentence --
   * **nothing derivable may be authored** -- and a row supplies exactly one of
   * the two sources. `description.test.ts` fails a row that supplies neither or
   * both.
   *
   * Written to `docs/mechanics-vocabulary.md`: no ticks, no internal pool names,
   * no magnitude that depends on who applied it. Where a number is a build's
   * rather than the status's, the line names the source instead of guessing one.
   */
  readonly effect?: string;
  /**
   * This status has no duration of its own (spec 191).
   *
   * True for exactly one row today. `world.ts` applies Prepared with
   * `Number.MAX_SAFE_INTEGER - tick`, so it never expires on its own and ends
   * only by being *spent* on the next cast -- and a mark that counted down
   * toward that would be showing a clock nothing is running.
   *
   * Declared here rather than inferred from the wire because the two questions
   * are different: the client also refuses an absurd remaining time
   * ({@link INDEFINITE_AFTER_TICKS} in `world/status-marks.ts`), which is the
   * defence against a *value* it cannot trust -- `expiresAtTick` crosses as a
   * u32 and that sentinel does not fit in one. This is the design saying the
   * status has no clock, which is what a description needs to know.
   */
  readonly indefinite?: boolean;
}

/**
 * The id the adaptation family collapses to.
 *
 * Adaptation is per ability -- `adapt:bolt.arcane` -- so it is the one entry
 * here that is not a status id the sim ever writes. A mark over a head cannot
 * say *which* ability it has learned to shrug off, so the rows below carry
 * one `adapted` and the packer folds every `adapt:` entry into it, keeping the
 * largest stack count. What is left is still true: this body is getting harder
 * to hurt the same way.
 */
export const ADAPTED_ID = 'adapted';

const DEFINITIONS: readonly StatusVisual[] = [
  // --- boons -------------------------------------------------------------
  {
    id: StatusId.Flow,
    wire: 0,
    name: 'Flow',
    kind: 'boon',
    icon: 'flow',
    maxStacks: 3,
    effect: 'Shortens your backswing. Lost when you are Staggered.',
  },
  {
    id: StatusId.Momentum,
    wire: 1,
    name: 'Momentum',
    kind: 'boon',
    icon: 'momentum',
    maxStacks: 1,
    effect: 'Shortens the wind-up of your next cast. Spent when you cast.',
  },
  {
    id: StatusId.Prepared,
    wire: 2,
    name: 'Prepared',
    kind: 'boon',
    icon: 'prepared',
    maxStacks: 1,
    indefinite: true,
    effect:
      'Shortens the wind-up of your next ability. Does not apply to basic attacks.',
  },
  {
    id: StatusId.Attuned,
    wire: 3,
    name: 'Attuned',
    kind: 'boon',
    icon: 'attuned',
    maxStacks: 3,
    effect: 'Each stack reduces what your abilities cost.',
  },

  // --- afflictions -------------------------------------------------------
  // Exposed is the one that most needed a picture: it is worth +15% to
  // *everybody* attacking that body, and until now no member of that everybody
  // could see it.
  {
    id: StatusId.Exposed,
    wire: 4,
    name: 'Exposed',
    kind: 'affliction',
    icon: 'exposed',
    maxStacks: 1,
    effect:
      'Every attacker deals more damage to this target. '
      + 'How much is set by whoever exposed it.',
  },
  {
    id: StatusId.Vulnerable,
    wire: 5,
    name: 'Vulnerable',
    kind: 'affliction',
    icon: 'vulnerable',
    maxStacks: 1,
    effect:
      'This body has committed to an action. '
      + 'Attackers who can read an opening find weak points against it more often.',
  },
  {
    id: StatusId.Sundered,
    wire: 6,
    name: 'Sundered',
    kind: 'affliction',
    icon: 'sundered',
    maxStacks: 1,
    effect: 'Armour is reduced by 10 percentage points, to a minimum of 0%.',
  },
  // An affliction from the point of view of whoever is trying to land the blow,
  // which is the side the mark is read from: a body that has adapted is a body
  // your bolt is getting worse against.
  {
    id: ADAPTED_ID,
    wire: 7,
    name: 'Adapted',
    kind: 'affliction',
    icon: 'adapted',
    maxStacks: 8,
    effect:
      'This body takes less damage from an ability it has been hit by repeatedly. '
      + 'Each stack reduces it further, up to a cap. The mark does not say which ability.',
  },
  // The first row here a *skill* writes rather than a build earning (spec 188),
  // and by this table's own rule the most obvious one there is: a body moving
  // at 60% of its own speed is a condition anybody can point at, and the player
  // who spent a cooldown on it has the most reason of all to want it confirmed.
  //
  // It carries no magnitude, like every row here. How *much* slower is a fact
  // the mover's own client needs and the watcher does not -- that one rides
  // `EntityField.MoveScale`, which is the number a step is multiplied by rather
  // than a picture.
  {
    id: StatusId.Slowed,
    wire: 8,
    name: 'Slowed',
    kind: 'affliction',
    icon: 'slowed',
    maxStacks: 1,
    effect: 'Move speed is reduced. Never below 25% of normal speed.',
  },

  // --- the afflictions (spec 190) ----------------------------------------
  //
  // Seven rows and the easiest decision in this table: an affliction is
  // *losing health to something that is still on you*, which is the most
  // pointable-at condition this game has. A player who cannot see one has no
  // way to tell being poisoned from being wrong about their own health bar.
  //
  // `maxStacks` mirrors the row in `data/damage-over-time.ts`, because it is the
  // same ceiling: the mark's count and the concentration doing the damage are
  // one number, and a table that guessed its own would eventually disagree with
  // the sim about what a player is carrying.
  //
  // They all read as one colour, like every other affliction here, and that is
  // the rule working rather than a shortcoming -- seven warm tones over a head
  // is a legend. Which one it is, is the glyph's job.
  { id: StatusId.Burn, wire: 9, name: 'Burn', kind: 'affliction', icon: 'burn', maxStacks: 1 },
  { id: StatusId.Bleed, wire: 10, name: 'Bleed', kind: 'affliction', icon: 'bleed', maxStacks: 3 },
  { id: StatusId.Poison, wire: 11, name: 'Poison', kind: 'affliction', icon: 'poison', maxStacks: 5 },
  {
    id: StatusId.Corrosion,
    wire: 12,
    name: 'Corrosion',
    kind: 'affliction',
    icon: 'corrosion',
    maxStacks: 3,
  },
  { id: StatusId.Shock, wire: 13, name: 'Shock', kind: 'affliction', icon: 'shock', maxStacks: 1 },
  {
    id: StatusId.Frostbite,
    wire: 14,
    name: 'Frostbite',
    kind: 'affliction',
    icon: 'frostbite',
    maxStacks: 1,
  },
  { id: StatusId.Decay, wire: 15, name: 'Decay', kind: 'affliction', icon: 'decay', maxStacks: 1 },

  // --- the aura fields (spec 223) ----------------------------------------
  //
  // A **boon**, and the one row in this table whose colour is doing more work
  // than usual: everybody in the fight can see this mark, and what it means to
  // the body wearing it and to the body next to it are opposites. `kind` is
  // read from the carrier's side, which is the side it is true of -- the fire
  // is theirs.
  //
  // No `effect` sentence, for the reason the seven afflictions above have none:
  // a field *is* a reach, an affliction and a linger in `data/aura-fields.ts`,
  // so `describeStatus` derives its lines from that row and a sentence here
  // would be a second copy of `radius` with nothing keeping it true.
  {
    id: StatusId.ScorchedEarth,
    wire: 16,
    name: 'Scorched Earth',
    kind: 'boon',
    icon: 'scorched',
    maxStacks: 1,
  },

  // --- the conjured light (spec 248) -------------------------------------
  //
  // The one row in this table whose *whole* mechanic is that it is drawn. Every
  // other entry is a condition the sim reads and this table decides to show; a
  // conjured light is nothing the sim reads at all, so if it were not here it
  // would not exist.
  //
  // It carries a sentence, because it has to: the rule is that nothing
  // derivable may be authored, and there is nothing to derive it *from* -- no
  // rate, no scale, no field row. What the light does lives in
  // `player-lights.ts`, which is the renderer.
  {
    id: StatusId.MagicLight,
    wire: 17,
    name: 'Conjured Light',
    kind: 'boon',
    icon: 'light',
    maxStacks: 1,
    effect: 'A conjured light floats overhead, lighting the ground around you. It casts no shadows.',
  },
];

export const STATUS_VISUALS: readonly StatusVisual[] = DEFINITIONS;

/** The widest a packed list can be, which bounds the field on the wire. */
export const MAX_VISIBLE_STATUSES = DEFINITIONS.length;

const BY_ID: ReadonlyMap<string, StatusVisual> = new Map(
  DEFINITIONS.map((definition) => [definition.id, definition]),
);

const BY_WIRE: ReadonlyMap<number, StatusVisual> = new Map(
  DEFINITIONS.map((definition) => [definition.wire, definition]),
);

/**
 * The row for one status id, or null if it is not shown.
 *
 * Every `adapt:<ability>` key answers the collapsed {@link ADAPTED_ID} row, which
 * is what lets the packer fold the family without knowing the ability table.
 */
export function visualFor(id: string): StatusVisual | null {
  if (id.startsWith(ADAPTED_PREFIX)) return BY_ID.get(ADAPTED_ID) ?? null;
  return BY_ID.get(id) ?? null;
}

/**
 * The row for a wire index, or null.
 *
 * Null rather than a throw: an index this build has no row for is a client
 * reading a newer server, and the honest answer to a mark it cannot name is to
 * draw nothing rather than to drop the frame.
 */
export function visualByWire(wire: number): StatusVisual | null {
  return BY_WIRE.get(wire) ?? null;
}
