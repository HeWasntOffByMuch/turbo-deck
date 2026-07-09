import type { ComboInput } from '../../game/combo-session.js';

/**
 * Input capture for the prototype. Movement/attack/aim come from keyboard +
 * mouse held state; the card economy actions (play a slot, activate, spawn a
 * wave) are one-shot edges that can be triggered *either* by a key or by a
 * click on the DOM HUD button -- both funnel through the queue methods so the
 * sim sees exactly one action per press. It reports intent only; it decides no
 * game outcome.
 */

const UP = new Set(['ArrowUp', 'KeyW']);
const DOWN = new Set(['ArrowDown', 'KeyS']);
const LEFT = new Set(['ArrowLeft', 'KeyA']);
const RIGHT = new Set(['ArrowRight', 'KeyD']);
const ATTACK = new Set(['Space']);
const PARRY = new Set(['KeyK']);
const DODGE = new Set(['KeyL']);
const PLAY_KEYS: Record<string, 0 | 1 | 2 | 3> = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 };
const ACTIVATE_KEY = 'KeyE';
const WAVE_KEY = 'KeyQ';

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export class ComboInputCapture {
  private readonly held = new Set<string>();
  private mouse: ScreenPoint = { x: 0, y: 0 };
  private mouseDown = false;
  private queuedPlay: 0 | 1 | 2 | 3 | null = null;
  private queuedActivate = false;
  private queuedWave = false;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Don't scroll the page on space / arrows while playing.
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    this.held.add(e.code);
    const play = PLAY_KEYS[e.code];
    if (play !== undefined) this.queuePlay(play);
    else if (e.code === ACTIVATE_KEY) this.queueActivate();
    else if (e.code === WAVE_KEY) this.queueWave();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseDown = true;
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseDown = false;
  };

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(target: Window): void {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    target.addEventListener('mouseup', this.onMouseUp);
  }

  // --- HUD buttons call these directly. ---
  queuePlay(index: 0 | 1 | 2 | 3): void {
    this.queuedPlay = index;
  }
  queueActivate(): void {
    this.queuedActivate = true;
  }
  queueWave(): void {
    this.queuedWave = true;
  }

  mouseScreen(): ScreenPoint {
    return this.mouse;
  }

  sample(playerScreen: ScreenPoint): ComboInput {
    let moveX: -1 | 0 | 1 = 0;
    if (this.heldAny(LEFT) && !this.heldAny(RIGHT)) moveX = -1;
    else if (this.heldAny(RIGHT) && !this.heldAny(LEFT)) moveX = 1;

    let moveY: -1 | 0 | 1 = 0;
    if (this.heldAny(UP) && !this.heldAny(DOWN)) moveY = -1;
    else if (this.heldAny(DOWN) && !this.heldAny(UP)) moveY = 1;

    let aimX = this.mouse.x - playerScreen.x;
    const aimY = this.mouse.y - playerScreen.y;
    if (aimX === 0 && aimY === 0) aimX = 1;

    const play = this.queuedPlay;
    const input: ComboInput = {
      moveX,
      moveY,
      attack: this.mouseDown || this.heldAny(ATTACK),
      aimX,
      aimY,
      parry: this.heldAny(PARRY),
      dodge: this.heldAny(DODGE),
      ...(play !== null ? { playHandIndex: play } : {}),
      ...(this.queuedActivate ? { activate: true } : {}),
      ...(this.queuedWave ? { spawnWave: true } : {}),
    };

    this.queuedPlay = null;
    this.queuedActivate = false;
    this.queuedWave = false;
    return input;
  }

  private heldAny(codes: ReadonlySet<string>): boolean {
    for (const code of codes) if (this.held.has(code)) return true;
    return false;
  }
}
