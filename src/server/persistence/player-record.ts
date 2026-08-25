/**
 * `PersistedPlayer` <-> a row in `players` (spec 226).
 *
 * The one file that knows the storage shape of a player, which is what keeps
 * requirement "no raw SQL scattered through gameplay code" true in the other
 * direction too: no gameplay type is spelled out in SQL either.
 *
 * The split between columns and the JSON document is a judgement, and it is the
 * one this file exists to write down. A field is a **column** when something
 * other than the player asks about it -- currency, level and experience are
 * what an economy audit queries and what a CHECK constraint can defend. Every
 * other field is in `data`, because it is only ever read as part of loading
 * that one player and only ever written with the rest of them. Normalising a
 * 24-slot fixed-length bag into 24 rows would buy nothing: the atomicity a
 * trade needs comes from writing both players' rows in one transaction, not
 * from the granularity of either row.
 *
 * Reading is deliberately tolerant. A row whose `data` will not parse is a
 * `CorruptPlayerData`, thrown rather than silently replaced -- see
 * `player-repository.ts` for what the server does with one -- but a row missing
 * a *field* is not corrupt, it is old, and it takes the same "an upgrade must
 * never rob anybody" defaults `player-manager.ts` has always applied.
 */

import {
  EMPTY_EQUIPMENT,
  EQUIP_SLOTS,
  INVENTORY_SLOTS,
  type Equipment,
  type Inventory,
  type ItemStack,
  type PersistedPlayer,
  type SkillAllocation,
  type Vec3,
} from '../state/types.js';
import { PLAYER_SAVE_VERSION } from './migrations.js';

export class CorruptPlayerData extends Error {
  constructor(
    readonly playerId: string,
    reason: string,
  ) {
    super(`player ${playerId} has unreadable save data: ${reason}`);
  }
}

/** The `players` row, as the driver hands it over. */
export interface PlayerRow {
  readonly id: string;
  readonly account_id: string | null;
  readonly display_name: string;
  readonly save_version: number;
  readonly coins: number;
  readonly level: number;
  readonly experience: number;
  readonly data: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** What goes in the `data` column. Everything not worth its own column. */
interface PlayerDocument {
  readonly baseStats: Record<string, number>;
  readonly skills: readonly SkillAllocation[];
  readonly equipment: Record<string, string | null>;
  readonly inventory: readonly (ItemStack | null)[];
  readonly position: Vec3;
  readonly facing: number;
  readonly currentZone: string;
  readonly unspentSkillPoints: number;
  readonly unspentAttributePoints: number;
  readonly health: number;
  readonly resource: number;
  readonly fallbackCharges?: number;
}

function integer(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function real(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function vec3(value: unknown): Vec3 {
  const source = (value ?? {}) as Record<string, unknown>;
  return { x: real(source['x'], 0), y: real(source['y'], 0), z: real(source['z'], 0) };
}

/**
 * A stack, or null for an empty slot. A malformed entry becomes an empty slot
 * rather than throwing: one unreadable stack is a lost item, and throwing would
 * make it a lost character.
 */
function stack(value: unknown): ItemStack | null {
  if (value === null || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const defId = source['defId'];
  const count = integer(source['count'], 0);
  if (typeof defId !== 'string' || defId.length === 0 || count < 1) return null;
  return { defId, count };
}

/**
 * Always exactly {@link INVENTORY_SLOTS} long, whatever was stored. The bag's
 * whole contract is that a slot index means the same thing forever, and a short
 * array is how an index starts meaning something else.
 */
function inventory(value: unknown): Inventory {
  const source = Array.isArray(value) ? value : [];
  const bag = new Array<ItemStack | null>(INVENTORY_SLOTS).fill(null);
  for (let i = 0; i < INVENTORY_SLOTS; i += 1) bag[i] = stack(source[i]);
  return bag;
}

function equipment(value: unknown): Equipment {
  const source = (value ?? {}) as Record<string, unknown>;
  const worn: Record<string, string | null> = { ...EMPTY_EQUIPMENT };
  for (const slot of EQUIP_SLOTS) {
    const held = source[slot];
    worn[slot] = typeof held === 'string' && held.length > 0 ? held : null;
  }
  return worn as Equipment;
}

function skills(value: unknown): readonly SkillAllocation[] {
  if (!Array.isArray(value)) return [];
  const out: SkillAllocation[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const source = entry as Record<string, unknown>;
    const skillId = source['skillId'];
    const level = integer(source['level'], 0);
    if (typeof skillId === 'string' && skillId.length > 0 && level > 0) out.push({ skillId, level });
  }
  return out;
}

/**
 * Base stats come back as whatever was written. `normalizeBaseStats` in
 * `player/attributes.ts` is what decides the attribute vocabulary, and it
 * already handles a spread from an older build -- so this copies the numbers
 * and lets that one rule stay the only rule.
 */
function baseStats(value: unknown): Record<string, number> {
  const source = (value ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [key, held] of Object.entries(source)) {
    if (typeof held === 'number' && Number.isFinite(held)) out[key] = held;
  }
  return out;
}

export function rowToPlayer(row: PlayerRow): PersistedPlayer {
  let document: PlayerDocument;
  try {
    const parsed: unknown = JSON.parse(row.data);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    document = parsed as PlayerDocument;
  } catch (error) {
    throw new CorruptPlayerData(row.id, error instanceof Error ? error.message : String(error));
  }

  const charges = document.fallbackCharges;
  return {
    id: row.id,
    displayName: row.display_name,
    // Cast at the boundary the way `player-manager.ts`'s `migrate` already
    // does: `normalizeBaseStats` is the function that decides what a valid
    // spread is, and it runs on the way in from here.
    baseStats: baseStats(document.baseStats) as unknown as PersistedPlayer['baseStats'],
    skills: skills(document.skills),
    equipment: equipment(document.equipment),
    inventory: inventory(document.inventory),
    position: vec3(document.position),
    facing: real(document.facing, 0),
    currentZone: typeof document.currentZone === 'string' ? document.currentZone : '',
    level: Math.max(1, row.level),
    experience: Math.max(0, row.experience),
    unspentSkillPoints: Math.max(0, integer(document.unspentSkillPoints, 0)),
    unspentAttributePoints: Math.max(0, integer(document.unspentAttributePoints, 0)),
    health: Math.max(0, real(document.health, 0)),
    resource: Math.max(0, real(document.resource, 0)),
    // Left off entirely when it was not stored, never written as `undefined`:
    // `exactOptionalPropertyTypes` makes those two different, and "the field
    // was not there" is the one that means "load the flask full" (spec 156).
    ...(charges === undefined ? {} : { fallbackCharges: Math.max(0, integer(charges, 0)) }),
    coins: Math.max(0, row.coins),
  };
}

/** The column values a write needs, beside the serialized document. */
export interface PlayerWrite {
  readonly id: string;
  readonly displayName: string;
  readonly saveVersion: number;
  readonly coins: number;
  readonly level: number;
  readonly experience: number;
  readonly data: string;
}

export function playerToWrite(player: PersistedPlayer): PlayerWrite {
  const document: PlayerDocument = {
    baseStats: player.baseStats as unknown as Record<string, number>,
    skills: player.skills ?? [],
    equipment: player.equipment as unknown as Record<string, string | null>,
    inventory: player.inventory ?? [],
    position: player.position,
    facing: player.facing,
    currentZone: player.currentZone,
    unspentSkillPoints: player.unspentSkillPoints,
    unspentAttributePoints: player.unspentAttributePoints,
    health: player.health,
    resource: player.resource,
    ...(player.fallbackCharges === undefined ? {} : { fallbackCharges: player.fallbackCharges }),
  };
  return {
    id: player.id,
    displayName: player.displayName,
    saveVersion: PLAYER_SAVE_VERSION,
    // Clamped to what the CHECK constraints accept. A negative purse is a bug
    // upstream and the right answer is still to persist the character: a
    // constraint violation here would fail the save and, on a trade, roll back
    // an exchange that already happened in memory.
    coins: Math.max(0, Math.floor(player.coins)),
    level: Math.max(1, Math.floor(player.level)),
    experience: Math.max(0, Math.floor(player.experience)),
    data: JSON.stringify(document),
  };
}

export { PLAYER_SAVE_VERSION };
