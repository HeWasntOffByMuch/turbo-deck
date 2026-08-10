/**
 * Tabs that keep what you left in them (spec 122).
 *
 * The rule that matters: content is built lazily on first selection and then
 * **kept**. Switching away hides a widget; it does not destroy one. Rebuilding on
 * every switch is the obvious implementation and it silently loses state nobody
 * thought of as state -- a half-typed search box, a scroll position, which row
 * was selected. Those are the things a player notices and cannot name.
 *
 * Overflow is handled by scrolling the strip rather than by shrinking the tabs
 * until the labels are unreadable. A tab whose name you cannot read is not a tab.
 */

import type { DrawList } from '../core/draw-list.js';
import type { EventContext, Gesture } from '../core/events.js';
import { Column } from '../core/containers.js';
import {
  intersect,
  shrink,
  uniformInsets,
  type Constraint,
  type Rect,
  type Size,
} from '../core/geom.js';
import { alignTextX, centerTextY, drawNineSlice, drawTextClipped } from '../core/paint.js';
import type { LayoutContext, PaintContext, Widget } from '../core/widget.js';
import { fontById, measureText } from '../text/font.js';
import { StyledWidget } from './base.js';

/** One tab's header. Its own widget so it can be hit, hovered and styled. */
export class Tab extends StyledWidget {
  active = false;
  onSelect: (() => void) | null = null;

  constructor(
    readonly id: string,
    private labelText: string,
  ) {
    super('tab', `tab:${id}`);
    this.focusable = true;
    this.layoutAlign = 'start';
  }

  get label(): string {
    return this.labelText;
  }

  setLabel(value: string): void {
    if (value === this.labelText) return;
    this.labelText = value;
    this.invalidateMeasure();
  }

  onGesture(gesture: Gesture): void {
    if (gesture.kind === 'click' && gesture.button === 0) this.onSelect?.();
  }

  onEvent(context: EventContext): void {
    const event = context.event;
    if (event.kind !== 'key' || event.phase !== 'down') return;
    if (event.code !== 'Space' && event.code !== 'Enter') return;
    this.onSelect?.();
    context.stopPropagation();
  }

  protected override measureSelf(_constraint: Constraint, context: LayoutContext): Size {
    const style = context.theme.widget(this.styleKey);
    const font = fontById('body');
    return {
      width: measureText(font, this.labelText) + style.padding * 2,
      height: Math.max(style.metric('minHeight', 14), font.height + style.padding),
    };
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    const style = this.style(context);
    // The active tab is the second place the visual direction spends boldness --
    // the first being a focused window's title bar. Everything else stays quiet.
    const state = style.state(this.active ? 'pressed' : this.stateFor(context));
    out.solid(this.rect, state.fill);
    drawNineSlice(
      out,
      context.atlas.patch(this.active ? 'heavy' : style.frame),
      this.rect,
      this.active ? context.theme.color('accent') : state.frameTint,
    );

    const font = fontById('body');
    drawTextClipped(
      out,
      context.atlas,
      font,
      this.labelText,
      alignTextX(font, this.labelText, this.rect, 'center'),
      centerTextY(font, this.rect),
      this.active ? context.theme.color('text') : state.text,
      this.rect,
    );
  }
}

/**
 * The strip of tab headers.
 *
 * Scrolls horizontally when the tabs do not fit, clamped so the last tab's right
 * edge can always be reached. No chevrons yet: a drag or a wheel over the strip
 * moves it, which is one mechanism instead of three.
 */
export class TabStrip extends StyledWidget {
  private offset = 0;
  private contentWidth = 0;

  constructor(name = 'tabStrip') {
    super('tab', name);
    this.pointerTransparent = true;
  }

  get scrollOffset(): number {
    return this.offset;
  }

  get maxScroll(): number {
    return Math.max(0, this.contentWidth - this.rect.width);
  }

  scrollBy(delta: number): void {
    const next = Math.max(0, Math.min(this.maxScroll, this.offset + delta));
    if (next === this.offset) return;
    this.offset = next;
    this.invalidateArrange();
  }

  /** Bring a tab fully into view, which is what selecting a hidden one must do. */
  revealTab(tab: Widget): void {
    const left = tab.rect.x - this.rect.x + this.offset;
    const right = left + tab.rect.width;
    if (left < this.offset) this.scrollBy(left - this.offset);
    else if (right > this.offset + this.rect.width) this.scrollBy(right - this.offset - this.rect.width);
  }

  onEvent(context: EventContext): void {
    const event = context.event;
    if (event.kind !== 'wheel' || this.maxScroll === 0) return;
    this.scrollBy(-event.delta * 12);
    context.stopPropagation();
  }

  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    let width = 0;
    let height = 0;
    for (const child of this.children) {
      if (!child.visible) continue;
      const size = child.measure({ maxWidth: constraint.maxWidth, maxHeight: constraint.maxHeight }, context);
      width += size.width;
      height = Math.max(height, size.height);
    }
    this.contentWidth = width;
    return { width: Math.min(width, constraint.maxWidth), height };
  }

  protected override arrangeSelf(rect: Rect, context: LayoutContext): void {
    this.offset = Math.max(0, Math.min(this.maxScroll, this.offset));
    let pen = rect.x - this.offset;
    for (const child of this.children) {
      if (!child.visible) continue;
      const size = child.desiredSize;
      child.arrange({ x: pen, y: rect.y, width: size.width, height: rect.height }, context);
      pen += size.width;
    }
  }

  /** Tabs are clipped to the strip, so an overflowing one is cropped not drawn out. */
  protected override paintChildren(out: DrawList, context: PaintContext): void {
    out.pushClip(this.rect);
    super.paintChildren(out, context);
    out.popClip();
  }

  /** Hit-testing has to respect the clip too, or a cropped tab is still clickable. */
  protected override containsForHitTest(point: { x: number; y: number }): boolean {
    return (
      point.x >= this.rect.x &&
      point.x < this.rect.x + this.rect.width &&
      point.y >= this.rect.y &&
      point.y < this.rect.y + this.rect.height
    );
  }
}

interface TabEntry {
  readonly id: string;
  readonly tab: Tab;
  readonly build: () => Widget;
  content: Widget | null;
}

/** The strip plus the body, and the rule that content is built once. */
export class TabPanel extends Column {
  private readonly strip = new TabStrip();
  private readonly body = new Column('tabBody');
  private readonly entries: TabEntry[] = [];
  private active = '';
  onSelect: ((id: string) => void) | null = null;

  constructor(name = 'tabs') {
    super(name);
    this.gap = 0;
    this.body.layoutGrow = 1;
    this.add(this.strip);
    this.add(this.body);
  }

  get activeId(): string {
    return this.active;
  }

  get tabIds(): readonly string[] {
    return this.entries.map((entry) => entry.id);
  }

  /** Whether a tab's content has been built yet. Asserted by the tests. */
  isBuilt(id: string): boolean {
    return this.entries.find((entry) => entry.id === id)?.content !== null;
  }

  addTab(id: string, label: string, build: () => Widget): this {
    const tab = new Tab(id, label);
    tab.onSelect = () => {
      this.select(id);
    };
    this.entries.push({ id, tab, build, content: null });
    this.strip.add(tab);
    if (this.active === '') this.select(id);
    return this;
  }

  select(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return;

    this.active = id;
    for (const other of this.entries) {
      other.tab.active = other.id === id;
      // Hidden, never removed: a tab you come back to still has what you left.
      if (other.content) other.content.visible = other.id === id;
    }
    if (!entry.content) {
      entry.content = entry.build();
      entry.content.layoutGrow = 1;
      this.body.add(entry.content);
    }
    entry.content.visible = true;
    this.strip.revealTab(entry.tab);
    this.invalidateMeasure();
    this.onSelect?.(id);
  }

  /**
   * The body's padding comes from the theme, which a constructor has no access to.
   *
   * Applied on the first measure rather than at build time, because the theme
   * arrives with the layout context -- and without it a tab's content sits
   * directly against the frame drawn around it, which reads as a rendering bug
   * rather than as missing padding.
   */
  protected override measureSelf(constraint: Constraint, context: LayoutContext): Size {
    const padding = context.theme.spacing.xs;
    if (this.body.padding.left !== padding) this.body.padding = uniformInsets(padding);
    return super.measureSelf(constraint, context);
  }

  /** The visible body rect, for tests that care where content lands. */
  bodyRect(): Rect {
    return this.body.rect;
  }

  /** The strip, so a test can drive overflow directly. */
  get headerStrip(): TabStrip {
    return this.strip;
  }

  /** Every tab header is inside the strip -- asserted, since overflow is easy to get wrong. */
  tabRects(): readonly Rect[] {
    return this.entries
      .filter((entry) => entry.tab.visible)
      .map((entry) => intersect(entry.tab.rect, this.strip.rect));
  }

  protected override paintSelf(out: DrawList, context: PaintContext): void {
    const style = context.theme.widget('panel');
    const box = shrink(this.body.rect, uniformInsets(0));
    out.solid(box, style.state('normal').fill);
    drawNineSlice(out, context.atlas.patch(style.frame), box, style.state('normal').frameTint);
  }
}
