/**
 * When a session ends (spec 267).
 *
 * End to end through the real message path and the real `tick`, for the reason
 * `server.test.ts` gives: the three rules here are all about *wiring* -- which
 * pass runs, on which tick, against which status -- and a test that called
 * `disconnect` directly would assert the branch rather than the behaviour.
 *
 * Every "the body went" is asserted by **coming back for it**: a resume with
 * the token that was issued either lands on the same entity id or does not, and
 * that is the same question the player is asking.
 */

import { describe, expect, it } from 'vitest';
import { AFK_TIMEOUT_TICKS, PROTOCOL_VERSION } from './config.js';
import { RESTORATION } from './data/restoration.js';
import { decodeServerMessage, encodeClientMessage, type ServerMessage } from './net/messages.js';
import { ClientMessageType, ServerMessageType } from './net/protocol.js';
import { GameServer } from './server.js';
import type { Channel } from './net/transport.js';

function server(): GameServer {
  const game = new GameServer({ seed: 5 });
  // Off throughout: a grazer wandering in and being hit would put a body in a
  // fight this test did not ask for, which is the one variable every assertion
  // below turns on.
  game.liveConfig.set('spawnRateMultiplier', 0);
  return game;
}

class Client {
  readonly received: ServerMessage[] = [];
  readonly connection: ReturnType<GameServer['createLocalConnection']>;

  constructor(private readonly game: GameServer) {
    this.connection = game.createLocalConnection((bytes) => {
      this.received.push(decodeServerMessage(bytes));
    });
  }

  async hello(playerId: string, resumeToken = ''): Promise<void> {
    await this.game.receive(
      this.connection,
      encodeClientMessage({
        type: ClientMessageType.Hello,
        protocolVersion: PROTOCOL_VERSION,
        playerId,
        displayName: playerId,
        token: '',
        resumeToken,
        assetManifest: '',
        authToken: '',
      }),
    );
  }

  /** An input that asks for nothing: what an idle tab sends, every frame. */
  async idleInput(seq: number): Promise<void> {
    await this.input(seq, {});
  }

  async input(seq: number, fields: Record<string, number>): Promise<void> {
    await this.game.receive(
      this.connection,
      encodeClientMessage({
        type: ClientMessageType.Input,
        seq,
        moveX: 0,
        moveY: 0,
        facing: 0,
        buttons: 0,
        predictedX: 0,
        predictedY: 0,
        renderLagTicks: 0,
        ...fields,
      } as Parameters<typeof encodeClientMessage>[0]),
    );
  }

  async ping(nonce: number): Promise<void> {
    await this.game.receive(
      this.connection,
      encodeClientMessage({ type: ClientMessageType.Ping, nonce }),
    );
  }

  async goodbye(): Promise<void> {
    await this.game.receive(
      this.connection,
      encodeClientMessage({ type: ClientMessageType.Goodbye }),
    );
  }

  /** Where this body is, off a delta: the welcome does not carry a position. */
  async position(game: GameServer): Promise<{ x: number; y: number }> {
    const id = this.welcome()?.entityId ?? -1;
    for (let i = 0; i < 6; i++) game.tick();
    for (const message of [...this.received].reverse()) {
      if (message.type !== ServerMessageType.Delta) continue;
      const record = message.upserts.find((upsert) => upsert.id === id);
      if (record?.position) return { x: record.position.x, y: record.position.y };
    }
    throw new Error('no delta placed this body');
  }

  welcome(): Extract<ServerMessage, { type: typeof ServerMessageType.Welcome }> | undefined {
    return this.received.find(
      (message): message is Extract<ServerMessage, { type: typeof ServerMessageType.Welcome }> =>
        message.type === ServerMessageType.Welcome,
    );
  }

  disconnectReasons(): string[] {
    return this.received
      .filter(
        (
          message,
        ): message is Extract<ServerMessage, { type: typeof ServerMessageType.Disconnect }> =>
          message.type === ServerMessageType.Disconnect,
      )
      .map((message) => message.reason);
  }
}

/**
 * Put this player in a real fight, by having them land a real blow.
 *
 * Not `applyStatus` on the entity: `InCombat` is stamped by `blow.ts` and the
 * whole claim being tested is that the departure reads what combat writes, so
 * a test that wrote the status itself would pass with the two disconnected.
 */
async function fight(game: GameServer, client: Client): Promise<void> {
  const me = client.welcome();
  expect(me).toBeDefined();
  // Off a delta rather than off the welcome, which carries no position: where
  // this body is standing has to be right, or the grazer is placed at NaN and
  // the swing goes through empty air -- which looks exactly like a working
  // fight from every assertion below.
  const at = await client.position(game);
  // Close enough that a basic attack reaches it: what is wanted is a blow that
  // *lands*, since `markAttacker` stamps the window on a landing and a swing
  // through empty air would leave the player exactly as out of combat as they
  // started.
  const spawned = game.spawnEntities('grazer', at.x + 20, at.y, 1);
  expect(spawned).toBe(1);
  // Facing it first, so the turn spec 065 puts in front of the wind-up is
  // already done and the swing is not still coming round when the ticks below
  // run out.
  await client.input(1, { facing: 0, predictedX: at.x, predictedY: at.y });
  await game.receive(
    client.connection,
    encodeClientMessage({
      type: ClientMessageType.UseAbility,
      abilityId: 'melee.slash',
      targetX: at.x + 20,
      targetY: at.y,
      targetEntityId: 0,
      afterInputSeq: 1,
    }),
  );
  // Far enough for the wind-up to reach its attack point and the blow to land.
  for (let i = 0; i < 120; i++) game.tick();
  // The helper's own claim, checked: a swing that missed leaves the player as
  // out of combat as they started, and every assertion built on this one would
  // then be measuring the out-of-combat rule under an in-combat name.
  expect(client.received.some((message) => message.type === ServerMessageType.CombatResult)).toBe(true);
}

/** Close the socket without saying goodbye: a tab that went away. */
async function pullThePlug(client: Client): Promise<void> {
  client.connection.channel.close();
  await Promise.resolve();
}

/** Come back with the token that was issued, and say which body we landed on. */
async function comeBack(game: GameServer, playerId: string, token: string): Promise<number> {
  const back = new Client(game);
  await back.hello(playerId, token);
  return back.welcome()?.entityId ?? -1;
}

describe('what buys the resume grace is being in a fight (spec 267)', () => {
  it('reaps the body at once when the tab closes out of combat', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('ana');
    const wasEntity = client.welcome()?.entityId ?? -1;
    expect(wasEntity).toBeGreaterThan(0);

    await pullThePlug(client);

    // The body is gone, so coming back is a fresh login onto a new one rather
    // than a resume. Asserted as "a different entity" rather than "no entity",
    // because a player who reloads is still owed a character.
    expect(await comeBack(game, 'ana', client.welcome()?.sessionToken ?? '')).not.toBe(wasEntity);
  });

  it('leaves the body standing when the tab closes mid-fight', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('ana');
    const wasEntity = client.welcome()?.entityId ?? -1;
    await fight(game, client);

    await pullThePlug(client);

    // The whole of spec 150's reason, kept: pulling the plug is not an escape.
    expect(await comeBack(game, 'ana', client.welcome()?.sessionToken ?? '')).toBe(wasEntity);
  });

  it('holds a body mid-fight even when the client says it meant to leave', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('ana');
    const wasEntity = client.welcome()?.entityId ?? -1;
    await fight(game, client);

    // The server decides this and the client never does -- "I meant to leave"
    // is exactly what the escape the grace forbids would say.
    await client.goodbye();

    expect(await comeBack(game, 'ana', client.welcome()?.sessionToken ?? '')).toBe(wasEntity);
  });
});

describe('a player who has stopped asking for anything (spec 267)', () => {
  /** Run the clock, feeding the connection whatever an idle tab really sends. */
  async function idleFor(game: GameServer, client: Client, ticks: number): Promise<void> {
    for (let i = 0; i < ticks; i++) {
      game.tick();
      // Every frame, with a zero move vector: `view.ts` calls `sendInput`
      // unconditionally, which is why arrival cannot be the measure.
      if (i % 3 === 0) await client.idleInput(i + 1);
      if (i % 30 === 0) await client.ping(i);
    }
  }

  it('drops one that only ever sends zero inputs, pings and nothing else', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('ana');

    await idleFor(game, client, AFK_TIMEOUT_TICKS + 10);

    expect(client.disconnectReasons()).toContain('idle');
  });

  it('never drops one whose inputs are asking for something', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('ana');

    for (let i = 0; i < AFK_TIMEOUT_TICKS + 600; i++) {
      game.tick();
      // Walking. The one thing an idle tab does not do.
      if (i % 3 === 0) await client.input(i + 1, { moveX: 1 });
    }

    expect(client.disconnectReasons()).toEqual([]);
  });

  it('counts a body that is only turning as present', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('ana');

    for (let i = 0; i < AFK_TIMEOUT_TICKS + 600; i++) {
      game.tick();
      // Aiming at something and standing still is playing. The facing has to
      // *change*: this is what an idle tab's constant facing is measured
      // against, and a mouse being moved is what separates them.
      if (i % 3 === 0) await client.input(i + 1, { facing: (i % 360) * 0.01 });
    }

    expect(client.disconnectReasons()).toEqual([]);
  });

  it('leaves a body alone while something is fighting it', async () => {
    // The one case that has to be staged from the *other* side. Every way a
    // player enters combat by their own hand is an input, which resets the very
    // clock this is meant to be running out -- so a test that fought its way in
    // would prove the input rule again under a combat name. A ferocious spider
    // needs no invitation: it commits on sight, and the blows it lands stamp
    // `InCombat` on a body that has asked for nothing for five minutes.
    //
    // The fight has to be live *as the threshold passes*, which is why the
    // spiders arrive at the end rather than the beginning: set on at the start
    // they are done with a stationary target in under a minute, `InCombat`
    // lapses, and the sweep is right to take the body four minutes later.
    const game = server();
    const client = new Client(game);
    await client.hello('ana');
    const at = await client.position(game);

    await idleFor(game, client, AFK_TIMEOUT_TICKS - 300);
    game.spawnEntities('small_spider', at.x + 30, at.y, 2);
    // Straddles the threshold with the fight in progress. The socket is kept up
    // throughout exactly as a real idle tab keeps it: left in true silence this
    // reaches `CONNECTION_TIMEOUT_TICKS` in ten seconds and is cut as a lost
    // socket instead, which is a different rule satisfying the same assertion.
    await idleFor(game, client, 600);

    // It really was a fight rather than a spider that never arrived.
    expect(client.received.some((message) => message.type === ServerMessageType.CombatResult)).toBe(
      true,
    );
    expect(client.disconnectReasons()).toEqual([]);
  });

  it('drops it once the fight is over and it still asks for nothing', async () => {
    // The other half of the clause: combat *suspends* the sweep, it does not
    // cancel it. Without this the rule above would be satisfied by never
    // dropping anybody who had ever been in a fight.
    const game = server();
    const client = new Client(game);
    await client.hello('ana');
    const at = await client.position(game);

    await idleFor(game, client, AFK_TIMEOUT_TICKS - 300);
    game.spawnEntities('small_spider', at.x + 30, at.y, 2);
    await idleFor(game, client, 600);
    expect(client.disconnectReasons()).toEqual([]);

    // Long enough for the fight to finish and for the last blow's window to
    // close after it. Nothing is *asked for* in any of it.
    await idleFor(game, client, RESTORATION.rest.combatTicks * 4);

    expect(client.disconnectReasons()).toContain('idle');
  });

  it('is switched off entirely for a server that asked for that', async () => {
    // The single-player tab (spec 267). Only the remote path wraps its channel
    // in a `ReconnectingChannel`, so a loopback client logged out here does not
    // come back -- and there is nobody else in a tab for an idle body to be in
    // the way of. Asserted rather than left to `view.ts`, because "the option
    // is passed" and "the option does anything" are two claims.
    const game = new GameServer({ seed: 5, afkTimeoutTicks: 0 });
    game.liveConfig.set('spawnRateMultiplier', 0);
    const client = new Client(game);
    await client.hello('ana');

    await idleFor(game, client, AFK_TIMEOUT_TICKS * 2);

    expect(client.disconnectReasons()).toEqual([]);
  });

  it('does not let a pong alone hold a session open', async () => {
    // The case the whole feature exists for (spec 197): a hidden tab answers a
    // protocol ping from its network stack with no JavaScript running, so
    // `lastSeenTick` stays fresh forever. If that also counted as a player
    // being present, nothing here could ever fire -- so this is the one test
    // that goes through a channel with an `onAlive` on it rather than the
    // loopback one, which has none.
    const game = server();
    const frames: ServerMessage[] = [];
    let alive: (() => void) | null = null;
    const channel: Channel = {
      isOpen: true,
      send: (bytes) => frames.push(decodeServerMessage(new Uint8Array(bytes))),
      close: () => {
        /* never closed by this test: the socket is healthy throughout */
      },
      onMessage: () => {
        /* frames are pushed in through `receive` */
      },
      onClose: () => {
        /* nothing to hand back */
      },
      onAlive: (handler) => {
        alive = handler;
      },
    };
    const connection = game.accept(channel);
    await game.receive(
      connection,
      encodeClientMessage({
        type: ClientMessageType.Hello,
        protocolVersion: PROTOCOL_VERSION,
        playerId: 'ana',
        displayName: 'ana',
        token: '',
        resumeToken: '',
        assetManifest: '',
        authToken: '',
      }),
    );
    const pong = alive as unknown as (() => void) | null;
    expect(pong).not.toBeNull();

    for (let i = 0; i < AFK_TIMEOUT_TICKS + 10; i++) {
      game.tick();
      // In perfect health the whole way, with nobody behind it.
      pong?.();
    }

    const reasons = frames
      .filter(
        (
          message,
        ): message is Extract<ServerMessage, { type: typeof ServerMessageType.Disconnect }> =>
          message.type === ServerMessageType.Disconnect,
      )
      .map((message) => message.reason);
    expect(reasons).toContain('idle');
  });
});
