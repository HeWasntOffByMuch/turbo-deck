/**
 * What drops, and how loudly it announces itself (spec 156).
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
   * Ticks from landing to the anticipation cue. Never past {@link revealTicks},
   * and equal to it only when there is no anticipation window at all.
   */
  readonly anticipationTicks: number;
  /**
   * Cue **names**, not assets (spec 156).
   *
   * The renderer decides what a name sounds and looks like; loot logic never
   * learns, and the server never sees one at all -- it sends a tier and two
   * ticks, and the client looks the rest up here. An empty name is "no cue",
   * which is how a common drop says nothing rather than saying something
   * quiet.
   */
  readonly cues: {
    readonly spawn: string;
    readonly anticipation: string;
    readonly reveal: string;
  };
  /**
   * How bright the drop's flare sits at rest, 0..1.
   *
   * The floor a tier never goes below once it has revealed, and the contrast
   * §3 of `docs/reward-philosophy.md` is about: a common drop is a dim object
   * in the grass forever, and nothing about it competes with the one that is
   * not.
   */
  readonly restFlare: number;
  /**
   * How bright it gets at the top of its run-up, 0..1.
   *
   * Equal to {@link restFlare} for a tier with nothing to build up to, which is
   * what makes common loot a flat dim object rather than one with a small
   * ceremony -- and what lets "a common drop is dimmer than every other tier at
   * every tick" be a property with a test behind it rather than a hope about
   * two curves.
   */
  readonly peakFlare: number;
  /**
   * Whether the drop has a pulse (spec 156).
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
 * At 60Hz: 0.75s for a rare, 1.6s for an exceptional.
 *
 * Long enough to be a beat rather than a stutter, short enough that walking two
 * steps to the thing already covers most of it -- which is the point. The
 * reveal is meant to resolve at about the moment a player who reacted to the
 * cue arrives, not to make them stand and wait for it.
 */
const RARITY_ROWS: readonly RarityRow[] = [
  {
    id: 'common',
    name: 'Common',
    revealTicks: 0,
    anticipationTicks: 0,
    cues: { spawn: 'loot.spawn.common', anticipation: '', reveal: '' },
    restFlare: 0.12,
    peakFlare: 0.12,
    heartbeat: false,
  },
  {
    id: 'rare',
    name: 'Rare',
    revealTicks: 45,
    anticipationTicks: 9,
    cues: {
      spawn: 'loot.spawn.rare',
      anticipation: 'loot.anticipation.rare',
      reveal: 'loot.reveal.rare',
    },
    restFlare: 0.45,
    peakFlare: 0.9,
    heartbeat: true,
  },
  {
    id: 'exceptional',
    name: 'Exceptional',
    revealTicks: 96,
    anticipationTicks: 12,
    cues: {
      spawn: 'loot.spawn.exceptional',
      anticipation: 'loot.anticipation.exceptional',
      reveal: 'loot.reveal.exceptional',
    },
    restFlare: 0.7,
    peakFlare: 1,
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
 * Small and unglamorous by design. The point of spec 156 is the reveal, and a
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
    { chance: 0.25, entries: [{ defId: 'potion.minor', count: 1, weight: 1 }] },
  ],
  [
    'small_spider',
    { chance: 0.25, entries: [{ defId: 'potion.minor', count: 1, weight: 1 }] },
  ],
  [
    'stalker',
    {
      chance: 0.35,
      entries: [
        { defId: 'potion.minor', count: 1, weight: 10 },
        { defId: 'helm.leather', count: 1, weight: 4 },
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
        { defId: 'focus.quartz', count: 1, weight: 1 },
      ],
    },
  ],
  [
    'ravager',
    {
      chance: 0.5,
      entries: [
        { defId: 'potion.minor', count: 2, weight: 12 },
        { defId: 'chest.leather', count: 1, weight: 6 },
        { defId: 'sword.keen', count: 1, weight: 3 },
        { defId: 'maul.iron', count: 1, weight: 3 },
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
