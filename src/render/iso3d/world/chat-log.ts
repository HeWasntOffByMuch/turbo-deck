/**
 * What has been said, and what this player said (spec 189).
 *
 * The client state behind the chat: a capped scrollback, a ring of the lines
 * this player sent so Up and Down can walk them, and the one timestamp that
 * decides whether the log is on screen at all.
 *
 * Pure -- no DOM, no clock. The time is an argument, the same rule everything
 * under `src/ui/` keeps, which is what lets a script of `[time, event]` pairs
 * replay to the same pixels every run.
 *
 * `chat.ts` beside it renders what this holds and decides nothing about it.
 */

/**
 * Say, System, AdminBroadcast -- `ChatChannel` from the protocol, narrowed.
 *
 * Declared in the screen and imported here rather than the other way round,
 * because lint refuses `src/ui/` an import of `**\/render/iso3d/**` and this
 * direction is the one that is allowed. The screen is also where the question
 * "what is a channel" is actually answered, since what a channel *is* here is
 * the colour it is drawn in.
 */
export type { ChatChannelId } from '../../../ui/screens/chat.js';

/**
 * How many lines are kept.
 *
 * A cap rather than a growing array: a log nobody clears is a session-long leak
 * that only shows up on the machine left running overnight, and two hundred
 * lines is far more scrollback than the eight-line panel can be scrolled through
 * in one sitting.
 */
export const SCROLLBACK = 200;

/** How many of this player's own lines Up walks back through. */
export const HISTORY = 20;

/** Silence before the log starts leaving. */
export const QUIET_MS = 10_000;

/** How long leaving takes. */
export const WIPE_MS = 260;

import type { ChatChannelId } from '../../../ui/screens/chat.js';

export interface ChatEntry {
  readonly id: number;
  readonly channel: ChatChannelId;
  /** Who said it. Empty for `System`, which is nobody. */
  readonly from: string;
  readonly text: string;
  readonly atMs: number;
}

/**
 * How much of the panel to draw, 1 fully out and 0 gone.
 *
 * **A wipe rather than a fade, and that is not a preference.** Nothing in this
 * framework blends: `budget.test.ts` asserts every quad comes out at alpha 255,
 * because a source-over blend is the one operation `raster.ts` and a browser
 * canvas round differently -- `preview-ui-gallery.ts` caught exactly that once,
 * a cooldown scrim off by one in two channels.
 *
 * Over the world it would be worse rather than better. The UI canvas is cleared
 * to transparent, so a translucent quad composites against *nothing*, and
 * `raster.ts` writes the source straight through on an empty pixel where a
 * browser stores it premultiplied and rounds. The backends would disagree by
 * construction.
 *
 * So the log leaves the way a window arrives (spec 133): a clip, computed while
 * painting from the time it was handed. Paint-time, so it costs no layout, and
 * `animate` answers reduce-motion centrally -- for a player who asked for less
 * motion the log is simply there or not.
 */
export function revealAt(lastAtMs: number, nowMs: number, open: boolean): number {
  // Open is open however long the silence has been: a player staring at the
  // field they are typing into must not watch the log slide out from over it.
  if (open) return 1;
  const quiet = nowMs - lastAtMs;
  if (!Number.isFinite(quiet)) return 0;
  if (quiet <= QUIET_MS) return 1;
  const leaving = (quiet - QUIET_MS) / WIPE_MS;
  return Math.max(0, Math.min(1, 1 - leaving));
}

export class ChatLog {
  private readonly lines: ChatEntry[] = [];
  private readonly sent: string[] = [];
  private nextId = 1;
  /**
   * Bumped by every {@link append}.
   *
   * The entries array is mutated in place -- pushed, and shifted at the cap --
   * so its identity says nothing about whether anything was said. A counter is
   * what lets the mount skip rebuilding a view for a frame in which nothing
   * arrived, which is very nearly all of them.
   */
  private version = 0;
  /**
   * Where Up has walked to. `sent.length` is the newest end, which is the empty
   * field the player started from rather than the last thing they said.
   */
  private cursor = 0;
  /**
   * When the log last had something to show.
   *
   * Negative infinity rather than zero, or a session opens with the log wiping
   * out of a corner it was never in. It reads as "silent since forever", which
   * {@link revealAt} answers 0 to.
   */
  private activeAt = Number.NEGATIVE_INFINITY;

  get revision(): number {
    return this.version;
  }

  get entries(): readonly ChatEntry[] {
    return this.lines;
  }

  /** When the log was last worth looking at. What {@link revealAt} measures. */
  get lastAtMs(): number {
    return this.activeAt;
  }

  /**
   * Something arrived. Oldest falls off the front once the cap is reached.
   *
   * The channel is taken as a number and narrowed here rather than at the call
   * site, because it arrives off the wire: a byte a future server sends that
   * this build has no colour for is drawn as `Say` instead of throwing, which is
   * the right way round for a message somebody typed to a person.
   */
  append(channel: number, from: string, text: string, nowMs: number): ChatEntry {
    const entry: ChatEntry = {
      id: this.nextId++,
      channel: channel === 1 || channel === 2 ? channel : 0,
      from,
      text,
      atMs: nowMs,
    };
    this.lines.push(entry);
    while (this.lines.length > SCROLLBACK) this.lines.shift();
    this.activeAt = nowMs;
    this.version++;
    return entry;
  }

  /**
   * Keep the log up without anything arriving.
   *
   * Called when the field is closed. Without it, closing the chat after a long
   * quiet spell makes the log vanish on the same frame -- the player is looking
   * straight at it, and the last thing they did was put it away, which is not
   * the same as having ignored it for ten seconds.
   */
  touch(nowMs: number): void {
    this.activeAt = nowMs;
  }

  /**
   * Remember a line this player sent.
   *
   * A repeat of the line most recently remembered is dropped: saying "ready"
   * four times should cost one entry in the ring, or Up walks back through four
   * of them before reaching anything else.
   */
  remember(text: string): void {
    if (text.length === 0) return;
    if (this.sent[this.sent.length - 1] !== text) {
      this.sent.push(text);
      while (this.sent.length > HISTORY) this.sent.shift();
    }
    this.resetRecall();
  }

  /**
   * Walk what was sent: -1 older, +1 newer.
   *
   * The newest end is `''` rather than the last line sent, so Down past the end
   * empties the field instead of sticking -- which is what every shell does, and
   * the only way back to a blank line without holding Backspace.
   */
  recall(step: number): string {
    const next = this.cursor + (step < 0 ? -1 : 1);
    this.cursor = Math.max(0, Math.min(this.sent.length, next));
    return this.sent[this.cursor] ?? '';
  }

  resetRecall(): void {
    this.cursor = this.sent.length;
  }
}
