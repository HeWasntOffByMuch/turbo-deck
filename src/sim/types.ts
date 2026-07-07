import type { Rng } from '../shared/prng.js';

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface DamageBuff {
  readonly amount: number;
  readonly expiresAtTick: number;
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
  readonly position: Vec2;
  readonly behavior: EnemyBehavior;
  // --- hunting cadence (meaningful only while hunting) ---
  readonly phase: EnemyPhase;
  readonly phaseEndsAtTick: number;
  readonly incomingAttackOutcome: DefenseOutcome;
  /** Centre of the telegraphed danger zone during windup; null otherwise. */
  readonly attackZoneCenter: Vec2 | null;
  // --- grazing (meaningful only while grazing) ---
  /** Current wander destination; null while standing and "eating". */
  readonly grazeTarget: Vec2 | null;
  /** Tick at which a standing grazer picks its next target. */
  readonly grazeResumeTick: number;
}

export interface CombatState {
  readonly tick: number;
  readonly player: PlayerState;
  readonly enemies: readonly EnemyState[];
  /** Monotonic id source for spawned enemies. */
  readonly nextEnemyId: number;
  /** Next tick the spawner may add an enemy (when below the cap). */
  readonly nextSpawnTick: number;
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
  | { readonly kind: 'playerDefeated'; readonly tick: number };
