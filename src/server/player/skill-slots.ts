/**
 * The four active-skill slots, and what may be done to them (spec 184).
 *
 * Pure, and it is the only place three questions are answered:
 *
 *  1. **What can this character cast?** `skillAbilityIdsOf` reads the four
 *     slots, exactly as `basicAttackFor` reads the main hand. Its answer is a
 *     derived stat, never a client's claim, and `startCast` gates on it.
 *  2. **May this slot be emptied right now?** A skill on cooldown may not leave
 *     its slot -- which is the brief's one hard rule about swapping and the one
 *     thing that stops four sigils in a bag being twelve castable skills.
 *  3. **Where does a swap take its time from?** `SKILL_SWAP` in
 *     `data/skill-effects.ts`; the queue that spends it lives on the connection
 *     in `server.ts`, the same shape spec 172's drop queue has.
 *
 * All three take plain arguments rather than a session or an entity, so the
 * rules are testable without a server and so the server, the sim and a test
 * cannot each hold a slightly different version of them.
 */

import { itemById } from '../data/items.js';
import { SKILL_EQUIP_SLOTS, isSkillSlot, type Equipment, type SlotAddress } from '../state/types.js';
import { equipSlotAt } from './inventory.js';

export { SKILL_EQUIP_SLOTS, isSkillSlot } from '../state/types.js';

/** How many active-skill slots a character has. Four, and it is a rule. */
export const SKILL_SLOT_COUNT = SKILL_EQUIP_SLOTS.length;

/**
 * The ability a worn item casts, or null.
 *
 * `null` for an id the table no longer defines and for an item that is not a
 * skill, so an empty slot, a stale save and a sword all give the same answer.
 */
export function activeSkillOf(defId: string | null): string | null {
  if (defId === null) return null;
  return itemById(defId)?.activeSkillId ?? null;
}

/**
 * What this character may cast, in slot order (spec 184).
 *
 * Positional -- a slot holding nothing is `null` rather than being skipped --
 * because the index *is* the action-bar index, and a list that closed its gaps
 * would silently renumber the player's keys the moment a slot was emptied.
 */
export function skillSlotAbilities(equipment: Equipment): readonly (string | null)[] {
  return SKILL_EQUIP_SLOTS.map((slot) => activeSkillOf(equipment[slot]));
}

/**
 * The same list with the gaps closed, which is what an ownership check wants.
 *
 * A separate function rather than a `.filter` at the call site, because the two
 * shapes mean different things and mixing them up would be an off-by-one in the
 * bar or a hole in the gate.
 */
export function skillAbilityIdsOf(equipment: Equipment): readonly string[] {
  return skillSlotAbilities(equipment).filter((id): id is string => id !== null);
}

/**
 * Whether a slot address names one of the four.
 *
 * Equipment addresses only: an inventory index is never a skill slot however
 * large it is, which is the check the naive `index >= 6` version got wrong.
 */
export function addressIsSkillSlot(at: SlotAddress): boolean {
  if (at.container !== 'equipment') return false;
  const slot = equipSlotAt(at.index);
  return slot !== null && isSkillSlot(slot);
}

/**
 * Whether the skill worn at `at` is still on cooldown, given the entity's
 * cooldown map.
 *
 * Reads the *entity's* map, which is where cooldowns have always lived
 * (`ServerEntity.cooldowns`, keyed by ability id, stamped at the attack point
 * and nowhere else). The brief asks for cooldown state to belong to the
 * equipped skill "in whatever manner best matches the current item
 * architecture", and this architecture has no item instances at all -- an item
 * *is* its definition plus a count. So the cooldown belongs to the body that
 * cast it, keyed by what it cast, which is exactly what already existed.
 */
export function skillSlotOnCooldown(
  equipment: Equipment,
  at: SlotAddress,
  cooldowns: Readonly<Record<string, number>>,
  tick: number,
): boolean {
  if (!addressIsSkillSlot(at)) return false;
  const slot = equipSlotAt(at.index);
  if (slot === null) return false;
  const abilityId = activeSkillOf(equipment[slot]);
  if (abilityId === null) return false;
  return tick < (cooldowns[abilityId] ?? 0);
}

/**
 * Why this move may not touch a skill slot right now, or null (spec 184).
 *
 * Called by `server.ts` before the move is delegated, because the rule needs
 * three things that live in three places -- the equipment (the store), the
 * cooldowns and the tick (the entity) -- and only the server holds all three.
 * Pure so that all of it is testable without any of them.
 *
 * The rule is stated over **either end** of the move rather than only over the
 * source, and that is not belt and braces: swapping a fresh sigil *into* an
 * occupied slot empties that slot just as surely as dragging the old one out,
 * and a check that only looked at `from` would leave the obvious way round it.
 */
export function skillSwapRefusal(
  equipment: Equipment,
  request: { readonly from: SlotAddress; readonly to: SlotAddress },
  cooldowns: Readonly<Record<string, number>>,
  tick: number,
): string | null {
  for (const at of [request.from, request.to]) {
    if (skillSlotOnCooldown(equipment, at, cooldowns, tick)) {
      return 'that skill is still on cooldown';
    }
  }
  return null;
}

/** Whether a move touches a skill slot at either end, and so has to be timed. */
export function movesASkill(request: { readonly from: SlotAddress; readonly to: SlotAddress }): boolean {
  return addressIsSkillSlot(request.from) || addressIsSkillSlot(request.to);
}
