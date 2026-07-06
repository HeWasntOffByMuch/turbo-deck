import { Rng } from '../shared/prng.js';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  ATTACK_ARC_COS_SQ,
  ATTACK_ROOT_TICKS,
  DEFENSE_RECOVERY_TICKS,
  DIAGONAL_SCALE,
  ENEMY_ATTACK_DAMAGE,
  ENEMY_ATTACK_RADIUS,
  ENEMY_IDLE_TICKS,
  ENEMY_MAX_HEALTH,
  ENEMY_MOVE_SPEED_PER_TICK,
  ENEMY_RADIUS,
  ENEMY_RECOVERY_TICKS,
  ENEMY_STANDOFF,
  ENEMY_WINDUP_TICKS,
  MANA_REGEN_PER_TICK,
  MOVE_SPEED_PER_TICK,
  NORMAL_WINDOW_TICKS,
  PERFECT_WINDOW_TICKS,
  PLAYER_ATTACK_COOLDOWN_TICKS,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_ATTACK_RANGE,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_MANA,
  PLAYER_RADIUS,
} from './constants.js';
import {
  IDENTITY_MODIFIERS,
  type CombatState,
  type DamageBuff,
  type DefenseOutcome,
  type DefenseType,
  type EnemyState,
  type InputFrame,
  type Modifiers,
  type PlayerState,
  type SimEvent,
  type Vec2,
} from './types.js';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distanceSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function activeDamageBuffTotal(buffs: readonly DamageBuff[], tick: number): number {
  return buffs.reduce((sum, buff) => (buff.expiresAtTick > tick ? sum + buff.amount : sum), 0);
}

/** Move the player by an 8-directional input, normalizing diagonals, clamped to the arena. */
function movePlayer(position: Vec2, moveX: number, moveY: number): Vec2 {
  const scale = moveX !== 0 && moveY !== 0 ? DIAGONAL_SCALE : 1;
  const x = clamp(position.x + moveX * MOVE_SPEED_PER_TICK * scale, PLAYER_RADIUS, ARENA_WIDTH - PLAYER_RADIUS);
  const y = clamp(position.y + moveY * MOVE_SPEED_PER_TICK * scale, PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS);
  return { x, y };
}

/** Enemy homes toward the player, stopping at the standoff distance, clamped to the arena. */
function moveEnemyToward(position: Vec2, target: Vec2): Vec2 {
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const distSq = dx * dx + dy * dy;
  const standoffSq = ENEMY_STANDOFF * ENEMY_STANDOFF;
  if (distSq <= standoffSq) return position;
  const dist = Math.sqrt(distSq);
  const step = Math.min(ENEMY_MOVE_SPEED_PER_TICK, dist - ENEMY_STANDOFF);
  const x = clamp(position.x + (dx / dist) * step, ENEMY_RADIUS, ARENA_WIDTH - ENEMY_RADIUS);
  const y = clamp(position.y + (dy / dist) * step, ENEMY_RADIUS, ARENA_HEIGHT - ENEMY_RADIUS);
  return { x, y };
}

/** True if the enemy is within reach and inside the aim cone (pure dot-product, no trig). */
function attackConnects(player: Vec2, enemy: Vec2, aimX: number, aimY: number): boolean {
  const dx = enemy.x - player.x;
  const dy = enemy.y - player.y;
  const lenSqD = dx * dx + dy * dy;
  const reach = PLAYER_ATTACK_RANGE + ENEMY_RADIUS;
  if (lenSqD > reach * reach) return false;
  const dot = dx * aimX + dy * aimY;
  if (dot <= 0) return false;
  const lenSqAim = aimX * aimX + aimY * aimY;
  return dot * dot >= ATTACK_ARC_COS_SQ * lenSqD * lenSqAim;
}

export function initCombat(seed: number): CombatState {
  return {
    tick: 0,
    player: {
      health: PLAYER_MAX_HEALTH,
      maxHealth: PLAYER_MAX_HEALTH,
      mana: PLAYER_MAX_MANA,
      maxMana: PLAYER_MAX_MANA,
      position: { x: ARENA_WIDTH * 0.35, y: ARENA_HEIGHT * 0.5 },
      attackCooldownUntil: 0,
      moveLockUntil: 0,
      defenseLockUntil: 0,
      strikeCount: 0,
      damageBuffs: [],
    },
    enemy: {
      health: ENEMY_MAX_HEALTH,
      maxHealth: ENEMY_MAX_HEALTH,
      position: { x: ARENA_WIDTH * 0.7, y: ARENA_HEIGHT * 0.5 },
      phase: 'idle',
      phaseEndsAtTick: ENEMY_IDLE_TICKS,
      incomingAttackOutcome: 'none',
      attackZoneCenter: null,
    },
    rng: Rng.fromSeed(seed),
  };
}

export function step(
  state: CombatState,
  input: InputFrame,
  mods: Modifiers = IDENTITY_MODIFIERS,
): { state: CombatState; events: SimEvent[] } {
  const tick = state.tick + 1;
  const events: SimEvent[] = [];

  // Decide the attack before moving so a swing roots the player this same tick.
  const willAttack = input.attack && tick >= state.player.attackCooldownUntil;
  const rooted = willAttack || tick < state.player.moveLockUntil;

  let player: PlayerState = {
    ...state.player,
    position: rooted ? state.player.position : movePlayer(state.player.position, input.moveX, input.moveY),
  };
  let enemy: EnemyState = state.enemy;

  // Enemy homes toward the player only while idle; it plants for windup and recovery.
  if (enemy.phase === 'idle') {
    enemy = { ...enemy, position: moveEnemyToward(enemy.position, player.position) };
  }

  // Player attack: aimed, connects only within reach and the aim cone.
  if (willAttack) {
    const strikeCount = player.strikeCount + 1;
    player = {
      ...player,
      attackCooldownUntil: tick + PLAYER_ATTACK_COOLDOWN_TICKS,
      moveLockUntil: tick + ATTACK_ROOT_TICKS,
      strikeCount,
    };
    if (attackConnects(player.position, enemy.position, input.aimX, input.aimY)) {
      const wasAlive = enemy.health > 0;
      let damage = PLAYER_ATTACK_DAMAGE + activeDamageBuffTotal(player.damageBuffs, tick) + mods.attackDamageBonus;
      if (mods.nthStrikeEveryN > 0 && strikeCount % mods.nthStrikeEveryN === 0) {
        damage = Math.round(damage * (1 + mods.nthStrikeBonusFraction));
      }
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

  // Enemy state machine. Passive modifiers scale its cadence and hit damage.
  const scaleDuration = (base: number): number => Math.max(1, Math.round(base * mods.enemySpeedMultiplier));
  if (tick >= enemy.phaseEndsAtTick) {
    if (enemy.phase === 'idle') {
      // Snapshot the danger zone at the player's current position and telegraph it.
      enemy = {
        ...enemy,
        phase: 'windup',
        phaseEndsAtTick: tick + scaleDuration(ENEMY_WINDUP_TICKS),
        incomingAttackOutcome: 'none',
        attackZoneCenter: player.position,
      };
    } else if (enemy.phase === 'windup') {
      const outcome = enemy.incomingAttackOutcome;
      const zone = enemy.attackZoneCenter;
      const inZone = zone !== null && distanceSq(player.position, zone) <= ENEMY_ATTACK_RADIUS * ENEMY_ATTACK_RADIUS;
      const fullDamage = Math.round(ENEMY_ATTACK_DAMAGE * mods.enemyDamageMultiplier);
      const baseDamage = inZone ? fullDamage : 0;
      const damage = outcome === 'perfect' ? 0 : outcome === 'normal' ? Math.round(baseDamage / 2) : baseDamage;
      if (damage > 0) {
        const wasAlive = player.health > 0;
        const health = Math.max(0, player.health - damage);
        player = { ...player, health };
        events.push({ kind: 'playerHit', damage, tick });
        if (wasAlive && health <= 0) {
          events.push({ kind: 'playerDefeated', tick });
        } else if (mods.healOnHurt > 0) {
          // Heal-on-hurt passive: recover after surviving a hit.
          const healed = Math.min(player.maxHealth, player.health + mods.healOnHurt);
          player = { ...player, health: healed };
          events.push({ kind: 'playerHealed', amount: healed - health, tick });
        }
      } else if (!inZone && outcome !== 'perfect' && outcome !== 'normal') {
        // The player stepped out of the telegraphed area entirely.
        events.push({ kind: 'enemyAttackAvoided', tick });
      }
      enemy = {
        ...enemy,
        phase: 'recovery',
        phaseEndsAtTick: tick + scaleDuration(ENEMY_RECOVERY_TICKS),
        incomingAttackOutcome: 'none',
        attackZoneCenter: null,
      };
    } else {
      enemy = { ...enemy, phase: 'idle', phaseEndsAtTick: tick + scaleDuration(ENEMY_IDLE_TICKS) };
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

  // Mana + health regen (passives add to the base) and buff expiry.
  player = {
    ...player,
    health: Math.min(player.maxHealth, player.health + mods.healthRegenPerTick),
    mana: Math.min(player.maxMana, player.mana + MANA_REGEN_PER_TICK + mods.manaRegenPerTick),
    damageBuffs: player.damageBuffs.filter((buff) => buff.expiresAtTick > tick),
  };

  return { state: { tick, player, enemy, rng: state.rng }, events };
}

export function runSim(
  seed: number,
  inputs: readonly InputFrame[],
  mods: Modifiers = IDENTITY_MODIFIERS,
): { state: CombatState; events: SimEvent[] } {
  let state = initCombat(seed);
  const events: SimEvent[] = [];
  for (const input of inputs) {
    const result = step(state, input, mods);
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}
