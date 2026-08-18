/**
 * Two bags, and nothing in between (spec 132).
 *
 * The first exchange in this game with two owners, and the difference is not
 * size. Spec 126's move can be checked by counting -- the same things are there
 * afterwards. Spec 129's shop deliberately stops conserving, but the other side
 * is a *table*, and a table cannot lose a connection halfway through.
 *
 * Here the failure mode is **duplication**: an item that ends up in both bags, or
 * in neither, because something ran twice or stopped halfway. A wrong price
 * annoys a player; a duplicated sword is a broken economy, and by the time anyone
 * notices it is in circulation. So almost every decision below is chosen to make
 * that impossible rather than unlikely.
 *
 * Three of them are worth naming.
 *
 * **The swap is one function returning four whole containers.** There is no
 * intermediate state in which one bag has been debited and the other has not,
 * because there is no intermediate state at all: it returns both sides or a
 * reason, and the caller assigns both or neither. That is spec 126's rule
 * stretched across two players.
 *
 * **An acceptance names a revision.** The classic trade-window scam is to swap a
 * valuable item for a worthless one in the instant between the other player
 * accepting and the exchange resolving. Every edit bumps the revision, and an
 * acceptance that names a stale one is not an acceptance -- which makes the scam
 * a mechanical impossibility rather than a race worth timing.
 *
 * **An offer is a set of slots, resolved against the bag at swap time.** Not a
 * copy of the items: a copy is a second place the truth lives, and the two can
 * disagree the moment anything else touches the bag. Resolving late means an
 * offer whose slot has changed underneath it is *refused* rather than quietly
 * pointing at whatever is there now.
 *
 * Pure. No session, no store, no clock -- which is what lets a property test
 * hammer it, and the property it protects is that nothing is created or
 * destroyed by a trade, accepted or refused.
 */

import { maxStackOf } from '../data/items.js';
import type { Inventory, ItemStack } from '../state/types.js';
import { addToInventory } from './inventory.js';

/**
 * Where a trade is.
 *
 * `offered` is an invitation nobody has answered; `open` is both sides editing;
 * `confirmed` is both sides accepting the same revision, which is the only stage
 * a swap may run from. `done` and `cancelled` are both terminal and are kept
 * apart because "it happened" and "it did not" are the two things a player most
 * needs to be able to tell about a trade.
 */
export type TradeStage = 'offered' | 'open' | 'confirmed' | 'done' | 'cancelled';

/** One slot on the table: where it is in the bag, and how much of it. */
export interface OfferedSlot {
  readonly index: number;
  readonly count: number;
}

export interface TradeSide {
  readonly playerId: string;
  readonly offer: readonly OfferedSlot[];
  readonly coins: number;
  /**
   * The revision this side has accepted, or -1 for "not yet".
   *
   * -1 rather than a boolean: "accepted nothing" and "accepted revision 0" are
   * different states and revision 0 is a real revision.
   */
  readonly acceptedRevision: number;
}

export interface Trade {
  readonly id: number;
  readonly a: TradeSide;
  readonly b: TradeSide;
  readonly stage: TradeStage;
  /** Bumped by every change to either offer. See the header. */
  readonly revision: number;
  /** Why it ended, when it ended badly. Empty otherwise. */
  readonly reason: string;
}

/** What one side is handed to and from. */
export interface Holdings {
  readonly inventory: Inventory;
  readonly coins: number;
}

export type SwapOutcome =
  | { readonly ok: true; readonly a: Holdings; readonly b: Holdings }
  | { readonly ok: false; readonly reason: string };

export type TradeOutcome =
  | { readonly ok: true; readonly trade: Trade }
  | { readonly ok: false; readonly reason: string };

function refuseSwap(reason: string): SwapOutcome {
  return { ok: false, reason };
}

function refuse(reason: string): TradeOutcome {
  return { ok: false, reason };
}

const NOT_ACCEPTED = -1;

export function beginTrade(id: number, from: string, to: string): Trade {
  return {
    id,
    a: emptySide(from),
    b: emptySide(to),
    stage: 'offered',
    revision: 0,
    reason: '',
  };
}

function emptySide(playerId: string): TradeSide {
  return { playerId, offer: [], coins: 0, acceptedRevision: NOT_ACCEPTED };
}

/** Which side of a trade a player is, or null when they are not in it. */
export function sideOf(trade: Trade, playerId: string): 'a' | 'b' | null {
  if (trade.a.playerId === playerId) return 'a';
  if (trade.b.playerId === playerId) return 'b';
  return null;
}

export function otherSide(side: 'a' | 'b'): 'a' | 'b' {
  return side === 'a' ? 'b' : 'a';
}

/** Whether this trade is still something either player can act on. */
export function isLive(trade: Trade): boolean {
  return trade.stage === 'offered' || trade.stage === 'open' || trade.stage === 'confirmed';
}

/**
 * Answer an invitation.
 *
 * Only the invited side may answer, and only while it is still an invitation --
 * an "accept" arriving twice must not reopen a trade that has since been
 * cancelled, which is the shape of every double-submit bug there is.
 */
export function respond(trade: Trade, playerId: string, accept: boolean): TradeOutcome {
  if (trade.stage !== 'offered') return refuse('that invitation is no longer open');
  if (trade.b.playerId !== playerId) return refuse('that invitation is not yours to answer');
  if (!accept) return { ok: true, trade: { ...trade, stage: 'cancelled', reason: 'declined' } };
  return { ok: true, trade: { ...trade, stage: 'open' } };
}

/**
 * Replace one side's whole offer.
 *
 * Whole rather than added to, for the reason `MoveItem` is one message: a
 * protocol with `add` and `remove` has two handlers that can disagree about what
 * is on the table, and the thing on the table is exactly what must not be
 * ambiguous.
 *
 * **Every edit clears both acceptances**, including the edit made by the side
 * that had not accepted. Anything else means a player can be holding a "yes"
 * against a table they are no longer looking at.
 */
export function setOffer(
  trade: Trade,
  playerId: string,
  offer: readonly OfferedSlot[],
  coins: number,
  holdings: Holdings,
): TradeOutcome {
  const side = sideOf(trade, playerId);
  if (side === null) return refuse('you are not in that trade');
  // An invitation may be furnished, but only by the player who sent it (spec
  // 169). An empty request asks "do you want to trade?" with no goods and no
  // reason to say yes, and the answer to that is always no. The invited side
  // stays a spectator until they have answered: putting something up is not an
  // answer, and a table both sides can edit before either has agreed to be at
  // it is a table you can be dragged into.
  const inviting = trade.stage === 'offered' && side === 'a';
  if (!inviting && trade.stage !== 'open' && trade.stage !== 'confirmed') {
    return refuse(trade.stage === 'offered' ? 'answer the invitation first' : 'that trade is not open');
  }

  const checked = validateOffer(offer, coins, holdings);
  if (checked !== null) return refuse(checked);

  const next: TradeSide = { playerId, offer: [...offer], coins, acceptedRevision: NOT_ACCEPTED };
  const other: TradeSide = { ...trade[otherSide(side)], acceptedRevision: NOT_ACCEPTED };
  return {
    ok: true,
    trade: {
      ...trade,
      [side]: next,
      [otherSide(side)]: other,
      // An invitation with goods on it is still an invitation. Advancing here
      // would put the invitee at a table they never agreed to sit at, and
      // `respond` -- which only runs at `offered` -- could never fire.
      stage: inviting ? 'offered' : 'open',
      revision: trade.revision + 1,
    },
  };
}

/**
 * Whether an offer is sayable at all, given what this player is holding.
 *
 * Checked when the offer is made *and* again at swap time, deliberately. This
 * pass is so a player is told immediately; the one in {@link swap} is the one
 * that matters, because the bag can change in between and only the late check
 * can see that.
 */
function validateOffer(
  offer: readonly OfferedSlot[],
  coins: number,
  holdings: Holdings,
): string | null {
  if (!Number.isInteger(coins) || coins < 0) return 'coins must be a whole number';
  if (coins > holdings.coins) return `you do not have ${coins} coins`;
  if (offer.length > holdings.inventory.length) return 'more slots than you have';

  const seen = new Set<number>();
  for (const entry of offer) {
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= holdings.inventory.length) {
      return 'no such slot';
    }
    // The shortest path to a duplicate: offer slot 4 twice and let each half be
    // taken separately. Refused rather than merged, because merging would accept
    // an offer of eight potions from a stack of five.
    if (seen.has(entry.index)) return 'that slot is already on the table';
    seen.add(entry.index);

    if (!Number.isInteger(entry.count) || entry.count < 1) return 'count must be a whole number';
    const stack = holdings.inventory[entry.index] ?? null;
    if (!stack) return 'that slot is empty';
    if (entry.count > stack.count) return 'not that many to offer';
  }
  return null;
}

/**
 * Accept, naming the revision being accepted.
 *
 * A stale revision is refused rather than upgraded. Upgrading it would be
 * accepting on the player's behalf a table they have not seen, which is exactly
 * the thing the revision exists to prevent.
 */
export function accept(trade: Trade, playerId: string, revision: number): TradeOutcome {
  if (trade.stage !== 'open' && trade.stage !== 'confirmed') return refuse('that trade is not open');
  const side = sideOf(trade, playerId);
  if (side === null) return refuse('you are not in that trade');
  if (revision !== trade.revision) return refuse('the offer changed -- look again');

  const next = { ...trade, [side]: { ...trade[side], acceptedRevision: revision } };
  const both =
    next.a.acceptedRevision === trade.revision && next.b.acceptedRevision === trade.revision;
  return { ok: true, trade: { ...next, stage: both ? 'confirmed' : 'open' } };
}

export function cancel(trade: Trade, reason: string): Trade {
  if (!isLive(trade)) return trade;
  return { ...trade, stage: 'cancelled', reason };
}

/** Whether both sides have said yes to what is currently on the table. */
export function isSwappable(trade: Trade): boolean {
  return (
    trade.stage === 'confirmed' &&
    trade.a.acceptedRevision === trade.revision &&
    trade.b.acceptedRevision === trade.revision
  );
}

/**
 * Perform the exchange, or refuse it whole.
 *
 * Both sides are computed and both are checked before either is returned. A
 * refusal returns no containers at all, so there is nothing partial for a caller
 * to have to undo -- which is the only way to be sure a dropped connection
 * between two writes cannot leave an item in both bags.
 *
 * The order inside is: take from both, then give to both. Taking first is what
 * makes room -- a trade of a sword for a sword between two full bags is a legal
 * trade, and giving first would refuse it for lack of a slot that is about to be
 * empty.
 */
export function swap(trade: Trade, a: Holdings, b: Holdings): SwapOutcome {
  if (!isSwappable(trade)) return refuseSwap('both sides have to accept the same offer');
  const result = exchange(trade, a, b);
  return result.ok ? result : refuseSwap(result.reason);
}

/**
 * Whose bag stops this exchange, and why -- or null if it would go through.
 *
 * The same arithmetic {@link swap} runs, minus the stage check, so it can be
 * asked of a table nobody has accepted yet (spec 170). That is the whole point:
 * a full bag used to be discovered *after* both sides had accepted, as the
 * reason the trade was cancelled, and there is nothing a player can do about it
 * at that moment except start again.
 *
 * It names a **side** rather than describing one, because the server publishes
 * to each player separately and "your bag is full" and "their bag is full" are
 * different sentences. `swap`'s single reason string could only ever be right
 * for one of the two people reading it, and was: it said "their bag is full" to
 * the player whose own bag was the problem.
 */
export function exchangeProblem(
  trade: Trade,
  a: Holdings,
  b: Holdings,
): { readonly side: 'a' | 'b'; readonly reason: string } | null {
  const result = exchange(trade, a, b);
  return result.ok ? null : { side: result.side, reason: result.reason };
}

type Exchange =
  | { readonly ok: true; readonly a: Holdings; readonly b: Holdings }
  | { readonly ok: false; readonly side: 'a' | 'b'; readonly reason: string };

/**
 * Take from both, then give to both.
 *
 * Taking first is what makes room -- a trade of a sword for a sword between two
 * full bags is a legal trade, and giving first would refuse it for lack of a
 * slot that is about to be empty.
 */
function exchange(trade: Trade, a: Holdings, b: Holdings): Exchange {
  const takenFromA = take(trade.a, a);
  if (typeof takenFromA === 'string') return { ok: false, side: 'a', reason: takenFromA };
  const takenFromB = take(trade.b, b);
  if (typeof takenFromB === 'string') return { ok: false, side: 'b', reason: takenFromB };

  const givenToA = give(takenFromA.left, takenFromB.moved);
  if (!givenToA) return { ok: false, side: 'a', reason: 'no room for what is on the table' };
  const givenToB = give(takenFromB.left, takenFromA.moved);
  if (!givenToB) return { ok: false, side: 'b', reason: 'no room for what is on the table' };

  return {
    ok: true,
    a: { inventory: givenToA, coins: a.coins - trade.a.coins + trade.b.coins },
    b: { inventory: givenToB, coins: b.coins - trade.b.coins + trade.a.coins },
  };
}

interface Taken {
  /** The bag with the offer removed. */
  readonly left: Inventory;
  /** What came out of it. */
  readonly moved: readonly ItemStack[];
}

/**
 * Remove a side's offer from its bag, or say why not.
 *
 * The late check the header promises. Every reason here is a bag that changed
 * between the offer and the swap -- something was sold, equipped, or moved -- and
 * every one of them refuses the whole trade rather than trading what is left.
 */
function take(side: TradeSide, holdings: Holdings): Taken | string {
  if (side.coins > holdings.coins) return `${side.playerId} no longer has ${side.coins} coins`;
  const bag = [...holdings.inventory];
  const moved: ItemStack[] = [];

  for (const entry of side.offer) {
    const stack = bag[entry.index] ?? null;
    if (!stack) return 'an offered slot is empty now';
    if (entry.count > stack.count) return 'an offered stack got smaller';
    const left = stack.count - entry.count;
    bag[entry.index] = left === 0 ? null : { defId: stack.defId, count: left };
    moved.push({ defId: stack.defId, count: entry.count });
  }
  return { left: bag, moved };
}

/**
 * Put every stack into a bag, or null when one of them will not fit.
 *
 * Folded through `addToInventory` one stack at a time rather than counting free
 * slots first, because stacking makes "will it fit" a question only the real
 * insertion can answer: three potions may need no slot at all, or one, depending
 * on what is already there.
 */
function give(inventory: Inventory, stacks: readonly ItemStack[]): Inventory | null {
  let bag = inventory;
  for (const stack of stacks) {
    // Split across stacks the bag can actually hold, so an offer of more than one
    // stack's worth is placed rather than refused for being a single oversized
    // stack that no slot could take.
    const cap = maxStackOf(stack.defId);
    let left = stack.count;
    while (left > 0) {
      const chunk = Math.min(cap, left);
      const next = addToInventory(bag, { defId: stack.defId, count: chunk });
      if (!next) return null;
      bag = next;
      left -= chunk;
    }
  }
  return bag;
}
