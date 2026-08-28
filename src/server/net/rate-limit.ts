/**
 * How often a client may say a thing (spec 151).
 *
 * The server already refuses most of what a hostile client can *say*. What it
 * had no answer to was how often: only chunk requests were budgeted, and the
 * expensive verbs -- a trade invite that walks the registry, an inventory
 * write, a chat line that fans out to every connection -- had no limit at all.
 * One client could spend the whole tick, on everybody else's behalf.
 *
 * Three buckets rather than one, and the split is the design:
 *
 *  - **`chat` is separate because it is the only verb whose cost is paid by
 *    somebody else.** Every other message costs the sender's connection a
 *    little work; a chat line costs every connection in the game one. That is
 *    a different kind of thing, not a more expensive one, so it gets its own
 *    number rather than a bigger cost against a shared one.
 *  - **`heartbeat` is separate because starving it would break something
 *    else.** `Ping` is what rate matching (148) and the round-trip estimate are
 *    built on. Punishing a noisy client by taking its clock sync away would
 *    make it a client with a *drifting* clock, which is a problem the server
 *    then has to absorb.
 *  - `verbs` is everything else. `Input` and `RequestChunk` are absent on
 *    purpose: both already have their own limits (`MAX_BUFFERED_INPUTS` and
 *    `ChunkBudget`) and adding a second would be two numbers to keep in step.
 *
 * Pure: `ChunkBudget` is handed the tick, and so is this.
 */

import { ClientMessageType } from './protocol.js';
import { SERVER_TICK_RATE } from '../config.js';
import { ChunkBudget } from '../world/map-request.js';

/** One a tick of burst, refilled at a tick: far past a hand, far short of a loop. */
export const VERB_BURST = 120;
export const VERB_REFILL_PER_SECOND = 60;

/** Tighter, because this one is paid for by everybody. */
export const CHAT_BURST = 5;
export const CHAT_REFILL_PER_SECOND = 1;

/** The client pings at 2Hz; this is headroom, not a leash. */
export const HEARTBEAT_BURST = 8;
export const HEARTBEAT_REFILL_PER_SECOND = 4;

/** Over budget this many times and the connection is not worth decoding for. */
export const FLOOD_STRIKES = 60;

/**
 * A quiet spell this long starts the count again (spec 157). Ten seconds.
 *
 * Without it `strikes` was a *lifetime* total that nothing ever reset, so a
 * well-behaved session that tripped a bucket sixty times over an hour was
 * eventually dropped as a flooder -- and dropped *intentionally*, so no body
 * was held and the session ended outright. A flood is a rate, and this is what
 * makes the counter measure one.
 */
export const STRIKE_DECAY_TICKS = 600;

/**
 * The largest frame worth parsing.
 *
 * The biggest thing a client legitimately sends is a trade offer naming 24
 * slots, which is under a hundred bytes. Three orders of magnitude of headroom,
 * and still a bound -- the point is that the size is checked *before* the
 * decode rather than discovered during it.
 */
export const MAX_FRAME_BYTES = 16384;

/** As long as a `playerId`, and now broadcast to everybody (spec 145). */
export const MAX_NAME_LENGTH = 64;

type Bucket = 'verbs' | 'chat' | 'heartbeat' | 'exempt';

/**
 * Which bucket a message type spends from.
 *
 * `Input` and `RequestChunk` are exempt because they are already limited
 * elsewhere; everything unknown falls through to `verbs`, so a message type
 * added later is limited by default rather than by remembering.
 */
export function bucketFor(type: number): Bucket {
  switch (type) {
    case ClientMessageType.Input:
    case ClientMessageType.RequestChunk:
      return 'exempt';
    case ClientMessageType.Chat:
      return 'chat';
    case ClientMessageType.Ping:
      return 'heartbeat';
    default:
      return 'verbs';
  }
}

export class RateLimiter {
  private readonly verbs: ChunkBudget;
  private readonly chat: ChunkBudget;
  private readonly heartbeat: ChunkBudget;
  private strikes = 0;
  /** When the last strike landed, so a gap can retire the ones before it. */
  private lastStrikeTick = 0;

  constructor(startTick = 0, tickRate: number = SERVER_TICK_RATE) {
    this.verbs = new ChunkBudget(VERB_BURST, VERB_REFILL_PER_SECOND, tickRate, startTick);
    this.chat = new ChunkBudget(CHAT_BURST, CHAT_REFILL_PER_SECOND, tickRate, startTick);
    this.heartbeat = new ChunkBudget(
      HEARTBEAT_BURST,
      HEARTBEAT_REFILL_PER_SECOND,
      tickRate,
      startTick,
    );
  }

  /**
   * Whether this frame may be handled. False means drop it -- **silently**,
   * because answering a flood is participating in it.
   */
  allow(type: number, tick: number): boolean {
    const bucket = bucketFor(type);
    if (bucket === 'exempt') return true;
    const budget =
      bucket === 'chat' ? this.chat : bucket === 'heartbeat' ? this.heartbeat : this.verbs;
    if (budget.take(tick)) return true;
    // A gap of good behaviour retires what came before it, so this counts
    // strikes in a window rather than over a lifetime (spec 157).
    if (tick - this.lastStrikeTick > STRIKE_DECAY_TICKS) this.strikes = 0;
    this.lastStrikeTick = tick;
    this.strikes += 1;
    return false;
  }

  /** Past this the decode cost alone is worth refusing the connection. */
  get flooding(): boolean {
    return this.strikes >= FLOOD_STRIKES;
  }

  get strikeCount(): number {
    return this.strikes;
  }
}
