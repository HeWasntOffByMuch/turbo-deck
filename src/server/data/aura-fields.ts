/**
 * The aura fields, as data (spec 222).
 *
 * A field is `a reach + an affliction + a linger`, and all three of those are
 * systems this game already has -- so this is one table rather than a mechanic,
 * and the pass beside it (`sim/aura-field.ts`) is the only thing that reads it.
 *
 * What a field *is*, from the sim's point of view, is a status its carrier
 * wears: `StatusId.ScorchedEarth` is a boon like any other, applied by an
 * ordinary `applyStatus` effect and expiring by the one comparison
 * `sim/statuses.ts` makes. What is new is that something reads a status and
 * reaches the bodies **around** the one carrying it -- until this, every rule in
 * the sim was about the body it was written on.
 *
 * Three numbers, and each is a different question:
 *
 *  - {@link AuraFieldDefinition.radius} -- how far it reaches. Measured to a
 *    body's *edge*, so a big body is caught by the edge of the fire and not only
 *    by its centre, which is how `landOnTarget` and `landBlast` already measure.
 *  - {@link AuraFieldDefinition.dotId} -- what it lays on them. A row in
 *    `data/damage-over-time.ts` and **nothing else**: no rate here, no cadence,
 *    no length, because spec 190's rule is that every Burn in the game is the
 *    same Burn, and a field that authored its own would be a second answer to
 *    what burning is.
 *  - {@link AuraFieldDefinition.lingerTicks} -- how much of it is left the
 *    moment a body steps out. This is the whole design of the feature: the pass
 *    re-lays the affliction every tick a body is inside, so standing in it never
 *    runs out, and stepping out leaves exactly this much.
 *
 * Pure data. No behaviour, in the same register as `data/damage-over-time.ts`
 * and `data/skill-effects.ts`.
 */

import { SERVER_TICK_RATE } from '../config.js';
import { StatusId } from '../sim/statuses.js';

export interface AuraFieldDefinition {
  /** The {@link StatusId} its **carrier** wears. The field *is* that status. */
  readonly id: string;
  readonly name: string;
  /**
   * How far it reaches, in world units, from the carrier's centre to a body's
   * edge.
   *
   * Also the radius of the ring drawn for it: `vfx/library.ts` reads this
   * number rather than repeating it, because the ring is not decoration around
   * the mechanic, it is where the fire is. A player who cannot tell which
   * bodies are inside cannot play the skill.
   */
  readonly radius: number;
  /** The affliction laid on whoever is inside. A row in `DAMAGE_OVER_TIME`. */
  readonly dotId: string;
  /**
   * How much of that affliction is left the moment a body steps out.
   *
   * Short on purpose. A field is pressure to move rather than a sentence: what
   * makes it a decision is that leaving works, and leaving only works if the
   * fire goes out shortly afterwards.
   */
  readonly lingerTicks: number;
  /**
   * How many bodies one tick of it may reach. Nearest first, ties on entity id.
   *
   * A bound rather than a balance knob -- the pass runs every tick, and a field
   * dropped into a nest should cost what a field costs rather than what the
   * nest costs.
   */
  readonly maxTargets: number;
  /** The ring drawn for it, in `vfx/library.ts`. */
  readonly auraEffectId: string;
  readonly description: string;
}

function seconds(value: number): number {
  return Math.max(1, Math.round(value * SERVER_TICK_RATE));
}

const SCORCHED_EARTH_ROW: AuraFieldDefinition = {
  id: StatusId.ScorchedEarth,
  name: 'Scorched Earth',
  // Wider than a body and narrower than Whirlwind's sweep (160). A field is
  // ground you have to leave rather than a room you have to be out of: at
  // this reach a monster at standoff is already outside it, so closing to
  // attack the carrier is what puts something in the fire.
  radius: 130,
  // Burn, whole. The strongest rate and the shortest life in the table, which
  // is exactly the shape a field wants -- it has to hurt while you are in it
  // and stop mattering when you are out.
  dotId: StatusId.Burn,
  lingerTicks: seconds(1),
  // Six, which is Whirlwind's, for the same reason: it is the number of
  // bodies that can be pressed against one at once.
  maxTargets: 6,
  auraEffectId: 'aura_scorched',
  description: 'The ground around you catches. Whoever stands in it burns, and keeps burning for a moment after they get out.',
};

const DEFINITIONS: readonly AuraFieldDefinition[] = [SCORCHED_EARTH_ROW];

export const AURA_FIELDS: ReadonlyMap<string, AuraFieldDefinition> = new Map(
  DEFINITIONS.map((row) => [row.id, row]),
);

export const ALL_AURA_FIELDS: readonly AuraFieldDefinition[] = DEFINITIONS;

/** The row for a status id, or null if that status is not a field. */
export function auraFieldById(id: string): AuraFieldDefinition | null {
  return AURA_FIELDS.get(id) ?? null;
}

/**
 * The window one tick inside the field is worth.
 *
 * `lingerTicks` **plus one tick**, and it is the same one tick of slack
 * `dotDurationTicks` states for the same reason: a pulse fires on
 * `elapsed % intervalTicks === 0` and `statusOf` refuses an entry at
 * `tick >= expiresAtTick`, so a window of exactly `lingerTicks` loses a
 * boundary landing on its last tick. Derived once here rather than authored
 * into the row, where it would be an off-by-one per field.
 */
export function lingerWindowTicks(row: AuraFieldDefinition): number {
  return row.lingerTicks + 1;
}

/**
 * The one field the game ships, for the callers that name it directly.
 *
 * Declared before {@link DEFINITIONS} rather than read out of it, so it is the
 * row rather than a lookup that could answer `undefined` -- which matters
 * because `vfx/library.ts` reads its `radius` at module load to author the ring
 * at the field's own reach.
 */
export const SCORCHED_EARTH: AuraFieldDefinition = SCORCHED_EARTH_ROW;
