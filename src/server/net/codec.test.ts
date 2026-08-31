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
  type ServerMessage,
} from './messages.js';
import {
  AdminMessageType,
  AdminProgressMode,
  AdminReplyType,
  ClientMessageType,
  EntityField,
  isAdminRequest,
  ServerMessageType,
} from './protocol.js';
import { CLIENT_CORPUS, SERVER_CORPUS } from './wire-corpus.js';

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
  // The corpus lives in wire-corpus.ts (spec 258), which is also what
  // wireFingerprint hashes -- one canonical set of message shapes rather than
  // this test keeping a partial copy that can drift from the fingerprint's.
  it.each(CLIENT_CORPUS.map((m) => [m.type, m] as const))(
    'client type 0x%s survives encode/decode',
    (_type, message) => {
      expect(decodeClientMessage(encodeClientMessage(message))).toEqual(message);
    },
  );

  it.each(SERVER_CORPUS.map((m) => [m.type, m] as const))(
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
    // Spec 153: all four modes, so none of them is the one nobody encoded.
    { type: AdminMessageType.SetProgress, playerId: 'bob', mode: AdminProgressMode.AddLevels, amount: 5 },
    { type: AdminMessageType.SetProgress, playerId: 'bob', mode: AdminProgressMode.SetLevel, amount: 1 },
    { type: AdminMessageType.SetProgress, playerId: 'bob', mode: AdminProgressMode.AddExperience, amount: 4_000_000_000 },
    { type: AdminMessageType.SetProgress, playerId: 'bob', mode: AdminProgressMode.SetExperience, amount: 0 },
    { type: AdminMessageType.GiveItem, playerId: 'bob', defId: 'potion.minor', count: 5 },
    { type: AdminMessageType.GetItems },
    { type: AdminMessageType.Kill, playerId: 'bob' },
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
          experience: 340,
          experienceToNextLevel: 671,
          unspentProgressionPoints: 14,
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
    {
      type: AdminReplyType.ItemList,
      items: [
        { id: 'sword.worn', name: 'Worn Sword', slot: 'mainHand', levelRequirement: 1, maxStack: 1 },
        { id: 'potion.minor', name: 'Minor Potion', slot: '-', levelRequirement: 1, maxStack: 10 },
      ],
    },
  ];

  it.each(replies.map((r) => [r.type, r] as const))(
    'admin reply 0x%s survives encode/decode',
    (_type, reply) => {
      expect(decodeAdminReply(encodeAdminReply(reply))).toEqual(reply);
    },
  );

  it('refuses an item list that declares more items than the frame holds', () => {
    // Spec 152's primitive, on the one admin reply that has a counted collection:
    // a count of ~2^30 in a six-byte frame is a frame that cannot exist.
    const frame = Uint8Array.from([AdminReplyType.ItemList, 0x80, 0x80, 0x80, 0x40]);
    expect(() => decodeAdminReply(frame)).toThrow(CodecError);
  });

  it('refuses an unknown progress mode rather than defaulting to one', () => {
    const frame = encodeAdminRequest({
      type: AdminMessageType.SetProgress,
      playerId: 'bob',
      mode: AdminProgressMode.AddLevels,
      amount: 1,
    });
    // Byte 0 is the type, 1 is the id's length, then 3 bytes of 'bob', then mode.
    frame[5] = 99;
    expect(() => decodeAdminRequest(frame)).toThrow(CodecError);
  });
});
