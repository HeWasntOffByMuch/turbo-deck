/**
 * The bar along the bottom of the screen (spec 190).
 *
 * Five {@link SkillSlot}s -- four skills and the vial -- and that is the whole
 * of the change: the widget was written for this job in spec 128 and had never
 * been mounted anywhere but the gallery, while the shipped bar was five
 * `<button>` elements of inline `cssText` with their own borders, their own
 * dimming and their own cooldown shade. Two implementations is two answers to
 * "what does a slot on cooldown look like", and the shipped one was the one
 * nothing could test.
 *
 * Docked bottom-centre in the `hud` layer beside the chat, on the same terms:
 * not a `UiWindow`, no title bar, never dragged, nothing in the layout store,
 * because it is furniture that is always there rather than something the player
 * opened.
 *
 * Two rules.
 *
 * **A slot is a square, and what it draws is an icon.** The DOM bar drew the
 * ability's *name* on a desktop and an icon on a phone, which is two layouts
 * and two things to keep fitting; at this framework's scale no name in the
 * table fits a slot at any size the face has, and every other slot in the game
 * -- the bag's cells, the paperdoll, the skill row -- is already a square with
 * an icon in it. One shape, and the bar stops being the odd one out. It is the
 * same {@link SLOT_SIDE} as those, too: see {@link barWidth}.
 *
 * **The row is rebuilt only when what it holds changes.** Everything that moves
 * during a fight -- the wedge, the seconds, whether a slot can be afforded, the
 * highlight -- is a plain field read at paint time, so a fight costs no layout
 * at all. That is `SkillSlot`'s own discipline, and this screen keeps it.
 *
 * Pure. No DOM, no clock: the view arrives from the caller.
 */

import { Row } from '../core/containers.js';
import { uniformInsets, type Insets } from '../core/geom.js';
import type { Theme } from '../theme/theme.js';
import { SkillSlot, SLOT_SIDE, type AbilityView } from '../widgets/skill-slot.js';

export type { AbilityView } from '../widgets/skill-slot.js';

/**
 * Why a slot is lit.
 *
 * Three states and one field, because a slot cannot be two of them at once and
 * they answer one question: is this the slot something is happening to.
 */
export type SlotHighlight = 'aimed' | 'casting' | 'requested';

/** What each highlight is drawn in. Tokens, never colours -- lint refuses one. */
export const HIGHLIGHT_TOKENS: Readonly<Record<SlotHighlight, string>> = {
  // The pale blue the aim indicator and the focus ring are already drawn in, so
  // the question on the ground and the button it came from are one thing.
  aimed: 'focus',
  // Gold is a commitment that can still be called off, which is exactly what a
  // wind-up is.
  casting: 'accent',
  // Asked for and not yet answered. Deliberately the quietest of the three: it
  // lasts one round trip, and a bright mark for it would flash on every press.
  requested: 'accentDark',
};

export interface ActionSlotView {
  /** What the slot casts, or null for one nothing has been put in yet. */
  readonly ability: AbilityView | null;
  /** The key that fires it, from the InputMap and never guessed. */
  readonly keyLabel: string;
  /** A count in the corner: the vial's charges. Empty draws none. */
  readonly badge: string;
  readonly highlight: SlotHighlight | null;
  /** A skill-slot change in flight over this slot (spec 188). */
  readonly change: { readonly label: string; readonly progress: number } | null;
}

export interface ActionBarView {
  readonly slots: readonly ActionSlotView[];
}

export interface ActionBarOptions {
  readonly theme: Theme;
  /** How many slots there are. The mount hands over the real count. */
  readonly slotCount: number;
  /** How big one is, in UI pixels. See {@link ActionBarScreen.setSlotSide}. */
  readonly slotSide?: number;
}

/**
 * How wide `count` slots of `side` and their gaps come to, in UI pixels.
 *
 * A function rather than a constant because the side is not one: see
 * {@link ActionBarScreen.setSlotSide}.
 */
export function barWidth(count: number, side: number, gap: number): number {
  return count <= 0 ? 0 : count * side + (count - 1) * gap;
}

/**
 * How much the 12-pixel icon art is magnified inside a box of `side`.
 *
 * Derived rather than authored, so the two cannot drift: whatever size the bar
 * is told to be, the icon fills the same proportion of it. Whole, because that
 * is the only kind of blit this framework does; at least one, because a slot
 * smaller than the art is a slot the widget clamps for itself.
 */
export function iconScaleFor(side: number): number {
  return Math.max(1, Math.floor((side - 8) / 12));
}

export class ActionBarScreen extends Row {
  private readonly slotWidgets: SkillSlot[] = [];
  private slotSide = SLOT_SIDE;
  onUse: ((index: number) => void) | null = null;

  constructor(options: ActionBarOptions) {
    super('actionBar');
    this.gap = options.theme.spacing.xs;
    // The bar is the one part of the interface that *is* pressable furniture:
    // the row itself passes the pointer through, and the slots in it do not.
    this.pointerTransparent = true;
    for (let index = 0; index < options.slotCount; index++) {
      const slot = new SkillSlot(index, `bar:${index}`);
      slot.onActivate = (at) => this.onUse?.(at);
      this.slotWidgets.push(slot);
      this.add(slot);
    }
    this.setSlotSide(options.slotSide ?? SLOT_SIDE);
  }

  get slots(): readonly SkillSlot[] {
    return this.slotWidgets;
  }

  /** How wide the whole row measures, in UI pixels. */
  get side(): number {
    return this.slotSide;
  }

  /**
   * How big one slot is, in UI pixels.
   *
   * Told rather than chosen here, and that is the one thing about this bar that
   * is not simply "the framework's own slot". A bag cell is a thing you look at;
   * these are **tap targets**, and the interface scale is picked by two
   * different constraints at the two ends of the range -- on a phone by how many
   * device pixels a finger covers, on a desktop by how much has to fit on
   * screen. So there is no single number of UI pixels that is finger-sized on
   * one and not absurd on the other: at 20 the bar is a row of 20 CSS-pixel
   * squares on a desktop, and at 40 it is 107 CSS pixels tall on a 390-pixel
   * phone. The mount converts a *physical* size and hands it over.
   *
   * Layout, so it invalidates -- and it changes when the window is resized or
   * the player picks a different interface scale, not per frame.
   */
  setSlotSide(uiPixels: number): void {
    const side = Math.max(1, Math.round(uiPixels));
    if (side === this.slotSide) return;
    this.slotSide = side;
    const iconScale = iconScaleFor(side);
    for (const slot of this.slotWidgets) {
      slot.side = side;
      slot.iconScale = iconScale;
      slot.invalidateMeasure();
    }
    this.invalidateMeasure();
  }

  /**
   * Called once per frame.
   *
   * Everything here is a field write except `setAbility`, which decides for
   * itself whether the *identity* in the slot changed -- so a screen full of
   * running cooldowns is free and equipping a skill costs one pass.
   */
  setView(view: ActionBarView): void {
    for (const [index, slot] of this.slotWidgets.entries()) {
      const entry = view.slots[index];
      slot.setAbility(entry?.ability ?? null);
      slot.badge = entry?.badge ?? '';
      slot.highlight = entry?.highlight ? HIGHLIGHT_TOKENS[entry.highlight] : null;
      slot.change = entry?.change ?? null;
      const label = entry?.keyLabel ?? '';
      if (slot.keyLabel !== label) {
        slot.keyLabel = label;
        // A key label is drawn rather than measured against anything -- but it
        // never changes during a fight, so paying a pass for a rebind is honest.
        slot.invalidateArrange();
      }
    }
  }
}

/**
 * The insets that keep the bar off the frame's floor.
 *
 * `floor` is what the experience strip occupies, measured outside and handed in
 * -- the strip spans the whole width and is pinned to the bottom, so every other
 * piece of furniture along that edge has to clear it or have a gold line through
 * it. Plus a margin, for the reason `chatInsets` gives: clearing something by
 * nothing is still sitting on it.
 */
export function actionBarInsets(theme: Theme, floor: number): Insets {
  return { ...uniformInsets(theme.spacing.sm), bottom: floor + theme.spacing.sm };
}
