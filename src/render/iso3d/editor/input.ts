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

/**
 * The button that orbits: right.
 *
 * Not left, even though the camera is the only thing here to drag. Left-drag is
 * the brush, and binding it to the camera would mean taking it away again the
 * moment a tool is armed. This is also what every 3D editor does.
 */
const ORBIT_BUTTON = 2;

/**
 * The button that tracks and dollies: middle (spec 056).
 *
 * It used to orbit alongside the right button, and moving the view was on WASD
 * -- the one set of keys the left hand is never on while the right hand is
 * painting. Reframing is now something the hand already holding the mouse can do
 * without letting go of the tool, which is why it is worth spending the middle
 * button on and why the keyboard pan is gone rather than kept as a second way.
 */
const TRACK_BUTTON = 1;

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
  private mouse: ScreenPoint = { x: 0, y: 0 };
  private orbiting = false;
  private tracking = false;
  private painting = false;
  // Edges, so the view can open and close an undo entry exactly once per stroke
  // however the gesture ends.
  private paintStarted = false;
  private paintEnded = false;
  // Accumulated between frames rather than sampled, so a fast drag that produced
  // several pointer events in one frame turns the whole gesture and not its tail.
  private orbitX = 0;
  private orbitY = 0;
  private trackX = 0;
  private trackY = 0;
  private wheelY = 0;
  private wheelMode = 0;

  /**
   * A gesture interrupted by the window losing focus never sends its pointerup,
   * and the view would keep turning. Anything that takes focus away releases
   * everything.
   */
  private readonly onBlur = (): void => {
    this.orbiting = false;
    this.tracking = false;
    // A stroke interrupted by losing focus still has to be closed, or its undo
    // entry stays open and the next stroke joins it.
    if (this.painting) this.paintEnded = true;
    this.painting = false;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (this.orbiting) {
      this.orbitX += e.movementX;
      this.orbitY += e.movementY;
    }
    if (this.tracking) {
      this.trackX += e.movementX;
      this.trackY += e.movementY;
    }
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button === PAINT_BUTTON) {
      this.painting = true;
      this.paintStarted = true;
      this.canvas.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button === ORBIT_BUTTON) this.orbiting = true;
    else if (e.button === TRACK_BUTTON) this.tracking = true;
    else return;
    // Keeps the drag alive when the cursor leaves the canvas mid-gesture, which
    // it will constantly -- moving the view is a long sweep, not a nudge.
    this.canvas.setPointerCapture?.(e.pointerId);
    // Also what stops the middle button opening the browser's autoscroll puck
    // in the middle of a track.
    e.preventDefault();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.button === PAINT_BUTTON) {
      if (this.painting) this.paintEnded = true;
      this.painting = false;
      this.canvas.releasePointerCapture?.(e.pointerId);
      return;
    }
    if (e.button === ORBIT_BUTTON) this.orbiting = false;
    else if (e.button === TRACK_BUTTON) this.tracking = false;
    else return;
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

  /** Consume the orbit drag (right button) accumulated since the last call. */
  takeOrbit(): DragDelta {
    const drag = { dx: this.orbitX, dy: this.orbitY };
    this.orbitX = 0;
    this.orbitY = 0;
    return drag;
  }

  /** Consume the track/dolly drag (middle button) since the last call. */
  takeTrack(): DragDelta {
    const drag = { dx: this.trackX, dy: this.trackY };
    this.trackX = 0;
    this.trackY = 0;
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

  /** Whether a track/dolly drag is in progress, for the cursor style. */
  get isTracking(): boolean {
    return this.tracking;
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
