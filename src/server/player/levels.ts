/**
 * Editing a character's level and experience (spec 154).
 *
 * Named for what it is about rather than for the edit, so it sits beside
 * `progression.ts` -- which resolves *attributes* into milestones and modifiers --
 * without either name suggesting it does the other's job. This file is the level
 * and what a level hands out; that one is what an allocation amounts to.
 *
 * Pure, so the rules below are tested without a store, a session or a socket.
 * `PlayerManager.setProgress` commits what {@link applyLevelEdit} returns and calls
 * `recalculate`, which is the single funnel every stat change already passes
 * through.
 *
 * The rules exist because a level is not one number. It is a number, the two
 * point budgets it earned, and the experience not yet spent on the next one. An
 * edit that moves one and not the others leaves the record saying something the
 * game's own rules say is impossible, and nothing downstream would notice:
 *
 *  1. **Both budgets are re-derived from the level, never adjusted by a delta.**
 *     Adding per level granted and subtracting per level removed looks equivalent
 *     and is not -- grant 5 levels, spend the points, reset the level to 1, and a
 *     delta leaves the points spent and the level gone.
 *  2. **A level that cannot pay for what it is holding gives it back.** You
 *     cannot hold a level-40 build at level 1. The specializations are cleared
 *     *and* the attributes go back to their starting spread -- together, since
 *     spec 244 they are one budget -- and the caller is told: an operator who
 *     silently deleted somebody's build would hear about it from the player.
 *  3. **Experience is clamped into its own level's band.** Otherwise `SetLevel 1`
 *     on a level-20 character is a character who re-levels on their next kill.
 *
 * Rule 2 covered *two* currencies from spec 147 to spec 244 and covers one now.
 * It still has to fire at all: `reconcileProgressionPoints` correctly clamps the
 * unspent count to `earned - spent`, which is zero for a level-1 character
 * holding a level-40 build. Left there, the allocation stands forever and the
 * reset only looked like it worked.
 *
 * That rule points the *opposite* way to the one `reconcileProgressionPoints`
 * applies on login, which keeps an over-budget allocation and hands back zero.
 * Deliberately, because the two have different causes. An over-budget save is
 * somebody else's bug -- a table edit, a schema change -- and the character is
 * innocent, so the generous reading is right and taking points off them would be
 * the worse failure. An over-budget *edit* is what the operator just asked for on
 * purpose, and keeping the allocation would mean "reset level" leaves a level-1
 * character wearing a level-40 spread for good.
 */

import { AdminProgressMode, type AdminProgressModeValue } from '../net/protocol.js';
import type { PersistedPlayer } from '../state/types.js';
import {
  pointsEarned as progressionPointsEarned,
  pointsSpent as attributePointsSpent,
  startingBaseStats,
} from './attributes.js';
import { totalSpecializationTiers } from './specializations.js';

/**
 * Experience needed to reach `level` from the one below it.
 *
 * Here rather than in `player-manager.ts`, where it used to live, because this
 * module and that one both need it and the dependency has to point one way. This
 * is the file about what a level costs; the manager is the file that awards them.
 */
export function experienceForLevel(level: number): number {
  return Math.round(50 * Math.pow(Math.max(1, level - 1), 1.5));
}

/**
 * The highest level an edit may reach.
 *
 * The first level cap this game states, and stated here for one narrow reason:
 * the derived stats are linear in the level, so an unclamped `AddLevels 1000000`
 * from a typo is a body with ten million health. It bounds an admin edit. Nothing
 * in the sim reads it, and it is not a claim about where the game ends.
 */
export const MAX_PLAYER_LEVEL = 60;

/** The highest experience a character at `level` may hold without owing a level. */
export function experienceCeiling(level: number): number {
  return Math.max(0, experienceForLevel(level + 1) - 1);
}

export interface LevelEditOutcome {
  readonly player: PersistedPlayer;
  /** What changed, for the operator's reply and the audit entry. */
  readonly detail: string;
  /**
   * True when rule 2 fired: the level could not pay for the build it was
   * holding, so attributes and specialization tiers were both handed back.
   */
  readonly refunded: boolean;
}

function clampLevel(level: number): number {
  return Math.min(MAX_PLAYER_LEVEL, Math.max(1, Math.floor(level)));
}

/**
 * Applies one edit and returns a whole, self-consistent record.
 *
 * `amount` is a u32 on the wire, so an `Add` cannot be negative; a decrease is a
 * `Set`. Both are floored and clamped here anyway rather than trusted, because
 * this is also called from tests and from a caller that is not the wire.
 */
export function applyLevelEdit(
  player: PersistedPlayer,
  mode: AdminProgressModeValue,
  amount: number,
): LevelEditOutcome {
  const asked = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;

  let level = clampLevel(player.level);
  let experience = Math.max(0, Math.floor(player.experience));
  const before = { level, experience };

  switch (mode) {
    case AdminProgressMode.AddLevels:
      level = clampLevel(level + asked);
      break;
    case AdminProgressMode.SetLevel:
      level = clampLevel(asked);
      break;
    case AdminProgressMode.AddExperience:
    case AdminProgressMode.SetExperience: {
      experience = mode === AdminProgressMode.AddExperience ? experience + asked : asked;
      // The same loop the monster award runs, because it *is* the monster award's
      // loop now -- so an admin grant and a kill level a character up identically,
      // including through several levels at once.
      while (level < MAX_PLAYER_LEVEL && experience >= experienceForLevel(level + 1)) {
        experience -= experienceForLevel(level + 1);
        level += 1;
      }
      break;
    }
  }

  // Rule 3, applied after every mode rather than inside two of them: a level that
  // moved may have brought its own ceiling down under the experience already there.
  experience = Math.min(experience, experienceCeiling(level));

  // Rules 1 and 2, and there is one currency to apply them to now (spec 244).
  // The old version ran them twice, once per budget, and noted that the two were
  // independent -- a level could be low enough to refund the tree and still high
  // enough to keep the spread. With one pool there is one comparison: what the
  // character is holding, against what the level earned. Over budget refunds
  // *both*, because a half-refund into a shared pool leaves a character whose
  // remaining half is affordable only by accident.
  const earned = progressionPointsEarned(level);
  const spentAttributes = attributePointsSpent(player.baseStats);
  const spentTiers = totalSpecializationTiers(player.specializations);
  const spent = spentAttributes + spentTiers;
  const refunded = spent > earned;

  const specializations = refunded ? [] : player.specializations;
  const baseStats = refunded ? startingBaseStats() : player.baseStats;
  const unspentProgressionPoints = refunded ? earned : earned - spent;

  const parts: string[] = [];
  if (level !== before.level) parts.push(`level ${before.level} -> ${level}`);
  if (experience !== before.experience) parts.push(`xp ${before.experience} -> ${experience}`);
  if (parts.length === 0) parts.push('no change');
  parts.push(`${unspentProgressionPoints} progression point(s)`);
  if (refunded) {
    parts.push(`build reset (${spentAttributes} attribute + ${spentTiers} tier point(s) refunded)`);
  }

  return {
    player: {
      ...player,
      level,
      experience,
      specializations,
      baseStats,
      unspentProgressionPoints,
    },
    detail: parts.join(', '),
    refunded,
  };
}
