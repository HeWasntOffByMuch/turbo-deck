import type { ScreenPoint } from '../input.js';

/**
 * Input capture for the map editor (spec 049).
 *
 * Deliberately not `IsoInputCapture`. That one speaks the game's language --
 * move orders, hand slots, waves -- and an editor shares none of it. What it does
 * share is the contract the tab shell relies on: `attach` on show, `detach` on
 * hide, and nothing captured in between.
 *
 * Reports intent only. Every rule about where the camera may end up lives in
 * `camera.ts`; this decides nothing but which buttons are down.
 */

/** Held keys that pan, as (forward, right) contributions. */
const PAN_KEYS: Record<string, readonly [forward: number, right: number]> = {
  KeyW: [1, 0],
  KeyS: [-1, 0],
  KeyA: [0, -1],
  KeyD: [0, 1],
  ArrowUp: [1, 0],
  ArrowDown: [-1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

/**
 * Buttons that orbit: right and middle.
 *
 * Not left, even though the camera is the only thing here to drag. Left-drag is
 * the brush from step 4 onward, and binding it to the camera now would mean
 * taking it away again the moment the first tool lands -- so the muscle memory is
 * set correctly from the start. This is also what every 3D editor does.
 */
const ORBIT_BUTTONS = new Set([1, 2]);

/** The button that paints. Reserved in spec 049, claimed by the brush in 050. */
const PAINT_BUTTON = 0;

export interface DragDelta {
  readonly dx: number;
  readonly dy: number;
}

export interface WheelDelta {
  readonly deltaY: number;
  readonly deltaMode: number;
}

export class EditorInputCapture {
  private readonly held = new Set<string>();
  private mouse: ScreenPoint = { x: 0, y: 0 };
  private orbiting = false;
  private painting = false;
  // Edges, so the view can open and close an undo entry exactly once per stroke
  // however the gesture ends.
  private paintStarted = false;
  private paintEnded = false;
  // Accumulated between frames rather than sampled, so a fast drag that produced
  // several pointer events in one frame turns the whole gesture and not its tail.
  private dragX = 0;
  private dragY = 0;
  private wheelY = 0;
  private wheelMode = 0;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!(e.code in PAN_KEYS)) return;
    this.held.add(e.code);
    // The arrows would otherwise scroll the page under the canvas.
    if (e.code.startsWith('Arrow')) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  /**
   * A key held while the window loses focus never sends its keyup, and the view
   * would pan forever. Anything that takes focus away releases everything.
   */
  private readonly onBlur = (): void => {
    this.held.clear();
    this.orbiting = false;
    // A stroke interrupted by losing focus still has to be closed, or its undo
    // entry stays open and the next stroke joins it.
    if (this.painting) this.paintEnded = true;
    this.painting = false;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (!this.orbiting) return;
    this.dragX += e.movementX;
    this.dragY += e.movementY;
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button === PAINT_BUTTON) {
      this.painting = true;
      this.paintStarted = true;
      this.canvas.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      return;
    }
    if (!ORBIT_BUTTONS.has(e.button)) return;
    this.orbiting = true;
    // Keeps the drag alive when the cursor leaves the canvas mid-gesture, which
    // it will constantly -- an orbit is a long sweep, not a nudge.
    this.canvas.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.button === PAINT_BUTTON) {
      if (this.painting) this.paintEnded = true;
      this.painting = false;
      this.canvas.releasePointerCapture?.(e.pointerId);
      return;
    }
    if (!ORBIT_BUTTONS.has(e.button)) return;
    this.orbiting = false;
    this.canvas.releasePointerCapture?.(e.pointerId);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    this.wheelY += e.deltaY;
    this.wheelMode = e.deltaMode;
    // The page behind the canvas must not scroll while zooming.
    e.preventDefault();
  };

  // Right-drag is the orbit, so the browser menu must not open on top of it.
  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private attached: Window | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(target: Window): void {
    if (this.attached) return;
    this.attached = target;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
    target.addEventListener('pointermove', this.onPointerMove);
    target.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  /** Release everything `attach` added, so a hidden editor captures nothing. */
  detach(): void {
    if (this.attached) {
      this.attached.removeEventListener('keydown', this.onKeyDown);
      this.attached.removeEventListener('keyup', this.onKeyUp);
      this.attached.removeEventListener('blur', this.onBlur);
      this.attached.removeEventListener('pointermove', this.onPointerMove);
      this.attached.removeEventListener('pointerup', this.onPointerUp);
      this.attached = null;
    }
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    // Switching tabs mid-gesture must not leave the camera turning.
    this.onBlur();
  }

  /** Cursor position in canvas CSS pixels. */
  mouseCanvas(): ScreenPoint {
    return this.mouse;
  }

  /** The pan axes the held keys add up to, each clamped to [-1, 1]. */
  panAxes(): { forward: number; right: number } {
    let forward = 0;
    let right = 0;
    for (const code of this.held) {
      const axis = PAN_KEYS[code];
      if (!axis) continue;
      forward += axis[0];
      right += axis[1];
    }
    // Opposite keys cancel; W and the up arrow together are still one unit.
    return {
      forward: Math.min(1, Math.max(-1, forward)),
      right: Math.min(1, Math.max(-1, right)),
    };
  }

  /** Consume the orbit drag accumulated since the last call. */
  takeDrag(): DragDelta {
    const drag = { dx: this.dragX, dy: this.dragY };
    this.dragX = 0;
    this.dragY = 0;
    return drag;
  }

  /** Consume the wheel scrolled since the last call. */
  takeWheel(): WheelDelta {
    const wheel = { deltaY: this.wheelY, deltaMode: this.wheelMode };
    this.wheelY = 0;
    return wheel;
  }

  /** Whether an orbit drag is in progress, for the cursor style. */
  get isOrbiting(): boolean {
    return this.orbiting;
  }

  /** Whether the paint button is held, i.e. whether a stroke should be applied. */
  get isPainting(): boolean {
    return this.painting;
  }

  /** Consume a "a stroke just began" edge. */
  takePaintStart(): boolean {
    const started = this.paintStarted;
    this.paintStarted = false;
    return started;
  }

  /** Consume a "a stroke just ended" edge, however it ended. */
  takePaintEnd(): boolean {
    const ended = this.paintEnded;
    this.paintEnded = false;
    return ended;
  }
}
