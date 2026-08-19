/**
 * What the bar along the bottom holds (spec 164).
 *
 * Five slots: four empty ones a skill will go into, and the vial. It replaces
 * the nine-entry `HOTBAR`, which was every ability in the table laid out in
 * authoring order -- the bar has *been* the ability list since spec 062, which
 * is a debug affordance that survived into the shipped interface.
 *
 * The emptiness is the feature and not a placeholder for one: a slot with
 * nothing in it is a place a skill will go, which is a thing an interface can
 * show, and a nine-wide list of everything cannot. Nothing here binds a skill
 * into a slot -- that needs a drag from the skill tree and is its own change.
 *
 * The rule that makes this worth a module rather than an array in `hud.ts`:
 * {@link abilityForSlot} is the **only** way a slot index becomes an ability, so
 * the key and the button cannot come to different answers, and neither of them
 * can cast out of a slot that holds nothing. `view.ts` reads it for `Digit1..5`
 * and `hud.ts` reads it for the click, and both are handed the *same* bar rather
 * than each building one.
 */

import type { Equipment } from '../../../server/state/types.js';
import { SKILL_EQUIP_SLOTS, skillSlotAbilities } from '../../../server/player/skill-slots.js';

/** A skill slot, or the vial. */
export type ActionSlotKind = 'skill' | 'vial';

export interface ActionSlot {
  readonly kind: ActionSlotKind;
  /** What this slot casts, or null for a slot nothing has been put in yet. */
  readonly abilityId: string | null;
  /** The key that presses it, 1-based, matching `skillbar.N` in bindings.json. */
  readonly keyNumber: number;
}

/**
 * The flask (spec 156), which gets a slot of its own after all.
 *
 * Spec 156 put it on the bar "because it is an ability like every other and the
 * only thing that makes it insurance is what it costs". That argument was about
 * the *rules* and it still holds -- nothing here gives the flask a rule of its
 * own. What changed is that the bar went from nine undifferentiated rectangles
 * to five, and four skill slots plus a flask in one identical row makes the
 * flask look like a fifth skill. Its cost is a charge rather than resource, and
 * a slot that draws its charge count is the interface saying so.
 */
export const VIAL_ABILITY_ID = 'self.hearthdraught';

/**
 * How many skill slots there are, before the vial.
 *
 * The same four as `SKILL_EQUIP_SLOTS` since spec 184, and asserted to be:
 * the four cells beside the backpack and the four along the bottom of the
 * screen are the *same* four slots, so a mismatch between the two counts would
 * be a bar with a button that reaches nothing.
 */
export const SKILL_SLOTS = SKILL_EQUIP_SLOTS.length;

/** The bar as it ships: four empty slots and the vial. */
export const ACTION_BAR: readonly ActionSlot[] = buildActionBar([]);

/**
 * The bar a player's equipment produces (spec 184).
 *
 * The one way a slot comes to hold something now: a skill is an item worn in
 * one of the four skill slots, so what the bar holds is a *view of the
 * equipment* and nothing on this side decides it. That is what makes the four
 * cells in the bag and the four along the bottom the same four -- there is no
 * second list to keep in step, because there is no second list.
 *
 * Positional: an empty slot stays empty rather than being closed up, so
 * emptying slot 2 does not silently renumber the player's keys.
 */
export function actionBarFor(equipment: Equipment): readonly ActionSlot[] {
  return buildActionBar(skillSlotAbilities(equipment));
}

/**
 * A bar with `abilityIds` in its skill slots, shortest wins.
 *
 * The vial is always last and is never one of them -- it is not a skill slot and
 * a caller that could overwrite it would be a caller that could take the flask
 * off the bar by naming five things.
 */
export function buildActionBar(abilityIds: readonly (string | null)[]): readonly ActionSlot[] {
  return [
    ...Array.from({ length: SKILL_SLOTS }, (_, index): ActionSlot => ({
      kind: 'skill',
      abilityId: abilityIds[index] ?? null,
      keyNumber: index + 1,
    })),
    { kind: 'vial', abilityId: VIAL_ABILITY_ID, keyNumber: SKILL_SLOTS + 1 },
  ];
}

/**
 * The bar a `?slots=` query parameter asks for, or **null** for "use the
 * player's equipment".
 *
 * A developer path and nothing else, in the same register as `?seed=`, `?wire=`
 * and `?units=`. It used to be the *only* way a slot could hold anything;
 * spec 184 made equipment the ordinary way, so this now **overrides** the
 * equipped skills rather than filling a bar nothing else could fill -- which is
 * what keeps it useful: a harness that wants `ground.quake` on the bar should
 * not have to loot a sigil for it first.
 *
 * It exists because the alternative was worse than a query parameter. With the
 * bar empty, every ability in the game except the auto-attack and the flask
 * became unreachable from the shipped page -- and the browser harnesses that
 * check the aim (spec 080), the cooldown refusal and the ground telegraph
 * (spec 153) had nothing left to press. Deleting those checks would have been
 * the change quietly taking the coverage with it.
 *
 * `?slots=` names ability ids in order, comma separated, and an empty entry
 * leaves that slot empty: `?slots=melee.heavy,,ground.quake` fills the first and
 * the third. Ids are *not* validated here -- an id naming nothing resolves to no
 * ability in `hud.ts` and draws as an empty slot, which is the same nothing an
 * unfilled slot is and needs no second path.
 */
export function actionBarFromQuery(search: string): readonly ActionSlot[] | null {
  const raw = new URLSearchParams(search).get('slots');
  if (raw === null) return null;
  return buildActionBar(raw.split(',').map((id) => (id.trim() === '' ? null : id.trim())));
}

/**
 * Whether two bars hold the same things in the same places (spec 184).
 *
 * The guard on rebuilding the row: what a bar *is* is its five ability ids in
 * order, so two bars agreeing on those are the same bar however they were
 * built. Here rather than in `hud.ts` because it is a statement about the model
 * and not about the DOM, and because a test can then assert it.
 */
export function sameBar(
  a: readonly { readonly abilityId: string | null }[],
  b: readonly { readonly abilityId: string | null }[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((slot, index) => slot.abilityId === b[index]?.abilityId);
}

/**
 * What pressing slot `index` of `bar` casts, or null.
 *
 * Null for an empty slot **and** for an index that is not a slot, because the
 * two mean the same thing to every caller: nothing happens. There are ten
 * skillbar bindings and five slots, so keys 6-0 land here and have to be as
 * inert as the empty ones.
 */
export function abilityForSlot(bar: readonly ActionSlot[], index: number): string | null {
  return bar[index]?.abilityId ?? null;
}
