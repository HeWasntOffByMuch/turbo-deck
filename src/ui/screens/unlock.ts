/**
 * What a track just gave you, said once (spec 283).
 *
 * The first thing ever placed in the `notification` layer, which spec 124
 * declared with `blocksBelow: false, interactive: false` and left empty. That
 * declaration is the whole design and this file adds almost nothing to it: a
 * notice must not take a click, must not block one, and must not be something
 * the player has to deal with -- which is three properties of the layer rather
 * than three things this screen remembers.
 *
 * It exists because the first node on every track is at 10, a fresh character
 * holds six progression points, and five of them reach it: the first mechanics
 * in this game are unlocked before the first level-up, and nothing said so.
 *
 * Four rules, and three of them are the furniture rules the chat and the
 * selected-unit readout already keep.
 *
 * **Nothing is drawn when there is nothing to say**, settled before the
 * has-anything-changed comparison -- an empty queue is the state this spends a
 * whole session in, and a visibility decided after that comparison is a
 * decision never taken. It is the trap `chat.ts` names and `selected-unit.ts`
 * repeats, and this is the third module to be built to avoid it.
 *
 * **The pointer passes straight through**, everywhere. The world is underneath
 * and this sits across the top of it for a few seconds at a time; a panel that
 * took a click would be a hole in the game at exactly the moment the player has
 * just been handed something to try.
 *
 * **It does not fade.** Nothing in this framework blends -- `budget.test.ts`
 * refuses a translucent quad, and the one exception is a plate whose alpha was
 * chosen so both backends round it identically. A notice arrives with a rise
 * and is then simply gone, which is the chat log's own answer (it *wipes*
 * rather than fading) for the same reason.
 *
 * And **one at a time**. Two notices side by side is a reward screen, which is
 * the thing reward-philosophy §1 forbids in as many words; a queue is what makes
 * "you crossed a threshold and bought a tier with the same click" two moments
 * rather than one crowded box.
 *
 * Pure. Time is an argument, like every other screen here.
 */

import { Column } from '../core/containers.js';
import type { Constraint, Size } from '../core/geom.js';
import { animate, MOTION } from '../core/motion.js';
import type { LayoutContext, PaintContext } from '../core/widget.js';
import type { Theme } from '../theme/theme.js';
import { Label } from '../widgets/label.js';
import { Panel } from '../widgets/panel.js';
import type { TooltipLine } from '../widgets/tooltip.js';

/**
 * How long one notice holds before it goes.
 *
 * **Chosen, not derived**, and the comparator is `error-log.ts`'s
 * `MESSAGE_LIFE_MS`: 3500ms is this game's own answer to how long a line of
 * text stays readable, for one short line whose meaning the reader already
 * knows. This is a title and up to half a dozen lines nobody has ever read, and
 * the bound runs the *other* way from a response's -- nothing is waiting on it,
 * so what sets it is being long enough to look away from the world.
 *
 * Deliberately not an entry in `MOTION`. That table is animation durations and
 * `motion.test.ts` holds every notice in it to a second, correctly: an arrival
 * is an animation and a hold is not.
 */
export const UNLOCK_HOLD_MS = 6000;

/**
 * How many notices may be waiting at once.
 *
 * Beyond it the rest are dropped rather than queued, and that is the same
 * ruling spec 256 made for the controls card: **the character sheet is the
 * permanent answer**. Ordinary play produces one or two -- crossing a node, and
 * buying the tier it opened -- and the case that produces fifteen is an admin
 * `setLevel`, where two minutes of notices would be the interface operating on
 * the player rather than the other way round.
 */
export const UNLOCK_QUEUE_MAX = 3;

/** The widest a notice gets before its lines wrap. */
export const UNLOCK_WIDTH = 150;

/** One thing to say: a name, and what it is. */
export interface UnlockNotice {
  /** Stable, so a caller can tell "this one again" from "another one". */
  readonly id: string;
  readonly title: string;
  readonly lines: readonly TooltipLine[];
}

export interface UnlockScreenOptions {
  readonly theme: Theme;
}

export class UnlockScreen extends Panel {
  private readonly titleLabel = new Label('', 'body');
  private readonly body = new Column('unlock:lines');
  private readonly lineLabels: Label[] = [];
  /** What is queued, oldest first. The head is what is on screen. */
  private queue: UnlockNotice[] = [];
  /** When the head went up, so its life is measured from the frame it appeared. */
  private shownAtMs = 0;
  private drawnId: string | null = null;

  constructor(options: UnlockScreenOptions) {
    super('column', 'unlock');
    const theme = options.theme;
    this.gap = theme.spacing.xs;
    this.withThemePadding(theme.spacing.sm);
    // The whole panel, and not only its labels: see the header.
    this.pointerTransparent = true;
    // The state it spends a session in.
    this.visible = false;

    this.titleLabel.colorToken = 'accent';
    this.body.gap = 0;
    this.body.pointerTransparent = true;
    this.addAll([this.titleLabel, this.body]);
  }

  /**
   * Queue something to say.
   *
   * Ignores an id already queued or already showing, because a caller diffing a
   * replicated message may see the same change twice -- `Stats` arrives on
   * login, on every equip and on every spend -- and a notice that could be
   * double-queued would be shown twice in a row for one purchase.
   */
  push(notice: UnlockNotice, nowMs: number): void {
    if (this.queue.some((held) => held.id === notice.id)) return;
    if (this.queue.length >= UNLOCK_QUEUE_MAX) return;
    if (this.queue.length === 0) this.shownAtMs = nowMs;
    this.queue.push(notice);
  }

  /** Nothing left to say: a death, a disconnect, a respec. */
  clear(): void {
    if (this.queue.length === 0) return;
    this.queue = [];
    this.drawnId = null;
    this.visible = false;
    this.invalidateMeasure();
  }

  /** True while something is on screen, so a caller can hold off on the next. */
  get showing(): boolean {
    return this.queue.length > 0;
  }

  /**
   * Advance to `nowMs`, retiring the head once its life is spent.
   *
   * A loop rather than a single step: a frame can drain more than one hold when
   * the tab has been in the background, and retiring one notice per frame there
   * would play a backlog out at the frame rate.
   */
  update(nowMs: number): void {
    while (this.queue.length > 0 && nowMs - this.shownAtMs >= UNLOCK_HOLD_MS) {
      this.queue.shift();
      this.shownAtMs += UNLOCK_HOLD_MS;
    }
    const head = this.queue[0];
    // Before the comparison below, not after it. See the header.
    const wanted = head !== undefined;
    if (this.visible !== wanted) {
      this.visible = wanted;
      this.invalidateMeasure();
    }
    if (!head) {
      this.drawnId = null;
      return;
    }
    if (this.drawnId === head.id) return;
    this.drawnId = head.id;
    this.titleLabel.setText(head.title);
    this.setLines(head.lines);
    this.invalidateMeasure();
  }

  /**
   * How far the panel has risen into place, in UI pixels.
   *
   * `animate` answers reduce-motion centrally by snapping, which is why the
   * preference is not read here: spec 133 made that a property over the whole
   * easing table rather than a claim each widget remembers.
   */
  riseOffset(nowMs: number, context: PaintContext): number {
    if (this.queue.length === 0) return 0;
    const t = animate(
      {
        from: MOTION.notice.riseUiPx,
        to: 0,
        startMs: this.shownAtMs,
        durationMs: MOTION.notice.durationMs,
        easing: MOTION.notice.easing,
      },
      nowMs,
      context.motion,
    );
    return t;
  }

  private setLines(lines: readonly TooltipLine[]): void {
    // Grown rather than rebuilt, and never shrunk: a notice is a handful of
    // lines and the tallest one a session ever shows is the size this settles
    // at. Rebuilding the column would churn the tree every few seconds.
    while (this.lineLabels.length < lines.length) {
      const label = new Label('', 'body');
      label.pointerTransparent = true;
      this.lineLabels.push(label);
      this.body.add(label);
    }
    for (const [index, label] of this.lineLabels.entries()) {
      const line = lines[index];
      if (!line) {
        if (label.visible) {
          label.visible = false;
          label.invalidateMeasure();
        }
        continue;
      }
      if (!label.visible) {
        label.visible = true;
        label.invalidateMeasure();
      }
      label.setText(line.text);
      label.colorToken = line.colorToken ?? 'text';
    }
  }

  /** Fixed, so a notice does not change width as the queue advances. */
  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    const measured = super.measureSelf(constraint, context);
    return { width: Math.min(UNLOCK_WIDTH, constraint.maxWidth), height: measured.height };
  }
}
