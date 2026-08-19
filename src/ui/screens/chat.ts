/**
 * What has been said, and the line you are saying (spec 189).
 *
 * Docked bottom-left in the `hud` layer rather than built as a `UiWindow`: it
 * has no title bar, is not dragged, and is not in the layout store, because it
 * is furniture that is always there rather than something the player opened.
 * The `hud` layer has been `interactive: true` since phase 5 for exactly this
 * -- a layer the pointer passes straight through *except* where something in it
 * opts back in.
 *
 * Three rules, and the first two are the ones a chat gets wrong.
 *
 * **A closed chat is not there as far as the pointer is concerned.** The wheel
 * is camera zoom in the Play tab, so a log that took it whenever the cursor
 * happened to be bottom-left would break zoom in one corner of the screen with
 * nothing drawn to explain why. Everything here is `pointerTransparent` until
 * the field is open.
 *
 * **It wipes rather than fades.** Nothing in this framework blends, and
 * `revealAt` in `chat-log.ts` carries the argument. The wipe is a *clip*
 * computed while painting, which is what `UiWindow` already does to arrive, so
 * it costs no layout and `reduced` is honoured by snapping.
 *
 * **The field pushes `textEntry`.** That context has existed since spec 123 to
 * justify this widget and nothing had ever pushed it -- `TextField.setFocused`
 * had no caller in the tree. It is what makes a typed `1` a one rather than a
 * cast, which is the difference between a chat and a way to kill yourself.
 *
 * Pure. No DOM, no clock: the view arrives from the caller.
 */

import { Column } from '../core/containers.js';
import type { DrawList } from '../core/draw-list.js';
import { uniformInsets, type Constraint, type Insets, type Rect, type Size } from '../core/geom.js';
import { drawFocusRing, drawNineSlice, drawTextClipped } from '../core/paint.js';
import type { LayoutContext, PaintContext, Widget } from '../core/widget.js';
import { advance, BODY_FONT } from '../text/font.js';
import type { Theme } from '../theme/theme.js';
import { Label } from '../widgets/label.js';
import { ScrollView } from '../widgets/scroll-view.js';
import { TextField } from '../widgets/text-field.js';

/** `ChatChannel` from the protocol: Say, System, AdminBroadcast. */
export type ChatChannelId = 0 | 1 | 2;

/**
 * What each channel is drawn in.
 *
 * Out of the palette that already exists. `theme.test.ts` caps it at nineteen
 * and it sits at exactly nineteen, and that cap is against *invented* colour --
 * a chat channel is not a new thing in the world, it is three existing tones
 * doing what they already mean. `focus` is the pale blue a focus ring is drawn
 * in and reads as "this one is addressed to you"; `textDim` is what the
 * interface already says its quieter things in, which is what a death notice
 * is; `accent` is the game's gold, spent here on the one channel an operator
 * sends by hand.
 */
export const CHANNEL_TOKENS: Readonly<Record<ChatChannelId, string>> = {
  0: 'text',
  1: 'textDim',
  2: 'accent',
};

/** What a speaker's own name is drawn in, on a `Say` line. */
export const SPEAKER_TOKEN = 'focus';

/**
 * How wide the log is, in UI pixels.
 *
 * Fixed rather than a fraction of the viewport: this is a column of text over a
 * 3D world, and a log that grew with the window would be a paragraph three
 * hundred characters wide on a desktop monitor. Fifty-odd characters is a line
 * somebody reads without tracking back.
 */
export const LOG_WIDTH = 320;

/** How many lines are on screen at once. Scrollback goes further; see `chat-log.ts`. */
export const LOG_LINES = 8;

/** The longest line the server will keep -- `text.slice(0, 240)` in `server.ts`. */
export const MAX_CHARS = 240;

/**
 * Which palette colour the chat sits on, and how opaque that plate is.
 *
 * The one place in this framework that blends, and the alpha is **chosen rather
 * than picked**, which is the whole of why it is allowed to.
 *
 * The rule it is the exception to is real (`budget.test.ts`): a browser canvas
 * stores premultiplied 8-bit and `getImageData` unpremultiplies it, so a
 * straight-alpha colour written over a transparent pixel comes back rounded --
 * where `raster.ts` writes it through untouched. At 0.62 this plate came back
 * `rgb(27,24,39)` in Chromium against `rgb(28,25,39)` in the rasterizer, off by
 * one in two channels, which is exactly the divergence the rule exists to stop.
 *
 * But the round trip is only lossy for *some* alphas. For this colour, 156 is
 * one of the values where `round(round(c * a / 255) * 255 / a) === c` holds on
 * every channel -- so the two backends agree byte for byte, and the exact
 * comparison in `preview-ui-gallery.ts` keeps working rather than being given a
 * tolerance that would hide every future blending mistake as well as this one.
 *
 * `budget.test.ts` asserts that property, so a change to `panelSunken` or to
 * this number fails in `npm test` rather than in a browser months later. If it
 * does fail: the fix is a neighbouring alpha, not a looser check.
 *
 * A byte rather than a fraction, because the fraction is a way of writing the
 * byte down and only the byte is the thing that has to be exact.
 */
export const PLATE_TOKEN = 'panelSunken';
export const PLATE_ALPHA = 156;

export interface ChatLineView {
  readonly id: number;
  readonly channel: ChatChannelId;
  /** Who said it. Empty for `System`, which is nobody. */
  readonly from: string;
  readonly text: string;
}

export interface ChatView {
  /** Oldest first. The newest is the bottom line. */
  readonly lines: readonly ChatLineView[];
  /** 0..1 from `revealAt`; the screen clips itself to it. */
  readonly reveal: number;
}

export interface ChatOptions {
  readonly theme: Theme;
}

/**
 * Somewhere to put the keyboard, and somewhere to say a field has it.
 *
 * The root's, never one of this screen's own -- keys route to whatever
 * `UiRoot.focus` holds, and a screen focused anywhere else is a screen no
 * keystroke reaches. Narrowed to what is actually used so `src/ui/screens/` does
 * not grow an import of the root.
 */
export interface ChatFocus {
  focus(widget: Widget | null): boolean;
  push(id: 'textEntry'): void;
  pop(id: 'textEntry'): void;
}

/**
 * One line, with the speaker in a colour of their own.
 *
 * A `Label` subclass rather than a widget of its own, because everything about
 * measuring and wrapping a line of text is already here and correct -- including
 * the lesson that paint has to wrap at the width `measure` reserved room for
 * rather than at `rect.width`.
 *
 * The speaker is coloured on the **first row only**, and only as far as that row
 * reaches. Wrapping breaks at spaces, so a character offset into the original
 * string is not a character offset into row two -- but a name is short and a
 * prefix that outran its own row is a name longer than fifty characters, which
 * the server would have to have accepted first.
 */
class ChatLine extends Label {
  /** Characters at the head of the text drawn in {@link speakerToken}. */
  speakerChars = 0;
  speakerToken = SPEAKER_TOKEN;

  constructor() {
    super('', 'body');
    this.wrap = true;
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    if (this.speakerChars <= 0) {
      super.paintSelf(out, context);
      return;
    }
    const font = this.font();
    const rows = this.lines(this.wrapWidth);
    const body = this.colorToken ? context.theme.color(this.colorToken) : this.resolved(context).text;
    const speaker = context.theme.color(this.speakerToken);

    let y = this.rect.y;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index] ?? '';
      const split = index === 0 ? Math.min(this.speakerChars, row.length) : 0;
      if (split > 0) {
        drawTextClipped(out, context.atlas, font, row.slice(0, split), this.rect.x, y, speaker, this.rect);
      }
      drawTextClipped(
        out,
        context.atlas,
        font,
        row.slice(split),
        // The face is fixed-pitch, so where the body starts is a character
        // count times the advance. `measureText` would subtract the trailing
        // spacing and put the rest of the line one pixel to the left.
        this.rect.x + split * advance(font),
        y,
        body,
        this.rect,
      );
      y += font.height;
    }
  }
}

/**
 * The log's scroller, with its plate taken off.
 *
 * A subclass rather than a flag on `ScrollView`, because "draw no background"
 * is true of this one scroller over the world and of nothing else in the
 * interface -- and the chat draws one plate behind its whole self, so a second
 * one here would be the blend applied twice and a rectangle inside a rectangle.
 * The scrollbar is left alone: it only appears when there is something to
 * scroll, and a position indicator you can see through is not one.
 */
class ChatLogView extends ScrollView {
  protected override paintSelf(): void {
    // Intentionally empty. See the class comment.
  }
}

/**
 * The input line, with its fill taken off and its frame kept.
 *
 * The frame and the focus ring are what say "this is a thing you type into",
 * and they are the whole of what the chrome is for here -- the fill is a plate,
 * and the plate is the screen's job.
 */
class ChatField extends TextField {
  protected override drawChrome(out: DrawList, context: PaintContext, box: Rect): void {
    const style = this.style(context);
    const state = style.state(this.stateFor(context));
    drawNineSlice(out, context.atlas.patch(style.frame), box, state.frameTint);
    if (context.focused === (this as unknown as Widget) && this.enabled) {
      drawFocusRing(out, context.atlas, box, context.theme.color('focus'));
    }
  }
}

export class ChatScreen extends Column {
  readonly field = new ChatField('', 'chat:input');
  readonly log: ScrollView;

  /**
   * Enter, in the field: the trimmed line, which may be empty.
   *
   * Reported rather than acted on. Sending needs the client, closing needs the
   * root's focus, and remembering the line for Up needs the log -- none of which
   * a screen under `src/ui/` may reach. The mount does all three in one place,
   * which is also what stops "send it" and "remember it" drifting apart.
   */
  onSubmit: ((text: string) => void) | null = null;

  /** The player put the field away. The mount restarts the quiet clock on it. */
  onClosed: (() => void) | null = null;

  private readonly lines = new Column('chat:lines');
  private readonly pool: ChatLine[] = [];
  private readonly shown: number[] = [];
  private opened = false;
  private reveal = 1;
  /**
   * Whether the log follows its own tail.
   *
   * Set while the view sits at the bottom and cleared the moment the player
   * scrolls up, which is the whole of the rule: a log that jumped back to the
   * newest line every time somebody spoke would be unreadable in exactly the
   * conversation worth scrolling back through.
   */
  private following = true;

  constructor(options: ChatOptions) {
    super('chat');
    const theme = options.theme;
    this.gap = theme.spacing.xs;
    this.pointerTransparent = true;

    this.lines.pointerTransparent = true;
    this.log = new ChatLogView(this.lines, 'chat:log');
    this.log.maxHeight = LOG_LINES * BODY_FONT.height + theme.spacing.xs;
    this.log.pointerTransparent = true;

    this.field.maxLength = MAX_CHARS;
    this.field.placeholder = 'Say something...';
    this.field.visible = false;
    // Both start hidden: a session opens with nothing said, and the first frame
    // is drawn before anything has had a chance to call `setView`.
    this.log.visible = false;
    this.lines.visible = false;
    this.field.onSubmit = (text) => {
      this.onSubmit?.(text.trim());
    };

    this.add(this.log);
    this.add(this.field);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** What is in the field. The mount reads and writes it for Up and Down. */
  get inputText(): string {
    return this.field.text;
  }

  setInputText(text: string): void {
    this.field.setText(text);
  }

  /**
   * Show the field and give it the keyboard.
   *
   * `setFocused` is called here rather than left to the focus manager because
   * only the field knows it is a field -- the same reason spec 123 gives for the
   * context living on the widget. Nothing in the tree had ever called it.
   */
  open(focus: ChatFocus): void {
    if (this.opened) return;
    this.opened = true;
    this.field.visible = true;
    // A press no longer takes focus (spec 137), so nothing else in this screen
    // can steal it while the field is up -- but the pointer has to be able to
    // reach the log to scroll it.
    this.pointerTransparent = false;
    this.log.pointerTransparent = false;
    this.following = true;
    focus.focus(this.field);
    this.field.setFocused(true, focus);
    this.invalidateMeasure();
  }

  close(focus: ChatFocus): void {
    if (!this.opened) return;
    this.opened = false;
    this.field.setFocused(false, focus);
    focus.focus(null);
    this.field.setText('');
    this.field.visible = false;
    this.pointerTransparent = true;
    this.log.pointerTransparent = true;
    this.following = true;
    this.invalidateMeasure();
    this.onClosed?.();
  }

  /**
   * What to draw.
   *
   * Rebuilt only when the set of ids changes, so a frame in which nothing was
   * said costs no layout at all -- the discipline the HUD screen already keeps
   * and the reason retained mode is worth having here.
   */
  setView(view: ChatView): void {
    this.reveal = Math.max(0, Math.min(1, view.reveal));

    // An empty log is not drawn at all -- not the lines, not the scroller, not
    // the plate under them. Opening the chat before anybody has said anything
    // used to put an empty black rectangle over the world above the field, which
    // is the interface taking up room to say nothing.
    //
    // Answered *before* the early-out below, because an empty list is the one
    // case that matches what is already shown: `sameLines` is true from the
    // first frame, so a visibility decided after it is a decision never taken.
    const holdsSomething = view.lines.length > 0;
    if (this.log.visible !== holdsSomething) {
      this.log.visible = holdsSomething;
      this.lines.visible = holdsSomething;
      this.invalidateMeasure();
    }

    if (this.sameLines(view.lines)) return;

    this.shown.length = 0;
    for (const line of view.lines) this.shown.push(line.id);

    while (this.pool.length < view.lines.length) {
      const widget = new ChatLine();
      this.pool.push(widget);
      this.lines.add(widget);
    }
    for (let index = 0; index < this.pool.length; index++) {
      const widget = this.pool[index];
      if (!widget) continue;
      const line = view.lines[index];
      if (!line) {
        widget.visible = false;
        continue;
      }
      widget.visible = true;
      // The speaker rides inline rather than in a column of its own, so a long
      // line wraps under the name instead of into a second column that would
      // have to be measured against the widest name in the log.
      const speaker = line.from.length > 0 && line.channel === 0 ? `${line.from}: ` : '';
      widget.speakerChars = speaker.length;
      widget.colorToken = CHANNEL_TOKENS[line.channel];
      widget.setText(`${speaker}${line.text}`);
    }
    this.invalidateMeasure();
  }

  private sameLines(lines: readonly ChatLineView[]): boolean {
    if (lines.length !== this.shown.length) return false;
    for (let index = 0; index < lines.length; index++) {
      if (lines[index]?.id !== this.shown[index]) return false;
    }
    return true;
  }

  /**
   * Follow the tail, after the layout pass.
   *
   * After, and it has to be: `maxScroll` is derived from the content height the
   * last layout measured, so a scroll requested while the new line is still
   * unmeasured lands one line short of the bottom -- which is the newest line,
   * every time.
   */
  settle(): void {
    if (!this.following) return;
    this.log.scrollTo(this.log.maxScroll);
  }

  /** Told the player scrolled, so the log stops chasing its own tail. */
  noteScrolled(): void {
    this.following = this.log.scrollOffset >= this.log.maxScroll;
  }

  /**
   * As wide as {@link LOG_WIDTH} and no wider, whatever it is offered.
   *
   * A wrapping label measures to the width it is handed, so a log left to take
   * the viewport is one line of three hundred characters and no wrapping at all.
   * The clamp goes here rather than on the label, because the width is a fact
   * about the log's shape and not about any line in it.
   */
  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    const width = Math.min(constraint.maxWidth, LOG_WIDTH);
    const size = super.measureSelf({ maxWidth: width, maxHeight: constraint.maxHeight }, context);
    return { width, height: size.height };
  }

  /**
   * Clipped to its own reveal while it is leaving.
   *
   * Anchored at the **bottom**, so the oldest line goes first and the newest is
   * the last thing on screen -- a log that retracted from the bottom would take
   * the line somebody is still reading and leave the one they have finished.
   *
   * `reduced` snaps rather than easing: a player who asked their system for less
   * motion asked for a reason, and a faster wipe is refusing it politely.
   */
  /**
   * The plate the chat sits on, translucent, behind everything it holds.
   *
   * Drawn here rather than by the scroller and the field, so it is **one**
   * blend over the whole surface. Two would overlap wherever they met and the
   * seam would be a different colour from either -- which is what a translucent
   * widget inside a translucent widget always looks like.
   *
   * Nothing is drawn when there is nothing to say: an empty plate over the
   * world is a black bar announcing that the chat exists, and the chat
   * announcing itself is the opposite of furniture.
   */
  protected override paintSelf(out: DrawList, context: PaintContext): void {
    const plate = { ...context.theme.color(PLATE_TOKEN), a: PLATE_ALPHA };
    if (this.lines.visible) out.solid(this.log.rect, plate);
    if (this.field.visible) out.solid(this.field.rect, plate);
  }

  override paint(out: DrawList, context: PaintContext): void {
    if (!this.visible) return;
    const shown = context.motion.reduced ? (this.reveal >= 1 ? 1 : 0) : this.reveal;
    if (shown <= 0) return;
    if (shown >= 1) {
      super.paint(out, context);
      return;
    }
    const height = Math.max(1, Math.round(this.rect.height * shown));
    out.pushClip({
      x: this.rect.x,
      y: this.rect.y + this.rect.height - height,
      width: this.rect.width,
      height,
    });
    super.paint(out, context);
    out.popClip();
  }
}

/**
 * The insets that keep the log off the frame's edge and clear of the HUD.
 *
 * The bottom is the measured furniture *plus* a margin rather than the larger
 * of the two: clearing something by nothing is still sitting on it, and the gap
 * is what makes the log read as its own thing instead of as another row of the
 * bottom band.
 */
export function chatInsets(theme: Theme, safeBottom: number): Insets {
  return { ...uniformInsets(theme.spacing.sm), bottom: safeBottom + theme.spacing.xl };
}
