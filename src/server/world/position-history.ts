/**
 * Where everything was, for as long as a blow may reach back (spec 149).
 *
 * Every landing in this game measures against the server's present, which is
 * exactly right on a loopback and wrong over a wire: the attacker swung at a
 * body drawn where it was 200ms ago. This is the record that lets the swing be
 * resolved against what they were looking at.
 *
 * Bounded by the cap rather than by uptime -- a ring of `MAX_REWIND_TICKS + 1`
 * ticks and nothing else, so a server that has been up for a week holds the
 * same thirteen frames as one that just booted.
 *
 * Pure: no clock, no randomness, no I/O. Part of the deterministic core, and
 * `record` is handed the tick like everything else here.
 */

import { MAX_REWIND_TICKS } from '../config.js';
import type { ServerEntity } from '../sim/types.js';
import type { Vec3 } from '../state/types.js';

/**
 * What the sim is handed so a landing can ask where a body was.
 *
 * An interface rather than the class, so `StepContext` depends on the question
 * and not on the storage -- and so a test can answer it with a literal.
 */
export interface RewindLookup {
  /** How far this attacker's view lags the server, in ticks. Already clamped. */
  ticksFor(attackerId: number): number;
  /** Where this entity was, or null if it was not being recorded then. */
  positionAt(entityId: number, ticksAgo: number): Vec3 | null;
}

interface Frame {
  tick: number;
  readonly positions: Map<number, Vec3>;
}

export class PositionHistory implements RewindLookup {
  /** Newest last. Fixed length once warm; never grows past the cap. */
  private readonly frames: Frame[] = [];
  private readonly lag = new Map<number, number>();
  private latest = -1;

  /**
   * Record where everything is, at the end of a tick.
   *
   * Positions only. Health is deliberately not kept: a target who died inside
   * the window is dead, and being able to rewind that would mean hitting a
   * corpse into being alive again.
   */
  record(tick: number, entities: Iterable<ServerEntity>): void {
    this.latest = tick;
    const positions = new Map<number, Vec3>();
    for (const entity of entities) positions.set(entity.id, entity.position);
    if (this.frames.length > MAX_REWIND_TICKS) {
      // Reuse the oldest rather than allocating: this runs every tick forever.
      const oldest = this.frames.shift();
      if (oldest) {
        oldest.tick = tick;
        oldest.positions.clear();
        for (const [id, at] of positions) oldest.positions.set(id, at);
        this.frames.push(oldest);
        return;
      }
    }
    this.frames.push({ tick, positions });
  }

  /**
   * Note how far behind the server's clock an attacker is drawing.
   *
   * Clamped here, once, rather than at each call site: the number arrives from
   * the client and a client may say anything. The worst a liar achieves is the
   * compensation an honest player on a 200ms connection already has.
   */
  noteLag(entityId: number, ticks: number): void {
    if (!Number.isFinite(ticks)) return;
    this.lag.set(entityId, Math.max(0, Math.min(MAX_REWIND_TICKS, Math.floor(ticks))));
  }

  /** Forget a connection that has gone, so the map does not grow forever. */
  forget(entityId: number): void {
    this.lag.delete(entityId);
  }

  ticksFor(attackerId: number): number {
    return this.lag.get(attackerId) ?? 0;
  }

  positionAt(entityId: number, ticksAgo: number): Vec3 | null {
    if (ticksAgo <= 0) return null;
    const want = this.latest - Math.min(ticksAgo, MAX_REWIND_TICKS);
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i];
      if (!frame || frame.tick !== want) continue;
      return frame.positions.get(entityId) ?? null;
    }
    return null;
  }

  /** Frames held. Bounded by the cap; a test asserts it stays that way. */
  get depth(): number {
    return this.frames.length;
  }
}
