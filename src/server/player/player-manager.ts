/**
 * Player lifecycle and the recalculation triggers (spec 056).
 *
 * Owns the rule that gives the whole persistence model its shape: **effective
 * stats are recomputed, never loaded**. There are exactly four moments they can
 * change -- login, equip, unequip, and a skill point being spent -- and all
 * four run through {@link PlayerManager.recalculate}. Nothing else may write a
 * stat, and no stat is ever read from a client message.
 */

import type { ZoneManager } from '../world/zone-manager.js';
import { itemById } from '../data/items.js';
import type { DataStore } from '../state/store.js';
import {
  EMPTY_EQUIPMENT,
  isEquipSlot,
  type BaseStats,
  type EffectiveStats,
  type EquipSlot,
  type PersistedPlayer,
  type Vec3,
} from '../state/types.js';
import { spendSkillPoint, sanitizeSkills } from './skills.js';
import { clampHealthToStats, computeEffectiveStats } from './stats.js';

/** Stats a brand new character starts with, before any allocation. */
export const DEFAULT_BASE_STATS: BaseStats = {
  strength: 5,
  dexterity: 5,
  intelligence: 5,
  vitality: 5,
};

/** Where a character with no saved position wakes up: the safe hub. */
export const DEFAULT_SPAWN: Vec3 = { x: 600, y: 450, z: 0 };

export const STARTER_EQUIPMENT: Readonly<Record<EquipSlot, string | null>> = {
  ...EMPTY_EQUIPMENT,
  mainHand: 'sword.worn',
  chest: 'chest.leather',
};

/** Skill points granted per level gained. */
export const SKILL_POINTS_PER_LEVEL = 1;

/** Experience needed to reach `level` from the one below it. */
export function experienceForLevel(level: number): number {
  return Math.round(50 * Math.pow(Math.max(1, level - 1), 1.5));
}

export interface PlayerSession {
  readonly playerId: string;
  readonly displayName: string;
  /** The entity this player drives; -1 until the world has spawned it. */
  readonly entityId: number;
  readonly record: PersistedPlayer;
  /** Derived on every change; never persisted, never accepted from a client. */
  readonly stats: EffectiveStats;
  readonly muted: boolean;
  /** Highest input seq applied, echoed in deltas so the client can reconcile. */
  readonly lastAppliedInputSeq: number;
}

export type PlayerActionResult =
  | { readonly ok: true; readonly session: PlayerSession }
  | { readonly ok: false; readonly reason: string };

export class PlayerManager {
  private readonly sessions = new Map<string, PlayerSession>();
  private readonly byEntity = new Map<number, string>();

  constructor(
    private readonly store: DataStore,
    private readonly zones: ZoneManager,
  ) {}

  /**
   * Loads or creates a character and derives its stats fresh. A save that has
   * gone stale against the tables -- a deleted skill, a level past a new cap --
   * is sanitised here rather than being allowed into the world.
   */
  async login(playerId: string, displayName: string): Promise<PlayerSession> {
    const loaded = await this.store.loadPlayer(playerId);
    const record: PersistedPlayer = loaded
      ? { ...loaded, skills: sanitizeSkills(loaded.skills) }
      : this.createCharacter(playerId, displayName);

    const stats = computeEffectiveStats(record);
    const session: PlayerSession = {
      playerId,
      displayName: record.displayName,
      entityId: -1,
      record: {
        ...record,
        health: clampHealthToStats(record.health > 0 ? record.health : stats.maxHealth, stats),
        currentZone: this.zones.zoneIdAt(record.position.x, record.position.y),
      },
      stats,
      muted: (await this.store.getMute(playerId)) !== null,
      lastAppliedInputSeq: 0,
    };
    this.sessions.set(playerId, session);
    await this.store.savePlayer(session.record);
    return session;
  }

  private createCharacter(playerId: string, displayName: string): PersistedPlayer {
    return {
      id: playerId,
      displayName: displayName || playerId,
      baseStats: DEFAULT_BASE_STATS,
      skills: [],
      equipment: STARTER_EQUIPMENT,
      position: DEFAULT_SPAWN,
      facing: 0,
      currentZone: this.zones.zoneIdAt(DEFAULT_SPAWN.x, DEFAULT_SPAWN.y),
      level: 1,
      experience: 0,
      unspentSkillPoints: 1,
      health: 0,
    };
  }

  async logout(playerId: string): Promise<void> {
    const session = this.sessions.get(playerId);
    if (!session) return;
    this.sessions.delete(playerId);
    if (session.entityId >= 0) this.byEntity.delete(session.entityId);
    await this.store.savePlayer(session.record);
  }

  attachEntity(playerId: string, entityId: number): void {
    const session = this.sessions.get(playerId);
    if (!session) return;
    if (session.entityId >= 0) this.byEntity.delete(session.entityId);
    this.sessions.set(playerId, { ...session, entityId });
    this.byEntity.set(entityId, playerId);
  }

  get(playerId: string): PlayerSession | null {
    return this.sessions.get(playerId) ?? null;
  }

  byEntityId(entityId: number): PlayerSession | null {
    const playerId = this.byEntity.get(entityId);
    return playerId === undefined ? null : this.sessions.get(playerId) ?? null;
  }

  all(): readonly PlayerSession[] {
    return [...this.sessions.values()];
  }

  /** Writes back a session whose record the caller has already updated. */
  private commit(session: PlayerSession): PlayerSession {
    this.sessions.set(session.playerId, session);
    if (session.entityId >= 0) this.byEntity.set(session.entityId, session.playerId);
    return session;
  }

  /**
   * Re-derives stats from the record as it stands and clamps health to the new
   * ceiling. The single funnel every stat change passes through.
   */
  async recalculate(playerId: string): Promise<PlayerSession | null> {
    const session = this.sessions.get(playerId);
    if (!session) return null;
    const stats = computeEffectiveStats(session.record);
    const next: PlayerSession = {
      ...session,
      stats,
      record: { ...session.record, health: clampHealthToStats(session.record.health, stats) },
    };
    this.commit(next);
    await this.store.savePlayer(next.record);
    return next;
  }

  async equip(playerId: string, slot: string, itemId: string): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };
    if (!isEquipSlot(slot)) return { ok: false, reason: `no such slot: ${slot}` };

    const item = itemById(itemId);
    if (!item) return { ok: false, reason: `no such item: ${itemId}` };
    if (item.slot !== slot) return { ok: false, reason: `${item.name} does not go in ${slot}` };
    if (session.record.level < item.levelRequirement) {
      return { ok: false, reason: `${item.name} requires level ${item.levelRequirement}` };
    }

    this.commit({
      ...session,
      record: { ...session.record, equipment: { ...session.record.equipment, [slot]: itemId } },
    });
    const updated = await this.recalculate(playerId);
    return updated ? { ok: true, session: updated } : { ok: false, reason: 'not logged in' };
  }

  async unequip(playerId: string, slot: string): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };
    if (!isEquipSlot(slot)) return { ok: false, reason: `no such slot: ${slot}` };
    if (session.record.equipment[slot] === null) return { ok: false, reason: `${slot} is empty` };

    this.commit({
      ...session,
      record: { ...session.record, equipment: { ...session.record.equipment, [slot]: null } },
    });
    const updated = await this.recalculate(playerId);
    return updated ? { ok: true, session: updated } : { ok: false, reason: 'not logged in' };
  }

  /** Validated in `skills.ts`; a rejection leaves the record untouched. */
  async spendSkillPoint(playerId: string, skillId: string): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };

    const outcome = spendSkillPoint(session.record, skillId);
    if (!outcome.ok) return { ok: false, reason: outcome.detail };

    this.commit({ ...session, record: outcome.player });
    const updated = await this.recalculate(playerId);
    return updated ? { ok: true, session: updated } : { ok: false, reason: 'not logged in' };
  }

  /** Awards experience and levels the character up as far as it carries them. */
  async grantExperience(playerId: string, amount: number): Promise<PlayerSession | null> {
    const session = this.sessions.get(playerId);
    if (!session || amount <= 0) return session ?? null;

    let { level, experience, unspentSkillPoints } = session.record;
    experience += Math.floor(amount);
    while (experience >= experienceForLevel(level + 1)) {
      experience -= experienceForLevel(level + 1);
      level += 1;
      unspentSkillPoints += SKILL_POINTS_PER_LEVEL;
    }

    this.commit({
      ...session,
      record: { ...session.record, level, experience, unspentSkillPoints },
    });
    return this.recalculate(playerId);
  }

  /**
   * Mirrors the authoritative entity back into the persisted record, so a
   * disconnect saves where the player actually was rather than where they
   * logged in. Position and health only -- everything else about an entity is
   * derived and must not leak back into storage.
   */
  syncFromEntity(
    playerId: string,
    position: Vec3,
    facing: number,
    health: number,
  ): PlayerSession | null {
    const session = this.sessions.get(playerId);
    if (!session) return null;
    return this.commit({
      ...session,
      record: {
        ...session.record,
        position,
        facing,
        health,
        currentZone: this.zones.zoneIdAt(position.x, position.y),
      },
    });
  }

  setMuted(playerId: string, muted: boolean): void {
    const session = this.sessions.get(playerId);
    if (session) this.commit({ ...session, muted });
  }

  noteInputSeq(playerId: string, seq: number): void {
    const session = this.sessions.get(playerId);
    if (session && seq > session.lastAppliedInputSeq) {
      this.commit({ ...session, lastAppliedInputSeq: seq });
    }
  }
}
