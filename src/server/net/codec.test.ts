import { describe, expect, it } from 'vitest';
import { BufferReader, BufferWriter, CodecError } from './codec.js';
import {
  decodeAdminReply,
  decodeAdminRequest,
  encodeAdminReply,
  encodeAdminRequest,
  type AdminReply,
  type AdminRequest,
} from './admin-messages.js';
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type ServerMessage,
} from './messages.js';
import {
  AdminMessageType,
  AdminReplyType,
  ClientMessageType,
  EntityField,
  isAdminRequest,
  ServerMessageType,
} from './protocol.js';
import { EMPTY_EQUIPMENT, emptyInventory, type EffectiveStats } from '../state/types.js';
import { maxStackOf } from '../data/items.js';

const STATS: EffectiveStats = {
  maxHealth: 137.5,
  moveSpeed: 152.25,
  turnRate: 210,
  attackDamage: 11.5,
  attackRange: 56,
  attackDelayTicks: 7,
  armor: 0.125,
  spellPower: 1.5,
  critChance: 0.0625,
  maxResource: 30,
  // f32-exact, so the round-trip is testing the codec and not float precision.
  resourceRegen: 0.0625,
  basicAttackId: 'ranged.shot',
};

describe('codec primitives', () => {
  it('round-trips every width, including the signed and float edges', () => {
    const writer = new BufferWriter(4);
    writer.u8(255).u16(65535).i16(-32768).u32(4294967295).i32(-2147483648).f32(0.5).f64(-1e-9).bool(true);
    const reader = new BufferReader(writer.toBytes());
    expect(reader.u8()).toBe(255);
    expect(reader.u16()).toBe(65535);
    expect(reader.i16()).toBe(-32768);
    expect(reader.u32()).toBe(4294967295);
    expect(reader.i32()).toBe(-2147483648);
    expect(reader.f32()).toBe(0.5);
    expect(reader.f64()).toBe(-1e-9);
    expect(reader.bool()).toBe(true);
    expect(reader.atEnd).toBe(true);
  });

  it('round-trips varuint across every byte-length boundary', () => {
    const values = [0, 1, 127, 128, 255, 16383, 16384, 2097151, 2097152, 1e9];
    const writer = new BufferWriter();
    for (const value of values) writer.varuint(value);
    const reader = new BufferReader(writer.toBytes());
    for (const value of values) expect(reader.varuint()).toBe(value);
  });

  it('keeps small negatives cheap through zigzag varint', () => {
    const values = [0, -1, 1, -64, 63, -1000000, 1000000];
    const writer = new BufferWriter();
    for (const value of values) writer.varint(value);
    const reader = new BufferReader(writer.toBytes());
    for (const value of values) expect(reader.varint()).toBe(value);
  });

  it('round-trips strings including empty and multi-byte UTF-8', () => {
    const values = ['', 'player-1', 'Hearthstead — the wilds', '🐖🐄'];
    const writer = new BufferWriter();
    for (const value of values) writer.str(value);
    const reader = new BufferReader(writer.toBytes());
    for (const value of values) expect(reader.str()).toBe(value);
  });

  it('grows past its initial capacity without corrupting earlier writes', () => {
    const writer = new BufferWriter(16);
    for (let i = 0; i < 500; i++) writer.u32(i);
    const reader = new BufferReader(writer.toBytes());
    for (let i = 0; i < 500; i++) expect(reader.u32()).toBe(i);
  });

  it('throws rather than reading past the end of a truncated frame', () => {
    const writer = new BufferWriter();
    writer.u32(7);
    const truncated = writer.toBytes().subarray(0, 2);
    expect(() => new BufferReader(truncated).u32()).toThrow(CodecError);
  });
});

describe('game message round-trip', () => {
  const clientMessages: ClientMessage[] = [
    {
      type: ClientMessageType.Hello,
      protocolVersion: 1,
      playerId: 'alice',
      displayName: 'Alice',
      token: '',
      assetManifest: '',
    },
    {
      type: ClientMessageType.Input,
      seq: 4096,
      moveX: -0.5,
      moveY: 0.75,
      facing: 1.5,
      buttons: 5,
      predictedX: -1234.5,
      predictedY: 987.25,
    },
    { type: ClientMessageType.Ping, nonce: 123456 },
    { type: ClientMessageType.Equip, slot: 'mainHand', itemId: 'sword.keen' },
    { type: ClientMessageType.Unequip, slot: 'offHand' },
    { type: ClientMessageType.SpendSkillPoint, skillId: 'might.toughness' },
    { type: ClientMessageType.Chat, text: 'hello world' },
    {
      type: ClientMessageType.UseAbility,
      abilityId: 'melee.slash',
      targetX: 612.5,
      targetY: -48.25,
      // The body it was aimed at (spec 070); 0 would be a point aim.
      targetEntityId: 44,
      // The input this request was made on (spec 067), not decoration: the
      // server commits on that input rather than on arrival.
      afterInputSeq: 9001,
    },
    { type: ClientMessageType.CancelCast, afterInputSeq: 9002 },
    {
      type: ClientMessageType.MoveItem,
      requestId: 7,
      from: { container: 'inventory', index: 3 },
      to: { container: 'equipment', index: 0 },
      count: 0,
    },
    {
      // An out-of-range index is a *rule* refusal, so it has to survive the
      // wire to be refused with a reason -- a signed index, not a length.
      type: ClientMessageType.MoveItem,
      requestId: 8,
      from: { container: 'inventory', index: -1 },
      to: { container: 'inventory', index: 5 },
      count: 4,
    },
  ];

  it.each(clientMessages.map((m) => [m.type, m] as const))(
    'client type 0x%s survives encode/decode',
    (_type, message) => {
      expect(decodeClientMessage(encodeClientMessage(message))).toEqual(message);
    },
  );

  const serverMessages: ServerMessage[] = [
    {
      type: ServerMessageType.Welcome,
      protocolVersion: 1,
      playerId: 'alice',
      entityId: 3,
      tick: 900,
      tickRate: 20,
      chunkSize: 100,
      interestRadius: 3,
      correctionThreshold: 48,
      worldSeed: 4242,
    },
    {
      type: ServerMessageType.Delta,
      tick: 42,
      ackInputSeq: 17,
      removed: [],
      upserts: [],
    },
    {
      type: ServerMessageType.Correction,
      inputSeq: 9,
      position: { x: -1600.5, y: 2500.25, z: -12.5 },
      facing: -3.125,
      reason: 1,
    },
    {
      type: ServerMessageType.CombatResult,
      attackerId: 1,
      targetId: 2,
      damage: 12.5,
      targetHealth: 27.5,
      flags: 3,
    },
    {
      type: ServerMessageType.Stats,
      entityId: 1,
      level: 7,
      experience: 340,
      unspentSkillPoints: 2,
      stats: STATS,
    },
    {
      type: ServerMessageType.CastState,
      entityId: 12,
      abilityId: 'melee.slash',
      phase: 0,
      releaseTick: 4210,
      endTick: 4222,
      targetX: 612.5,
      targetY: -48.25,
      // What the swing is aimed at (spec 070), which is what makes it single
      // target on the other side of the wire.
      targetEntityId: 44,
    },
    { type: ServerMessageType.CastEnded, entityId: 12, abilityId: 'melee.slash', reason: 0 },
    { type: ServerMessageType.Chat, channel: 2, from: 'Server', text: 'be nice' },
    {
      type: ServerMessageType.Cooldowns,
      entries: [
        { abilityId: 'melee.heavy', readyAtTick: 1800 },
        { abilityId: 'ground.quake', readyAtTick: 2400 },
      ],
      resource: 12.5,
      atTick: 1750,
    },
    { type: ServerMessageType.Cooldowns, entries: [], resource: 0, atTick: 0 },
    // An empty bag, a full one, and a stack at its ceiling (spec 126) -- the
    // three shapes a container has, and the codec has to carry all of them.
    {
      type: ServerMessageType.Inventory,
      requestId: 0,
      inventory: emptyInventory(),
      equipment: EMPTY_EQUIPMENT,
    },
    {
      type: ServerMessageType.Inventory,
      requestId: 12,
      inventory: [...emptyInventory()].map(() => ({ defId: 'sword.worn', count: 1 })),
      equipment: { ...EMPTY_EQUIPMENT, mainHand: 'bow.hunting', chest: 'chest.leather' },
    },
    {
      type: ServerMessageType.Inventory,
      requestId: 3,
      inventory: [...emptyInventory()].map((_, i) =>
        i === 2 ? { defId: 'potion.minor', count: maxStackOf('potion.minor') } : null,
      ),
      equipment: EMPTY_EQUIPMENT,
    },
    { type: ServerMessageType.Pong, nonce: 88, serverTick: 1000 },
    { type: ServerMessageType.Error, code: 7, message: 'rejected' },
    { type: ServerMessageType.Disconnect, reason: 'kicked' },
  ];

  it.each(serverMessages.map((m) => [m.type, m] as const))(
    'server type 0x%s survives encode/decode',
    (_type, message) => {
      expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
    },
  );

  it('round-trips a delta carrying every combination of field bits', () => {
    const message: ServerMessage = {
      type: ServerMessageType.Delta,
      tick: 7,
      ackInputSeq: 3,
      removed: [4, 9, 300],
      upserts: [
        {
          id: 1,
          fields:
            EntityField.Spawn |
            EntityField.Position |
            EntityField.Facing |
            EntityField.Health |
            EntityField.Activity |
            EntityField.Level,
          kind: 0,
          typeId: 'player',
          position: { x: 1.5, y: -2.5, z: 0 },
          facing: 0.25,
          health: 90,
          maxHealth: 120,
          activity: 1,
          activityUntilTick: 30,
          level: 4,
        },
        { id: 2, fields: EntityField.Position, position: { x: 10, y: 20, z: -1.5 } },
        { id: 3, fields: EntityField.Health, health: 5, maxHealth: 40 },
      ],
    };
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
  });

  it('refuses an unknown type byte instead of guessing', () => {
    expect(() => decodeClientMessage(new Uint8Array([0x3e]))).toThrow(CodecError);
    expect(() => decodeServerMessage(new Uint8Array([0x7e]))).toThrow(CodecError);
  });
});

describe('admin message round-trip', () => {
  const requests: AdminRequest[] = [
    { type: AdminMessageType.Auth, token: 'a.b.c' },
    { type: AdminMessageType.ListPlayers },
    { type: AdminMessageType.Kick, playerId: 'bob', reason: 'afk' },
    { type: AdminMessageType.Ban, playerId: 'bob', seconds: 600, reason: 'cheating' },
    { type: AdminMessageType.Mute, playerId: 'bob', seconds: 0 },
    { type: AdminMessageType.Teleport, playerId: 'bob', x: -1600, y: 2500 },
    { type: AdminMessageType.SpawnEntity, entityType: 'ravager', x: 100, y: 200, count: 12 },
    { type: AdminMessageType.DespawnEntity, entityId: 65535 },
    { type: AdminMessageType.TriggerEvent, eventName: 'raid', x: 5, y: 6, magnitude: 8 },
    { type: AdminMessageType.Broadcast, text: 'server restarting' },
    { type: AdminMessageType.SetConfig, key: 'spawnRateMultiplier', value: 2.5 },
    { type: AdminMessageType.GetConfig },
    { type: AdminMessageType.GetAudit, limit: 50 },
  ];

  it.each(requests.map((r) => [r.type, r] as const))(
    'admin request 0x%s survives encode/decode',
    (_type, request) => {
      expect(decodeAdminRequest(encodeAdminRequest(request))).toEqual(request);
    },
  );

  it('marks exactly the admin range as admin', () => {
    for (const request of requests) expect(isAdminRequest(request.type)).toBe(true);
    expect(isAdminRequest(ClientMessageType.Input)).toBe(false);
    expect(isAdminRequest(ServerMessageType.Delta)).toBe(false);
    expect(isAdminRequest(AdminReplyType.Ok)).toBe(false);
  });

  const replies: AdminReply[] = [
    { type: AdminReplyType.Ok, requestType: AdminMessageType.Kick, message: 'kicked bob' },
    { type: AdminReplyType.Error, requestType: AdminMessageType.Ban, message: 'no such player' },
    {
      type: AdminReplyType.PlayerList,
      players: [
        {
          playerId: 'alice',
          displayName: 'Alice',
          entityId: 1,
          x: 600,
          y: 450,
          z: 0,
          zone: 'Hearthstead',
          chunk: '6,4',
          health: 100,
          maxHealth: 155,
          level: 3,
          attackDamage: 12.5,
          moveSpeed: 147.5,
          muted: false,
        },
      ],
    },
    { type: AdminReplyType.Config, entries: [['spawnRateMultiplier', 1.5] as const] },
    {
      type: AdminReplyType.Audit,
      entries: [
        {
          at: 1700000000000,
          actor: 'dev',
          action: 'admin:kick',
          target: 'bob',
          detail: 'afk',
          accepted: true,
        },
      ],
    },
  ];

  it.each(replies.map((r) => [r.type, r] as const))(
    'admin reply 0x%s survives encode/decode',
    (_type, reply) => {
      expect(decodeAdminReply(encodeAdminReply(reply))).toEqual(reply);
    },
  );
});
