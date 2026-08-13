/**
 * Editing a character's level and experience (spec 153).
 *
 * Pure, so the three rules below are tested without a store, a session or a
 * socket. `PlayerManager.setProgress` commits what {@link applyProgress} returns
 * and calls `recalculate`, which is the single funnel every stat change already
 * passes through.
 *
 * The rules exist because a level is not one number -- it is a number, the skill
 * points it earned, and the experience it has not yet spent on the next one. An
 * edit that moves one and not the others leaves the record saying something the
 * game's own rules say is impossible, and nothing downstream would notice:
 *
 *  1. **Skill points are re-derived from the level, never adjusted by a delta.**
 *     Adding one per level granted and subtracting one per level removed looks
 *     equivalent and is not -- grant 5 levels, spend the points, reset the level
 *     to 1, and a delta leaves the points spent and the level gone.
 *  2. **A level that cannot pay for its tree respecs it.** You cannot hold twelve
 *     points of skills at level 1, so the tree is cleared and every earned point
 *     handed back. The caller is told, because an operator who silently deleted
 *     somebody's build would hear about it from the player.
 *  3. **Experience is clamped into its own level's band.** Otherwise `SetLevel 1`
 *     on a level-20 character is a character who re-levels on their next kill.
 */

import { AdminProgressMode, type AdminProgressModeValue } from '../net/protocol.js';
import type { PersistedPlayer } from '../state/types.js';
import { totalPointsSpent } from './skills.js';

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

/** Skill points granted per level gained. */
export const SKILL_POINTS_PER_LEVEL = 1;

/**
 * The highest level an edit may reach.
 *
 * The first level cap this game states, and stated here for one narrow reason:
 * `HP_PER_LEVEL` and the rest of `computeEffectiveStats` are linear in the level,
 * so an unclamped `AddLevels 1000000` from a typo is a body with ten million
 * health. It bounds an admin edit. Nothing in the sim reads it, and it is not a
 * claim about where the game ends.
 */
export const MAX_PLAYER_LEVEL = 60;

/**
 * Every skill point a character at this level has been given, spent or not.
 *
 * The `1` is the point `createCharacter` starts a level-1 character with, so this
 * agrees with a character who has never been edited.
 */
export function earnedSkillPoints(level: number): number {
  const levels = Math.max(0, Math.floor(level) - 1);
  return 1 + levels * SKILL_POINTS_PER_LEVEL;
}

/** The highest experience a character at `level` may hold without owing a level. */
export function experienceCeiling(level: number): number {
  return Math.max(0, experienceForLevel(level + 1) - 1);
}

export interface ProgressOutcome {
  readonly player: PersistedPlayer;
  /** What changed, for the operator's reply and the audit entry. */
  readonly detail: string;
  /** True when rule 2 fired and the skill tree was cleared. */
  readonly respecced: boolean;
}

function clampLevel(level: number): number {
  return Math.min(MAX_PLAYER_LEVEL, Math.max(1, Math.floor(level)));
}

/**
 * Applies one edit and returns a whole, self-consistent record.
 *
 * `amount` is a u32 on the wire, so an `Add` cannot be negative; a decrease is a
 * `Set`. Both are floored and clamped here anyway rather than trusted, because
 * this is also called from tests and from a future caller that is not the wire.
 */
export function applyProgress(
  player: PersistedPlayer,
  mode: AdminProgressModeValue,
  amount: number,
): ProgressOutcome {
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
      // The same loop the monster award runs, so an admin grant and a kill level
      // a character up identically -- including through several levels at once.
      while (level < MAX_PLAYER_LEVEL && experience >= experienceForLevel(level + 1)) {
        experience -= experienceForLevel(level + 1);
        level += 1;
      }
      break;
    }
  }

  // Rule 3, applied after every mode rather than inside two of them: a level
  // that moved may have brought its own ceiling down under the experience that
  // was already there.
  experience = Math.min(experience, experienceCeiling(level));

  // Rules 1 and 2.
  const earned = earnedSkillPoints(level);
  const spent = totalPointsSpent(player.skills);
  const respecced = spent > earned;
  const skills = respecced ? [] : player.skills;
  const unspentSkillPoints = respecced ? earned : earned - spent;

  const parts: string[] = [];
  if (level !== before.level) parts.push(`level ${before.level} -> ${level}`);
  if (experience !== before.experience) parts.push(`xp ${before.experience} -> ${experience}`);
  if (parts.length === 0) parts.push('no change');
  parts.push(`${unspentSkillPoints} skill point(s)`);
  if (respecced) parts.push(`skill tree cleared (${spent} point(s) refunded)`);

  return {
    player: { ...player, level, experience, skills, unspentSkillPoints },
    detail: parts.join(', '),
    respecced,
  };
}
