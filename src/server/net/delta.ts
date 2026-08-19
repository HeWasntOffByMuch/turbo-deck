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
import { MIN_MOVE_SCALE } from '../sim/movement.js';
import { moveScaleOf } from '../sim/statuses.js';
import type { DeltaMessage, EntityDelta, WireStatus } from './messages.js';
import { ServerMessageType } from './protocol.js';
import type { ServerEntity } from '../sim/types.js';
import { visualFor } from '../data/status-visuals.js';

/** Position changes below this are noise, not movement. */
const POSITION_EPSILON = 0.01;
/** ~0.06 degrees; below this a facing change is invisible. */
const FACING_EPSILON = 0.001;
const HEALTH_EPSILON = 0.01;
/**
 * Poise is sent as a byte, so anything under a 255th is not expressible
 * (spec 147). Matching the epsilon to the quantisation is what stops a body
 * regenerating a hundredth of a point a tick from being marked dirty every
 * single tick and turning the delta back into a snapshot.
 */
const POISE_EPSILON = 1 / 255;

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
  /** Spec 145. `''` for anything that is not a player. */
  name: string;
  turnRate: number;
  /** Spec 147. A fraction, because that is all a bar asks. */
  poise: number;
  shield: number;
  shieldUntilTick: number;
  /** Spec 185, already packed and sorted. Compared entry by entry. */
  statuses: readonly WireStatus[];
  /** Spec 188. A fraction, because that is all a step is multiplied by. */
  moveScale: number;
}

function snapshotOf(entity: ServerEntity, name: string, tick: number): KnownEntity {
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
    name,
    turnRate: entity.stats.turnRate,
    poise: poiseFractionOf(entity),
    shield: entity.shield,
    shieldUntilTick: entity.shieldUntilTick,
    statuses: visibleStatusesOf(entity, tick),
    moveScale: moveScaleOf(entity.statuses, tick, MIN_MOVE_SCALE),
  };
}

/** Guard left, 0..1. A body with no poise pool reads as full rather than as 0. */
function poiseFractionOf(entity: ServerEntity): number {
  const max = entity.stats.traits.maxPoise;
  if (!(max > 0)) return 1;
  return Math.max(0, Math.min(1, entity.poise / max));
}

/**
 * The statuses on this body that anybody may see, packed for the wire (spec 186).
 *
 * Three things happen here and nowhere else:
 *
 *  - **The table decides.** `visualFor` answers null for everything without a
 *    row, so the sim's own bookkeeping -- `recentlyHit`, the spent-flags,
 *    `exposed.bounty`, the `dmg:` assist keys, the restoration windows -- never
 *    reaches a client. Absent is the default.
 *  - **The adaptation family collapses.** Every `adapt:<ability>` maps to the one
 *    `adapted` row, and the largest stack count wins, because a mark over a head
 *    cannot name the ability and the honest reading of the collapsed form is
 *    still true.
 *  - **Expired entries are dropped**, on the same comparison `statusOf` makes.
 *    `expireStatuses` is a garbage collector rather than a rule, so a status
 *    whose window has passed can still be sitting in the map, and sending one
 *    would put a mark on screen the sim has already stopped honouring.
 *
 * Sorted by wire index, so a set that has not changed cannot look changed
 * because the map was built in a different order on a later tick.
 */
function visibleStatusesOf(entity: ServerEntity, tick: number): readonly WireStatus[] {
  let packed: WireStatus[] | null = null;
  for (const [id, held] of Object.entries(entity.statuses)) {
    if (tick >= held.expiresAtTick) continue;
    const visual = visualFor(id);
    if (!visual) continue;
    packed ??= [];
    const already = packed.find((candidate) => candidate.wire === visual.wire);
    if (!already) {
      packed.push({ wire: visual.wire, stacks: held.stacks, expiresAtTick: held.expiresAtTick });
      continue;
    }
    // Only the collapsed `adapted` row can arrive twice. Keep the strongest, and
    // the expiry that goes with it, so the mark and its count describe the same
    // ability rather than the deepest stack wearing the longest clock.
    if (held.stacks > already.stacks) {
      packed[packed.indexOf(already)] = {
        wire: visual.wire,
        stacks: held.stacks,
        expiresAtTick: held.expiresAtTick,
      };
    }
  }
  if (!packed) return EMPTY_STATUSES;
  return packed.sort((a, b) => a.wire - b.wire);
}

/** Shared, so the common case -- a body carrying nothing -- allocates nothing. */
const EMPTY_STATUSES: readonly WireStatus[] = [];

/** Whether two packed lists say the same thing. Both are sorted by wire index. */
function sameStatuses(a: readonly WireStatus[], b: readonly WireStatus[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (!left || !right) return false;
    if (
      left.wire !== right.wire ||
      left.stacks !== right.stacks ||
      left.expiresAtTick !== right.expiresAtTick
    ) {
      return false;
    }
  }
  return true;
}

export class DeltaTracker {
  private readonly known = new Map<number, KnownEntity>();

  /**
   * Builds the frame for one tick. `visible` is this client's interest set,
   * already filtered by the chunk manager -- interest is not this class's job,
   * it only reports change within whatever it is shown.
   */
  build(
    tick: number,
    ackInputSeq: number,
    visible: readonly ServerEntity[],
    nameOf: (entity: ServerEntity) => string | null = () => null,
  ): DeltaMessage {
    const upserts: EntityDelta[] = [];
    const seen = new Set<number>();

    for (const entity of visible) {
      seen.add(entity.id);
      const previous = this.known.get(entity.id);
      // Null means "nothing a table cannot answer" -- every monster, prop and
      // projectile. Only a player costs an `Identity` field (spec 145).
      const named = nameOf(entity);
      const next = snapshotOf(entity, named ?? '', tick);

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
            EntityField.Poise |
            EntityField.Shield |
            // Only when there is something in it. A first sight is the one
            // delta that is always sent in full, and paying a byte per body to
            // say "no statuses" is a cost every projectile and prop in the
            // world would carry for a field almost nothing uses.
            (next.statuses.length > 0 ? EntityField.Statuses : 0) |
            // The same argument for the same reason (spec 188): almost nothing
            // in the world is ever slowed, and a client told nothing assumes
            // the full speed it would have assumed anyway.
            (next.moveScale < 1 ? EntityField.MoveScale : 0) |
            (named === null ? 0 : EntityField.Identity),
          kind: entity.kind,
          typeId: entity.typeId,
          position: entity.position,
          facing: entity.facing,
          health: entity.health,
          maxHealth: entity.stats.maxHealth,
          activity: entity.activity,
          activityUntilTick: entity.activityUntilTick,
          level: entity.level,
          poise: next.poise,
          shield: entity.shield,
          shieldUntilTick: entity.shieldUntilTick,
          ...(next.statuses.length > 0 ? { statuses: next.statuses } : {}),
          ...(next.moveScale < 1 ? { moveScale: next.moveScale } : {}),
          ...(named === null ? {} : { name: named, turnRate: entity.stats.turnRate }),
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
      // A name never changes mid-session, but a turn rate does -- it is derived
      // from dexterity, so a level-up or an equip moves it.
      if (named !== null && (next.name !== previous.name || next.turnRate !== previous.turnRate)) {
        fields |= EntityField.Identity;
      }
      if (Math.abs(next.poise - previous.poise) > POISE_EPSILON) fields |= EntityField.Poise;
      // The same epsilon and for the same reason: both ride the wire as a byte,
      // so a change smaller than a 255th is not expressible and reporting it
      // would be a field per tick that decoded to the number already held.
      if (Math.abs(next.moveScale - previous.moveScale) > POISE_EPSILON) {
        fields |= EntityField.MoveScale;
      }
      if (
        Math.abs(next.shield - previous.shield) > HEALTH_EPSILON ||
        next.shieldUntilTick !== previous.shieldUntilTick
      ) {
        fields |= EntityField.Shield;
      }
      // Refreshing a status to a new expiry is a change, and so is losing the
      // last one: the empty list has to be *sent* or a status could only ever be
      // added. The comparison is entry by entry against a list already sorted by
      // wire index, so the map's iteration order cannot make a still set look
      // like a moving one.
      if (!sameStatuses(next.statuses, previous.statuses)) fields |= EntityField.Statuses;

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
        ...(fields & EntityField.Identity
          ? { name: named ?? '', turnRate: entity.stats.turnRate }
          : {}),
        ...(fields & EntityField.Poise ? { poise: next.poise } : {}),
        ...(fields & EntityField.MoveScale ? { moveScale: next.moveScale } : {}),
        ...(fields & EntityField.Shield
          ? { shield: entity.shield, shieldUntilTick: entity.shieldUntilTick }
          : {}),
        ...(fields & EntityField.Statuses ? { statuses: next.statuses } : {}),
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
