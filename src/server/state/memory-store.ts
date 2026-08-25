/**
 * In-memory {@link DataStore} (spec 056). The only implementation that ships
 * today; a Postgres/Redis one is a sibling class, not a refactor.
 *
 * Copies on the way in and on the way out. That costs a shallow clone per save
 * and buys the guarantee a networked store gives for free: a caller mutating a
 * record it handed over cannot reach back into stored state, so nothing works
 * here that would break against a real database.
 */

import type { DataStore, ChunkRecord } from './store.js';
import type { AuditEntry, Ban, Mute, PersistedPlayer } from './types.js';

/** How many audit entries are retained before the oldest are dropped. */
const AUDIT_CAPACITY = 5000;

function clonePlayer(player: PersistedPlayer): PersistedPlayer {
  return {
    ...player,
    baseStats: { ...player.baseStats },
    // Tolerant of a save written before the field existed, like the bag is
    // (spec 126). A store that throws on an old record is a store that cannot
    // load the very saves the migration exists for.
    skills: (player.skills ?? []).map((allocation) => ({ ...allocation })),
    equipment: { ...player.equipment },
    // Each stack copied too: a bag is an array of objects, and a shallow copy of
    // the array would still hand back the very stacks the caller is holding.
    //
    // The `??` is not dead code: a row written before spec 126 has no bag at
    // all, and a store is where that shows up first. It hands the record back as
    // it found it and `sanitizeInventory` decides what an absent bag means --
    // which is the same thing a Postgres store reading a NULL column would do.
    inventory: (player.inventory ?? []).map((stack) => (stack ? { ...stack } : null)),
    position: { ...player.position },
  };
}

export class MemoryDataStore implements DataStore {
  private readonly players = new Map<string, PersistedPlayer>();
  private readonly bans = new Map<string, Ban>();
  private readonly mutes = new Map<string, Mute>();
  private readonly chunks = new Map<string, ChunkRecord>();
  /** Append-only, oldest first; trimmed from the front at capacity. */
  private audit: AuditEntry[] = [];

  loadPlayer(id: string): Promise<PersistedPlayer | null> {
    const stored = this.players.get(id);
    return Promise.resolve(stored ? clonePlayer(stored) : null);
  }

  savePlayer(player: PersistedPlayer): Promise<void> {
    this.players.set(player.id, clonePlayer(player));
    return Promise.resolve();
  }

  /**
   * Atomic here for free: the loop is synchronous and a Map assignment cannot
   * fail part way, so there is no interleaving point between the two writes.
   * The signature exists so that a caller written against the seam gets the
   * same guarantee from both implementations -- one by construction, one by
   * transaction.
   */
  savePlayers(players: readonly PersistedPlayer[]): Promise<void> {
    for (const player of players) this.players.set(player.id, clonePlayer(player));
    return Promise.resolve();
  }

  /**
   * There is nothing to begin and nothing to roll back: every write below is a
   * synchronous Map assignment, so a body that returns has already had all of
   * its writes applied and one that throws has had exactly the ones before the
   * throw. That is weaker than the SQLite store's promise, and it is the one
   * place these two implementations genuinely differ -- so anything relying on
   * a rollback is tested against SQLite, which is where it runs.
   */
  transaction<T>(body: () => T): T {
    return body();
  }

  listPlayerIds(): Promise<readonly string[]> {
    return Promise.resolve([...this.players.keys()]);
  }

  getBan(playerId: string): Promise<Ban | null> {
    const ban = this.bans.get(playerId);
    return Promise.resolve(ban ? { ...ban } : null);
  }

  putBan(ban: Ban): Promise<void> {
    this.bans.set(ban.playerId, { ...ban });
    return Promise.resolve();
  }

  clearBan(playerId: string): Promise<void> {
    this.bans.delete(playerId);
    return Promise.resolve();
  }

  listBans(): Promise<readonly Ban[]> {
    return Promise.resolve([...this.bans.values()].map((ban) => ({ ...ban })));
  }

  getMute(playerId: string): Promise<Mute | null> {
    const mute = this.mutes.get(playerId);
    return Promise.resolve(mute ? { ...mute } : null);
  }

  putMute(mute: Mute): Promise<void> {
    this.mutes.set(mute.playerId, { ...mute });
    return Promise.resolve();
  }

  clearMute(playerId: string): Promise<void> {
    this.mutes.delete(playerId);
    return Promise.resolve();
  }

  appendAudit(entry: AuditEntry): Promise<void> {
    this.audit.push({ ...entry });
    if (this.audit.length > AUDIT_CAPACITY) {
      this.audit = this.audit.slice(this.audit.length - AUDIT_CAPACITY);
    }
    return Promise.resolve();
  }

  listAudit(limit: number): Promise<readonly AuditEntry[]> {
    const capped = Math.max(0, Math.min(limit, this.audit.length));
    const slice = this.audit.slice(this.audit.length - capped);
    return Promise.resolve(slice.reverse().map((entry) => ({ ...entry })));
  }

  loadChunk(key: string): Promise<ChunkRecord | null> {
    const record = this.chunks.get(key);
    return Promise.resolve(record ? { ...record } : null);
  }

  saveChunk(record: ChunkRecord): Promise<void> {
    this.chunks.set(record.key, { ...record });
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
