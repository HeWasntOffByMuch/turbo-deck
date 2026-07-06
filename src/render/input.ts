import type { GameInput } from '../game/session.js';

const MOVE_LEFT_KEYS = new Set(['ArrowLeft', 'KeyA']);
const MOVE_RIGHT_KEYS = new Set(['ArrowRight', 'KeyD']);
const ATTACK_KEYS = new Set(['Space']);
const PARRY_KEYS = new Set(['KeyK']);
const DODGE_KEYS = new Set(['KeyL']);
const HAND_KEYS: Record<string, 0 | 1 | 2> = { Digit1: 0, Digit2: 1, Digit3: 2 };
const BONUS_KEY = 'KeyB';

/**
 * Tracks held keys and one-tick "just pressed" edges, and samples them into
 * a GameInput. This is the only place DOM keyboard events are read; it does
 * not decide what any input means for the game.
 */
export class InputCapture {
  private readonly held = new Set<string>();
  private readonly justPressed = new Set<string>();

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.held.has(e.code)) {
      this.justPressed.add(e.code);
    }
    this.held.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  attach(target: Window): void {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
  }

  detach(target: Window): void {
    target.removeEventListener('keydown', this.onKeyDown);
    target.removeEventListener('keyup', this.onKeyUp);
  }

  /** Sample the current input for one sim tick, then clear this tick's edges. */
  sample(): GameInput {
    let moveDir: -1 | 0 | 1 = 0;
    const left = this.heldAny(MOVE_LEFT_KEYS);
    const right = this.heldAny(MOVE_RIGHT_KEYS);
    if (left && !right) moveDir = -1;
    else if (right && !left) moveDir = 1;

    let playHandIndex: 0 | 1 | 2 | undefined;
    for (const [code, index] of Object.entries(HAND_KEYS)) {
      if (this.justPressed.has(code)) {
        playHandIndex = index;
        break;
      }
    }
    const playBonusCard = this.justPressed.has(BONUS_KEY);

    const input: GameInput = {
      moveDir,
      attack: this.heldAny(ATTACK_KEYS),
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
