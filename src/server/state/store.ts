/**
 * The persistence seam (spec 056).
 *
 * Everything the server needs to outlive a process goes through this interface,
 * and every method is async even though today's implementation answers from a
 * Map. That is the entire trick: a Postgres or Redis store is a new class
 * implementing the same shape, and no caller changes -- because no caller was
 * ever allowed to assume a read was free or synchronous.
 *
 * Two more rules keep that promise honest:
 *  - records in and out are plain data, never live objects the store keeps a
 *    reference to. A real store round-trips through a wire format; the in-memory
 *    one copies, so aliasing bugs cannot hide until the swap.
 *  - nothing derived is ever stored (see `player/stats.ts`), so there is no
 *    denormalised column to migrate when the tables change.
 */

import type { AuditEntry, Ban, Mute, PersistedPlayer } from './types.js';

/** Per-chunk state that must survive an unload. Deliberately tiny. */
export interface ChunkRecord {
  readonly key: string;
  /** Server tick the chunk was last simulated, so a reload can age it forward. */
  readonly lastActiveTick: number;
  /** Seed for this chunk's spawner, so its population is reproducible. */
  readonly spawnSeed: number;
}

export interface DataStore {
  // --- players ---
  loadPlayer(id: string): Promise<PersistedPlayer | null>;
  savePlayer(player: PersistedPlayer): Promise<void>;
  listPlayerIds(): Promise<readonly string[]>;

  // --- moderation ---
  getBan(playerId: string): Promise<Ban | null>;
  putBan(ban: Ban): Promise<void>;
  clearBan(playerId: string): Promise<void>;
  listBans(): Promise<readonly Ban[]>;
  getMute(playerId: string): Promise<Mute | null>;
  putMute(mute: Mute): Promise<void>;
  clearMute(playerId: string): Promise<void>;

  // --- accountability ---
  appendAudit(entry: AuditEntry): Promise<void>;
  /** Most recent first, capped at `limit`. */
  listAudit(limit: number): Promise<readonly AuditEntry[]>;

  // --- world ---
  loadChunk(key: string): Promise<ChunkRecord | null>;
  saveChunk(record: ChunkRecord): Promise<void>;

  close(): Promise<void>;
}
