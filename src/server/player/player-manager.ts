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
  type BaseStats,
  type EffectiveStats,
  type Equipment,
  type Inventory,
  type PersistedPlayer,
  type Vec3,
} from '../state/types.js';
import {
  addToInventory,
  applyMove,
  equipmentAddress,
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
  ATTRIBUTE_POINTS_PER_LEVEL,
  normalizeBaseStats,
  reconcileAttributePoints,
  respecAttributes,
  startingBaseStats,
  STARTING_ATTRIBUTE_POINTS,
} from './attributes.js';
import { resolveProgression } from './progression.js';
import { sanitizeSkills, spendSkillPoint, type AttributeTotals } from './skills.js';
import type { Holdings } from './trade.js';
import {
  clampCharges,
  clampHealthToStats,
  clampResourceToStats,
  computeEffectiveStats,
} from './stats.js';

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

/** Skill points granted per level gained. */
export const SKILL_POINTS_PER_LEVEL = 1;

/** Experience needed to reach `level` from the one below it. */
export function experienceForLevel(level: number): number {
  return Math.round(50 * Math.pow(Math.max(1, level - 1), 1.5));
}

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
    // A save from before spec 147 holds `might.*`/`finesse.*`/`arcane.*` rows
    // from the branch-locked tree, which no longer exists. `sanitizeSkills`
    // drops an id the table does not have, so those go and the points they cost
    // come back as `unspentSkillPoints` -- nobody is robbed, and nobody is left
    // holding a skill nothing reads.
    skills: sanitizeSkills(
      Array.isArray(loaded.skills) ? loaded.skills : [],
      baseStats as unknown as AttributeTotals,
    ),
    unspentAttributePoints: reconcileAttributePoints(
      baseStats,
      loaded.level,
      loaded.unspentAttributePoints,
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
        // The flask comes back as it was left (spec 154). A save from before it
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
    await this.store.savePlayer(session.record);
    return session;
  }

  private createCharacter(playerId: string, displayName: string): PersistedPlayer {
    return {
      id: playerId,
      displayName: displayName || playerId,
      baseStats: startingBaseStats(),
      skills: [],
      equipment: STARTER_EQUIPMENT,
      inventory: starterInventory(),
      position: DEFAULT_SPAWN,
      facing: 0,
      currentZone: this.zones.zoneIdAt(DEFAULT_SPAWN.x, DEFAULT_SPAWN.y),
      level: 1,
      experience: 0,
      unspentSkillPoints: 1,
      unspentAttributePoints: STARTING_ATTRIBUTE_POINTS,
      health: 0,
      resource: 0,
      // `fallbackCharges` is deliberately absent (spec 154), so a brand-new
      // character takes the same "load it full" path a pre-spec-154 save does
      // and there is one rule rather than two that have to agree.
      coins: STARTING_COINS,
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
    // Stat skills are re-checked against the *allocated* attributes on every
    // recalculation (spec 147): a respec, a table edit or a threshold that moved
    // can all leave a character holding a skill they could not take now, and
    // there is exactly one place that decides what happens then.
    const allocated = resolveProgression(session.record).allocated;
    const skills = sanitizeSkills(session.record.skills, allocated);
    const record = skills.length === session.record.skills.length
      ? session.record
      : { ...session.record, skills };
    const stats = computeEffectiveStats(record);
    const next: PlayerSession = {
      ...session,
      stats,
      record: {
        ...record,
        health: clampHealthToStats(record.health, stats),
        resource: clampResourceToStats(record.resource, stats),
        // Clamped on every recalculation like health and the pool, because
        // Constitution decides the ceiling and a respec can lower it (spec 154).
        fallbackCharges: clampCharges(record.fallbackCharges, stats),
      },
    };
    this.commit(next);
    await this.store.savePlayer(next.record);
    return next;
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
    return updated ? { ok: true, session: updated } : { ok: false, reason: 'not logged in' };
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
   * safety argument at this level: the swap has already produced two whole
   * containers, and this assigns both before it awaits anything. There is no
   * point between the two writes where a caller could be interrupted and leave
   * an item in both bags -- which is the failure this feature exists to be
   * careful about.
   *
   * The `await`s that follow are stat recalculations, and by then the exchange
   * has already happened.
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

    this.commit({
      ...aSession,
      record: { ...aSession.record, inventory: a.inventory, coins: a.coins },
    });
    this.commit({
      ...bSession,
      record: { ...bSession.record, inventory: b.inventory, coins: b.coins },
    });
    await this.recalculate(aId);
    await this.recalculate(bId);
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
   * Skills are *not* refunded here. `recalculate` runs `sanitizeSkills`
   * against the new allocation, so any skill whose attribute requirement is no
   * longer met is dropped there -- one place that decides what a lost
   * requirement costs, whether it was lost to a respec or to a table edit.
   */
  async respec(playerId: string): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };

    const outcome = respecAttributes(session.record);
    if (!outcome.ok) return { ok: false, reason: outcome.detail };

    this.commit({ ...session, record: outcome.player });
    const updated = await this.recalculate(playerId);
    return updated ? { ok: true, session: updated } : { ok: false, reason: 'not logged in' };
  }

  /** Validated in `skills.ts`, against the character's live attributes. */
  async spendSkillPoint(playerId: string, skillId: string): Promise<PlayerActionResult> {
    const session = this.sessions.get(playerId);
    if (!session) return { ok: false, reason: 'not logged in' };

    const { attributes } = resolveProgression(session.record);
    const outcome = spendSkillPoint(session.record, attributes, skillId);
    if (!outcome.ok) return { ok: false, reason: outcome.detail };

    this.commit({ ...session, record: outcome.player });
    const updated = await this.recalculate(playerId);
    return updated ? { ok: true, session: updated } : { ok: false, reason: 'not logged in' };
  }

  /** Awards experience and levels the character up as far as it carries them. */
  async grantExperience(playerId: string, amount: number): Promise<PlayerSession | null> {
    const session = this.sessions.get(playerId);
    if (!session || amount <= 0) return session ?? null;

    let { level, experience, unspentSkillPoints, unspentAttributePoints } = session.record;
    experience += Math.floor(amount);
    while (experience >= experienceForLevel(level + 1)) {
      experience -= experienceForLevel(level + 1);
      level += 1;
      unspentSkillPoints += SKILL_POINTS_PER_LEVEL;
      // Two budgets, granted together (spec 147). Separate on purpose: a system
      // where one point could be either makes every skill compete with a stat,
      // and the stat wins early and loses late for reasons nobody chose.
      unspentAttributePoints += ATTRIBUTE_POINTS_PER_LEVEL;
    }

    this.commit({
      ...session,
      record: { ...session.record, level, experience, unspentSkillPoints, unspentAttributePoints },
    });
    return this.recalculate(playerId);
  }

  /**
   * Mirrors the authoritative entity back into the persisted record, so a
   * disconnect saves where the player actually was rather than where they
   * logged in. Position, health and the flask only -- everything else about an
   * entity is derived and must not leak back into storage.
   *
   * The flask is here for the reason health is (spec 154): it is a live count
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
