/**
 * A label that follows the cursor and gets out of its own way (spec 124).
 *
 * Two behaviours, both of which are the difference between a tooltip and an
 * annoyance.
 *
 * **It waits.** `theme.input.tooltipDelayMs` after the pointer settles, measured
 * from the timestamps handed to `update` -- so the whole thing replays exactly,
 * like everything else here, and a golden image of a shown tooltip is
 * reproducible.
 *
 * **It flips rather than overflows.** Near the right edge it opens to the left;
 * near the bottom it opens above. A tooltip clipped by the screen edge is a
 * tooltip you cannot read, and the viewport is small and variable since spec 123.
 *
 * Since spec 185 it draws either a run of prose or a list of {@link TooltipLine}s,
 * and the difference is only what the caller hands it: the character sheet passes
 * a string and gets exactly what it got before, while the bag passes lines and
 * gets an item described in its tier's own colour. Wrapping is **per line** --
 * each one folds on its own and every fragment keeps its line's colour, so a long
 * name cannot run into the stat underneath it.
 */

import type { DrawList } from '../core/draw-list.js';
import {
  uniformInsets,
  type Constraint,
  type Point,
  type Rect,
  type Size,
} from '../core/geom.js';
import { drawNineSlice, drawText } from '../core/paint.js';
import type { LayoutContext, PaintContext } from '../core/widget.js';
import { fontById, measureText, wrapText } from '../text/font.js';
import { StyledWidget } from './base.js';

/** How far from the cursor the box sits, so it never covers what it describes. */
const CURSOR_GAP = 8;
/** Widest a tooltip gets before it wraps. */
const MAX_WIDTH = 140;

/**
 * One line of a tooltip (spec 185).
 *
 * The colour is a palette *token*, resolved against the theme at paint: a widget
 * that carried four bytes would be a widget with a colour spelled out in it, and
 * a screen naming a token is what `Label.colorToken` has always done.
 *
 * Absent means the tooltip's own text colour, which is what every line of prose
 * has always been drawn in.
 */
export interface TooltipLine {
  readonly text: string;
  readonly colorToken?: string;
  /**
   * The line drawn as coloured runs instead of one colour (spec 215).
   *
   * The weapon scaling line is `S / D / -` with the three letters in the three
   * attribute colours and the separators in the tooltip's own, which one
   * `colorToken` cannot say. A span carries its own token and falls back to the
   * line's, so a run that wants the ordinary text colour simply omits one.
   *
   * A spanned line is **never wrapped**: its runs are positioned by measuring
   * the ones before them, and a fold would put half a run at the start of the
   * next line with no way to say which half. Every spanned line this widget is
   * given is a handful of characters wide, which is why that is a rule rather
   * than a limitation -- {@link text} must still be the concatenation, because
   * it is what {@link contentKey} and the plain-text readout are built from.
   */
  readonly spans?: readonly TooltipSpan[];
}

/** One coloured run of a spanned line. */
export interface TooltipSpan {
  readonly text: string;
  readonly colorToken?: string;
}

/** Prose, or lines. A string is the single unstyled line it always was. */
export type TooltipContent = string | readonly TooltipLine[];

/** The identity a repeat hover is judged by: the text *and* the colour. */
function contentKey(lines: readonly TooltipLine[]): string {
  return lines
    .map((line) => {
      const runs = line.spans?.map((span) => `${span.colorToken ?? ''}:${span.text}`).join(',') ?? '';
      return `${line.colorToken ?? ''}|${runs}|${line.text}`;
    })
    .join('\n');
}

function asLines(content: TooltipContent): readonly TooltipLine[] {
  if (typeof content === 'string') return content.length === 0 ? [] : [{ text: content }];
  return content.filter((line) => line.text.length > 0);
}

export class Tooltip extends StyledWidget {
  /** The viewport, so the flip has something to flip against. */
  viewport: Size = { width: 0, height: 0 };

  /** What was handed in, before wrapping. */
  private source: readonly TooltipLine[] = [];
  /** Its identity, so a re-point with the same content does not restart the wait. */
  private key = '';

  /**
   * What it is currently saying, as plain text. Read by tests and by probes.
   *
   * Newline-joined, because the lines are lines: joining with spaces would make
   * a stat table read as one long sentence in exactly the place somebody is
   * asserting on what it says.
   */
  get label(): string {
    return this.source.map((line) => line.text).join('\n');
  }
  private anchor: Point = { x: 0, y: 0 };
  private since = -1;
  private lines: readonly TooltipLine[] = [];

  constructor(name = 'tooltip') {
    super('tooltip', name);
    this.visible = false;
    this.pointerTransparent = true;
  }

  /**
   * The pointer moved.
   *
   * Passing null clears; passing the same content again keeps the timer running,
   * so moving the cursor *within* one widget does not restart the wait. "Same"
   * is the text and the colour together (spec 185) -- an item whose tier changed
   * under the cursor is a different thing being described, even at the same name.
   */
  point(content: TooltipContent | null, at: Point, now: number): void {
    this.anchor = at;
    const lines = content === null ? [] : asLines(content);
    if (lines.length === 0) {
      this.source = [];
      this.key = '';
      this.since = -1;
      this.setVisible(false);
      return;
    }
    const key = contentKey(lines);
    if (key !== this.key) {
      this.source = lines;
      this.key = key;
      this.since = now;
      this.lines = [];
      this.setVisible(false);
      this.invalidateMeasure();
      return;
    }
    // Same content, cursor moved: the box follows without waiting again.
    if (this.visible) this.invalidateArrange();
  }

  /** Called each frame with the current time. Returns whether it is showing. */
  update(now: number, delayMs: number): boolean {
    const due = this.since >= 0 && now - this.since >= delayMs;
    this.setVisible(due && this.source.length > 0);
    return this.visible;
  }

  /** The lines it was handed, unwrapped. */
  get content(): readonly TooltipLine[] {
    return this.source;
  }

  private setVisible(next: boolean): void {
    if (next === this.visible) return;
    this.visible = next;
    this.invalidateMeasure();
  }

  /**
   * Where the box goes, given the cursor and the viewport.
   *
   * Pure and exported through the class so a test can ask about a corner without
   * building a frame. Flips on each axis independently: the bottom-right corner
   * of the screen needs both.
   */
  placementFor(size: Size, at: Point, viewport: Size): Point {
    let x = at.x + CURSOR_GAP;
    let y = at.y + CURSOR_GAP;
    if (x + size.width > viewport.width) x = at.x - CURSOR_GAP - size.width;
    if (y + size.height > viewport.height) y = at.y - CURSOR_GAP - size.height;
    // Still off the edge on a viewport narrower than the tooltip: pin it inside
    // rather than flipping it out the other side.
    x = Math.max(0, Math.min(x, Math.max(0, viewport.width - size.width)));
    y = Math.max(0, Math.min(y, Math.max(0, viewport.height - size.height)));
    return { x: Math.round(x), y: Math.round(y) };
  }

  protected override measureSelf(_constraint: Constraint, context: LayoutContext): Size {
    if (this.source.length === 0) return { width: 0, height: 0 };
    const style = context.theme.widget(this.styleKey);
    const font = fontById('body');
    // Wrapped per line, and each fragment keeps its line's colour: a name too
    // long for the box folds without swallowing the stat under it.
    const wrapped: TooltipLine[] = [];
    for (const line of this.source) {
      // A spanned line goes through whole: its runs are placed by measuring the
      // ones before them, so folding it would strand half a run on the next line
      // with nothing to say which colour that half was.
      if (line.spans !== undefined) {
        wrapped.push(line);
        continue;
      }
      for (const part of wrapText(font, line.text, MAX_WIDTH)) {
        wrapped.push(line.colorToken === undefined ? { text: part } : { text: part, colorToken: line.colorToken });
      }
    }
    this.lines = wrapped;
    let width = 0;
    for (const line of this.lines) width = Math.max(width, measureText(font, line.text));
    return {
      width: width + style.padding * 2,
      height: this.lines.length * font.height + style.padding * 2,
    };
  }

  /**
   * A tooltip places itself.
   *
   * Its parent is a full-viewport layer, so being handed the layer's rect and
   * then moving into a corner of it is the whole arrangement.
   */
  protected override arrangeSelf(_rect: Rect, _context: LayoutContext): void {
    const size = this.desiredSize;
    const at = this.placementFor(size, this.anchor, this.viewport);
    this.rect = { x: at.x, y: at.y, width: size.width, height: size.height };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    if (this.source.length === 0) return;
    const style = this.style(context);
    const state = style.state('normal');
    out.solid(this.rect, state.fill);
    drawNineSlice(out, context.atlas.patch(style.frame), this.rect, state.frameTint);

    const font = fontById('body');
    const inner = uniformInsets(style.padding);
    let y = this.rect.y + inner.top;
    for (const line of this.lines) {
      const tint = line.colorToken === undefined ? state.text : context.theme.color(line.colorToken);
      if (line.spans === undefined) {
        drawText(out, context.atlas, font, line.text, this.rect.x + inner.left, y, tint);
      } else {
        // Laid out by measuring what came before, which is what keeps the runs
        // in one line and in the order they were handed over. A span with no
        // token of its own takes the line's, so the separators in `S / D / -`
        // are the tooltip's ordinary text without naming a token for them.
        let x = this.rect.x + inner.left;
        for (const span of line.spans) {
          const runTint = span.colorToken === undefined ? tint : context.theme.color(span.colorToken);
          drawText(out, context.atlas, font, span.text, x, y, runTint);
          x += measureText(font, span.text);
        }
      }
      y += font.height;
    }
  }
}
