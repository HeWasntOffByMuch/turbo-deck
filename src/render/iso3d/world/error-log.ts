/**
 * The stack of refusals in the corner of the frame (spec 143).
 * Pure -- no three.js, no DOM.
 *
 * What this replaces was one shared line at the top of the screen: a second
 * refusal overwrote the first, and it was cleared by counting 120 frames, so how
 * long a warning stayed on screen was a property of the machine reading it.
 * Here a message is a line of its own, it lives for a number of *milliseconds*,
 * and the caller draws them down a column anchored at its bottom so the newest
 * is the bottom line and the older ones are pushed up.
 *
 * `hud.ts` owns the elements and nothing else; every judgement about lifetime,
 * coalescing, order and fade lives here, where a test can reach it.
 */

/** How long a message stays on screen, from the moment it was last said. */
export const MESSAGE_LIFE_MS = 3500;

/** The tail of that life spent fading out. */
export const MESSAGE_FADE_MS = 700;

/**
 * How many lines the stack may hold.
 *
 * Five is what a corner can carry without becoming the screen. Repeats coalesce,
 * so filling it takes five *different* refusals inside three and a half seconds
 * -- which is a player pressing everything at once, and the oldest of them is
 * the one they have already read.
 */
export const MESSAGE_CAPACITY = 5;

/** One line of the stack, as it should be drawn this frame. */
export interface ErrorLine {
  readonly id: number;
  /** What to draw, the repeat count already folded in. */
  readonly text: string;
  readonly opacity: number;
}

export interface ErrorStep {
  /**
   * Oldest first. The caller appends in this order down a column whose bottom
   * is pinned, so the newest message is the bottom line.
   */
  readonly live: readonly ErrorLine[];
  /** Ids whose element the caller should now delete. Reported exactly once. */
  readonly expired: readonly number[];
}

interface Entry {
  readonly id: number;
  /** The message without its count. What a repeat is matched against. */
  readonly text: string;
  count: number;
  /**
   * When it was last said, or null for one added before the log has ever been
   * stepped -- the next step stamps it. See {@link ErrorLog.add}.
   */
  stampedAt: number | null;
}

export class ErrorLog {
  private readonly entries: Entry[] = [];
  private nextId = 1;
  /** The last time this log was stepped, which is what {@link add} stamps with. */
  private now: number | null = null;

  /**
   * Say something.
   *
   * **No timestamp, on purpose.** A refusal arrives on a network callback,
   * outside the frame loop, and the two honest options are to hand this module a
   * clock or to stamp with the last frame's time. It stamps: a frame is at most
   * a few milliseconds of error against a three-and-a-half second life, and a
   * second clock in here would be the one thing that makes the module impure.
   *
   * Before the first {@link step} there is no last frame, so the entry is left
   * unstamped and the first step claims it. Without that, a page whose
   * `requestAnimationFrame` timestamps start in the thousands would open with a
   * message that had already expired.
   *
   * An identical text already on screen has its count bumped and its clock
   * reset instead of taking a second line -- auto-attack refuses once a tick
   * while a swing is cooling, and sixty lines a second is not a warning. It
   * keeps its place in the column: a line that jumped to the bottom every time
   * it repeated would be the busiest thing on the screen.
   *
   * Returns the id to hang an element on, plus any ids evicted to stay under
   * capacity, so the caller never orphans one.
   */
  add(text: string): { readonly id: number; readonly expired: readonly number[] } {
    // Uppercased here rather than at the call site because the face this is
    // drawn in has one case (spec 143), and a caller that forgot would get a row
    // of solid blocks -- the font's fallback -- instead of a word.
    const normalized = text.trim().toUpperCase();

    const repeat = this.entries.find((entry) => entry.text === normalized);
    if (repeat) {
      repeat.count += 1;
      repeat.stampedAt = this.now;
      return { id: repeat.id, expired: [] };
    }

    const id = this.nextId++;
    this.entries.push({ id, text: normalized, count: 1, stampedAt: this.now });

    const expired: number[] = [];
    while (this.entries.length > MESSAGE_CAPACITY) {
      const dropped = this.entries.shift();
      if (dropped) expired.push(dropped.id);
    }
    return { id, expired };
  }

  /** Advance to `nowMs` and lay out every message still alive. */
  step(nowMs: number): ErrorStep {
    this.now = nowMs;

    const live: ErrorLine[] = [];
    const expired: number[] = [];

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (!entry) continue;
      // An entry added before the first step starts its life here.
      entry.stampedAt ??= nowMs;
      const age = nowMs - entry.stampedAt;
      if (age >= MESSAGE_LIFE_MS) {
        this.entries.splice(i, 1);
        expired.push(entry.id);
        continue;
      }
      const left = MESSAGE_LIFE_MS - age;
      live.push({
        id: entry.id,
        text: entry.count > 1 ? `${entry.text} X${entry.count}` : entry.text,
        opacity: Math.max(0, Math.min(1, left / MESSAGE_FADE_MS)),
      });
    }

    // Walked backwards so a splice cannot skip the next entry; handed back
    // oldest first, because that is the order they are drawn in.
    live.reverse();
    return { live, expired };
  }

  /** How many messages are on screen. For tests and for anyone counting elements. */
  get count(): number {
    return this.entries.length;
  }
}

/**
 * What a refused cast says, in one place.
 *
 * The server's reason is a code -- `notEnoughResource` -- and the old line put
 * it on screen exactly like that. Nothing else in the game speaks to a player in
 * camelCase.
 */
export function castRefusalText(abilityName: string, reason: string): string {
  return `${abilityName}: ${refusalPhrase(reason)}`.toUpperCase();
}

/**
 * Every reason `abilities.ts` and `world.ts` can refuse with.
 *
 * Not imported from the server's union: this is a *wording* table, the wire
 * carries a free string, and a code that arrives without a phrase should read as
 * words rather than fail to draw.
 */
export const REFUSAL_PHRASES: Readonly<Record<string, string>> = {
  onCooldown: 'on cooldown',
  notEnoughResource: 'not enough resource',
  outOfRange: 'out of range',
  alreadyCasting: 'already casting',
  noTarget: 'no target',
  unknownAbility: 'unknown ability',
  dead: 'you are dead',
  withdrawn: 'withdrawn',
  // Spec 173's, worded here because "staggered" alone reads as a state rather
  // than as the reason the button did nothing.
  staggered: 'staggered',
  noCharges: 'no charges left',
  // Spec 184's three. `notEquipped` is the one worth wording carefully: an
  // honest client should never see it, so when it does appear the useful thing
  // to say is which of the four slots it is talking about.
  notEquipped: 'not in a skill slot',
  notEnoughHealth: 'not enough health',
  notEnoughPoise: 'not enough guard',
};

/** A phrase for a code, or the code itself split into readable words. */
export function refusalPhrase(reason: string): string {
  const known = REFUSAL_PHRASES[reason];
  if (known !== undefined) return known;
  // `someNewReason` -> `some new reason`. A code nobody has worded yet is still
  // a sentence, and it is still made of characters the font has.
  return reason
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .toLowerCase()
    .trim();
}
