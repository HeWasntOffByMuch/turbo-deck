/**
 * Per-connection delta tracking (spec 056).
 *
 * One of these per connected client. It remembers what that client has been
 * told and sends only the difference: an entity whose position has not changed
 * costs zero bytes, an entity that moved costs its id, a flag byte and twelve
 * bytes of position.
 *
 * Two things make that safe rather than merely small:
 *
 *  - an entity entering the client's interest set is always sent in full
 *    (the {@link EntityField.Spawn} bit), so a client never has to infer a
 *    field it was never told;
 *  - an entity leaving the set is explicitly removed, so a client that walks
 *    away does not keep rendering a stale ghost at the edge of its view.
 *
 * Float comparisons are quantised. Without that, floating-point noise in the
 * last bits would mark every entity dirty every tick and the delta would be a
 * full snapshot wearing a costume.
 */

import { EntityField } from './protocol.js';
import type { DeltaMessage, EntityDelta } from './messages.js';
import { ServerMessageType } from './protocol.js';
import type { ServerEntity } from '../sim/types.js';

/** Position changes below this are noise, not movement. */
const POSITION_EPSILON = 0.01;
/** ~0.06 degrees; below this a facing change is invisible. */
const FACING_EPSILON = 0.001;
const HEALTH_EPSILON = 0.01;

interface KnownEntity {
  x: number;
  y: number;
  z: number;
  facing: number;
  health: number;
  maxHealth: number;
  activity: number;
  activityUntilTick: number;
  level: number;
  mainHandId: string;
}

function snapshotOf(entity: ServerEntity): KnownEntity {
  return {
    x: entity.position.x,
    y: entity.position.y,
    z: entity.position.z,
    facing: entity.facing,
    health: entity.health,
    maxHealth: entity.stats.maxHealth,
    activity: entity.activity,
    activityUntilTick: entity.activityUntilTick,
    level: entity.level,
    mainHandId: entity.mainHandId,
  };
}

export class DeltaTracker {
  private readonly known = new Map<number, KnownEntity>();

  /**
   * Builds the frame for one tick. `visible` is this client's interest set,
   * already filtered by the chunk manager -- interest is not this class's job,
   * it only reports change within whatever it is shown.
   */
  build(tick: number, ackInputSeq: number, visible: readonly ServerEntity[]): DeltaMessage {
    const upserts: EntityDelta[] = [];
    const seen = new Set<number>();

    for (const entity of visible) {
      seen.add(entity.id);
      const previous = this.known.get(entity.id);
      const next = snapshotOf(entity);

      if (!previous) {
        // First sight: everything, including identity.
        upserts.push({
          id: entity.id,
          fields:
            EntityField.Spawn |
            EntityField.Position |
            EntityField.Facing |
            EntityField.Health |
            EntityField.Activity |
            EntityField.Level |
            EntityField.MainHand,
          kind: entity.kind,
          typeId: entity.typeId,
          position: entity.position,
          facing: entity.facing,
          health: entity.health,
          maxHealth: entity.stats.maxHealth,
          activity: entity.activity,
          activityUntilTick: entity.activityUntilTick,
          level: entity.level,
          mainHandId: entity.mainHandId,
        });
        this.known.set(entity.id, next);
        continue;
      }

      let fields = 0;
      if (
        Math.abs(next.x - previous.x) > POSITION_EPSILON ||
        Math.abs(next.y - previous.y) > POSITION_EPSILON ||
        Math.abs(next.z - previous.z) > POSITION_EPSILON
      ) {
        fields |= EntityField.Position;
      }
      if (Math.abs(next.facing - previous.facing) > FACING_EPSILON) fields |= EntityField.Facing;
      if (
        Math.abs(next.health - previous.health) > HEALTH_EPSILON ||
        Math.abs(next.maxHealth - previous.maxHealth) > HEALTH_EPSILON
      ) {
        fields |= EntityField.Health;
      }
      if (
        next.activity !== previous.activity ||
        next.activityUntilTick !== previous.activityUntilTick
      ) {
        fields |= EntityField.Activity;
      }
      if (next.level !== previous.level) fields |= EntityField.Level;
      // A string compare, and it costs nothing: switching weapons is a keypress
      // a person makes, not something that happens every tick.
      if (next.mainHandId !== previous.mainHandId) fields |= EntityField.MainHand;

      if (fields === 0) continue;

      upserts.push({
        id: entity.id,
        fields,
        ...(fields & EntityField.Position ? { position: entity.position } : {}),
        ...(fields & EntityField.Facing ? { facing: entity.facing } : {}),
        ...(fields & EntityField.Health
          ? { health: entity.health, maxHealth: entity.stats.maxHealth }
          : {}),
        ...(fields & EntityField.Activity
          ? { activity: entity.activity, activityUntilTick: entity.activityUntilTick }
          : {}),
        ...(fields & EntityField.Level ? { level: entity.level } : {}),
        ...(fields & EntityField.MainHand ? { mainHandId: entity.mainHandId } : {}),
      });
      this.known.set(entity.id, next);
    }

    const removed: number[] = [];
    for (const id of this.known.keys()) {
      if (!seen.has(id)) removed.push(id);
    }
    for (const id of removed) this.known.delete(id);

    return { type: ServerMessageType.Delta, tick, ackInputSeq, removed, upserts };
  }

  /** True when this client has nothing new to hear -- the frame can be skipped. */
  static isEmpty(delta: DeltaMessage): boolean {
    return delta.removed.length === 0 && delta.upserts.length === 0;
  }

  /** Forgets an entity, so the next sighting is sent in full. */
  forget(entityId: number): void {
    this.known.delete(entityId);
  }

  reset(): void {
    this.known.clear();
  }

  get trackedCount(): number {
    return this.known.size;
  }
}
