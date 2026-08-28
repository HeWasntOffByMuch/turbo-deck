/**
 * The dialogue bubble (spec 246).
 *
 * HUD furniture in the register `chat.ts` and `selected-unit.ts` are: no title
 * bar, never dragged, nothing in the layout store, because it is not something
 * the player opened -- it is what a conversation *looks* like, and it goes away
 * with the conversation.
 *
 * What makes it different from those two is that it is **anchored to a body**.
 * The speaker is somewhere in the world and the bubble belongs over it, so the
 * mount hands in a point each frame and this places itself against it. Nothing
 * here knows what a world position is or how one becomes a pixel: it is given a
 * point in UI coordinates, which is the same division `hud.ts` already makes for
 * a health bar.
 *
 * Three rules it shares with its neighbours, each of which is the fix for the
 * version without it.
 *
 * **Nothing is drawn when nobody is speaking**, settled before the
 * has-anything-changed early-out, because "no conversation" is the state that
 * matches what is already on screen -- the trap `chat.ts` names and
 * `selected-unit.ts` repeats.
 *
 * **The pointer does not pass through.** This is the one place that inverts
 * `selected-unit.ts`'s rule, and deliberately: a readout is something you look
 * at *through*, and a bubble with buttons in it is something you press. A click
 * on a reply must not also be a click on the world behind it, and the way that
 * is guaranteed is that the panel is opaque to the hit test rather than by
 * anything remembering to swallow the event.
 *
 * **The replies are rebuilt only when they change.** A conversation is a handful
 * of lines, and a screen that tore down four buttons every frame would lose the
 * hover state on the one under the cursor between the press and the release.
 */

import { Column, Container } from '../core/containers.js';
import type { Gesture } from '../core/events.js';
import type { Constraint, Rect, Size } from '../core/geom.js';
import type { LayoutContext } from '../core/widget.js';
import { BODY_FONT } from '../text/font.js';
import type { Theme } from '../theme/theme.js';
import { Button } from '../widgets/button.js';
import { Label } from '../widgets/label.js';
import { Panel } from '../widgets/panel.js';

/** What the mount hands in each frame. Plain rows: nothing here reaches a sim. */
export interface DialogueBubbleView {
  readonly speaker: string;
  /** Revealed so far. The bubble shows exactly this and never the whole line. */
  readonly text: string;
  /** Still typing, so the replies are withheld and a press means "skip". */
  readonly typing: boolean;
  readonly choices: readonly string[];
}

export interface DialogueScreenOptions {
  readonly theme: Theme;
}

/**
 * How wide the bubble is allowed to get, in UI pixels.
 *
 * Fixed rather than following the longest line, for `selected-unit.ts`'s reason
 * one step further: this box is *centred on a body*, so a width that followed
 * its content would move both edges every time a character was revealed. A
 * bubble that grows while you read it is worse than one that is sometimes wider
 * than it needs to be.
 */
export const BUBBLE_WIDTH = 260;

/** How far above the anchor point the bubble's bottom edge sits. */
export const BUBBLE_LIFT = 12;

export class DialogueScreen extends Panel {
  /** Pressed a reply, by index. The mount decides what it means. */
  onChoice: ((index: number) => void) | null = null;

  /**
   * Pressed the bubble itself: skip the reveal, or advance.
   *
   * The bubble is a click target as well as a container, because the confirm
   * key and clicking the bubble are the same request and a player reading a
   * line will reach for the one in front of them.
   */
  onAdvance: (() => void) | null = null;

  private readonly speaker = new Label('', 'body');
  private readonly body = new Label('', 'body');
  private readonly replies = new Column('dialogue:replies');
  private readonly buttons: Button[] = [];
  private shown: string[] = [];
  /** Where the speaker is, in UI pixels, or null for nothing to point at. */
  private anchor: { x: number; y: number } | null = null;

  constructor(private readonly options: DialogueScreenOptions) {
    super('column', 'dialogue');
    const theme = options.theme;
    this.gap = theme.spacing.xs;
    this.withThemePadding(theme.spacing.sm);
    this.visible = false;

    this.speaker.colorToken = 'accent';
    this.body.wrap = true;
    this.body.colorToken = 'text';
    // Labels are pointer-transparent by default, which is what lets a press
    // anywhere on the bubble reach the panel and mean "advance".
    this.replies.gap = theme.spacing.xs;

    this.add(this.speaker);
    this.add(this.body);
    this.add(this.replies);
  }

  /**
   * Where the bubble points, in UI pixels: the top of the speaker's head.
   *
   * Null hides it, which is what an off-screen speaker gets. Separate from
   * {@link setView} because they change on different clocks -- the anchor moves
   * every frame as the camera eases, and the text moves when a character is
   * revealed.
   */
  setAnchor(at: { x: number; y: number } | null): void {
    if (at === null) {
      if (this.anchor === null) return;
      this.anchor = null;
      this.parent?.invalidateArrange();
      return;
    }
    if (this.anchor !== null && this.anchor.x === at.x && this.anchor.y === at.y) return;
    this.anchor = { x: at.x, y: at.y };
    // The **dock's** arrange, not this widget's: the placement is computed in
    // `DialogueDock.arrangeSelf`, so invalidating only this one would re-run a
    // pass that does not read the anchor. `UiRoot.update` lays out nothing that
    // is not dirty, so without this the bubble sticks where it was first placed
    // and moves only when the *text* changes -- which looks right while a line
    // is typing and freezes the moment it finishes.
    this.parent?.invalidateArrange();
  }

  /**
   * What is being said.
   *
   * Null is "nobody is talking", and it is checked first -- before the
   * did-anything-change comparison below -- because an empty view is exactly
   * what the screen already looks like when it is hidden, so a visibility
   * settled after that comparison is a decision never taken.
   */
  setView(view: DialogueBubbleView | null): void {
    if (view === null || view.speaker === '') {
      if (this.visible) {
        this.visible = false;
        this.invalidateMeasure();
      }
      return;
    }

    let changed = false;
    if (!this.visible) {
      this.visible = true;
      changed = true;
    }
    // A colon rather than a name on its own line: this face has one case and no
    // bold, so punctuation is what a name has to be told apart by.
    const speaker = `${view.speaker}:`;
    if (this.speaker.text !== speaker) {
      this.speaker.setText(speaker);
      changed = true;
    }
    if (this.body.text !== view.text) {
      this.body.setText(view.text);
      changed = true;
    }
    if (this.setChoices(view.choices)) changed = true;
    if (changed) this.invalidateMeasure();
  }

  /** Rebuilt only when the list differs, so a hovered reply keeps its state. */
  private setChoices(choices: readonly string[]): boolean {
    if (this.shown.length === choices.length && this.shown.every((text, i) => text === choices[i])) {
      return false;
    }
    this.shown = [...choices];
    this.replies.clearChildren();
    this.buttons.length = 0;
    for (let index = 0; index < choices.length; index++) {
      const button = new Button(choices[index] ?? '', `dialogue:choice:${index}`);
      // The width is fixed, so a reply fills it rather than sitting at its own
      // intrinsic size -- four buttons of four different widths in a column
      // reads as a list of unrelated things.
      button.layoutAlign = 'stretch';
      button.onPress = (): void => this.onChoice?.(index);
      this.buttons.push(button);
      this.replies.add(button);
    }
    this.replies.visible = choices.length > 0;
    return true;
  }

  /**
   * A click on the bubble that no reply took means "get on with it".
   *
   * A gesture rather than a raw press, so it is the same derived click a button
   * answers and a drag across the bubble is not one. Reached only when the
   * press missed every reply, because the router hands a gesture to the
   * deepest widget that took the press -- so this is the bubble's own
   * background rather than a rule about where the buttons happen to be.
   */
  onGesture(gesture: Gesture): void {
    if (gesture.kind !== 'click') return;
    this.onAdvance?.();
  }

  /**
   * Fixed width, and as tall as the text needs.
   *
   * The one thing this overrides `Panel` for, and for `selected-unit.ts`'s
   * reason: anchored to a moving body, a width that followed the content would
   * slide both edges inward every time a line got shorter.
   */
  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    const width = Math.min(BUBBLE_WIDTH, constraint.maxWidth);
    const size = super.measureSelf({ maxWidth: width, maxHeight: constraint.maxHeight }, context);
    return { width, height: size.height };
  }

  /**
   * Where the bubble goes: centred over the anchor, and kept on screen.
   *
   * Clamped rather than allowed to run off, because a bubble half outside the
   * frame is a conversation with an unreadable half -- and the speaker is often
   * near an edge, since walking up to somebody puts them at the middle of the
   * screen only by luck.
   */
  placement(viewport: { readonly width: number; readonly height: number }): { x: number; y: number } {
    const size = this.desiredSize;
    const margin = this.options.theme.spacing.sm;
    const anchor = this.anchor;
    if (anchor === null) {
      // Centred, low: what a bubble with nothing to point at gets. Reached only
      // while the speaker is off screen, which the mount usually catches first.
      return {
        x: Math.round((viewport.width - size.width) / 2),
        y: Math.round(viewport.height - size.height - margin - BODY_FONT.height * 4),
      };
    }
    const x = clamp(Math.round(anchor.x - size.width / 2), margin, viewport.width - size.width - margin);
    const y = clamp(Math.round(anchor.y - size.height - BUBBLE_LIFT), margin, viewport.height - size.height - margin);
    return { x, y };
  }
}

/**
 * The frame the bubble is placed inside.
 *
 * A container of its own rather than an `Anchor`, because an anchor places at
 * one of nine fixed sides and this places at *a point* -- the projected top of
 * a body's head, which moves every frame as the camera eases. It is here beside
 * the screen rather than in `core/containers.ts` for the same reason
 * `chat.ts`'s insets are in `chat.ts`: it is one screen's placement rule, not a
 * layout primitive anything else would reach for.
 *
 * Pointer-transparent, so the empty three-quarters of the frame it fills does
 * not swallow clicks meant for the world. The bubble inside it is not.
 */
export class DialogueDock extends Container {
  constructor(private readonly bubble: DialogueScreen) {
    super('dialogue:dock');
    this.pointerTransparent = true;
    this.add(bubble);
  }

  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    if (this.bubble.visible) this.bubble.measure(constraint, context);
    // A frame, like `Anchor`: it fills what it is given and has no size of its
    // own to contribute.
    return { width: constraint.maxWidth, height: constraint.maxHeight };
  }

  protected override arrangeSelf(rect: Rect, context: LayoutContext): void {
    if (!this.bubble.visible) return;
    const size = this.bubble.desiredSize;
    const at = this.bubble.placement({ width: rect.width, height: rect.height });
    this.bubble.arrange(
      {
        x: rect.x + at.x,
        y: rect.y + at.y,
        width: Math.min(size.width, rect.width),
        height: Math.min(size.height, rect.height),
      },
      context,
    );
  }
}

function clamp(value: number, low: number, high: number): number {
  // High can be below low on a viewport narrower than the bubble, and the
  // honest answer there is the left edge rather than a negative width.
  if (high <= low) return low;
  return Math.min(high, Math.max(low, value));
}
