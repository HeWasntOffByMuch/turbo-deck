/**
 * A question that has to be answered before anything else (spec 130).
 *
 * The first thing ever placed in the `modal` layer, which spec 124 declared with
 * `blocksBelow: true` and left empty. Almost nothing here implements modality --
 * the layer does it: `LayerStack.hitTest` already stops at a blocking layer that
 * has a visible child, so a click beside this dialog reaches nothing rather than
 * reaching the button behind it. What this file adds is the *keyboard* half and
 * the context push, which is the part a layer cannot know about.
 *
 * Pure. No DOM, no clock.
 */

import { Row } from '../core/containers.js';
import type { ContextStack, EventContext } from '../core/events.js';
import type { FocusManager } from '../core/focus.js';
import { uniformInsets, type Constraint, type Rect, type Size } from '../core/geom.js';
import type { DrawList } from '../core/draw-list.js';
import { animate, MOTION, settled, type Tween } from '../core/motion.js';
import type { LayoutContext, PaintContext } from '../core/widget.js';
import type { Theme } from '../theme/theme.js';
import { Button, Separator } from './button.js';
import { Label } from './label.js';
import { Panel } from './panel.js';

/**
 * The widest a dialog gets before its message wraps.
 *
 * A question is one or two lines; a dialog as wide as the screen makes a short
 * sentence hard to read and a long one worse.
 */
const MAX_WIDTH = 180;

export interface DialogOptions {
  readonly theme: Theme;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /**
   * Whether Escape and the cancel button exist at all.
   *
   * False makes it a *message* rather than a question -- it still closes on its
   * one button, because a dialog with no way out is a hung game.
   */
  readonly cancellable?: boolean;
}

export class Dialog extends Panel {
  readonly confirmButton: Button;
  readonly cancelButton: Button;
  onConfirm: (() => void) | null = null;
  onCancel: (() => void) | null = null;

  private readonly titleLabel: Label;
  private readonly messageLabel: Label;
  private readonly cancellable: boolean;
  /**
   * How much of the dialog is revealed, 0..1.
   *
   * The same clip the window uses and for the same reason: the draw list has no
   * transform, so a thing cannot be moved once painted -- and re-arranging to
   * slide would move the buttons out from under a cursor that is already over
   * them. `outBack` rather than `outQuad`, because a modal has to *arrive*.
   */
  private reveal: Tween = settled(1);
  private open = false;

  constructor(options: DialogOptions) {
    super('column', 'dialog');
    const theme = options.theme;
    this.padding = uniformInsets(theme.spacing.sm);
    this.gap = theme.spacing.xs;
    this.cancellable = options.cancellable ?? true;
    this.visible = false;

    this.titleLabel = new Label(options.title, 'body');
    this.titleLabel.colorToken = 'accent';
    this.messageLabel = new Label(options.message, 'body');
    this.messageLabel.wrap = true;

    this.confirmButton = new Button(options.confirmLabel ?? 'OK', 'dialog:confirm');
    this.confirmButton.onPress = () => this.confirm();
    this.cancelButton = new Button(options.cancelLabel ?? 'Cancel', 'dialog:cancel');
    this.cancelButton.onPress = () => this.cancel();
    this.cancelButton.visible = this.cancellable;

    const buttons = new Row('dialog:buttons');
    buttons.gap = theme.spacing.xs;
    buttons.layoutAlign = 'end';
    buttons.addAll([this.confirmButton, this.cancelButton]);

    this.addAll([this.titleLabel, new Separator('row'), this.messageLabel, buttons]);
  }

  get isOpen(): boolean {
    return this.open;
  }

  get question(): string {
    return this.messageLabel.text;
  }

  /** Change what is being asked without building a second dialog. */
  ask(title: string, message: string): void {
    this.titleLabel.setText(title);
    this.messageLabel.setText(message);
  }

  /**
   * Show it, take the keyboard, and push `modal`.
   *
   * The context push is what stops a key reaching gameplay while this is up, and
   * it is a stack rather than a flag for the reason spec 123 gives: two booleans
   * can get out of step with each other and a stack cannot.
   *
   * `focus` must be **the root's** manager. Keys are routed to whatever
   * `UiRoot.focus` holds, so a dialog focused in a manager of somebody's own is
   * a dialog no keystroke ever reaches -- and it looks completely fine on screen.
   */
  /**
   * Put the question up, arriving at `nowMs` if a caller knows one (spec 133).
   *
   * Optional, and the reason it can be supplied at all is that a `Button` hands
   * its press handler the *gesture's* time -- so the screen that opens a dialog
   * from a click has a number without anything threading a clock down to it.
   * Omitted means "already there", which is what the goldens and the layout
   * tests want.
   */
  show(contexts: ContextStack, focus?: FocusManager, nowMs?: number): void {
    if (this.open) return;
    this.open = true;
    this.visible = true;
    this.reveal =
      nowMs === undefined
        ? settled(1)
        : { from: 0, to: 1, startMs: nowMs, durationMs: MOTION.modal.durationMs, easing: MOTION.modal.easing };
    contexts.push('modal');
    focus?.focus(this.confirmButton);
    this.invalidateMeasure();
  }

  /** Hide it and pop the context. Safe to call on a dialog that is not open. */
  /**
   * Painted inside its own clip while it is arriving.
   *
   * Overriding `paint` rather than `paintSelf`, because the reveal has to take
   * the question and its buttons with it -- a frame wiping in over text that was
   * already there reads as a bug rather than an animation.
   */
  override paint(out: DrawList, context: PaintContext): void {
    if (!this.visible) return;
    const shown = animate(this.reveal, context.now, context.motion);
    if (shown >= 1) {
      super.paint(out, context);
      return;
    }
    out.pushClip({
      ...this.rect,
      height: Math.max(1, Math.round(this.rect.height * Math.max(0, shown))),
    });
    super.paint(out, context);
    out.popClip();
  }

  hide(contexts: ContextStack, focus?: FocusManager): void {
    if (!this.open) return;
    this.open = false;
    this.visible = false;
    contexts.pop('modal');
    if (focus?.focused === this.confirmButton || focus?.focused === this.cancelButton) {
      focus.focus(null);
    }
    this.invalidateMeasure();
  }

  private confirm(): void {
    if (!this.open) return;
    this.onConfirm?.();
  }

  private cancel(): void {
    if (!this.open || !this.cancellable) return;
    this.onCancel?.();
  }

  /**
   * Narrower than whatever it is given.
   *
   * The modal layer fills the viewport, and a `Panel` dropped into it stretches
   * to fill -- which is what the first golden of this widget showed: a
   * four-hundred-pixel box holding one short question. A dialog is a box.
   */
  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    return super.measureSelf(
      { maxWidth: Math.min(constraint.maxWidth, MAX_WIDTH), maxHeight: constraint.maxHeight },
      context,
    );
  }

  /**
   * Centred in whatever it was given, at its own size.
   *
   * It places itself for the same reason the tooltip does: its parent is a
   * full-viewport layer, so being handed the layer's rect and then sitting in
   * the middle of it *is* the arrangement.
   */
  protected override arrangeSelf(rect: Rect, context: LayoutContext): void {
    const size = this.desiredSize;
    const width = Math.min(size.width, rect.width);
    const height = Math.min(size.height, rect.height);
    this.rect = {
      x: rect.x + Math.floor((rect.width - width) / 2),
      y: rect.y + Math.floor((rect.height - height) / 2),
      width,
      height,
    };
    super.arrangeSelf(this.rect, context);
  }

  /**
   * Enter confirms and Escape cancels.
   *
   * Both are swallowed whether or not they did anything, which is the whole
   * point of a modal: an Escape that closed this *and* the window behind it
   * would be one keypress doing two things nobody asked for.
   */
  onEvent(context: EventContext): void {
    const event = context.event;
    if (!this.open || event.kind !== 'key' || event.phase !== 'down') return;
    if (event.code === 'Enter' || event.code === 'NumpadEnter') {
      this.confirm();
      context.stopPropagation();
      return;
    }
    if (event.code === 'Escape') {
      this.cancel();
      context.stopPropagation();
    }
  }
}
