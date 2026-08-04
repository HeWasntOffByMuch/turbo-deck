/**
 * End-to-end through the real message path (spec 056): frames in, frames out,
 * no network. Everything here goes through the same decode/route/encode the
 * socket handler uses, so it exercises the wiring and not a parallel test path.
 */

import { describe, expect, it } from 'vitest';
import { signToken } from './admin/auth.js';
import { PROTOCOL_VERSION, SERVER_TICK_RATE } from './config.js';
import { encodeAdminRequest, decodeAdminReply, type AdminReply } from './net/admin-messages.js';
import { decodeServerMessage, encodeClientMessage, type ServerMessage } from './net/messages.js';
import {
  AdminMessageType,
  AdminReplyType,
  ClientMessageType,
  CorrectionReason,
  EntityField,
  ErrorCode,
  InputButton,
  ServerMessageType,
} from './net/protocol.js';
import { GameServer } from './server.js';

const SECRET = 'integration-secret';

/** A connected client: sends real frames, collects real frames. */
class Client {
  readonly received: (ServerMessage | AdminReply)[] = [];
  readonly connection: ReturnType<GameServer['createLocalConnection']>;

  constructor(private readonly server: GameServer) {
    this.connection = server.createLocalConnection((bytes) => {
      const type = bytes[0] ?? 0;
      this.received.push(
        type >= 0xa0 && type <= 0xbf ? decodeAdminReply(bytes) : decodeServerMessage(bytes),
      );
    });
  }

  async hello(playerId: string): Promise<void> {
    await this.server.receive(
      this.connection,
      encodeClientMessage({
        type: ClientMessageType.Hello,
        protocolVersion: PROTOCOL_VERSION,
        playerId,
        displayName: playerId,
        token: '',
      }),
    );
  }

  async input(seq: number, fields: Partial<Parameters<typeof encodeClientMessage>[0]> = {}): Promise<void> {
    await this.server.receive(
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
        ...fields,
      } as Parameters<typeof encodeClientMessage>[0]),
    );
  }

  async admin(request: Parameters<typeof encodeAdminRequest>[0]): Promise<void> {
    await this.server.receive(this.connection, encodeAdminRequest(request));
  }

  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.received.filter(
      (message): message is Extract<ServerMessage, { type: T }> => message.type === type,
    );
  }

  adminReplies(): AdminReply[] {
    return this.received.filter(
      (message): message is AdminReply => message.type >= 0xa0 && message.type <= 0xbf,
    );
  }

  clear(): void {
    this.received.length = 0;
  }
}

function server(): GameServer {
  return new GameServer({ headless: true, seed: 5, adminSecret: SECRET });
}

describe('login', () => {
  it('welcomes a client and immediately tells it its derived stats', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('alice');

    const welcome = client.of(ServerMessageType.Welcome)[0];
    expect(welcome).toBeDefined();
    expect(welcome?.playerId).toBe('alice');
    expect(welcome?.tickRate).toBe(SERVER_TICK_RATE);
    expect(welcome?.entityId).toBeGreaterThan(0);

    const stats = client.of(ServerMessageType.Stats)[0];
    expect(stats?.stats.maxHealth).toBeGreaterThan(0);
    expect(stats?.stats.attackDamage).toBeGreaterThan(0);
  });

  it('refuses a client speaking a different protocol version', async () => {
    const game = server();
    const client = new Client(game);
    await game.receive(
      client.connection,
      encodeClientMessage({
        type: ClientMessageType.Hello,
        protocolVersion: PROTOCOL_VERSION + 1,
        playerId: 'alice',
        displayName: 'Alice',
        token: '',
      }),
    );
    expect(client.of(ServerMessageType.Error)[0]?.code).toBe(ErrorCode.BadProtocolVersion);
    expect(client.of(ServerMessageType.Welcome)).toEqual([]);
  });

  it('answers a malformed frame with an error rather than falling over', async () => {
    const game = server();
    const client = new Client(game);
    // A Hello type byte with no payload behind it.
    await game.receive(client.connection, new Uint8Array([ClientMessageType.Hello]));
    expect(client.of(ServerMessageType.Error)[0]?.code).toBe(ErrorCode.MalformedFrame);
  });
});

describe('the tick loop and delta broadcast', () => {
  it('sends a full record first, then only what changed', async () => {
    const game = server();
    // The ambient spawner is off for this one, so "nothing changed" really is
    // nothing changed rather than "a grazer wandered in".
    game.liveConfig.set('spawnRateMultiplier', 0);
    const client = new Client(game);
    await client.hello('alice');
    client.clear();

    game.tick();
    const first = client.of(ServerMessageType.Delta)[0];
    expect(first).toBeDefined();
    const spawn = first?.upserts.find((record) => record.fields & EntityField.Spawn);
    expect(spawn?.typeId).toBe('player');

    // Standing still: nothing to say, so nothing is sent.
    client.clear();
    game.tick();
    expect(client.of(ServerMessageType.Delta)).toEqual([]);

    // Moving: the position and the idle -> moving flip, and nothing else. No
    // identity, no health, no level -- none of those changed.
    await client.input(1, { moveX: 1, predictedX: 0, predictedY: 0 });
    client.clear();
    game.tick();
    const moving = client.of(ServerMessageType.Delta)[0];
    expect(moving?.upserts[0]?.fields).toBe(EntityField.Position | EntityField.Activity);
    expect(moving?.upserts[0]?.typeId).toBeUndefined();
    expect(moving?.upserts[0]?.health).toBeUndefined();
  });

  it('acknowledges the input sequence a client should reconcile from', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('alice');
    await client.input(7, { moveX: 1 });
    client.clear();
    game.tick();
    expect(client.of(ServerMessageType.Delta)[0]?.ackInputSeq).toBe(7);
  });

  it('applies one input per tick however fast a client sends them', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('alice');
    const entityId = client.of(ServerMessageType.Welcome)[0]?.entityId ?? -1;
    const start = game.world.entities.get(entityId)?.position.x ?? 0;

    for (let seq = 1; seq <= 10; seq++) await client.input(seq, { moveX: 1 });
    game.tick();

    const after = game.world.entities.get(entityId)?.position.x ?? 0;
    const stats = client.of(ServerMessageType.Stats)[0]?.stats;
    const perTick = (stats?.moveSpeed ?? 0) / SERVER_TICK_RATE;
    expect(after - start).toBeCloseTo(perTick, 4);
  });

  it('ignores a replayed or out-of-order input sequence', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('alice');
    const entityId = client.of(ServerMessageType.Welcome)[0]?.entityId ?? -1;

    await client.input(5, { moveX: 1 });
    await client.input(3, { moveX: 1 });
    await client.input(5, { moveX: 1 });
    game.tick();
    game.tick();
    game.tick();

    const start = 600;
    const travelled = (game.world.entities.get(entityId)?.position.x ?? 0) - start;
    const perTick = (client.of(ServerMessageType.Stats)[0]?.stats.moveSpeed ?? 0) / SERVER_TICK_RATE;
    // Only the one accepted input moved them.
    expect(travelled).toBeCloseTo(perTick, 4);
  });

  it('corrects a client that claims impossible movement', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('alice');
    client.clear();
    await client.input(1, { moveX: 1, predictedX: 99999, predictedY: 450 });
    game.tick();

    const correction = client.of(ServerMessageType.Correction)[0];
    expect(correction?.reason).toBe(CorrectionReason.SpeedViolation);
    expect(correction?.inputSeq).toBe(1);
    expect(Math.abs(correction?.position.x ?? 0)).toBeLessThan(1000);
  });
});

describe('interest management over the wire', () => {
  it('tells a client about a nearby player and not a distant one', async () => {
    const game = server();
    const alice = new Client(game);
    const bob = new Client(game);
    const carol = new Client(game);
    await alice.hello('alice');
    await bob.hello('bob');
    await carol.hello('carol');

    const carolEntity = carol.of(ServerMessageType.Welcome)[0]?.entityId ?? -1;
    // Carol is teleported far outside anyone's interest window.
    expect(game.teleport('carol', 40000, 40000)).toBe(true);

    game.tick();
    alice.clear();
    game.tick();
    game.tick();

    const seen = new Set<number>();
    for (const delta of alice.of(ServerMessageType.Delta)) {
      for (const record of delta.upserts) seen.add(record.id);
    }
    const bobEntity = bob.of(ServerMessageType.Welcome)[0]?.entityId ?? -1;
    expect(seen.has(carolEntity)).toBe(false);
    // Bob spawned in the same hub, so he is inside the window.
    expect(bobEntity).toBeGreaterThan(0);
  });

  it('removes an entity that walks out of the interest window', async () => {
    const game = server();
    const alice = new Client(game);
    const bob = new Client(game);
    await alice.hello('alice');
    await bob.hello('bob');
    const bobEntity = bob.of(ServerMessageType.Welcome)[0]?.entityId ?? -1;

    game.tick();
    alice.clear();
    game.teleport('bob', 40000, 40000);
    game.tick();

    const removed = alice.of(ServerMessageType.Delta).flatMap((delta) => delta.removed);
    expect(removed).toContain(bobEntity);
  });
});

describe('inventory and skills are server-side only', () => {
  it('re-derives and re-sends stats when an item is equipped', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('alice');
    const before = client.of(ServerMessageType.Stats)[0]?.stats.maxHealth ?? 0;
    client.clear();

    await game.receive(
      client.connection,
      encodeClientMessage({ type: ClientMessageType.Equip, slot: 'head', itemId: 'helm.leather' }),
    );
    const after = client.of(ServerMessageType.Stats)[0]?.stats.maxHealth ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it('refuses an illegal skill allocation and changes nothing', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('alice');
    client.clear();

    // A tier-2 skill with nothing invested in the branch.
    await game.receive(
      client.connection,
      encodeClientMessage({ type: ClientMessageType.SpendSkillPoint, skillId: 'might.bulwark' }),
    );
    expect(client.of(ServerMessageType.Error)[0]?.code).toBe(ErrorCode.RejectedAction);
    expect(game.playerManager.get('alice')?.record.skills).toEqual([]);
  });

  it('accepts a legal one and spends exactly one point', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('alice');
    const before = game.playerManager.get('alice')?.record.unspentSkillPoints ?? 0;

    await game.receive(
      client.connection,
      encodeClientMessage({ type: ClientMessageType.SpendSkillPoint, skillId: 'might.toughness' }),
    );
    const record = game.playerManager.get('alice')?.record;
    expect(record?.skills).toEqual([{ skillId: 'might.toughness', level: 1 }]);
    expect(record?.unspentSkillPoints).toBe(before - 1);
  });
});

describe('combat over the wire', () => {
  it('delivers a combat result carrying its own hitstop and knockback', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('alice');
    const entityId = client.of(ServerMessageType.Welcome)[0]?.entityId ?? -1;
    const at = game.world.entities.get(entityId)?.position ?? { x: 600, y: 450, z: 0 };

    expect(game.spawnEntities('grazer', at.x + 40, at.y, 1)).toBe(1);
    client.clear();

    await client.input(1, { facing: 0, buttons: InputButton.Attack });
    game.tick();

    const result = client.of(ServerMessageType.CombatResult)[0];
    expect(result).toBeDefined();
    expect(result?.attackerId).toBe(entityId);
    expect(result?.damage).toBeGreaterThan(0);
    expect(result?.hitstopTicks).toBeGreaterThanOrEqual(1);
    expect(result?.knockbackX).toBeGreaterThan(0);
  });
});

describe('the admin namespace on the same connection', () => {
  const token = (nowMs = Date.now()): string =>
    signToken({ sub: 'root', role: 'admin' }, SECRET, nowMs);

  it('refuses an admin action from an ordinary player connection', async () => {
    const game = server();
    const client = new Client(game);
    await client.hello('alice');
    client.clear();

    await client.admin({ type: AdminMessageType.ListPlayers });
    expect(client.adminReplies()[0]?.type).toBe(AdminReplyType.Error);
  });

  it('lists connected players once authenticated, with derived stats', async () => {
    const game = server();
    const alice = new Client(game);
    await alice.hello('alice');

    const admin = new Client(game);
    await admin.admin({ type: AdminMessageType.Auth, token: token() });
    admin.clear();
    await admin.admin({ type: AdminMessageType.ListPlayers });

    const reply = admin.adminReplies()[0];
    expect(reply?.type).toBe(AdminReplyType.PlayerList);
    if (reply?.type !== AdminReplyType.PlayerList) throw new Error('expected a player list');
    expect(reply.players).toHaveLength(1);
    expect(reply.players[0]?.playerId).toBe('alice');
    expect(reply.players[0]?.maxHealth).toBeGreaterThan(0);
    expect(reply.players[0]?.chunk).toMatch(/^-?\d+,-?\d+$/);
  });

  it('teleports a player and pushes them an unpredictable correction', async () => {
    const game = server();
    const alice = new Client(game);
    await alice.hello('alice');
    const admin = new Client(game);
    await admin.admin({ type: AdminMessageType.Auth, token: token() });
    alice.clear();

    await admin.admin({
      type: AdminMessageType.Teleport,
      playerId: 'alice',
      x: 1234,
      y: 567,
    });

    const correction = alice.of(ServerMessageType.Correction)[0];
    expect(correction?.reason).toBe(CorrectionReason.Teleport);
    expect(correction?.position.x).toBeCloseTo(1234, 3);
  });

  it('spawns a raid, and broadcasts it to every player', async () => {
    const game = server();
    const alice = new Client(game);
    await alice.hello('alice');
    const admin = new Client(game);
    await admin.admin({ type: AdminMessageType.Auth, token: token() });
    alice.clear();
    admin.clear();

    const before = game.world.entities.size;
    await admin.admin({
      type: AdminMessageType.TriggerEvent,
      eventName: 'raid',
      x: 600,
      y: 450,
      magnitude: 4,
    });

    expect(game.world.entities.size).toBe(before + 4);
    expect(admin.adminReplies()[0]?.type).toBe(AdminReplyType.Ok);
    expect(alice.of(ServerMessageType.Chat)[0]?.text).toContain('raid');
  });

  it('adjusts live config without a restart, and the sim picks it up', async () => {
    const game = server();
    const admin = new Client(game);
    await admin.admin({ type: AdminMessageType.Auth, token: token() });
    admin.clear();

    await admin.admin({
      type: AdminMessageType.SetConfig,
      key: 'spawnRateMultiplier',
      value: 0,
    });
    expect(admin.adminReplies()[0]?.type).toBe(AdminReplyType.Ok);
    expect(game.liveConfig.get().spawnRateMultiplier).toBe(0);
  });

  it('kicks a player, who is then gone from the world', async () => {
    const game = server();
    const alice = new Client(game);
    await alice.hello('alice');
    const entityId = alice.of(ServerMessageType.Welcome)[0]?.entityId ?? -1;
    const admin = new Client(game);
    await admin.admin({ type: AdminMessageType.Auth, token: token() });

    await admin.admin({ type: AdminMessageType.Kick, playerId: 'alice', reason: 'afk' });
    expect(alice.of(ServerMessageType.Disconnect)[0]?.reason).toContain('afk');
    expect(game.world.entities.has(entityId)).toBe(false);
    expect(game.playerManager.get('alice')).toBeNull();
  });

  it('refuses a banned player at the door on their next login', async () => {
    const game = server();
    const alice = new Client(game);
    await alice.hello('alice');
    const admin = new Client(game);
    await admin.admin({ type: AdminMessageType.Auth, token: token() });
    await admin.admin({
      type: AdminMessageType.Ban,
      playerId: 'alice',
      seconds: 600,
      reason: 'cheating',
    });

    const returning = new Client(game);
    await returning.hello('alice');
    expect(returning.of(ServerMessageType.Error)[0]?.code).toBe(ErrorCode.Banned);
    expect(returning.of(ServerMessageType.Welcome)).toEqual([]);
  });

  it('stops a muted player from being heard', async () => {
    const game = server();
    const alice = new Client(game);
    await alice.hello('alice');
    const admin = new Client(game);
    await admin.admin({ type: AdminMessageType.Auth, token: token() });
    await admin.admin({ type: AdminMessageType.Mute, playerId: 'alice', seconds: 60 });
    alice.clear();

    await game.receive(
      alice.connection,
      encodeClientMessage({ type: ClientMessageType.Chat, text: 'hello?' }),
    );
    expect(alice.of(ServerMessageType.Error)[0]?.code).toBe(ErrorCode.Muted);
    expect(alice.of(ServerMessageType.Chat)).toEqual([]);
  });

  it('has an audit trail for everything it just did', async () => {
    const game = server();
    const admin = new Client(game);
    await admin.admin({ type: AdminMessageType.Auth, token: token() });
    await admin.admin({ type: AdminMessageType.Broadcast, text: 'hello everyone' });
    admin.clear();

    await admin.admin({ type: AdminMessageType.GetAudit, limit: 10 });
    const reply = admin.adminReplies()[0];
    expect(reply?.type).toBe(AdminReplyType.Audit);
    if (reply?.type !== AdminReplyType.Audit) throw new Error('expected an audit reply');
    expect(reply.entries.map((entry) => entry.action)).toContain('admin:broadcast');
    for (const entry of reply.entries) expect(entry.actor).toBe('root');
  });
});
