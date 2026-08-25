/**
 * Guest play and claiming (spec 226).
 *
 * Requirements 5 and 6, which are the two halves of one promise: **you can play
 * without registering, and registering later does not cost you what you did.**
 *
 * The tests that matter most here are the negative ones. A guest player that
 * can be claimed twice is a stolen character; a claim that is not transactional
 * is an account owning nothing; and a login that overwrites an account's player
 * with a guest's is the one failure nobody can undo.
 */

import { describe, expect, it } from 'vitest';
import { managerFor, must, openTestStack } from '../persistence/testing.js';

const PASSWORD = 'a decent playtest password';

describe('guest play', () => {
  it('creates a player and a session with nothing typed', () => {
    const stack = openTestStack();
    try {
      const guest = stack.current.auth.createGuest('Wanderer');
      expect(guest.kind).toBe('guest');
      expect(guest.accountId).toBeNull();
      expect(guest.playerId).toMatch(/^p_[0-9a-f]{32}$/);
      // The player row is real: a guest's progression is persisted from tick one.
      expect(stack.current.store.players.exists(guest.playerId)).toBe(true);
    } finally {
      stack.dispose();
    }
  });

  it('reconnects with a valid guest session', () => {
    const stack = openTestStack();
    try {
      const guest = stack.current.auth.createGuest();
      const identity = stack.current.auth.resolve(guest.token);
      expect(identity?.playerId).toBe(guest.playerId);
      expect(identity?.kind).toBe('guest');
      expect(identity?.accountId).toBeNull();
    } finally {
      stack.dispose();
    }
  });

  it('rejects invalid guest credentials', () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      const guest = auth.createGuest();
      expect(auth.resolve('')).toBeNull();
      expect(auth.resolve('made-up-token')).toBeNull();
      // The player id is not a credential. This is the hole requirement 5 names.
      expect(auth.resolve(guest.playerId)).toBeNull();
    } finally {
      stack.dispose();
    }
  });

  it('a second client cannot take a guest player by knowing its id', async () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      const victim = auth.createGuest();
      // An attacker who has somehow learned the player id gets a *different*
      // player when they ask for a guest session, and cannot resolve the id.
      const attacker = auth.createGuest();
      expect(attacker.playerId).not.toBe(victim.playerId);
      expect(auth.resolve(victim.playerId)).toBeNull();
      // Nor can they claim it: a claim needs the guest's own token.
      await expect(
        auth.register({ login: 'thief', password: PASSWORD, guestToken: victim.playerId }),
      ).rejects.toMatchObject({ code: 'invalid_session' });
      expect(stack.current.store.players.ownership(victim.playerId)?.accountId).toBeNull();
    } finally {
      stack.dispose();
    }
  });

  it('guest progression and its session survive a restart', async () => {
    const stack = openTestStack();
    try {
      const guest = stack.current.auth.createGuest('Wanderer');
      const players = managerFor(stack.current.store);
      await players.login(guest.playerId, 'Wanderer');
      const record = must(players.recordOf(guest.playerId), 'guest record');
      await stack.current.store.savePlayer({ ...record, coins: 420, level: 6, experience: 1234 });

      // A restart must not destroy an otherwise valid guest player or session.
      const reopened = stack.reopen();
      expect(reopened.auth.resolve(guest.token)?.playerId).toBe(guest.playerId);
      const loaded = await reopened.store.loadPlayer(guest.playerId);
      expect(loaded?.coins).toBe(420);
      expect(loaded?.level).toBe(6);
    } finally {
      stack.dispose();
    }
  });
});

describe('claiming a guest player', () => {
  it('registers a new account over an existing guest and keeps every bit of progression', async () => {
    const stack = openTestStack();
    try {
      const { auth, store } = stack.current;
      const guest = auth.createGuest('Wanderer');

      // Play: gain levels, coins and an item.
      const players = managerFor(store);
      await players.login(guest.playerId, 'Wanderer');
      const played = must(players.recordOf(guest.playerId), 'guest record');
      const bag = [...played.inventory];
      bag[5] = { defId: 'gem.rough', count: 9 };
      await store.savePlayer({ ...played, coins: 777, level: 12, experience: 4321, inventory: bag });

      const claimed = await auth.register({
        login: 'ada',
        password: PASSWORD,
        displayName: 'Ada L',
        guestToken: guest.token,
      });

      // The same player, now owned by the new account.
      expect(claimed.playerId).toBe(guest.playerId);
      expect(claimed.kind).toBe('account');
      expect(store.players.ownership(guest.playerId)?.accountId).toBe(claimed.accountId);

      // And the progression is untouched.
      const after = await store.loadPlayer(guest.playerId);
      expect(after?.coins).toBe(777);
      expect(after?.level).toBe(12);
      expect(after?.experience).toBe(4321);
      expect(after?.inventory[5]).toEqual({ defId: 'gem.rough', count: 9 });

      // No second character was created.
      expect(await store.listPlayerIds()).toEqual([guest.playerId]);
    } finally {
      stack.dispose();
    }
  });

  it('rotates the guest credentials: the old token stops working, the new one works', async () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      const guest = auth.createGuest();
      const claimed = await auth.register({ login: 'ada', password: PASSWORD, guestToken: guest.token });

      expect(auth.resolve(guest.token)).toBeNull();
      expect(auth.resolve(claimed.token)?.playerId).toBe(guest.playerId);
      expect(auth.resolve(claimed.token)?.kind).toBe('account');
    } finally {
      stack.dispose();
    }
  });

  it('cannot be claimed twice', async () => {
    const stack = openTestStack();
    try {
      const { auth, store } = stack.current;
      const guest = auth.createGuest();
      // Two clients hold the same guest token -- a copied localStorage, say.
      const secondCopy = guest.token;

      const first = await auth.register({ login: 'ada', password: PASSWORD, guestToken: guest.token });
      await expect(
        auth.register({ login: 'bob', password: PASSWORD, guestToken: secondCopy }),
      ).rejects.toMatchObject({ code: 'invalid_session' });

      // Still exactly one owner, and the second account was rolled back.
      expect(store.players.ownership(guest.playerId)?.accountId).toBe(first.accountId);
      expect(stack.current.db.get<{ n: number }>('SELECT count(*) AS n FROM accounts')?.n).toBe(1);
    } finally {
      stack.dispose();
    }
  });

  it('cannot be claimed by an account session either', async () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      const guest = auth.createGuest();
      const claimed = await auth.register({ login: 'ada', password: PASSWORD, guestToken: guest.token });
      // Registering again with the *account* token is not a claim.
      await expect(
        auth.register({ login: 'bob', password: PASSWORD, guestToken: claimed.token }),
      ).rejects.toMatchObject({ code: 'already_claimed' });
    } finally {
      stack.dispose();
    }
  });

  it('the database refuses two players owned by one account', async () => {
    const stack = openTestStack();
    try {
      const { auth, store } = stack.current;
      const claimed = await auth.register({ login: 'ada', password: PASSWORD });
      const other = auth.createGuest();
      const accountId = must(claimed.accountId, 'account id');
      expect(() => store.players.attachToAccount(other.playerId, accountId)).toThrow(
        /UNIQUE constraint/i,
      );
    } finally {
      stack.dispose();
    }
  });

  it('a failed registration leaves the guest player intact and usable', async () => {
    const stack = openTestStack();
    try {
      const { auth, store } = stack.current;
      const guest = auth.createGuest();
      const players = managerFor(store);
      await players.login(guest.playerId, 'Wanderer');
      await store.savePlayer({ ...must(players.recordOf(guest.playerId)), coins: 55 });

      // The name is taken, so this registration fails after the guest was read.
      await auth.register({ login: 'ada', password: PASSWORD });
      await expect(
        auth.register({ login: 'ada', password: PASSWORD, guestToken: guest.token }),
      ).rejects.toMatchObject({ code: 'login_taken' });

      // Still a guest, still unowned, still playable, still holding its coins.
      expect(auth.resolve(guest.token)?.kind).toBe('guest');
      expect(store.players.ownership(guest.playerId)?.accountId).toBeNull();
      expect((await store.loadPlayer(guest.playerId))?.coins).toBe(55);
    } finally {
      stack.dispose();
    }
  });
});

describe('logging into an existing account while playing as a guest', () => {
  it('loads the account player and does not overwrite it with the guest', async () => {
    const stack = openTestStack();
    try {
      const { auth, store } = stack.current;

      // An established account with a real character.
      const established = await auth.register({ login: 'ada', password: PASSWORD });
      const players = managerFor(store);
      await players.login(established.playerId, 'Ada');
      await store.savePlayer({
        ...must(players.recordOf(established.playerId)),
        coins: 5000,
        level: 30,
        experience: 99_000,
      });

      // Somebody is playing as a guest on this machine, with different progress.
      const guest = auth.createGuest();
      await players.login(guest.playerId, 'Wanderer');
      await store.savePlayer({ ...must(players.recordOf(guest.playerId)), coins: 3, level: 2 });

      const result = await auth.login({ login: 'ada', password: PASSWORD, guestToken: guest.token });

      // The account's own player, untouched.
      expect(result.playerId).toBe(established.playerId);
      const account = await store.loadPlayer(established.playerId);
      expect(account?.coins).toBe(5000);
      expect(account?.level).toBe(30);

      // The guest character is not merged, not deleted, and still unowned.
      expect(result.retainedGuestPlayerId).toBe(guest.playerId);
      const stillThere = await store.loadPlayer(guest.playerId);
      expect(stillThere?.coins).toBe(3);
      expect(store.players.ownership(guest.playerId)?.accountId).toBeNull();
      // And still reachable with the credentials the client already holds, so
      // "your guest progress is not coming with you" is a warning rather than a
      // loss.
      expect(auth.resolve(guest.token)?.playerId).toBe(guest.playerId);
    } finally {
      stack.dispose();
    }
  });

  it('reports no retained guest when the caller was not playing as one', async () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      await auth.register({ login: 'ada', password: PASSWORD });
      const result = await auth.login({ login: 'ada', password: PASSWORD });
      expect(result.retainedGuestPlayerId).toBeNull();
    } finally {
      stack.dispose();
    }
  });
});
