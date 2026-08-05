import { describe, expect, it } from 'vitest';
import { ActivityValue, EntityKindValue, type ServerEntity } from '../sim/types.js';
import type { EffectiveStats } from '../state/types.js';
import { DeltaTracker } from './delta.js';
import { decodeServerMessage, encodeServerMessage } from './messages.js';
import { EntityField } from './protocol.js';

const STATS: EffectiveStats = {
  maxHealth: 100,
  moveSpeed: 147.5,
  turnRate: 180,
  attackDamage: 10,
  attackRange: 50,
  attackCooldownTicks: 8,
  armor: 0,
  spellPower: 1,
  knockbackResist: 0,
  critChance: 0,
};

function entity(id: number, overrides: Partial<ServerEntity> = {}): ServerEntity {
  return {
    id,
    kind: EntityKindValue.Monster,
    typeId: 'grazer',
    ownerPlayerId: null,
    position: { x: 100, y: 200, z: 0 },
    facing: 0,
    health: 100,
    level: 1,
    zoneId: 'greenmarch',
    stats: STATS,
    activity: ActivityValue.Idle,
    activityUntilTick: 0,
    attackReadyTick: 0,
    knockbackX: 0,
    knockbackY: 0,
    knockbackUntilTick: 0,
    hitstopUntilTick: 0,
    radius: 22,
    targetId: null,
    claimedPosition: null,
    ...overrides,
  };
}

function moved(source: ServerEntity, x: number, y: number): ServerEntity {
  return { ...source, position: { x, y, z: source.position.z } };
}

describe('delta tracking', () => {
  it('sends a newly visible entity in full, identity included', () => {
    const tracker = new DeltaTracker();
    const delta = tracker.build(1, 0, [entity(7)]);

    expect(delta.upserts).toHaveLength(1);
    const record = delta.upserts[0];
    expect(record?.fields).toBe(
      EntityField.Spawn |
        EntityField.Position |
        EntityField.Facing |
        EntityField.Health |
        EntityField.Activity |
        EntityField.Level,
    );
    expect(record?.typeId).toBe('grazer');
    expect(record?.kind).toBe(EntityKindValue.Monster);
    expect(record?.position).toEqual({ x: 100, y: 200, z: 0 });
  });

  it('says nothing at all about an entity that did not change', () => {
    const tracker = new DeltaTracker();
    const target = entity(7);
    tracker.build(1, 0, [target]);
    const second = tracker.build(2, 0, [target]);

    expect(second.upserts).toEqual([]);
    expect(second.removed).toEqual([]);
    expect(DeltaTracker.isEmpty(second)).toBe(true);
  });

  it('sends only the fields that actually changed', () => {
    const tracker = new DeltaTracker();
    const target = entity(7);
    tracker.build(1, 0, [target]);

    const second = tracker.build(2, 0, [moved(target, 140, 200)]);
    expect(second.upserts).toHaveLength(1);
    expect(second.upserts[0]?.fields).toBe(EntityField.Position);
    // No identity, no health, no level -- none of them moved.
    expect(second.upserts[0]?.typeId).toBeUndefined();
    expect(second.upserts[0]?.health).toBeUndefined();

    const third = tracker.build(3, 0, [{ ...moved(target, 140, 200), health: 60 }]);
    expect(third.upserts[0]?.fields).toBe(EntityField.Health);
    expect(third.upserts[0]?.health).toBe(60);
    expect(third.upserts[0]?.position).toBeUndefined();
  });

  it('treats float noise below the epsilon as no change', () => {
    const tracker = new DeltaTracker();
    const target = entity(7);
    tracker.build(1, 0, [target]);
    const jittered = tracker.build(2, 0, [moved(target, 100.0001, 200.0001)]);
    expect(DeltaTracker.isEmpty(jittered)).toBe(true);
  });

  it('removes an entity that left the interest set, exactly once', () => {
    const tracker = new DeltaTracker();
    tracker.build(1, 0, [entity(7), entity(8)]);

    const second = tracker.build(2, 0, [entity(7)]);
    expect(second.removed).toEqual([8]);

    const third = tracker.build(3, 0, [entity(7)]);
    expect(third.removed).toEqual([]);
    expect(DeltaTracker.isEmpty(third)).toBe(true);
  });

  it('re-sends an entity in full when it comes back into view', () => {
    const tracker = new DeltaTracker();
    tracker.build(1, 0, [entity(7)]);
    tracker.build(2, 0, []);
    const returning = tracker.build(3, 0, [entity(7)]);
    expect(returning.upserts[0]?.fields).toBe(
      EntityField.Spawn |
        EntityField.Position |
        EntityField.Facing |
        EntityField.Health |
        EntityField.Activity |
        EntityField.Level,
    );
  });

  it('forgets an entity on request, so the next sighting is a full record', () => {
    const tracker = new DeltaTracker();
    tracker.build(1, 0, [entity(7)]);
    tracker.forget(7);
    const after = tracker.build(2, 0, [entity(7)]);
    expect((after.upserts[0]?.fields ?? 0) & EntityField.Spawn).toBeTruthy();
  });

  it('carries the acknowledged input sequence, which is what a client reconciles from', () => {
    const tracker = new DeltaTracker();
    const delta = tracker.build(42, 17, [entity(7)]);
    expect(delta.tick).toBe(42);
    expect(delta.ackInputSeq).toBe(17);
  });

  it('survives the wire unchanged', () => {
    const tracker = new DeltaTracker();
    tracker.build(1, 0, [entity(7), entity(8)]);
    const delta = tracker.build(2, 5, [moved(entity(7), 150, 250)]);
    expect(decodeServerMessage(encodeServerMessage(delta))).toEqual(delta);
  });

  it('costs far fewer bytes than a full snapshot once the world settles', () => {
    const tracker = new DeltaTracker();
    const crowd = Array.from({ length: 50 }, (_, index) => entity(index + 1));
    const full = encodeServerMessage(tracker.build(1, 0, crowd)).length;

    // One entity of fifty moves.
    const first = crowd[0];
    if (!first) throw new Error('expected a crowd');
    const nudged = [moved(first, 140, 200), ...crowd.slice(1)];
    const delta = encodeServerMessage(tracker.build(2, 0, nudged)).length;

    expect(delta).toBeLessThan(full / 10);
  });
});
