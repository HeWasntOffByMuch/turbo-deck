/**
 * The controls card: what the featured buttons do, in one dismissable panel
 * (spec 255).
 *
 * Furniture in the chat's register -- translucent, docked, never dragged,
 * nothing in the layout store -- but it swallows the pointer rather than
 * passing it through, on `Panel`'s own argument: it is a card sitting over
 * the world with a close button on it, and a click through a translucent
 * panel onto the fight underneath would be worse than a click that simply
 * did nothing.
 *
 * **Content is derived, never authored.** A row names the action ids it
 * cares about; what each one is *bound to*, right now, comes from the live
 * `InputMap` through {@link controlHints}, which is the same machinery
 * `screens/keybindings.ts` reads. A rebind changes what this card draws with
 * no second table to keep in step, and an action with no binding drops its
 * row rather than drawing an empty cap -- the same rule
 * `ActionBarScreen`'s empty slots follow one level over.
 *
 * **A chord becomes a picture or a keycap, and the split is a table.** Three
 * pointer controls have art (`control:mouseLeft/mouseRight/mouseWheel`,
 * spec 255's own addition to the atlas); everything else -- including a
 * pointer code with no picture, like the middle button -- is a keycap
 * carrying `chordLabel`'s own text, the same abbreviation the keybinding
 * window already shows. The mapping from code to sprite is a small table
 * rather than a `startsWith` test, for the reason `naming.ts` is a table:
 * the alternative is a second, invisible answer to "does this chord have a
 * picture" that has to be re-derived at every caller, and it has nowhere to
 * put the sprite name.
 *
 * **Width is fixed**, `selected-unit.ts`'s reason: it is anchored to a
 * corner, so a width that followed its content would move its own edge
 * every time a rebind changed a label's length.
 *
 * Pure. No DOM, no clock: the view arrives from the caller, and dismissal is
 * reported through {@link ControlsScreen.onDismiss} rather than acted on --
 * this screen does not know what closing it means, the same rule every
 * other screen here follows.
 */

import { WHITE } from '../core/color.js';
import { Column, Row } from '../core/containers.js';
import type { DrawList } from '../core/draw-list.js';
import { uniformInsets, type Constraint, type Size } from '../core/geom.js';
import { alignTextX, centerTextY, drawNineSlice, drawTextClipped } from '../core/paint.js';
import { Widget, type LayoutContext, type PaintContext } from '../core/widget.js';
import { chordLabel, MOVE_EAST, MOVE_NORTH, MOVE_SOUTH, MOVE_WEST, type Chord } from '../input/actions.js';
import type { InputMap } from '../input/input-map.js';
import { fontById, measureText } from '../text/font.js';
import type { Theme } from '../theme/theme.js';
import { Button, Separator } from '../widgets/button.js';
import { Label } from '../widgets/label.js';
import { PLATE_ALPHA, PLATE_TOKEN } from './chat.js';

/** A physical key or button, drawn as a keycap with its label on it. */
export interface ControlGlyphKey {
  readonly kind: 'key';
  readonly label: string;
}

/** A mouse control, drawn as the picture rather than as text. */
export interface ControlGlyphPointer {
  readonly kind: 'pointer';
  /** An `atlas-source.ts` `CONTROL_ICONS` name; drawn as `control:<sprite>`. */
  readonly sprite: string;
}

export type ControlGlyph = ControlGlyphKey | ControlGlyphPointer;

/** One row of the card: the control(s) that do a thing, and what the thing is. */
export interface ControlHint {
  readonly glyphs: readonly ControlGlyph[];
  readonly label: string;
}

/** What the card is handed each frame. */
export interface ControlsView {
  readonly hints: readonly ControlHint[];
}

/**
 * One row the card may show, and the action ids that fill it.
 *
 * The label is this file's own copy, not `ActionDefinition.label` -- the
 * keybinding window's names are written for a list of every action there is
 * ("Stop everything", "Inventory") and this card is a short legend for the
 * handful worth calling out ("Stop", "Bag"). Two different jobs, so a second
 * short table here is not the copy `mechanics-vocabulary.md` warns against
 * duplicating: nothing about what a chord fires is repeated, only how the
 * row is titled.
 */
interface FeaturedRow {
  readonly actionIds: readonly string[];
  readonly label: string;
}

const FEATURED_ROWS: readonly FeaturedRow[] = [
  { actionIds: [MOVE_NORTH, MOVE_WEST, MOVE_SOUTH, MOVE_EAST], label: 'Move' },
  { actionIds: ['world.order'], label: 'Move / attack' },
  { actionIds: ['world.confirmAim'], label: 'Select / aim' },
  { actionIds: ['skillbar.1', 'skillbar.2', 'skillbar.3', 'skillbar.4'], label: 'Skills' },
  { actionIds: ['combat.stop'], label: 'Stop' },
  { actionIds: ['ui.inventory'], label: 'Bag' },
  { actionIds: ['ui.character'], label: 'Character' },
  { actionIds: ['camera.zoomIn'], label: 'Zoom' },
];

/**
 * Which pointer codes have art, and which sprite (spec 255).
 *
 * Four codes rather than every entry `POINTER_CODES` carries: this game has
 * three pointer pictures, one per button and one shared by both wheel
 * directions, and the other three pointer controls -- the middle button,
 * Mouse4, Mouse5 -- have none. Those fall through to a keycap carrying the
 * same abbreviation the keybinding window already shows, rather than to a
 * sprite name the atlas has never baked.
 */
const POINTER_SPRITES: Readonly<Record<string, string>> = {
  MouseLeft: 'mouseLeft',
  MouseRight: 'mouseRight',
  WheelUp: 'mouseWheel',
  WheelDown: 'mouseWheel',
};

function glyphFor(chord: Chord): ControlGlyph {
  const sprite = POINTER_SPRITES[chord.code];
  if (sprite !== undefined) return { kind: 'pointer', sprite };
  // `chordLabel` rather than the input module's private per-code label: it is
  // the exported, modifier-aware answer to "what does a player read this
  // as", and for a chord with no modifiers it is exactly that label alone.
  return { kind: 'key', label: chordLabel(chord) };
}

/**
 * The featured rows, as the live bindings actually stand.
 *
 * A row is dropped -- not drawn with an empty cap -- the moment any action it
 * names has no primary chord. For the four-action rows (`Move`, `Skills`)
 * that is deliberately an all-or-nothing test: a row missing one of its four
 * caps is a row lying about what it takes to move or to fight.
 */
export function controlHints(map: InputMap): readonly ControlHint[] {
  const hints: ControlHint[] = [];
  for (const row of FEATURED_ROWS) {
    const glyphs: ControlGlyph[] = [];
    let bound = true;
    for (const actionId of row.actionIds) {
      const chord = map.bindingsFor(actionId).primary;
      if (!chord) {
        bound = false;
        break;
      }
      glyphs.push(glyphFor(chord));
    }
    if (!bound) continue;
    hints.push({ glyphs, label: row.label });
  }
  return hints;
}

/** A glyph's box, in UI pixels. Fixed, so a row of mixed keys and pictures lines up. */
export const GLYPH_HEIGHT = 14;
/** Room either side of a keycap's label before the bevel. */
const KEYCAP_H_PAD = 3;
const GLYPH_GAP = 2;

/**
 * One control, drawn as a keycap or as the mouse picture (spec 255).
 *
 * A single class rather than two, since the two kinds share everything that
 * is not the paint: both are a fixed-height box in a row of them, and
 * branching on `glyph.kind` twice (once in `measureSelf`, once in
 * `paintSelf`) is smaller than two classes agreeing about `GLYPH_HEIGHT`.
 *
 * Extends {@link Widget} directly rather than `StyledWidget`: nothing here
 * has a hover or a pressed state to look up in the theme, so there is no
 * `styleKey` to name.
 */
class GlyphChip extends Widget {
  constructor(
    private readonly glyph: ControlGlyph,
    name: string,
  ) {
    super();
    this.name = name;
    // Decoration, not a control: the card itself takes the click.
    this.pointerTransparent = true;
  }

  protected override measureSelf(): Size {
    if (this.glyph.kind === 'pointer') return { width: GLYPH_HEIGHT, height: GLYPH_HEIGHT };
    const font = fontById('body');
    const width = Math.max(GLYPH_HEIGHT, measureText(font, this.glyph.label) + KEYCAP_H_PAD * 2);
    return { width, height: GLYPH_HEIGHT };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    const glyph = this.glyph;
    if (glyph.kind === 'pointer') {
      const src = context.atlas.sprite(`control:${glyph.sprite}`);
      // White: the identity tint. `CONTROL_ICONS` bakes its own palette
      // colours (spec 255's `atlas-source.ts` comment states the rule this
      // follows), so nothing here recolours it.
      out.sprite(
        src,
        {
          x: this.rect.x + Math.floor((this.rect.width - src.width) / 2),
          y: this.rect.y + Math.floor((this.rect.height - src.height) / 2),
          width: src.width,
          height: src.height,
        },
        WHITE,
      );
      return;
    }

    // The button vocabulary a keycap already is (`atlas-source.ts`'s own
    // words for why the bevel is borrowed): the same fill and the same
    // frame tint a resting `Button` draws, so a keycap reads as "press this"
    // without a second set of numbers to tune.
    out.solid(this.rect, context.theme.color('panelRaised'));
    drawNineSlice(out, context.atlas.patch('keycap'), this.rect, context.theme.color('edgeLight'));

    const font = fontById('body');
    drawTextClipped(
      out,
      context.atlas,
      font,
      glyph.label,
      alignTextX(font, glyph.label, this.rect, 'center'),
      centerTextY(font, this.rect),
      context.theme.color('text'),
      this.rect,
    );
  }
}

/** One row: the label on the left, its glyphs on the right. */
class HintRow extends Row {
  private readonly title = new Label('', 'body');
  private readonly glyphs = new Row('controls:glyphs');

  constructor(index: number, theme: Theme) {
    super(`controls:hint:${index}`);
    this.gap = theme.spacing.xs;
    this.title.layoutGrow = 1;
    this.glyphs.gap = GLYPH_GAP;
    this.addAll([this.title, this.glyphs]);
  }

  /**
   * Undefined hides the row.
   *
   * The glyphs are rebuilt rather than diffed: a rebind is a player decision
   * from a window, not a per-frame event, so paying a child-list rebuild for
   * it is the same trade `KeybindingsScreen.refresh` already makes.
   */
  setHint(hint: ControlHint | undefined): void {
    if (!hint) {
      if (this.visible) {
        this.visible = false;
        this.invalidateMeasure();
      }
      return;
    }
    if (!this.visible) this.visible = true;
    this.title.setText(hint.label);
    this.glyphs.clearChildren();
    for (const [index, glyph] of hint.glyphs.entries()) {
      this.glyphs.add(new GlyphChip(glyph, `controls:glyph:${index}`));
    }
    this.invalidateMeasure();
  }
}

/**
 * How wide the card is, in UI pixels.
 *
 * Wide enough for the longest row this table can produce -- `Move / attack`
 * beside its pointer picture, or `Skills` beside four keycaps -- with the
 * card's own padding either side. See the file header for why it is fixed
 * rather than measured.
 */
export const CARD_WIDTH = 140;

export interface ControlsOptions {
  readonly theme: Theme;
}

export class ControlsScreen extends Column {
  /**
   * The player asked to close this. Reported, not acted on: what dismissing
   * this card means -- discarding it for the session, remembering "seen" to
   * `display-store.ts` -- lives with whoever mounts it, the same split
   * `ChatScreen.onSubmit` and `UiWindow.onClose` already keep.
   */
  onDismiss: (() => void) | null = null;

  /**
   * Not reused from `UiWindow`'s title bar (spec 251): that button's
   * constructor takes `owner: UiWindow` and calls `owner.requestClose()` and
   * `owner.hasFocusWithin()` directly, so it is a window's close button and
   * not a close button that happens to live in a window. This card is not a
   * `UiWindow` -- no drag, no resize, no place in the layout store -- so it
   * gets the framework's ordinary `Button` with the same `icon:close`
   * sprite instead, rather than a second bespoke close-button class.
   */
  readonly closeButton = new Button('', 'controls:close');

  private readonly list = new Column('controls:list');
  private readonly rowWidgets: HintRow[] = [];

  constructor(options: ControlsOptions) {
    super('controls');
    const theme = options.theme;
    this.padding = uniformInsets(theme.spacing.sm);
    this.gap = theme.spacing.xs;

    const heading = new Row('controls:heading');
    heading.gap = theme.spacing.xs;
    const title = new Label('CONTROLS', 'body');
    title.layoutGrow = 1;
    this.closeButton.iconName = 'close';
    this.closeButton.onPress = () => {
      this.onDismiss?.();
    };
    heading.addAll([title, this.closeButton]);

    this.list.gap = theme.spacing.xs;
    for (let index = 0; index < FEATURED_ROWS.length; index++) {
      const row = new HintRow(index, theme);
      row.visible = false;
      this.rowWidgets.push(row);
      this.list.add(row);
    }

    this.addAll([heading, new Separator('row'), this.list]);
  }

  /**
   * What to draw, one hint per row.
   *
   * Positional: the *i*th hint fills the *i*th row widget, so a dropped row
   * (an unbound action) simply is not drawn rather than leaving a gap where
   * it would have been -- the compaction `SelectedUnitScreen`'s status rows
   * and `ChatScreen`'s line pool both already rely on.
   */
  setView(view: ControlsView): void {
    for (const [index, row] of this.rowWidgets.entries()) row.setHint(view.hints[index]);
    this.invalidateMeasure();
  }

  /**
   * Fixed at {@link CARD_WIDTH}, whatever it is offered.
   *
   * `Math.min` alone handles an unbounded constraint too, since
   * `CARD_WIDTH` is always the smaller of the two -- the same shape
   * `ChatScreen.measureSelf` uses.
   */
  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    const width = Math.min(constraint.maxWidth, CARD_WIDTH);
    const size = super.measureSelf({ maxWidth: width, maxHeight: constraint.maxHeight }, context);
    return { width, height: size.height };
  }

  /**
   * The plate, then a quiet frame over it.
   *
   * The plate is this screen's one blend, reusing `chat.ts`'s
   * `PLATE_TOKEN`/`PLATE_ALPHA` rather than a second chosen alpha -- that
   * pair is the one proven to round-trip exactly through a browser's
   * premultiplied storage (see `chat.ts`'s own comment), and a second
   * translucent value here would need the same proof done twice. The frame
   * is opaque, drawn the way a tooltip's is, because a translucent panel
   * with no edge reads as a smudge over the grass rather than as a card.
   */
  protected override paintSelf(out: DrawList, context: PaintContext): void {
    const plate = { ...context.theme.color(PLATE_TOKEN), a: PLATE_ALPHA };
    out.solid(this.rect, plate);
    drawNineSlice(out, context.atlas.patch('frame'), this.rect, context.theme.color('edgeLight'));
  }
}
