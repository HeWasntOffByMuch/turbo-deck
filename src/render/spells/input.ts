import type { SpellInput } from '../../game/spell-session.js';

/**
 * Input capture for the spell game (spec 018). Movement comes from held WASD;
 * aim is the mouse direction from the player; the world point under the cursor
 * is the target for aimed AOEs. Playing a card (1-4) and spawning a wave (Q) are
 * one-shot edges triggered by a key or a HUD click, funnelled through the queue
 * so the sim sees exactly one action per press. It reports intent only.
 */

const UP = new Set(['ArrowUp', 'KeyW']);
const DOWN = new Set(['ArrowDown', 'KeyS']);
const LEFT = new Set(['ArrowLeft', 'KeyA']);
const RIGHT = new Set(['ArrowRight', 'KeyD']);
const PLAY_KEYS: Record<string, 0 | 1 | 2 | 3> = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 };
const WAVE_KEY = 'KeyQ';

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export class SpellInputCapture {
  private readonly held = new Set<string>();
  private mouse: ScreenPoint = { x: 0, y: 0 };
  private queuedPlay: 0 | 1 | 2 | 3 | null = null;
  private queuedWave = false;
  private queuedReward: 0 | 1 | 2 | null = null;
  private queuedPick: number | null = null;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    this.held.add(e.code);
    const play = PLAY_KEYS[e.code];
    if (play !== undefined) this.queuePlay(play);
    else if (e.code === WAVE_KEY) this.queueWave();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  private readonly onClick = (): void => {
    // A left click plays the first (leftmost) available card, for mouse-only play.
    // The HUD handles per-slot clicks; this is a convenience only.
  };

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(target: Window): void {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('click', this.onClick);
  }

  /** HUD card buttons call this directly. */
  queuePlay(index: 0 | 1 | 2 | 3): void {
    this.queuedPlay = index;
  }
  queueWave(): void {
    this.queuedWave = true;
  }
  queueReward(index: 0 | 1 | 2): void {
    this.queuedReward = index;
  }
  queuePick(index: number): void {
    this.queuedPick = index;
  }

  mouseScreen(): ScreenPoint {
    return this.mouse;
  }

  /** Build one input frame. `playerScreen` and `scale` convert the cursor to aim + world target. */
  sample(playerScreen: ScreenPoint, scale: number): SpellInput {
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
    const reward = this.queuedReward;
    const pick = this.queuedPick;
    const input: SpellInput = {
      moveX,
      moveY,
      aimX,
      aimY,
      targetX: this.mouse.x / scale,
      targetY: this.mouse.y / scale,
      ...(play !== null ? { playHandIndex: play } : {}),
      ...(reward !== null ? { chooseReward: reward } : {}),
      ...(pick !== null ? { chooseCard: pick } : {}),
      ...(this.queuedWave ? { spawnWave: true } : {}),
    };

    this.queuedPlay = null;
    this.queuedReward = null;
    this.queuedPick = null;
    this.queuedWave = false;
    return input;
  }

  private heldAny(codes: ReadonlySet<string>): boolean {
    for (const code of codes) if (this.held.has(code)) return true;
    return false;
  }
}
