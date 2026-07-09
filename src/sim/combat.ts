import { Rng } from '../shared/prng.js';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  ATTACK_ARC_COS_SQ,
  ATTACK_ROOT_TICKS,
  DEFENSE_RECOVERY_TICKS,
  DIAGONAL_SCALE,
  ENEMY_ATTACK_ARC_COS_SQ,
  ENEMY_ATTACK_RANGE,
  ENEMY_ATTACK_TRIGGER_RANGE,
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
  MAX_DAMAGE_REDUCTION,
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
  PLAYER_SLOW_MULTIPLIER,
  SPAWN_MIN_PLAYER_DIST,
  WAVE_ATTACK_SPEED_GROWTH,
  WAVE_BASE_COUNT,
  WAVE_DAMAGE_GROWTH,
  WAVE_HEALTH_GROWTH,
  WAVE_MAX_ENEMIES,
  WAVE_SPEED_GROWTH,
} from './constants.js';
import { ENEMY_TYPES, enemyTypeByKey, type EnemyType } from './enemies.js';
import {
  IDENTITY_MODIFIERS,
  type AuraState,
  type CombatState,
  type DamageBuff,
  type DefenseOutcome,
  type DefenseType,
  type EnemyState,
  type GroundFire,
  type InputFrame,
  type Modifiers,
  type PendingAoe,
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
function movePlayer(position: Vec2, moveX: number, moveY: number, speedScale = 1): Vec2 {
  const diag = moveX !== 0 && moveY !== 0 ? DIAGONAL_SCALE : 1;
  const speed = MOVE_SPEED_PER_TICK * diag * speedScale;
  const x = clamp(position.x + moveX * speed, PLAYER_RADIUS, ARENA_WIDTH - PLAYER_RADIUS);
  const y = clamp(position.y + moveY * speed, PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS);
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

/** Clamp a point to the player's movable bounds. */
function clampPlayerPos(x: number, y: number): Vec2 {
  return {
    x: clamp(x, PLAYER_RADIUS, ARENA_WIDTH - PLAYER_RADIUS),
    y: clamp(y, PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS),
  };
}

/** Parameterized cone hit (spec 018 spell casts); `aim` need not be normalized. */
function coneHits(from: Vec2, target: Vec2, aimX: number, aimY: number, range: number, arcCosSq: number, targetRadius: number): boolean {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const lenSq = dx * dx + dy * dy;
  const reach = range + targetRadius;
  if (lenSq > reach * reach) return false;
  const dot = dx * aimX + dy * aimY;
  if (dot <= 0) return false;
  const aimLenSq = aimX * aimX + aimY * aimY;
  return dot * dot >= arcCosSq * lenSq * aimLenSq;
}

/** True if `target` lies inside a forward rectangle from `from` along unit `(ux,uy)`. */
function rectHits(from: Vec2, target: Vec2, ux: number, uy: number, length: number, halfWidth: number, targetRadius: number): boolean {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const along = dx * ux + dy * uy;
  if (along < -targetRadius || along > length + targetRadius) return false;
  const perp = Math.abs(dx * -uy + dy * ux);
  return perp <= halfWidth + targetRadius;
}

/** Circle overlap: `target` (radius `targetRadius`) within `radius` of `center`. */
function circleHits(center: Vec2, target: Vec2, radius: number, targetRadius: number): boolean {
  const r = radius + targetRadius;
  return distanceSq(center, target) <= r * r;
}

/** Where a point-AOE lands: on the player, at the cursor, or on the foe nearest the cursor. */
function pointAoeOrigin(
  origin: 'player' | 'target' | 'nearestEnemyToTarget',
  playerPos: Vec2,
  targetX: number,
  targetY: number,
  enemies: readonly EnemyState[],
): Vec2 {
  if (origin === 'player') return playerPos;
  if (origin === 'target') return { x: targetX, y: targetY };
  // nearestEnemyToTarget: centre on the closest foe to the cursor, else the cursor.
  const cursor = { x: targetX, y: targetY };
  let best: EnemyState | null = null;
  let bestSq = Infinity;
  for (const enemy of enemies) {
    const d = distanceSq(enemy.position, cursor);
    if (d < bestSq) {
      bestSq = d;
      best = enemy;
    }
  }
  return best ? best.position : cursor;
}

/** Unit vector from `from` toward `to`; falls back to +x when they coincide. */
function unitToward(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  return len < 1e-6 ? { x: 1, y: 0 } : { x: dx / len, y: dy / len };
}

/** True if `target` lies inside the enemy's slam cone (apex, unit `aim`, reach + arc). */
function enemyConeHits(apex: Vec2, aim: Vec2, target: Vec2): boolean {
  const dx = target.x - apex.x;
  const dy = target.y - apex.y;
  const lenSq = dx * dx + dy * dy;
  const reach = ENEMY_ATTACK_RANGE + PLAYER_RADIUS;
  if (lenSq > reach * reach) return false;
  const dot = dx * aim.x + dy * aim.y;
  if (dot <= 0) return false;
  // aim is a unit vector, so its squared length is 1.
  return dot * dot >= ENEMY_ATTACK_ARC_COS_SQ * lenSq;
}

interface SpawnOpts {
  /** Scale the type's base health/damage (wave escalation); default 1. */
  readonly healthMult: number;
  readonly damageMult: number;
  /** Scale the type's homing speed and attack cadence (wave escalation); default 1. */
  readonly speedMult: number;
  readonly attackSpeedMult: number;
  /** Spawn already hunting the player (wave mode) rather than grazing. */
  readonly hunting: boolean;
}

const GRAZE_SPAWN: SpawnOpts = { healthMult: 1, damageMult: 1, speedMult: 1, attackSpeedMult: 1, hunting: false };

/** Spawn a fresh enemy of a random type, placed away from the player. */
function spawnEnemy(id: number, playerPos: Vec2, tick: number, draw: Draw, opts: SpawnOpts = GRAZE_SPAWN): EnemyState {
  const type = ENEMY_TYPES[draw(0, ENEMY_TYPES.length - 1)] as EnemyType;
  let position = clampToArena(ARENA_WIDTH / 2, ARENA_HEIGHT / 2);
  const minSq = SPAWN_MIN_PLAYER_DIST * SPAWN_MIN_PLAYER_DIST;
  for (let attempt = 0; attempt < 8; attempt++) {
    position = clampToArena(draw(0, ARENA_WIDTH), draw(0, ARENA_HEIGHT));
    if (distanceSq(position, playerPos) >= minSq) break;
  }
  const maxHealth = Math.round(type.maxHealth * opts.healthMult);
  return {
    id,
    type: type.key,
    health: maxHealth,
    maxHealth,
    attackDamage: Math.round(type.attackDamage * opts.damageMult),
    speedMult: opts.speedMult,
    attackSpeedMult: opts.attackSpeedMult,
    position,
    behavior: opts.hunting ? 'hunting' : 'grazing',
    phase: 'idle',
    phaseEndsAtTick: opts.hunting ? tick + Math.max(1, Math.round(ENEMY_IDLE_TICKS / opts.attackSpeedMult)) : 0,
    incomingAttackOutcome: 'none',
    attackAim: null,
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
    attackAim: null,
  };
}

export interface CombatOptions {
  /** Enemies present at tick 0; defaults to the legacy INITIAL_ENEMIES. */
  readonly initialEnemies?: number;
  /** When false, the ambient refill spawner is off (wave mode). Default true. */
  readonly ambientSpawner?: boolean;
}

export function initCombat(seed: number, opts: CombatOptions = {}): CombatState {
  const ambientSpawner = opts.ambientSpawner ?? true;
  const initialEnemies = opts.initialEnemies ?? INITIAL_ENEMIES;
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
    stanceExpiresAtTick: 0,
    stanceAttackBonus: 0,
    stanceReductionPct: 0,
    stanceRegenPerTick: 0,
    guardExpiresAtTick: 0,
    guardReductionPct: 0,
    activateLockUntil: 0,
    shieldAmount: 0,
    shieldExpiresAtTick: 0,
    auras: [],
    pendingAoes: [],
    dashDx: 0,
    dashDy: 0,
    dashExpiresAtTick: 0,
    dashDamage: 0,
    dashHitIds: [],
    dashTrail: null,
    groundFires: [],
    attackFlameCharges: 0,
    attackFlameBonus: 0,
    moveSlowUntilTick: 0,
  };
  const enemies: EnemyState[] = [];
  let nextEnemyId = 1;
  for (let i = 0; i < initialEnemies; i++) {
    enemies.push(spawnEnemy(nextEnemyId, player.position, 0, draw));
    nextEnemyId++;
  }
  return {
    tick: 0,
    player,
    enemies,
    nextEnemyId,
    nextSpawnTick: ambientSpawner ? ENEMY_SPAWN_INTERVAL_TICKS : Number.MAX_SAFE_INTEGER,
    ambientSpawner,
    waveNumber: 0,
    enemySlowExpiresAtTick: 0,
    enemySlowMultiplier: 1,
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
  // Enemy slow (stance/diamond): <1 slows homing and stretches telegraphs.
  const slowMult = tick < state.enemySlowExpiresAtTick ? state.enemySlowMultiplier : 1;
  const scaleDuration = (base: number, attackSpeedMult = 1): number =>
    Math.max(1, Math.round((base * mods.enemySpeedMultiplier) / (slowMult * attackSpeedMult)));

  // --- Player intent + movement ---
  const swingPending = state.player.attackReleaseTick !== 0;
  const startAttack = input.attack && !swingPending && tick >= state.player.attackCooldownUntil;
  // A dash (spec 018) overrides ordinary movement and ignores attack rooting.
  const dashing = tick < state.player.dashExpiresAtTick;
  const rooted = !dashing && (swingPending || startAttack || tick < state.player.moveLockUntil);

  // A mis-timed window (spec 021) drags the walk speed down for a spell.
  const moveScale = tick < state.player.moveSlowUntilTick ? PLAYER_SLOW_MULTIPLIER : 1;
  const nextPos = dashing
    ? clampPlayerPos(state.player.position.x + state.player.dashDx, state.player.position.y + state.player.dashDy)
    : rooted
      ? state.player.position
      : movePlayer(state.player.position, input.moveX, input.moveY, moveScale);
  let player: PlayerState = { ...state.player, position: nextPos };

  // --- Enemy movement: grazers wander, hunters home while idle ---
  let enemies: EnemyState[] = state.enemies.map((enemy) => {
    if (enemy.stunnedUntilTick && tick < enemy.stunnedUntilTick) return enemy; // frozen by a bury-feet stun
    if (enemy.behavior === 'grazing') return grazeStep(enemy, tick, draw);
    if (enemy.phase === 'idle') {
      const speed = enemyTypeByKey(enemy.type).moveSpeed * (enemy.speedMult ?? 1) * slowMult;
      return { ...enemy, position: moveToward(enemy.position, player.position, speed, ENEMY_STANDOFF) };
    }
    return enemy; // hunting but planted for windup/recovery
  });

  // --- Damaging dash (three-dash fusion): strike each body it passes, once per dash ---
  if (dashing && state.player.dashDamage > 0) {
    const alreadyHit = new Set(state.player.dashHitIds);
    const newlyHit: number[] = [];
    enemies = enemies.map((enemy) => {
      if (alreadyHit.has(enemy.id) || !circleHits(player.position, enemy.position, PLAYER_RADIUS, ENEMY_RADIUS)) return enemy;
      newlyHit.push(enemy.id);
      const health = Math.max(0, enemy.health - state.player.dashDamage);
      events.push({ kind: 'enemyHit', damage: state.player.dashDamage, tick, enemyId: enemy.id, at: enemy.position });
      return aggro({ ...enemy, health }, tick);
    });
    if (newlyHit.length > 0) player = { ...player, dashHitIds: [...state.player.dashHitIds, ...newlyHit] };
  }

  // --- Basking Path: lay a burning patch under the player every few ticks of the dash ---
  if (dashing && state.player.dashTrail && (state.player.dashExpiresAtTick - tick) % 3 === 0) {
    const trail = state.player.dashTrail;
    const fire: GroundFire = {
      x: player.position.x,
      y: player.position.y,
      radius: trail.radius,
      pulseDamage: trail.pulseDamage,
      pulseIntervalTicks: trail.pulseIntervalTicks,
      nextPulseTick: tick + trail.pulseIntervalTicks,
      expiresAtTick: tick + trail.durationTicks,
    };
    player = { ...player, groundFires: [...player.groundFires, fire] };
  }

  // Begin an attack wind-up: capture the aim now; the strike lands later.
  if (startAttack) {
    player = { ...player, attackReleaseTick: tick + PLAYER_ATTACK_WINDUP_TICKS, attackAimX: input.aimX, attackAimY: input.aimY };
  }

  // --- Resolve a pending swing: a cleave that hits every enemy in the cone ---
  if (player.attackReleaseTick !== 0 && tick >= player.attackReleaseTick) {
    const strikeCount = player.strikeCount + 1;
    const stanceAttack = tick < player.stanceExpiresAtTick ? player.stanceAttackBonus : 0;
    let damage = PLAYER_ATTACK_DAMAGE + activeDamageBuffTotal(player.damageBuffs, tick) + mods.attackDamageBonus + stanceAttack;
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

  // Enemy-slow state may be refreshed by an effect this tick; carried at the end.
  let enemySlowExpiresAtTick = state.enemySlowExpiresAtTick;
  let enemySlowMultiplier = state.enemySlowMultiplier;

  // --- External effect (a played card / activated stance) ---
  if (input.externalEffect) {
    const effect = input.externalEffect;
    switch (effect.kind) {
      case 'damageEnemy': {
        if (player.mana < effect.manaCost) {
          events.push({ kind: 'effectRejectedInsufficientMana', tick });
          break;
        }
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
        break;
      }
      case 'healPlayer': {
        if (player.mana < effect.manaCost) {
          events.push({ kind: 'effectRejectedInsufficientMana', tick });
          break;
        }
        player = { ...player, mana: player.mana - effect.manaCost, health: Math.min(player.maxHealth, player.health + effect.amount) };
        break;
      }
      case 'buffPlayerDamage': {
        if (player.mana < effect.manaCost) {
          events.push({ kind: 'effectRejectedInsufficientMana', tick });
          break;
        }
        const damageBuffs = [...player.damageBuffs, { amount: effect.amount, expiresAtTick: tick + effect.durationTicks }];
        player = { ...player, mana: player.mana - effect.manaCost, damageBuffs };
        break;
      }
      case 'guard': {
        // A played spade: a brief incoming-damage-reduction window.
        player = { ...player, guardExpiresAtTick: tick + effect.durationTicks, guardReductionPct: effect.reductionPct };
        break;
      }
      case 'slowEnemies': {
        // A played diamond: slow the whole population for a moment.
        enemySlowExpiresAtTick = tick + effect.durationTicks;
        enemySlowMultiplier = effect.multiplier;
        break;
      }
      case 'applyStance': {
        // Cashed-in poker hand. Refused while the previous stance's lockout holds.
        if (tick < player.activateLockUntil) {
          events.push({ kind: 'stanceRejectedLocked', tick });
          break;
        }
        player = {
          ...player,
          stanceExpiresAtTick: tick + effect.durationTicks,
          stanceAttackBonus: effect.attackBonus,
          stanceReductionPct: effect.reductionPct,
          stanceRegenPerTick: effect.regenPerTick,
          activateLockUntil: tick + effect.lockoutTicks,
        };
        if (effect.slowMultiplier < 1) {
          enemySlowExpiresAtTick = tick + effect.durationTicks;
          enemySlowMultiplier = effect.slowMultiplier;
        }
        events.push({ kind: 'stanceApplied', tick });
        break;
      }
      case 'castSpells': {
        // A synergy window's worth of resolved geometry, executed at once.
        const aimLen = Math.sqrt(effect.aimX * effect.aimX + effect.aimY * effect.aimY);
        const ux = aimLen < 1e-6 ? 1 : effect.aimX / aimLen;
        const uy = aimLen < 1e-6 ? 0 : effect.aimY / aimLen;
        const castPos = player.position;
        let auras = player.auras;
        let pendingAoes = player.pendingAoes;
        let dashDx = player.dashDx;
        let dashDy = player.dashDy;
        let dashExpiresAtTick = player.dashExpiresAtTick;
        let dashDamage = player.dashDamage;
        let dashHitIds = player.dashHitIds;
        let dashTrail = player.dashTrail;
        let shieldAmount = player.shieldAmount;
        let shieldExpiresAtTick = player.shieldExpiresAtTick;
        let flameCharges = player.attackFlameCharges;
        let flameBonus = player.attackFlameBonus;
        const applyInstant = (hit: (e: EnemyState) => boolean, dmg: number): void => {
          enemies = enemies.map((enemy) => {
            if (!hit(enemy)) return enemy;
            const health = Math.max(0, enemy.health - dmg);
            events.push({ kind: 'enemyHit', damage: dmg, tick, enemyId: enemy.id, at: enemy.position });
            return aggro({ ...enemy, health }, tick);
          });
        };
        for (const spell of effect.spells) {
          switch (spell.kind) {
            case 'cone': {
              // Conjure Flame arms cone casts with bonus fire damage; each cone spends one charge.
              const bonus = flameCharges > 0 ? flameBonus : 0;
              if (flameCharges > 0) flameCharges -= 1;
              applyInstant((e) => coneHits(castPos, e.position, ux, uy, spell.range, spell.arcCosSq, ENEMY_RADIUS), spell.damage + bonus);
              break;
            }
            case 'rect':
              applyInstant((e) => rectHits(castPos, e.position, ux, uy, spell.length, spell.halfWidth, ENEMY_RADIUS), spell.damage);
              break;
            case 'pointAoe': {
              const origin = pointAoeOrigin(spell.origin, castPos, effect.targetX, effect.targetY, enemies);
              const added: PendingAoe[] = [];
              for (let i = 0; i < spell.count; i++) {
                added.push({
                  x: origin.x,
                  y: origin.y,
                  radius: spell.radius,
                  damage: spell.damage,
                  stunTicks: spell.stunTicks,
                  impactTick: tick + spell.delayTicks + i * spell.spreadTicks,
                });
              }
              pendingAoes = [...pendingAoes, ...added];
              break;
            }
            case 'empower':
              flameCharges += spell.charges;
              flameBonus = spell.bonusDamage;
              break;
            case 'aura':
              auras = [
                ...auras,
                {
                  radius: spell.radius,
                  pulseDamage: spell.pulseDamage,
                  pulseIntervalTicks: spell.pulseIntervalTicks,
                  nextPulseTick: tick + spell.pulseIntervalTicks,
                  expiresAtTick: tick + spell.durationTicks,
                },
              ];
              break;
            case 'dash': {
              const dur = Math.max(1, spell.durationTicks);
              dashDx = ux * (spell.distance / dur);
              dashDy = uy * (spell.distance / dur);
              dashExpiresAtTick = tick + dur;
              dashDamage = spell.damage;
              dashHitIds = [];
              dashTrail =
                spell.trailRadius !== undefined && spell.trailPulseDamage !== undefined && spell.trailDurationTicks !== undefined
                  ? {
                      radius: spell.trailRadius,
                      pulseDamage: spell.trailPulseDamage,
                      pulseIntervalTicks: spell.trailPulseIntervalTicks ?? 12,
                      durationTicks: spell.trailDurationTicks,
                    }
                  : null;
              events.push({ kind: 'dashPerformed', tick });
              break;
            }
            case 'shield': {
              const active = tick < shieldExpiresAtTick ? shieldAmount : 0;
              shieldAmount = Math.max(active, spell.amount);
              shieldExpiresAtTick = tick + spell.durationTicks;
              break;
            }
          }
        }
        const slowTicks = effect.playerSlowTicks ?? 0;
        player = {
          ...player,
          auras,
          pendingAoes,
          dashDx,
          dashDy,
          dashExpiresAtTick,
          dashDamage,
          dashHitIds,
          dashTrail,
          shieldAmount,
          shieldExpiresAtTick,
          attackFlameCharges: flameCharges,
          attackFlameBonus: flameBonus,
          ...(slowTicks > 0 ? { moveSlowUntilTick: tick + slowTicks } : {}),
        };
        if (slowTicks > 0) events.push({ kind: 'playerSlowed', tick, durationTicks: slowTicks });
        events.push({ kind: 'spellCast', tick, spellCount: effect.spells.length });
        break;
      }
    }
  }

  // --- Spell upkeep: aura pulses and telegraphed AOE impacts (spec 018) ---
  if (player.auras.length > 0) {
    const auras = player.auras;
    const anyDue = auras.some((aura) => tick >= aura.nextPulseTick && tick < aura.expiresAtTick);
    if (anyDue) {
      enemies = enemies.map((enemy) => {
        let dmg = 0;
        for (const aura of auras) {
          if (tick >= aura.nextPulseTick && tick < aura.expiresAtTick && circleHits(player.position, enemy.position, aura.radius, ENEMY_RADIUS)) {
            dmg += aura.pulseDamage;
          }
        }
        if (dmg <= 0) return enemy;
        const health = Math.max(0, enemy.health - dmg);
        events.push({ kind: 'enemyHit', damage: dmg, tick, enemyId: enemy.id, at: enemy.position });
        return aggro({ ...enemy, health }, tick);
      });
    }
    const advanced: AuraState[] = auras
      .map((aura) => (tick >= aura.nextPulseTick && tick < aura.expiresAtTick ? { ...aura, nextPulseTick: aura.nextPulseTick + aura.pulseIntervalTicks } : aura))
      .filter((aura) => tick < aura.expiresAtTick);
    player = { ...player, auras: advanced };
  }

  // --- Ground fire (Basking Path trail): stationary patches pulse like auras ---
  if (player.groundFires.length > 0) {
    const fires = player.groundFires;
    const anyDue = fires.some((f) => tick >= f.nextPulseTick && tick < f.expiresAtTick);
    if (anyDue) {
      enemies = enemies.map((enemy) => {
        let dmg = 0;
        for (const f of fires) {
          if (tick >= f.nextPulseTick && tick < f.expiresAtTick && circleHits({ x: f.x, y: f.y }, enemy.position, f.radius, ENEMY_RADIUS)) {
            dmg += f.pulseDamage;
          }
        }
        if (dmg <= 0) return enemy;
        const health = Math.max(0, enemy.health - dmg);
        events.push({ kind: 'enemyHit', damage: dmg, tick, enemyId: enemy.id, at: enemy.position });
        return aggro({ ...enemy, health }, tick);
      });
    }
    const advancedFires: GroundFire[] = fires
      .map((f) => (tick >= f.nextPulseTick && tick < f.expiresAtTick ? { ...f, nextPulseTick: f.nextPulseTick + f.pulseIntervalTicks } : f))
      .filter((f) => tick < f.expiresAtTick);
    player = { ...player, groundFires: advancedFires };
  }

  if (player.pendingAoes.length > 0) {
    const due = player.pendingAoes.filter((a) => tick >= a.impactTick);
    for (const aoe of due) {
      enemies = enemies.map((enemy) => {
        if (!circleHits({ x: aoe.x, y: aoe.y }, enemy.position, aoe.radius, ENEMY_RADIUS)) return enemy;
        const health = Math.max(0, enemy.health - aoe.damage);
        if (aoe.damage > 0) events.push({ kind: 'enemyHit', damage: aoe.damage, tick, enemyId: enemy.id, at: enemy.position });
        if (aoe.stunTicks > 0) {
          const stunnedUntilTick = Math.max(enemy.stunnedUntilTick ?? 0, tick + aoe.stunTicks);
          return aggro({ ...enemy, health, stunnedUntilTick }, tick);
        }
        return aggro({ ...enemy, health }, tick);
      });
      events.push({ kind: 'aoeImpact', tick, at: { x: aoe.x, y: aoe.y }, radius: aoe.radius });
    }
    if (due.length > 0) player = { ...player, pendingAoes: player.pendingAoes.filter((a) => tick < a.impactTick) };
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
  let shieldAmount = player.shieldAmount;
  let over = false;
  enemies = enemies.map((enemy) => {
    if (enemy.stunnedUntilTick && tick < enemy.stunnedUntilTick) return enemy; // stunned: no wind-up
    if (enemy.behavior !== 'hunting' || tick < enemy.phaseEndsAtTick) return enemy;
    if (enemy.phase === 'idle') {
      // Attack only when in range: beyond the trigger distance the enemy keeps
      // closing (another idle beat of homing) instead of committing to a slam.
      const inRange = distanceSq(enemy.position, player.position) <= ENEMY_ATTACK_TRIGGER_RANGE * ENEMY_ATTACK_TRIGGER_RANGE;
      if (!inRange) return { ...enemy, phaseEndsAtTick: tick + scaleDuration(ENEMY_IDLE_TICKS, enemy.attackSpeedMult ?? 1) };
      // Commit: snapshot the cone direction toward the player now; the enemy is
      // planted for the wind-up so its position is the cone's apex at the slam.
      const aim = unitToward(enemy.position, player.position);
      return { ...enemy, phase: 'windup', phaseEndsAtTick: tick + scaleDuration(ENEMY_WINDUP_TICKS, enemy.attackSpeedMult ?? 1), incomingAttackOutcome: 'none', attackAim: aim };
    }
    if (enemy.phase === 'windup') {
      const aim = enemy.attackAim;
      const inZone = aim !== null && enemyConeHits(enemy.position, aim, player.position);
      const baseAttack = enemy.attackDamage ?? enemyTypeByKey(enemy.type).attackDamage;
      const fullDamage = Math.round(baseAttack * mods.enemyDamageMultiplier);
      const baseDamage = inZone ? fullDamage : 0;
      const outcome = enemy.incomingAttackOutcome;
      const afterDefense = outcome === 'perfect' ? 0 : outcome === 'normal' ? Math.round(baseDamage / 2) : baseDamage;
      // Stack the held stance and any brief guard, capped, against the incoming hit.
      const reduction = Math.min(
        MAX_DAMAGE_REDUCTION,
        (tick < player.stanceExpiresAtTick ? player.stanceReductionPct : 0) +
          (tick < player.guardExpiresAtTick ? player.guardReductionPct : 0),
      );
      let damage = Math.round(afterDefense * (1 - reduction));
      // A Rocky Raise shield eats the incoming hit before health does.
      if (damage > 0 && tick < player.shieldExpiresAtTick && shieldAmount > 0) {
        const absorbed = Math.min(shieldAmount, damage);
        shieldAmount -= absorbed;
        damage -= absorbed;
      }
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
      return { ...enemy, phase: 'recovery', phaseEndsAtTick: tick + scaleDuration(ENEMY_RECOVERY_TICKS, enemy.attackSpeedMult ?? 1), incomingAttackOutcome: 'none', attackAim: null };
    }
    return { ...enemy, phase: 'idle', phaseEndsAtTick: tick + scaleDuration(ENEMY_IDLE_TICKS, enemy.attackSpeedMult ?? 1) };
  });
  player = { ...player, health: playerHealth, shieldAmount };

  // --- Wave cleared: heal the player to full when the last enemy of a wave dies ---
  if (!over && state.waveNumber >= 1 && state.enemies.length > 0 && enemies.length === 0 && player.health < player.maxHealth) {
    events.push({ kind: 'playerHealed', amount: player.maxHealth - player.health, tick });
    player = { ...player, health: player.maxHealth };
  }

  // --- Ambient spawner: refill toward the cap (off in wave mode) ---
  let nextSpawnTick = state.nextSpawnTick;
  let nextEnemyId = state.nextEnemyId;
  if (state.ambientSpawner && !over && tick >= nextSpawnTick && enemies.length < MAX_ENEMIES) {
    enemies = [...enemies, spawnEnemy(nextEnemyId, player.position, tick, draw)];
    nextEnemyId++;
    nextSpawnTick = tick + ENEMY_SPAWN_INTERVAL_TICKS;
  }

  // --- Wave spawner: an escalating burst of hunting enemies on demand ---
  let waveNumber = state.waveNumber;
  if (input.spawnWave === true && !over) {
    waveNumber += 1;
    const count = Math.min(WAVE_BASE_COUNT + waveNumber, WAVE_MAX_ENEMIES - enemies.length);
    const opts: SpawnOpts = {
      healthMult: 1 + WAVE_HEALTH_GROWTH * (waveNumber - 1),
      damageMult: 1 + WAVE_DAMAGE_GROWTH * (waveNumber - 1),
      speedMult: 1 + WAVE_SPEED_GROWTH * (waveNumber - 1),
      attackSpeedMult: 1 + WAVE_ATTACK_SPEED_GROWTH * (waveNumber - 1),
      hunting: true,
    };
    const spawned: EnemyState[] = [];
    for (let i = 0; i < count; i++) {
      spawned.push(spawnEnemy(nextEnemyId, player.position, tick, draw, opts));
      nextEnemyId++;
    }
    enemies = [...enemies, ...spawned];
    events.push({ kind: 'waveSpawned', tick, waveNumber, count: spawned.length });
  }

  // --- Regen + buff expiry (skipped once the game is over) ---
  if (!over) {
    const stanceRegen = tick < player.stanceExpiresAtTick ? player.stanceRegenPerTick : 0;
    player = {
      ...player,
      health: Math.min(player.maxHealth, player.health + mods.healthRegenPerTick + stanceRegen),
      mana: Math.min(player.maxMana, player.mana + MANA_REGEN_PER_TICK + mods.manaRegenPerTick),
      damageBuffs: player.damageBuffs.filter((buff) => buff.expiresAtTick > tick),
    };
  }

  return {
    state: {
      tick,
      player,
      enemies,
      nextEnemyId,
      nextSpawnTick,
      ambientSpawner: state.ambientSpawner,
      waveNumber,
      enemySlowExpiresAtTick,
      enemySlowMultiplier,
      over,
      rng,
    },
    events,
  };
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
