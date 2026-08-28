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
import { STARTING_KIT } from '../data/items.js';
import type { DataStore } from '../state/store.js';
import {
  EMPTY_EQUIPMENT,
  EQUIP_SLOTS,
  emptyInventory,
  isEquipSlot,
  isSkillSlot,
  type BaseStats,
  type EffectiveStats,
  type Equipment,
  type Inventory,
  type ItemStack,
  type PersistedPlayer,
  type SlotAddress,
  type Vec3,
} from '../state/types.js';
import {
  addToInventory,
  applyMove,
  equipmentAddress,
  removeFromSlot,
  sanitizeInventory,
  type MoveRequest,
} from './inventory.js';
import { vendorById, withinReach, type VendorDefinition } from '../data/vendors.js';
import {
  buy,
  buyBack,
  forgetSale,
  rememberSale,
  sell,
  type BuybackEntry,
  type ShopOutcome,
} from './shop.js';
import {
  allocateAttributePoint,
  normalizeBaseStats,
  reconcileProgressionPoints,
  respecProgression,
  startingBaseStats,
  STARTING_PROGRESSION_POINTS,
} from './attributes.js';
import { resolveProgression } from './progression.js';
import {
  buySpecializationTier,
  sanitizeSpecializations,
  type AttributeTotals,
} from './specializations.js';
import type { Holdings } from './trade.js';
import {
  clampCharges,
  clampHealthToStats,
  clampResourceToStats,
  computeEffectiveStats,
} from './stats.js';
import { applyLevelEdit, experienceForLevel } from './levels.js';
import { itemById, maxStackOf } from '../data/items.js';
import { AdminProgressMode, type AdminProgressModeValue } from '../net/protocol.js';

/** Stats a brand new character starts with, before any allocation (spec 147). */
export const DEFAULT_BASE_STATS: BaseStats = startingBaseStats();

/** Where a character with no saved position wakes up: the safe hub. */
export const DEFAULT_SPAWN: Vec3 = { x: 600, y: 450, z: 0 };

export const STARTER_EQUIPMENT: Equipment = {
  ...EMPTY_EQUIPMENT,
  mainHand: 'sword.worn',
  chest: 'chest.leather',
};

/**
 * The starting kit, minus what the character is already wearing (spec 126).
 *
 * Subtracted rather than granted twice: `STARTER_EQUIPMENT` puts a worn sword
 * and a jerkin on, and handing a second copy of each into the bag would be the
 * first duplication bug in a system whose whole point is that nothing is
 * duplicated.
 */
export function starterInventory(): Inventory {
  const worn = new Set(EQUIP_SLOTS.map((slot) => STARTER_EQUIPMENT[slot]).filter((id) => id !== null));
  let bag = emptyInventory();
  for (const entry of STARTING_KIT) {
    if (worn.delete(entry.defId) && entry.count === 1) continue;
    bag = addToInventory(bag, entry) ?? bag;
  }
  return bag;
}

/**
 * What a new character has to spend (spec 129).
 *
 * Enough for a potion and a shield, not enough for the armourer's stock: a purse
 * that could buy anything makes the first shop a menu rather than a choice.
 */
export const STARTING_COINS = 60;

/**
 * The level arithmetic lives in `levels.ts` (spec 154) and is re-exported here
 * because this is where every caller already looks for it. The dependency points
 * that way and not back: `levels.ts` imports nothing from this file.
 */
export { experienceForLevel };

/**
 * A loaded record, brought up to spec 147.
 *
 * Three fields did not exist before it, and the rule for all three is the same:
 * **an upgrade must never rob anybody.** `dexterity` and `vitality` carry over
 * onto their new names, the two new attributes start where a fresh character
 * starts, and the attribute budget is re-derived from the character's *level* --
 * so an existing level-12 character logs in holding 38 points to place rather
 * than having notionally spent them on stats that did not exist.
 */
function migrate(loaded: PersistedPlayer): PersistedPlayer {
  const baseStats = normalizeBaseStats(loaded.baseStats);
  return {
    ...loaded,
    baseStats,
    // `sanitizeSpecializations` drops an id the table does not have, so a row
    // removed by a table edit goes and the points it cost come back through
    // `reconcileProgressionPoints` below -- nobody is robbed, and nobody is left
    // holding a specialization nothing reads.
    specializations: sanitizeSpecializations(
      Array.isArray(loaded.specializations) ? loaded.specializations : [],
      baseStats as unknown as AttributeTotals,
    ),
    unspentProgressionPoints: reconcileProgressionPoints(
      baseStats,
      Array.isArray(loaded.specializations) ? loaded.specializations : [],
      loaded.level,
      loaded.unspentProgressionPoints,
    ),
  };
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
  /**
   * What this player can buy back, per vendor (spec 129).
   *
   * On the session and never on the record: a buyback list that survived a
   * logout would be a shop remembering a transaction from last week, and the
   * whole point of it is undoing the click you just made.
   */
  readonly buyback: Readonly<Record<string, readonly BuybackEntry[]>>;
}

export type PlayerActionResult =
  | { readonly ok: true; readonly session: PlayerSession }
  | { readonly ok: false; readonly reason: string };

/**
 * What a drop took, beside the session it changed (spec 172).
 *
 * `taken` is on the success case for the reason `removeFromSlot` returns it: a
 * removal is half a transaction, and the caller has to put the stack somewhere.
 */
export type DropResult =
  | { readonly ok: true; readonly session: PlayerSession; readonly taken: ItemStack }
  | { readonly ok: false; readonly reason: string };

/**
 * A progression edit's result (spec 154). Carries a description of what changed,
 * because "level 4 -> 9, 6 skill point(s)" is the only way the operator who
 * asked for it can see that it did what they meant.
 */
export type ProgressResult =
  | { readonly ok: true; readonly session: PlayerSession; readonly detail: string }
  | { readonly ok: false; readonly reason: string };

export class PlayerManager {
  private readonly sessions = new Map<string, PlayerSession>();
  private readonly byEntity = new Map<number, string>();
  /**
   * Logged-in players whose record has changed since it was last written
   * (spec 226).
   *
   * A set of ids rather than a flag on the session, because a session is
   * replaced wholesale on every `commit` and a flag on it would be copied
   * forward by the spread that replaces it -- so clearing one would be undone
   * by the next unrelated edit. A set outside the session is cleared exactly
   * when a save succeeds and by nothing else.
   *
   * Nothing here reads a clock: `player/` is part of the deterministic core, so
   * *when* to flush is `persistence/autosave.ts`'s question and this only
   * answers *what*.
   */
  private readonly dirty = new Set<string>();

  constructor(
    private readonly store: DataStore,
    private readonly zones: ZoneManager,
  ) {}

  // --- dirty tracking ----------------------------------------------------

  /**
   * Note that this player's persistent state has moved.
   *
   * Cheap on purpose -- one `Set.add` -- because the highest-frequency caller
   * is `syncFromEntity`, which runs for every logged-in player on every
   * broadcast. Saving there instead is the mistake this whole mechanism exists
   * to avoid: twenty writes a second per player, of which nineteen are a
   * position that moved a few units.
   */
  markDirty(playerId: string): void {
    if (this.sessions.has(playerId)) this.dirty.add(playerId);
  }

  /** Ids with unsaved changes, oldest marked first (insertion order). */
  dirtyIds(): readonly string[] {
    return [...this.dirty];
  }

  isDirty(playerId: string): boolean {
    return this.dirty.has(playerId);
  }

  /** The record as it stands in memory, for whoever is about to write it. */
  recordOf(playerId: string): PersistedPlayer | null {
    return this.sessions.get(playerId)?.record ?? null;
  }

  /**
   * Give a logged-in player a new display name (spec 227).
   *
   * The in-memory half of a claim, and the half without which the other one
   * does not survive: the row is written inside the registration's transaction,
   * and this record is what the autosave writes *over* it twenty-five seconds
   * later. False when nobody is playing as that id, which is not a failure --
   * the row is already right and there is nothing here to correct.
   *
   * The record is **replaced rather than mutated**, which is the rule every
   * writer here follows and matters more than usual for this one: a flush that
   * started before the rename holds the old object, so `clearDirtyIfUnchanged`
   * compares identity and correctly refuses to clear the mark this just set.
   * Mutating in place would make that comparison say the new name had been
   * written when what went to disk was the old one.
   *
   * `session.displayName` moves with it. Both exist and are not redundant: the
   * session's is what the connection announced itself as, the record's is what
   * the character is called -- and `nameOf` reads the record, so that is the one
   * every other client sees over the body.
   */
  rename(playerId: string, displayName: string): boolean {
    const session = this.sessions.get(playerId);
    if (!session || displayName === '') return false;
    if (session.record.displayName === displayName && session.displayName === displayName) return false;
    this.commit({
      ...session,
      displayName,
      record: { ...session.record, displayName },
    });
    this.dirty.add(playerId);
    return true;
  }

  /**
   * Clear the dirty mark, but only if the record has not moved since the
   * snapshot that was written.
   *
   * The identity comparison is the whole of it. A save is `snapshot -> await
   * store -> clear`, and a gameplay edit landing inside that await produces a
   * *new* record object; clearing unconditionally would then mark clean a
   * change that was never written. Records are replaced rather than mutated
   * everywhere in this class, so `===` is exactly the right question.
   */
  clearDirtyIfUnchanged(playerId: string, written: PersistedPlayer): boolean {
    const session = this.sessions.get(playerId);
    if (!session || session.record !== written) return false;
    this.dirty.delete(playerId);
    return true;
  }

  /**
   * Persist these players now, in one transaction, and clear their dirty marks
   * if it lands.
   *
   * For the operations too important to wait for the autosave loop: a trade, a
   * purchase, a sale. A failure leaves every mark in place and reports, because
   * the alternative -- a clean flag over an unwritten change -- is how a save
   * gets silently skipped forever.
   */
  async persistNow(playerIds: readonly string[]): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> {
    const records: PersistedPlayer[] = [];
    for (const id of playerIds) {
      const record = this.recordOf(id);
      if (record) records.push(record);
    }
    if (records.length === 0) return { ok: true };
    try {
      await this.store.savePlayers(records);
    } catch (error) {
      return { ok: false, error };
    }
    for (const record of records) this.clearDirtyIfUnchanged(record.id, record);
    return { ok: true };
  }

  /**
   * Loads or creates a character and derives its stats fresh. A save that has
   * gone stale against the tables -- a deleted skill, a level past a new cap --
   * is sanitised here rather than being allowed into the world.
   */
  async login(playerId: string, displayName: string): Promise<PlayerSession> {
    const loaded = await this.store.loadPlayer(playerId);
    const record: PersistedPlayer = loaded
      ? // A save from before spec 126 has no `inventory` at all; it loads as an
        // empty bag and keeps whatever it was wearing. Nobody is stripped by an
        // upgrade, and nobody is handed a second starting kit for logging in.
        migrate({
          ...loaded,
          // Sanitised in `migrate`, which is where the attribute allocation is
          // settled -- a skill's gate is an attribute, so the two cannot be
          // checked in either order.
          inventory: sanitizeInventory(loaded.inventory),
          // A save from before spec 129 has no purse. It loads as the starting
          // one rather than as zero: an upgrade must not rob anybody, and there
          // is no way to tell "spent it all" from "never had any" in a field
          // that was not there.
          coins: Number.isFinite(loaded.coins) ? Math.max(0, Math.floor(loaded.coins)) : STARTING_COINS,
        })
      : this.createCharacter(playerId, displayName);

    const stats = computeEffectiveStats(record);
    const session: PlayerSession = {
      playerId,
      displayName: record.displayName,
      entityId: -1,
      record: {
        ...record,
        health: clampHealthToStats(record.health > 0 ? record.health : stats.maxHealth, stats),
        // A fresh login comes back with a full pool; there is nothing to gain
        // from making someone wait out a regen timer at the character select.
        resource: stats.maxResource,
        // The flask comes back as it was left (spec 156). A save from before it
        // existed loads full: an upgrade must not strand an existing character
        // with no insurance, and `undefined` cannot be told from "drank them
        // all" in a field that was not there.
        fallbackCharges: clampCharges(record.fallbackCharges, stats),
        currentZone: this.zones.zoneIdAt(record.position.x, record.position.y),
      },
      stats,
      muted: (await this.store.getMute(playerId)) !== null,
      lastAppliedInputSeq: 0,
      buyback: {},
    };
    this.sessions.set(playerId, session);
    // Written immediately rather than left to the autosave loop, and this is
    // the one routine save that has to be: for a brand-new character there is
    // no row yet, so a crash before the first flush would lose the character
    // rather than a few seconds of one. Cleared afterwards, because what was
    // just written is what is in memory.
    await this.store.savePlayer(session.record);
    this.dirty.delete(playerId);
    return session;
  }

  private createCharacter(playerId: string, displayName: string): PersistedPlayer {
    return newCharacter(playerId, displayName, this.zones.zoneIdAt(DEFAULT_SPAWN.x, DEFAULT_SPAWN.y));
  }

  /**
   * End a session, flushing whatever it had not saved.
   *
   * The disconnect flush is a *safety net* rather than the save mechanism
   * (spec 226): the autosave loop has already written this player within the
   * interval, and this catches the seconds since. So a failure here is logged
   * and swallowed rather than thrown -- the session is over either way, and
   * throwing out of a disconnect handler would take the connection teardown
   * with it. What is lost is at most one interval of progress, which is the
   * same thing a kill -9 costs and is documented as such.
   */
  async logout(playerId: string): Promise<void> {
    const session = this.sessions.get(playerId);
    if (!session) return;
    this.sessions.delete(playerId);
    if (session.entityId >= 0) this.byEntity.delete(session.entityId);
    // Dropped whether or not the write lands: the session is gone, so nothing
    // can flush this id again and a mark left behind would be a permanent
    // entry in the dirty set naming a player who is not logged in.
    this.dirty.delete(playerId);
    try {
      await this.store.savePlayer(session.record);
    } catch (error) {
      this.onSaveError?.(playerId, error);
    }
  }

  /**
   * Told about a save that failed, so the process has somewhere to log it.
   *
   * A callback rather than a logger, because `player/` is part of the
   * deterministic core and a `console` in here would be a side effect in a
   * module whose whole contract is that it has none.
   */
  onSaveError: ((playerId: string, error: unknown) => void) | null = null;

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
   * Re-derive stats from a session's record and clamp the live pools to the new
   * ceilings. Pure: it commits nothing and writes nothing.
   *
   * Split out of {@link recalculate} for one caller (spec 226). A trade has to
   * persist *before* it commits to memory, so that a failed write leaves both
   * bags exactly as they were -- which means it needs the finished session
   * before anything has been made true, and `recalculate` only hands one back
   * once it already is.
   */
  private derive(session: PlayerSession): PlayerSession {
    // Specializations are re-checked against the *allocated* attributes on every
    // recalculation (spec 147): a table edit or a threshold that moved can leave
    // a character holding a tier they could not buy now, and there is exactly one
    // place that decides what happens then. A respec no longer reaches here --
    // since spec 244 it refunds the tiers itself, atomically.
    const allocated = resolveProgression(session.record).allocated;
    const specializations = sanitizeSpecializations(session.record.specializations, allocated);
    const record = specializations.length === session.record.specializations.length
      ? session.record
      : { ...session.record, specializations };
    const stats = computeEffectiveStats(record);
    return {
      ...session,
      stats,
      record: {
        ...record,
        health: clampHealthToStats(record.health, stats),
        resource: clampResourceToStats(record.resource, stats),
        // Clamped on every recalculation like health and the pool, because
        // Constitution decides the ceiling and a respec can lower it (spec 156).
        fallbackCharges: clampCharges(record.fallbackCharges, stats),
      },
    };
  }

  /**
   * Re-derives stats from the record as it stands and clamps health to the new
   * ceiling. The single funnel every stat change passes through.
   *
   * It used to end in `store.savePlayer` (spec 056), which made every equip,
   * unequip, allocation and purchase a synchronous write of the whole record.
   * Against a Map that was free; against a database it is the pattern spec 226
   * exists to replace. It marks the player dirty instead, and
   * `persistence/autosave.ts` writes them in batches -- with the operations
   * that must not wait (a trade, a purchase) calling {@link persistNow}
   * themselves rather than relying on the loop.
   */
  async recalculate(playerId: string): Promise<PlayerSession | null> {
    const session = this.sessions.get(playerId);
    if (!session) return null;
    const next = this.derive(session);
    this.commit(next);
    this.dirty.add(playerId);
    return Promise.resolve(next);
  }

  /**
   * The one write into either container (spec 126).
   *
   * Everything below goes through here, and here goes through `applyMove` --
   * which is pure, so the rules that decide whether a move is legal are testable
   * without a session, a store or a clock.
   */
  async moveItem(playerId: string, request: MoveRequest): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };

    const outcome = applyMove(
      session.record.inventory,
      session.record.equipment,
      request,
      session.record.level,
    );
    if (!outcome.ok) return { ok: false, reason: outcome.reason };

    this.commit({
      ...session,
      record: { ...session.record, inventory: outcome.inventory, equipment: outcome.equipment },
    });
    const updated = await this.recalculate(playerId);
    return updated ? { ok: true, session: updated } : { ok: false, reason: 'not logged in' };
  }

  /**
   * Take a stack out of a slot and hand it back (spec 172).
   *
   * The container half of putting something down. It commits and re-derives
   * through the same funnel `moveItem` does -- dropping the sword you are
   * holding changes what you hit for, and a removal that skipped
   * `recalculate` would leave the stats of a player still wearing it.
   *
   * It does **not** put anything in the world: that needs the terrain, the
   * zones and an entity id, none of which live here. The caller gets the stack
   * and is responsible for it -- which is why this is the second half of a
   * transaction the server does not await anything between.
   */
  async dropItem(playerId: string, at: SlotAddress, count?: number): Promise<DropResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };

    const outcome = removeFromSlot(
      session.record.inventory,
      session.record.equipment,
      at,
      count,
    );
    if (!outcome.ok) return { ok: false, reason: outcome.reason };

    this.commit({
      ...session,
      record: { ...session.record, inventory: outcome.inventory, equipment: outcome.equipment },
    });
    const updated = await this.recalculate(playerId);
    return updated
      ? { ok: true, session: updated, taken: outcome.taken }
      : { ok: false, reason: 'not logged in' };
  }

  /**
   * Wear the first one of `itemId` in the bag.
   *
   * Kept for the HUD's weapon switch, which knows an item id and not a slot
   * index, and reimplemented over `moveItem` rather than beside it -- so it
   * obeys ownership for free instead of having its own copy of the rules to
   * forget one of. Strictly redundant with `MoveItem` once nothing sends it.
   */
  async equip(playerId: string, slot: string, itemId: string): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };
    if (!isEquipSlot(slot)) return { ok: false, reason: `no such slot: ${slot}` };
    // **Not a skill slot** (spec 188). This is the weapon switch's path and it
    // is instantaneous by design; a skill slot costs time and is refused while
    // its skill is on cooldown, and neither rule lives here. Left reachable it
    // would be the whole of spec 188's swap gate bypassed by a message the HUD
    // already sends.
    if (isSkillSlot(slot)) return { ok: false, reason: 'change a skill from the bag' };

    const index = session.record.inventory.findIndex((stack) => stack?.defId === itemId);
    if (index < 0) return { ok: false, reason: `you are not carrying ${itemId}` };

    return this.moveItem(playerId, {
      from: { container: 'inventory', index },
      to: equipmentAddress(slot),
      count: 1,
    });
  }

  /** Take off what is in `slot` and put it in the first free bag slot. */
  async unequip(playerId: string, slot: string): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };
    if (!isEquipSlot(slot)) return { ok: false, reason: `no such slot: ${slot}` };
    // The other half of the same gate: taking a skill *off* is a swap too.
    if (isSkillSlot(slot)) return { ok: false, reason: 'change a skill from the bag' };
    if (session.record.equipment[slot] === null) return { ok: false, reason: `${slot} is empty` };

    const free = session.record.inventory.findIndex((stack) => stack === null);
    if (free < 0) return { ok: false, reason: 'your bag is full' };

    return this.moveItem(playerId, {
      from: equipmentAddress(slot),
      to: { container: 'inventory', index: free },
    });
  }

  /**
   * Where a shop's transactions land (spec 129).
   *
   * The proximity check lives here rather than in `shop.ts` because where a
   * player is standing is session state -- so the pure half stays drivable
   * without a world, and there is exactly one place that knows a shop has a
   * counter you have to walk up to.
   */
  private vendorInReach(session: PlayerSession, vendorId: string): VendorDefinition | string {
    const vendor = vendorById(vendorId);
    if (!vendor) return `no such vendor: ${vendorId}`;
    const at = session.record.position;
    if (!withinReach(vendor, at.x, at.y)) return `you are too far from the ${vendor.name}`;
    return vendor;
  }

  /** What this vendor is offering, or null when it cannot be reached. */
  vendorFor(playerId: string, vendorId: string): VendorDefinition | null {
    const session = this.sessions.get(playerId);
    if (!session) return null;
    const found = this.vendorInReach(session, vendorId);
    return typeof found === 'string' ? null : found;
  }

  /** The sales this player can undo at this vendor, newest first. */
  buybackFor(playerId: string, vendorId: string): readonly BuybackEntry[] {
    return this.sessions.get(playerId)?.buyback[vendorId] ?? [];
  }

  private async settle(
    playerId: string,
    session: PlayerSession,
    outcome: ShopOutcome,
    buyback: Readonly<Record<string, readonly BuybackEntry[]>>,
  ): Promise<PlayerActionResult> {
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    this.commit({
      ...session,
      buyback,
      record: { ...session.record, inventory: outcome.inventory, coins: outcome.coins },
    });
    const updated = await this.recalculate(playerId);
    if (!updated) return { ok: false, reason: 'not logged in' };
    // A purchase moves currency, so it is written now rather than at the next
    // flush (spec 226). Judgement rather than a rule applied everywhere: an
    // equip or a spent skill point neither creates nor destroys anything and
    // can wait, and a crash that rewinds one is a crash that rewinds a choice.
    // A crash that rewinds a *sale* hands back an item that was paid for.
    //
    // A failed write is reported and the purchase stands: it has already
    // happened in memory, the player has been told, and the record stays dirty
    // so the next flush tries again. This is the recoverable case, unlike a
    // trade -- there is one bag involved, so there is no half of it to be left
    // in.
    const written = await this.persistNow([playerId]);
    if (!written.ok) this.onSaveError?.(playerId, written.error);
    return { ok: true, session: updated };
  }

  async buyItem(
    playerId: string,
    vendorId: string,
    defId: string,
    count: number,
  ): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };
    const vendor = this.vendorInReach(session, vendorId);
    if (typeof vendor === 'string') return { ok: false, reason: vendor };

    const outcome = buy(session.record.inventory, session.record.coins, vendor, defId, count);
    return this.settle(playerId, session, outcome, session.buyback);
  }

  async sellItem(
    playerId: string,
    vendorId: string,
    index: number,
    count: number,
  ): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };
    const vendor = this.vendorInReach(session, vendorId);
    if (typeof vendor === 'string') return { ok: false, reason: vendor };

    const outcome = sell(session.record.inventory, session.record.coins, vendor, index, count);
    const buyback =
      outcome.ok && outcome.sold
        ? { ...session.buyback, [vendorId]: rememberSale(session.buyback[vendorId] ?? [], outcome.sold) }
        : session.buyback;
    return this.settle(playerId, session, outcome, buyback);
  }

  async buyBackItem(playerId: string, vendorId: string, index: number): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };
    const vendor = this.vendorInReach(session, vendorId);
    if (typeof vendor === 'string') return { ok: false, reason: vendor };

    const list = session.buyback[vendorId] ?? [];
    const entry = list[index];
    if (!entry) return { ok: false, reason: 'nothing to buy back there' };

    const outcome = buyBack(session.record.inventory, session.record.coins, entry);
    const buyback = outcome.ok ? { ...session.buyback, [vendorId]: forgetSale(list, index) } : session.buyback;
    return this.settle(playerId, session, outcome, buyback);
  }

  /** What a trade's rules need to see of a player (spec 132). */
  holdingsOf(playerId: string): Holdings | null {
    const session = this.sessions.get(playerId);
    if (!session) return null;
    return { inventory: session.record.inventory, coins: session.record.coins };
  }

  /**
   * Write both sides of a settled trade.
   *
   * One method rather than two calls to a per-player one, and that is the whole
   * safety argument: the swap has already produced two whole containers, and
   * both are persisted in a single transaction and only then assigned. There is
   * no ordering of these steps that can leave one bag written and the other
   * not, in memory or on disk.
   *
   * The order is **persist, then commit**, and it is the opposite of what the
   * first version did (spec 226). Committing first and saving after leaves a
   * failed write with the exchange already true in memory and false on disk --
   * so a crash before the next autosave un-does half a trade that both players
   * watched happen, and the half it un-does depends on which record the loop
   * reached first. Persisting first means a refusal is a trade that simply did
   * not occur: both bags are untouched, and `settleTrade` cancels with the
   * reason attached.
   *
   * The records written are the *derived* ones -- stats recomputed, pools
   * clamped -- so what lands in the database is exactly what is committed to
   * memory rather than a version of it from before the recalculation.
   */
  async applyTrade(
    aId: string,
    bId: string,
    a: Holdings,
    b: Holdings,
  ): Promise<{ readonly ok: boolean; readonly reason: string }> {
    const aSession = this.sessions.get(aId);
    const bSession = this.sessions.get(bId);
    if (!aSession || !bSession) return { ok: false, reason: 'one of you is not logged in' };

    const nextA = this.derive({
      ...aSession,
      record: { ...aSession.record, inventory: a.inventory, coins: a.coins },
    });
    const nextB = this.derive({
      ...bSession,
      record: { ...bSession.record, inventory: b.inventory, coins: b.coins },
    });

    try {
      await this.store.savePlayers([nextA.record, nextB.record]);
    } catch (error) {
      // Nothing has been committed, so there is nothing to undo. The reason
      // reaches both players as a cancelled trade.
      return {
        ok: false,
        reason: `the exchange could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    this.commit(nextA);
    this.commit(nextB);
    // Written and unchanged since, so neither is dirty. Cleared explicitly
    // rather than left, or the next autosave rewrites two records nothing has
    // touched.
    this.dirty.delete(aId);
    this.dirty.delete(bId);
    return { ok: true, reason: '' };
  }

  /**
   * Puts one attribute point somewhere (spec 147).
   *
   * Through `attributes.ts` for the rules and through {@link recalculate} for
   * the consequences, which is the same two-step every other stat change in this
   * class takes. A rejection returns the reason and leaves the record untouched.
   */
  async allocateAttribute(playerId: string, key: string): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };

    const outcome = allocateAttributePoint(session.record, key);
    if (!outcome.ok) return { ok: false, reason: outcome.detail };

    this.commit({ ...session, record: outcome.player });
    const updated = await this.recalculate(playerId);
    return updated ? { ok: true, session: updated } : { ok: false, reason: 'not logged in' };
  }

  /**
   * Hands every allocated point back, for coins.
   *
   * Skills are *not* refunded here. `recalculate` runs `sanitizeSpecializations`
   * against the new allocation, so any skill whose attribute requirement is no
   * longer met is dropped there -- one place that decides what a lost
   * requirement costs, whether it was lost to a respec or to a table edit.
   */
  async respec(playerId: string): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };

    const outcome = respecProgression(session.record);
    if (!outcome.ok) return { ok: false, reason: outcome.detail };

    this.commit({ ...session, record: outcome.player });
    const updated = await this.recalculate(playerId);
    return updated ? { ok: true, session: updated } : { ok: false, reason: 'not logged in' };
  }

  /** Validated in `specializations.ts`, against the character's live attributes. */
  async buySpecializationTier(
    playerId: string,
    specializationId: string,
  ): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };

    const { attributes } = resolveProgression(session.record);
    const outcome = buySpecializationTier(session.record, attributes, specializationId);
    if (!outcome.ok) return { ok: false, reason: outcome.detail };

    this.commit({ ...session, record: outcome.player });
    const updated = await this.recalculate(playerId);
    return updated ? { ok: true, session: updated } : { ok: false, reason: 'not logged in' };
  }

  /**
   * Awards experience and levels the character up as far as it carries them.
   *
   * Since spec 154 this is {@link setProgress} with one mode fixed, rather than
   * its own copy of the level-up loop. One place decides how experience becomes
   * levels, so a monster's award and an admin's grant cannot come to different
   * answers -- including about the level cap, which a second loop would have
   * quietly ignored.
   */
  async grantExperience(playerId: string, amount: number): Promise<PlayerSession | null> {
    const session = this.sessions.get(playerId);
    if (!session || amount <= 0) return session ?? null;
    const result = await this.setProgress(playerId, AdminProgressMode.AddExperience, amount);
    return result.ok ? result.session : null;
  }

  /**
   * Edits a level or an experience total (spec 154).
   *
   * The arithmetic is `applyLevelEdit`, which is pure; this is the part that needs
   * a session -- committing the record and re-deriving stats through the one
   * funnel every other stat change already passes through.
   */
  async setProgress(
    playerId: string,
    mode: AdminProgressModeValue,
    amount: number,
  ): Promise<ProgressResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };

    const outcome = applyLevelEdit(session.record, mode, amount);
    this.commit({ ...session, record: outcome.player });
    const updated = await this.recalculate(playerId);
    return updated
      ? { ok: true, session: updated, detail: outcome.detail }
      : { ok: false, reason: 'not logged in' };
  }

  /**
   * Puts a stack in the bag, or refuses and changes nothing (spec 154).
   *
   * `addToInventory` is all-or-nothing, and that is deliberate here: a bag that
   * can hold four of six takes none of them, so an operator is told the bag is
   * full rather than left guessing how many landed.
   */
  async giveItem(playerId: string, defId: string, count: number): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };
    if (!itemById(defId)) return { ok: false, reason: `no such item: ${defId}` };

    const wanted = Math.floor(count);
    if (!Number.isFinite(wanted) || wanted < 1) return { ok: false, reason: 'count must be at least 1' };

    const bag = addToInventory(session.record.inventory, { defId, count: wanted });
    if (bag === null) {
      const cap = maxStackOf(defId);
      return {
        ok: false,
        reason: `their bag cannot hold ${wanted} x ${defId} (stacks of ${cap})`,
      };
    }

    this.commit({ ...session, record: { ...session.record, inventory: bag } });
    const updated = await this.recalculate(playerId);
    return updated ? { ok: true, session: updated } : { ok: false, reason: 'not logged in' };
  }

  /**
   * Mirrors the authoritative entity back into the persisted record, so a
   * disconnect saves where the player actually was rather than where they
   * logged in. Position, health and the flask only -- everything else about an
   * entity is derived and must not leak back into storage.
   *
   * The flask is here for the reason health is (spec 156): it is a live count
   * the sim spends and the rest loop refills, and a relog that handed it back
   * full would make logging out the cheapest heal in the game. The restoration
   * *meter* is deliberately not mirrored -- see `PersistedPlayer`.
   */
  syncFromEntity(
    playerId: string,
    position: Vec3,
    facing: number,
    health: number,
    fallbackCharges?: number,
  ): PlayerSession | null {
    const session = this.sessions.get(playerId);
    if (!session) return null;
    // The highest-frequency writer of persistent state there is -- every
    // logged-in player, every broadcast. Marking is a `Set.add`; the flush that
    // acts on it is `persistence/autosave.ts`'s, every twenty seconds or so.
    this.dirty.add(playerId);
    return this.commit({
      ...session,
      record: {
        ...session.record,
        position,
        facing,
        health,
        // Spread rather than assigned: `exactOptionalPropertyTypes` means
        // writing `undefined` is not the same as leaving the key off, and
        // leaving it off is what "the caller had nothing to say" has to mean.
        ...(fallbackCharges === undefined ? {} : { fallbackCharges }),
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

/**
 * A brand-new character, as data (spec 226).
 *
 * Module-level so that `auth/` can create the player row a guest session has to
 * reference without reaching into a manager, a zone map or a world. There is
 * one description of what a new character is and both callers use it -- the
 * alternative being a second starting kit in `auth/`, which would drift the
 * first time either moved.
 *
 * The zone is an argument rather than derived, because deriving it needs a
 * `ZoneManager` and that is exactly the dependency this split exists to avoid.
 * `PlayerManager.createCharacter` supplies the hub's; a guest gets the same one
 * from `DEFAULT_SPAWN`.
 */
export function newCharacter(playerId: string, displayName: string, zoneId: string): PersistedPlayer {
  return {
    id: playerId,
    displayName: displayName || playerId,
    baseStats: startingBaseStats(),
    specializations: [],
    equipment: STARTER_EQUIPMENT,
    inventory: starterInventory(),
    position: DEFAULT_SPAWN,
    facing: 0,
    currentZone: zoneId,
    level: 1,
    experience: 0,
    unspentProgressionPoints: STARTING_PROGRESSION_POINTS,
    health: 0,
    resource: 0,
    // `fallbackCharges` is deliberately absent (spec 156), so a brand-new
    // character takes the same "load it full" path a pre-spec-154 save does
    // and there is one rule rather than two that have to agree.
    coins: STARTING_COINS,
  };
}
