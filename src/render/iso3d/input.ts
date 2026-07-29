import type { ComboInput } from '../../game/combo-session.js';

/**
 * Keyboard input for the isometric prototype (spec 018). Movement is WASD /
 * arrows over the sim's world axes; aim is simply the last direction you moved,
 * so attacks fire where the hero faces -- no mouse needed for this slice. It
 * reports intent only and decides no game outcome. Card-economy edges (play a
 * slot, activate, spawn a wave) are one-shot, matching the combo prototype.
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

export class IsoInputCapture {
  private readonly held = new Set<string>();
  private queuedPlay: 0 | 1 | 2 | 3 | null = null;
  private queuedActivate = false;
  private queuedWave = false;
  // Persisted facing so a standing hero keeps aiming where they last moved.
  private aimX = 1;
  private aimY = 0;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    this.held.add(e.code);
    const play = PLAY_KEYS[e.code];
    if (play !== undefined) this.queuedPlay = play;
    else if (e.code === ACTIVATE_KEY) this.queuedActivate = true;
    else if (e.code === WAVE_KEY) this.queuedWave = true;
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  attach(target: Window): void {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
  }

  sample(): ComboInput {
    let moveX: -1 | 0 | 1 = 0;
    if (this.heldAny(LEFT) && !this.heldAny(RIGHT)) moveX = -1;
    else if (this.heldAny(RIGHT) && !this.heldAny(LEFT)) moveX = 1;

    let moveY: -1 | 0 | 1 = 0;
    if (this.heldAny(UP) && !this.heldAny(DOWN)) moveY = -1;
    else if (this.heldAny(DOWN) && !this.heldAny(UP)) moveY = 1;

    if (moveX !== 0 || moveY !== 0) {
      this.aimX = moveX;
      this.aimY = moveY;
    }

    const play = this.queuedPlay;
    const input: ComboInput = {
      moveX,
      moveY,
      attack: this.heldAny(ATTACK),
      aimX: this.aimX,
      aimY: this.aimY,
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
