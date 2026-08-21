/**
 * The server's nav, sized by where the players are (spec 205).
 *
 * Owns a `NavField` and the residency that decides which windows are worth
 * holding, and is the one thing `routeToward` asks. Everything it decides is
 * pure and lives next door -- `nav-tiles.ts` for a tile and a window,
 * `nav-residency.ts` for which window -- so this is a cache and an invalidation
 * rule and nothing else.
 *
 * The invalidation rule is the whole file: **windows are dropped whenever the
 * active set changes, tiles are kept while anything wants them.** They are
 * different questions. A tile is expensive (its ground is sampled) and is still
 * correct wherever the players go, so it is kept until nothing is near it. A
 * window is cheap to rebuild from tiles and is *only* correct as a window --
 * its component labels describe a rectangle, and the rectangle moved.
 *
 * Not part of the deterministic core's pure half only because it holds a cache;
 * it reads no clock and draws nothing from the Rng, and a tick that asks the
 * same question twice gets the same answer.
 */

import { NavField, type TileRect } from '../../sim/nav-tiles.js';
import type { NavGrid, NavGround } from '../../sim/pathfinding.js';
import type { WorldColliders } from '../../sim/types.js';
import { chunkKeyOf, type ChunkKey } from './chunks.js';
import { CHUNK_SIZE } from '../config.js';
import { navResidency, type NavResidency } from './nav-residency.js';

export class ServerNav {
  private readonly field: NavField;
  private residency: NavResidency = navResidency(new Set());
  /** The active set the current residency was computed from. */
  private from: ReadonlySet<ChunkKey> | null = null;
  private fromSize = -1;

  constructor(colliders: WorldColliders, ground: NavGround, radii: readonly number[]) {
    this.field = new NavField(colliders, ground, radii);
  }

  /**
   * Take a new active set, if it is a new one.
   *
   * `ChunkManager.activeChunks()` hands back its **live** set rather than a copy
   * (spec 193), and rebuilds it only when a player changes chunk -- so identity
   * is not enough to tell "unchanged" from "rebuilt", and the size is not
   * either. Compared by content, which is a few dozen lookups against a rebuild
   * that samples ground.
   */
  update(active: ReadonlySet<ChunkKey>): void {
    if (this.from !== null && this.fromSize === active.size && sameSet(this.from, active)) return;
    this.from = new Set(active);
    this.fromSize = active.size;
    this.residency = navResidency(active);
    // Windows first: they name tiles, and dropping a tile a live window still
    // points at would leave the window holding copied bytes of ground nobody is
    // keeping -- correct, but a lie about what is resident.
    this.field.clearWindows();
    this.field.keepOnly(this.residency.tiles);
  }

  /**
   * The grid a body at this point routes in, or null if it is not resident.
   *
   * Null is not an error and callers must handle it: an entity is only stepped
   * when its chunk is active, so in the ordinary case there is always a window
   * -- but a sandbox, a test and the loopback tab all step worlds with no
   * residency at all, and they fall back to the world-sized grid.
   */
  gridAt(radius: number, x: number, y: number): NavGrid | null {
    const rect = this.residency.windowFor(chunkKeyOf(x, y, CHUNK_SIZE));
    if (!rect) return null;
    return this.field.window(rect, radius);
  }

  /** The window a point falls in, for a caller that wants the rectangle. */
  windowAt(x: number, y: number): TileRect | null {
    return this.residency.windowFor(chunkKeyOf(x, y, CHUNK_SIZE));
  }

  /** Tiles held, windows assembled. What the bench and the tests watch. */
  stats(): { tiles: number; windows: number } {
    return { tiles: this.field.size, windows: this.field.windowCount };
  }

  /** Throw everything away. For a world whose ground changed under it. */
  clear(): void {
    this.field.clear();
    this.field.clearWindows();
    this.from = null;
    this.fromSize = -1;
    this.residency = navResidency(new Set());
  }
}

function sameSet(a: ReadonlySet<ChunkKey>, b: ReadonlySet<ChunkKey>): boolean {
  for (const key of a) if (!b.has(key)) return false;
  return true;
}
