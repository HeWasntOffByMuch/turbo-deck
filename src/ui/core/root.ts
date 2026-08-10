/**
 * The one object a caller holds (spec 121).
 *
 * Owns the tree, the router, the focus manager and the context stack, and
 * exposes exactly three verbs: feed it an event, tell it what time it is, and
 * ask it for a draw list. Everything else in `ui/core` is reachable from here
 * but nothing outside has to know it exists.
 *
 * `update(nowMs)` takes the time rather than reading it. That is the rule the
 * whole test strategy rests on -- a script of `[time, event]` pairs replays to
 * the same state every run, forever -- and lint enforces it by banning `Date`
 * and `performance` across `src/ui/`.
 *
 * Pure. No DOM, no clock, no backend: the draw list goes to a surface elsewhere.
 */

import { ContextStack, type InputContextId, type UiEvent } from './events.js';
import { DrawList } from './draw-list.js';
import { FocusManager } from './focus.js';
import { looseConstraint, type Size } from './geom.js';
import { EventRouter } from './router.js';
import type { LayoutContext, PaintContext, Widget } from './widget.js';
import type { Atlas } from '../render/atlas.js';
import type { Theme } from '../theme/theme.js';

export interface UiRootOptions {
  readonly theme: Theme;
  readonly atlas: Atlas;
  readonly viewport: Size;
}

export class UiRoot {
  readonly focus = new FocusManager();
  readonly contexts = new ContextStack();
  readonly router: EventRouter;

  private readonly list = new DrawList();
  private viewportSize: Size;
  private layoutCount = 0;
  private now = 0;

  constructor(
    readonly content: Widget,
    private readonly options: UiRootOptions,
  ) {
    this.viewportSize = options.viewport;
    this.router = new EventRouter({
      dragThreshold: options.theme.input.dragThreshold,
      doubleClickMs: options.theme.input.doubleClickMs,
    });
  }

  get viewport(): Size {
    return this.viewportSize;
  }

  /** The current time, as last handed to {@link update}. */
  get time(): number {
    return this.now;
  }

  /**
   * How many times a layout pass has actually run.
   *
   * Exposed because "a still frame does no work" is an invariant rather than an
   * aspiration, and the only way to assert it is to count.
   */
  get layoutPasses(): number {
    return this.layoutCount;
  }

  resize(viewport: Size): void {
    if (viewport.width === this.viewportSize.width && viewport.height === this.viewportSize.height) return;
    this.viewportSize = viewport;
    this.content.invalidateMeasure();
  }

  /** Advance to `nowMs` and lay out anything dirty. */
  update(nowMs: number): void {
    this.now = nowMs;
    this.focus.revalidate(this.content);
    if (!this.content.needsMeasure && !this.content.needsArrange) return;
    this.layoutCount++;
    const context = this.layoutContext();
    this.content.measure(looseConstraint(this.viewportSize), context);
    this.content.arrange(
      { x: 0, y: 0, width: this.viewportSize.width, height: this.viewportSize.height },
      context,
    );
  }

  /**
   * Deliver an event.
   *
   * Returns whether it was consumed by the UI. A caller that also drives
   * gameplay asks {@link reachesGameplay} rather than inferring it from this --
   * a click on empty UI space is unconsumed but still must not also issue a move
   * order when a modal is up.
   */
  handle(event: UiEvent): boolean {
    this.now = event.time;
    return this.router.route(this.content, event, this.focus.focused);
  }

  reachesGameplay(kind: UiEvent['kind']): boolean {
    return this.contexts.reachesGameplay(kind);
  }

  pushContext(id: InputContextId): void {
    this.contexts.push(id);
  }

  popContext(id: InputContextId): void {
    this.contexts.pop(id);
  }

  /** Move focus forward (`+1`) or back (`-1`) within the root. */
  moveFocus(step: number): Widget | null {
    return this.focus.move(this.content, step);
  }

  /** Build this frame's draw list. Does not lay out -- call {@link update} first. */
  paint(): DrawList {
    this.list.clear();
    this.content.paint(this.list, this.paintContext());
    return this.list;
  }

  layoutContext(): LayoutContext {
    return { theme: this.options.theme, atlas: this.options.atlas };
  }

  paintContext(): PaintContext {
    return {
      theme: this.options.theme,
      atlas: this.options.atlas,
      now: this.now,
      hovered: this.router.hoveredWidget,
      pressed: this.router.pressedWidget,
      focused: this.focus.focused,
    };
  }
}
