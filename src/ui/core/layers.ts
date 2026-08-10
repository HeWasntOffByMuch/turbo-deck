/**
 * The fixed stacking order (spec 122).
 *
 * An enum, not a number anybody assigns. Every UI framework that lets a widget
 * pick its own z-index ends up with a file of magic numbers nobody dares change
 * and a tooltip that is somehow behind a window. Here the order is declared once,
 * a layer is a child of a `Stack` in that order, and "what is on top" is a fact
 * about this list rather than about whoever most recently guessed a bigger
 * number.
 *
 * Within `windows`, the {@link WindowManager} owns the ordering. Nothing else
 * has an ordering to own.
 *
 * Pure. No DOM, no clock.
 */

import { Stack } from './containers.js';
import type { Widget } from './widget.js';

export const LAYER_IDS = ['hud', 'windows', 'dragGhost', 'modal', 'tooltip', 'notification'] as const;

export type LayerId = (typeof LAYER_IDS)[number];

/**
 * A layer's job, for whoever is deciding where a new thing goes.
 *
 * `blocksBelow` is what makes the modal layer modal: while it has a visible
 * child, hit-testing stops there. It is a property of the layer rather than a
 * check every widget has to remember.
 */
export interface LayerSpec {
  readonly id: LayerId;
  readonly blocksBelow: boolean;
  /** Whether the pointer can reach this layer at all. */
  readonly interactive: boolean;
}

export const LAYERS: readonly LayerSpec[] = [
  // Always on, never focusable, ignores the pointer except where a widget in it
  // explicitly opts back in.
  { id: 'hud', blocksBelow: false, interactive: false },
  { id: 'windows', blocksBelow: false, interactive: true },
  // The thing under the cursor mid-drag. It must never be hit-tested: it *is*
  // the cursor, and a drop target under it has to be findable.
  { id: 'dragGhost', blocksBelow: false, interactive: false },
  { id: 'modal', blocksBelow: true, interactive: true },
  { id: 'tooltip', blocksBelow: false, interactive: false },
  { id: 'notification', blocksBelow: false, interactive: false },
];

/** The root of every screen: one Stack, six children, in order. */
export class LayerStack extends Stack {
  private readonly layers = new Map<LayerId, Stack>();

  constructor(name = 'layers') {
    super();
    this.name = name;
    for (const spec of LAYERS) {
      const layer = new Stack();
      layer.name = `layer:${spec.id}`;
      // Every layer is pointer-transparent, always -- a layer is an ordering,
      // not a surface. Making only the non-interactive ones transparent looks
      // right and means an *empty* modal layer, whose rect covers the viewport,
      // silently swallows every click in the game. `spec.interactive` decides
      // whether the layer is consulted at all; it never makes the layer itself
      // a target.
      layer.pointerTransparent = true;
      this.layers.set(spec.id, layer);
      this.add(layer);
    }
  }

  layer(id: LayerId): Stack {
    const found = this.layers.get(id);
    if (!found) throw new Error(`layers: no layer named ${id}`);
    return found;
  }

  place(id: LayerId, widget: Widget): void {
    this.layer(id).add(widget);
  }

  /** Whether a blocking layer currently has anything visible in it. */
  isBlocked(): boolean {
    for (const spec of LAYERS) {
      if (!spec.blocksBelow) continue;
      const layer = this.layers.get(spec.id);
      if (layer?.children.some((child) => child.visible)) return true;
    }
    return false;
  }

  /**
   * Hit-test, honouring `blocksBelow`.
   *
   * A modal has to stop the pointer reaching a window behind it while the window
   * is still *painted* -- which is the whole difference between a modal and
   * hiding everything else.
   */
  override hitTest(point: { x: number; y: number }): Widget | null {
    const blockingIndex = LAYERS.findIndex(
      (spec) => spec.blocksBelow && (this.layers.get(spec.id)?.children.some((child) => child.visible) ?? false),
    );
    const floor = blockingIndex < 0 ? 0 : blockingIndex;

    for (let i = LAYERS.length - 1; i >= floor; i--) {
      const spec = LAYERS[i];
      if (!spec) continue;
      const layer = this.layers.get(spec.id);
      if (!layer || !layer.visible || !spec.interactive) continue;
      const hit = layer.hitTest(point);
      if (hit) return hit;
    }
    return null;
  }
}
