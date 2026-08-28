/**
 * The container's rules (spec 126).
 *
 * The property test at the bottom is the reason this file exists in this shape:
 * every hand-written case below asserts something a human thought of, and the
 * one invariant that actually matters -- that a move creates and destroys
 * nothing -- is the one a human will not find the hole in.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { itemById, maxStackOf, STARTING_KIT } from '../data/items.js';
import { MemoryDataStore } from '../state/memory-store.js';
import { ZoneManager } from '../world/zone-manager.js';
import { PlayerManager } from './player-manager.js';
import {
  EMPTY_EQUIPMENT,
  EQUIP_SLOTS,
  INVENTORY_SLOTS,
  emptyInventory,
  type Equipment,
  type Inventory,
  type ItemStack,
  type PersistedPlayer,
} from '../state/types.js';
import {
  addToInventory,
  applyMove,
  equipmentAddress,
  removeFromSlot,
  sanitizeInventory,
  tallyOf,
  type MoveRequest,
} from './inventory.js';

function bagOf(entries: Readonly<Record<number, ItemStack>>): Inventory {
  const bag = [...emptyInventory()];
  for (const [index, stack] of Object.entries(entries)) bag[Number(index)] = stack;
  return bag;
}

const inv = (index: number) => ({ container: 'inventory', index }) as const;

/** Both containers, so an assertion can talk about a move's whole result. */
function move(
  inventory: Inventory,
  equipment: Equipment,
  request: MoveRequest,
  level = 10,
): ReturnType<typeof applyMove> {
  return applyMove(inventory, equipment, request, level);
}

describe('applyMove', () => {
  it('moves a stack to an empty slot', () => {
    const bag = bagOf({ 0: { defId: 'sword.worn', count: 1 } });
    const result = move(bag, EMPTY_EQUIPMENT, { from: inv(0), to: inv(5) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inventory[0]).toBeNull();
    expect(result.inventory[5]).toEqual({ defId: 'sword.worn', count: 1 });
    expect(result.inventory).toHaveLength(INVENTORY_SLOTS);
  });

  it('never mutates what it was given', () => {
    const bag = bagOf({ 0: { defId: 'sword.worn', count: 1 } });
    const before = JSON.stringify({ bag, worn: EMPTY_EQUIPMENT });
    move(bag, EMPTY_EQUIPMENT, { from: inv(0), to: equipmentAddress('mainHand') });
    expect(JSON.stringify({ bag, worn: EMPTY_EQUIPMENT })).toBe(before);
  });

  it('equips an item the player is holding', () => {
    const bag = bagOf({ 3: { defId: 'sword.worn', count: 1 } });
    const result = move(bag, EMPTY_EQUIPMENT, { from: inv(3), to: equipmentAddress('mainHand') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.equipment.mainHand).toBe('sword.worn');
    expect(result.inventory[3]).toBeNull();
  });

  /**
   * The hole this whole spec exists to close: the old `equip` took an item id
   * off the wire and never asked whether the player had one.
   */
  it('refuses to equip an item the player does not hold', () => {
    const result = move(emptyInventory(), EMPTY_EQUIPMENT, {
      from: inv(3),
      to: equipmentAddress('mainHand'),
    });
    expect(result).toEqual({ ok: false, reason: 'source slot is empty' });
  });

  it('refuses the wrong slot, and changes nothing', () => {
    const bag = bagOf({ 0: { defId: 'sword.worn', count: 1 } });
    const result = move(bag, EMPTY_EQUIPMENT, { from: inv(0), to: equipmentAddress('head') });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('does not go in head');
  });

  it('refuses an item above the level requirement', () => {
    const bag = bagOf({ 0: { defId: 'sword.keen', count: 1 } });
    const result = move(bag, EMPTY_EQUIPMENT, { from: inv(0), to: equipmentAddress('mainHand') }, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('requires level 5');
  });

  /** Outgrowing nothing: the check is on the way in, never on the way out. */
  it('lets an under-levelled character take off what they are wearing', () => {
    const equipment: Equipment = { ...EMPTY_EQUIPMENT, mainHand: 'sword.keen' };
    const result = move(emptyInventory(), equipment, {
      from: equipmentAddress('mainHand'),
      to: inv(0),
    }, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.equipment.mainHand).toBeNull();
    expect(result.inventory[0]).toEqual({ defId: 'sword.keen', count: 1 });
  });

  it('swaps two occupied slots exactly', () => {
    const bag = bagOf({
      0: { defId: 'sword.worn', count: 1 },
      1: { defId: 'bow.hunting', count: 1 },
    });
    const result = move(bag, EMPTY_EQUIPMENT, { from: inv(0), to: inv(1) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inventory[0]).toEqual({ defId: 'bow.hunting', count: 1 });
    expect(result.inventory[1]).toEqual({ defId: 'sword.worn', count: 1 });
  });

  it('swaps a held weapon for a worn one', () => {
    const bag = bagOf({ 0: { defId: 'bow.hunting', count: 1 } });
    const equipment: Equipment = { ...EMPTY_EQUIPMENT, mainHand: 'sword.worn' };
    const result = move(bag, equipment, { from: inv(0), to: equipmentAddress('mainHand') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.equipment.mainHand).toBe('bow.hunting');
    expect(result.inventory[0]).toEqual({ defId: 'sword.worn', count: 1 });
  });

  it('merges two partial stacks and caps at maxStack', () => {
    const cap = maxStackOf('potion.minor');
    const bag = bagOf({
      0: { defId: 'potion.minor', count: 6 },
      1: { defId: 'potion.minor', count: cap - 2 },
    });
    const result = move(bag, EMPTY_EQUIPMENT, { from: inv(0), to: inv(1) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inventory[1]).toEqual({ defId: 'potion.minor', count: cap });
    // The remainder stays behind rather than vanishing.
    expect(result.inventory[0]).toEqual({ defId: 'potion.minor', count: 6 - 2 });
  });

  it('refuses to merge into a full stack', () => {
    const cap = maxStackOf('potion.minor');
    const bag = bagOf({
      0: { defId: 'potion.minor', count: 1 },
      1: { defId: 'potion.minor', count: cap },
    });
    expect(move(bag, EMPTY_EQUIPMENT, { from: inv(0), to: inv(1) })).toEqual({
      ok: false,
      reason: 'that stack is full',
    });
  });

  it('splits a stack into a free slot', () => {
    const bag = bagOf({ 0: { defId: 'potion.minor', count: 5 } });
    const result = move(bag, EMPTY_EQUIPMENT, { from: inv(0), to: inv(7), count: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inventory[0]).toEqual({ defId: 'potion.minor', count: 3 });
    expect(result.inventory[7]).toEqual({ defId: 'potion.minor', count: 2 });
  });

  it('refuses a split onto an occupied slot', () => {
    const bag = bagOf({
      0: { defId: 'potion.minor', count: 5 },
      1: { defId: 'sword.worn', count: 1 },
    });
    expect(move(bag, EMPTY_EQUIPMENT, { from: inv(0), to: inv(1), count: 2 })).toEqual({
      ok: false,
      reason: 'a split needs an empty slot',
    });
  });

  it('refuses more than the source holds', () => {
    const bag = bagOf({ 0: { defId: 'potion.minor', count: 2 } });
    expect(move(bag, EMPTY_EQUIPMENT, { from: inv(0), to: inv(1), count: 3 })).toEqual({
      ok: false,
      reason: 'not that many to move',
    });
  });

  it('refuses rather than throwing on nonsense', () => {
    const bag = bagOf({ 0: { defId: 'potion.minor', count: 2 } });
    for (const request of [
      { from: inv(-1), to: inv(0) },
      { from: inv(0), to: inv(INVENTORY_SLOTS) },
      { from: inv(0), to: { container: 'equipment', index: EQUIP_SLOTS.length } as const },
      { from: inv(0), to: inv(0) },
      { from: inv(0), to: inv(1), count: -1 },
      { from: inv(0), to: inv(1), count: 1.5 },
    ] satisfies MoveRequest[]) {
      expect(move(bag, EMPTY_EQUIPMENT, request).ok).toBe(false);
    }
  });

  it('refuses a stack of something the table no longer defines', () => {
    const bag = bagOf({ 0: { defId: 'sword.imaginary', count: 1 } });
    expect(move(bag, EMPTY_EQUIPMENT, { from: inv(0), to: inv(1) })).toEqual({
      ok: false,
      reason: 'no such item: sword.imaginary',
    });
  });

  it('refuses to equip more than one of something', () => {
    const bag = bagOf({ 0: { defId: 'potion.minor', count: 3 } });
    expect(
      move(bag, EMPTY_EQUIPMENT, { from: inv(0), to: equipmentAddress('trinket') }).ok,
    ).toBe(false);
  });
});

// --- the property ------------------------------------------------------

const ITEM_IDS = ['sword.worn', 'bow.hunting', 'chest.leather', 'potion.minor'] as const;

const arbStack = fc
  .record({ defId: fc.constantFrom(...ITEM_IDS), count: fc.integer({ min: 1, max: 12 }) })
  .map((stack) => ({ defId: stack.defId, count: Math.min(stack.count, maxStackOf(stack.defId)) }));

const arbInventory = fc
  .array(fc.option(arbStack, { nil: null }), { minLength: INVENTORY_SLOTS, maxLength: INVENTORY_SLOTS })
  .map((bag): Inventory => bag);

/** A legal starting wardrobe: each slot empty, or holding something that fits. */
const arbEquipment = fc
  .record({
    mainHand: fc.constantFrom<string | null>(null, 'sword.worn', 'bow.hunting'),
    chest: fc.constantFrom<string | null>(null, 'chest.leather'),
  })
  .map((worn): Equipment => ({ ...EMPTY_EQUIPMENT, ...worn }));

const arbAddress = fc.oneof(
  fc.integer({ min: -2, max: INVENTORY_SLOTS + 1 }).map((index) => inv(index)),
  fc
    .integer({ min: -1, max: EQUIP_SLOTS.length })
    .map((index) => ({ container: 'equipment', index }) as const),
);

/**
 * A move, including nonsensical ones: out-of-range indices, negative counts and
 * counts larger than any stack. A generator that only produced legal requests
 * would only test the half of the code that says yes.
 */
const arbRequest: fc.Arbitrary<MoveRequest> = fc
  .record({
    from: arbAddress,
    to: arbAddress,
    count: fc.option(fc.integer({ min: -1, max: 14 }), { nil: null }),
  })
  .map(({ from, to, count }): MoveRequest => ({ from, to, ...(count === null ? {} : { count }) }));

describe('conservation', () => {
  /**
   * Nothing is created and nothing is destroyed -- by an accepted move *or* by a
   * refused one. Both halves matter: a refusal that half-applied would be a
   * duplication bug that every hand-written test above would still pass.
   */
  it('holds over a random sequence of moves', () => {
    fc.assert(
      fc.property(
        arbInventory,
        arbEquipment,
        fc.array(arbRequest, { maxLength: 24 }),
        fc.integer({ min: 1, max: 12 }),
        (startBag, startWorn, requests, level) => {
          let bag = startBag;
          let worn = startWorn;
          const expected = tallyOf(bag, worn);

          for (const request of requests) {
            const result = applyMove(bag, worn, request, level);
            if (result.ok) {
              bag = result.inventory;
              worn = result.equipment;
            }
            expect(tallyOf(bag, worn)).toEqual(expected);

            // ...and every accepted state is a legal one.
            expect(bag).toHaveLength(INVENTORY_SLOTS);
            for (const stack of bag) {
              if (!stack) continue;
              expect(stack.count).toBeGreaterThanOrEqual(1);
              expect(stack.count).toBeLessThanOrEqual(maxStackOf(stack.defId));
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  /** Equipment only ever holds items whose row says they go there. */
  it('never lets an item into a slot it does not belong in', () => {
    fc.assert(
      fc.property(arbInventory, fc.array(arbRequest, { maxLength: 16 }), (startBag, requests) => {
        let bag = startBag;
        let worn: Equipment = EMPTY_EQUIPMENT;
        for (const request of requests) {
          const result = applyMove(bag, worn, request, 12);
          if (!result.ok) continue;
          bag = result.inventory;
          worn = result.equipment;
          for (const slot of EQUIP_SLOTS) {
            const id = worn[slot];
            if (id === null) continue;
            expect(itemById(id)?.slot).toBe(slot);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

// --- grants and loading ------------------------------------------------

describe('addToInventory', () => {
  it('fills a partial stack before taking a fresh slot', () => {
    const bag = bagOf({ 0: { defId: 'potion.minor', count: maxStackOf('potion.minor') - 1 } });
    const next = addToInventory(bag, { defId: 'potion.minor', count: 3 });
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next[0]).toEqual({ defId: 'potion.minor', count: maxStackOf('potion.minor') });
    expect(next[1]).toEqual({ defId: 'potion.minor', count: 2 });
  });

  it('answers null when there is no room', () => {
    const full = [...emptyInventory()].map(() => ({ defId: 'sword.worn', count: 1 }));
    expect(addToInventory(full, { defId: 'sword.worn', count: 1 })).toBeNull();
  });
});

describe('loading a character', () => {
  /** A save written before spec 126 has no bag. Nobody is stripped by that. */
  it('loads a save with no inventory field as empty, keeping its equipment', async () => {
    const store = new MemoryDataStore();
    const manager = new PlayerManager(store, new ZoneManager());
    const first = await manager.login('p1', 'P1');
    // Exactly the shape on disk before this spec: every other field, no bag.
    const legacy: Record<string, unknown> = { ...first.record };
    delete legacy['inventory'];
    await manager.logout('p1');
    // Written *after* the logout, so what is on disk is the old shape and not
    // the record this session happened to save on its way out.
    await store.savePlayer({
      ...legacy,
      equipment: { ...EMPTY_EQUIPMENT, head: 'helm.plated' },
    } as PersistedPlayer);

    const reloaded = await manager.login('p1', 'P1');
    expect(reloaded.record.inventory).toEqual(emptyInventory());
    expect(reloaded.record.equipment.head).toBe('helm.plated');
  });

  it('grants a starting kit, and does not hand over a second copy of what is worn', async () => {
    const manager = new PlayerManager(new MemoryDataStore(), new ZoneManager());
    const fresh = await manager.login('p1', 'P1');
    const tally = tallyOf(fresh.record.inventory, fresh.record.equipment);
    for (const entry of STARTING_KIT) expect(tally.get(entry.defId)).toBe(entry.count);
  });

  it('lets a fresh character equip what it was given, and nothing else', async () => {
    const manager = new PlayerManager(new MemoryDataStore(), new ZoneManager());
    await manager.login('p1', 'P1');
    expect(await manager.equip('p1', 'mainHand', 'bow.hunting')).toMatchObject({ ok: true });
    expect(await manager.equip('p1', 'mainHand', 'staff.emberwood')).toMatchObject({ ok: false });
  });
});

describe('sanitizeInventory', () => {
  it('loads an absent bag as empty', () => {
    expect(sanitizeInventory(undefined)).toEqual(emptyInventory());
  });

  it('drops what the table no longer defines and caps what grew', () => {
    const loaded = sanitizeInventory([
      { defId: 'sword.imaginary', count: 1 },
      { defId: 'potion.minor', count: 9999 },
      { defId: 'sword.worn', count: 0 },
    ]);
    expect(loaded[0]).toBeNull();
    expect(loaded[1]).toEqual({ defId: 'potion.minor', count: maxStackOf('potion.minor') });
    expect(loaded[2]).toBeNull();
    expect(loaded).toHaveLength(INVENTORY_SLOTS);
  });
});

/**
 * Taking something out of a slot with nowhere to put it (spec 172).
 *
 * The half of a drop that is a container rule. Where the item goes afterwards is
 * the world's problem and is tested over a real wire in `drop-wire.test.ts`;
 * what is here is the one property that matters at this layer -- what leaves the
 * containers is exactly what is handed back, and a refusal hands back nothing
 * and changes nothing.
 */
describe('removeFromSlot', () => {
  it('takes a whole stack and empties the slot', () => {
    const bag = bagOf({ 2: { defId: 'potion.minor', count: 3 } });
    const outcome = removeFromSlot(bag, EMPTY_EQUIPMENT, { container: 'inventory', index: 2 });
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.taken).toEqual({ defId: 'potion.minor', count: 3 });
    expect(outcome.inventory[2]).toBeNull();
  });

  it('takes part of a stack and leaves the rest', () => {
    const bag = bagOf({ 0: { defId: 'potion.minor', count: 5 } });
    const outcome = removeFromSlot(bag, EMPTY_EQUIPMENT, { container: 'inventory', index: 0 }, 2);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.taken).toEqual({ defId: 'potion.minor', count: 2 });
    expect(outcome.inventory[0]).toEqual({ defId: 'potion.minor', count: 3 });
  });

  /** Nothing is checked on the way out -- the rule `equipRefusal` states. */
  it('takes what is worn straight off the body', () => {
    const worn: Equipment = { ...EMPTY_EQUIPMENT, mainHand: 'sword.worn' };
    const outcome = removeFromSlot(emptyInventory(), worn, equipmentAddress('mainHand'));
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.taken).toEqual({ defId: 'sword.worn', count: 1 });
    expect(outcome.equipment.mainHand).toBeNull();
  });

  it.each([
    ['an empty slot', { container: 'inventory' as const, index: 5 }, undefined],
    ['a slot that does not exist', { container: 'inventory' as const, index: -1 }, undefined],
    ['more than is there', { container: 'inventory' as const, index: 0 }, 9],
    ['a fractional count', { container: 'inventory' as const, index: 0 }, 1.5],
    ['nothing at all', { container: 'inventory' as const, index: 0 }, 0],
  ])('refuses %s, changing nothing', (_what, at, count) => {
    const bag = bagOf({ 0: { defId: 'potion.minor', count: 3 } });
    const outcome = removeFromSlot(bag, EMPTY_EQUIPMENT, at, count);
    expect(outcome.ok).toBe(false);
    expect(bag[0]).toEqual({ defId: 'potion.minor', count: 3 });
  });

  it('conserves: what left the containers is exactly what came back', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: INVENTORY_SLOTS - 1 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 8 }),
        (index, held, wanted) => {
          const bag = bagOf({ [index]: { defId: 'potion.minor', count: held } });
          const before = tallyOf(bag, EMPTY_EQUIPMENT).get('potion.minor') ?? 0;
          const outcome = removeFromSlot(bag, EMPTY_EQUIPMENT, { container: 'inventory', index }, wanted);
          if (!outcome.ok) {
            // A refusal is allowed, but only for asking for more than is there.
            expect(wanted).toBeGreaterThan(held);
            return;
          }
          const after = tallyOf(outcome.inventory, outcome.equipment).get('potion.minor') ?? 0;
          expect(after + outcome.taken.count).toBe(before);
        },
      ),
    );
  });
});
