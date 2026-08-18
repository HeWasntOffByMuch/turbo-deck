/**
 * What the trade screen is handed (spec 134).
 *
 * The fourth of these, and the same job: `src/ui/` may not reach the sim, so the
 * replicated facts and the content tables are turned into plain rows out here.
 *
 * What is different is where the offer's *slots* come from. The wire sends each
 * side's offer already resolved to items (spec 132), because the other player
 * cannot see into your bag -- so the screen gets names from the wire, and the
 * *indices* it needs to highlight your own bag come from matching those items
 * back against the bag the server also sent. That matching is the one piece of
 * arithmetic here, and it is why this file exists rather than the screen taking
 * a `TradeView` directly.
 *
 * Pure and headlessly tested.
 */

import { itemById } from '../../../server/data/items.js';
import { TradeStageValue } from '../../../server/net/protocol.js';
import type { TradeSideView } from '../../../server/net/messages.js';
import type { Inventory } from '../../../server/state/types.js';
import type { TradeOfferView, TradeUiView } from '../../../ui/screens/trade.js';
import { itemViewOf } from './inventory-model.js';

export interface TradeSource {
  readonly trade: {
    readonly stage: number;
    readonly revision: number;
    readonly you: TradeSideView;
    readonly them: TradeSideView;
    readonly reason: string;
    readonly invited: boolean;
    readonly warning: string;
  } | null;
  readonly inventory: Inventory;
  readonly coins: number;
}

/** How a stage byte reads to a screen. Both endings are one word to a player. */
function stageOf(stage: number): TradeUiView['stage'] {
  switch (stage) {
    case TradeStageValue.Offered:
      return 'offered';
    case TradeStageValue.Confirmed:
      return 'confirmed';
    case TradeStageValue.Done:
    case TradeStageValue.Cancelled:
      return 'over';
    default:
      return 'open';
  }
}

function nameOf(defId: string): string {
  return itemById(defId)?.name ?? defId;
}

function offerOf(side: TradeSideView): TradeOfferView {
  return {
    name: side.displayName,
    rows: side.offer.map((entry) => ({ name: nameOf(entry.defId), count: entry.count })),
    coins: side.coins,
    accepted: side.accepted,
  };
}

/**
 * Which bag slots your own offer is standing on.
 *
 * Matched back rather than sent, because the wire carries items and not indices
 * -- and it has to be a *consuming* match: two separate stacks of the same salve
 * on the table are two slots, and a naive `findIndex` would light the first one
 * twice and leave the second dark.
 */
export function offeredSlotsOf(offer: TradeSideView['offer'], inventory: Inventory): readonly number[] {
  const used = new Set<number>();
  const slots: number[] = [];
  for (const entry of offer) {
    for (let index = 0; index < inventory.length; index += 1) {
      if (used.has(index)) continue;
      const stack = inventory[index];
      if (!stack || stack.defId !== entry.defId) continue;
      used.add(index);
      slots.push(index);
      break;
    }
  }
  return slots.sort((a, b) => a - b);
}

/**
 * The whole screen, or null when there is no trade.
 *
 * Null rather than an empty view, because "no trade" and "a trade with nothing
 * on the table" are different things and the window's own visibility is driven
 * from the difference -- the same shape `shopViewOf` has.
 */
export function tradeViewOf(source: TradeSource): TradeUiView | null {
  const trade = source.trade;
  if (!trade) return null;
  const succeeded = trade.stage === TradeStageValue.Done;
  return {
    stage: stageOf(trade.stage),
    succeeded,
    invited: trade.invited,
    warning: trade.warning,
    you: offerOf(trade.you),
    them: offerOf(trade.them),
    bag: source.inventory.map((stack) => (stack ? itemViewOf(stack.defId, stack.count) : null)),
    offered: offeredSlotsOf(trade.you.offer, source.inventory),
    coins: trade.you.coins,
    purse: source.coins,
    revision: trade.revision,
    // A completed trade carries no reason -- there is nothing to explain, which
    // is exactly why it needs words here: the four cancellations all say why the
    // window is still up, and a success said nothing at all, leaving the payoff
    // of the whole feature as a blank panel with a Close button on it. The
    // wording is presentation, so it lives out here with the rest of the rows
    // rather than being invented by the server or by the screen.
    reason: trade.reason === '' && succeeded ? 'the trade went through' : trade.reason,
  };
}
