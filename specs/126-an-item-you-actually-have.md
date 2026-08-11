# 126 — an item you actually have

> **The number is shared.** `specs/126-a-shockwave-is-a-ring-on-the-floor.md` carries it too: the VFX arc and
> the GUI arc were written on parallel branches and both had taken it by the time
> they met. Renumbering either would have rewritten a couple of hundred references
> in files that are otherwise finished, so the number stays ambiguous and the
> filename is what identifies this one. `main` already carries duplicate 118s for
> the same reason.


## Problem

There is no inventory. `PersistedPlayer` has six equipment slots holding item
**ids** and nothing else, and two things follow from that which are worse than
"the feature is missing".

**Equipping does not check ownership.** `PlayerManager.equip` validates the slot,
that the id is in the table, that the item goes in that slot, and the level
requirement — and then equips it. Any client can equip anything in `data/items.ts`
by sending one message. Nothing in the server says a player *has* it, because
there is nowhere for having to live.

**Equipment is not replicated.** The client sends `Equip` and gets a `Stats`
message back; it is never told what is in a slot. So the HUD's weapon switch
infers the equipped weapon from the derived stat block, and the inference is
wrong — `scripts/preview-world.ts` reports "the weapon switch clicked Hunting Bow
and lit Worn Sword" on every run. A paperdoll cannot be drawn from stats.

Phase 4 of the GUI brief is drag-and-drop inventory and equipment. It needs a
container to drag things between, an authority that refuses illegal moves, and a
reconcile channel to roll back against. This spec is that; the screen is 127.

## Shape

### An item instance is a definition id and a count

```ts
// src/server/state/types.ts
export interface ItemStack {
  readonly defId: string;
  readonly count: number;   // >= 1, <= the definition's maxStack
}

/** Fixed-length. A null slot is an empty one; the array never shortens. */
export type Inventory = readonly (ItemStack | null)[];

export const INVENTORY_SLOTS = 24;
```

No `instanceId`, and no width or height. An item *is* its definition plus how
many, which keeps `data/items.ts`'s rule intact — buffing a sword buffs every
sword — and keeps a slot addressable by index, which is all a uniform grid needs.
Per-instance state (durability, sockets) and multi-cell shapes are both out
of scope and both land as fields on the stack or the definition when they arrive.

`ItemDefinition` gains `maxStack?: number`, defaulting to 1. A weapon does not
stack; a potion does.

### One address, one move

```ts
// src/server/player/inventory.ts  -- pure, in the deterministic core
export type ContainerId = 'inventory' | 'equipment';
export interface SlotAddress {
  readonly container: ContainerId;
  /** An index into the inventory, or the ordinal of an EquipSlot. */
  readonly index: number;
}

export interface MoveRequest {
  readonly from: SlotAddress;
  readonly to: SlotAddress;
  /** How many to take. Omitted means the whole stack; this is what splits. */
  readonly count?: number;
}

export type MoveOutcome =
  | { readonly ok: true; readonly inventory: Inventory; readonly equipment: Equipment }
  | { readonly ok: false; readonly reason: string };

export function applyMove(
  inventory: Inventory,
  equipment: Equipment,
  request: MoveRequest,
  level: number,
): MoveOutcome;
```

One function, and deliberately one: move-within-bag, equip, unequip, swap, merge
and split are all *the same operation* between two addresses. Writing them as six
handlers is six places for the conservation rule to be broken separately, and it
is the shape the drag UI wants anyway — a drag has a source and a target and
nothing else.

`applyMove` is pure and returns new arrays. It never mutates, never persists and
never reads a clock, so it is linted as part of the deterministic core and can be
driven by a property test.

The rules it enforces:

- An equipment target only accepts an item whose `slot` matches that ordinal.
- Level requirements are checked on the way *in* to an equipment slot.
- Two stacks of the same `defId` merge up to `maxStack`; the remainder stays
  behind rather than vanishing.
- A move onto an occupied slot swaps, unless both are the same stackable item.
- A split needs a free target slot; splitting onto an occupied one is refused
  rather than silently merged, because "put half here" and "merge into that" are
  different requests and guessing gets one of them wrong.

### On the wire

```ts
// client -> server
export interface MoveItemMessage {
  readonly type: typeof ClientMessageType.MoveItem;
  readonly requestId: number;      // echoed back, so a client knows which guess was answered
  readonly from: SlotAddress;
  readonly to: SlotAddress;
  readonly count: number;          // 0 means "the whole stack"
}

// server -> client
export interface InventoryMessage {
  readonly type: typeof ServerMessageType.Inventory;
  /** The request this answers, or 0 for an unprompted resend (login, loot). */
  readonly requestId: number;
  readonly inventory: Inventory;
  readonly equipment: Equipment;
}
```

**The whole container is resent, never a delta.** Twenty-four slots of an id and a
count is a few hundred bytes; a delta is a second description of the same state
that can drift from it. The client's optimistic guess is *replaced* by what
arrives, so rollback is not a code path — it is what happens when the resend
disagrees, and it therefore cannot rot from disuse.

A refused move still gets an `Inventory` at the same `requestId`, alongside the
existing `Error(RejectedAction, reason)`. That is what makes the rollback path
observable to a test: force a rejection, and the client's predicted state must
end up equal to the server's.

`Equip` and `Unequip` stay on the wire and are reimplemented over `applyMove`, so
the HUD's weapon switch keeps working and starts obeying ownership. They are
strictly redundant with `MoveItem` and should be removed once nothing sends them.

### Migration, and where the items come from

An existing save has no `inventory` field. It loads as `INVENTORY_SLOTS` empties,
and whatever is equipped stays equipped — a player is not stripped by an upgrade.

But once ownership is enforced, a new character with an empty bag can equip
nothing at all, so new players are granted a starting kit from a small table in
`data/items.ts`. That is the thing this spec has to add or the change is a
regression for everybody who has not looted anything yet.

## Invariants tested

- **Conservation.** Over a random sequence of moves (`fast-check`, already a
  devDependency), the multiset of `(defId, count)` across inventory *and*
  equipment is unchanged by any accepted move, and unchanged by any refused one.
  This is the property the whole design exists to protect and it is the one a
  hand-written test will not find the hole in.
- Every `applyMove` result has: no stack with `count < 1`, none above its
  `maxStack`, an inventory of exactly `INVENTORY_SLOTS`, and equipment holding
  only items whose `slot` matches.
- `applyMove` never mutates its arguments — the inputs are deep-equal afterwards.
- Equipping an item the player does not hold is refused.
- Equipping into the wrong slot, or below the level requirement, is refused and
  changes nothing.
- Two partial stacks of one item merge, capped at `maxStack`, with the remainder
  left in the source slot.
- A split leaves `count - n` behind and puts `n` in a free slot; a split onto an
  occupied slot is refused.
- A swap between two occupied slots exchanges them exactly.
- An out-of-range index, an unknown `defId` and a negative count are each refused
  rather than throwing.
- Round trip: a container encodes and decodes to itself through the codec, for an
  empty bag, a full one, and one with a stack at `maxStack`.
- A save with no `inventory` field loads as empty and keeps its equipment.
- A new player is granted the starting kit and can equip from it.
- The client's replicated view equals the server's after an accepted move **and**
  after a refused one — the rollback, asserted directly.

## Out of scope

- **The drag-and-drop screen** — spec 127, and the phase-4 UI work.
- **Currency, vendors and trade** — phase 6 needs its own server spec.
- **Multi-cell items**, item rotation and bag-shape packing. Settled out
  (`docs/ui/00-architecture.md` §12).
- **Per-instance state**: durability, sockets, enchantments, bound-on-pickup.
- **Loot, drops and pickup.** Nothing yet *puts* items in a bag except the
  starting kit; a monster that drops something is its own spec.
- **Bag size as a stat.** `INVENTORY_SLOTS` is a constant; bags that grow are a
  field on the player when something grants one.
- **Dropping to the world.** The GUI brief mentions "drop to world" as a
  configurable intent; there is no ground-item entity to drop onto.

Tested by `src/server/player/inventory.test.ts` (pure, including the property
test), `src/server/net/codec.test.ts` for the round trip, and
`src/server/client/inventory-sync.test.ts` for the prediction and its rollback.
