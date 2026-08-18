/**
 * Who is trading with whom, and what ends it (spec 132).
 *
 * `trade.ts` is the rules; this is the bookkeeping around them -- one trade per
 * player, ids that never repeat, and the five ways a trade ends. It is kept
 * apart from `PlayerManager` because that class is about *a* player and a trade
 * is the first thing in this server that is about two.
 *
 * The invariant it exists to hold: **a player is in at most one trade.** Two
 * would let the same sword be offered on two tables and taken from both, which
 * is the duplication `trade.ts` refuses to be tricked into -- so it is refused
 * one level up as well, where it is a single map lookup rather than a race.
 *
 * Pure: no clock, no store, no sessions. Holdings come in as an argument, the
 * swap goes out as a result, and the caller writes it. That is the same shape
 * `shop.ts` has and for the same reason -- an exchange whose duplication bugs
 * have somewhere to show up is an exchange a test can drive.
 */

import {
  accept,
  beginTrade,
  cancel,
  exchangeProblem,
  isLive,
  isSwappable,
  respond,
  setOffer,
  sideOf,
  swap,
  type Holdings,
  type OfferedSlot,
  type SwapOutcome,
  type Trade,
  type TradeOutcome,
} from './trade.js';

export type { Trade, TradeStage, OfferedSlot, Holdings, MovedStacks, SwapOutcome } from './trade.js';

/** How close two players must be to trade at all, in world units. */
export const TRADE_RANGE = 90;

function refuse(reason: string): TradeOutcome {
  return { ok: false, reason };
}

export class TradeRegistry {
  private readonly trades = new Map<number, Trade>();
  /** playerId -> the trade they are in. The one-trade-per-player invariant. */
  private readonly byPlayer = new Map<string, number>();
  private nextId = 1;

  /** The trade this player is in, or null. */
  for(playerId: string): Trade | null {
    const id = this.byPlayer.get(playerId);
    return id === undefined ? null : this.trades.get(id) ?? null;
  }

  get(id: number): Trade | null {
    return this.trades.get(id) ?? null;
  }

  /** Every live trade, for the per-tick range sweep. */
  live(): readonly Trade[] {
    return [...this.trades.values()].filter(isLive);
  }

  /**
   * Invite `to` to trade.
   *
   * Refused if either side is already in one, and refused for inviting yourself
   * -- which sounds like a joke and is the first thing a fuzzer tries, because a
   * self-trade would swap a bag with itself and is the neatest duplication there
   * is.
   */
  invite(from: string, to: string): TradeOutcome {
    if (from === to) return refuse('you cannot trade with yourself');
    if (this.for(from)) return refuse('you are already trading');
    if (this.for(to)) return refuse('they are already trading');

    const trade = beginTrade(this.nextId++, from, to);
    this.remember(trade);
    return { ok: true, trade };
  }

  respond(playerId: string, accepted: boolean): TradeOutcome {
    return this.step(playerId, (trade) => respond(trade, playerId, accepted));
  }

  setOffer(
    playerId: string,
    offer: readonly OfferedSlot[],
    coins: number,
    holdings: Holdings,
  ): TradeOutcome {
    return this.step(playerId, (trade) => setOffer(trade, playerId, offer, coins, holdings));
  }

  accept(playerId: string, revision: number): TradeOutcome {
    return this.step(playerId, (trade) => accept(trade, playerId, revision));
  }

  /** End this player's trade, if they are in one. Returns it, or null. */
  cancelFor(playerId: string, reason: string): Trade | null {
    const trade = this.for(playerId);
    if (!trade || !isLive(trade)) return null;
    return this.remember(cancel(trade, reason));
  }

  cancelById(id: number, reason: string): Trade | null {
    const trade = this.trades.get(id);
    if (!trade || !isLive(trade)) return null;
    return this.remember(cancel(trade, reason));
  }

  /**
   * Ask whether the exchange can run, and hand back both sides' new holdings.
   *
   * The trade is **not** marked done here: the caller has to write two players'
   * containers first, and a registry that declared the trade finished before the
   * write would be a registry that lies if the write throws. {@link finish} is
   * the second half, and it is called after.
   */
  settle(trade: Trade, a: Holdings, b: Holdings): SwapOutcome {
    if (!isSwappable(trade)) return { ok: false, reason: 'both sides have to accept the same offer' };
    return swap(trade, a, b);
  }

  /** Mark a settled trade done. Called after both sides have been written. */
  finish(trade: Trade): Trade {
    return this.remember({ ...trade, stage: 'done', reason: '' });
  }

  /**
   * Drop everything a finished trade was holding.
   *
   * Called once both sides have been told. Kept separate from `finish` so a
   * client is told about a `done` or `cancelled` trade before it disappears --
   * a trade that vanished from the registry the instant it ended would be a
   * trade nobody could be informed about.
   */
  forget(id: number): void {
    const trade = this.trades.get(id);
    if (!trade) return;
    this.trades.delete(id);
    for (const side of [trade.a, trade.b]) {
      if (this.byPlayer.get(side.playerId) === id) this.byPlayer.delete(side.playerId);
    }
  }

  private step(playerId: string, run: (trade: Trade) => TradeOutcome): TradeOutcome {
    const trade = this.for(playerId);
    if (!trade) return refuse('you are not trading');
    const result = run(trade);
    if (result.ok) this.remember(result.trade);
    return result;
  }

  private remember(trade: Trade): Trade {
    this.trades.set(trade.id, trade);
    for (const side of [trade.a, trade.b]) this.byPlayer.set(side.playerId, trade.id);
    return trade;
  }
}

/** Whether two players are close enough to trade. The per-tick check. */
export function inTradeRange(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= TRADE_RANGE;
}

/** Both sides of a trade, as player ids. */
export function partiesOf(trade: Trade): readonly [string, string] {
  return [trade.a.playerId, trade.b.playerId];
}

export { sideOf, isLive, isSwappable, exchangeProblem };
