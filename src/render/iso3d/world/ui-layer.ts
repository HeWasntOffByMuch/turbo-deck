/**
 * The canvas the interface is drawn on (spec 131).
 *
 * The impure half of the mount, and deliberately almost nothing: a second canvas
 * over the world's, the scale that decides how big a UI pixel is, the conversion
 * from a CSS coordinate to a UI one, and a blit. What the interface *is* lives
 * next door in `ui-screens.ts`, which is pure and runs in Node -- that is what
 * lets `mount-presentation.test.ts` play the same fight twice, once with the
 * interface driven and once without, and require identical authoritative state.
 *
 * Two decisions worth knowing, both about *where*.
 *
 * **It covers the whole tab, not the letterboxed picture.** The DOM HUD is
 * pinned to `scene.viewport()` because every anchor it draws is in canvas
 * space -- a health bar over a body has to letterbox with the body. A window
 * does not: it belongs to the screen, and `docs/ui/00-architecture.md` §2.3
 * settled that the UI has a *scale* rather than a resolution. So this canvas is
 * the size of the tab, at `autoUiScale`, and never reads the world's `lowRes`.
 *
 * **The browser never hit-tests it.** `pointer-events: none`, so events go on
 * arriving at the listeners `view.ts` already owns and the interface is
 * *offered* each one. There is one input path in the Play tab, and "did the
 * interface take that click" has one answer rather than being split between the
 * DOM and us.
 */

import { resolveUiScale, uiFrame, type UiFrame } from '../../../ui/core/frame.js';
import { replay, type DrawCommand } from '../../../ui/core/draw-list.js';
import type { Modifiers } from '../../../ui/core/events.js';
import type { Point, Rect } from '../../../ui/core/geom.js';
import type { Color } from '../../../ui/core/color.js';
import { Canvas2dSurface } from '../../../ui/render/canvas2d.js';
import { THEME } from '../../../ui/theme/theme.js';
import type { ClientView } from '../../../server/client/game-client.js';
import { isHandheldDevice } from '../device.js';
import { hudLayout, leftBandHeight } from './hud-layout.js';
import type { WindowId } from './key-actions.js';
import { UiScreens, type UiScreensOptions } from './ui-screens.js';
import { DEFAULT_SHOW_FPS, type ScaleChoice } from '../../../ui/input/display-store.js';

export type { WindowId } from './key-actions.js';
export interface UiLayerOptions extends UiScreensOptions {
  /** The saved scale preference, read at the DOM edge. `'auto'` by default. */
  readonly scale?: ScaleChoice;
  /** The saved frame-rate preference (spec 165), read at the same edge. On by default. */
  readonly showFps?: boolean;
}

/**
 * Whether the tab is on its way out, in a way worth flushing the layout for.
 *
 * Both events, because neither is enough on its own: `pagehide` is the one that
 * fires for a bfcache freeze and a navigation, and a phone browser killed in the
 * background may only ever report `visibilitychange`. Flushing twice costs one
 * `setItem` of the same document.
 */

/** How many *drawn* frames the reported cost is taken over. Two seconds at 60fps. */
const COST_WINDOW = 120;

/** What the interface is showing, for a harness. See {@link UiLayer.readout}. */
export interface UiReadout {
  readonly windows: readonly WindowId[];
  readonly bag: readonly string[];
  /** The options window's active tab, and where every tab is, in UI pixels. */
  readonly tab: string;
  readonly tabRects: readonly { readonly id: string; readonly rect: Rect }[];
  /** The scale preference, and where each choice's box is, in UI pixels. */
  readonly scaleChoice: string;
  readonly scaleRects: readonly { readonly id: string; readonly rect: Rect }[];
  /** Where each bag cell is, in UI pixels, so a harness can click one. */
  readonly bagRects: readonly { readonly id: string; readonly rect: Rect }[];
  /** ...and a keybinding row's two buttons, by action id. */
  readonly bindRects: readonly { readonly id: string; readonly rect: Rect }[];
  readonly resetRects: readonly { readonly id: string; readonly rect: Rect }[];
  /** Every window's placement, open or not, in UI pixels (spec 147). */
  readonly windowRects: readonly { readonly id: string; readonly rect: Rect }[];
  /**
   * What the trade table is showing and where its controls are (spec 134).
   * Empty when there is no trade; only visible controls are listed.
   */
  readonly tradeStage: string;
  readonly tradeReason: string;
  /** Whether you are the side being asked: 'yes', 'no', or '' for no trade. */
  readonly tradeInvited: string;
  /** Each side as `name|accepted|coins|item xN/item xN`. */
  readonly tradeYou: string;
  readonly tradeThem: string;
  readonly tradeRects: readonly { readonly id: string; readonly rect: Rect }[];
  /** Device pixels per UI pixel. Whole, always -- the rule the frame exists for. */
  readonly scale: number;
  readonly viewport: { readonly width: number; readonly height: number };
  /** The median full update-and-draw, over the last {@link COST_WINDOW} that drew. */
  readonly frameMs: number;
  /** ...and the worst of them, which is mostly a fact about the rest of the frame. */
  readonly worstFrameMs: number;
}

export class UiLayer {
  readonly element: HTMLCanvasElement;
  readonly screens: UiScreens;

  private readonly surface: Canvas2dSurface;
  private frame: UiFrame;
  /** `'auto'` defers to {@link autoUiScale}; a number overrides it (spec 136). */
  private scaleChoice: ScaleChoice = 'auto';
  private readonly costs = new Float64Array(COST_WINDOW);
  private costCursor = 0;
  /** The picture as last drawn, so an unchanged one is not drawn again. */
  private lastList: readonly DrawCommand[] = [];
  /**
   * Whether the frame needs measuring again.
   *
   * Set by an observer rather than checked every frame, and that is a real
   * measurement rather than a style preference: `clientWidth` forces a layout
   * flush, the DOM HUD rewrites element styles every frame right before this
   * runs, and `matchMedia` is not free either. Asking once per frame cost 19ms
   * against a 1.5ms budget -- almost none of it the interface, all of it the
   * reflow the question provoked.
   */
  private frameDirty = false;
  private readonly observer: ResizeObserver | null;
  private readonly onWindowResize = (): void => {
    // A zoom or a move to another monitor changes `devicePixelRatio` without
    // changing the element's size, so the observer alone would miss it.
    this.frameDirty = true;
  };
  /** The tab going away, so a layout still inside its debounce is written. */
  private readonly onPageHide = (): void => {
    this.screens.flushLayout();
  };
  /** ...and the same on the way to the background. It fires on the way back too. */
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.screens.flushLayout();
  };

  constructor(
    private readonly host: HTMLElement,
    options: UiLayerOptions,
  ) {
    this.element = document.createElement('canvas');
    // Over the world and over the DOM HUD, and inert to the browser's own
    // hit-testing. See the header.
    this.element.style.cssText = 'position:absolute;left:0;top:0;z-index:40;pointer-events:none;';
    // Named so a harness can find *this* canvas among the tab's several and read
    // its pixels back -- which is the only way to ask whether the interface drew.
    this.element.dataset['uiCanvas'] = '';
    host.append(this.element);

    this.scaleChoice = options.scale ?? 'auto';
    this.frame = this.measureFrame();
    this.screens = new UiScreens(options, { width: this.frame.width, height: this.frame.height });
    this.screens.setScale(this.scaleChoice, this.frame.scale);
    this.screens.setShowFps(options.showFps ?? DEFAULT_SHOW_FPS);
    this.surface = new Canvas2dSurface(
      this.element,
      this.screens.atlas,
      this.frame.width,
      this.frame.height,
      { scale: this.frame.scale },
    );
    this.applyCssSize();

    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            this.frameDirty = true;
          });
    this.observer?.observe(host);
    // A first pass anyway: the tab is often not laid out yet when this is built,
    // so the frame measured above is a 1x1 placeholder until the first frame.
    this.frameDirty = true;
    globalThis.addEventListener('resize', this.onWindowResize);
    // Neither is enough alone: `pagehide` covers a navigation and a bfcache
    // freeze, and a phone browser that kills a backgrounded tab may only ever
    // report the visibility change (spec 147).
    globalThis.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private measureFrame(): UiFrame {
    const dpr = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    // The rule itself is `resolveUiScale`, next to `autoUiScale` where it
    // belongs (spec 136). This file measures; it does not decide.
    const scale = resolveUiScale(this.scaleChoice === 'auto' ? null : this.scaleChoice, width, height, dpr, {
      minViewport: THEME.input.minViewport,
      comfortViewport: THEME.input.comfortViewport,
      coarsePointer: globalThis.matchMedia?.('(pointer: coarse)').matches ?? false,
      maxTapUiPx: THEME.input.maxTapUiPx,
    });
    return uiFrame(width, height, dpr, scale);
  }

  /**
   * Take a new scale preference and re-frame on the next update.
   *
   * The re-measure is deferred rather than done here for the reason the whole
   * `frameDirty` flag exists: this is called from a click handler, and
   * `clientWidth` in one forces the layout flush that cost 19ms a frame.
   */
  setScaleChoice(choice: ScaleChoice): void {
    if (choice === this.scaleChoice) return;
    this.scaleChoice = choice;
    this.frameDirty = true;
    this.screens.setScale(choice, this.frame.scale);
  }

  /**
   * Take a new frame-rate preference (spec 165).
   *
   * Beside `setScaleChoice` and unlike it in one way: nothing re-frames, because
   * this changes what an overlay outside the interface draws rather than how big
   * the interface is. All it does is keep the page's tick in step with what the
   * mount decided.
   */
  setShowFps(show: boolean): void {
    this.screens.setShowFps(show);
  }

  get scale(): number {
    return this.frame.scale;
  }

  /**
   * The CSS size, in CSS pixels.
   *
   * Set here rather than left to the surface: `Canvas2dSurface` sizes itself in
   * *device* pixels and writes that number into `style.width`, which is the
   * right answer only at dpr 1. In the game it would draw the interface at twice
   * its size on a retina screen, off the bottom of the tab.
   */
  private applyCssSize(): void {
    this.element.style.width = `${this.frame.cssWidth}px`;
    this.element.style.height = `${this.frame.cssHeight}px`;
  }

  /** Everything a screen shows, then the blit. Cheap when nothing changed. */
  update(view: ClientView, nowMs: number): void {
    const began = performance.now();
    this.resize();
    this.screens.update(view, nowMs);
    const list = this.screens.paint();
    // A still interface is not redrawn.
    //
    // The commands are rebuilt every frame -- they are cheap objects and the
    // paint walk is the only thing that knows whether anything moved -- but
    // *drawing* them is not cheap, and an interface with a window open and
    // nothing happening in it produces the same picture sixty times a second.
    // Comparing four hundred small records costs microseconds and saved the
    // largest single item in the frame.
    if (sameList(list, this.lastList)) return;
    // Copied: `DrawList.finish` hands back the list's own array, which the next
    // paint clears and refills. Keeping the reference would compare a frame
    // against itself and never redraw anything again.
    this.lastList = list.slice();
    replay(this.surface, list);
    // Only frames that actually drew are timed, and that is the whole point of
    // the number. The brief asks what a full update *and draw* costs; with the
    // still-frame skip above, a median over every frame is a median over frames
    // that did nothing, and it reads 0.00ms however slow the drawing is.
    this.recordCost(performance.now() - began);
  }

  /**
   * What a frame of interface costs, over the last {@link COST_WINDOW} of them.
   *
   * The brief states a budget and adds "measure it, don't assume it", and the
   * gallery's browser preview measures a *scene* rather than the game. These are
   * the same numbers where it actually matters: under a fight, with the world
   * drawing on the same thread and the tab's compositor doing the rest.
   *
   * Both the median and the worst, because they answer different questions. The
   * median is what the interface costs and is the number comparable with the
   * gallery's. The worst is dominated by whatever else the frame was doing --
   * a GC, a chunk arriving, the world's own draw -- and is diagnostics.
   *
   * The clock is read here rather than inside `src/ui/`, which is forbidden one
   * and forbidden it for a reason: `UiScreens` stays replayable.
   */
  private recordCost(ms: number): void {
    this.costs[this.costCursor % COST_WINDOW] = ms;
    this.costCursor += 1;
  }

  private sampled(): number[] {
    return [...this.costs.slice(0, Math.min(this.costCursor, COST_WINDOW))].sort((a, b) => a - b);
  }

  get frameMs(): number {
    const seen = this.sampled();
    return seen[Math.floor(seen.length / 2)] ?? 0;
  }

  get worstFrameMs(): number {
    const seen = this.sampled();
    return seen[seen.length - 1] ?? 0;
  }

  /** Follow the tab's size, and the scale that size implies. */
  resize(): void {
    if (!this.frameDirty) return;
    this.frameDirty = false;
    const next = this.measureFrame();
    if (
      next.width === this.frame.width &&
      next.height === this.frame.height &&
      next.scale === this.frame.scale
    ) {
      return;
    }
    this.frame = next;
    this.screens.setScale(this.scaleChoice, next.scale);
    // Read here, at the same cadence and in the same place as `(pointer:
    // coarse)` above (spec 133). Nothing under `src/ui/` may ask the platform
    // anything, and a preference sensed inside a widget is one no test can set.
    this.screens.setMotion({ reduced: prefersReducedMotion() });
    this.surface.resize(next.width, next.height, next.scale);
    this.applyCssSize();
    this.screens.resize({ width: next.width, height: next.height });
    this.screens.setSafeTop(this.toUi({ x: 0, y: chromeBottomCss() }).y);
    // ...and the other edge (spec 189). The chat is docked bottom-left, which is
    // where the pool bars are, so it is given the same treatment: measured in
    // CSS pixels out here and converted through the one place the two coordinate
    // systems meet. A `y` is an absolute position and this is a *height*, so it
    // is converted as the distance between two points rather than as a point.
    const band = leftBandHeight(hudLayout(isHandheldDevice()));
    this.screens.setSafeBottom(this.toUi({ x: 0, y: band }).y - this.toUi({ x: 0, y: 0 }).y);
    // The canvas's backing store was just reallocated, so whatever was on it is
    // gone -- and the same draw list would otherwise be skipped as unchanged and
    // leave the interface blank until something moved.
    this.forgetPicture();
  }

  // --- what `view.ts` calls -------------------------------------------------

  get anyOpen(): boolean {
    return this.screens.anyOpen;
  }

  isOpen(id: WindowId): boolean {
    return this.screens.isOpen(id);
  }

  opened(): readonly WindowId[] {
    return this.screens.opened();
  }

  /** What the interface is showing, for a harness. See `UiScreens.readout`. */
  readout(): UiReadout {
    return {
      ...this.screens.readout(),
      scale: this.frame.scale,
      viewport: { width: this.frame.width, height: this.frame.height },
      frameMs: this.frameMs,
      worstFrameMs: this.worstFrameMs,
    };
  }

  toggle(id: WindowId): void {
    this.screens.toggle(id);
  }

  /** Offer a pointer event, in CSS pixels. True when gameplay must not act. */
  handlePointer(phase: 'down' | 'up' | 'move', at: Point, button: number, mods: Modifiers): boolean {
    return this.screens.handlePointer(phase, this.toUi(at), button, mods);
  }

  handleWheel(at: Point, delta: number, mods: Modifiers): boolean {
    return this.screens.handleWheel(this.toUi(at), delta, mods);
  }

  handleKey(code: string, phase: 'down' | 'up', mods: Modifiers, text?: string): boolean {
    return this.screens.handleKey(code, phase, mods, text);
  }

  moveFocus(step: number): void {
    this.screens.moveFocus(step);
  }

  // --- chat (spec 189) ------------------------------------------------------

  /** A line arrived from the server. */
  pushChat(channel: number, from: string, text: string): void {
    this.screens.pushChat(channel, from, text);
  }

  get chatOpen(): boolean {
    return this.screens.chatOpen;
  }

  openChat(): void {
    this.screens.openChat();
  }

  closeChat(): void {
    this.screens.closeChat();
  }

  /** CSS pixels relative to the host, to UI pixels. The one conversion. */
  private toUi(at: Point): Point {
    const dpr = globalThis.devicePixelRatio || 1;
    return {
      x: Math.floor((at.x * dpr) / this.frame.scale),
      y: Math.floor((at.y * dpr) / this.frame.scale),
    };
  }

  /** Forget what was drawn, so the next frame redraws. For a surface swap. */
  private forgetPicture(): void {
    this.lastList = [];
  }

  dispose(): void {
    this.observer?.disconnect();
    globalThis.removeEventListener('resize', this.onWindowResize);
    globalThis.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    // Leaving the tab is leaving: a layout inside its debounce is written on the
    // way out rather than lost with the mount.
    this.screens.flushLayout();
    this.element.remove();
  }
}

/**
 * Whether the player has asked their system for less motion.
 *
 * Defaults to *full* motion when the query cannot be asked, which is the right
 * way round: an interface that animated nothing because it could not read a
 * preference would be silently broken, where one that animates when it should
 * not is visibly wrong and gets fixed.
 */
function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * How far down the tab's own chrome reaches, in CSS pixels.
 *
 * The tab bar is `position: fixed` over the whole view and wraps on a narrow
 * window, so its height is a measurement rather than a constant -- and a window
 * opened at the top margin opens underneath it. Nobody saw that while the
 * interface was twice as chunky: a margin of 8 UI pixels was 32 real ones and
 * cleared the bar by accident.
 *
 * Read once per re-measure, never per frame: `getBoundingClientRect` forces a
 * layout flush, which is the cost this file already learned about the hard way.
 * Zero when there is no bar, which is every headless and embedded case.
 */
function chromeBottomCss(): number {
  const bar = document.querySelector<HTMLElement>('[data-tab-bar]');
  return bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
}

/**
 * Whether two frames' commands describe the same picture.
 *
 * Field-wise rather than by identity: the paint walk builds fresh records every
 * frame, so identity is always false and the whole comparison would be a slower
 * way of saying "redraw". The rects and the atlas sources *are* compared by
 * identity where they can be -- `AtlasRect`s come out of the atlas and are the
 * same objects -- with a field compare as the fallback.
 */
function sameList(next: readonly DrawCommand[], last: readonly DrawCommand[]): boolean {
  if (next.length !== last.length) return false;
  for (let i = 0; i < next.length; i++) {
    const a = next[i];
    const b = last[i];
    if (a === undefined || b === undefined || a.kind !== b.kind) return false;
    switch (a.kind) {
      case 'popClip':
        break;
      case 'pushClip':
        if (b.kind !== 'pushClip' || !sameRect(a.rect, b.rect)) return false;
        break;
      case 'solid':
        if (b.kind !== 'solid' || !sameRect(a.dst, b.dst) || !sameColor(a.color, b.color)) return false;
        break;
      case 'sprite':
        if (
          b.kind !== 'sprite' ||
          !sameRect(a.dst, b.dst) ||
          !sameRect(a.src, b.src) ||
          !sameColor(a.tint, b.tint)
        ) {
          return false;
        }
        break;
    }
  }
  return true;
}

function sameRect(a: Rect, b: Rect): boolean {
  return a === b || (a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
}

function sameColor(a: Color, b: Color): boolean {
  return a === b || (a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a);
}
