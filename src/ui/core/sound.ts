/**
 * Sound, as a name (spec 133).
 *
 * A widget emits an **id** into a sink it was handed. Nothing under `src/ui/`
 * learns what a sound is, allocates an audio context, or reads a clock to
 * schedule one -- which is the only way this survives the three rules the layer
 * lives by, and the only way the golden tests keep running in Node.
 *
 * The sink the game passes lives in `src/render/`, where the platform is. This
 * file ships the vocabulary, the interface and a recording sink for tests, and
 * deliberately ships nothing that makes noise: there are no audio files in this
 * repo, they are binary assets, and `docs/ui/00-architecture.md` §2.1 has a
 * settled opinion about binary assets that would have to be reopened first.
 *
 * The rule for *where* a sound is emitted: **at the intent, not the outcome.** A
 * drop plays when the drag lands, not when the server agrees, because the sound
 * is feedback about the gesture -- a click that made no noise until a round trip
 * later is a click that felt broken. The refusal has its own sound.
 */

/**
 * Every sound this interface can ask for.
 *
 * A closed union rather than a string, so a typo is a build error and so the set
 * is small enough to stay coherent. Seven is a lot for an interface; an eighth
 * should have to argue for itself.
 */
export type UiSoundId =
  /** A button, a tab, a checkbox: anything that took a press. */
  | 'ui.press'
  | 'ui.open'
  | 'ui.close'
  /** A refusal -- the server said no, or a rule did. */
  | 'ui.error'
  /** An item let go over a slot that took it. */
  | 'ui.drop'
  | 'ui.pickUp'
  /** Coins changing hands. */
  | 'ui.coin'
  /**
   * Something worn, or taken off (spec 229). The eighth, and the argument it
   * had to make:
   *
   * It is a **gesture of its own** -- shift+click on a cell, which the bag's own
   * table lists beside the four that take and place -- and it is the only one of
   * the five whose outcome is not "the item is somewhere else in this window".
   * Drawing it as `ui.drop` would say a sword went into a cell when it went onto
   * a body, and the two are told apart by every other channel the interface has.
   */
  | 'ui.equip';

export const UI_SOUNDS: readonly UiSoundId[] = [
  'ui.press',
  'ui.open',
  'ui.close',
  'ui.error',
  'ui.drop',
  'ui.pickUp',
  'ui.coin',
  'ui.equip',
];

export interface SoundSink {
  play(id: UiSoundId): void;
}

/**
 * A sink that does nothing, and the default everywhere.
 *
 * So that a widget can always emit without asking whether anybody is listening.
 * The alternative -- an optional sink and a `?.` at every call site -- is seven
 * chances to forget one, and the one that gets forgotten is always the error.
 */
export const SILENT: SoundSink = {
  play(): void {
    // Nothing. See above.
  },
};

/** A sink that remembers, so a test can assert what an interaction asked for. */
export class RecordingSink implements SoundSink {
  private readonly heard: UiSoundId[] = [];

  play(id: UiSoundId): void {
    this.heard.push(id);
  }

  get played(): readonly UiSoundId[] {
    return this.heard;
  }

  clear(): void {
    this.heard.length = 0;
  }
}
