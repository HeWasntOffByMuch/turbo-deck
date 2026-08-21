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
import type { WindowId } from './control-actions.js';
import type { MaxZoomChoice } from '../../../ui/input/display-store.js';
import { UiScreens, type UiScreensOptions } from './ui-screens.js';
import type { ActionSlot } from './action-bar.js';
import { NO_ACTION_BAR, type ActionBarBox } from './hud-layout.js';
import { DEFAULT_SHOW_FPS, type ScaleChoice } from '../../../ui/input/display-store.js';

export type { WindowId } from './control-actions.js';
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
  /**
   * The chat's lines, its field and whether the field is open (spec 189).
   *
   * The log is drawn to a canvas like everything else here, so "the line the
   * other player said is on screen" has no element to ask -- and a browser
   * assertion that could only say some pixels changed would pass just as
   * happily over a log showing the wrong thing.
   */
  readonly chat: readonly string[];
  readonly chatOpen: boolean;
  readonly chatInput: string;
  /**
   * The mini HUD and the action bar (spec 196), for the reason the chat is here.
   *
   * `selected` is `name|detail` and empty for nothing selected; `selectedRows`
   * is each status as `label|remaining|tone`; `barSlots` is each slot keyed by
   * the ability it holds, with an empty id for one nothing has been put in yet.
   */
  readonly selected: string;
  readonly selectedRows: readonly string[];
  readonly selectedRect: Rect | null;
  readonly barSlots: readonly { readonly id: string; readonly rect: Rect }[];
  readonly chatRects: readonly { readonly id: string; readonly rect: Rect }[];
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

  /** The widest-zoom preference (spec 198). Same pass-through as the two above. */
  setMaxZoom(choice: MaxZoomChoice): void {
    this.screens.setMaxZoom(choice);
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
  /** The last measured bottom band, in CSS pixels. See {@link applySafeBottom}. */
  private measuredBand = 0;
  /** ...and the top-right corner's, on the same terms (spec 196). */
  private measuredRight = 0;
  /** How big an action-bar slot should be, in CSS pixels. See below. */
  private slotSideCss = 0;

  private applyCssSize(): void {
    this.element.style.width = `${this.frame.cssWidth}px`;
    this.element.style.height = `${this.frame.cssHeight}px`;
  }

  /**
   * Everything a screen shows, then the blit. Cheap when nothing changed.
   *
   * `drawnTick` is the interpolated presentation tick the bodies are placed by,
   * handed through rather than re-derived: it is what the mini HUD measures a
   * status's remaining window against, and a second clock here would let the
   * panel and the mark over the same body disagree about when one runs out.
   */
  update(view: ClientView, nowMs: number, drawnTick: number = view.estimatedTick): void {
    const began = performance.now();
    this.resize();
    // The HUD is built after this layer is mounted, so the measurement taken at
    // the first resize finds nothing to measure. Retried until it does, and then
    // left alone -- the switch's height does not change while the frame does
    // not, and a `getBoundingClientRect` in the render loop is a forced layout
    // every frame for an answer that is settled after the first one.
    if (this.measuredBand === 0) this.applySafeBottom();
    if (this.measuredRight === 0) this.applySafeTopRight();
    this.screens.update(view, nowMs, drawnTick);
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
    this.applySafeBottom();
    this.applySafeTopRight();
    this.applySlotSide();
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

  // --- the action bar (spec 196) ---------------------------------------------

  /** Replace what the five slots hold. See `UiScreens.setActionBarPlan`. */
  setActionBarPlan(plan: readonly ActionSlot[]): void {
    this.screens.setActionBarPlan(plan);
  }

  /** Which ability is being aimed, so the slot it came from is lit (spec 080). */
  setAiming(abilityId: string | null): void {
    this.screens.setAiming(abilityId);
  }

  /**
   * The box the bar occupies, in **CSS** pixels.
   *
   * The one conversion this file exists for, run the other way round: everything
   * the DOM HUD still draws along the bottom edge is placed against the bar, and
   * the bar is measured in UI pixels at whatever scale the player chose. Zero
   * before the interface has laid itself out once, which is a real state and one
   * the HUD is written to survive.
   */
  actionBarBoxCss(): ActionBarBox {
    const rect = this.screens.actionBarBox();
    if (!rect) return NO_ACTION_BAR;
    const dpr = globalThis.devicePixelRatio || 1;
    const perUi = this.frame.scale / dpr;
    return {
      width: Math.round(rect.width * perUi),
      height: Math.round(rect.height * perUi),
      // Where the row actually ended up, not where it was asked to go: the dock
      // adds the theme's own margin above the floor it was told, and a DOM half
      // that assumed the floor put the pool block eight pixels low.
      bottom: Math.round((this.frame.height - rect.y - rect.height) * perUi),
    };
  }

  /**
   * How much of the frame's floor the DOM HUD has reserved, in CSS pixels.
   *
   * Converted here rather than by the caller, because this file is where UI
   * pixels and CSS pixels meet and a second conversion anywhere else is a second
   * answer. A *distance* rather than a point, so it is the gap between two.
   */
  setActionBarFloorCss(cssPixels: number): void {
    this.screens.setActionBarFloor(this.toUi({ x: 0, y: cssPixels }).y - this.toUi({ x: 0, y: 0 }).y);
  }

  /**
   * How big one slot should be, converted from CSS pixels (spec 196).
   *
   * Re-applied on every resize rather than pushed once, because the scale is
   * what the conversion turns on: a player who picks a chunkier interface gets
   * *fewer* UI pixels for the same physical square, and a bar that kept the old
   * number would be the one thing on the canvas drawn at the previous scale.
   */
  setActionBarSlotCss(cssPixels: number): void {
    this.slotSideCss = cssPixels;
    this.applySlotSide();
  }

  private applySlotSide(): void {
    if (this.slotSideCss <= 0) return;
    const dpr = globalThis.devicePixelRatio || 1;
    this.screens.setActionBarSlotSide((this.slotSideCss * dpr) / this.frame.scale);
  }

  /** Whether a slot names the key that fires it. See `HudHandle.showsSlotKeys`. */
  setShowsSlotKeys(shows: boolean): void {
    this.screens.setShowsSlotKeys(shows);
  }

  /** Every slot's box, in CSS pixels, and what it holds. See the note above. */
  actionBarSlotsCss(): readonly { readonly ability: string; readonly rect: Rect }[] {
    const dpr = globalThis.devicePixelRatio || 1;
    const perUi = this.frame.scale / dpr;
    const origin = this.element.getBoundingClientRect();
    return this.screens.actionBarSlots().map((slot) => ({
      ability: slot.ability,
      rect: {
        x: origin.left + slot.rect.x * perUi,
        y: origin.top + slot.rect.y * perUi,
        width: slot.rect.width * perUi,
        height: slot.rect.height * perUi,
      },
    }));
  }

  // --- the mini HUD (spec 196) ----------------------------------------------

  /**
   * Point the selected-unit panel at a body, or at nothing.
   *
   * A passthrough like the chat's below: this half is a canvas and a coordinate
   * conversion, and what the interface *is* lives on the other side of it.
   */
  select(entityId: number | null): void {
    this.screens.select(entityId);
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

  /**
   * How far up the DOM HUD's own furniture reaches, told to the screens (spec 189).
   *
   * **Measured rather than derived.** The chat is docked bottom-left and what is
   * already there is the weapon switch -- a column whose height depends on how
   * many weapons there are and on which layout is in force -- so the arithmetic
   * version was a second description of somebody else's layout, and it was
   * wrong: it measured the pool bars, which sit lower and further right, and the
   * log was drawn straight over the switch.
   *
   * Converted as a *distance* rather than as a point: `toUi` maps a position,
   * and a height is the gap between two of them.
   */
  private applySafeBottom(): void {
    const band = bottomBandCss();
    this.measuredBand = band;
    this.screens.setSafeBottom(this.toUi({ x: 0, y: band }).y - this.toUi({ x: 0, y: 0 }).y);
  }

  /**
   * How far down the top-right corner's own furniture reaches (spec 196).
   *
   * The counterpart to {@link applySafeBottom} and measured for the same reason
   * it is: the tuning popovers are seven buttons of their own heights that wrap
   * on a narrow window, and they are absent entirely on a handheld. A constant
   * would be a second description of somebody else's layout -- which is the
   * mistake that put the chat log on the weapon switch.
   *
   * A *point* rather than a distance, because that is what it is: the corner is
   * occupied from the top of the frame down to where those buttons end.
   */
  private applySafeTopRight(): void {
    const bottom = rightBandCss();
    this.measuredRight = bottom;
    this.screens.setSafeTopRight(this.toUi({ x: 0, y: bottom }).y);
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
/**
 * How far up the frame the HUD's own furniture reaches, in CSS pixels (spec 189).
 *
 * The topmost edge of anything marked `data-hud-bottom`, which today is the
 * weapon switch and the pool block. Zero when the HUD has not been built yet,
 * which is a real state -- see {@link UiLayer.applySafeBottom}.
 */
function bottomBandCss(): number {
  const boxes = Array.from(document.querySelectorAll<HTMLElement>('[data-hud-bottom]'))
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (boxes.length === 0) return 0;
  const top = Math.min(...boxes.map((rect) => rect.top));
  return Math.max(0, globalThis.innerHeight - top);
}

/**
 * How far down the frame anything marked `data-hud-right` reaches, in CSS
 * pixels (spec 196).
 *
 * Today that is the strip of tuning popovers, and only on a pointer device --
 * spec 140 does not build them on a handheld, so zero there is the truth rather
 * than a not-yet-measured state. Zero is also what a headless or embedded case
 * gets, which is correct for the same reason.
 */
function rightBandCss(): number {
  const boxes = Array.from(document.querySelectorAll<HTMLElement>('[data-hud-right]'))
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (boxes.length === 0) return 0;
  return Math.max(0, ...boxes.map((rect) => rect.bottom));
}

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
