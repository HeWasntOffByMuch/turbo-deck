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
  readonly defenseLockUntil: number;
  readonly damageBuffs: readonly DamageBuff[];
}

export type EnemyPhase = 'idle' | 'windup' | 'recovery';
export type DefenseOutcome = 'none' | 'perfect' | 'normal' | 'whiffed';

export interface EnemyState {
  readonly health: number;
  readonly maxHealth: number;
  readonly position: Vec2;
  readonly phase: EnemyPhase;
  readonly phaseEndsAtTick: number;
  readonly incomingAttackOutcome: DefenseOutcome;
  /** Centre of the telegraphed danger zone during windup; null otherwise. */
  readonly attackZoneCenter: Vec2 | null;
}

export interface CombatState {
  readonly tick: number;
  readonly player: PlayerState;
  readonly enemy: EnemyState;
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
  | { readonly kind: 'enemyHit'; readonly damage: number; readonly tick: number }
  | { readonly kind: 'attackMissed'; readonly tick: number }
  | { readonly kind: 'enemyAttackAvoided'; readonly tick: number }
  | { readonly kind: 'effectRejectedInsufficientMana'; readonly tick: number }
  | { readonly kind: 'enemyDefeated'; readonly tick: number }
  | { readonly kind: 'playerDefeated'; readonly tick: number };
