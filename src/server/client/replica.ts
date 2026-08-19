/**
 * The world as a client knows it (spec 057).
 *
 * The mirror image of `net/delta.ts`: that decides what to say, this applies
 * what was said. Between them they are the only two places that know the delta
 * encoding, and they are written to be read side by side.
 *
 * A replica holds exactly the fields the protocol carries and nothing derived.
 * Anything a renderer wants that is not here -- an interpolated position, a
 * bobbing animation phase, a health bar's easing -- is presentation and belongs
 * in the renderer, which is the same boundary CLAUDE.md draws between the sim
 * and the view. Keeping the replica this thin is what stops the client growing
 * a second opinion about game state.
 */

import type { EntityDelta, WireStatus } from '../net/messages.js';
import { EntityField } from '../net/protocol.js';

/** Shared, so every body carrying nothing points at the same empty list. */
const NO_STATUSES: readonly WireStatus[] = [];

export interface ReplicatedEntity {
  readonly id: number;
  readonly kind: number;
  readonly typeId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly facing: number;
  readonly health: number;
  readonly maxHealth: number;
  readonly activity: number;
  readonly activityUntilTick: number;
  readonly level: number;
  /**
   * Spec 145. `''` and `0` mean "not told" -- true for every monster, prop and
   * projectile by design, and true for a player only in the frames before their
   * first delta lands. Both consumers have a fallback for it.
   */
  readonly name: string;
  readonly turnRate: number;
  /** Guard left, 0..1 (spec 147). 1 for anything with no poise pool. */
  readonly poise: number;
  /** Absorb left in health units, and the tick it falls off whole. */
  readonly shield: number;
  readonly shieldUntilTick: number;
  /**
   * What this body is visibly carrying (spec 185).
   *
   * Empty for anything with nothing on it, which is most bodies most of the
   * time -- and empty rather than optional, so a reader never has to tell "no
   * statuses" apart from "not told about yet". Each entry carries an absolute
   * `expiresAtTick`, and a consumer is expected to refuse a passed one on read
   * exactly as the sim's own `statusOf` does; nothing prunes this list.
   */
  readonly statuses: readonly WireStatus[];
}

export class ReplicatedWorld {
  private readonly entities = new Map<number, ReplicatedEntity>();
  private lastTick = 0;

  get tick(): number {
    return this.lastTick;
  }

  get size(): number {
    return this.entities.size;
  }

  get(id: number): ReplicatedEntity | null {
    return this.entities.get(id) ?? null;
  }

  /** Insertion-ordered, matching the order the server sent them in. */
  all(): readonly ReplicatedEntity[] {
    return [...this.entities.values()];
  }

  /**
   * Applies one delta. An upsert without the Spawn bit for an entity we have
   * never heard of is dropped rather than half-built: the server only omits
   * identity for something it believes we already have, so receiving one is a
   * desync, and inventing a placeholder would hide it.
   */
  apply(tick: number, removed: readonly number[], upserts: readonly EntityDelta[]): void {
    this.lastTick = tick;
    for (const id of removed) this.entities.delete(id);

    for (const record of upserts) {
      const existing = this.entities.get(record.id);
      if (!existing) {
        if ((record.fields & EntityField.Spawn) === 0) continue;
        this.entities.set(record.id, {
          id: record.id,
          kind: record.kind ?? 0,
          typeId: record.typeId ?? '',
          x: record.position?.x ?? 0,
          y: record.position?.y ?? 0,
          z: record.position?.z ?? 0,
          facing: record.facing ?? 0,
          health: record.health ?? 0,
          maxHealth: record.maxHealth ?? 0,
          activity: record.activity ?? 0,
          activityUntilTick: record.activityUntilTick ?? 0,
          level: record.level ?? 1,
          name: record.name ?? '',
          turnRate: record.turnRate ?? 0,
          poise: record.poise ?? 1,
          shield: record.shield ?? 0,
          shieldUntilTick: record.shieldUntilTick ?? 0,
          statuses: record.statuses ?? NO_STATUSES,
        });
        continue;
      }

      this.entities.set(record.id, {
        ...existing,
        ...(record.fields & EntityField.Position && record.position
          ? { x: record.position.x, y: record.position.y, z: record.position.z }
          : {}),
        ...(record.fields & EntityField.Facing && record.facing !== undefined
          ? { facing: record.facing }
          : {}),
        ...(record.fields & EntityField.Health && record.health !== undefined
          ? { health: record.health, maxHealth: record.maxHealth ?? existing.maxHealth }
          : {}),
        ...(record.fields & EntityField.Activity && record.activity !== undefined
          ? {
              activity: record.activity,
              activityUntilTick: record.activityUntilTick ?? existing.activityUntilTick,
            }
          : {}),
        ...(record.fields & EntityField.Level && record.level !== undefined
          ? { level: record.level }
          : {}),
        ...(record.fields & EntityField.Identity
          ? { name: record.name ?? existing.name, turnRate: record.turnRate ?? existing.turnRate }
          : {}),
        // Guard and shields, which the first-sight branch above has always read
        // and this one never did -- so a replicated body's guard was whatever it
        // had when the client first saw it, forever. Invisible until spec 147
        // drew the bar: nothing else on this side reads either field, so a value
        // frozen at spawn and a value tracking the server look identical to
        // every test that only asks whether the number arrived.
        ...(record.fields & EntityField.Poise && record.poise !== undefined
          ? { poise: record.poise }
          : {}),
        ...(record.fields & EntityField.Shield && record.shield !== undefined
          ? { shield: record.shield, shieldUntilTick: record.shieldUntilTick ?? existing.shieldUntilTick }
          : {}),
        // Replaced whole rather than merged (spec 185). The field carries the
        // body's entire visible set, so an empty list is how the server says the
        // last one fell off -- merging would make a status impossible to lose.
        ...(record.fields & EntityField.Statuses
          ? { statuses: record.statuses ?? NO_STATUSES }
          : {}),
      });
    }
  }

  clear(): void {
    this.entities.clear();
    this.lastTick = 0;
  }
}
