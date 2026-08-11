/**
 * What reaches a widget, and the stack that decides whether it does (spec 123).
 *
 * Two things here are deliberate and easy to get wrong later.
 *
 * **Time is an argument.** Every event carries the timestamp it arrived with,
 * and nothing under `src/ui/` reads `Date` or `performance` -- lint forbids it.
 * Double-click and press-and-hold are therefore decided from numbers the caller
 * supplied, which is what makes an input-replay test exact rather than
 * approximately reproducible. It is the same discipline the sim runs on.
 *
 * **Contexts are a stack, never a set of booleans.** `Gameplay -> UI -> Modal ->
 * TextEntry`, pushed and popped. A focused text field swallows keys because it
 * pushed `TextEntry`, not because something set `typing = true` and something
 * else forgot to unset it.
 *
 * Pure. No DOM, no clock.
 */

import type { Point } from './geom.js';
import type { Widget } from './widget.js';

/** A physical key, in the `KeyboardEvent.code` vocabulary -- layout independent. */
export type PhysicalKey = string;

export interface Modifiers {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export const NO_MODIFIERS: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };

export type PointerPhase = 'down' | 'up' | 'move';

export interface PointerEventData {
  readonly kind: 'pointer';
  readonly phase: PointerPhase;
  /** In UI pixels, relative to the viewport's top left. */
  readonly pos: Point;
  readonly button: number;
  readonly mods: Modifiers;
  readonly time: number;
}

export interface WheelEventData {
  readonly kind: 'wheel';
  readonly pos: Point;
  /** Positive scrolls content up (the usual "away from the user" direction). */
  readonly delta: number;
  readonly mods: Modifiers;
  readonly time: number;
}

export interface KeyEventData {
  readonly kind: 'key';
  readonly phase: 'down' | 'up';
  readonly code: PhysicalKey;
  readonly mods: Modifiers;
  readonly time: number;
}

/** A committed character. Separate from `key` so IME and repeat stay sane. */
export interface TextEventData {
  readonly kind: 'text';
  readonly text: string;
  readonly time: number;
}

export type UiEvent = PointerEventData | WheelEventData | KeyEventData | TextEventData;

/** Derived events a widget subscribes to rather than deriving itself. */
export type GestureKind = 'click' | 'doubleClick' | 'dragStart' | 'drag' | 'dragEnd' | 'enter' | 'leave';

export interface Gesture {
  readonly kind: GestureKind;
  readonly pos: Point;
  /** Movement since the drag began. Zero for everything that is not a drag. */
  readonly delta: Point;
  readonly button: number;
  readonly mods: Modifiers;
  readonly time: number;
}

/**
 * One delivery of an event to one widget.
 *
 * `stopPropagation` ends the *current* phase only: stopping during capture still
 * lets the bubble walk run, because "do not let my children see this" and "do
 * not let my parents see this" are different requests and a single flag would
 * conflate them.
 */
export class EventContext {
  private stopped = false;

  constructor(
    readonly event: UiEvent,
    readonly target: Widget | null,
  ) {}

  stopPropagation(): void {
    this.stopped = true;
  }

  get propagationStopped(): boolean {
    return this.stopped;
  }

  resume(): void {
    this.stopped = false;
  }
}

export type InputContextId = 'gameplay' | 'ui' | 'modal' | 'textEntry';

/**
 * The context stack.
 *
 * `blocksBelow` is what makes a modal modal and a text field greedy, and it is a
 * property of the context rather than a check every handler has to remember.
 */
export interface InputContext {
  readonly id: InputContextId;
  /** Whether events stop here instead of reaching contexts pushed before it. */
  readonly blocksBelow: boolean;
  /** Whether keyboard events specifically stop here. */
  readonly swallowsKeys: boolean;
}

export const CONTEXTS: Readonly<Record<InputContextId, InputContext>> = {
  gameplay: { id: 'gameplay', blocksBelow: false, swallowsKeys: false },
  ui: { id: 'ui', blocksBelow: false, swallowsKeys: false },
  modal: { id: 'modal', blocksBelow: true, swallowsKeys: true },
  textEntry: { id: 'textEntry', blocksBelow: true, swallowsKeys: true },
};

export class ContextStack {
  private readonly stack: InputContext[] = [CONTEXTS.gameplay];

  push(id: InputContextId): void {
    this.stack.push(CONTEXTS[id]);
  }

  /** Pops the topmost entry with this id. A no-op when it is not on the stack. */
  pop(id: InputContextId): void {
    for (let i = this.stack.length - 1; i > 0; i--) {
      if (this.stack[i]?.id === id) {
        this.stack.splice(i, 1);
        return;
      }
    }
  }

  top(): InputContext {
    return this.stack[this.stack.length - 1] ?? CONTEXTS.gameplay;
  }

  has(id: InputContextId): boolean {
    return this.stack.some((context) => context.id === id);
  }

  depth(): number {
    return this.stack.length;
  }

  /** Whether an event of this kind should reach gameplay at all. */
  reachesGameplay(kind: UiEvent['kind']): boolean {
    const top = this.top();
    if (top.id === 'gameplay') return true;
    if (kind === 'key' || kind === 'text') return !top.swallowsKeys;
    return !top.blocksBelow;
  }

  ids(): readonly InputContextId[] {
    return this.stack.map((context) => context.id);
  }
}
