import { Rng } from '../shared/prng.js';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  ATTACK_ARC_COS_SQ,
  ATTACK_ROOT_TICKS,
  DEFENSE_RECOVERY_TICKS,
  DIAGONAL_SCALE,
  ENEMY_ATTACK_RADIUS,
  ENEMY_IDLE_TICKS,
  ENEMY_RADIUS,
  ENEMY_RECOVERY_TICKS,
  ENEMY_SPAWN_INTERVAL_TICKS,
  ENEMY_STANDOFF,
  ENEMY_WINDUP_TICKS,
  GRAZE_ARRIVE_EPS_SQ,
  GRAZE_MOVE_SPEED_PER_TICK,
  GRAZE_PAUSE_MAX_TICKS,
  GRAZE_PAUSE_MIN_TICKS,
  GRAZE_WANDER_RADIUS,
  INITIAL_ENEMIES,
  MANA_REGEN_PER_TICK,
  MAX_ENEMIES,
  MOVE_SPEED_PER_TICK,
  NORMAL_WINDOW_TICKS,
  PERFECT_WINDOW_TICKS,
  PLAYER_ATTACK_COOLDOWN_TICKS,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_ATTACK_RANGE,
  PLAYER_ATTACK_WINDUP_TICKS,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_MANA,
  PLAYER_RADIUS,
  SPAWN_MIN_PLAYER_DIST,
} from './constants.js';
import { ENEMY_TYPES, enemyTypeByKey, type EnemyType } from './enemies.js';
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

/** Advances an immutable Rng through a closure so draws read as plain calls. */
type Draw = (minInclusive: number, maxInclusive: number) => number;

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

const clampToArena = (x: number, y: number): Vec2 => ({
  x: clamp(x, ENEMY_RADIUS, ARENA_WIDTH - ENEMY_RADIUS),
  y: clamp(y, ENEMY_RADIUS, ARENA_HEIGHT - ENEMY_RADIUS),
});

/** Move the player by an 8-directional input, normalizing diagonals, clamped to the arena. */
function movePlayer(position: Vec2, moveX: number, moveY: number): Vec2 {
  const scale = moveX !== 0 && moveY !== 0 ? DIAGONAL_SCALE : 1;
  const x = clamp(position.x + moveX * MOVE_SPEED_PER_TICK * scale, PLAYER_RADIUS, ARENA_WIDTH - PLAYER_RADIUS);
  const y = clamp(position.y + moveY * MOVE_SPEED_PER_TICK * scale, PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS);
  return { x, y };
}

/** Step `position` toward `target` at `speed`, stopping `stopDist` short, clamped to the arena. */
function moveToward(position: Vec2, target: Vec2, speed: number, stopDist: number): Vec2 {
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const distSq = dx * dx + dy * dy;
  if (distSq <= stopDist * stopDist) return position;
  const dist = Math.sqrt(distSq);
  const step = Math.min(speed, dist - stopDist);
  return clampToArena(position.x + (dx / dist) * step, position.y + (dy / dist) * step);
}

/** True if `enemy` is within reach and inside the aim cone (pure dot-product, no trig). */
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

/** Spawn a fresh grazing enemy of a random type, placed away from the player. */
function spawnEnemy(id: number, playerPos: Vec2, tick: number, draw: Draw): EnemyState {
  const type = ENEMY_TYPES[draw(0, ENEMY_TYPES.length - 1)] as EnemyType;
  let position = clampToArena(ARENA_WIDTH / 2, ARENA_HEIGHT / 2);
  const minSq = SPAWN_MIN_PLAYER_DIST * SPAWN_MIN_PLAYER_DIST;
  for (let attempt = 0; attempt < 8; attempt++) {
    position = clampToArena(draw(0, ARENA_WIDTH), draw(0, ARENA_HEIGHT));
    if (distanceSq(position, playerPos) >= minSq) break;
  }
  return {
    id,
    type: type.key,
    health: type.maxHealth,
    maxHealth: type.maxHealth,
    position,
    behavior: 'grazing',
    phase: 'idle',
    phaseEndsAtTick: 0,
    incomingAttackOutcome: 'none',
    attackZoneCenter: null,
    grazeTarget: null,
    // Stagger initial wander so a fresh herd doesn't all move on the same tick.
    grazeResumeTick: tick + draw(0, GRAZE_PAUSE_MAX_TICKS),
  };
}

/** A grazing enemy: amble to a random spot, stand and "eat", repeat. Never attacks. */
function grazeStep(enemy: EnemyState, tick: number, draw: Draw): EnemyState {
  if (enemy.grazeTarget === null) {
    if (tick < enemy.grazeResumeTick) return enemy; // standing, eating
    const target = clampToArena(
      enemy.position.x + draw(-GRAZE_WANDER_RADIUS, GRAZE_WANDER_RADIUS),
      enemy.position.y + draw(-GRAZE_WANDER_RADIUS, GRAZE_WANDER_RADIUS),
    );
    return { ...enemy, grazeTarget: target };
  }
  if (distanceSq(enemy.position, enemy.grazeTarget) <= GRAZE_ARRIVE_EPS_SQ) {
    const pause = draw(GRAZE_PAUSE_MIN_TICKS, GRAZE_PAUSE_MAX_TICKS);
    return { ...enemy, position: enemy.grazeTarget, grazeTarget: null, grazeResumeTick: tick + pause };
  }
  return { ...enemy, position: moveToward(enemy.position, enemy.grazeTarget, GRAZE_MOVE_SPEED_PER_TICK, 0) };
}

/** Flip a grazing enemy to hunting; a no-op if it is already hunting. */
function aggro(enemy: EnemyState, tick: number): EnemyState {
  if (enemy.behavior === 'hunting') return enemy;
  return {
    ...enemy,
    behavior: 'hunting',
    phase: 'idle',
    phaseEndsAtTick: tick + ENEMY_IDLE_TICKS,
    grazeTarget: null,
    incomingAttackOutcome: 'none',
    attackZoneCenter: null,
  };
}

export function initCombat(seed: number): CombatState {
  let rng = Rng.fromSeed(seed);
  const draw: Draw = (min, max) => {
    const [value, next] = rng.nextInt(min, max);
    rng = next;
    return value;
  };
  const player: PlayerState = {
    health: PLAYER_MAX_HEALTH,
    maxHealth: PLAYER_MAX_HEALTH,
    mana: PLAYER_MAX_MANA,
    maxMana: PLAYER_MAX_MANA,
    position: { x: ARENA_WIDTH * 0.5, y: ARENA_HEIGHT * 0.5 },
    attackCooldownUntil: 0,
    moveLockUntil: 0,
    attackReleaseTick: 0,
    attackAimX: 1,
    attackAimY: 0,
    defenseLockUntil: 0,
    strikeCount: 0,
    damageBuffs: [],
  };
  const enemies: EnemyState[] = [];
  let nextEnemyId = 1;
  for (let i = 0; i < INITIAL_ENEMIES; i++) {
    enemies.push(spawnEnemy(nextEnemyId, player.position, 0, draw));
    nextEnemyId++;
  }
  return {
    tick: 0,
    player,
    enemies,
    nextEnemyId,
    nextSpawnTick: ENEMY_SPAWN_INTERVAL_TICKS,
    over: false,
    rng,
  };
}

export function step(
  state: CombatState,
  input: InputFrame,
  mods: Modifiers = IDENTITY_MODIFIERS,
): { state: CombatState; events: SimEvent[] } {
  const events: SimEvent[] = [];
  // Terminal freeze: once the player is defeated the sim stops advancing.
  if (state.over) return { state, events };

  const tick = state.tick + 1;
  let rng = state.rng;
  const draw: Draw = (min, max) => {
    const [value, next] = rng.nextInt(min, max);
    rng = next;
    return value;
  };
  const scaleDuration = (base: number): number => Math.max(1, Math.round(base * mods.enemySpeedMultiplier));

  // --- Player intent + movement ---
  const swingPending = state.player.attackReleaseTick !== 0;
  const startAttack = input.attack && !swingPending && tick >= state.player.attackCooldownUntil;
  const rooted = swingPending || startAttack || tick < state.player.moveLockUntil;

  let player: PlayerState = {
    ...state.player,
    position: rooted ? state.player.position : movePlayer(state.player.position, input.moveX, input.moveY),
  };

  // --- Enemy movement: grazers wander, hunters home while idle ---
  let enemies: EnemyState[] = state.enemies.map((enemy) => {
    if (enemy.behavior === 'grazing') return grazeStep(enemy, tick, draw);
    if (enemy.phase === 'idle') {
      const speed = enemyTypeByKey(enemy.type).moveSpeed;
      return { ...enemy, position: moveToward(enemy.position, player.position, speed, ENEMY_STANDOFF) };
    }
    return enemy; // hunting but planted for windup/recovery
  });

  // Begin an attack wind-up: capture the aim now; the strike lands later.
  if (startAttack) {
    player = { ...player, attackReleaseTick: tick + PLAYER_ATTACK_WINDUP_TICKS, attackAimX: input.aimX, attackAimY: input.aimY };
  }

  // --- Resolve a pending swing: a cleave that hits every enemy in the cone ---
  if (player.attackReleaseTick !== 0 && tick >= player.attackReleaseTick) {
    const strikeCount = player.strikeCount + 1;
    let damage = PLAYER_ATTACK_DAMAGE + activeDamageBuffTotal(player.damageBuffs, tick) + mods.attackDamageBonus;
    if (mods.nthStrikeEveryN > 0 && strikeCount % mods.nthStrikeEveryN === 0) {
      damage = Math.round(damage * (1 + mods.nthStrikeBonusFraction));
    }
    let anyHit = false;
    enemies = enemies.map((enemy) => {
      if (!attackConnects(player.position, enemy.position, player.attackAimX, player.attackAimY)) return enemy;
      anyHit = true;
      const health = Math.max(0, enemy.health - damage);
      events.push({ kind: 'enemyHit', damage, tick, enemyId: enemy.id, at: enemy.position });
      return aggro({ ...enemy, health }, tick);
    });
    if (!anyHit) events.push({ kind: 'attackMissed', tick });
    player = {
      ...player,
      attackReleaseTick: 0,
      attackCooldownUntil: tick + PLAYER_ATTACK_COOLDOWN_TICKS,
      moveLockUntil: tick + ATTACK_ROOT_TICKS,
      strikeCount,
    };
  }

  // --- External effect (a played card) ---
  if (input.externalEffect) {
    const effect = input.externalEffect;
    if (player.mana < effect.manaCost) {
      events.push({ kind: 'effectRejectedInsufficientMana', tick });
    } else if (effect.kind === 'damageEnemy') {
      // Target the nearest enemy; damaging it also wakes it.
      let nearest: EnemyState | null = null;
      let nearestSq = Infinity;
      for (const enemy of enemies) {
        const d = distanceSq(enemy.position, player.position);
        if (d < nearestSq) {
          nearest = enemy;
          nearestSq = d;
        }
      }
      if (nearest) {
        const target = nearest;
        const health = Math.max(0, target.health - effect.amount);
        enemies = enemies.map((enemy) => (enemy.id === target.id ? aggro({ ...enemy, health }, tick) : enemy));
        player = { ...player, mana: player.mana - effect.manaCost };
        events.push({ kind: 'enemyHit', damage: effect.amount, tick, enemyId: target.id, at: target.position });
      }
    } else if (effect.kind === 'healPlayer') {
      player = { ...player, mana: player.mana - effect.manaCost, health: Math.min(player.maxHealth, player.health + effect.amount) };
    } else {
      const damageBuffs = [...player.damageBuffs, { amount: effect.amount, expiresAtTick: tick + effect.durationTicks }];
      player = { ...player, mana: player.mana - effect.manaCost, damageBuffs };
    }
  }

  // --- Remove dead enemies ---
  {
    const survivors: EnemyState[] = [];
    for (const enemy of enemies) {
      if (enemy.health <= 0) events.push({ kind: 'enemyDefeated', tick, enemyId: enemy.id, enemyType: enemy.type });
      else survivors.push(enemy);
    }
    enemies = survivors;
  }

  // --- Defense input: register against the most imminent hunting wind-up ---
  if ((input.parry || input.dodge) && tick >= player.defenseLockUntil) {
    let target: EnemyState | null = null;
    for (const enemy of enemies) {
      if (enemy.behavior !== 'hunting' || enemy.phase !== 'windup' || enemy.incomingAttackOutcome !== 'none') continue;
      if (target === null || enemy.phaseEndsAtTick < target.phaseEndsAtTick) target = enemy;
    }
    if (target) {
      const chosen = target;
      const defenseType: DefenseType = input.parry ? 'parry' : 'dodge';
      const diff = Math.abs(tick - chosen.phaseEndsAtTick);
      const outcome: DefenseOutcome =
        diff <= PERFECT_WINDOW_TICKS ? 'perfect' : diff <= NORMAL_WINDOW_TICKS ? 'normal' : 'whiffed';
      enemies = enemies.map((enemy) => (enemy.id === chosen.id ? { ...enemy, incomingAttackOutcome: outcome } : enemy));
      player = { ...player, defenseLockUntil: tick + DEFENSE_RECOVERY_TICKS };
      if (outcome === 'perfect') events.push({ kind: 'perfectDefense', defenseType, tick });
      else if (outcome === 'normal') events.push({ kind: 'normalDefense', defenseType, tick });
    }
  }

  // --- Hunting state machine: idle -> windup -> (slam) -> recovery -> idle ---
  let playerHealth = player.health;
  let over = false;
  enemies = enemies.map((enemy) => {
    if (enemy.behavior !== 'hunting' || tick < enemy.phaseEndsAtTick) return enemy;
    if (enemy.phase === 'idle') {
      return { ...enemy, phase: 'windup', phaseEndsAtTick: tick + scaleDuration(ENEMY_WINDUP_TICKS), incomingAttackOutcome: 'none', attackZoneCenter: player.position };
    }
    if (enemy.phase === 'windup') {
      const zone = enemy.attackZoneCenter;
      const inZone = zone !== null && distanceSq(player.position, zone) <= ENEMY_ATTACK_RADIUS * ENEMY_ATTACK_RADIUS;
      const fullDamage = Math.round(enemyTypeByKey(enemy.type).attackDamage * mods.enemyDamageMultiplier);
      const baseDamage = inZone ? fullDamage : 0;
      const outcome = enemy.incomingAttackOutcome;
      const damage = outcome === 'perfect' ? 0 : outcome === 'normal' ? Math.round(baseDamage / 2) : baseDamage;
      if (damage > 0 && !over && playerHealth > 0) {
        playerHealth = Math.max(0, playerHealth - damage);
        events.push({ kind: 'playerHit', damage, tick });
        if (playerHealth <= 0) {
          events.push({ kind: 'playerDefeated', tick });
          over = true;
        } else if (mods.healOnHurt > 0) {
          const healed = Math.min(player.maxHealth, playerHealth + mods.healOnHurt);
          events.push({ kind: 'playerHealed', amount: healed - playerHealth, tick });
          playerHealth = healed;
        }
      } else if (!inZone && outcome !== 'perfect' && outcome !== 'normal') {
        events.push({ kind: 'enemyAttackAvoided', tick });
      }
      return { ...enemy, phase: 'recovery', phaseEndsAtTick: tick + scaleDuration(ENEMY_RECOVERY_TICKS), incomingAttackOutcome: 'none', attackZoneCenter: null };
    }
    return { ...enemy, phase: 'idle', phaseEndsAtTick: tick + scaleDuration(ENEMY_IDLE_TICKS) };
  });
  player = { ...player, health: playerHealth };

  // --- Spawner: refill toward the cap ---
  let nextSpawnTick = state.nextSpawnTick;
  let nextEnemyId = state.nextEnemyId;
  if (!over && tick >= nextSpawnTick && enemies.length < MAX_ENEMIES) {
    enemies = [...enemies, spawnEnemy(nextEnemyId, player.position, tick, draw)];
    nextEnemyId++;
    nextSpawnTick = tick + ENEMY_SPAWN_INTERVAL_TICKS;
  }

  // --- Regen + buff expiry (skipped once the game is over) ---
  if (!over) {
    player = {
      ...player,
      health: Math.min(player.maxHealth, player.health + mods.healthRegenPerTick),
      mana: Math.min(player.maxMana, player.mana + MANA_REGEN_PER_TICK + mods.manaRegenPerTick),
      damageBuffs: player.damageBuffs.filter((buff) => buff.expiresAtTick > tick),
    };
  }

  return { state: { tick, player, enemies, nextEnemyId, nextSpawnTick, over, rng }, events };
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
