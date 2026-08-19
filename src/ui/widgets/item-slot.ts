/**
 * One cell of a bag or one slot of a paperdoll (spec 127).
 *
 * The cell is the whole interaction surface: it is what a drag starts on, what a
 * drop lands on, and what the keyboard picks up from. Everything above it -- the
 * grid, the paperdoll, the screen -- is layout.
 *
 * Two rules that are the design rather than the drawing.
 *
 * **A cell never moves its own item.** It emits an intent and waits to be told.
 * The client already predicts and already replays what is in flight (spec 126),
 * so what this widget is handed is *already* the optimistic answer; guessing
 * again here would be a second copy of the truth, and a refused move would need
 * undo code of its own rather than being the next `setItem` call.
 *
 * **What it accepts is a property, not a lookup.** An equipment cell knows the
 * slot id it takes and compares it against the item's own; it never consults a
 * table, because a widget that reads the item table is a widget with an opinion
 * about game rules.
 */

import { over } from '../core/color.js';
import type { DragPayload, DropTarget } from '../core/drag.js';
import type { DrawList } from '../core/draw-list.js';
import type { Gesture } from '../core/events.js';
import type { Constraint, Point, Rect, Size } from '../core/geom.js';
import { drawNineSlice, drawText } from '../core/paint.js';
import type { LayoutContext, PaintContext } from '../core/widget.js';
import { fontById, measureText } from '../text/font.js';
import { StyledWidget } from './base.js';

/**
 * How a described line reads (spec 185).
 *
 * A *tone* rather than a palette token, because the view-model that produces
 * these lives in `src/render/` and whether a drawback is red is a fact about the
 * theme. The model says what kind of thing a line is; `inventory.ts` says what
 * that looks like.
 *
 * `rarity` is the item's own tier colour -- the name and the tier line, and the
 * only two places the colour on the ground is repeated in words.
 */
export type DetailTone = 'rarity' | 'good' | 'bad' | 'dim' | 'normal';

/** One line of what an item says about itself (spec 185). */
export interface ItemDetail {
  readonly text: string;
  readonly tone: DetailTone;
}

/**
 * A tier's palette token (spec 185).
 *
 * A name table rather than a colour: the values are `theme.json`'s, which are
 * `drop-rig.ts`'s, which is the whole point -- an item is the same colour in the
 * bag as it was in the grass.
 *
 * Unknown answers `common`, the same totality `rarityFromByte` has on the wire
 * and for the same reason: a client a build behind draws a quiet item rather
 * than throwing over a tier it has never heard of.
 */
const RARITY_TOKENS: Readonly<Record<string, string>> = {
  common: 'rarityCommon',
  rare: 'rarityRare',
  exceptional: 'rarityExceptional',
};

export const COMMON_RARITY = 'common';

export function rarityToken(rarity: string): string {
  return RARITY_TOKENS[rarity] ?? (RARITY_TOKENS[COMMON_RARITY] as string);
}

/**
 * An item as a widget is allowed to know it (spec 127).
 *
 * Deliberately not `ItemStack`: `src/ui/` may not import `server/state`, and
 * that boundary is what keeps layer 1 portable. Every field here is something
 * the cell or its tooltip *draws* -- there is nothing on it a rule would want.
 */
export interface ItemView {
  readonly defId: string;
  readonly name: string;
  readonly count: number;
  /** The equipment slot it belongs in, or null for something only carried. */
  readonly slot: string | null;
  /** An atlas sprite name. The screen never derives one from an id. */
  readonly icon: string;
  readonly levelRequirement: number;
  /**
   * The tier id (spec 185). What the icon is tinted with, and what the tooltip's
   * name is drawn in. A string rather than a union because the vocabulary is the
   * server's and this layer may not import it -- {@link rarityToken} is total, so
   * an id from a build this one has never heard of draws as ordinary loot.
   */
  readonly rarity: string;
  /**
   * What the tooltip says under the name, in display order (spec 185).
   *
   * Assembled outside `src/ui/` like everything else here: the stats, the worth
   * and the level gate are all in the item table, which a widget may not read.
   */
  readonly details: readonly ItemDetail[];
}

/** Which container a cell belongs to, and where in it. */
export interface SlotRef {
  readonly container: 'inventory' | 'equipment';
  readonly index: number;
}

/** What a drag carries: where it came from and how much of it. */
export interface ItemDrag {
  readonly from: SlotRef;
  readonly item: ItemView;
  /** How many are being carried. Equal to `item.count` for a whole stack. */
  readonly count: number;
}

export function isItemDrag(data: unknown): data is ItemDrag {
  const candidate = data as Partial<ItemDrag> | null;
  return !!candidate && typeof candidate.count === 'number' && !!candidate.item && !!candidate.from;
}

/** The side of a cell, in UI pixels. A 12px icon with two pixels of air. */
export const SLOT_SIDE = 20;

/**
 * How far past its own edge a cell answers the pointer, in UI pixels (spec 136).
 *
 * The gutter between cells belongs to nobody, so a release a couple of pixels
 * off lands on nothing and the item goes back where it came from. At a UI scale
 * of 1 that gutter is four real pixels and it eats a genuine fraction of drops.
 *
 * **Exactly half the gutter**, so the expanded rects *tile*: every point in the
 * grid belongs to one cell and no point belongs to two. Overlap would be worse
 * than the gap -- two cells claiming a pixel makes the winner depend on child
 * order, which is invisible and therefore unfixable by a player. Half is the
 * only number with that property, which is why it is derived from the grid's own
 * spacing rather than typed.
 *
 * The *paint* rect is untouched. A cell that drew itself two pixels larger would
 * close the gutter it is reaching into, and the grid would stop reading as a
 * grid.
 */
export const SLOT_CATCH = 2;

export class ItemSlot extends StyledWidget implements DropTarget {
  item: ItemView | null = null;
  /** For an equipment cell: the slot id it takes. Null accepts anything. */
  acceptsSlot: string | null = null;
  /**
   * Whether a drag in flight would land here.
   *
   * Set by the screen from the controller's answer rather than worked out here,
   * because "would this take the payload" and "is the cursor over me" are
   * different questions and only the controller knows the second one. A cell that
   * *refuses* stays unlit: nothing lighting up is the refusal, and a red flash on
   * every cell the cursor crosses is noise rather than information.
   */
  dropCandidate = false;
  /**
   * A change to this cell the server has committed to but not yet applied
   * (spec 188).
   *
   * Set by the screen from what it was handed, like everything else here. It is
   * the one thing a cell draws that is *not* about what is in it: a swap takes
   * time on purpose, so during that time the truthful picture is not the new
   * arrangement but the commitment to it -- which end this cell is, and how far
   * through.
   *
   * Null on every cell that is not one of the two ends, which is all of them
   * almost all of the time.
   */
  pending: SlotPending | null = null;
  /** Emitted when a drop is accepted here. The screen turns it into an intent. */
  onDropItem: ((drag: ItemDrag, to: SlotRef) => void) | null = null;
  /**
   * A press and release on this cell (spec 137).
   *
   * The only gesture this widget has, and it is fed by three of the router's --
   * which is not an oversight but the point. Every one of them is one press and
   * one release over this cell, and carrying needs nothing else:
   *
   *  - `click`, the ordinary case;
   *  - `dragEnd`, because a press that wanders past the drag threshold produces
   *    one and *no* click, so ignoring it would make an unsteady click on a cell
   *    do nothing at all;
   *  - `doubleClick`, because taking something and putting it straight back is
   *    two fast clicks on one cell, and dropping the second would leave the
   *    player holding an item they had already put down.
   */
  onClick: ((slot: ItemSlot, gesture: Gesture) => void) | null = null;

  onGesture(gesture: Gesture): void {
    if (gesture.kind === 'click' || gesture.kind === 'doubleClick' || gesture.kind === 'dragEnd') {
      this.onClick?.(this, gesture);
    }
  }

  constructor(
    readonly ref: SlotRef,
    name = 'itemSlot',
  ) {
    super('itemSlot', name);
    // Not focusable (spec 137). A focused cell drew a blue ring that read as
    // "active" when nothing was active, and it held the arrow keys -- which are
    // how the player walks. The bag is a pointer surface; the keyboard belongs
    // to the game.
    this.layoutAlign = 'start';
  }

  setItem(next: ItemView | null): void {
    // Compared field-wise rather than by identity: the view-model is rebuilt
    // whole on every server resend, so a fresh object with the same contents
    // arrives twenty times a second and every one of them would dirty layout.
    if (sameItem(this.item, next)) return;
    this.item = next;
    this.invalidateMeasure();
  }

  /**
   * Whether this cell would take `payload`.
   *
   * Refuses its own source, so letting go where you started is a cancel rather
   * than a move onto itself -- which the server refuses anyway, with a message
   * the player would have to read to learn they had done nothing.
   */
  canAcceptDrop(payload: DragPayload): boolean {
    if (!this.enabled || !this.visible) return false;
    if (!isItemDrag(payload.data)) return false;
    const drag = payload.data;
    if (drag.from.container === this.ref.container && drag.from.index === this.ref.index) return false;
    if (this.acceptsSlot === null) return true;
    return drag.item.slot === this.acceptsSlot;
  }

  onDrop(payload: DragPayload): void {
    if (!isItemDrag(payload.data)) return;
    this.onDropItem?.(payload.data, this.ref);
  }

  protected override measureSelf(_constraint: Constraint, _context: LayoutContext): Size {
    return { width: SLOT_SIDE, height: SLOT_SIDE };
  }

  /** The rect this cell answers the pointer over: its own, plus the catch. */
  catchRect(): Rect {
    return {
      x: this.rect.x - SLOT_CATCH,
      y: this.rect.y - SLOT_CATCH,
      width: this.rect.width + SLOT_CATCH * 2,
      height: this.rect.height + SLOT_CATCH * 2,
    };
  }

  /**
   * Hit-tested over {@link catchRect} rather than the drawn rect.
   *
   * The one place the two are allowed to differ, and the whole of spec 136's
   * gutter fix. Everything else about this widget -- what it draws, what it
   * measures to, where the grid puts it -- is unchanged.
   */
  protected override containsForHitTest(point: Point): boolean {
    const rect = this.catchRect();
    return (
      point.x >= rect.x &&
      point.x < rect.x + rect.width &&
      point.y >= rect.y &&
      point.y < rect.y + rect.height
    );
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    this.drawChrome(out, context, this.rect);
    if (this.dropCandidate) {
      drawNineSlice(out, context.atlas.patch('frame'), this.rect, context.theme.color('accent'));
    }
    if (this.item) paintItem(out, context, this.item, this.rect);
    if (this.pending) paintPending(out, context, this.pending, this.rect);
  }
}

/**
 * One end of a change in flight, as this cell sees it (spec 188).
 *
 * `role` is which end, and it is what the two colours are for: something
 * *leaving* is drawn in the danger tone and something *arriving* in the success
 * one, so a pair of marked cells reads as a direction without a caption. Red
 * and green rather than two shades of the accent, because at twenty pixels a
 * cell the only difference a player can actually see is hue -- two warm tones
 * read as one mark applied twice, which says a change is happening and not
 * which way it goes. `progress` is the same 0..1 the action bar and the bar
 * over the body fill by, from the same two server ticks.
 */
export interface SlotPending {
  readonly role: 'out' | 'in';
  readonly progress: number;
}

/**
 * The commitment, drawn over the cell: a tinted frame and a bar filling along
 * the bottom.
 *
 * A *bar* rather than a spinner or a fade, because this game already says
 * "committed, with a clock on it" with a bar -- over a casting body, and under
 * an action bar slot on cooldown. A fourth vocabulary for the fourth timed
 * thing would be three too many.
 *
 * Drawn last so it sits over the icon: what the cell holds is still true and
 * still worth seeing, and the mark is what is about to change about it.
 */
function paintPending(out: DrawList, context: PaintContext, pending: SlotPending, rect: Rect): void {
  const tint = context.theme.color(pending.role === 'out' ? 'danger' : 'success');
  drawNineSlice(out, context.atlas.patch('frame'), rect, tint);

  const height = 3;
  const inset = 2;
  const track = {
    x: rect.x + inset,
    y: rect.y + rect.height - height - inset,
    width: rect.width - inset * 2,
    height,
  };
  out.solid(track, context.theme.color('shadow'));
  // Floored, so a bar one pixel wide is a bar and a bar zero pixels wide is
  // nothing at all -- the first frame of a change should show no progress
  // rather than a sliver that reads as "nearly done at the start".
  const filled = Math.floor(track.width * Math.max(0, Math.min(1, pending.progress)));
  if (filled > 0) out.solid({ ...track, width: filled }, tint);
}

/**
 * Draw an item's icon and its count inside `box`.
 *
 * Shared by the cell and by the drag ghost, so what you are carrying looks
 * exactly like what you picked up -- if the ghost drew itself, the two would
 * drift the first time either changed.
 */
export function paintItem(out: DrawList, context: PaintContext, item: ItemView, box: Rect, count = item.count): void {
  paintRarityWash(out, context, item, box);
  const name = context.atlas.hasSprite(item.icon) ? item.icon : 'item:unknown';
  const src = context.atlas.sprite(name);
  out.sprite(
    src,
    {
      x: box.x + Math.floor((box.width - src.width) / 2),
      y: box.y + Math.floor((box.height - src.height) / 2),
      width: src.width,
      height: src.height,
    },
    context.theme.color('text'),
  );

  if (count <= 1) return;
  // The numeric face, bottom right, in the accent: a count is a number and this
  // is the face the game already draws numbers in.
  const font = fontById('numeric');
  const text = String(count);
  drawText(
    out,
    context.atlas,
    font,
    text,
    box.x + box.width - measureText(font, text) - 1,
    box.y + box.height - font.height - 1,
    context.theme.color('accent'),
  );
}

/**
 * The tier, as the cell it sits in (spec 185) -- the colour it was lying in the
 * grass, behind the same icon it has always had.
 *
 * **Behind rather than on.** The obvious version tints the sprite, and the
 * sprites are not silhouettes: they carry their own colour, so multiplying an
 * orange trinket by a gold tier and by a grey one gives two oranges nobody can
 * tell apart, while a blue tier over a warm sprite gives a colour that is not in
 * the palette at all. A wash under the icon is the same three bytes against a
 * near-black cell every time, whatever the icon happens to be made of.
 *
 * **Common is not washed at all**, which is the whole contrast: ordinary loot
 * looks exactly as it did, and the wash means "this one is not ordinary" rather
 * than "here is which of three tiers this is". Same argument as `restFlare` on
 * the ground, where a common drop's curve is flat at the dimmest value there is.
 * An unrevealed tier resolves to common's token and is therefore quiet too,
 * which is the answer spec 158 already settled for a drop nobody has read yet.
 */
function paintRarityWash(out: DrawList, context: PaintContext, item: ItemView, box: Rect): void {
  const token = rarityToken(item.rarity);
  if (token === rarityToken(COMMON_RARITY)) return;
  const style = context.theme.widget('itemSlot');
  const mix = style.metric('rarityWashMix', 0);
  if (mix <= 0) return;
  // Composited here and drawn opaque, never blended at draw time: nothing in
  // this framework is translucent, because a source-over blend is the one
  // operation the software rasterizer and a browser canvas round differently
  // (`budget.test.ts`). `over` is the rasterizer's own operator, so the bytes
  // are the ones a translucent draw would have produced -- computed once,
  // where both backends can only agree.
  //
  // Against the cell's **normal** fill rather than its current one, so a
  // hovered cell and a carried ghost wash identically: what is in flight has to
  // look like what was picked up, and the hover already speaks through the frame.
  const tier = context.theme.color(token);
  const washed = over({ r: tier.r, g: tier.g, b: tier.b, a: mix }, style.state('normal').fill);
  // Inset by one, so the wash sits inside the sunken frame rather than over its
  // edge -- the frame is the cell and this is what is in it.
  out.solid(
    { x: box.x + 1, y: box.y + 1, width: Math.max(0, box.width - 2), height: Math.max(0, box.height - 2) },
    washed,
  );
}

function sameItem(a: ItemView | null, b: ItemView | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  // Rarity is compared because it is *drawn* (spec 185). The details are not:
  // they are a function of the id, which is compared, and they are a list.
  return (
    a.defId === b.defId &&
    a.count === b.count &&
    a.icon === b.icon &&
    a.name === b.name &&
    a.rarity === b.rarity
  );
}
