import type { SpellInput } from '../../game/spell-session.js';
import type { Vec2 } from '../../sim/types.js';

/**
 * Input capture for the isometric renderer (spec 031), matching the 2D spell
 * game's MOBA scheme (spec 028): movement is a right-click move order to the
 * world point under the cursor -- no held-button movement -- and holding shift
 * while right-clicking queues the destination behind the standing order instead
 * of replacing it (spec 040). The cursor world point is the aim/target for cards
 * (a dash fires toward it). The hand is played with Q/W/E/R (spec 041), C cycles
 * the movement character, and Space summons a wave. It reports intent only and
 * decides no game outcome.
 *
 * Screen->world is not done here: the scene owns the fixed camera and raycasts
 * the cursor onto the ground, so `sample` is handed the already-projected world
 * cursor and the player's world position each tick.
 *
 * Because right-click is a game command, the browser's context menu is suppressed
 * across `contextMenuRoot` -- the whole game window, not merely the canvas, once
 * a HUD floats over the play area.
 */

/**
 * Hand slot per key (spec 041): the four slots sit under the left hand on
 * Q/W/E/R, with the digits kept as aliases for anyone used to them.
 */
export const HAND_KEYS: Record<string, 0 | 1 | 2 | 3> = {
  KeyQ: 0,
  KeyW: 1,
  KeyE: 2,
  KeyR: 3,
  Digit1: 0,
  Digit2: 1,
  Digit3: 2,
  Digit4: 3,
};
/** Summon the next wave. Moved off Q when the hand took it (spec 041). */
export const WAVE_KEY = 'Space';
export const CYCLE_CHARACTER_KEY = 'KeyC';

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface IsoInputOptions {
  /**
   * Element across whose subtree the browser's context menu is suppressed.
   * Defaults to the canvas, which is right for the sandbox tabs: their panels
   * sit *beside* the view and keep an ordinary right-click.
   *
   * The fullscreen game window passes the document element instead. There the
   * game is the whole viewport and every control -- the hand, the wave button,
   * the stat buttons, the settings cog, the tab bar -- floats *on top of* the
   * play area, so a right-click that lands on one never reaches the canvas and
   * the browser menu opens over the game. Queueing a route with shift+right-click
   * (spec 040) walks the cursor across exactly those corners, which is where it
   * bites. Suppression is released again on `detach()`, so switching to a
   * sandbox tab gives the page its right-click back.
   */
  readonly contextMenuRoot?: HTMLElement;
}

export class IsoInputCapture {
  private mouse: ScreenPoint = { x: 0, y: 0 };
  // A right-click move order is a discrete edge, consumed once by sample().
  private rightClicked = false;
  // Whether that right-click was shifted (a queued order rather than a fresh one).
  private rightClickQueued = false;
  // A left-click basic-attack edge (played toward the cursor), consumed once.
  private leftClicked = false;
  private queuedCycleCharacter = false;
  private queuedPlay: 0 | 1 | 2 | 3 | null = null;
  private queuedWave = false;
  private queuedStat: 'strength' | 'agility' | 'intelligence' | null = null;
  private queuedReward: 0 | 1 | 2 | null = null;
  private queuedPick: number | null = null;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const play = HAND_KEYS[e.code];
    if (play !== undefined) this.queuedPlay = play;
    else if (e.code === WAVE_KEY) {
      this.queuedWave = true;
      e.preventDefault(); // Space would otherwise scroll the page
    } else if (e.code === CYCLE_CHARACTER_KEY) this.queuedCycleCharacter = true;
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 2) {
      this.rightClicked = true;
      this.rightClickQueued = e.shiftKey;
    } else if (e.button === 0) this.leftClicked = true;
  };

  // Right-click is the move command, so suppress the browser context menu.
  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private attached: Window | null = null;
  /** Subtree the context menu is suppressed across; see {@link IsoInputOptions}. */
  private readonly contextMenuRoot: HTMLElement;

  constructor(private readonly canvas: HTMLCanvasElement, opts: IsoInputOptions = {}) {
    this.contextMenuRoot = opts.contextMenuRoot ?? canvas;
  }

  attach(target: Window): void {
    this.attached = target;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.contextMenuRoot.addEventListener('contextmenu', this.onContextMenu);
  }

  /** Release the listeners `attach` added, so a hidden view stops capturing input. */
  detach(): void {
    if (this.attached) {
      this.attached.removeEventListener('keydown', this.onKeyDown);
      this.attached.removeEventListener('mousemove', this.onMouseMove);
      this.attached = null;
    }
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.contextMenuRoot.removeEventListener('contextmenu', this.onContextMenu);
  }

  /** Cursor position in canvas CSS pixels, for the scene's screen->world raycast. */
  mouseCanvas(): ScreenPoint {
    return this.mouse;
  }

  // --- Queued from the HUD's buttons (spec 041); each is consumed by one sample. ---
  queuePlay(slot: 0 | 1 | 2 | 3): void {
    this.queuedPlay = slot;
  }
  queueWave(): void {
    this.queuedWave = true;
  }
  queueCycleCharacter(): void {
    this.queuedCycleCharacter = true;
  }
  queueAllocate(stat: 'strength' | 'agility' | 'intelligence'): void {
    this.queuedStat = stat;
  }
  queueReward(index: 0 | 1 | 2): void {
    this.queuedReward = index;
  }
  queuePick(index: number): void {
    this.queuedPick = index;
  }

  /**
   * Build one input frame from the world cursor (raycast by the scene) and
   * player position. `attackSlot` is the hand slot holding a basic `attack` card
   * (or null if none) so a left-click can fire a basic attack toward the cursor;
   * a queued key/HUD card play takes precedence over the left-click.
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
      ...(this.rightClicked && this.rightClickQueued ? { queueMove: true } : {}),
      ...(this.queuedCycleCharacter ? { cycleCharacter: true } : {}),
      ...(play !== null ? { playHandIndex: play } : {}),
      ...(this.queuedWave ? { spawnWave: true } : {}),
      ...(this.queuedStat ? { allocateStat: this.queuedStat } : {}),
      ...(this.queuedReward !== null ? { chooseReward: this.queuedReward } : {}),
      ...(this.queuedPick !== null ? { chooseCard: this.queuedPick } : {}),
    };

    this.queuedPlay = null;
    this.queuedWave = false;
    this.rightClicked = false;
    this.rightClickQueued = false;
    this.leftClicked = false;
    this.queuedCycleCharacter = false;
    this.queuedStat = null;
    this.queuedReward = null;
    this.queuedPick = null;
    return input;
  }
}
