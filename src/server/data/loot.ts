/**
 * What drops, and how loudly it announces itself (spec 158).
 *
 * Same contract as SKILLS, ITEMS and MONSTERS: content is data, an entity only
 * ever stores an id, and both ends read this file rather than the server
 * describing it on the wire.
 *
 * Two tables live here and they are deliberately separate questions. {@link
 * DROP_TABLES} is what a monster leaves behind -- probability, and nothing else.
 * {@link RARITIES} is how a drop is *presented* -- the reveal clock and the cue
 * names -- and nothing in it can change what dropped. Keeping the roll and the
 * ceremony apart is the whole reviewability argument of the spec: a change to
 * one is a diff that visibly does not touch the other.
 *
 * Pure and part of the deterministic core: no clock, no `Math.random`, and the
 * roll takes its {@link Rng} as an argument like every other draw in the sim.
 */

import type { Rng } from '../../shared/prng.js';
import type { ItemStack } from '../state/types.js';
import { itemById, maxStackOf, type RarityId } from './items.js';

export interface RarityRow {
  readonly id: RarityId;
  /** What the label says once the drop has revealed. */
  readonly name: string;
  /**
   * Ticks from the drop landing to its identity being told.
   *
   * `0` means "at once", which is what keeps ordinary loot ordinary: a common
   * drop has no reveal to wait through and no beat is spent on it.
   */
  readonly revealTicks: number;
  /**
   * Ticks of **quiet** between the drop landing and anything about it starting
   * to change. Never past {@link revealTicks}, and equal to it only when there
   * is no anticipation window at all.
   *
   * Half a second, and the point is the stillness. It used to be a sixth of
   * one, so the aura began swelling while the item was still in the air --
   * which reads as the object arriving mid-effect rather than as an object
   * arriving and *then* something happening to it. The beat lands after the
   * throw has finished (`TOSS_TICKS` is 18) with room to spare, so the sequence
   * a player sees is: thrown, settles, pause, and only then does it begin.
   */
  readonly anticipationTicks: number;
  /**
   * Cue **names**, not assets (spec 158).
   *
   * The renderer decides what a name sounds and looks like; loot logic never
   * learns, and the server never sees one at all -- it sends a tier and two
   * ticks, and the client looks the rest up here. An empty name is "no cue",
   * which is how a common drop says nothing rather than saying something
   * quiet.
   *
   * **Only `reveal` names a tier.** The other two fire before the identity is
   * known, so a tier in either of their names would be the rarity leaking out
   * through the audio channel the moment anything is authored for them -- the
   * same leak the aura had. `spawn` is one name for every tier because a drop
   * landing sounds like a drop landing, and `anticipation` is one name for
   * every tier that has one because "something is happening here" is all it is
   * allowed to say.
   */
  readonly cues: {
    readonly spawn: string;
    readonly anticipation: string;
    readonly reveal: string;
  };
  /**
   * How bright the drop's flare sits at rest, 0..1.
   *
   * Where a revealed drop's aura ends up and stays -- and, since there is no
   * overshoot anywhere in the curve, the brightest it ever gets. The contrast
   * §3 of `docs/reward-philosophy.md` is about: a common drop is a dim object
   * in the grass forever, and nothing about it competes with the one that is
   * not.
   *
   * It has to sit at or above `HIDDEN_PEAK_FLARE` for every tier that has a
   * run-up, or the aura would climb through the anticipation and then sag at
   * the reveal -- an anticlimax exactly where the payoff is meant to be.
   * `loot-drop.test.ts` asserts it.
   */
  readonly restFlare: number;
  /**
   * Whether the drop has a pulse (spec 158).
   *
   * What a resolved drop does while it lies there, and part of the *payoff*
   * rather than of the run-up: `heartbeatAt` withholds it until the reveal and
   * phases the cycle off that tick, so the first beat lands on the moment the
   * item becomes known. A pulse running during the anticipation would say "rare
   * or better" from the first frame, which is the same leak the tier colour
   * was. Off for common, so ordinary loot lies there inert forever.
   */
  readonly heartbeat: boolean;
}

/**
 * At 60Hz: half a second of quiet, then 0.6s of build for a rare and 1.4s for
 * an exceptional.
 *
 * The quiet is the same for both because it is not a tier signal -- it is the
 * drop landing and being an object for a moment. What differs is the build
 * after it, and only in *length*: both climb between the same two brightnesses,
 * so a longer one is a slower one rather than a brighter one, which is a rate
 * read over time instead of a kind read at a glance.
 *
 * Long enough to be a beat rather than a stutter, short enough that walking two
 * steps to the thing already covers most of it. The reveal is meant to resolve
 * at about the moment a player who reacted to it arrives, not to make them
 * stand and wait.
 */
const RARITY_ROWS: readonly RarityRow[] = [
  {
    id: 'common',
    name: 'Common',
    revealTicks: 0,
    anticipationTicks: 0,
    cues: { spawn: 'loot.spawn', anticipation: '', reveal: '' },
    restFlare: 0.12,
    heartbeat: false,
  },
  {
    id: 'rare',
    name: 'Rare',
    revealTicks: 66,
    anticipationTicks: 30,
    cues: {
      spawn: 'loot.spawn',
      anticipation: 'loot.anticipation',
      reveal: 'loot.reveal.rare',
    },
    restFlare: 0.45,
    heartbeat: true,
  },
  {
    id: 'exceptional',
    name: 'Exceptional',
    revealTicks: 114,
    anticipationTicks: 30,
    cues: {
      spawn: 'loot.spawn',
      anticipation: 'loot.anticipation',
      reveal: 'loot.reveal.exceptional',
    },
    restFlare: 0.7,
    heartbeat: true,
  },
];

export const RARITIES: ReadonlyMap<RarityId, RarityRow> = new Map(
  RARITY_ROWS.map((row) => [row.id, row]),
);

export const ALL_RARITIES: readonly RarityRow[] = RARITY_ROWS;

/** Total by construction, for the same reason `rarityFromByte` is. */
export function rarityRow(id: RarityId): RarityRow {
  return RARITIES.get(id) ?? (RARITY_ROWS[0] as RarityRow);
}

/**
 * How long a drop lies there before the world takes it back. 90s at 60Hz.
 *
 * Generous, because the failure it prevents is a player watching their reward
 * evaporate while they finish the fight that produced it. It is not a pressure
 * mechanic and should not be tuned into one.
 */
export const DROP_LIFETIME_TICKS = 5400;

/** One row of a monster's table: what, how many, and how often against the rest. */
export interface DropEntry {
  readonly defId: string;
  readonly count: number;
  /** Relative weight within the table. Weights need not sum to anything. */
  readonly weight: number;
}

export interface DropTable {
  /**
   * Chance that this monster drops anything at all, 0..1, before the live
   * `dropRateMultiplier`.
   *
   * Split from the weights on purpose: "how often does anything happen" and
   * "given something happened, what was it" are the two questions a designer
   * asks separately, and one combined number answers neither.
   */
  readonly chance: number;
  readonly entries: readonly DropEntry[];
}

/**
 * What each monster leaves.
 *
 * Small and unglamorous by design. The point of spec 158 is the reveal, and a
 * generous table would make the ceremony ordinary within a minute -- which is
 * exactly the contrast failure `docs/reward-philosophy.md` §3 warns about. The
 * one exceptional entry is on the one monster that is genuinely a fight.
 *
 * A monster with no row here drops nothing, which is why the training dummy
 * needs no entry saying so.
 */
export const DROP_TABLES: ReadonlyMap<string, DropTable> = new Map<string, DropTable>([
  [
    'grazer',
    {
      chance: 0.25,
      entries: [
        { defId: 'potion.minor', count: 1, weight: 6 },
        // The two level-2 affliction sigils, on the earliest bodies in the
        // world (spec 190). An affliction nobody can reach is a table nothing
        // reads, and the two that go here are the two whose skills are cheap
        // enough to be somebody's first: a dart you stack, and a cut that
        // punishes a runner.
        { defId: 'sigil.poisonDart', count: 1, weight: 1 },
      ],
    },
  ],
  [
    'small_spider',
    {
      chance: 0.25,
      entries: [
        { defId: 'potion.minor', count: 1, weight: 6 },
        { defId: 'sigil.rendingCut', count: 1, weight: 1 },
      ],
    },
  ],
  [
    'stalker',
    {
      chance: 0.35,
      entries: [
        { defId: 'potion.minor', count: 1, weight: 10 },
        { defId: 'helm.leather', count: 1, weight: 4 },
        // A skill is an item, so it drops like one (spec 188). Crippling
        // Strike is the level-2 sigil, which puts it on the earliest body that
        // drops anything worth walking over to.
        { defId: 'sigil.cripplingStrike', count: 1, weight: 2 },
        { defId: 'sigil.acidSpray', count: 1, weight: 2 },
        { defId: 'trinket.swiftband', count: 1, weight: 1 },
      ],
    },
  ],
  [
    'slinger',
    {
      chance: 0.35,
      entries: [
        { defId: 'potion.minor', count: 2, weight: 10 },
        { defId: 'stars.weighted', count: 1, weight: 4 },
        { defId: 'sigil.cripplingStrike', count: 1, weight: 2 },
        { defId: 'sigil.emberToss', count: 1, weight: 2 },
        { defId: 'sigil.arcLash', count: 1, weight: 2 },
        { defId: 'sigil.rimeTouch', count: 1, weight: 2 },
        { defId: 'focus.quartz', count: 1, weight: 1 },
      ],
    },
  ],
  [
    'ravager',
    {
      chance: 0.5,
      entries: [
        // The common anchor, raised by spec 190 from 12 and 6. Not a balance
        // whim: this table sat at *exactly* 1.5 commons per rare, which is the
        // boundary `loot.test.ts` asserts, so it had been passing on the roll of
        // one seed rather than on the rule -- and one more rare row tipped it.
        // Twice as much common weight as rare is the rule with room in it.
        { defId: 'potion.minor', count: 2, weight: 16 },
        { defId: 'chest.leather', count: 1, weight: 8 },
        { defId: 'sword.keen', count: 1, weight: 3 },
        { defId: 'maul.iron', count: 1, weight: 3 },
        // The two rare sigils, on the only body in the table that drops
        // anything else rare. Weighted like the weapons they sit beside,
        // because a skill is worth roughly what a weapon is worth.
        { defId: 'sigil.stunningBlow', count: 1, weight: 3 },
        { defId: 'sigil.whirlwind', count: 1, weight: 3 },
        // The one exceptional sigil, on the one body that could reasonably
        // carry it (spec 190).
        { defId: 'sigil.blight', count: 1, weight: 1 },
        { defId: 'trinket.bloodstone', count: 1, weight: 1 },
      ],
    },
  ],
]);

/** Scale under which a table's chance is treated as "never", not "almost never". */
const NEVER = 1e-9;

/**
 * What a monster left, or null.
 *
 * Threads the {@link Rng} through immutably like every other draw in the sim,
 * and **always draws the same number of values for the same table**: the chance
 * roll and the weight roll both happen, or neither does. A body that drew a
 * different count depending on its own outcome would change every fight after
 * it, which is the rule `blow.ts` states about rolling crit before the weak
 * point and it applies just as hard here.
 *
 * `dropRate` is the live `dropRateMultiplier` -- a knob that has existed since
 * spec 056 scaling a roll that did not. Zero disables drops outright, which is
 * what a balance harness or a load test wants.
 */
export function rollLoot(rng: Rng, monsterId: string, dropRate: number): [ItemStack | null, Rng] {
  const table = DROP_TABLES.get(monsterId);
  if (!table || table.entries.length === 0) return [null, rng];

  const chance = Math.max(0, Math.min(1, table.chance * Math.max(0, dropRate)));
  if (chance <= NEVER) return [null, rng];

  // Basis points, so the roll is integer arithmetic and reproduces exactly
  // across engines -- the same 0..9999 the crit roll uses.
  const [roll, afterChance] = rng.nextInt(0, 9999);
  const total = table.entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (total <= 0) return [null, afterChance];

  const [pick, afterPick] = afterChance.nextInt(0, total - 1);
  if (roll >= Math.round(chance * 10000)) return [null, afterPick];

  let cursor = pick;
  for (const entry of table.entries) {
    cursor -= Math.max(0, entry.weight);
    if (cursor >= 0) continue;
    // Clamped against the item's own stack ceiling, so a table row asking for
    // five of something that stacks to three cannot mint a stack the bag rules
    // would refuse to hold.
    const count = Math.max(1, Math.min(Math.floor(entry.count), maxStackOf(entry.defId)));
    return [itemById(entry.defId) === null ? null : { defId: entry.defId, count }, afterPick];
  }
  return [null, afterPick];
}
