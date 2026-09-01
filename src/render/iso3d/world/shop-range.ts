/**
 * Whether the shop that is open can still be reached (spec 269).
 *
 * The server refuses each *transaction* out of range and always has --
 * `vendorInReach`, which is the authority and is untouched. What it does not do
 * is say so unprompted: `sendVendorState` answers an out-of-range open with an
 * empty state, but only when asked, and nothing sweeps. So walking away from a
 * merchant left a full price list on screen with every cell live, refusing one
 * press at a time.
 *
 * `sweepConversations` does exactly this job for spec 246's bubble, and this is
 * deliberately **not** that. Three reasons, and the last one decides it.
 *
 * **A shop is not a claim on a body.** A conversation is held server-side
 * because it stops a merchant wandering off mid-sentence and because two
 * players cannot hold one with the same NPC. A shop holds nothing and refuses
 * nobody -- two players may browse one merchant at once -- so there is nothing
 * for the server to release.
 *
 * **The client's position is the earlier one.** This measures against the
 * *predicted* position, which crosses the line before the server's copy does:
 * `record.position` is written by `syncFromEntity` once a broadcast, so a
 * server sweep would answer at best one broadcast late and take another round
 * trip to arrive. Here the window closes on the frame you walk out. Spec 260's
 * rule for a sign's bubble, in as many words.
 *
 * **A volunteered `VendorState` would put spec 249's guard permanently off by
 * one.** That guard is `vendorReplies + 1 < vendorAsks`, and it rests on there
 * being exactly one reply per ask -- `OpenVendor`, `BuyItem`, `SellItem`,
 * `BuyBack`. A reply nobody asked for makes the replies run ahead of the asks
 * for the rest of the session, and from then on a *superseded* answer is
 * accepted: which is the shop opening and vanishing within a frame or two of
 * the press, the exact bug spec 249 exists to have fixed. Closing from here is
 * an ordinary `openVendor('')`, so the pairing is undisturbed.
 *
 * Pure, and it stays that way: it is handed a position and answers a question.
 */

import { vendorById } from '../../../server/data/vendors.js';

/** Where the player is, as much of it as this question needs. */
export interface ReaderAt {
  readonly x: number;
  readonly y: number;
}

/**
 * Whether a shop at `vendorId` is still in reach from `at`.
 *
 * The vendor's **own** radius, which is the number `withinReach` measures
 * against -- so the window shuts exactly when the cells would begin being
 * refused. Not a hair before, which would take away a purchase the server would
 * have allowed; and not after, which is the state being fixed.
 *
 * There is no hysteresis and none is needed: nothing reopens a shop on its own,
 * so a player standing on the boundary cannot make it flicker.
 *
 * An unknown vendor is **in** reach, and that is the safe direction rather than
 * a shrug: this side may be a build behind the server's content, and a client
 * that shut a shop it could not name would be one that cannot buy from a vendor
 * the server is perfectly happy to serve. The server still refuses every
 * transaction that is really out of range.
 *
 * A null position is likewise in reach: that is a client with no prediction yet
 * -- the first frames of a session -- not a body a hundred metres away.
 */
export function shopInReach(vendorId: string, at: ReaderAt | null): boolean {
  if (vendorId === '') return false;
  const vendor = vendorById(vendorId);
  if (!vendor || !at) return true;
  return Math.hypot(vendor.x - at.x, vendor.y - at.y) <= vendor.radius;
}
