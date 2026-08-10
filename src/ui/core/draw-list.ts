/**
 * What a widget paints into, instead of painting (spec 121).
 *
 * `Widget.paint()` appends commands here; a {@link UiSurface} replays them
 * afterwards. The indirection buys two things that would otherwise both need a
 * backend:
 *
 * - A screen's drawing can be **asserted** with no renderer at all. "The button
 *   emitted a sunken frame and its label in the accent colour" is a test that
 *   runs in Node in microseconds, and it fails for a reason a person can read,
 *   which a pixel diff does not.
 * - Batching is a property of the list rather than of every widget's good
 *   behaviour. Nothing in a widget knows or cares how many draw calls it costs.
 *
 * Pure. No DOM, no clock.
 */

import type { Color } from './color.js';
import type { Rect } from './geom.js';
import type { AtlasRect } from '../render/atlas.js';

export type DrawCommand =
  | { readonly kind: 'sprite'; readonly src: AtlasRect; readonly dst: Rect; readonly tint: Color }
  | { readonly kind: 'solid'; readonly dst: Rect; readonly color: Color }
  | { readonly kind: 'pushClip'; readonly rect: Rect }
  | { readonly kind: 'popClip' };

export class DrawList {
  private readonly commands: DrawCommand[] = [];
  private clipDepth = 0;

  clear(): void {
    this.commands.length = 0;
    this.clipDepth = 0;
  }

  sprite(src: AtlasRect, dst: Rect, tint: Color): void {
    if (dst.width <= 0 || dst.height <= 0) return;
    this.commands.push({ kind: 'sprite', src, dst, tint });
  }

  solid(dst: Rect, color: Color): void {
    if (dst.width <= 0 || dst.height <= 0 || color.a === 0) return;
    this.commands.push({ kind: 'solid', dst, color });
  }

  pushClip(rect: Rect): void {
    this.clipDepth++;
    this.commands.push({ kind: 'pushClip', rect });
  }

  popClip(): void {
    if (this.clipDepth === 0) throw new Error('draw list: popClip with no matching pushClip');
    this.clipDepth--;
    this.commands.push({ kind: 'popClip' });
  }

  /**
   * Every command, in order.
   *
   * Throws on an unbalanced clip stack rather than letting the surface discover
   * it: a widget that pushes and forgets to pop clips everything drawn after it,
   * which looks like the *next* widget being broken.
   */
  finish(): readonly DrawCommand[] {
    if (this.clipDepth !== 0) {
      throw new Error(`draw list: ${this.clipDepth} clip(s) were pushed and never popped`);
    }
    return this.commands;
  }

  /** The command count, without validating. For budget assertions. */
  get length(): number {
    return this.commands.length;
  }
}

/** Replay a finished list onto a surface. The only thing that calls the six methods. */
export function replay(surface: import('../render/surface.js').UiSurface, commands: readonly DrawCommand[]): void {
  surface.beginFrame();
  for (const command of commands) {
    switch (command.kind) {
      case 'sprite':
        surface.drawSprite(command.src, command.dst, command.tint);
        break;
      case 'solid':
        surface.drawSolid(command.dst, command.color);
        break;
      case 'pushClip':
        surface.pushClip(command.rect);
        break;
      case 'popClip':
        surface.popClip();
        break;
    }
  }
  surface.endFrame();
}
