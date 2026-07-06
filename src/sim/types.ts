import type { Rng } from '../shared/prng.js';

export interface DamageBuff {
  readonly amount: number;
  readonly expiresAtTick: number;
}

export interface PlayerState {
  readonly health: number;
  readonly maxHealth: number;
  readonly mana: number;
  readonly maxMana: number;
  readonly position: number;
  readonly attackCooldownUntil: number;
  readonly defenseLockUntil: number;
  readonly damageBuffs: readonly DamageBuff[];
}

export type EnemyPhase = 'idle' | 'windup' | 'recovery';
export type DefenseOutcome = 'none' | 'perfect' | 'normal' | 'whiffed';

export interface EnemyState {
  readonly health: number;
  readonly maxHealth: number;
  readonly position: number;
  readonly phase: EnemyPhase;
  readonly phaseEndsAtTick: number;
  readonly incomingAttackOutcome: DefenseOutcome;
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
  readonly moveDir: -1 | 0 | 1;
  readonly attack: boolean;
  readonly parry: boolean;
  readonly dodge: boolean;
  readonly externalEffect?: ExternalEffect;
}

export const NEUTRAL_INPUT: InputFrame = { moveDir: 0, attack: false, parry: false, dodge: false };

export type DefenseType = 'parry' | 'dodge';

export type SimEvent =
  | { readonly kind: 'perfectDefense'; readonly defenseType: DefenseType; readonly tick: number }
  | { readonly kind: 'normalDefense'; readonly defenseType: DefenseType; readonly tick: number }
  | { readonly kind: 'playerHit'; readonly damage: number; readonly tick: number }
  | { readonly kind: 'enemyHit'; readonly damage: number; readonly tick: number }
  | { readonly kind: 'attackMissed'; readonly tick: number }
  | { readonly kind: 'effectRejectedInsufficientMana'; readonly tick: number }
  | { readonly kind: 'enemyDefeated'; readonly tick: number }
  | { readonly kind: 'playerDefeated'; readonly tick: number };
