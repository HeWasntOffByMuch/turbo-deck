/**
 * The auth gate, through the real message path (spec 224).
 *
 * The claim being tested is the one the acceptance criteria state and no unit
 * test of `AuthService` can make: **against a server that authenticates,
 * knowing a player id gets you nothing.** So these go through
 * `GameServer.receive` with real encoded frames, the way `server.test.ts` does,
 * rather than calling `resolve` directly.
 *
 * The other half is just as important and is the last test here: a server with
 * no gate behaves exactly as it always has, because that is what the in-tab
 * single-player server, the bot harness and every other test in this tree rely
 * on.
 */

import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../config.js';
import { decodeServerMessage, encodeClientMessage, type ServerMessage } from '../net/messages.js';
import { ClientMessageType, ServerMessageType } from '../net/protocol.js';
import { GameServer } from '../server.js';
import { openTestStack } from '../persistence/testing.js';

const PASSWORD = 'a decent playtest password';

class Client {
  readonly received: ServerMessage[] = [];
  readonly connection: ReturnType<GameServer['createLocalConnection']>;

  constructor(private readonly server: GameServer) {
    this.connection = server.createLocalConnection((bytes) => {
      const type = bytes[0] ?? 0;
      // Admin replies are out of range here; every frame is a server message.
      if (type >= 0xa0 && type <= 0xbf) return;
      this.received.push(decodeServerMessage(bytes));
    });
  }

  async hello(playerId: string, authToken = ''): Promise<void> {
    await this.server.receive(
      this.connection,
      encodeClientMessage({
        type: ClientMessageType.Hello,
        protocolVersion: PROTOCOL_VERSION,
        playerId,
        displayName: playerId,
        token: '',
        assetManifest: '',
        resumeToken: '',
        authToken,
      }),
    );
  }

  welcome(): Extract<ServerMessage, { type: typeof ServerMessageType.Welcome }> | undefined {
    return this.received.find((m) => m.type === ServerMessageType.Welcome) as never;
  }

  errors(): Extract<ServerMessage, { type: typeof ServerMessageType.Error }>[] {
    return this.received.filter((m) => m.type === ServerMessageType.Error) as never;
  }
}

describe('the auth gate', () => {
  it('refuses a connection with no session token', async () => {
    const stack = openTestStack();
    try {
      const server = new GameServer({ store: stack.current.store, authGate: stack.current.authGate });
      const client = new Client(server);
      await client.hello('p_whoever');

      expect(client.welcome()).toBeUndefined();
      expect(client.errors()[0]?.message).toMatch(/not signed in/);
    } finally {
      stack.dispose();
    }
  });

  it('refuses a made-up token', async () => {
    const stack = openTestStack();
    try {
      const server = new GameServer({ store: stack.current.store, authGate: stack.current.authGate });
      const client = new Client(server);
      await client.hello('p_whoever', 'not-a-real-token');
      expect(client.welcome()).toBeUndefined();
      expect(client.errors()).toHaveLength(1);
    } finally {
      stack.dispose();
    }
  });

  it('welcomes a guest, as the player the session names', async () => {
    const stack = openTestStack();
    try {
      const guest = stack.current.auth.createGuest('Wanderer');
      const server = new GameServer({ store: stack.current.store, authGate: stack.current.authGate });
      const client = new Client(server);
      await client.hello('', guest.token);

      const welcome = client.welcome();
      expect(welcome?.playerId).toBe(guest.playerId);
      expect(welcome?.entityId).toBeGreaterThanOrEqual(0);
    } finally {
      stack.dispose();
    }
  });

  it('ignores the player id on the frame: you cannot claim somebody by naming them', async () => {
    const stack = openTestStack();
    try {
      const { auth } = stack.current;
      const victim = auth.createGuest('Victim');
      const attacker = auth.createGuest('Attacker');

      const server = new GameServer({ store: stack.current.store, authGate: stack.current.authGate });
      const client = new Client(server);
      // The attacker knows the victim's player id and presents their own token.
      await client.hello(victim.playerId, attacker.token);

      const welcome = client.welcome();
      // They get their own character, not the one they asked for.
      expect(welcome?.playerId).toBe(attacker.playerId);
      expect(welcome?.playerId).not.toBe(victim.playerId);
      expect(server.isLoggedIn(victim.playerId)).toBe(false);
    } finally {
      stack.dispose();
    }
  });

  it('a revoked session cannot connect', async () => {
    const stack = openTestStack();
    try {
      const guest = stack.current.auth.createGuest();
      stack.current.auth.logout(guest.token);

      const server = new GameServer({ store: stack.current.store, authGate: stack.current.authGate });
      const client = new Client(server);
      await client.hello('', guest.token);
      expect(client.welcome()).toBeUndefined();
    } finally {
      stack.dispose();
    }
  });

  it('a registered player connects as their account, with the account display name', async () => {
    const stack = openTestStack();
    try {
      const issued = await stack.current.auth.register({
        login: 'ada',
        password: PASSWORD,
        displayName: 'Ada L',
      });
      const server = new GameServer({ store: stack.current.store, authGate: stack.current.authGate });
      const client = new Client(server);
      // Whatever the client types as its display name, the account's wins.
      await client.hello('LIES', issued.token);

      expect(client.welcome()?.playerId).toBe(issued.playerId);
      expect(server.playerManager.get(issued.playerId)?.displayName).toBe('Ada L');
    } finally {
      stack.dispose();
    }
  });

  it('a guest who plays, disconnects and comes back gets the same character', async () => {
    const stack = openTestStack();
    try {
      const guest = stack.current.auth.createGuest();
      const first = new GameServer({ store: stack.current.store, authGate: stack.current.authGate });
      const clientA = new Client(first);
      await clientA.hello('', guest.token);
      first.playerManager.syncFromEntity(guest.playerId, { x: 88, y: 99, z: 0 }, 0, 21);
      await first.stop();

      // A whole new server over the same database, as a restart would be.
      const reopened = stack.reopen();
      const second = new GameServer({ store: reopened.store, authGate: reopened.authGate });
      const clientB = new Client(second);
      await clientB.hello('', guest.token);

      expect(clientB.welcome()?.playerId).toBe(guest.playerId);
      // The position came back, having been flushed by `logout` when the first
      // server dropped its connections.
      expect(second.playerManager.recordOf(guest.playerId)?.position).toEqual({ x: 88, y: 99, z: 0 });
    } finally {
      stack.dispose();
    }
  });

  it('refuses the connection when a character cannot be loaded, and keeps the save', async () => {
    // The failure mode this rules out is the destructive one: starting somebody
    // on a fresh character would have the next autosave write the empty one
    // over whatever was there.
    const stack = openTestStack();
    try {
      const guest = stack.current.auth.createGuest('Wanderer');
      // Corrupt the save, the way a bad write or a half-finished edit would.
      stack.current.db.run('UPDATE players SET data = ? WHERE id = ?', '{not json', guest.playerId);

      const reported: string[] = [];
      const server = new GameServer({
        store: stack.current.store,
        authGate: stack.current.authGate,
        onSaveError: (playerId) => reported.push(playerId),
      });
      const client = new Client(server);
      await client.hello('', guest.token);

      expect(client.welcome()).toBeUndefined();
      expect(client.errors()[0]?.message).toMatch(/could not be loaded/);
      expect(reported).toEqual([guest.playerId]);
      // Untouched: still corrupt, still there, still somebody's character.
      const row = stack.current.db.get<{ data: string }>('SELECT data FROM players WHERE id = ?', guest.playerId);
      expect(row?.data).toBe('{not json');
    } finally {
      stack.dispose();
    }
  });

  it('with no gate, the client still names itself -- the in-tab and bot case', async () => {
    const stack = openTestStack();
    try {
      const server = new GameServer({ store: stack.current.store });
      const client = new Client(server);
      await client.hello('p_local', '');
      expect(client.welcome()?.playerId).toBe('p_local');
    } finally {
      stack.dispose();
    }
  });
});
