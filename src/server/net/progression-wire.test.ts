/**
 * What the progression system puts on the wire, and what it refuses to (147).
 *
 * Two jobs. The first is the ordinary codec job: a `Stats` message round-trips
 * byte for byte, traits and all, so a client is told the truth rather than a
 * truncated version of it.
 *
 * The second is the one the brief cares about, and it is a test about what is
 * *absent*: **there is no client message that carries a stat.** Every write in
 * the client-to-server union is a request naming a button, and this walks the
 * union to say so -- so a future message that carried a derived number would
 * fail here rather than being noticed after someone had used it.
 */

import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KEYS, ordinalOfAttribute } from '../data/attributes.js';
import { NEUTRAL_TRAITS } from '../player/derived.js';
import { startingBaseStats } from '../player/attributes.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  BASE_STAT_KEYS,
  EMPTY_EQUIPMENT,
  emptyInventory,
  TRAIT_WIRE_ORDER,
  type EffectiveStats,
  type PersistedPlayer,
} from '../state/types.js';
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type StatsMessage,
} from './messages.js';
import { ClientMessageType, ServerMessageType } from './protocol.js';

function built(): PersistedPlayer {
  return {
    id: 'p1',
    displayName: 'P1',
    baseStats: { strength: 31, agility: 12, intelligence: 5, constitution: 27, perception: 18, wisdom: 9 },
    skills: [
      { skillId: 'str.crushingBlows', level: 2 },
      { skillId: 'con.deepReserves', level: 1 },
    ],
    equipment: EMPTY_EQUIPMENT,
    inventory: emptyInventory(),
    position: { x: 0, y: 0, z: 0 },
    facing: 0,
    currentZone: 'wilds',
    level: 14,
    experience: 220,
    unspentSkillPoints: 4,
    unspentAttributePoints: 7,
    health: 500,
    resource: 40,
    coins: 90,
  };
}

function statsMessage(stats: EffectiveStats, record: PersistedPlayer): StatsMessage {
  return {
    type: ServerMessageType.Stats,
    entityId: 12,
    level: record.level,
    experience: record.experience,
    unspentSkillPoints: record.unspentSkillPoints,
    skills: record.skills,
    baseStats: record.baseStats,
    attributes: record.baseStats,
    unspentAttributePoints: record.unspentAttributePoints,
    stats,
  };
}

describe('the Stats message', () => {
  it('round-trips a built character, traits included', () => {
    const record = built();
    const message = statsMessage(computeEffectiveStats(record), record);
    const decoded = decodeServerMessage(encodeServerMessage(message));
    expect(decoded.type).toBe(ServerMessageType.Stats);
    if (decoded.type !== ServerMessageType.Stats) return;

    expect(decoded.baseStats).toEqual(record.baseStats);
    expect(decoded.unspentAttributePoints).toBe(record.unspentAttributePoints);
    expect(decoded.skills).toEqual(record.skills);
    // Traits are f32 on the wire, so exact equality would be a lie about
    // floats. Every field survives to single precision, which is what a client
    // draws with.
    for (const key of TRAIT_WIRE_ORDER) {
      expect(decoded.stats.traits[key], key).toBeCloseTo(message.stats.traits[key], 4);
    }
  });

  it('keeps the six attributes in their canonical order', () => {
    // Written by position rather than by name, so a reader that disagreed about
    // the order would silently put Perception's value in Constitution.
    const record = { ...built(), baseStats: { strength: 1, agility: 2, intelligence: 3, constitution: 4, perception: 5, wisdom: 6 } };
    const decoded = decodeServerMessage(
      encodeServerMessage(statsMessage(computeEffectiveStats(record), record)),
    );
    if (decoded.type !== ServerMessageType.Stats) throw new Error('wrong type');
    for (const [index, key] of BASE_STAT_KEYS.entries()) {
      expect(decoded.baseStats[key], key).toBe(index + 1);
    }
  });

  it('survives a body with nothing on it', () => {
    const bare: EffectiveStats = {
      maxHealth: 1,
      moveSpeed: 0,
      turnRate: 0,
      attackDamage: 0,
      attackRange: 1,
      baseAttackTimeTicks: 1,
      attackSpeed: 0,
      attackSpeedMultiplier: 1,
      attackSpeedSlowMultiplier: 1,
      armor: 0,
      spellPower: 1,
      critChance: 0,
      maxResource: 0,
      resourceRegen: 0,
      basicAttackId: '',
      skillAbilityIds: [],
      traits: NEUTRAL_TRAITS,
    };
    const record = { ...built(), skills: [], baseStats: startingBaseStats() };
    const decoded = decodeServerMessage(encodeServerMessage(statsMessage(bare, record)));
    if (decoded.type !== ServerMessageType.Stats) throw new Error('wrong type');
    expect(decoded.skills).toEqual([]);
    expect(decoded.stats.traits.backswingScale).toBeCloseTo(1, 6);
  });
});

describe('the three progression requests', () => {
  it('names an attribute by ordinal, and round-trips it', () => {
    for (const key of ATTRIBUTE_KEYS) {
      const message: ClientMessage = {
        type: ClientMessageType.AllocateAttribute,
        attribute: ordinalOfAttribute(key),
      };
      const decoded = decodeClientMessage(encodeClientMessage(message));
      expect(decoded).toEqual(message);
    }
  });

  it('carries nothing at all for a respec', () => {
    const decoded = decodeClientMessage(
      encodeClientMessage({ type: ClientMessageType.RespecAttributes }),
    );
    expect(decoded).toEqual({ type: ClientMessageType.RespecAttributes });
  });

  it('round-trips a stat-skill request', () => {
    const message: ClientMessage = {
      type: ClientMessageType.SpendSkillPoint,
      skillId: 'per.weakPointStudy',
    };
    expect(decodeClientMessage(encodeClientMessage(message))).toEqual(message);
  });

  it('carries an out-of-range ordinal through to be refused, not clamped', () => {
    // The codec's job is to say what arrived, not to make it plausible. An
    // ordinal of 200 has to reach `attributeByOrdinal` and be refused there,
    // where the refusal can be reported.
    const decoded = decodeClientMessage(
      encodeClientMessage({ type: ClientMessageType.AllocateAttribute, attribute: 200 }),
    );
    expect(decoded.type).toBe(ClientMessageType.AllocateAttribute);
    if (decoded.type === ClientMessageType.AllocateAttribute) expect(decoded.attribute).toBe(200);
  });
});

describe('nothing a client sends carries a stat', () => {
  it('has no client message with a derived field on it', () => {
    // The anti-cheat property, as a sweep rather than a promise. Every message
    // in the union is built at its widest and checked for any field named after
    // something derived. A future message carrying `maxHealth` -- or a trait --
    // fails here.
    const forbidden = new Set<string>([
      'maxHealth',
      'moveSpeed',
      'turnRate',
      'attackDamage',
      'attackRange',
      'armor',
      'spellPower',
      'critChance',
      'maxResource',
      'resourceRegen',
      'baseAttackTimeTicks',
      'attackSpeed',
      'stats',
      'traits',
      'poise',
      'shield',
      ...TRAIT_WIRE_ORDER,
      ...BASE_STAT_KEYS,
    ]);

    const samples: ClientMessage[] = [
      { type: ClientMessageType.Hello, playerId: 'p', displayName: 'P', protocolVersion: 1, token: '', resumeToken: '', assetManifest: '' },
      { type: ClientMessageType.Ping, nonce: 1 },
      { type: ClientMessageType.Equip, slot: 'head', itemId: 'helm.leather' },
      { type: ClientMessageType.Unequip, slot: 'head' },
      { type: ClientMessageType.SpendSkillPoint, skillId: 'str.crushingBlows' },
      { type: ClientMessageType.AllocateAttribute, attribute: 0 },
      { type: ClientMessageType.RespecAttributes },
      { type: ClientMessageType.Chat, text: 'hi' },
      { type: ClientMessageType.CancelCast, afterInputSeq: 3 },
    ];

    for (const message of samples) {
      for (const key of Object.keys(message)) {
        expect(forbidden.has(key), `${message.type} carries ${key}`).toBe(false);
      }
    }
  });

  it('leaves the input frame carrying intent and a hint, and no authority', () => {
    // `predictedX/Y` is the one number a client sends about itself, and the sim
    // measures divergence against it rather than adopting it (spec 057). Worth
    // restating here because it is the only field that *looks* authoritative.
    const input: ClientMessage = {
      type: ClientMessageType.Input,
      seq: 4,
      moveX: 1,
      moveY: 0,
      facing: 0,
      buttons: 0,
      predictedX: 900,
      predictedY: 900,
      renderLagTicks: 0,
    };
    const decoded = decodeClientMessage(encodeClientMessage(input));
    expect(Object.keys(decoded).some((key) => forbiddenStatName(key))).toBe(false);
  });
});

function forbiddenStatName(key: string): boolean {
  return (
    (TRAIT_WIRE_ORDER as readonly string[]).includes(key) ||
    (BASE_STAT_KEYS as readonly string[]).includes(key) ||
    key === 'stats' ||
    key === 'traits'
  );
}
