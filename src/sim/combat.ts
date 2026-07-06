import { Rng } from '../shared/prng.js';
import {
  ARENA_MAX,
  ARENA_MIN,
  ATTACK_RANGE,
  DEFENSE_RECOVERY_TICKS,
  ENEMY_ATTACK_DAMAGE,
  ENEMY_IDLE_TICKS,
  ENEMY_MAX_HEALTH,
  ENEMY_RECOVERY_TICKS,
  ENEMY_WINDUP_TICKS,
  MANA_REGEN_PER_TICK,
  MOVE_SPEED_PER_TICK,
  NORMAL_WINDOW_TICKS,
  PERFECT_WINDOW_TICKS,
  PLAYER_ATTACK_COOLDOWN_TICKS,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_MANA,
} from './constants.js';
import type {
  CombatState,
  DamageBuff,
  DefenseOutcome,
  DefenseType,
  EnemyState,
  InputFrame,
  PlayerState,
  SimEvent,
} from './types.js';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function activeDamageBuffTotal(buffs: readonly DamageBuff[], tick: number): number {
  return buffs.reduce((sum, buff) => (buff.expiresAtTick > tick ? sum + buff.amount : sum), 0);
}

export function initCombat(seed: number): CombatState {
  const span = ARENA_MAX - ARENA_MIN;
  return {
    tick: 0,
    player: {
      health: PLAYER_MAX_HEALTH,
      maxHealth: PLAYER_MAX_HEALTH,
      mana: PLAYER_MAX_MANA,
      maxMana: PLAYER_MAX_MANA,
      position: ARENA_MIN + span * 0.3,
      attackCooldownUntil: 0,
      defenseLockUntil: 0,
      damageBuffs: [],
    },
    enemy: {
      health: ENEMY_MAX_HEALTH,
      maxHealth: ENEMY_MAX_HEALTH,
      position: ARENA_MIN + span * 0.7,
      phase: 'idle',
      phaseEndsAtTick: ENEMY_IDLE_TICKS,
      incomingAttackOutcome: 'none',
    },
    rng: Rng.fromSeed(seed),
  };
}

export function step(state: CombatState, input: InputFrame): { state: CombatState; events: SimEvent[] } {
  const tick = state.tick + 1;
  const events: SimEvent[] = [];

  let player: PlayerState = {
    ...state.player,
    position: clamp(state.player.position + input.moveDir * MOVE_SPEED_PER_TICK, ARENA_MIN, ARENA_MAX),
  };
  let enemy: EnemyState = state.enemy;

  // Player attack.
  if (input.attack && tick >= player.attackCooldownUntil) {
    player = { ...player, attackCooldownUntil: tick + PLAYER_ATTACK_COOLDOWN_TICKS };
    const distance = Math.abs(player.position - enemy.position);
    if (distance <= ATTACK_RANGE) {
      const wasAlive = enemy.health > 0;
      const damage = PLAYER_ATTACK_DAMAGE + activeDamageBuffTotal(player.damageBuffs, tick);
      enemy = { ...enemy, health: Math.max(0, enemy.health - damage) };
      events.push({ kind: 'enemyHit', damage, tick });
      if (wasAlive && enemy.health <= 0) events.push({ kind: 'enemyDefeated', tick });
    } else {
      events.push({ kind: 'attackMissed', tick });
    }
  }

  // Defend input: register at most once per incoming attack, timed against its fixed hit tick.
  if (
    (input.parry || input.dodge) &&
    tick >= player.defenseLockUntil &&
    enemy.phase === 'windup' &&
    enemy.incomingAttackOutcome === 'none'
  ) {
    const defenseType: DefenseType = input.parry ? 'parry' : 'dodge';
    const diff = Math.abs(tick - enemy.phaseEndsAtTick);
    const outcome: DefenseOutcome =
      diff <= PERFECT_WINDOW_TICKS ? 'perfect' : diff <= NORMAL_WINDOW_TICKS ? 'normal' : 'whiffed';
    enemy = { ...enemy, incomingAttackOutcome: outcome };
    player = { ...player, defenseLockUntil: tick + DEFENSE_RECOVERY_TICKS };
    if (outcome === 'perfect') events.push({ kind: 'perfectDefense', defenseType, tick });
    else if (outcome === 'normal') events.push({ kind: 'normalDefense', defenseType, tick });
  }

  // Enemy state machine.
  if (tick >= enemy.phaseEndsAtTick) {
    if (enemy.phase === 'idle') {
      enemy = { ...enemy, phase: 'windup', phaseEndsAtTick: tick + ENEMY_WINDUP_TICKS, incomingAttackOutcome: 'none' };
    } else if (enemy.phase === 'windup') {
      const outcome = enemy.incomingAttackOutcome;
      const damage = outcome === 'perfect' ? 0 : outcome === 'normal' ? Math.round(ENEMY_ATTACK_DAMAGE / 2) : ENEMY_ATTACK_DAMAGE;
      if (damage > 0) {
        const wasAlive = player.health > 0;
        const health = Math.max(0, player.health - damage);
        player = { ...player, health };
        events.push({ kind: 'playerHit', damage, tick });
        if (wasAlive && health <= 0) events.push({ kind: 'playerDefeated', tick });
      }
      enemy = { ...enemy, phase: 'recovery', phaseEndsAtTick: tick + ENEMY_RECOVERY_TICKS, incomingAttackOutcome: 'none' };
    } else {
      enemy = { ...enemy, phase: 'idle', phaseEndsAtTick: tick + ENEMY_IDLE_TICKS };
    }
  }

  // External effect (integration's hook for a played card).
  if (input.externalEffect) {
    const effect = input.externalEffect;
    if (player.mana < effect.manaCost) {
      events.push({ kind: 'effectRejectedInsufficientMana', tick });
    } else {
      const mana = player.mana - effect.manaCost;
      if (effect.kind === 'damageEnemy') {
        const wasAlive = enemy.health > 0;
        const health = Math.max(0, enemy.health - effect.amount);
        enemy = { ...enemy, health };
        player = { ...player, mana };
        events.push({ kind: 'enemyHit', damage: effect.amount, tick });
        if (wasAlive && health <= 0) events.push({ kind: 'enemyDefeated', tick });
      } else if (effect.kind === 'healPlayer') {
        const health = Math.min(player.maxHealth, player.health + effect.amount);
        player = { ...player, mana, health };
      } else {
        const damageBuffs = [...player.damageBuffs, { amount: effect.amount, expiresAtTick: tick + effect.durationTicks }];
        player = { ...player, mana, damageBuffs };
      }
    }
  }

  // Mana regen + buff expiry.
  player = {
    ...player,
    mana: Math.min(player.maxMana, player.mana + MANA_REGEN_PER_TICK),
    damageBuffs: player.damageBuffs.filter((buff) => buff.expiresAtTick > tick),
  };

  return { state: { tick, player, enemy, rng: state.rng }, events };
}

export function runSim(
  seed: number,
  inputs: readonly InputFrame[],
): { state: CombatState; events: SimEvent[] } {
  let state = initCombat(seed);
  const events: SimEvent[] = [];
  for (const input of inputs) {
    const result = step(state, input);
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}
