import type { GameInput } from '../game/session.js';

const MOVE_UP_KEYS = new Set(['ArrowUp', 'KeyW']);
const MOVE_DOWN_KEYS = new Set(['ArrowDown', 'KeyS']);
const MOVE_LEFT_KEYS = new Set(['ArrowLeft', 'KeyA']);
const MOVE_RIGHT_KEYS = new Set(['ArrowRight', 'KeyD']);
const ATTACK_KEYS = new Set(['Space']);
const PARRY_KEYS = new Set(['KeyK']);
const DODGE_KEYS = new Set(['KeyL']);
const HAND_KEYS: Record<string, 0 | 1 | 2> = { Digit1: 0, Digit2: 1, Digit3: 2 };
const BONUS_KEY = 'KeyB';

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Tracks held keys, one-tick "just pressed" edges, and the mouse (position +
 * left button), and samples them into a GameInput. This is the only place DOM
 * keyboard/mouse events are read; it does not decide what any input means for
 * the game — it just reports directions and button states.
 */
export class InputCapture {
  private readonly held = new Set<string>();
  private readonly justPressed = new Set<string>();
  private mouse: ScreenPoint = { x: 0, y: 0 };
  private mouseDown = false;
  private canvas: HTMLCanvasElement | undefined;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.held.has(e.code)) this.justPressed.add(e.code);
    this.held.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseDown = true;
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseDown = false;
  };

  attach(target: Window, canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('mousemove', this.onMouseMove);
    target.addEventListener('mousedown', this.onMouseDown);
    target.addEventListener('mouseup', this.onMouseUp);
  }

  detach(target: Window): void {
    target.removeEventListener('keydown', this.onKeyDown);
    target.removeEventListener('keyup', this.onKeyUp);
    target.removeEventListener('mousemove', this.onMouseMove);
    target.removeEventListener('mousedown', this.onMouseDown);
    target.removeEventListener('mouseup', this.onMouseUp);
  }

  /** Latest mouse position in canvas-local pixels. */
  mouseScreen(): ScreenPoint {
    return this.mouse;
  }

  /**
   * Sample the current input for one sim tick. Aim points from the player's
   * on-screen position toward the mouse; because world->screen is a uniform,
   * non-flipping transform, this screen-space direction equals the world-space
   * aim direction the sim needs.
   */
  sample(playerScreen: ScreenPoint): GameInput {
    let moveX: -1 | 0 | 1 = 0;
    if (this.heldAny(MOVE_LEFT_KEYS) && !this.heldAny(MOVE_RIGHT_KEYS)) moveX = -1;
    else if (this.heldAny(MOVE_RIGHT_KEYS) && !this.heldAny(MOVE_LEFT_KEYS)) moveX = 1;

    let moveY: -1 | 0 | 1 = 0;
    if (this.heldAny(MOVE_UP_KEYS) && !this.heldAny(MOVE_DOWN_KEYS)) moveY = -1;
    else if (this.heldAny(MOVE_DOWN_KEYS) && !this.heldAny(MOVE_UP_KEYS)) moveY = 1;

    let playHandIndex: 0 | 1 | 2 | undefined;
    for (const [code, index] of Object.entries(HAND_KEYS)) {
      if (this.justPressed.has(code)) {
        playHandIndex = index;
        break;
      }
    }
    const playBonusCard = this.justPressed.has(BONUS_KEY);

    const aimY = this.mouse.y - playerScreen.y;
    let aimX = this.mouse.x - playerScreen.x;
    if (aimX === 0 && aimY === 0) aimX = 1; // avoid a zero-length aim

    const input: GameInput = {
      moveX,
      moveY,
      attack: this.mouseDown || this.heldAny(ATTACK_KEYS),
      aimX,
      aimY,
      parry: this.heldAny(PARRY_KEYS),
      dodge: this.heldAny(DODGE_KEYS),
      ...(playHandIndex !== undefined ? { playHandIndex } : {}),
      ...(playBonusCard ? { playBonusCard } : {}),
    };

    this.justPressed.clear();
    return input;
  }

  private heldAny(codes: ReadonlySet<string>): boolean {
    for (const code of codes) {
      if (this.held.has(code)) return true;
    }
    return false;
  }
}
