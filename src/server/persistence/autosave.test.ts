/**
 * Dirty tracking and the periodic flush (spec 226).
 *
 * The four properties `autosave.ts` claims, asserted rather than described. The
 * third and fourth are the ones worth having tests for, because they are the
 * ones that only fail under timing nobody reproduces by hand: a failed save
 * that clears the mark anyway, and two passes writing the same player.
 */

import { describe, expect, it } from 'vitest';
import { PlayerAutosave } from './autosave.js';
import { FlakyStore, managerFor, openTestStack } from './testing.js';

describe('autosave', () => {
  it('flushes a dirty player and clears the mark', async () => {
    const stack = openTestStack();
    try {
      const players = managerFor(stack.current.store);
      const autosave = new PlayerAutosave({ players, store: stack.current.store });

      await players.login('p_a', 'A');
      // Login writes, so nothing is owed yet.
      expect(players.isDirty('p_a')).toBe(false);

      players.syncFromEntity('p_a', { x: 10, y: 20, z: 0 }, 0.5, 55);
      expect(players.isDirty('p_a')).toBe(true);

      const result = await autosave.flush();
      expect(result).toMatchObject({ saved: 1, failed: 0, skipped: false });
      expect(players.isDirty('p_a')).toBe(false);

      const loaded = await stack.reopen().store.loadPlayer('p_a');
      expect(loaded?.position).toEqual({ x: 10, y: 20, z: 0 });
      expect(loaded?.health).toBe(55);
    } finally {
      stack.dispose();
    }
  });

  it('does nothing when nothing is dirty', async () => {
    const stack = openTestStack();
    try {
      const players = managerFor(stack.current.store);
      const autosave = new PlayerAutosave({ players, store: stack.current.store });
      await players.login('p_a', 'A');
      expect(await autosave.flush()).toMatchObject({ saved: 0, failed: 0 });
    } finally {
      stack.dispose();
    }
  });

  it('keeps a player dirty when the save fails, and saves it on the next pass', async () => {
    const stack = openTestStack();
    try {
      const store = new FlakyStore(stack.current.store);
      const players = managerFor(store);
      const failures: unknown[] = [];
      const autosave = new PlayerAutosave({
        players,
        store,
        onError: (error) => failures.push(error),
      });

      await players.login('p_b', 'B');
      players.syncFromEntity('p_b', { x: 5, y: 5, z: 0 }, 0, 77);

      store.failWith = 'disk on fire';
      const bad = await autosave.flush();
      expect(bad).toMatchObject({ saved: 0, failed: 1 });
      expect(failures).toHaveLength(1);
      // The whole point: the mark survives a failure.
      expect(players.isDirty('p_b')).toBe(true);

      store.failWith = null;
      const good = await autosave.flush();
      expect(good).toMatchObject({ saved: 1, failed: 0 });
      expect(players.isDirty('p_b')).toBe(false);

      const loaded = await stack.reopen().store.loadPlayer('p_b');
      expect(loaded?.health).toBe(77);
    } finally {
      stack.dispose();
    }
  });

  it('leaves a player dirty when they change during their own save', async () => {
    // The identity check in `clearDirtyIfUnchanged`. Without it the edit that
    // landed mid-write is marked clean and never saved.
    const stack = openTestStack();
    try {
      const players = managerFor(stack.current.store);
      // A one-shot hook: the flag rather than reassigning the closure from
      // inside itself, which narrows the binding to `never`.
      let editDuringSave = false;
      const store = {
        ...stack.current.store,
        savePlayers: async (records: Parameters<typeof stack.current.store.savePlayers>[0]) => {
          if (editDuringSave) {
            editDuringSave = false;
            players.syncFromEntity('p_c', { x: 2, y: 2, z: 0 }, 0, 20);
          }
          await stack.current.store.savePlayers(records);
        },
      } as typeof stack.current.store;

      const autosave = new PlayerAutosave({ players, store });
      await players.login('p_c', 'C');
      players.syncFromEntity('p_c', { x: 1, y: 1, z: 0 }, 0, 10);

      // A second move lands while the first snapshot is being written.
      editDuringSave = true;

      await autosave.flush();
      expect(players.isDirty('p_c')).toBe(true);

      await autosave.flush();
      expect(players.isDirty('p_c')).toBe(false);
      expect((await stack.reopen().store.loadPlayer('p_c'))?.position).toEqual({ x: 2, y: 2, z: 0 });
    } finally {
      stack.dispose();
    }
  });

  it('never runs two passes at once', async () => {
    const stack = openTestStack();
    try {
      const players = managerFor(stack.current.store);
      // The first write is held open until `release` is called, so the second
      // flush is guaranteed to arrive while the first is still running.
      const held: { resolve: (() => void) | null } = { resolve: null };
      const store = {
        ...stack.current.store,
        savePlayers: async (records: Parameters<typeof stack.current.store.savePlayers>[0]) => {
          await new Promise<void>((resolve) => {
            held.resolve = resolve;
          });
          await stack.current.store.savePlayers(records);
        },
      } as typeof stack.current.store;

      const autosave = new PlayerAutosave({ players, store });
      await players.login('p_d', 'D');
      players.syncFromEntity('p_d', { x: 3, y: 3, z: 0 }, 0, 30);

      const first = autosave.flush();
      // Let the first pass reach the store.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      const second = await autosave.flush();
      expect(second.skipped).toBe(true);

      held.resolve?.();
      expect(await first).toMatchObject({ saved: 1, skipped: false });
    } finally {
      stack.dispose();
    }
  });

  it('a forced flush waits for a pass in flight rather than skipping it', async () => {
    const stack = openTestStack();
    try {
      const players = managerFor(stack.current.store);
      // The first write is held for 20ms so the forced flush genuinely
      // overlaps it; every one after that is immediate.
      let slow = true;
      const store = {
        ...stack.current.store,
        savePlayers: async (records: Parameters<typeof stack.current.store.savePlayers>[0]) => {
          if (slow) {
            slow = false;
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
          await stack.current.store.savePlayers(records);
        },
      } as typeof stack.current.store;

      const autosave = new PlayerAutosave({ players, store });
      await players.login('p_e', 'E');
      players.syncFromEntity('p_e', { x: 9, y: 9, z: 0 }, 0, 90);

      const first = autosave.flush();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      // Forced: it waits the running pass out rather than reporting `skipped`,
      // which is what makes "flush everything before we exit" mean it.
      const forced = await autosave.flush({ force: true });
      expect(forced.skipped).toBe(false);
      await first;
      expect(players.isDirty('p_e')).toBe(false);
    } finally {
      stack.dispose();
    }
  });

  it('does not mark a player who is not logged in', async () => {
    const stack = openTestStack();
    try {
      const players = managerFor(stack.current.store);
      players.markDirty('p_ghost');
      expect(players.dirtyIds()).toEqual([]);
    } finally {
      stack.dispose();
    }
  });

  it('drops the mark on logout and writes what was owed', async () => {
    const stack = openTestStack();
    try {
      const players = managerFor(stack.current.store);
      await players.login('p_f', 'F');
      players.syncFromEntity('p_f', { x: 7, y: 8, z: 0 }, 0, 44);
      expect(players.isDirty('p_f')).toBe(true);

      await players.logout('p_f');
      expect(players.isDirty('p_f')).toBe(false);
      expect((await stack.reopen().store.loadPlayer('p_f'))?.position).toEqual({ x: 7, y: 8, z: 0 });
    } finally {
      stack.dispose();
    }
  });

  it('a disconnect whose save fails reports rather than throwing', async () => {
    const stack = openTestStack();
    try {
      const store = new FlakyStore(stack.current.store);
      const players = managerFor(store);
      const reported: string[] = [];
      players.onSaveError = (playerId): void => {
        reported.push(playerId);
      };

      await players.login('p_g', 'G');
      players.syncFromEntity('p_g', { x: 1, y: 2, z: 0 }, 0, 3);
      store.failWith = 'disk gone';

      // Does not throw: the session is over either way.
      await expect(players.logout('p_g')).resolves.toBeUndefined();
      expect(reported).toEqual(['p_g']);
    } finally {
      stack.dispose();
    }
  });

  it('an equip does not write, but leaves the player owing one', async () => {
    // The behaviour change this whole mechanism is: `recalculate` used to write
    // the entire record synchronously on every stat change.
    const stack = openTestStack();
    try {
      const store = new FlakyStore(stack.current.store);
      const players = managerFor(store);
      await players.login('p_h', 'H');
      const attemptsAfterLogin = store.attempts;

      await players.recalculate('p_h');
      expect(store.attempts).toBe(attemptsAfterLogin);
      expect(players.isDirty('p_h')).toBe(true);
    } finally {
      stack.dispose();
    }
  });

  it('start/stop does not leave a timer running', () => {
    const stack = openTestStack();
    try {
      const players = managerFor(stack.current.store);
      const autosave = new PlayerAutosave({ players, store: stack.current.store, intervalMs: 1000 });
      autosave.start();
      autosave.start(); // idempotent
      autosave.stop();
      autosave.stop();
    } finally {
      stack.dispose();
    }
  });
});
