/**
 * The name a character keeps after you register (spec 227).
 *
 * The bug these were written against: a claim attached the guest player to the
 * new account and never renamed it, so the account row said `Ada Lovelace`, the
 * session said `Ada Lovelace`, and `players.display_name` -- which is what the
 * game reads and what every other client is sent over the body -- still said
 * `Wanderer`.
 *
 * The half worth the most tests is the *live* one. Claiming happens while you
 * are playing, so `PlayerManager` holds the authoritative record and the next
 * autosave writes it over whatever the transaction put on disk. A database-only
 * fix passes the first test here and fails the flush one.
 */

import { describe, expect, it } from 'vitest';
import { PlayerAutosave } from '../persistence/autosave.js';
import { managerFor, must, openTestStack } from '../persistence/testing.js';

const PASSWORD = 'a decent playtest password';

/** Every rename the service announced, in order. */
function renameLog(): { seen: [string, string][]; onPlayerRenamed: (id: string, name: string) => void } {
  const seen: [string, string][] = [];
  return { seen, onPlayerRenamed: (id, name): void => void seen.push([id, name]) };
}

describe('a claim renames the character', () => {
  it('writes the new name to the row the game reads', async () => {
    const stack = openTestStack();
    try {
      const { auth, store } = stack.current;
      const guest = auth.createGuest();
      expect(store.players.displayNameOf(guest.playerId)).toBe('Wanderer');

      const claimed = await auth.register({
        login: 'ada',
        password: PASSWORD,
        displayName: 'Ada Lovelace',
        guestToken: guest.token,
      });

      expect(claimed.displayName).toBe('Ada Lovelace');
      expect(store.players.displayNameOf(guest.playerId)).toBe('Ada Lovelace');
      // The whole record, not just the column: `loadPlayer` is what a login
      // reads, and a name that only exists in one of the two is the bug in a
      // different hat.
      expect((await store.loadPlayer(guest.playerId))?.displayName).toBe('Ada Lovelace');
    } finally {
      stack.dispose();
    }
  });

  it('falls back to the login when no display name was typed', async () => {
    const stack = openTestStack();
    try {
      const { auth, store } = stack.current;
      const guest = auth.createGuest();
      await auth.register({ login: 'ada', password: PASSWORD, guestToken: guest.token });
      expect(store.players.displayNameOf(guest.playerId)).toBe('ada');
    } finally {
      stack.dispose();
    }
  });

  it('announces the rename once the transaction has committed', async () => {
    const log = renameLog();
    const stack = openTestStack({ onPlayerRenamed: log.onPlayerRenamed });
    try {
      const guest = stack.current.auth.createGuest();
      await stack.current.auth.register({
        login: 'ada',
        password: PASSWORD,
        displayName: 'Ada Lovelace',
        guestToken: guest.token,
      });
      expect(log.seen).toEqual([[guest.playerId, 'Ada Lovelace']]);
    } finally {
      stack.dispose();
    }
  });

  it('announces nothing when the registration was refused', async () => {
    const log = renameLog();
    const stack = openTestStack({ onPlayerRenamed: log.onPlayerRenamed });
    try {
      const { auth, store } = stack.current;
      await auth.register({ login: 'ada', password: PASSWORD, displayName: 'The First' });
      log.seen.length = 0;

      const guest = auth.createGuest();
      // `ada` is taken, so this rolls back -- account row included.
      await expect(
        auth.register({ login: 'ada', password: PASSWORD, displayName: 'Impostor', guestToken: guest.token }),
      ).rejects.toMatchObject({ code: 'login_taken' });

      expect(log.seen).toEqual([]);
      // And the guest is exactly as it was: unowned, unrenamed, still playable.
      expect(store.players.displayNameOf(guest.playerId)).toBe('Wanderer');
      expect(store.players.ownership(guest.playerId)?.accountId).toBeNull();
      expect(auth.resolve(guest.token)?.playerId).toBe(guest.playerId);
    } finally {
      stack.dispose();
    }
  });

  it('renames nobody when a second client claims the same guest', async () => {
    const log = renameLog();
    const stack = openTestStack({ onPlayerRenamed: log.onPlayerRenamed });
    try {
      const { auth, store } = stack.current;
      const guest = auth.createGuest();
      const copied = guest.token;
      await auth.register({ login: 'ada', password: PASSWORD, displayName: 'Ada', guestToken: guest.token });
      log.seen.length = 0;

      await expect(
        auth.register({ login: 'bob', password: PASSWORD, displayName: 'Bob', guestToken: copied }),
      ).rejects.toMatchObject({ code: 'invalid_session' });

      expect(log.seen).toEqual([]);
      expect(store.players.displayNameOf(guest.playerId)).toBe('Ada');
    } finally {
      stack.dispose();
    }
  });

  it('still names a fresh character when there is no guest to claim', async () => {
    const stack = openTestStack();
    try {
      const made = await stack.current.auth.register({
        login: 'bob',
        password: PASSWORD,
        displayName: 'Bobby',
      });
      expect(stack.current.store.players.displayNameOf(made.playerId)).toBe('Bobby');
    } finally {
      stack.dispose();
    }
  });
});

describe('logging in renames nothing', () => {
  it('leaves the account player and the guest player with their own names', async () => {
    const stack = openTestStack();
    try {
      const { auth, store } = stack.current;
      const account = await auth.register({ login: 'ada', password: PASSWORD, displayName: 'Ada' });
      const guest = auth.createGuest('Somebody Else');

      const signedIn = await auth.login({ login: 'ada', password: PASSWORD, guestToken: guest.token });

      expect(signedIn.playerId).toBe(account.playerId);
      expect(signedIn.retainedGuestPlayerId).toBe(guest.playerId);
      expect(store.players.displayNameOf(account.playerId)).toBe('Ada');
      expect(store.players.displayNameOf(guest.playerId)).toBe('Somebody Else');
    } finally {
      stack.dispose();
    }
  });
});

describe('the live record catches up', () => {
  it('survives the autosave that would otherwise write the old name back', async () => {
    const stack = openTestStack();
    try {
      const { auth, store } = stack.current;
      const guest = auth.createGuest();
      const players = managerFor(store);
      // Playing, which is what claiming means: the manager now holds the
      // authoritative record and the row is only a copy of it.
      await players.login(guest.playerId, 'Wanderer');

      const claimed = await auth.register({
        login: 'ada',
        password: PASSWORD,
        displayName: 'Ada Lovelace',
        guestToken: guest.token,
      });
      const autosave = new PlayerAutosave({ players, store, intervalMs: 1000 });

      // First, the hazard itself, demonstrated rather than assumed. The
      // transaction has written the new name to the row and the manager still
      // holds a record saying `Wanderer` -- so the next flush of this player,
      // for any reason at all, undoes the registration's own write.
      expect(store.players.displayNameOf(guest.playerId)).toBe('Ada Lovelace');
      players.markDirty(guest.playerId);
      await autosave.flush({ force: true });
      expect(store.players.displayNameOf(guest.playerId)).toBe('Wanderer');

      // Then the fix: the wiring `index.ts` does, by hand. The service
      // announced the rename and whoever holds the live record adopts it.
      expect(players.rename(claimed.playerId, claimed.displayName)).toBe(true);
      await autosave.flush({ force: true });

      expect(store.players.displayNameOf(guest.playerId)).toBe('Ada Lovelace');
      expect(must(players.recordOf(guest.playerId), 'record').displayName).toBe('Ada Lovelace');
    } finally {
      stack.dispose();
    }
  });

  it('replaces the record rather than mutating it, so a flush in flight cannot clear the mark', async () => {
    const stack = openTestStack();
    try {
      const { auth, store } = stack.current;
      const guest = auth.createGuest();
      const players = managerFor(store);
      await players.login(guest.playerId, 'Wanderer');
      const before = must(players.recordOf(guest.playerId), 'record');

      players.rename(guest.playerId, 'Ada Lovelace');
      const after = must(players.recordOf(guest.playerId), 'record');

      expect(after).not.toBe(before);
      expect(before.displayName).toBe('Wanderer');
      expect(players.isDirty(guest.playerId)).toBe(true);
      // A save that started before the rename holds `before`, so clearing the
      // mark on it must be refused -- what reached the disk was the old name.
      expect(players.clearDirtyIfUnchanged(guest.playerId, before)).toBe(false);
      expect(players.isDirty(guest.playerId)).toBe(true);
      expect(players.clearDirtyIfUnchanged(guest.playerId, after)).toBe(true);
    } finally {
      stack.dispose();
    }
  });

  it('is a no-op for a player nobody is logged in as, and for a name that has not moved', async () => {
    const stack = openTestStack();
    try {
      const { auth, store } = stack.current;
      const players = managerFor(store);
      const guest = auth.createGuest();

      // Nobody is playing this one: the row is already right and there is
      // nothing in memory to correct.
      expect(players.rename(guest.playerId, 'Ada')).toBe(false);

      await players.login(guest.playerId, 'Wanderer');
      expect(players.rename(guest.playerId, 'Wanderer')).toBe(false);
      expect(players.isDirty(guest.playerId)).toBe(false);
      expect(players.rename(guest.playerId, '')).toBe(false);
    } finally {
      stack.dispose();
    }
  });
});
