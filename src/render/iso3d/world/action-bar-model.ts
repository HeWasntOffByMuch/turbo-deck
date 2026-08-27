/**
 * What the bar along the bottom is handed, every frame (spec 196).
 *
 * Beside `character-model.ts` and `inventory-model.ts` for the reason those are
 * out here: `src/ui/` may not reach the sim, so the replicated facts, the
 * ability table and the key map are turned into plain rows on this side of the
 * fence. A screen renders what it is handed and decides nothing -- including
 * which slot is lit and how far a wedge has drained.
 *
 * What it is *not* is a second opinion about what is on the bar.
 * {@link import('./action-bar.js').abilityForSlot} is still the only way a slot
 * index becomes an ability, and the plan handed in here is the one `view.ts`
 * built and presses keys against -- so a button and a key cannot come to
 * different answers, which is the rule spec 164 wrote the module for.
 *
 * Pure. No DOM, no clock: the tick being drawn arrives from the caller.
 */

import { SERVER_TICK_RATE } from '../../../server/config.js';
import { abilityById, barNameOf, type AbilityDefinition } from '../../../server/data/abilities.js';
import { attackTimingFor } from '../../../server/sim/abilities.js';
import { describeAbility, type Tone } from '../../../server/data/description.js';
import type { EffectiveStats } from '../../../server/state/types.js';
import { chordLabel } from '../../../ui/input/actions.js';
import { ATTRIBUTE_TOKENS } from '../../../ui/theme/theme.js';
import type { InputMap } from '../../../ui/input/input-map.js';
import type {
  ActionBarView,
  ActionSlotView,
  SlotHighlight,
  TooltipLine,
} from '../../../ui/screens/action-bar.js';
import type { AbilityView } from '../../../ui/widgets/skill-slot.js';
import { abilityIconFor } from './character-model.js';
import type { ActionSlot } from './action-bar.js';
import { barSlotOf, swapLabel, type SwapProgress } from './skill-swap-view.js';

/** Everything about the player the bar reads, narrowed to what it actually uses. */
export interface ActionBarSource {
  /** The five slots, as `view.ts` built them. The one list. */
  readonly bar: readonly ActionSlot[];
  /** Ability id -> the tick it is ready on, straight from the server. */
  readonly cooldowns: Readonly<Record<string, number>>;
  readonly resource: number;
  /** The flask's charges (spec 156), which is what the vial's badge counts. */
  readonly restoration: { readonly charges: number; readonly maxCharges: number };
  /** Every cast in flight, and whose body this is, so ours can be picked out. */
  readonly casts: readonly { readonly entityId: number; readonly abilityId: string }[];
  readonly selfEntityId: number;
  /** What was asked for and not yet answered, or null (spec 080). */
  readonly requestedAbilityId: string | null;
  /** What is being aimed, or null (spec 080). */
  readonly aimingAbilityId: string | null;
  /** Derived stats, for the basic attack's real interval. Null before they land. */
  readonly stats: EffectiveStats | null;
  /** A skill-slot change in flight (spec 188), already resolved against the tick. */
  readonly swap: SwapProgress | null;
  /** The tick being drawn, so a wedge is measured against it and not a clock. */
  readonly tick: number;
  /** The key map, so a slot says what actually fires it rather than a guess. */
  readonly map: InputMap;
  /**
   * Whether a slot names the key at all (specs 094, 196).
   *
   * False on a finger, which has no keyboard to press: a "1" in the corner of a
   * slot somebody taps is a label about a control that is not there. The
   * decision belongs to `hud-layout.ts`, which is the file that answers device
   * questions; what is decided *here* is that the answer means an empty string
   * rather than a widget with a flag on it.
   */
  readonly showsKeys: boolean;
}

export function actionBarViewOf(source: ActionBarSource): ActionBarView {
  // Which slot is changing, worked out once outside the loop: it is one change
  // at a time, and asking per slot would be five answers to a question with one.
  const changingSlot = barSlotOf(source.swap);
  // Ours, once, for the same reason. The `?? []` is the one `hud.ts` explains
  // where it draws the status marks: several harnesses fabricate a view by hand,
  // and a field added to `ClientView` is not a field they know to set. The type
  // says it is always there; the rigs say otherwise, and a bar that throws on a
  // missing field takes the whole frame with it.
  const casting = new Set(
    (source.casts ?? [])
      .filter((cast) => cast.entityId === source.selfEntityId)
      .map((cast) => cast.abilityId),
  );
  return {
    slots: source.bar.map((slot, index) => slotViewOf(source, slot, index, changingSlot, casting)),
  };
}

function slotViewOf(
  source: ActionBarSource,
  slot: ActionSlot,
  index: number,
  changingSlot: number | null,
  casting: ReadonlySet<string>,
): ActionSlotView {
  const ability = slot.abilityId === null ? null : abilityById(slot.abilityId);
  return {
    ability: ability ? abilityViewOf(source, ability) : null,
    keyLabel: source.showsKeys
      ? chordLabel(source.map.bindingsFor(`skillbar.${slot.keyNumber}`).primary)
      : '',
    // Only the vial counts anything. Its cost is a *charge* rather than
    // resource, so the dimming rule `affordable` already applies to it had
    // nothing on screen to point at: an empty flask and an unaffordable bolt
    // looked identical, and only one of them refills by standing still.
    badge:
      slot.kind === 'vial' && source.restoration
        ? `${source.restoration.charges}/${source.restoration.maxCharges}`
        : '',
    highlight: highlightOf(source, slot.abilityId, casting),
    // Drawn for an empty slot too, and that is the point: putting your first
    // skill into one is the commonest change there is, and it is exactly the
    // case a check on `ability` would have skipped.
    change:
      source.swap && changingSlot === index
        ? { label: swapLabel(source.swap.kind), progress: source.swap.progress }
        : null,
    hint: hintFor(ability),
  };
}

/**
 * What hovering a slot says (specs 191, 196).
 *
 * The DOM bar carried this as a browser `title`; a canvas has none, so the
 * lines are composed here and the framework's own `Tooltip` draws them. Through
 * `describeAbility` rather than a second sentence written for the bar, which is
 * what spec 191 built the vocabulary for -- and the tone each line was given
 * there becomes the colour it is drawn in, which is the division the item
 * tooltip already keeps: the model says what a line *is*, `src/ui/` says what
 * that looks like.
 *
 * An empty slot says nothing at all. "Empty -- no skill assigned" is a tooltip
 * that tells a player what they can already see, and a box that pops up to do
 * it is worse than one that stays quiet.
 */
function hintFor(ability: AbilityDefinition | null): readonly TooltipLine[] {
  if (!ability) return NO_HINT;
  const described = describeAbility(ability);
  return [
    { text: described.name },
    ...described.lines.map((line) => {
      const colorToken = TONE_TOKENS[line.tone];
      // A spanned line carries its runs through with each one resolved here,
      // which is the same hop the line's own tone makes and the same one
      // `inventory.ts` makes for a weapon's grades (spec 242). One line has
      // them: the `S / - / D` scaling notation, where position is the attribute
      // and each position takes that attribute's hue. `text` rides along as the
      // whole line, because the tooltip's wrap and its repeat-hover key are
      // built from it.
      if (line.spans === undefined) return { text: line.text, colorToken };
      return {
        text: line.text,
        colorToken,
        spans: line.spans.map((span) => ({
          text: span.text,
          colorToken: span.attribute === undefined ? colorToken : ATTRIBUTE_TOKENS[span.attribute],
        })),
      };
    }),
    // Flavour last and dim, kept out of the rules exactly as `technicalText`
    // keeps it out of them: a caller that wants both puts them in two styles.
    ...(described.flavor === null ? [] : [{ text: described.flavor, colorToken: 'textDim' }]),
  ];
}

const NO_HINT: readonly TooltipLine[] = [];

/**
 * What each of spec 191's five tones is drawn in.
 *
 * Out of the nineteen that exist, and each already means this somewhere else:
 * `focus` is what the interface says a target in, `text` is a plain statement,
 * `danger` is what something costs you, `accent` is a commitment with a clock
 * on it, and `textDim` is the aside it already draws every quiet thing in.
 */
const TONE_TOKENS: Readonly<Record<Tone, string>> = {
  target: 'focus',
  effect: 'text',
  cost: 'danger',
  timing: 'accent',
  note: 'textDim',
};

/**
 * Why a slot is lit, in the order the states outrank each other.
 *
 * An aim first, because it is the one the player is in the middle of *deciding*
 * about and the only one they can still call off by pressing something else. A
 * cast next, because it is happening. A request last: it lasts one round trip,
 * and letting it outrank either of the others would make every press flicker.
 */
function highlightOf(
  source: ActionBarSource,
  abilityId: string | null,
  casting: ReadonlySet<string>,
): SlotHighlight | null {
  if (abilityId === null) return null;
  if (source.aimingAbilityId === abilityId) return 'aimed';
  if (casting.has(abilityId)) return 'casting';
  if (source.requestedAbilityId === abilityId) return 'requested';
  return null;
}

/**
 * One slot's ability, with its wedge measured against the tick being drawn.
 *
 * The wedge's *length* is the cadence the cooldown was actually stamped with,
 * which for a basic attack is the player's own attack interval (specs 070, 144)
 * rather than the table's number -- against the table's, the shade starts
 * part-drained and finishes early. Through `attackTimingFor`, so the wedge and
 * the sim cannot come to different answers about how long a swing takes.
 */
function abilityViewOf(source: ActionBarSource, ability: AbilityDefinition): AbilityView {
  const remaining = Math.max(0, (source.cooldowns?.[ability.id] ?? 0) - source.tick);
  const length = Math.max(
    1,
    source.stats
      ? attackTimingFor(ability, { stats: source.stats }).intervalTicks
      : ability.cooldownTicks,
  );
  return {
    id: ability.id,
    // The *short* name where a row authored one (spec 188). The bar draws an
    // icon, so nothing is set in this string today -- but it is the ability's
    // name-where-space-is-tight, and this is the tight place: an interface that
    // ever names a slot should name it the way its author asked.
    name: barNameOf(ability),
    icon: abilityIconFor(ability.id),
    cost: ability.cost,
    sweep: Math.min(1, remaining / length),
    affordable: affordable(source, ability),
    secondsLeft: remaining / SERVER_TICK_RATE,
  };
}

/**
 * Whether the slot can be paid for right now.
 *
 * True before the stats have landed, deliberately: a bar that opened every
 * session greyed out would be saying "you cannot cast" about a character it has
 * not been told anything about yet.
 *
 * The charge count is the replicated one, which already has whatever a request
 * in flight spent taken off it -- so a second press inside the round trip is
 * dimmed rather than refused.
 */
export function affordable(source: ActionBarSource, ability: AbilityDefinition | null): boolean {
  if (!ability || !source.stats) return true;
  const charges = ability.chargeCost ?? 0;
  if (charges > 0 && (source.restoration?.charges ?? 0) < charges) return false;
  return ability.cost <= source.resource;
}
