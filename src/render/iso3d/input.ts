import type { SpellInput } from '../../game/spell-session.js';
import type { Vec2 } from '../../sim/types.js';

/**
 * Input capture for the isometric renderer (spec 031), matching the 2D spell
 * game's MOBA scheme (spec 028): movement is a right-click move order to the
 * world point under the cursor -- no held-button movement. The cursor world
 * point is the aim/target for cards (a dash fires toward it). C cycles the
 * movement character, Q spawns a wave, 1-4 play cards. It reports intent only
 * and decides no game outcome.
 *
 * Screen->world is not done here: the scene owns the fixed camera and raycasts
 * the cursor onto the ground, so `sample` is handed the already-projected world
 * cursor and the player's world position each tick.
 */

const PLAY_KEYS: Record<string, 0 | 1 | 2 | 3> = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 };
const WAVE_KEY = 'KeyQ';
const CYCLE_CHARACTER_KEY = 'KeyC';

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export class IsoInputCapture {
  private mouse: ScreenPoint = { x: 0, y: 0 };
  // A right-click move order is a discrete edge, consumed once by sample().
  private rightClicked = false;
  // A left-click basic-attack edge (played toward the cursor), consumed once.
  private leftClicked = false;
  private queuedCycleCharacter = false;
  private queuedPlay: 0 | 1 | 2 | 3 | null = null;
  private queuedWave = false;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const play = PLAY_KEYS[e.code];
    if (play !== undefined) this.queuedPlay = play;
    else if (e.code === WAVE_KEY) this.queuedWave = true;
    else if (e.code === CYCLE_CHARACTER_KEY) this.queuedCycleCharacter = true;
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 2) this.rightClicked = true;
    else if (e.button === 0) this.leftClicked = true;
  };

  // Right-click is the move command, so suppress the browser context menu.
  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(target: Window): void {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  /** Cursor position in canvas CSS pixels, for the scene's screen->world raycast. */
  mouseCanvas(): ScreenPoint {
    return this.mouse;
  }

  /**
   * Build one input frame from the world cursor (raycast by the scene) and
   * player position. `attackSlot` is the hand slot holding a basic `attack` card
   * (or null if none) so a left-click can fire a basic attack toward the cursor;
   * a queued number-key card play takes precedence over the left-click.
   */
  sample(worldCursor: Vec2, playerPos: Vec2, attackSlot: 0 | 1 | 2 | 3 | null): SpellInput {
    let aimX = worldCursor.x - playerPos.x;
    const aimY = worldCursor.y - playerPos.y;
    if (aimX === 0 && aimY === 0) aimX = 1;

    const play = this.queuedPlay ?? (this.leftClicked ? attackSlot : null);
    const input: SpellInput = {
      aimX,
      aimY,
      targetX: worldCursor.x,
      targetY: worldCursor.y,
      ...(this.rightClicked ? { moveTarget: worldCursor } : {}),
      ...(this.queuedCycleCharacter ? { cycleCharacter: true } : {}),
      ...(play !== null ? { playHandIndex: play } : {}),
      ...(this.queuedWave ? { spawnWave: true } : {}),
    };

    this.queuedPlay = null;
    this.queuedWave = false;
    this.rightClicked = false;
    this.leftClicked = false;
    this.queuedCycleCharacter = false;
    return input;
  }
}
