/**
 * The server's shared vocabulary (spec 056): the shapes that persistence, the
 * sim, the network layer and the admin router all agree on. Types only, no
 * imports, no behaviour -- so every other server module can depend on this one
 * without any risk of a cycle.
 */

/**
 * A point in the world. `x`/`y` are the ground plane, matching the sim's
 * {@link import('../../sim/types.js').Vec2} so the existing collision helpers
 * apply unchanged; `z` is height above the ground, sampled from the heightfield.
 */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The six attributes a character is built out of (spec 147). Persisted verbatim
 * and never recomputed -- these are the *inputs* to the stat pipeline, not its
 * output.
 *
 * `dexterity` and `vitality` were renamed to `agility` and `constitution`
 * rather than kept as aliases: a field the code calls one thing and the sheet
 * calls another is the drift this repo does not tolerate, and
 * {@link import('../player/attributes.js').normalizeBaseStats} maps an old save
 * onto the new names on the way in so nobody loses a point for it.
 */
export interface BaseStats {
  readonly strength: number;
  readonly agility: number;
  readonly intelligence: number;
  readonly constitution: number;
  readonly perception: number;
  readonly wisdom: number;
}

export type BaseStatKey = keyof BaseStats;

/**
 * Canonical order. **Load-bearing**: it is the wire order of the six varuints on
 * the `Stats` message and the ordinal an `AllocateAttribute` names, so reordering
 * this array is a protocol change rather than a cosmetic one.
 */
export const BASE_STAT_KEYS: readonly BaseStatKey[] = [
  'strength',
  'agility',
  'intelligence',
  'constitution',
  'perception',
  'wisdom',
];

export type EquipSlot = 'mainHand' | 'offHand' | 'head' | 'chest' | 'legs' | 'trinket';

export const EQUIP_SLOTS: readonly EquipSlot[] = [
  'mainHand',
  'offHand',
  'head',
  'chest',
  'legs',
  'trinket',
];

export function isEquipSlot(value: string): value is EquipSlot {
  return (EQUIP_SLOTS as readonly string[]).includes(value);
}

/** A point spent in the tree. Only the id and the level are ever stored. */
export interface SkillAllocation {
  readonly skillId: string;
  readonly level: number;
}

export type Equipment = Readonly<Record<EquipSlot, string | null>>;

export const EMPTY_EQUIPMENT: Equipment = {
  mainHand: null,
  offHand: null,
  head: null,
  chest: null,
  legs: null,
  trinket: null,
};

/**
 * One occupied inventory slot (spec 126): a definition id and how many.
 *
 * No instance id and no shape. An item *is* its definition plus a count, which
 * keeps `data/items.ts`'s rule intact -- buffing a sword buffs every sword --
 * and keeps a slot addressable by index, which is all a uniform grid needs.
 * Durability, sockets and multi-cell footprints all land as fields here or on
 * the definition when they arrive.
 */
export interface ItemStack {
  readonly defId: string;
  /** >= 1, and <= the definition's `maxStack`. */
  readonly count: number;
}

/** Fixed-length. A null slot is an empty one; the array never shortens. */
export type Inventory = readonly (ItemStack | null)[];

export const INVENTORY_SLOTS = 24;

/** A bag of the right length with nothing in it. A new array every call. */
export function emptyInventory(): Inventory {
  return new Array<ItemStack | null>(INVENTORY_SLOTS).fill(null);
}

export type ContainerId = 'inventory' | 'equipment';

/**
 * One addressable slot, in either container (spec 126).
 *
 * Here in the shared vocabulary rather than beside the rules that use it,
 * because the wire format needs to name a slot too and `net/` is not allowed to
 * depend on anything but this file. `player/inventory.ts` re-exports it, so the
 * rules and the codec cannot disagree about what an address is.
 */
export interface SlotAddress {
  readonly container: ContainerId;
  /** An index into the inventory, or the ordinal of an {@link EquipSlot}. */
  readonly index: number;
}

/**
 * Everything about a player that survives a disconnect.
 *
 * Note what is *not* here: no maxHealth, no attack damage, no movement speed,
 * no armor. Those are derived on login and on every equip/skill change by
 * {@link import('../player/stats.js').computeEffectiveStats}, from the tables
 * as they exist *now*. Persisting them would freeze yesterday's balance patch
 * into every save file and hand the client a number worth lying about.
 *
 * `health` is here because it is a live resource, not a derived stat -- but it
 * is clamped to the freshly derived maxHealth on every recalculation.
 *
 * `currentChunk` is likewise absent: it is a pure function of `position`
 * (see `world/chunks.ts`), and a second copy of a fact is a second copy to get
 * wrong.
 */
export interface PersistedPlayer {
  readonly id: string;
  readonly displayName: string;
  readonly baseStats: BaseStats;
  /**
   * Points spent in the attribute-attuned tree (spec 147).
   *
   * The only tree there is. Spec 056's branch-locked Might/Finesse/Arcane tree
   * is gone: a system whose whole premise is that unusual combinations should be
   * discoverable cannot also have three columns that permanently foreclose each
   * other, and keeping both meant two skill systems where one would do.
   */
  readonly skills: readonly SkillAllocation[];
  readonly equipment: Equipment;
  /**
   * What the player is carrying (spec 126). Exactly {@link INVENTORY_SLOTS}
   * entries once loaded; a save written before this field existed comes back
   * with an empty bag and keeps whatever it had equipped.
   */
  readonly inventory: Inventory;
  readonly position: Vec3;
  /** Heading in radians, 0 = +x. */
  readonly facing: number;
  readonly currentZone: string;
  readonly level: number;
  readonly experience: number;
  /** Skill points earned by levelling and not yet spent. */
  readonly unspentSkillPoints: number;
  /**
   * Attribute points earned by levelling and not yet spent (spec 147).
   *
   * Its own budget, deliberately: a system where a point can be either a stat or
   * a skill makes every skill compete with a stat, and the stat always wins
   * early and never wins late. Two budgets means the two trees are tuned
   * against themselves rather than against each other.
   */
  readonly unspentAttributePoints: number;
  /** Live resource, clamped to derived maxHealth whenever stats are recomputed. */
  readonly health: number;
  /** Ability resource, clamped the same way. Live, not derived. */
  readonly resource: number;
  /**
   * Fallback flask charges left (spec 154).
   *
   * Live like health, and persisted for the same reason: it is the insurance a
   * character is carrying, and a relog that refilled it would make logging out
   * the cheapest way to heal. A save written before this field existed comes
   * back full, which is the generous reading and the only one that cannot
   * strand an existing character with no way to recover.
   *
   * The restoration *meter* is deliberately not here. It is momentum inside an
   * expedition rather than a possession, and a persisted one would be a thing
   * to bank by logging out at 99.
   *
   * Optional, and that is the migration: a record written before this field
   * existed has `undefined` here, which `player-manager.ts` reads as a full
   * flask. The alternative -- required, defaulted to zero by whoever forgot --
   * strands an existing character with no way to recover.
   */
  readonly fallbackCharges?: number;
  /**
   * What this character can spend (spec 129).
   *
   * A live resource like health, not a derived stat: it is changed by an
   * exchange and never recomputed from a table.
   */
  readonly coins: number;
}

/**
 * Everything the six attributes derive that the four never had (spec 147).
 *
 * A nested block on {@link EffectiveStats} rather than twenty more fields beside
 * the existing ones, for two reasons. Every existing reader -- the sim, the
 * prediction, the sheet, the codec -- keeps working untouched, so the diff that
 * introduces a whole progression system does not also rewrite `applyArmor`. And
 * the wire gets one fixed block to write rather than twenty appends that each
 * have to be found in two functions.
 *
 * Every field is a *number*, including the ones that read as flags: a milestone
 * grants `0.6` hyper-armour, not `true`, so two sources of the same effect sum
 * the way every other modifier in this repo sums, and there is no boolean whose
 * "on" means a different amount depending on who set it.
 *
 * All of it is derived. None of it is persisted, and none of it is ever read
 * from a client.
 */
export interface TraitStats {
  // --- Strength: force and commitment ------------------------------------
  /** Poise damage one blow carries. See `sim/poise.ts`. */
  readonly staggerPower: number;
  /** How long a poise break roots the body it happened to, in ticks. */
  readonly staggerTicks: number;
  /**
   * Fraction of incoming poise damage ignored *while committed to a cast*.
   * 0 is none, 1 is unbreakable. Never applies to a body that is not casting --
   * that is the whole difference between hyper-armour and CC immunity.
   */
  readonly windupPoiseArmor: number;
  /** Hyper-armour extends past the attack point into the backswing when 1. */
  readonly poiseArmorInBackswing: number;
  /** Hyper-armour covers every cast rather than basic attacks alone, when 1. */
  readonly poiseArmorAllCasts: number;
  /** Health fraction below which `poiseArmorAllCasts` turns on. 0 disables it. */
  readonly juggernautBelow: number;
  /** Resource returned by a poise break this body caused. */
  readonly breakResource: number;
  /** Fraction of live cooldowns removed by a poise break this body caused. */
  readonly breakCooldownRefund: number;
  /**
   * Multiplier on a **basic attack's** damage, the way `spellPower` is one on an
   * ability's (spec 147).
   *
   * This is the fix for a hole spec 062 left and nobody noticed for eighty-five
   * specs: `applyDamage` multiplied every blow by `spellPower` and read
   * `attackDamage` nowhere at all, so Strength's damage coefficient was
   * decorative -- derived, replicated, shown on the sheet, and never reaching a
   * blow. A "pure Strength" build could not deal damage with Strength.
   *
   * Derived *from* `attackDamage` rather than beside it, so there is still one
   * number that means "how hard do I hit" and the sheet's Damage row is that
   * number rather than a second one nobody can reconcile with it.
   */
  readonly weaponPower: number;
  /** Multiplier on poise damage this body's *abilities* deal. 0 is none. */
  readonly abilityPoiseFactor: number;
  /** Damage multiplier against a staggered target under `executeBelow` health. */
  readonly executeBonus: number;
  readonly executeBelow: number;
  /** Resource restored by a kill that overkilled by 25% or more. */
  readonly overkillResource: number;
  /** Ticks the window after a break lasts, and how far it cuts the next wind-up. */
  readonly momentumTicks: number;
  readonly momentumWindupScale: number;
  /** Multiplier on the wind-up of a heavy ability. Strength's Heavy Handling. */
  readonly heavyWindupScale: number;

  // --- Agility: animation, not cadence -----------------------------------
  /**
   * Multiplier on a basic attack's wind-up. **Never touches `intervalTicks`** --
   * that is the property the whole Agility design rests on and it is asserted
   * directly in `attack-timing` tests.
   */
  readonly attackPointScale: number;
  /** Multiplier on a basic attack's backswing. Same rule. */
  readonly backswingScale: number;
  /** Multiplier on the wind-up of an ability that launches a projectile. */
  readonly handlingScale: number;
  /** `handlingScale` also shortens projectile cooldowns, when 1. */
  readonly handlingCooldowns: number;
  /** Ticks a `flow` stack lives for. 0 means this body cannot gain flow. */
  readonly flowTicks: number;
  /**
   * What one Flow stack is worth: follow-through, cost, damage reduction and
   * weak-point chance.
   *
   * Deliberately **not** move speed, though the fantasy wants it to be. Flow is
   * a status and statuses are not replicated, so a body moving 15% faster than
   * its replicated `moveSpeed` would diverge from its own client's prediction on
   * every tick it held a stack -- a correction per tick for the one build most
   * likely to notice. Agility's raw speed lives on `moveSpeed`, which *is*
   * replicated and *is* predicted; Flow is about recovery and offence.
   */
  readonly flowBackswingPct: number;
  readonly flowCostPct: number;
  readonly flowArmorPct: number;
  readonly flowWeakPoint: number;
  /** A backswing cancel makes the next non-basic cast use `handlingScale`. */
  readonly spellbladeHandling: number;
  /** Perfect Exit: resource returned, and how soon after a hit it must happen. */
  readonly perfectExitResource: number;
  readonly perfectExitWindowTicks: number;

  // --- Intelligence: shaping and manipulation ----------------------------
  readonly spellRadiusPct: number;
  readonly spellRangePct: number;
  /** Cost premium the shaping above costs, before Efficient Construction. */
  readonly shapingCostPct: number;
  /** Fraction of that premium removed. Clamped so it can only ever cancel it. */
  readonly shapingCostRelief: number;
  /** Ticks of stillness that grant `prepared`. 0 means this body never does. */
  readonly prepareTicks: number;
  /** Multiplier on a prepared cast's wind-up. */
  readonly preparedWindupScale: number;
  /** `prepared` also waives the shaping premium and refunds cooldown, when 1. */
  readonly preparedMastery: number;
  /** Extra damage against a target carrying any status. */
  readonly vsAfflictedPct: number;
  /** This body's blows apply `sundered` (armour down) when 1. */
  readonly appliesSundered: number;
  /** Health per point of missing resource an overflow cast may pay. 0 refuses. */
  readonly overflowHealthPerResource: number;
  /** Fraction of ability damage dealt that becomes shield. */
  readonly damageToShield: number;

  // --- Constitution: absorption ------------------------------------------
  readonly maxPoise: number;
  /** Poise regained per tick. */
  readonly poiseRegen: number;
  /** Multiplier on poise regen while not casting. */
  readonly poiseRegenCalm: number;
  /** Fraction of poise regen that still applies while staggered. */
  readonly poiseRegenStaggered: number;
  /** Poise regenerates while moving, when 1. */
  readonly poiseRegenMoving: number;
  /** Health fraction that triggers Second Wind, and what it restores. */
  readonly secondWindBelow: number;
  readonly secondWindHeal: number;
  /** Health fraction below which `resolute` applies, and what it grants. */
  readonly resoluteBelow: number;
  readonly resoluteReduction: number;
  /** Overheal becomes shield, up to `maxShield`, for this many ticks. 0 is off. */
  readonly overhealShieldTicks: number;
  readonly maxShield: number;

  // --- Perception: information and precision ------------------------------
  readonly weakPointChance: number;
  readonly weakPointMultiplier: number;
  /** Ticks `exposed` lasts on a body this one weak-pointed. */
  readonly exposeTicks: number;
  /** Extra damage an `exposed` body takes, contributed by whoever exposed it. */
  readonly exposedDamagePct: number;
  /** Ticks an enemy is `vulnerable` for after committing an attack. 0 is off. */
  readonly openingReadTicks: number;
  /** Weak-point chance multiplier against a `vulnerable` body. 1 is none. */
  readonly vulnerableWeakPointFactor: number;
  /** Extra weak-point payoff after standing still for `steadyAimTicks`. */
  readonly steadyAimPct: number;
  readonly steadyAimTicks: number;
  /** Extra damage and poise a weak point does to an already-`exposed` body. */
  readonly exploitDamagePct: number;
  readonly exploitPoiseFactor: number;
  /** Resource and health-fraction a weak point returns. */
  readonly weakPointResource: number;
  readonly weakPointKillHeal: number;
  /** Abilities may score weak points too, when 1. */
  readonly abilityWeakPoints: number;
  /** Damage reduction taken from a `vulnerable` attacker. */
  readonly vsVulnerableReduction: number;
  /** Anyone hitting a body this one exposed gains this much resource. */
  readonly exposedTeamResource: number;

  // --- Wisdom: economy ----------------------------------------------------
  /** Multiplier on ability cost, floored. */
  readonly resourceCostScale: number;
  /** Multiplier on non-basic cooldowns, floored. */
  readonly cooldownScale: number;
  /** Multiplier on healing received. */
  readonly healingScale: number;
  /** Extra healing multiplier below `healingSurgeBelow` health. */
  readonly healingSurge: number;
  readonly healingSurgeBelow: number;
  /** `attuned`: stacks, life, and the cost each removes. */
  readonly attunedMaxStacks: number;
  readonly attunedTicks: number;
  readonly attunedCostPct: number;
  /** Weak points also grant `attuned`, when 1. */
  readonly attunedFromWeakPoints: number;
  /** `adaptation`: resistance per repeat, its cap, and how long a stack lives. */
  readonly adaptationPerStack: number;
  readonly adaptationCap: number;
  readonly adaptationTicks: number;
  /** Overheal becomes resource 1:1, up to this much per event. 0 is off. */
  readonly conversionCap: number;
  /** Tier-3 stat skills open this many attribute points early. */
  readonly masteryRelief: number;

  // --- the health economy: one route per attribute (spec 154) -------------
  /**
   * Extra restoration progress from an overkill or an execution, as a fraction
   * of the kill's base. Strength's route: a body that dies decisively pays more.
   */
  readonly restoreOverkillPct: number;
  /** The same, from a kill that took no damage. Agility's route. */
  readonly restoreEvasivePct: number;
  /** The same, from a kill made with an ability rather than the weapon. Intelligence's. */
  readonly restoreAbilityKillPct: number;
  /** The same, from a weak-point kill. Perception's. */
  readonly restoreWeakPointPct: number;
  /** Extra world units a mote reaches for its owner from. Perception's, again. */
  readonly moteAttractRadius: number;
  /**
   * The fraction of a restorative's overheal that goes back into the meter,
   * capped per event. Wisdom's route, and the only path in the game from
   * healing to the restoration meter.
   */
  readonly restoreSalvagePct: number;
  /**
   * Fallback flask charges this body may hold. Constitution's route -- more
   * insurance rather than more healing, which is what keeps it from becoming
   * the mandatory stat.
   */
  readonly fallbackCharges: number;
}

/**
 * The order {@link TraitStats} rides the wire in (spec 147).
 *
 * Here rather than in `net/`, beside the interface it describes, so that adding
 * a trait and adding its wire slot are one glance apart. Walked by both the
 * writer and the reader, so the two cannot disagree about the layout; a test
 * asserts it covers every key, so a trait added and forgotten fails CI rather
 * than silently reading as its neighbour's value.
 *
 * **Order is protocol.** Reordering this array is a wire change.
 */
export const TRAIT_WIRE_ORDER: readonly (keyof TraitStats)[] = [
  'staggerPower',
  'staggerTicks',
  'windupPoiseArmor',
  'poiseArmorInBackswing',
  'poiseArmorAllCasts',
  'juggernautBelow',
  'breakResource',
  'breakCooldownRefund',
  'abilityPoiseFactor',
  'executeBonus',
  'executeBelow',
  'overkillResource',
  'weaponPower',
  'momentumTicks',
  'momentumWindupScale',
  'heavyWindupScale',
  'attackPointScale',
  'backswingScale',
  'handlingScale',
  'handlingCooldowns',
  'flowTicks',
  'flowBackswingPct',
  'flowCostPct',
  'flowArmorPct',
  'flowWeakPoint',
  'spellbladeHandling',
  'perfectExitResource',
  'perfectExitWindowTicks',
  'spellRadiusPct',
  'spellRangePct',
  'shapingCostPct',
  'shapingCostRelief',
  'prepareTicks',
  'preparedWindupScale',
  'preparedMastery',
  'vsAfflictedPct',
  'appliesSundered',
  'overflowHealthPerResource',
  'damageToShield',
  'maxPoise',
  'poiseRegen',
  'poiseRegenCalm',
  'poiseRegenStaggered',
  'poiseRegenMoving',
  'secondWindBelow',
  'secondWindHeal',
  'resoluteBelow',
  'resoluteReduction',
  'overhealShieldTicks',
  'maxShield',
  'weakPointChance',
  'weakPointMultiplier',
  'exposeTicks',
  'exposedDamagePct',
  'openingReadTicks',
  'vulnerableWeakPointFactor',
  'steadyAimPct',
  'steadyAimTicks',
  'exploitDamagePct',
  'exploitPoiseFactor',
  'weakPointResource',
  'weakPointKillHeal',
  'abilityWeakPoints',
  'vsVulnerableReduction',
  'exposedTeamResource',
  'resourceCostScale',
  'cooldownScale',
  'healingScale',
  'healingSurge',
  'healingSurgeBelow',
  'attunedMaxStacks',
  'attunedTicks',
  'attunedCostPct',
  'attunedFromWeakPoints',
  'adaptationPerStack',
  'adaptationCap',
  'adaptationTicks',
  'conversionCap',
  'masteryRelief',
  'restoreOverkillPct',
  'restoreEvasivePct',
  'restoreAbilityKillPct',
  'restoreWeakPointPct',
  'moteAttractRadius',
  'restoreSalvagePct',
  'fallbackCharges',
];

/**
 * Stats as the sim and the client actually use them. Computed, broadcast, and
 * never written to the store.
 */
export interface EffectiveStats {
  readonly maxHealth: number;
  /** World units per second. */
  readonly moveSpeed: number;
  /** Degrees per second. */
  readonly turnRate: number;
  readonly attackDamage: number;
  readonly attackRange: number;
  /**
   * Base Attack Time: ticks between one basic attack starting and the next,
   * before attack speed (specs 088, 144).
   *
   * Spec 088 stored the *resolved* interval here and called it
   * `attackDelayTicks`. 144 splits it, because the interval is now a computed
   * thing -- attack speed divides it, and divides the wind-up and the backswing
   * by the same amount -- and a stored copy of a computed number is a second
   * source of truth for exactly the question that must only have one.
   *
   * What a body waits between blows is `resolveAttackTiming(...).intervalTicks`,
   * from `sim/attack-timing.ts`, and nothing else answers it.
   */
  readonly baseAttackTimeTicks: number;
  /**
   * Additive flat attack speed (spec 144). **0 is base, 100 is twice the rate.**
   *
   * Deliberately still zero for every player: spec 091 took the attack cadence
   * off the weapon on purpose and this is not the spec that puts it back. The
   * field is the socket a future item or buff plugs into, and monsters may
   * author it in their rows today.
   */
  readonly attackSpeed: number;
  /** Percent attack-speed multiplier. 1 is none (spec 144). */
  readonly attackSpeedMultiplier: number;
  /** Percent attack-speed slow multiplier. 1 is none (spec 144). */
  readonly attackSpeedSlowMultiplier: number;
  /** Fraction of incoming damage removed, 0..MAX_ARMOR. */
  readonly armor: number;
  /** Multiplier on ability damage. */
  readonly spellPower: number;
  /** Chance a hit crits, 0..1. Rolled server-side against the sim's seeded PRNG. */
  readonly critChance: number;
  /** Pool abilities are paid out of (spec 062). */
  readonly maxResource: number;
  /** Refilled by this much every tick. */
  readonly resourceRegen: number;
  /**
   * The ability this body's auto-attack uses (spec 079), or `''` for something
   * that never attacks.
   *
   * A stat rather than a constant because it is the difference between a
   * swordsman and an archer, and it is derived exactly like every other stat
   * here: from the main hand for a player, from its row for a monster. The sim
   * never needs it -- a cast names its own ability -- but a client does, to know
   * what its right-click reaches with and asks for.
   */
  readonly basicAttackId: string;
  /**
   * Everything the six attributes derive (spec 147). See {@link TraitStats}.
   *
   * Present on every body, monsters included -- a monster gets
   * {@link import('../player/derived.js').DEFAULT_TRAITS} with its poise sized
   * off its own health, so "can this be staggered" is answered the same way for
   * everything in the world rather than by a null check.
   */
  readonly traits: TraitStats;
}

export interface Ban {
  readonly playerId: string;
  /** Epoch ms the ban lifts; Infinity for permanent. */
  readonly until: number;
  readonly reason: string;
  readonly issuedBy: string;
}

export interface Mute {
  readonly playerId: string;
  readonly until: number;
  readonly issuedBy: string;
}

/** One line of the admin accountability log: who, what, when. */
export interface AuditEntry {
  readonly at: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly detail: string;
  readonly accepted: boolean;
}
