import type { Rng } from '../shared/prng.js';
import type { SpellSpec } from '../shared/spell-spec.js';

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface DamageBuff {
  readonly amount: number;
  readonly expiresAtTick: number;
}

/** A burning aura the player carries (spec 018): pulses damage to nearby enemies. */
export interface AuraState {
  readonly radius: number;
  readonly pulseDamage: number;
  readonly pulseIntervalTicks: number;
  readonly nextPulseTick: number;
  readonly expiresAtTick: number;
}

/** A telegraphed point blast (meteor, bury feet, blaze explosions) that lands later. */
export interface PendingAoe {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly damage: number;
  readonly stunTicks: number;
  readonly impactTick: number;
}

/** A stationary burning patch (Basking Path trail, spec 019) that pulses until it expires. */
export interface GroundFire {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly pulseDamage: number;
  readonly pulseIntervalTicks: number;
  readonly nextPulseTick: number;
  readonly expiresAtTick: number;
}

/** Fire trail a dash leaves behind while travelling (Basking Path); null for a plain dash. */
export interface DashTrail {
  readonly radius: number;
  readonly pulseDamage: number;
  readonly pulseIntervalTicks: number;
  readonly durationTicks: number;
}

/** Burning Speed's end-of-effect payload (spec 022): burns foes near the player when it expires. */
export interface BurnBurst {
  readonly atTick: number;
  readonly radius: number;
  readonly dps: number;
  readonly durationTicks: number;
}

export interface PlayerState {
  readonly health: number;
  readonly maxHealth: number;
  readonly mana: number;
  readonly maxMana: number;
  readonly position: Vec2;
  readonly attackCooldownUntil: number;
  /** Movement input is ignored until this tick (attack commitment). */
  readonly moveLockUntil: number;
  /** Tick a pending swing resolves; 0 when no swing is winding up. */
  readonly attackReleaseTick: number;
  /** Aim direction captured when the current swing began. */
  readonly attackAimX: number;
  readonly attackAimY: number;
  readonly defenseLockUntil: number;
  /** Count of swings the player has committed; drives every-Nth-strike passives. */
  readonly strikeCount: number;
  readonly damageBuffs: readonly DamageBuff[];
  // --- Poker-combo stance (spec 014); identity values (0) leave combat untouched. ---
  /** Tick the activated stance expires; 0 when no stance is held. */
  readonly stanceExpiresAtTick: number;
  readonly stanceAttackBonus: number;
  readonly stanceReductionPct: number;
  readonly stanceRegenPerTick: number;
  /** Brief damage-reduction window from a played spade; 0 when none. */
  readonly guardExpiresAtTick: number;
  readonly guardReductionPct: number;
  /** Activate is refused until this tick (stance lockout). */
  readonly activateLockUntil: number;
  // --- Spell cards (spec 018); identity values leave combat untouched. ---
  /** Rocky Raise shield: damage it can still absorb, and the tick it expires. */
  readonly shieldAmount: number;
  readonly shieldExpiresAtTick: number;
  /** Blaze Aura DOT fields the player carries. */
  readonly auras: readonly AuraState[];
  /** Telegraphed blasts awaiting their impact tick. */
  readonly pendingAoes: readonly PendingAoe[];
  /** Dash velocity per tick and the tick the dash ends; movement input is ignored while dashing. */
  readonly dashDx: number;
  readonly dashDy: number;
  readonly dashExpiresAtTick: number;
  /** Damage a damaging dash deals to each body it passes through (0 = harmless dash). */
  readonly dashDamage: number;
  /** Enemy ids already struck by the current dash, so each is hit at most once. */
  readonly dashHitIds: readonly number[];
  /** Fire trail dropped while dashing (Basking Path); null for a plain dash. */
  readonly dashTrail: DashTrail | null;
  /** Stationary burning patches currently on the ground. */
  readonly groundFires: readonly GroundFire[];
  /** Conjure Flame: remaining cone casts that get bonus fire damage, and the bonus. */
  readonly attackFlameCharges: number;
  readonly attackFlameBonus: number;
  /** Mis-timed window punishment (spec 021): walking is slowed until this tick. */
  readonly moveSlowUntilTick: number;
  // --- Burning Speed (spec 022); identity values leave movement/health untouched. ---
  /** Haste from Burning Speed: walk-speed multiplier and the tick it expires. */
  readonly moveHasteUntilTick: number;
  readonly moveHasteMult: number;
  /** Self-Burning drain (hp/second) the player suffers, and the tick it ends. */
  readonly burningUntilTick: number;
  readonly burningDps: number;
  /** Burn foes near the player when Burning Speed ends; null when none pending. */
  readonly pendingBurnBurst: BurnBurst | null;
}

/**
 * Aggregate mechanic modifiers, computed by the game layer from the passive
 * cards the player is holding and passed into the sim each tick. Identity
 * values leave every mechanic untouched.
 */
export interface Modifiers {
  readonly attackDamageBonus: number;
  readonly nthStrikeEveryN: number; // 0 = no every-Nth-strike bonus
  readonly nthStrikeBonusFraction: number;
  readonly healthRegenPerTick: number;
  readonly manaRegenPerTick: number;
  readonly healOnHurt: number;
  readonly enemySpeedMultiplier: number; // <1 = enemy acts faster
  readonly enemyDamageMultiplier: number;
}

export const IDENTITY_MODIFIERS: Modifiers = {
  attackDamageBonus: 0,
  nthStrikeEveryN: 0,
  nthStrikeBonusFraction: 0,
  healthRegenPerTick: 0,
  manaRegenPerTick: 0,
  healOnHurt: 0,
  enemySpeedMultiplier: 1,
  enemyDamageMultiplier: 1,
};

export type EnemyPhase = 'idle' | 'windup' | 'recovery';
export type DefenseOutcome = 'none' | 'perfect' | 'normal' | 'whiffed';
/**
 * grazing: passive, wanders to random graze spots, ignores the player.
 * hunting: entered once the enemy takes player damage; homes and attacks.
 */
export type EnemyBehavior = 'grazing' | 'hunting';

export interface EnemyState {
  /** Stable identity for the renderer's sprite pool. */
  readonly id: number;
  /** Key into ENEMY_TYPES; also the sprite seed. */
  readonly type: string;
  readonly health: number;
  readonly maxHealth: number;
  /** Per-enemy attack damage override (wave scaling); falls back to the type's. */
  readonly attackDamage?: number;
  /** Per-enemy homing-speed multiplier (wave scaling); defaults to 1 when absent. */
  readonly speedMult?: number;
  /** Per-enemy attack-cadence multiplier (wave scaling); higher = faster attacks; defaults to 1. */
  readonly attackSpeedMult?: number;
  readonly position: Vec2;
  readonly behavior: EnemyBehavior;
  // --- hunting cadence (meaningful only while hunting) ---
  readonly phase: EnemyPhase;
  readonly phaseEndsAtTick: number;
  readonly incomingAttackOutcome: DefenseOutcome;
  /**
   * Unit direction of the attack cone, captured at wind-up start; the cone's
   * apex is the enemy's own (planted) position. Null when not winding up.
   */
  readonly attackAim: Vec2 | null;
  // --- grazing (meaningful only while grazing) ---
  /** Current wander destination; null while standing and "eating". */
  readonly grazeTarget: Vec2 | null;
  /** Tick at which a standing grazer picks its next target. */
  readonly grazeResumeTick: number;
  /** Bury-Feet stun: while `tick < stunnedUntilTick` the enemy neither moves nor attacks. Absent = 0. */
  readonly stunnedUntilTick?: number;
  /** Burning condition (spec 022): loses `burningDps` hp/second until this tick. Absent = not burning. */
  readonly burningUntilTick?: number;
  readonly burningDps?: number;
}

export interface CombatState {
  readonly tick: number;
  readonly player: PlayerState;
  readonly enemies: readonly EnemyState[];
  /** Monotonic id source for spawned enemies. */
  readonly nextEnemyId: number;
  /** Next tick the spawner may add an enemy (when below the cap). */
  readonly nextSpawnTick: number;
  /** When false, the ambient spawner is off (wave mode drives spawns instead). */
  readonly ambientSpawner: boolean;
  /** Count of waves spawned so far (spec 014); 0 before the first wave. */
  readonly waveNumber: number;
  /** Global enemy slow: tick it expires and its speed/telegraph multiplier (<1 = slower). */
  readonly enemySlowExpiresAtTick: number;
  readonly enemySlowMultiplier: number;
  /** True once the player is defeated; the sim then freezes. */
  readonly over: boolean;
  readonly rng: Rng;
}

export type ExternalEffect =
  | { readonly kind: 'damageEnemy'; readonly manaCost: number; readonly amount: number }
  | { readonly kind: 'healPlayer'; readonly manaCost: number; readonly amount: number }
  | {
      readonly kind: 'buffPlayerDamage';
      readonly manaCost: number;
      readonly amount: number;
      readonly durationTicks: number;
    }
  // --- Poker-combo prototype effects (spec 014); no mana, resolved by the game layer. ---
  | { readonly kind: 'guard'; readonly reductionPct: number; readonly durationTicks: number }
  | { readonly kind: 'slowEnemies'; readonly multiplier: number; readonly durationTicks: number }
  | {
      readonly kind: 'applyStance';
      readonly attackBonus: number;
      readonly reductionPct: number;
      readonly regenPerTick: number;
      readonly slowMultiplier: number;
      readonly durationTicks: number;
      readonly lockoutTicks: number;
    }
  // --- Spell cards (spec 018): a window's worth of resolved geometry, cast at once. ---
  | {
      readonly kind: 'castSpells';
      readonly spells: readonly SpellSpec[];
      /** Aim direction for cones/rects/dashes; need not be normalized. */
      readonly aimX: number;
      readonly aimY: number;
      /** World point for target-origin AOEs (meteor, bury feet). */
      readonly targetX: number;
      readonly targetY: number;
      /** Slow the player's walk for this many ticks (mis-timed window); 0/absent = none. */
      readonly playerSlowTicks?: number;
    };

export interface InputFrame {
  readonly moveX: -1 | 0 | 1;
  readonly moveY: -1 | 0 | 1;
  readonly attack: boolean;
  /** Aim direction for the attack cone; need not be normalized. */
  readonly aimX: number;
  readonly aimY: number;
  readonly parry: boolean;
  readonly dodge: boolean;
  readonly externalEffect?: ExternalEffect;
  /** Spawn the next escalating wave of enemies this tick (spec 014). */
  readonly spawnWave?: boolean;
}

export const NEUTRAL_INPUT: InputFrame = {
  moveX: 0,
  moveY: 0,
  attack: false,
  aimX: 1,
  aimY: 0,
  parry: false,
  dodge: false,
};

export type DefenseType = 'parry' | 'dodge';

export type SimEvent =
  | { readonly kind: 'perfectDefense'; readonly defenseType: DefenseType; readonly tick: number }
  | { readonly kind: 'normalDefense'; readonly defenseType: DefenseType; readonly tick: number }
  | { readonly kind: 'playerHit'; readonly damage: number; readonly tick: number }
  | { readonly kind: 'playerHealed'; readonly amount: number; readonly tick: number }
  | { readonly kind: 'enemyHit'; readonly damage: number; readonly tick: number; readonly enemyId: number; readonly at: Vec2 }
  | { readonly kind: 'attackMissed'; readonly tick: number }
  | { readonly kind: 'enemyAttackAvoided'; readonly tick: number }
  | { readonly kind: 'effectRejectedInsufficientMana'; readonly tick: number }
  | { readonly kind: 'enemyDefeated'; readonly tick: number; readonly enemyId: number; readonly enemyType: string }
  | { readonly kind: 'playerDefeated'; readonly tick: number }
  | { readonly kind: 'stanceApplied'; readonly tick: number }
  | { readonly kind: 'stanceRejectedLocked'; readonly tick: number }
  // --- Spell cards (spec 018) ---
  | { readonly kind: 'spellCast'; readonly tick: number; readonly spellCount: number }
  | { readonly kind: 'aoeImpact'; readonly tick: number; readonly at: Vec2; readonly radius: number }
  | { readonly kind: 'dashPerformed'; readonly tick: number }
  | { readonly kind: 'playerSlowed'; readonly tick: number; readonly durationTicks: number }
  | { readonly kind: 'waveSpawned'; readonly tick: number; readonly waveNumber: number; readonly count: number };
