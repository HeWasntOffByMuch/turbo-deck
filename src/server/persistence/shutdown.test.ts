/**
 * Shutdown flushing, at the service level (spec 226).
 *
 * The shape requirement 9 asks for: a dirty player, a shutdown, a reopened
 * database, and the latest state on disk. Driven through the real
 * `GameServer.stop()` and the real `PlayerAutosave`, because the wiring between
 * them -- `onFlush`, called between the last connection closing and the store
 * closing -- is exactly the part that can be absent while every unit around it
 * passes.
 *
 * What is deliberately not done here is send a signal. The handlers live in
 * `index.ts` and killing the test runner to check them would be a brittle test
 * of a two-line binding; what they *call* is all asserted below.
 */

import { describe, expect, it } from 'vitest';
import { createShutdown } from './shutdown.js';
import { GameServer } from '../server.js';
import type { DataStore } from '../state/store.js';
import { PlayerAutosave } from './autosave.js';
import { FlakyStore, openTestStack } from './testing.js';

/** A server wired the way `index.ts` wires one, minus the sockets. */
function serverOver(stack: ReturnType<typeof openTestStack>, store: DataStore = stack.current.store): {
  readonly server: GameServer;
  readonly autosave: PlayerAutosave;
  readonly failures: unknown[];
} {
  const failures: unknown[] = [];
  const server = new GameServer({ store });
  const autosave = new PlayerAutosave({
    players: server.playerManager,
    store,
    onError: (error) => failures.push(error),
  });
  server.onFlush = async (): Promise<void> => {
    await autosave.flush({ force: true });
  };
  return { server, autosave, failures };
}

describe('graceful shutdown', () => {
  it('flushes dirty players before closing the database', async () => {
    const stack = openTestStack();
    try {
      const { server } = serverOver(stack);
      await server.playerManager.login('p_a', 'A');
      server.playerManager.syncFromEntity('p_a', { x: 111, y: 222, z: 0 }, 1.5, 31);
      expect(server.dirtyPlayerCount()).toBe(1);

      await server.stop();
      expect(server.dirtyPlayerCount()).toBe(0);
      // The store is closed, so this has to be a fresh connection over the file.
      const reopened = stack.reopen();
      const loaded = await reopened.store.loadPlayer('p_a');
      expect(loaded?.position).toEqual({ x: 111, y: 222, z: 0 });
      expect(loaded?.health).toBe(31);
    } finally {
      stack.dispose();
    }
  });

  it('flushes several players in one shutdown', async () => {
    const stack = openTestStack();
    try {
      const { server } = serverOver(stack);
      for (const id of ['p_a', 'p_b', 'p_c']) {
        await server.playerManager.login(id, id);
        server.playerManager.syncFromEntity(id, { x: 1, y: 2, z: 0 }, 0, 42);
      }
      expect(server.dirtyPlayerCount()).toBe(3);

      await server.stop();
      const reopened = stack.reopen();
      for (const id of ['p_a', 'p_b', 'p_c']) {
        expect((await reopened.store.loadPlayer(id))?.health).toBe(42);
      }
    } finally {
      stack.dispose();
    }
  });

  it('closes the database even when the flush fails, and says who was stranded', async () => {
    const stack = openTestStack();
    try {
      const store = new FlakyStore(stack.current.store);
      const { server, failures } = serverOver(stack, store);
      await server.playerManager.login('p_a', 'A');
      server.playerManager.syncFromEntity('p_a', { x: 9, y: 9, z: 0 }, 0, 5);

      store.failWith = 'disk gone';
      await server.stop();

      // Reported, not swallowed -- and the player is still marked, which is
      // what `dirtyPlayerCount` reports to the shutdown log.
      expect(failures).toHaveLength(1);
      expect(server.dirtyPlayerCount()).toBe(1);
    } finally {
      stack.dispose();
    }
  });

  it('stopping twice does not throw', async () => {
    const stack = openTestStack();
    try {
      const { server } = serverOver(stack);
      await server.playerManager.login('p_a', 'A');
      await server.stop();
      // `Db.close` is idempotent, which is what makes a second teardown safe
      // even though `index.ts` also guards against reaching one.
      await expect(server.stop()).resolves.toBeUndefined();
    } finally {
      stack.dispose();
    }
  });

  it('a server with no flush hook still shuts down (the in-tab case)', async () => {
    const stack = openTestStack();
    try {
      const server = new GameServer({ store: stack.current.store });
      await server.playerManager.login('p_a', 'A');
      await expect(server.stop()).resolves.toBeUndefined();
    } finally {
      stack.dispose();
    }
  });

  it('an autosaved player is already safe before the shutdown', async () => {
    // The flush is a safety net, not the mechanism: the interval has already
    // written this player, so the shutdown finds nothing owed.
    const stack = openTestStack();
    try {
      const { server, autosave } = serverOver(stack);
      await server.playerManager.login('p_a', 'A');
      server.playerManager.syncFromEntity('p_a', { x: 4, y: 4, z: 0 }, 0, 12);
      await autosave.flush();
      expect(server.dirtyPlayerCount()).toBe(0);

      await server.stop();
      expect((await stack.reopen().store.loadPlayer('p_a'))?.health).toBe(12);
    } finally {
      stack.dispose();
    }
  });
});

describe('the shutdown handler', () => {
  /** A handler wired to observers rather than to a process. */
  function handler(overrides: Partial<Parameters<typeof createShutdown>[0]> = {}) {
    const logs: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    const timers: (() => void)[] = [];
    // A box rather than a plain counter, so the helper can hand back a live
    // view of it without a getter.
    const state = { stops: 0 };
    const run = createShutdown({
      timeoutMs: 10_000,
      stop: async (): Promise<void> => {
        state.stops += 1;
      },
      exit: (code): void => {
        exits.push(code);
      },
      log: (line): void => {
        logs.push(line);
      },
      logError: (line): void => {
        errors.push(line);
      },
      // The bound, made drivable: nothing waits ten seconds.
      setTimer: (fn) => {
        timers.push(fn);
        // Nothing to cancel: the test fires timers by hand.
        return { cancel: (): void => undefined };
      },
      ...overrides,
    });
    return {
      run,
      logs,
      errors,
      exits,
      state,
      /** Trip the shutdown's own bound, without waiting ten seconds for it. */
      fire: (): void => timers.forEach((fn) => fn()),
    };
  }

  it('runs the teardown once and exits zero', async () => {
    const h = handler();
    h.run('SIGTERM');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.state.stops).toBe(1);
    expect(h.exits).toEqual([0]);
    expect(h.logs.some((line) => line.includes('graceful shutdown complete'))).toBe(true);
  });

  it('refuses a second signal rather than tearing down twice', async () => {
    const h = handler();
    h.run('SIGINT');
    h.run('SIGINT');
    h.run('SIGTERM');
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The property: one teardown, one exit, however many signals arrive.
    expect(h.state.stops).toBe(1);
    expect(h.exits).toEqual([0]);
    expect(h.logs.filter((line) => line.includes('already shutting down'))).toHaveLength(2);
  });

  it('exits non-zero when the teardown hangs, and names what was stranded', () => {
    const h = handler({
      // Never settles: a wedged database.
      stop: () => new Promise<void>(() => undefined),
      strandedPlayers: () => 3,
    });
    h.run('SIGTERM');
    h.fire();

    expect(h.exits).toEqual([1]);
    expect(h.errors[0]).toContain('3 player(s) were not flushed');
    expect(h.errors[0]).toContain('last autosave');
  });

  it('says so plainly when a timeout stranded nothing', () => {
    const h = handler({ stop: () => new Promise<void>(() => undefined), strandedPlayers: () => 0 });
    h.run('SIGTERM');
    h.fire();
    expect(h.errors[0]).toContain('already been flushed');
  });

  it('exits non-zero when the teardown throws', async () => {
    const h = handler({ stop: () => Promise.reject(new Error('database is on fire')) });
    h.run('SIGTERM');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.exits).toEqual([1]);
    expect(h.errors[0]).toContain('database is on fire');
  });

  it('still tears down when the synchronous cleanup throws', async () => {
    const h = handler({
      before: (): void => {
        throw new Error('timer already gone');
      },
    });
    h.run('SIGTERM');
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The flush is the part that matters; a failure tidying up must not skip it.
    expect(h.state.stops).toBe(1);
    expect(h.exits).toEqual([0]);
    expect(h.errors[0]).toContain('cleanup failed');
  });
});
