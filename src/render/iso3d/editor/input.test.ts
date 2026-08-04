import { describe, expect, it } from 'vitest';
import { EditorInputCapture } from './input.js';

/**
 * Spec 049, rebound in 056. The tab shell's whole contract with a view is
 * `start`/`stop`, and the half of it that actually bites is that a hidden view
 * captures nothing -- a tab still listening moves a scene nobody is looking at,
 * and a button held while focus moves away never sends its pointerup at all.
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

describe('button assignment (spec 056)', () => {
  it('orbits on right-drag and never on middle or left', () => {
    const { input, canvas, window } = attached();
    fire(canvas, 'pointerdown', { button: 2, pointerId: 1 });
    expect(input.isOrbiting).toBe(true);
    fire(window, 'pointermove', { clientX: 2, clientY: 2, movementX: 3, movementY: -2 });
    expect(input.takeOrbit()).toEqual({ dx: 3, dy: -2 });
    // The same gesture must not also track: one button, one meaning.
    expect(input.takeTrack()).toEqual({ dx: 0, dy: 0 });
  });

  it('tracks on middle-drag and never orbits with it', () => {
    // The middle button used to orbit alongside the right one; it is the whole
    // navigation gesture now, so an orbit leaking out of it would fight the drag.
    const { input, canvas, window } = attached();
    fire(canvas, 'pointerdown', { button: 1, pointerId: 1 });
    expect(input.isTracking).toBe(true);
    expect(input.isOrbiting).toBe(false);
    fire(window, 'pointermove', { clientX: 2, clientY: 2, movementX: 8, movementY: 5 });
    expect(input.takeTrack()).toEqual({ dx: 8, dy: 5 });
    expect(input.takeOrbit()).toEqual({ dx: 0, dy: 0 });
  });

  it('leaves the left button to the tools', () => {
    const { input, canvas, window } = attached();
    fire(canvas, 'pointerdown', { button: 0, pointerId: 1 });
    fire(window, 'pointermove', { clientX: 1, clientY: 1, movementX: 9, movementY: 9 });
    expect(input.takeOrbit()).toEqual({ dx: 0, dy: 0 });
    expect(input.takeTrack()).toEqual({ dx: 0, dy: 0 });
    expect(input.isOrbiting).toBe(false);
    expect(input.isTracking).toBe(false);
    expect(input.isPainting).toBe(true);
  });

  it('ignores the keyboard entirely, now that nothing is bound to it', () => {
    const { input, window } = attached();
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp']) fire(window, 'keydown', { code });
    fire(window, 'pointermove', { clientX: 1, clientY: 1, movementX: 4, movementY: 4 });
    expect(input.takeTrack()).toEqual({ dx: 0, dy: 0 });
    expect(input.takeOrbit()).toEqual({ dx: 0, dy: 0 });
  });

  it('releases both drags when the window loses focus', () => {
    // Without this the view moves forever: a button held as focus moves away
    // never sends its pointerup, so the capture would believe it is still down.
    const { input, canvas, window } = attached();
    fire(canvas, 'pointerdown', { button: 1, pointerId: 1 });
    fire(canvas, 'pointerdown', { button: 2, pointerId: 2 });
    fire(window, 'blur');
    expect(input.isTracking).toBe(false);
    expect(input.isOrbiting).toBe(false);
  });
});

describe('orbit drag', () => {
  it('accumulates movement only while the orbit button is down', () => {
    const { input, canvas, window } = attached();
    fire(window, 'pointermove', { clientX: 10, clientY: 10, movementX: 5, movementY: 5 });
    expect(input.takeOrbit()).toEqual({ dx: 0, dy: 0 });

    fire(canvas, 'pointerdown', { button: 2, pointerId: 1 });
    fire(window, 'pointermove', { clientX: 20, clientY: 14, movementX: 10, movementY: 4 });
    fire(window, 'pointermove', { clientX: 26, clientY: 15, movementX: 6, movementY: 1 });
    // Accumulated across both events, so a fast drag turns the whole gesture.
    expect(input.takeOrbit()).toEqual({ dx: 16, dy: 5 });
    // ...and consumed, so the next frame starts from nothing.
    expect(input.takeOrbit()).toEqual({ dx: 0, dy: 0 });
  });

  it('stops on pointerup, for both gestures', () => {
    for (const button of [1, 2] as const) {
      const { input, canvas, window } = attached();
      fire(canvas, 'pointerdown', { button, pointerId: 1 });
      fire(window, 'pointerup', { button, pointerId: 1 });
      expect(input.isOrbiting).toBe(false);
      expect(input.isTracking).toBe(false);
      fire(window, 'pointermove', { clientX: 3, clientY: 3, movementX: 7, movementY: 7 });
      expect(input.takeOrbit()).toEqual({ dx: 0, dy: 0 });
      expect(input.takeTrack()).toEqual({ dx: 0, dy: 0 });
    }
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

    fire(canvas, 'pointerdown', { button: 2, pointerId: 1 });
    fire(canvas, 'pointerdown', { button: 1, pointerId: 2 });
    fire(window, 'pointermove', { clientX: 5, clientY: 5, movementX: 20, movementY: 20 });
    fire(canvas, 'wheel', { deltaY: -100, deltaMode: 0 });

    expect(input.takeOrbit()).toEqual({ dx: 0, dy: 0 });
    expect(input.takeTrack()).toEqual({ dx: 0, dy: 0 });
    expect(input.takeWheel().deltaY).toBe(0);
  });

  it('clears an in-flight drag on detach', () => {
    // Switching tabs mid-gesture must not leave the camera moving when the tab
    // comes back.
    const { input, canvas } = attached();
    fire(canvas, 'pointerdown', { button: 2, pointerId: 1 });
    fire(canvas, 'pointerdown', { button: 1, pointerId: 2 });
    input.detach();
    expect(input.isOrbiting).toBe(false);
    expect(input.isTracking).toBe(false);
  });

  it('can be re-attached, as the shell does on every tab switch', () => {
    const { input, canvas, window } = attached();
    input.detach();
    input.attach(window);
    fire(canvas, 'pointerdown', { button: 1, pointerId: 1 });
    fire(window, 'pointermove', { clientX: 0, clientY: 0, movementX: 6, movementY: 0 });
    expect(input.takeTrack()).toEqual({ dx: 6, dy: 0 });
  });

  it('does not double-subscribe if attached twice', () => {
    const { input, canvas, window } = attached();
    input.attach(window);
    fire(canvas, 'pointerdown', { button: 2, pointerId: 1 });
    fire(window, 'pointermove', { clientX: 0, clientY: 0, movementX: 4, movementY: 0 });
    // Two subscriptions would count the same movement twice.
    expect(input.takeOrbit()).toEqual({ dx: 4, dy: 0 });
  });
});
