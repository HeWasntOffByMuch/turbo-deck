import { describe, expect, it } from 'vitest';
import { EditorInputCapture } from './input.js';

/**
 * Spec 049. The tab shell's whole contract with a view is `start`/`stop`, and the
 * half of it that actually bites is that a hidden view captures nothing -- a tab
 * still listening for W pans a scene nobody is looking at, and a key held while
 * focus moves away never sends its keyup at all.
 *
 * Driven through real `EventTarget`s with plain `Event`s carrying the fields the
 * handlers read, so no DOM implementation is needed: the capture only ever asks
 * an event for properties, never for behaviour.
 */

/** The bits of a canvas the capture touches. */
function fakeCanvas(): HTMLCanvasElement {
  const target = new EventTarget() as EventTarget & {
    getBoundingClientRect: () => { left: number; top: number };
    setPointerCapture: (id: number) => void;
    releasePointerCapture: (id: number) => void;
  };
  target.getBoundingClientRect = () => ({ left: 0, top: 0 });
  target.setPointerCapture = () => undefined;
  target.releasePointerCapture = () => undefined;
  return target as unknown as HTMLCanvasElement;
}

const win = (): Window => new EventTarget() as unknown as Window;

/** Dispatch an event of `type` carrying `fields`. */
function fire(target: EventTarget, type: string, fields: Record<string, unknown> = {}): void {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, fields);
  target.dispatchEvent(event);
}

interface Rig {
  readonly input: EditorInputCapture;
  readonly canvas: HTMLCanvasElement;
  readonly window: Window;
}

function attached(): Rig {
  const canvas = fakeCanvas();
  const window = win();
  const input = new EditorInputCapture(canvas);
  input.attach(window);
  return { input, canvas, window };
}

describe('pan keys', () => {
  it('reads held keys as axes and releases them on keyup', () => {
    const { input, window } = attached();
    expect(input.panAxes()).toEqual({ forward: 0, right: 0 });

    fire(window, 'keydown', { code: 'KeyW' });
    expect(input.panAxes()).toEqual({ forward: 1, right: 0 });
    fire(window, 'keydown', { code: 'KeyD' });
    expect(input.panAxes()).toEqual({ forward: 1, right: 1 });
    fire(window, 'keyup', { code: 'KeyW' });
    expect(input.panAxes()).toEqual({ forward: 0, right: 1 });
  });

  it('accepts the arrows as aliases, without doubling up', () => {
    const { input, window } = attached();
    fire(window, 'keydown', { code: 'KeyW' });
    fire(window, 'keydown', { code: 'ArrowUp' });
    expect(input.panAxes().forward).toBe(1);
  });

  it('cancels opposite keys', () => {
    const { input, window } = attached();
    fire(window, 'keydown', { code: 'KeyW' });
    fire(window, 'keydown', { code: 'KeyS' });
    expect(input.panAxes()).toEqual({ forward: 0, right: 0 });
  });

  it('ignores keys it does not own', () => {
    const { input, window } = attached();
    fire(window, 'keydown', { code: 'KeyQ' });
    fire(window, 'keydown', { code: 'Space' });
    expect(input.panAxes()).toEqual({ forward: 0, right: 0 });
  });

  it('releases everything when the window loses focus', () => {
    // Without this the view pans forever: a key held as focus moves away never
    // sends its keyup, so the capture would believe it is still down.
    const { input, window } = attached();
    fire(window, 'keydown', { code: 'KeyW' });
    fire(window, 'blur');
    expect(input.panAxes()).toEqual({ forward: 0, right: 0 });
  });
});

describe('orbit drag', () => {
  it('accumulates movement only while an orbit button is down', () => {
    const { input, canvas, window } = attached();
    fire(window, 'pointermove', { clientX: 10, clientY: 10, movementX: 5, movementY: 5 });
    expect(input.takeDrag()).toEqual({ dx: 0, dy: 0 });

    fire(canvas, 'pointerdown', { button: 2, pointerId: 1 });
    fire(window, 'pointermove', { clientX: 20, clientY: 14, movementX: 10, movementY: 4 });
    fire(window, 'pointermove', { clientX: 26, clientY: 15, movementX: 6, movementY: 1 });
    // Accumulated across both events, so a fast drag turns the whole gesture.
    expect(input.takeDrag()).toEqual({ dx: 16, dy: 5 });
    // ...and consumed, so the next frame starts from nothing.
    expect(input.takeDrag()).toEqual({ dx: 0, dy: 0 });
  });

  it('orbits on middle-drag too, but never on left', () => {
    const { input, canvas, window } = attached();
    fire(canvas, 'pointerdown', { button: 0, pointerId: 1 });
    fire(window, 'pointermove', { clientX: 1, clientY: 1, movementX: 9, movementY: 9 });
    // Left is reserved for the tools, so it must not move the camera.
    expect(input.takeDrag()).toEqual({ dx: 0, dy: 0 });
    expect(input.isOrbiting).toBe(false);

    fire(canvas, 'pointerdown', { button: 1, pointerId: 2 });
    expect(input.isOrbiting).toBe(true);
    fire(window, 'pointermove', { clientX: 2, clientY: 2, movementX: 3, movementY: -2 });
    expect(input.takeDrag()).toEqual({ dx: 3, dy: -2 });
  });

  it('stops on pointerup', () => {
    const { input, canvas, window } = attached();
    fire(canvas, 'pointerdown', { button: 2, pointerId: 1 });
    fire(window, 'pointerup', { button: 2, pointerId: 1 });
    expect(input.isOrbiting).toBe(false);
    fire(window, 'pointermove', { clientX: 3, clientY: 3, movementX: 7, movementY: 7 });
    expect(input.takeDrag()).toEqual({ dx: 0, dy: 0 });
  });

  it('tracks the cursor in canvas pixels whether dragging or not', () => {
    const { input, window } = attached();
    fire(window, 'pointermove', { clientX: 42, clientY: 17, movementX: 0, movementY: 0 });
    expect(input.mouseCanvas()).toEqual({ x: 42, y: 17 });
  });
});

describe('wheel', () => {
  it('accumulates and consumes the scroll, keeping the delta mode', () => {
    const { input, canvas } = attached();
    fire(canvas, 'wheel', { deltaY: -100, deltaMode: 0 });
    fire(canvas, 'wheel', { deltaY: -40, deltaMode: 0 });
    expect(input.takeWheel()).toEqual({ deltaY: -140, deltaMode: 0 });
    expect(input.takeWheel().deltaY).toBe(0);
  });

  it('passes a line-mode wheel through unchanged', () => {
    const { input, canvas } = attached();
    fire(canvas, 'wheel', { deltaY: 3, deltaMode: 1 });
    expect(input.takeWheel()).toEqual({ deltaY: 3, deltaMode: 1 });
  });
});

describe('attach and detach', () => {
  it('captures nothing once detached', () => {
    const { input, canvas, window } = attached();
    input.detach();

    fire(window, 'keydown', { code: 'KeyW' });
    fire(canvas, 'pointerdown', { button: 2, pointerId: 1 });
    fire(window, 'pointermove', { clientX: 5, clientY: 5, movementX: 20, movementY: 20 });
    fire(canvas, 'wheel', { deltaY: -100, deltaMode: 0 });

    expect(input.panAxes()).toEqual({ forward: 0, right: 0 });
    expect(input.takeDrag()).toEqual({ dx: 0, dy: 0 });
    expect(input.takeWheel().deltaY).toBe(0);
  });

  it('clears a held key and an in-flight drag on detach', () => {
    // Switching tabs mid-gesture must not leave the camera turning when the tab
    // comes back.
    const { input, canvas, window } = attached();
    fire(window, 'keydown', { code: 'KeyA' });
    fire(canvas, 'pointerdown', { button: 2, pointerId: 1 });
    input.detach();
    expect(input.panAxes()).toEqual({ forward: 0, right: 0 });
    expect(input.isOrbiting).toBe(false);
  });

  it('can be re-attached, as the shell does on every tab switch', () => {
    const { input, window } = attached();
    input.detach();
    input.attach(window);
    fire(window, 'keydown', { code: 'KeyS' });
    expect(input.panAxes().forward).toBe(-1);
  });

  it('does not double-subscribe if attached twice', () => {
    const { input, canvas, window } = attached();
    input.attach(window);
    fire(canvas, 'pointerdown', { button: 2, pointerId: 1 });
    fire(window, 'pointermove', { clientX: 0, clientY: 0, movementX: 4, movementY: 0 });
    // Two subscriptions would count the same movement twice.
    expect(input.takeDrag()).toEqual({ dx: 4, dy: 0 });
  });
});
