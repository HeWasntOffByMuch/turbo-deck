import type { SpellInput } from '../../game/spell-session.js';
import type { Vec2 } from '../../sim/types.js';

/**
 * Input capture for the spell game (spec 018). Movement is a MOBA move order:
 * right-click sends the hero to that world point (spec 028). Aim is the mouse
 * direction from the player; the world point under the cursor is the target for
 * aimed AOEs. Playing a card (1-4) and spawning a wave (Q) are one-shot edges
 * triggered by a key or a HUD click, funnelled through the queue so the sim sees
 * exactly one action per press. It reports intent only.
 */

const PLAY_KEYS: Record<string, 0 | 1 | 2 | 3> = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 };
const WAVE_KEY = 'KeyQ';
const CYCLE_CHARACTER_KEY = 'KeyC';

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export class SpellInputCapture {
  private readonly held = new Set<string>();
  private mouse: ScreenPoint = { x: 0, y: 0 };
  // A right-click move order is a discrete edge, consumed once by sample().
  private rightClicked = false;
  // Character-swap edge (press C), consumed once by sample().
  private queuedCycleCharacter = false;
  private queuedPlay: 0 | 1 | 2 | 3 | null = null;
  private queuedWave = false;
  private queuedReward: 0 | 1 | 2 | null = null;
  private queuedPick: number | null = null;
  private queuedAllocate: 'strength' | 'agility' | 'intelligence' | null = null;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    this.held.add(e.code);
    const play = PLAY_KEYS[e.code];
    if (play !== undefined) this.queuePlay(play);
    else if (e.code === WAVE_KEY) this.queueWave();
    else if (e.code === CYCLE_CHARACTER_KEY) this.queuedCycleCharacter = true;
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 2) this.rightClicked = true;
  };

  // Right-click is the move command, so suppress the browser context menu.
  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(target: Window): void {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
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
  queueCycleCharacter(): void {
    this.queuedCycleCharacter = true;
  }
  queueAllocate(stat: 'strength' | 'agility' | 'intelligence'): void {
    this.queuedAllocate = stat;
  }

  mouseScreen(): ScreenPoint {
    return this.mouse;
  }

  /** Build one input frame. `playerScreen` and `scale` convert the cursor to aim + world target. */
  sample(playerScreen: ScreenPoint, scale: number): SpellInput {
    let aimX = this.mouse.x - playerScreen.x;
    const aimY = this.mouse.y - playerScreen.y;
    if (aimX === 0 && aimY === 0) aimX = 1;

    const worldCursor: Vec2 = { x: this.mouse.x / scale, y: this.mouse.y / scale };
    const play = this.queuedPlay;
    const reward = this.queuedReward;
    const pick = this.queuedPick;
    const allocate = this.queuedAllocate;
    const input: SpellInput = {
      aimX,
      aimY,
      targetX: worldCursor.x,
      targetY: worldCursor.y,
      ...(this.rightClicked ? { moveTarget: worldCursor } : {}),
      ...(this.queuedCycleCharacter ? { cycleCharacter: true } : {}),
      ...(allocate !== null ? { allocateStat: allocate } : {}),
      ...(play !== null ? { playHandIndex: play } : {}),
      ...(reward !== null ? { chooseReward: reward } : {}),
      ...(pick !== null ? { chooseCard: pick } : {}),
      ...(this.queuedWave ? { spawnWave: true } : {}),
    };

    this.queuedPlay = null;
    this.queuedReward = null;
    this.queuedPick = null;
    this.queuedWave = false;
    this.rightClicked = false;
    this.queuedCycleCharacter = false;
    this.queuedAllocate = null;
    return input;
  }
}
