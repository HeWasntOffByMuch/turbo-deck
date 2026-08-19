/**
 * What a skill-slot change looks like while it is happening (spec 188).
 *
 * A swap is the one container edit this client does not predict: the server
 * holds it for `SKILL_SWAP.durationTicks` on purpose, so the interface cannot
 * show the *result* and has to show the **commitment** instead. That is three
 * facts -- which slots, which direction, how far through -- and this file turns
 * the replicated block into them once, so the bag, the action bar and the body
 * cannot come to different answers about a change that is happening to all
 * three at the same moment.
 *
 * Pure, and deliberately not a clock: both ticks are the server's and the
 * progress is a comparison against the tick being drawn, the same trick the
 * loot reveal uses. There is nothing here to start, stop, or leak.
 */

import { SKILL_SWAP, SkillSwapKind } from '../../../server/data/skill-effects.js';
import { EntityActivity } from '../../../server/net/protocol.js';
import type { PendingSkillSwap } from '../../../server/net/messages.js';
import { equipSlotAt } from '../../../server/player/inventory.js';
import { isSkillSlot, type SlotAddress } from '../../../server/state/types.js';

/**
 * What one *cell* is doing in a change, from that cell's own point of view.
 *
 * Two roles rather than three, because a cell is one end of the move: something
 * is leaving it or something is arriving in it. Which of the three *kinds* the
 * whole change is, is a fact about the pair -- see {@link SwapProgress.kind} --
 * and is what the word in the action bar says.
 */
export type SlotRole = 'out' | 'in';

export interface SwapProgress {
  /** A {@link SkillSwapKind}. */
  readonly kind: number;
  readonly from: SlotAddress;
  readonly to: SlotAddress;
  /** 0 at the moment it was asked for, 1 when it lands. Clamped. */
  readonly progress: number;
}

/**
 * The change as of `tick`, or null when there is none.
 *
 * `progress` is clamped at both ends, which matters more than it looks: the
 * drawn tick is an *estimate* that can sit either side of the server's, and a
 * bar that went past full or started negative would read as a glitch in the one
 * moment the player is watching it.
 */
export function swapProgress(pending: PendingSkillSwap | null, tick: number): SwapProgress | null {
  if (!pending) return null;
  const span = pending.readyAtTick - pending.startedTick;
  const done = span > 0 ? (tick - pending.startedTick) / span : 1;
  return {
    kind: pending.kind,
    from: pending.from,
    to: pending.to,
    progress: Math.max(0, Math.min(1, done)),
  };
}

/** What `at` is doing in this change, or null if it is not one of its ends. */
export function roleOf(swap: SwapProgress | null, at: SlotAddress): SlotRole | null {
  if (!swap) return null;
  if (sameSlot(swap.from, at)) return 'out';
  if (sameSlot(swap.to, at)) return 'in';
  return null;
}

function sameSlot(a: SlotAddress, b: SlotAddress): boolean {
  return a.container === b.container && a.index === b.index;
}

/**
 * The skill slot this change is happening *to*, as an index into the action
 * bar, or null.
 *
 * The bar has four cells and a change always touches at least one of them --
 * that is what makes it a swap rather than a bag drag. When both ends are skill
 * slots (dragging one skill onto another) the *destination* is the one named,
 * because that is the slot whose contents are about to be different.
 */
export function barSlotOf(swap: SwapProgress | null): number | null {
  if (!swap) return null;
  return skillOrdinal(swap.to) ?? skillOrdinal(swap.from);
}

function skillOrdinal(at: SlotAddress): number | null {
  if (at.container !== 'equipment') return null;
  const slot = equipSlotAt(at.index);
  if (slot === null || !isSkillSlot(slot)) return null;
  // The ordinal *within the skill slots*, which is the bar index: the four are
  // appended to `EQUIP_SLOTS`, so this is the offset past the worn ones.
  return at.index - firstSkillIndex();
}

let firstSkill = -1;

function firstSkillIndex(): number {
  if (firstSkill >= 0) return firstSkill;
  let index = 0;
  for (;;) {
    const slot = equipSlotAt(index);
    if (slot === null) break;
    if (isSkillSlot(slot)) {
      firstSkill = index;
      return index;
    }
    index += 1;
  }
  firstSkill = 0;
  return 0;
}

/**
 * The commitment as seen from *outside*, over a body (spec 188).
 *
 * Everything above is driven by the `pendingSwap` block, which is owner-only --
 * it names slot addresses, and what is in another player's bag is nobody
 * else's business. This is the half every client can draw: `activity` and
 * `activityUntilTick` are already replicated for every body in interest, so a
 * player changing a skill in front of you is visibly busy for exactly as long
 * as they are.
 *
 * It says *that* a change is happening and never *which* one, and that split is
 * deliberate rather than a shortcut: which slot and which direction are facts
 * about a bag, and the two surfaces that show them -- the grid and the bar --
 * are the player's own.
 *
 * The length comes from the shared constant rather than from the wire, for the
 * reason `stun-icon.ts` gives about its own tail: only the *end* is replicated.
 * Unlike a stagger's window, this one has a single authored length that both
 * ends already agree on, so a fraction is expressible here where it was not
 * there.
 */
export function swapOverhead(
  activity: number,
  activityUntilTick: number,
  tick: number,
): { readonly visible: boolean; readonly progress: number } {
  if (activity !== EntityActivity.Swapping || tick >= activityUntilTick) {
    return { visible: false, progress: 0 };
  }
  const span = Math.max(1, SKILL_SWAP.durationTicks);
  const left = activityUntilTick - tick;
  return { visible: true, progress: Math.max(0, Math.min(1, 1 - left / span)) };
}

/**
 * What the action bar calls this change.
 *
 * Words rather than an icon, and in the bar rather than in the bag, because the
 * bar is the surface with room for a caption and the one a player is looking at
 * mid-fight. The bag shows the same change as a *direction* -- one cell
 * emptying, one filling -- which is the reading a grid gives for free.
 */
export function swapLabel(kind: number): string {
  switch (kind) {
    case SkillSwapKind.Equip:
      return 'EQUIPPING';
    case SkillSwapKind.Unequip:
      return 'REMOVING';
    default:
      return 'SWAPPING';
  }
}
