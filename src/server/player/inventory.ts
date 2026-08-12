/**
 * Moving one item from one slot to another (spec 126).
 *
 * There is exactly one operation here, and that is the point. Move-within-bag,
 * equip, unequip, swap, merge and split are all *the same thing* between two
 * addresses: take from `from`, put at `to`, and refuse if the result would be a
 * state the rules do not allow. Written as six handlers it would be six places
 * for the conservation rule to be broken separately, and it is the shape a drag
 * wants anyway -- a drag has a source and a target and nothing else.
 *
 * Pure: it returns new arrays, never mutates its arguments, never persists and
 * never reads a clock. That is what lets a property test hammer it, and the
 * property it protects is that nothing is created or destroyed by a move --
 * accepted or refused.
 */

import { itemById, maxStackOf } from '../data/items.js';
import {
  EQUIP_SLOTS,
  INVENTORY_SLOTS,
  type Equipment,
  type EquipSlot,
  type Inventory,
  type ItemStack,
  type SlotAddress,
} from '../state/types.js';

// The address lives in the shared vocabulary so the codec can name a slot
// without depending on the rules; re-exported here so callers of the rules have
// one import rather than two.
export type { ContainerId, SlotAddress } from '../state/types.js';

export interface MoveRequest {
  readonly from: SlotAddress;
  readonly to: SlotAddress;
  /** How many to take. Omitted means the whole stack; this is what splits. */
  readonly count?: number;
}

export type MoveOutcome =
  | { readonly ok: true; readonly inventory: Inventory; readonly equipment: Equipment }
  | { readonly ok: false; readonly reason: string };

/** The address of an equipment slot by name, for callers that think in names. */
export function equipmentAddress(slot: EquipSlot): SlotAddress {
  return { container: 'equipment', index: EQUIP_SLOTS.indexOf(slot) };
}

/** The slot an equipment address names, or null if the ordinal is not one. */
export function equipSlotAt(index: number): EquipSlot | null {
  return EQUIP_SLOTS[index] ?? null;
}

/**
 * Equipment as a container of stacks, so both sides of a move have one shape.
 *
 * An equipped item is a count of exactly one: a worn sword is not a stack and
 * never becomes one, which is why the equipment record stores a bare id and this
 * is a view over it rather than the storage.
 */
function equipmentStackAt(equipment: Equipment, index: number): ItemStack | null {
  const slot = equipSlotAt(index);
  if (slot === null) return null;
  const id = equipment[slot];
  return id === null ? null : { defId: id, count: 1 };
}

function inventoryStackAt(inventory: Inventory, index: number): ItemStack | null {
  return inventory[index] ?? null;
}

function stackAt(inventory: Inventory, equipment: Equipment, at: SlotAddress): ItemStack | null {
  return at.container === 'inventory'
    ? inventoryStackAt(inventory, at.index)
    : equipmentStackAt(equipment, at.index);
}

function addressInRange(at: SlotAddress): boolean {
  if (!Number.isInteger(at.index) || at.index < 0) return false;
  return at.index < (at.container === 'inventory' ? INVENTORY_SLOTS : EQUIP_SLOTS.length);
}

function sameAddress(a: SlotAddress, b: SlotAddress): boolean {
  return a.container === b.container && a.index === b.index;
}

/**
 * A working copy of both containers, written through and frozen back at the end.
 *
 * The mutation is confined to this object and it never escapes: `applyMove`
 * builds one from copies, edits it, and hands out the copies. Every rule below
 * therefore reads as a plain assignment while the function stays pure.
 */
interface Draft {
  readonly bag: (ItemStack | null)[];
  readonly worn: Record<EquipSlot, string | null>;
}

function draftOf(inventory: Inventory, equipment: Equipment): Draft {
  return { bag: [...inventory], worn: { ...equipment } };
}

function write(draft: Draft, at: SlotAddress, stack: ItemStack | null): void {
  if (at.container === 'inventory') {
    draft.bag[at.index] = stack;
    return;
  }
  const slot = equipSlotAt(at.index);
  if (slot === null) return;
  draft.worn[slot] = stack === null ? null : stack.defId;
}

function done(draft: Draft): MoveOutcome {
  return { ok: true, inventory: draft.bag, equipment: draft.worn };
}

function refuse(reason: string): MoveOutcome {
  return { ok: false, reason };
}

/**
 * Whether `stack` may be worn at an equipment ordinal, and why not if not.
 *
 * The two checks that make ownership meaningful: an item goes where its row says
 * it goes, and the level requirement is checked on the way *in*. Nothing is
 * checked on the way out -- outlevelling a chestpiece must not trap it on you.
 */
function equipRefusal(stack: ItemStack, index: number, level: number): string | null {
  const slot = equipSlotAt(index);
  if (slot === null) return `no such equipment slot: ${index}`;
  const definition = itemById(stack.defId);
  if (!definition) return `no such item: ${stack.defId}`;
  if (definition.slot !== slot) return `${definition.name} does not go in ${slot}`;
  if (level < definition.levelRequirement) {
    return `${definition.name} requires level ${definition.levelRequirement}`;
  }
  if (stack.count !== 1) return `cannot equip ${stack.count} of ${definition.name}`;
  return null;
}

/**
 * Move `count` (or all) of what is at `from` to `to`.
 *
 * Refusals leave both containers exactly as they were -- the caller gets a
 * reason and the old arrays, never a half-applied move.
 */
export function applyMove(
  inventory: Inventory,
  equipment: Equipment,
  request: MoveRequest,
  level: number,
): MoveOutcome {
  if (inventory.length !== INVENTORY_SLOTS) return refuse('inventory is the wrong size');
  const { from, to } = request;
  if (!addressInRange(from)) return refuse('source slot does not exist');
  if (!addressInRange(to)) return refuse('target slot does not exist');
  if (sameAddress(from, to)) return refuse('source and target are the same slot');

  const source = stackAt(inventory, equipment, from);
  if (source === null) return refuse('source slot is empty');
  if (itemById(source.defId) === null) return refuse(`no such item: ${source.defId}`);

  const requested = request.count === undefined ? source.count : request.count;
  if (!Number.isInteger(requested) || requested < 1) return refuse('count must be a whole number');
  if (requested > source.count) return refuse('not that many to move');
  const whole = requested === source.count;

  const target = stackAt(inventory, equipment, to);
  const draft = draftOf(inventory, equipment);

  // --- the target is empty: put it there, leaving any remainder behind ---
  if (target === null) {
    if (to.container === 'equipment') {
      const refusal = equipRefusal({ defId: source.defId, count: requested }, to.index, level);
      if (refusal !== null) return refuse(refusal);
    }
    write(draft, from, whole ? null : { defId: source.defId, count: source.count - requested });
    write(draft, to, { defId: source.defId, count: requested });
    return done(draft);
  }

  // --- same stackable item: merge what fits, leave the rest ---
  if (target.defId === source.defId && to.container === 'inventory' && maxStackOf(source.defId) > 1) {
    const room = maxStackOf(source.defId) - target.count;
    if (room <= 0) return refuse('that stack is full');
    const moved = Math.min(room, requested);
    const left = source.count - moved;
    write(draft, from, left === 0 ? null : { defId: source.defId, count: left });
    write(draft, to, { defId: target.defId, count: target.count + moved });
    return done(draft);
  }

  // --- occupied by something else: swap, but only a whole stack can swap ---
  //
  // "Put half of this here" and "merge into that" are different requests, and a
  // partial move onto an occupied slot can honestly do neither: there is nowhere
  // for the displaced stack to go. Refusing is the only answer that does not
  // guess, and guessing gets one of the two wrong.
  if (!whole) return refuse('a split needs an empty slot');

  if (to.container === 'equipment') {
    const refusal = equipRefusal(source, to.index, level);
    if (refusal !== null) return refuse(refusal);
  }
  if (from.container === 'equipment') {
    const refusal = equipRefusal(target, from.index, level);
    if (refusal !== null) return refuse(refusal);
  }
  write(draft, from, target);
  write(draft, to, source);
  return done(draft);
}

/**
 * Where a stack would go if it were handed to a player, or null for "no room".
 *
 * Not part of a move -- a move is between two named addresses. This is what a
 * grant needs (the starting kit today, loot later), and it fills partial stacks
 * before empty slots so a bag does not fragment on its own.
 */
export function addToInventory(inventory: Inventory, stack: ItemStack): Inventory | null {
  const cap = maxStackOf(stack.defId);
  const bag = [...inventory];
  let left = stack.count;

  if (cap > 1) {
    for (let i = 0; i < bag.length && left > 0; i++) {
      const held = bag[i];
      if (!held || held.defId !== stack.defId || held.count >= cap) continue;
      const moved = Math.min(cap - held.count, left);
      bag[i] = { defId: held.defId, count: held.count + moved };
      left -= moved;
    }
  }
  for (let i = 0; i < bag.length && left > 0; i++) {
    if (bag[i]) continue;
    const moved = Math.min(cap, left);
    bag[i] = { defId: stack.defId, count: moved };
    left -= moved;
  }
  return left > 0 ? null : bag;
}

/**
 * A bag from a save, made safe to load.
 *
 * A save written before spec 126 has no field at all; one written by an older
 * table may name an item that no longer exists or hold more than today's
 * `maxStack`. All three load rather than refusing the login, because a character
 * nobody can log into is a worse outcome than a character missing a potion.
 */
export function sanitizeInventory(raw: Inventory | undefined): Inventory {
  const bag = new Array<ItemStack | null>(INVENTORY_SLOTS).fill(null);
  if (!raw) return bag;
  for (let i = 0; i < Math.min(raw.length, INVENTORY_SLOTS); i++) {
    const stack = raw[i];
    if (!stack || itemById(stack.defId) === null) continue;
    const count = Math.floor(stack.count);
    if (!Number.isFinite(count) || count < 1) continue;
    bag[i] = { defId: stack.defId, count: Math.min(count, maxStackOf(stack.defId)) };
  }
  return bag;
}

/** Every stack in both containers, for tests and for a conservation check. */
export function contentsOf(inventory: Inventory, equipment: Equipment): readonly ItemStack[] {
  const all: ItemStack[] = [];
  for (const stack of inventory) if (stack) all.push(stack);
  for (const slot of EQUIP_SLOTS) {
    const id = equipment[slot];
    if (id !== null) all.push({ defId: id, count: 1 });
  }
  return all;
}

/** `contentsOf` folded to a count per definition -- what conservation compares. */
export function tallyOf(inventory: Inventory, equipment: Equipment): ReadonlyMap<string, number> {
  const tally = new Map<string, number>();
  for (const stack of contentsOf(inventory, equipment)) {
    tally.set(stack.defId, (tally.get(stack.defId) ?? 0) + stack.count);
  }
  return tally;
}
