/**
 * Noticing that a track just gave you something (spec 283).
 *
 * Attributes start at 5 and the first node on every track is at 10, and a fresh
 * character holds six progression points -- so the first twelve mechanics in
 * this game are unlocked *before the first level-up*, and until this nothing
 * anywhere said one had opened. `player.attributeUp` played on the press for
 * every point, so 9 to 10 sounded exactly like 5 to 6, and the purchase surfaced
 * only on a sheet the player already had open.
 *
 * **Derived, never sent.** `ClientView.attributes` and
 * `ClientView.specializations` are both already replicated on `Stats`, so a
 * threshold crossing is a diff of two readings and this costs no protocol
 * change, no server state and nothing to forget to clear. It is `xp-gain.ts`'s
 * own shape, and it keeps that file's two hard-won rules for that file's
 * reasons:
 *
 *  - **The first reading only baselines.** A `Stats` carries a whole character,
 *    so a watch that reported on its first one would throw a session's worth of
 *    unlocks across the screen of somebody who has just logged in.
 *  - **A move backwards re-baselines silently.** A respec is not a reward, and
 *    an admin edit is not either. Leaving the old baseline would swallow every
 *    real unlock until the character had climbed back to where it was.
 *
 * What it deliberately does *not* fire on is an ordinary numeric tier. A second
 * rank of Crushing Blows is 18% more Guard damage and nothing a player has to
 * learn, and reward-philosophy §10's rule is that not every tier gets ceremony
 * -- basic loot stays quiet so unusual loot keeps its contrast, and the same
 * holds one system over. The test for "this one needs saying" is a *data* test
 * rather than a judgement: `GRANT_LABELS` marks a capability field `form:
 * 'flag'`, so `grantsOf` hands back a `whole` grant for exactly the rows that
 * turn something on.
 *
 * Pure. No DOM, no clock, and no storage -- what has already been shown is the
 * caller's to remember, because it outlives a session and this does not.
 */

import { ATTRIBUTE_KEYS, ATTRIBUTES, type AttributeKey } from '../../../server/data/attributes.js';
import {
  describeMilestone,
  describeSpecialization,
  grantsOf,
} from '../../../server/data/description.js';
import { ALL_SPECIALIZATIONS } from '../../../server/data/specializations.js';
import { trackFor, type TrackNode } from '../../../server/data/tracks.js';
import type { BaseStats, SpecializationAllocation } from '../../../server/state/types.js';
import type { TooltipLine } from '../../../ui/widgets/tooltip.js';
import { describedLines } from './described-lines.js';

/** What this watches: the two progression fields `Stats` already replicates. */
export interface ProgressionReading {
  readonly attributes: BaseStats;
  readonly specializations: readonly SpecializationAllocation[];
}

/**
 * Which of the three things just happened.
 *
 * Three rather than one because they are three different sentences to a player,
 * and only one of them is "you gained something":
 *
 *  - `threshold` -- a node opened. **Nothing changed yet**; what is new is that
 *    there are things to buy. This is the one that fires at level 1 and it is
 *    the whole reason this module exists.
 *  - `milestone` -- an automatic one fired. The body can now do something it
 *    could not do a tick ago, and nobody pressed anything for it.
 *  - `capability` -- a purchased tier turned a mechanic on.
 */
export type UnlockKind = 'threshold' | 'milestone' | 'capability';

export interface Unlock {
  /**
   * Stable across sessions and across builds, because it is what the seen list
   * is keyed on: a generated id would re-show every notice the first time
   * anything about the ordering moved.
   */
  readonly id: string;
  readonly kind: UnlockKind;
  readonly title: string;
  /** What it is, already composed -- `src/ui/` may not read the tables. */
  readonly lines: readonly TooltipLine[];
}

const NONE: readonly Unlock[] = [];

function attributeName(key: AttributeKey): string {
  return ATTRIBUTES.find((entry) => entry.key === key)?.name ?? key;
}

/**
 * What opening a node is worth saying, when no milestone sits on it.
 *
 * Deliberately **not** a description of the specializations themselves. Two rows
 * at once is two Technical Descriptions in a box that is meant to be read at a
 * glance mid-fight, and the character sheet already draws both properly, with
 * their tiers and their costs and a button. What this says is that there is
 * something there — which is the fact the player does not have.
 */
function thresholdLines(key: AttributeKey, node: TrackNode): readonly TooltipLine[] {
  const names = node.specializations.map((row) => row.name);
  return [
    { text: `${attributeName(key)} ${String(node.threshold)}`, colorToken: 'focus' },
    ...names.map((name) => ({ text: name, colorToken: 'text' })),
    { text: 'Open the character sheet to spend a point on one.', colorToken: 'textDim' },
  ];
}

/** Whether a row turns a mechanic on, rather than moving a number. */
function isCapability(specializationId: string): boolean {
  const row = ALL_SPECIALIZATIONS.find((entry) => entry.id === specializationId);
  if (!row) return false;
  return grantsOf(row.perTier).some((grant) => grant.whole === true);
}

export class UnlockWatch {
  private attributes: BaseStats | null = null;
  private tiers: ReadonlyMap<string, number> = new Map();
  /**
   * What this watch has already yielded.
   *
   * Session-scoped and separate from whatever the caller persists: a `Stats`
   * arrives on login, on every equip, on every spend and on every level, so
   * without it a player who equips a hat is told again about every node they
   * have ever passed.
   */
  private readonly yielded = new Set<string>();

  /**
   * Seed the watch from what has already been shown, so a notice survives being
   * *dismissed* rather than only being *drawn*.
   */
  constructor(alreadySeen: Iterable<string> = []) {
    for (const id of alreadySeen) this.yielded.add(id);
  }

  observe(reading: ProgressionReading): readonly Unlock[] {
    const tiers = new Map(reading.specializations.map((held) => [held.specializationId, held.tier]));
    const previous = this.attributes;
    const previousTiers = this.tiers;
    this.attributes = reading.attributes;
    this.tiers = tiers;

    // The first reading is a whole character, not a change to one.
    if (previous === null) return NONE;

    const found: Unlock[] = [];
    for (const key of ATTRIBUTE_KEYS) {
      const before = previous[key];
      const now = reading.attributes[key];
      // Backwards is a respec or an admin edit. The baseline has already been
      // replaced above, so this is the whole of "re-baseline silently".
      if (now <= before) continue;
      for (const node of trackFor(key).nodes) {
        if (node.threshold <= before || node.threshold > now) continue;
        // One notice per node, and a milestone wins where a node carries both
        // -- Constitution's mastery rows sit on the same threshold as the
        // Overflow Vitality milestone (spec 273), and what fired on its own is
        // the more surprising half of that.
        const unlock =
          node.milestone === null
            ? {
                id: `node:${key}:${String(node.threshold)}`,
                kind: 'threshold' as const,
                title: `${attributeName(key)} ${String(node.threshold)}`,
                lines: thresholdLines(key, node),
              }
            : {
                id: `milestone:${node.milestone.id}`,
                kind: 'milestone' as const,
                title: node.milestone.name,
                lines: describedLines(describeMilestone(node.milestone)),
              };
        if (this.yielded.has(unlock.id)) continue;
        this.yielded.add(unlock.id);
        found.push(unlock);
      }
    }

    for (const [id, tier] of tiers) {
      // The tier that turns it on, and only that one. Tier 2 of a capability row
      // is more of a mechanic the player already has.
      if (tier < 1 || (previousTiers.get(id) ?? 0) >= 1) continue;
      if (!isCapability(id)) continue;
      const row = ALL_SPECIALIZATIONS.find((entry) => entry.id === id);
      if (!row) continue;
      const unlockId = `spec:${id}`;
      if (this.yielded.has(unlockId)) continue;
      this.yielded.add(unlockId);
      found.push({
        id: unlockId,
        kind: 'capability',
        title: row.name,
        // Described at the tier just bought rather than at zero, because the
        // question somebody who has just spent a point has is what they now
        // have, not what one more would cost.
        lines: describedLines(describeSpecialization(row, tier)),
      });
    }

    return found.length > 0 ? found : NONE;
  }

  /** Everything shown so far, for the caller that persists it. */
  get seen(): readonly string[] {
    return [...this.yielded];
  }
}
