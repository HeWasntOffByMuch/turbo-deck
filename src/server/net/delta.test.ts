import { describe, expect, it } from 'vitest';
import { ActivityValue, AggroValue, EntityKindValue, type ServerEntity } from '../sim/types.js';
import type { EffectiveStats } from '../state/types.js';
import { DeltaTracker } from './delta.js';
import { decodeServerMessage, encodeServerMessage } from './messages.js';
import { EntityField, ServerMessageType } from './protocol.js';
import { StatusId, adaptedKey } from '../sim/statuses.js';
import { ADAPTED_ID, visualFor } from '../data/status-visuals.js';
import { NO_ATTACK_SPEED } from '../sim/attack-timing.js';
import { NEUTRAL_TRAITS } from '../player/derived.js';
import { blankProgression } from '../sim/world.js';

const STATS: EffectiveStats = {
  maxHealth: 100,
  moveSpeed: 147.5,
  turnRate: 180,
  attackDamage: 10,
  attackRange: 50,
  baseAttackTimeTicks: 8,
  ...NO_ATTACK_SPEED,
  armor: 0,
  spellPower: 1,
  critChance: 0,
  maxResource: 30,
  resourceRegen: 0.05,
  basicAttackId: 'melee.slash',
  traits: NEUTRAL_TRAITS,
};

function entity(id: number, overrides: Partial<ServerEntity> = {}): ServerEntity {
  return {
    id,
    kind: EntityKindValue.Monster,
    typeId: 'grazer',
    ownerPlayerId: null,
    position: { x: 100, y: 200, z: 0 },
    facing: 0,
    mote: null,
    health: 100,
    level: 1,
    zoneId: 'greenmarch',
    stats: STATS,
    activity: ActivityValue.Idle,
    activityUntilTick: 0,
    radius: 22,
    targetId: null,
    aggro: AggroValue.Calm,
    aggroUntilTick: 0,
    path: null,
    pathIndex: 0,
    repathAtTick: 0,
    pathGoal: null,
    claimedPosition: null,
    claimedSeq: 0,
    pardon: null,
    spawnerId: null,
    anchor: null,
    resource: 0,
    cast: null,
    cooldowns: {},
    projectile: null,
    dropAim: null,
    drop: null,
    ...blankProgression(),
    ...overrides,
  };
}

/** The wire index for a status id, so a test reads by name rather than by number. */
function wireOf(id: string): number {
  const visual = visualFor(id);
  if (!visual) throw new Error(`no visible row for ${id}`);
  return visual.wire;
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
        EntityField.Poise |
        EntityField.Shield |
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
        EntityField.Poise |
        EntityField.Shield |
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

  describe('identity (spec 145)', () => {
    const player = (id: number): ServerEntity =>
      entity(id, { kind: EntityKindValue.Player, typeId: 'player', ownerPlayerId: `p${id}` });
    const named = (e: ServerEntity): string | null =>
      e.kind === EntityKindValue.Player ? `Name${e.id}` : null;

    it('rides with the first sight of a player, and names them', () => {
      const tracker = new DeltaTracker();
      const delta = tracker.build(1, 0, [player(3)], named);
      const upsert = delta.upserts[0];
      if (!upsert) throw new Error('expected an upsert');
      expect(upsert.fields & EntityField.Identity).toBeTruthy();
      expect(upsert.name).toBe('Name3');
      expect(upsert.turnRate).toBe(STATS.turnRate);
    });

    it('is absent for anything a content table already answers for', () => {
      const tracker = new DeltaTracker();
      // A monster: `named` returns null, so no identity and no bytes.
      const delta = tracker.build(1, 0, [entity(9)], named);
      const upsert = delta.upserts[0];
      if (!upsert) throw new Error('expected an upsert');
      expect(upsert.fields & EntityField.Identity).toBeFalsy();
      expect(upsert.name).toBeUndefined();
    });

    it('costs nothing after the first sight', () => {
      const tracker = new DeltaTracker();
      tracker.build(1, 0, [player(3)], named);
      // Moved, but still the same person at the same turn rate.
      const delta = tracker.build(2, 0, [moved(player(3), 140, 200)], named);
      const upsert = delta.upserts[0];
      if (!upsert) throw new Error('expected an upsert');
      expect(upsert.fields & EntityField.Position).toBeTruthy();
      expect(upsert.fields & EntityField.Identity).toBeFalsy();
    });

    it('is re-sent when the turn rate moves, because dexterity can change it', () => {
      const tracker = new DeltaTracker();
      tracker.build(1, 0, [player(3)], named);
      const faster = entity(3, {
        kind: EntityKindValue.Player,
        typeId: 'player',
        ownerPlayerId: 'p3',
        stats: { ...STATS, turnRate: STATS.turnRate + 40 },
      });
      const delta = tracker.build(2, 0, [faster], named);
      const upsert = delta.upserts[0];
      if (!upsert) throw new Error('expected an upsert');
      expect(upsert.fields & EntityField.Identity).toBeTruthy();
      expect(upsert.turnRate).toBe(STATS.turnRate + 40);
    });

    it('survives the wire unchanged', () => {
      const tracker = new DeltaTracker();
      const delta = tracker.build(1, 0, [player(3), entity(9)], named);
      expect(decodeServerMessage(encodeServerMessage(delta))).toEqual(delta);
    });
  });
});

describe('statuses on the wire (spec 185)', () => {
  /** A body carrying one live status, expiring at `until`. */
  function carrying(
    id: number,
    held: Record<string, { expiresAtTick: number; stacks: number; magnitude: number }>,
  ): ServerEntity {
    return entity(id, { statuses: held });
  }

  const flow = (until: number, stacks = 1) => ({
    [StatusId.Flow]: { expiresAtTick: until, stacks, magnitude: 0 },
  });

  it('sends no status field for a body carrying nothing', () => {
    const tracker = new DeltaTracker();
    const delta = tracker.build(1, 0, [entity(7)]);
    // Not even on a first sight, which is the one delta sent in full: a byte per
    // body to say "nothing" is a cost every prop and projectile would carry.
    expect(delta.upserts[0]?.fields && EntityField.Statuses).toBeTruthy();
    expect((delta.upserts[0]?.fields ?? 0) & EntityField.Statuses).toBe(0);
    expect(delta.upserts[0]?.statuses).toBeUndefined();
  });

  it('sends a status on first sight, and only the visible ones', () => {
    const tracker = new DeltaTracker();
    const delta = tracker.build(1, 0, [
      carrying(7, {
        ...flow(200, 2),
        // Every one of these is live in the sim and none may be shown.
        [StatusId.RecentlyHit]: { expiresAtTick: 200, stacks: 1, magnitude: 0 },
        [StatusId.InCombat]: { expiresAtTick: 900, stacks: 1, magnitude: 0 },
        [StatusId.SecondWindSpent]: { expiresAtTick: 900, stacks: 1, magnitude: 0 },
      }),
    ]);

    expect((delta.upserts[0]?.fields ?? 0) & EntityField.Statuses).toBeTruthy();
    expect(delta.upserts[0]?.statuses).toEqual([
      { wire: wireOf(StatusId.Flow), stacks: 2, expiresAtTick: 200 },
    ]);
  });

  it('drops a status whose window has already passed', () => {
    // `expireStatuses` is a garbage collector rather than a rule, so an expired
    // entry can still be sitting in the map when the delta is built.
    const tracker = new DeltaTracker();
    const delta = tracker.build(500, 0, [carrying(7, flow(200))]);
    expect((delta.upserts[0]?.fields ?? 0) & EntityField.Statuses).toBe(0);
  });

  it('collapses the adaptation family and keeps the deepest stack', () => {
    const tracker = new DeltaTracker();
    const delta = tracker.build(1, 0, [
      carrying(7, {
        [adaptedKey('bolt.arcane')]: { expiresAtTick: 300, stacks: 2, magnitude: 0 },
        [adaptedKey('melee.slash')]: { expiresAtTick: 400, stacks: 5, magnitude: 0 },
        [adaptedKey('ground.quake')]: { expiresAtTick: 500, stacks: 1, magnitude: 0 },
      }),
    ]);

    // One mark, carrying the largest count and the expiry that goes with it --
    // not the deepest stack wearing the longest clock.
    expect(delta.upserts[0]?.statuses).toEqual([
      { wire: wireOf(ADAPTED_ID), stacks: 5, expiresAtTick: 400 },
    ]);
  });

  it('sorts by wire index, so the map’s iteration order cannot fake a change', () => {
    const tracker = new DeltaTracker();
    const first = tracker.build(1, 0, [
      carrying(7, {
        [StatusId.Sundered]: { expiresAtTick: 300, stacks: 1, magnitude: 0 },
        [StatusId.Flow]: { expiresAtTick: 300, stacks: 1, magnitude: 0 },
      }),
    ]);
    const wires = (first.upserts[0]?.statuses ?? []).map((status) => status.wire);
    expect(wires).toEqual([...wires].sort((a, b) => a - b));

    // The same set, inserted the other way round, is not a change.
    const second = tracker.build(2, 0, [
      carrying(7, {
        [StatusId.Flow]: { expiresAtTick: 300, stacks: 1, magnitude: 0 },
        [StatusId.Sundered]: { expiresAtTick: 300, stacks: 1, magnitude: 0 },
      }),
    ]);
    expect(second.upserts).toEqual([]);
  });

  it('stays a delta: an unchanged set says nothing, a refreshed one says so', () => {
    const tracker = new DeltaTracker();
    tracker.build(1, 0, [carrying(7, flow(200))]);
    expect(tracker.build(2, 0, [carrying(7, flow(200))]).upserts).toEqual([]);

    // A refresh to a new expiry is a real change -- Flow is re-stamped on every
    // follow-through walked out of.
    const refreshed = tracker.build(3, 0, [carrying(7, flow(260))]);
    expect(refreshed.upserts[0]?.fields).toBe(EntityField.Statuses);
    expect(refreshed.upserts[0]?.statuses?.[0]?.expiresAtTick).toBe(260);

    // And so is a deeper stack at the same expiry.
    const stacked = tracker.build(4, 0, [carrying(7, flow(260, 2))]);
    expect(stacked.upserts[0]?.statuses?.[0]?.stacks).toBe(2);
  });

  it('sends the empty list when the last status falls off', () => {
    // Without this a status could only ever be added: the client replaces the
    // whole set on the field, so "nothing left" has to be said out loud.
    const tracker = new DeltaTracker();
    tracker.build(1, 0, [carrying(7, flow(200))]);
    const gone = tracker.build(2, 0, [entity(7)]);
    expect(gone.upserts[0]?.fields).toBe(EntityField.Statuses);
    expect(gone.upserts[0]?.statuses).toEqual([]);
  });

  it('round-trips through the codec, absolute ticks intact', () => {
    const tracker = new DeltaTracker();
    const built = tracker.build(1, 0, [
      carrying(7, {
        ...flow(4321, 3),
        [StatusId.Exposed]: { expiresAtTick: 99_999, stacks: 1, magnitude: 0.15 },
      }),
    ]);

    const decoded = decodeServerMessage(encodeServerMessage(built));
    if (decoded?.type !== ServerMessageType.Delta) throw new Error('not a delta');
    expect(decoded.upserts[0]?.statuses).toEqual([
      { wire: wireOf(StatusId.Flow), stacks: 3, expiresAtTick: 4321 },
      { wire: wireOf(StatusId.Exposed), stacks: 1, expiresAtTick: 99_999 },
    ]);
    // A remainder would have shifted; an absolute tick does not.
    expect(decoded.upserts[0]?.statuses?.[1]?.expiresAtTick).toBe(99_999);
  });

  it('round-trips an empty list as an empty list, not as absence', () => {
    const tracker = new DeltaTracker();
    tracker.build(1, 0, [carrying(7, flow(200))]);
    const gone = tracker.build(2, 0, [entity(7)]);

    const decoded = decodeServerMessage(encodeServerMessage(gone));
    if (decoded?.type !== ServerMessageType.Delta) throw new Error('not a delta');
    expect(decoded.upserts[0]?.statuses).toEqual([]);
  });
});
