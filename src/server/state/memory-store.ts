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
    skills: player.skills.map((allocation) => ({ ...allocation })),
    equipment: { ...player.equipment },
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
