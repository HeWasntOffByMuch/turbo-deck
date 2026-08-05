/**
 * What the tab shell needs from anything it mounts (spec 062).
 *
 * Lifted out of the movement sandbox when that was deleted along with the card
 * game: the contract outlived the module it happened to live in, and the editor
 * and the play view both implement it.
 */
export interface ViewHandle {
  readonly element: HTMLElement;
  start(): void;
  stop(): void;
}
