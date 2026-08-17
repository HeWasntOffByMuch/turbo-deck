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

/** How many skill slots there are, before the vial. */
export const SKILL_SLOTS = 4;

/** The bar as it ships: four empty slots and the vial. */
export const ACTION_BAR: readonly ActionSlot[] = buildActionBar([]);

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
 * The bar a `?slots=` query parameter asks for, or the shipped one.
 *
 * A developer path and nothing else, in the same register as `?seed=`, `?wire=`
 * and `?units=`: the four slots ship empty and there is no way for a *player* to
 * put anything in one, because binding a skill needs a source to drag from and
 * that is a change of its own.
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
export function actionBarFromQuery(search: string): readonly ActionSlot[] {
  const raw = new URLSearchParams(search).get('slots');
  if (raw === null) return ACTION_BAR;
  return buildActionBar(raw.split(',').map((id) => (id.trim() === '' ? null : id.trim())));
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
