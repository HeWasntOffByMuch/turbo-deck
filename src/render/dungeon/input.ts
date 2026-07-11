import type { DungeonInput } from '../../game/dungeon-session.js';
import type { ScreenPoint } from './view.js';

/**
 * Input capture for the dungeon mode (spec 027). Movement is held WASD/arrows;
 * aim follows the mouse from the player; attack is the held left mouse button (or
 * J); parry (Space) and dodge (Shift) are one-shot edges queued for a single
 * tick so a hold cannot auto-defend. It reports intent only — no game rules.
 */

const UP = new Set(['ArrowUp', 'KeyW']);
const DOWN = new Set(['ArrowDown', 'KeyS']);
const LEFT = new Set(['ArrowLeft', 'KeyA']);
const RIGHT = new Set(['ArrowRight', 'KeyD']);
const ATTACK_KEYS = new Set(['KeyJ']);

export class DungeonInputCapture {
  private readonly held = new Set<string>();
  private mouse: ScreenPoint = { x: 0, y: 0 };
  private mouseDown = false;
  private queuedParry = false;
  private queuedDodge = false;
  private queuedRestart = false;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    this.held.add(e.code);
    if (e.code === 'Space') this.queuedParry = true;
    else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.queuedDodge = true;
    else if (e.code === 'KeyR') this.queuedRestart = true;
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
    else if (e.button === 2) this.queuedDodge = true; // right-click dodges
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
    window.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  mouseScreen(): ScreenPoint {
    return this.mouse;
  }

  /** True once, then cleared: the player asked to restart (after death/completion). */
  takeRestart(): boolean {
    const r = this.queuedRestart;
    this.queuedRestart = false;
    return r;
  }

  /** Build one input frame; `playerScreen` converts the cursor into an aim vector. */
  sample(playerScreen: ScreenPoint): DungeonInput {
    let moveX: -1 | 0 | 1 = 0;
    if (this.heldAny(LEFT) && !this.heldAny(RIGHT)) moveX = -1;
    else if (this.heldAny(RIGHT) && !this.heldAny(LEFT)) moveX = 1;

    let moveY: -1 | 0 | 1 = 0;
    if (this.heldAny(UP) && !this.heldAny(DOWN)) moveY = -1;
    else if (this.heldAny(DOWN) && !this.heldAny(UP)) moveY = 1;

    let aimX = this.mouse.x - playerScreen.x;
    const aimY = this.mouse.y - playerScreen.y;
    if (aimX === 0 && aimY === 0) aimX = 1;

    const input: DungeonInput = {
      moveX,
      moveY,
      aimX,
      aimY,
      attack: this.mouseDown || this.heldAny(ATTACK_KEYS),
      parry: this.queuedParry,
      dodge: this.queuedDodge,
    };
    this.queuedParry = false;
    this.queuedDodge = false;
    return input;
  }

  private heldAny(codes: ReadonlySet<string>): boolean {
    for (const code of codes) if (this.held.has(code)) return true;
    return false;
  }
}
