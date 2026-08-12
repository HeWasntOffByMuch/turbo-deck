/**
 * Input capture for the sandbox tabs (spec 066).
 *
 * What is left of the deleted `input.ts` once the cards it mostly existed to
 * play are gone: a right-click move order to the world point under the cursor,
 * C to cycle the movement archetype, and J to hop. It reports intent only and
 * decides nothing.
 *
 * Screen->world is not done here. The scene owns the camera and raycasts the
 * cursor onto the ground, so {@link takeMoveOrder} is handed the already
 * projected world point by the caller that knows how to project it.
 *
 * The browser's context menu is suppressed across the canvas only: unlike the
 * game window, the sandbox panels sit *beside* the view and keep an ordinary
 * right-click.
 */

export const CYCLE_CHARACTER_KEY = 'KeyC';
/** Hop the robed figure or the critter (spec 046). Cosmetic; the mover never sees it. */
export const JUMP_KEY = 'KeyJ';
/**
 * Throw a swing (spec 140). Space, because it is the key a hand already rests
 * on and because nothing in this tab scrolls.
 */
export const ATTACK_KEY = 'Space';

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export class SandboxInput {
  private mouse: ScreenPoint = { x: 0, y: 0 };
  // Each of these is a discrete edge, consumed once by whoever takes it.
  private rightClicked = false;
  private queuedCycleCharacter = false;
  private queuedJump = false;
  private queuedAttack = false;
  private attached: Window | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === CYCLE_CHARACTER_KEY) this.queuedCycleCharacter = true;
    else if (e.code === JUMP_KEY) this.queuedJump = true;
    else if (e.code === ATTACK_KEY) {
      // Space scrolls a page by default, and this tab sits in a scrolling shell.
      e.preventDefault();
      this.queuedAttack = true;
    }
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

  attach(target: Window): void {
    this.attached = target;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  /** Release the listeners `attach` added, so a hidden view stops capturing input. */
  detach(): void {
    if (this.attached) {
      this.attached.removeEventListener('keydown', this.onKeyDown);
      this.attached.removeEventListener('mousemove', this.onMouseMove);
      this.attached = null;
    }
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }

  /** Cursor position in canvas CSS pixels, for the scene's screen->world raycast. */
  mouseCanvas(): ScreenPoint {
    return this.mouse;
  }

  /** Consume a pending right-click; true when this tick should issue a move order. */
  takeMoveOrder(): boolean {
    const clicked = this.rightClicked;
    this.rightClicked = false;
    return clicked;
  }

  /** Consume a pending C press. */
  takeCycleCharacter(): boolean {
    const cycled = this.queuedCycleCharacter;
    this.queuedCycleCharacter = false;
    return cycled;
  }

  /**
   * Consume a pending J press. Deliberately separate from the mover's input:
   * the mover has no notion of height, so the hop reaches the rig and nothing
   * else, and can decide no outcome.
   */
  takeJump(): boolean {
    const jumped = this.queuedJump;
    this.queuedJump = false;
    return jumped;
  }

  /**
   * Consume a pending swing (spec 140).
   *
   * Separate from the mover's input for the same reason the hop is: the mover
   * has no notion of an attack, so this reaches the rig and the rehearsal and
   * nothing else, and can decide no outcome.
   */
  takeAttack(): boolean {
    const swung = this.queuedAttack;
    this.queuedAttack = false;
    return swung;
  }

  /** Raise a swing from something that is not a key -- the panel's button. */
  queueAttack(): void {
    this.queuedAttack = true;
  }
}
