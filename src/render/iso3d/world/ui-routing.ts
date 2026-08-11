/**
 * Who gets an input, once the interface has been offered it (spec 131).
 *
 * Two questions, and conflating them is the bug this file exists to prevent.
 *
 * **Consumed** means a widget handled it: a click landed on a button, a focused
 * field took a key. **Blocked** means something above gameplay is swallowing
 * that *kind* of event -- a modal is up, or a text field has pushed `textEntry`
 * -- whether or not anything actually handled this one.
 *
 * A single boolean gets the second case wrong, and the symptom is specific and
 * awful: a player clicks just beside a confirmation dialog, nothing consumes the
 * click because it landed on empty space, and the character walks across the map
 * while a question about selling their sword is still on screen.
 *
 * Pure, so the ordering that decides whether the game hears you is checked in
 * Node rather than by clicking around a browser.
 */

/** What the UI reported about one event. */
export interface Routing {
  /** A widget handled it. */
  readonly consumed: boolean;
  /** A context above gameplay swallows this kind, handled or not. */
  readonly blocked: boolean;
}

/**
 * Whether the gameplay handler should run.
 *
 * The order is deliberate: consumption is checked first because it is the common
 * case, and blocking second because it is the one that is easy to forget.
 */
export function reachesGameplay(routing: Routing): boolean {
  if (routing.consumed) return false;
  return !routing.blocked;
}

/**
 * What Escape means, in the order the phases built it.
 *
 * Four things can want it, and each already reports whether it acted:
 *
 *  1. a drag in flight puts the item back (spec 127),
 *  2. a dialog dismisses without answering (spec 130),
 *  3. the topmost window closes (spec 124),
 *  4. gameplay withdraws from a cast (spec 065).
 *
 * Written as a list of thunks rather than as four nested ifs, because the *order*
 * is the rule and a list makes it something a test can read back. Returns whether
 * anything above gameplay took it -- so the caller's last step is simply "if not,
 * cancel the cast".
 */
export function escapeTaken(steps: readonly (() => boolean)[]): boolean {
  for (const step of steps) {
    if (step()) return true;
  }
  return false;
}
