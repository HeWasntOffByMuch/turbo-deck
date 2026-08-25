/**
 * Trades commit atomically, or not at all (spec 226).
 *
 * The requirement in one sentence: **there must never be a committed state
 * where one half of a trade happened and the other did not.** So the tests do
 * not check that a trade "worked" -- they force a failure *between* the two
 * writes and then assert both bags, in memory and on disk, are exactly as they
 * were before anybody agreed to anything.
 *
 * The failure is a real database abort rather than a mocked rejection: a BEFORE
 * UPDATE trigger that raises on one player's row. That means what is being
 * tested is SQLite's ROLLBACK, which is the thing actually relied on, rather
 * than a stub's idea of one.
 */

import { describe, expect, it } from 'vitest';
import { newCharacter } from '../player/player-manager.js';
import { INVENTORY_SLOTS, type Inventory, type PersistedPlayer } from '../state/types.js';
import type { Holdings } from '../player/trade.js';
import { managerFor, must, openTestStack } from './testing.js';

function bagWith(entries: Record<number, { defId: string; count: number }>): Inventory {
  const bag = new Array<PersistedPlayer['inventory'][number]>(INVENTORY_SLOTS).fill(null);
  for (const [index, stack] of Object.entries(entries)) bag[Number(index)] = stack;
  return bag;
}

/** Raise on any UPDATE of this player's row, the way a failing disk would. */
function breakWritesFor(db: { exec: (sql: string) => void }, playerId: string): void {
  db.exec(`
    CREATE TRIGGER fail_${playerId} BEFORE UPDATE ON players
    WHEN NEW.id = '${playerId}'
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;
  `);
}

describe('trade persistence', () => {
  it('moves an item from A to B, and both sides survive a restart', async () => {
    const stack = openTestStack();
    try {
      const players = managerFor(stack.current.store);
      await players.login('p_alice', 'Alice');
      await players.login('p_bob', 'Bob');

      // Alice has the sword and 100 coins; Bob has an empty bag and 20.
      const alice: Holdings = { inventory: bagWith({ 0: { defId: 'sword.worn', count: 1 } }), coins: 100 };
      const bob: Holdings = { inventory: bagWith({}), coins: 20 };
      await players.applyTrade('p_alice', 'p_bob', alice, bob);

      // The exchange: Alice gives the sword, Bob gives 30 coins.
      const afterA: Holdings = { inventory: bagWith({}), coins: 130 };
      const afterB: Holdings = { inventory: bagWith({ 0: { defId: 'sword.worn', count: 1 } }), coins: 0 };
      const written = await players.applyTrade('p_alice', 'p_bob', afterA, afterB);
      expect(written.ok).toBe(true);

      const reopened = stack.reopen();
      const savedA = await reopened.store.loadPlayer('p_alice');
      const savedB = await reopened.store.loadPlayer('p_bob');
      expect(savedA?.inventory[0]).toBeNull();
      expect(savedA?.coins).toBe(130);
      expect(savedB?.inventory[0]).toEqual({ defId: 'sword.worn', count: 1 });
      expect(savedB?.coins).toBe(0);

      // Counted together, because a swap that duplicated the sword leaves each
      // bag individually plausible (the rule `trade.test.ts` already follows).
      const swords =
        (savedA?.inventory.filter((slot) => slot?.defId === 'sword.worn').length ?? 0) +
        (savedB?.inventory.filter((slot) => slot?.defId === 'sword.worn').length ?? 0);
      expect(swords).toBe(1);
      expect((savedA?.coins ?? 0) + (savedB?.coins ?? 0)).toBe(130);
    } finally {
      stack.dispose();
    }
  });

  it('rolls the whole exchange back when the second write fails', async () => {
    const stack = openTestStack();
    try {
      const players = managerFor(stack.current.store);
      await players.login('p_alice', 'Alice');
      await players.login('p_bob', 'Bob');

      const startA: Holdings = { inventory: bagWith({ 0: { defId: 'sword.worn', count: 1 } }), coins: 100 };
      const startB: Holdings = { inventory: bagWith({}), coins: 50 };
      await players.applyTrade('p_alice', 'p_bob', startA, startB);

      // Bob's row is the second one written, and it now refuses.
      breakWritesFor(stack.current.db, 'p_bob');

      const swapped = await players.applyTrade(
        'p_alice',
        'p_bob',
        { inventory: bagWith({}), coins: 150 },
        { inventory: bagWith({ 0: { defId: 'sword.worn', count: 1 } }), coins: 0 },
      );
      expect(swapped.ok).toBe(false);
      expect(swapped.reason).toMatch(/could not be recorded/);

      // In memory: untouched. The exchange is persisted before it is committed,
      // so a refused write is a trade that simply did not happen.
      expect(players.holdingsOf('p_alice')?.coins).toBe(100);
      expect(players.holdingsOf('p_bob')?.coins).toBe(50);
      expect(players.holdingsOf('p_alice')?.inventory[0]).toEqual({ defId: 'sword.worn', count: 1 });
      expect(players.holdingsOf('p_bob')?.inventory[0]).toBeNull();

      // On disk: Alice's half was written first inside the transaction and must
      // have been rolled back with Bob's. This is the assertion the whole
      // feature exists for.
      const savedA = await stack.current.store.loadPlayer('p_alice');
      const savedB = await stack.current.store.loadPlayer('p_bob');
      expect(savedA?.coins).toBe(100);
      expect(savedA?.inventory[0]).toEqual({ defId: 'sword.worn', count: 1 });
      expect(savedB?.coins).toBe(50);
      expect(savedB?.inventory[0]).toBeNull();
    } finally {
      stack.dispose();
    }
  });

  it('the rollback survives a restart: no half-trade is on disk', async () => {
    const stack = openTestStack();
    try {
      const players = managerFor(stack.current.store);
      await players.login('p_alice', 'Alice');
      await players.login('p_bob', 'Bob');
      await players.applyTrade(
        'p_alice',
        'p_bob',
        { inventory: bagWith({ 3: { defId: 'potion.minor', count: 2 } }), coins: 10 },
        { inventory: bagWith({}), coins: 10 },
      );

      breakWritesFor(stack.current.db, 'p_bob');
      await players.applyTrade(
        'p_alice',
        'p_bob',
        { inventory: bagWith({}), coins: 10 },
        { inventory: bagWith({ 3: { defId: 'potion.minor', count: 2 } }), coins: 10 },
      );

      const reopened = stack.reopen();
      const savedA = await reopened.store.loadPlayer('p_alice');
      const savedB = await reopened.store.loadPlayer('p_bob');
      expect(savedA?.inventory[3]).toEqual({ defId: 'potion.minor', count: 2 });
      expect(savedB?.inventory[3]).toBeNull();
    } finally {
      stack.dispose();
    }
  });

  it('does not wait for the autosave loop: the trade is on disk immediately', async () => {
    const stack = openTestStack();
    try {
      const players = managerFor(stack.current.store);
      await players.login('p_alice', 'Alice');
      await players.login('p_bob', 'Bob');

      await players.applyTrade(
        'p_alice',
        'p_bob',
        { inventory: bagWith({ 1: { defId: 'gem.rough', count: 3 } }), coins: 5 },
        { inventory: bagWith({}), coins: 5 },
      );

      // No flush has been called. The row is already there.
      const row = stack.current.db.get<{ data: string }>('SELECT data FROM players WHERE id = ?', 'p_alice');
      expect(row?.data).toContain('gem.rough');
      // And neither side is left owing a save.
      expect(players.isDirty('p_alice')).toBe(false);
      expect(players.isDirty('p_bob')).toBe(false);
    } finally {
      stack.dispose();
    }
  });

  it('refuses when one side is not logged in, and writes nothing', async () => {
    const stack = openTestStack();
    try {
      const players = managerFor(stack.current.store);
      await players.login('p_alice', 'Alice');
      const result = await players.applyTrade(
        'p_alice',
        'p_absent',
        { inventory: bagWith({}), coins: 0 },
        { inventory: bagWith({}), coins: 0 },
      );
      expect(result.ok).toBe(false);
      expect(await stack.current.store.loadPlayer('p_absent')).toBeNull();
    } finally {
      stack.dispose();
    }
  });

  it('savePlayers is one transaction: a mid-batch failure writes none of it', async () => {
    // The primitive underneath, tested directly -- a trade is the caller that
    // needs it, but any future two-party operation gets the same guarantee.
    const stack = openTestStack();
    try {
      const store = stack.current.store;
      await store.savePlayer(newCharacter('p_x', 'X', 'hub'));
      await store.savePlayer(newCharacter('p_y', 'Y', 'hub'));
      breakWritesFor(stack.current.db, 'p_y');

      const x = must(await store.loadPlayer('p_x'), 'p_x');
      const y = must(await store.loadPlayer('p_y'), 'p_y');
      await expect(store.savePlayers([{ ...x, coins: 777 }, { ...y, coins: 888 }])).rejects.toThrow();

      expect((await store.loadPlayer('p_x'))?.coins).toBe(x.coins);
      expect((await store.loadPlayer('p_y'))?.coins).toBe(y.coins);
    } finally {
      stack.dispose();
    }
  });
});
