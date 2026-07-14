import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  ATTACK_ROOT_TICKS,
  ENEMY_ATTACK_DAMAGE,
  ENEMY_IDLE_TICKS,
  ENEMY_RADIUS,
  ENEMY_RECOVERY_TICKS,
  ENEMY_STANDOFF,
  ENEMY_WINDUP_TICKS,
  MANA_REGEN_PER_TICK,
  MAX_ENEMIES,
  MOVE_ARRIVE_EPS,
  MOVE_SPEED_HARD_MAX,
  MOVE_SPEED_HARD_MIN,
  NORMAL_WINDOW_TICKS,
  PERFECT_WINDOW_TICKS,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_ATTACK_RANGE,
  PLAYER_ATTACK_WINDUP_TICKS,
  PLAYER_MAX_HEALTH,
  PLAYER_RADIUS,
} from './constants.js';
import { computeMoveSpeed, initCombat, runSim, step } from './combat.js';
import { enemyTypeByKey } from './enemies.js';
import {
  IDENTITY_MODIFIERS,
  NEUTRAL_INPUT,
  type CombatState,
  type EnemyState,
  type InputFrame,
  type Modifiers,
  type Vec2,
} from './types.js';

const BRAWLER = enemyTypeByKey('brawler');

// A standing grazing enemy at a fixed spot (grazeResumeTick far off so it does
// not wander), for deterministic cone/cleave tests.
function enemyAt(id: number, position: Vec2, overrides: Partial<EnemyState> = {}): EnemyState {
  return {
    id,
    type: 'brawler',
    health: BRAWLER.maxHealth,
    maxHealth: BRAWLER.maxHealth,
    position,
    behavior: 'grazing',
    phase: 'idle',
    phaseEndsAtTick: 0,
    incomingAttackOutcome: 'none',
    attackAim: null,
    grazeTarget: null,
    grazeResumeTick: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

/** Replace the population with `enemies` and disable the spawner for the test. */
function withEnemies(base: CombatState, enemies: EnemyState[]): CombatState {
  return { ...base, enemies, nextSpawnTick: Number.MAX_SAFE_INTEGER };
}

/** One hunting enemy planted at standoff to the player's right, fresh idle phase. */
function huntingState(seed = 1): CombatState {
  const base = initCombat(seed);
  const p = base.player.position;
  const enemy = enemyAt(1, { x: p.x + ENEMY_STANDOFF, y: p.y }, {
    behavior: 'hunting',
    phaseEndsAtTick: ENEMY_IDLE_TICKS,
    grazeResumeTick: 0,
  });
  return withEnemies(base, [enemy]);
}

function runFrom(state: CombatState, inputs: readonly InputFrame[], mods: Modifiers = IDENTITY_MODIFIERS): ReturnType<typeof step> {
  let s = state;
  let events: ReturnType<typeof step>['events'] = [];
  for (const input of inputs) {
    const r = step(s, input, mods);
    s = r.state;
    events = [...events, ...r.events];
  }
  return { state: s, events };
}

/** Press attack (waiting for readiness), advance through the wind-up, return the resolving tick. */
function swing(state: CombatState, aim: { aimX: number; aimY: number }, mods: Modifiers = IDENTITY_MODIFIERS): ReturnType<typeof step> {
  let s = state;
  while (s.player.attackReleaseTick !== 0 || s.tick < s.player.attackCooldownUntil) s = step(s, NEUTRAL_INPUT, mods).state;
  let r = step(s, { ...NEUTRAL_INPUT, attack: true, ...aim }, mods);
  s = r.state;
  while (s.player.attackReleaseTick !== 0) {
    r = step(s, NEUTRAL_INPUT, mods);
    s = r.state;
  }
  return r;
}

const HIT_TICK = ENEMY_IDLE_TICKS + ENEMY_WINDUP_TICKS; // first slam's resolution tick from a fresh idle

function neutralSteps(count: number): InputFrame[] {
  return Array.from({ length: count }, () => NEUTRAL_INPUT);
}

/** An input carrying a standing move order to a world point. */
function moveTo(x: number, y: number, extra: Partial<InputFrame> = {}): InputFrame {
  return { ...NEUTRAL_INPUT, moveTarget: { x, y }, ...extra };
}

/** Inputs through the first slam's resolution, pressing a defend input at `tick`. */
function defendAt(tick: number, type: 'parry' | 'dodge' = 'parry'): InputFrame[] {
  const inputs = neutralSteps(HIT_TICK);
  inputs[tick - 1] = { ...NEUTRAL_INPUT, parry: type === 'parry', dodge: type === 'dodge' };
  return inputs;
}

describe('combat sim determinism', () => {
  it('reproduces identical state and events for the same seed and input sequence', () => {
    const inputArb: fc.Arbitrary<InputFrame> = fc.record(
      {
        attack: fc.boolean(),
        aimX: fc.constantFrom(-1, 0, 1),
        aimY: fc.constantFrom(-1, 0, 1),
        parry: fc.boolean(),
        dodge: fc.boolean(),
        // Left out of requiredKeys: randomly present (a Vec2) or omitted entirely.
        moveTarget: fc.record({ x: fc.integer({ min: 0, max: ARENA_WIDTH }), y: fc.integer({ min: 0, max: ARENA_HEIGHT }) }),
      },
      { requiredKeys: ['attack', 'aimX', 'aimY', 'parry', 'dodge'] },
    );

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.array(inputArb, { maxLength: 300 }), (seed, inputs) => {
        const runA = runSim(seed, inputs);
        const runB = runSim(seed, inputs);
        expect(runA.state).toEqual(runB.state);
        expect(runA.events).toEqual(runB.events);
      }),
    );
  });
});

describe('perfect/normal/whiffed defense timing', () => {
  it('a defend input exactly on the hit tick registers perfect and negates damage', () => {
    const { state, events } = runFrom(huntingState(), defendAt(HIT_TICK));
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH);
    expect(events).toContainEqual({ kind: 'perfectDefense', defenseType: 'parry', tick: HIT_TICK });
    expect(events.some((e) => e.kind === 'playerHit')).toBe(false);
  });

  it('a defend input at the edge of the perfect window still registers perfect', () => {
    const { state, events } = runFrom(huntingState(), defendAt(HIT_TICK - PERFECT_WINDOW_TICKS));
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH);
    expect(events.some((e) => e.kind === 'perfectDefense')).toBe(true);
  });

  it('a defend input just outside the perfect window registers normal (halved damage)', () => {
    const { state, events } = runFrom(huntingState(), defendAt(HIT_TICK - PERFECT_WINDOW_TICKS - 1));
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH - Math.round(ENEMY_ATTACK_DAMAGE / 2));
    expect(events.some((e) => e.kind === 'normalDefense')).toBe(true);
    expect(events.some((e) => e.kind === 'perfectDefense')).toBe(false);
  });

  it('a defend input far outside any window whiffs and takes full damage', () => {
    const { state, events } = runFrom(huntingState(), defendAt(HIT_TICK - NORMAL_WINDOW_TICKS - 5));
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH - ENEMY_ATTACK_DAMAGE);
    expect(events.some((e) => e.kind === 'perfectDefense')).toBe(false);
    expect(events.some((e) => e.kind === 'normalDefense')).toBe(false);
    expect(events.some((e) => e.kind === 'playerHit')).toBe(true);
  });

  it('no defend input at all takes full damage', () => {
    const { state, events } = runFrom(huntingState(), neutralSteps(HIT_TICK));
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH - ENEMY_ATTACK_DAMAGE);
    expect(events).toContainEqual({ kind: 'playerHit', damage: ENEMY_ATTACK_DAMAGE, tick: HIT_TICK });
  });

  it('only the first defend input in a windup is registered; a second one is a no-op', () => {
    const inputs = neutralSteps(HIT_TICK);
    inputs[HIT_TICK - 10] = { ...NEUTRAL_INPUT, parry: true }; // normal-window attempt, locks in 'normal'
    inputs[HIT_TICK - 1] = { ...NEUTRAL_INPUT, parry: true }; // would be perfect, but should be ignored
    const { state, events } = runFrom(huntingState(), inputs);
    expect(events.filter((e) => e.kind === 'normalDefense' || e.kind === 'perfectDefense')).toHaveLength(1);
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH - Math.round(ENEMY_ATTACK_DAMAGE / 2));
  });
});

describe('mana gating for external effects', () => {
  it('rejects an effect that costs more mana than available and leaves state unchanged', () => {
    const inputs: InputFrame[] = [{ ...NEUTRAL_INPUT, externalEffect: { kind: 'healPlayer', manaCost: 999, amount: 5 } }];
    const before = initCombat(2);
    const { state, events } = runSim(2, inputs);
    expect(state.player.mana).toBeCloseTo(before.player.mana, 5);
    expect(state.player.health).toBe(before.player.health);
    expect(events).toContainEqual({ kind: 'effectRejectedInsufficientMana', tick: 1 });
  });

  it('applies an affordable effect and spends exactly its mana cost', () => {
    const before = initCombat(2);
    const inputs: InputFrame[] = [{ ...NEUTRAL_INPUT, externalEffect: { kind: 'healPlayer', manaCost: 2, amount: 40 } }];
    const damaged = { ...before, player: { ...before.player, health: 10 } };
    const { state: result } = step(damaged, inputs[0] as InputFrame);
    expect(result.player.health).toBe(50);
    expect(result.player.mana).toBeCloseTo(before.player.mana - 2 + MANA_REGEN_PER_TICK, 10);
  });
});

describe('movement bounds', () => {
  it('clamps player position to the arena rectangle regardless of how long a move order stands', () => {
    // Order past the top-left corner: the unit walks to the edge and clamps there.
    const topLeft = Array.from({ length: 1000 }, () => moveTo(-500, -500));
    const { state } = runSim(3, topLeft);
    expect(state.player.position.x).toBe(PLAYER_RADIUS);
    expect(state.player.position.y).toBe(PLAYER_RADIUS);

    const bottomRight = Array.from({ length: 1000 }, () => moveTo(ARENA_WIDTH + 500, ARENA_HEIGHT + 500));
    const { state: br } = runSim(3, bottomRight);
    expect(br.player.position.x).toBe(ARENA_WIDTH - PLAYER_RADIUS);
    expect(br.player.position.y).toBe(ARENA_HEIGHT - PLAYER_RADIUS);
  });
});

describe('MOBA movement: speed, turn rate, facing gate', () => {
  it('computeMoveSpeed applies flat/pct/slow terms and clamps to [100, 550]', () => {
    expect(computeMoveSpeed(300)).toBe(300);
    expect(computeMoveSpeed(300, 100)).toBe(400); // flat bonus
    expect(computeMoveSpeed(300, 0, 1.5)).toBe(450); // percentage bonus
    expect(computeMoveSpeed(300, 0, 1, [{ multiplier: 0.5 }])).toBe(150); // a 50% slow
    // A slow damped to half strength by slow resistance: 1 - (1 - 0.5) * 0.5 = 0.75.
    expect(computeMoveSpeed(300, 0, 1, [{ multiplier: 0.5, resistance: 0.5 }])).toBe(225);
    expect(computeMoveSpeed(9999)).toBe(MOVE_SPEED_HARD_MAX);
    expect(computeMoveSpeed(1)).toBe(MOVE_SPEED_HARD_MIN);
  });

  it('starts translating on the first tick for an order within the facing gate', () => {
    const base = initCombat(1); // player faces +x (east)
    const start = base.player.position;
    const { state } = step(base, moveTo(start.x + 300, start.y)); // due east, already faced
    expect(state.player.position.x).toBeGreaterThan(start.x);
    expect(state.player.position.y).toBeCloseTo(start.y, 6);
  });

  it('an order directly behind only rotates on the first tick — zero translation', () => {
    const base = initCombat(1); // faces east; order is due west (180 degrees behind)
    const start = base.player.position;
    const { state } = step(base, moveTo(start.x - 300, start.y));
    expect(state.player.position).toEqual(start); // gate closed: no movement yet
    expect(state.player.facing).not.toBe(0); // but it has begun turning
  });

  it('travels in a straight line to the target — no arc even when it must turn', () => {
    // Order due south from a unit facing east: it should move straight down the
    // x=start.x line the entire way (perpendicular offset stays ~0), never bowing
    // east along its lagging facing.
    let s = initCombat(1);
    const start = s.player.position;
    const target = { x: start.x, y: start.y + 300 };
    let maxOffset = 0;
    for (let i = 0; i < 120; i++) {
      s = step(s, moveTo(target.x, target.y)).state;
      maxOffset = Math.max(maxOffset, Math.abs(s.player.position.x - start.x));
      if (s.player.moveTarget === null) break;
    }
    expect(maxOffset).toBeLessThanOrEqual(1e-6); // dead straight, no arc
    expect(s.player.position.y).toBeGreaterThan(start.y + 100);
  });

  it('reaches a reachable order and clears the standing move target (no drift after)', () => {
    let s = initCombat(1);
    const target = { x: s.player.position.x + 220, y: s.player.position.y - 160 };
    for (let i = 0; i < 300; i++) s = step(s, moveTo(target.x, target.y)).state;
    const dist = Math.hypot(s.player.position.x - target.x, s.player.position.y - target.y);
    expect(dist).toBeLessThanOrEqual(MOVE_ARRIVE_EPS);
    expect(s.player.moveTarget).toBeNull();
    // With the order cleared and no new one, the unit does not drift (no momentum).
    const held = s.player.position;
    s = step(s, NEUTRAL_INPUT).state;
    expect(s.player.position).toEqual(held);
  });

  it('with no move order, facing eases toward the aim direction', () => {
    let s = initCombat(1); // faces east
    for (let i = 0; i < 300; i++) s = step(s, { ...NEUTRAL_INPUT, aimX: 0, aimY: 1 }).state; // aim south
    expect(s.player.facing).toBeCloseTo(Math.PI / 2, 5);
  });
});

describe('positional telegraph (cone)', () => {
  it('side-stepping out of the cone during windup avoids the hit', () => {
    // Stand still through the idle phase so the cone is aimed straight at rest,
    // then order a move straight south (perpendicular to the westward cone) once
    // the windup begins; by resolution the player has left the wedge.
    const inputs = neutralSteps(HIT_TICK);
    for (let t = ENEMY_IDLE_TICKS; t < HIT_TICK; t++) inputs[t] = moveTo(ARENA_WIDTH / 2, ARENA_HEIGHT * 2);
    const { state, events } = runFrom(huntingState(), inputs);
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH);
    expect(events.some((e) => e.kind === 'playerHit')).toBe(false);
    expect(events.some((e) => e.kind === 'enemyAttackAvoided')).toBe(true);
  });

  it('standing still inside the cone with no defense takes the full hit', () => {
    const { state, events } = runFrom(huntingState(), neutralSteps(HIT_TICK));
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH - ENEMY_ATTACK_DAMAGE);
    expect(events.some((e) => e.kind === 'playerHit')).toBe(true);
    expect(events.some((e) => e.kind === 'enemyAttackAvoided')).toBe(false);
  });
});

describe('enemies attack only when in range', () => {
  it('a hunting enemy the player keeps outrunning never winds up or lands a hit', () => {
    const base = initCombat(1);
    const p = base.player.position;
    // Far to the right, well beyond the trigger range, freshly hunting.
    const enemy = enemyAt(1, { x: p.x + 400, y: p.y }, {
      behavior: 'hunting',
      phaseEndsAtTick: ENEMY_IDLE_TICKS,
      grazeResumeTick: 0,
    });
    // Sprint left, faster than the enemy homes, so it never closes to reach.
    const inputs = Array.from({ length: 150 }, () => moveTo(-500, p.y));
    const { state, events } = runFrom(withEnemies(base, [enemy]), inputs);
    expect(state.enemies[0]?.phase).toBe('idle'); // never committed to a windup
    expect(events.some((e) => e.kind === 'playerHit')).toBe(false);
  });
});

describe('aimed attack cone', () => {
  // One enemy planted just within reach, directly to the player's right.
  function stateWithEnemyInRange(): CombatState {
    const base = initCombat(9);
    const p = base.player.position;
    return withEnemies(base, [enemyAt(1, { x: p.x + PLAYER_ATTACK_RANGE + ENEMY_RADIUS - 5, y: p.y })]);
  }

  it('connects when the enemy is in range and inside the aim cone', () => {
    const { events } = swing(stateWithEnemyInRange(), { aimX: 1, aimY: 0 });
    expect(events.some((e) => e.kind === 'enemyHit')).toBe(true);
    expect(events.some((e) => e.kind === 'attackMissed')).toBe(false);
  });

  it('misses an in-range enemy when aimed away from it', () => {
    const { events } = swing(stateWithEnemyInRange(), { aimX: -1, aimY: 0 });
    expect(events.some((e) => e.kind === 'attackMissed')).toBe(true);
    expect(events.some((e) => e.kind === 'enemyHit')).toBe(false);
  });

  it('does not deal damage on the press tick; the strike lands one wind-up later', () => {
    const press = step(stateWithEnemyInRange(), { ...NEUTRAL_INPUT, attack: true, aimX: 1, aimY: 0 });
    expect(press.events.some((e) => e.kind === 'enemyHit')).toBe(false);
    expect(press.state.player.attackReleaseTick).toBe(1 + PLAYER_ATTACK_WINDUP_TICKS);
  });

  it('one swing cleaves every enemy inside the cone', () => {
    const base = initCombat(9);
    const p = base.player.position;
    const state = withEnemies(base, [
      enemyAt(1, { x: p.x + 40, y: p.y }),
      enemyAt(2, { x: p.x + 45, y: p.y - 12 }),
    ]);
    const { events } = swing(state, { aimX: 1, aimY: 0 });
    const hits = events.filter((e) => e.kind === 'enemyHit');
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => (h as { enemyId: number }).enemyId))).toEqual(new Set([1, 2]));
  });
});

describe('attack commitment (stop when attacking)', () => {
  it('roots the player through the wind-up and recovery, then movement resumes', () => {
    let s = huntingState(11);
    const startX = s.player.position.x;
    const east = moveTo(ARENA_WIDTH * 2, s.player.position.y, { attack: true, aimX: 1 });
    const eastMove = moveTo(ARENA_WIDTH * 2, s.player.position.y);
    s = step(s, east).state;
    expect(s.player.position.x).toBe(startX);
    for (let i = 0; i < PLAYER_ATTACK_WINDUP_TICKS - 1; i++) s = step(s, eastMove).state;
    expect(s.player.position.x).toBe(startX);
    for (let i = 0; i < ATTACK_ROOT_TICKS + 3; i++) s = step(s, eastMove).state;
    expect(s.player.position.x).toBeGreaterThan(startX);
  });
});

describe('passive modifiers', () => {
  function plant(seed: number): CombatState {
    const base = initCombat(seed);
    const p = base.player.position;
    return withEnemies(base, [enemyAt(1, { x: p.x + PLAYER_ATTACK_RANGE + ENEMY_RADIUS - 5, y: p.y })]);
  }
  const hitDamage = (events: readonly { kind: string }[]): number | undefined => {
    const hit = events.find((e) => e.kind === 'enemyHit');
    return hit && 'damage' in hit ? (hit as { damage: number }).damage : undefined;
  };

  it('attackDamage bonus adds flat damage to each strike', () => {
    const mods: Modifiers = { ...IDENTITY_MODIFIERS, attackDamageBonus: 5 };
    const { events } = swing(plant(21), { aimX: 1, aimY: 0 }, mods);
    expect(hitDamage(events)).toBe(PLAYER_ATTACK_DAMAGE + 5);
  });

  it('every Nth strike gets the bonus, other strikes do not', () => {
    const mods: Modifiers = { ...IDENTITY_MODIFIERS, nthStrikeEveryN: 2, nthStrikeBonusFraction: 0.5 };
    const first = swing(plant(22), { aimX: 1, aimY: 0 }, mods); // strike 1
    const second = swing(first.state, { aimX: 1, aimY: 0 }, mods); // strike 2
    expect(hitDamage(first.events)).toBe(PLAYER_ATTACK_DAMAGE);
    expect(hitDamage(second.events)).toBe(Math.round(PLAYER_ATTACK_DAMAGE * 1.5));
  });

  it('healthRegen restores health over time', () => {
    const mods: Modifiers = { ...IDENTITY_MODIFIERS, healthRegenPerTick: 1 };
    let s = initCombat(23);
    s = { ...s, player: { ...s.player, health: 50 } };
    for (let i = 0; i < 10; i++) s = step(s, NEUTRAL_INPUT, mods).state;
    expect(s.player.health).toBe(60);
  });

  it('healOnHurt heals after surviving a hit and emits playerHealed', () => {
    const mods: Modifiers = { ...IDENTITY_MODIFIERS, healOnHurt: 10 };
    const { state, events } = runFrom(huntingState(), neutralSteps(HIT_TICK), mods);
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH - ENEMY_ATTACK_DAMAGE + 10);
    expect(events.some((e) => e.kind === 'playerHealed' && e.amount === 10)).toBe(true);
  });

  it('enemyTempo makes the slam land sooner and hit for less', () => {
    const mods: Modifiers = { ...IDENTITY_MODIFIERS, enemySpeedMultiplier: 0.5, enemyDamageMultiplier: 0.5 };
    const early = ENEMY_IDLE_TICKS + Math.round(ENEMY_WINDUP_TICKS * 0.5);
    const reduced = Math.round(ENEMY_ATTACK_DAMAGE * 0.5);
    const { state, events } = runFrom(huntingState(), neutralSteps(early), mods);
    expect(events.some((e) => e.kind === 'playerHit' && e.damage === reduced)).toBe(true);
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH - reduced);
    const baseline = runFrom(huntingState(), neutralSteps(early));
    expect(baseline.events.some((e) => e.kind === 'playerHit')).toBe(false);
  });
});

describe('hunting enemy plants while attacking', () => {
  it('holds position across every windup and recovery tick, moving only during idle', () => {
    let s = huntingState(13);
    let windupPos: string | null = null;
    let recoveryPos: string | null = null;
    let idleMoved = false;
    const cycle = ENEMY_IDLE_TICKS + ENEMY_WINDUP_TICKS + ENEMY_RECOVERY_TICKS;
    let prevIdleKey: string | null = null;
    // Drift the player east (its start heading) so the idle-homing enemy has
    // somewhere to close; the order stands for the whole cycle.
    const eastMove = moveTo(ARENA_WIDTH * 2, s.player.position.y);
    for (let t = 1; t <= cycle; t++) {
      const before = (s.enemies[0] as EnemyState).position;
      s = step(s, eastMove).state;
      const e = s.enemies[0] as EnemyState;
      const key = `${e.position.x},${e.position.y}`;
      if (e.phase === 'windup') {
        if (windupPos === null) windupPos = key;
        else expect(key).toBe(windupPos);
      } else if (e.phase === 'recovery') {
        if (recoveryPos === null) recoveryPos = key;
        else expect(key).toBe(recoveryPos);
      } else {
        const movedNow = e.position.x !== before.x || e.position.y !== before.y;
        if (movedNow && prevIdleKey !== key) idleMoved = true;
        prevIdleKey = key;
      }
    }
    expect(idleMoved).toBe(true);
  });
});

describe('population: spawner, grazing, death', () => {
  it('never exceeds the enemy cap across a long run', () => {
    let s = initCombat(31);
    for (let t = 0; t < 2000; t++) {
      s = step(s, NEUTRAL_INPUT).state;
      expect(s.enemies.length).toBeLessThanOrEqual(MAX_ENEMIES);
    }
  });

  it('leaves untouched enemies passive: they never hunt or hit the player', () => {
    // Player stands still and never attacks; the herd should just graze.
    const { state, events } = runSim(31, neutralSteps(600));
    expect(events.some((e) => e.kind === 'playerHit')).toBe(false);
    expect(state.enemies.every((e) => e.behavior === 'grazing')).toBe(true);
  });

  it('keeps grazing enemies inside the arena bounds', () => {
    const { state } = runSim(37, neutralSteps(1500));
    for (const e of state.enemies) {
      expect(e.position.x).toBeGreaterThanOrEqual(ENEMY_RADIUS);
      expect(e.position.x).toBeLessThanOrEqual(ARENA_WIDTH - ENEMY_RADIUS);
      expect(e.position.y).toBeGreaterThanOrEqual(ENEMY_RADIUS);
      expect(e.position.y).toBeLessThanOrEqual(ARENA_HEIGHT - ENEMY_RADIUS);
    }
  });

  it('an attacked enemy switches from grazing to hunting', () => {
    const base = initCombat(9);
    const p = base.player.position;
    const state = withEnemies(base, [enemyAt(1, { x: p.x + 40, y: p.y })]);
    expect(state.enemies[0]?.behavior).toBe('grazing');
    const { state: after } = swing(state, { aimX: 1, aimY: 0 });
    expect(after.enemies[0]?.behavior).toBe('hunting');
  });

  it('a lethal blow removes the enemy and emits enemyDefeated', () => {
    const base = initCombat(9);
    const p = base.player.position;
    const state = withEnemies(base, [enemyAt(1, { x: p.x + 40, y: p.y }, { health: 4, maxHealth: 4 })]);
    const { state: after, events } = swing(state, { aimX: 1, aimY: 0 });
    expect(after.enemies.some((e) => e.id === 1)).toBe(false);
    expect(events.some((e) => e.kind === 'enemyDefeated' && e.enemyId === 1)).toBe(true);
  });
});

describe('player death', () => {
  it('sets the game over, emits playerDefeated once, and then freezes the sim', () => {
    const base = huntingState();
    const state = { ...base, player: { ...base.player, health: 5 } };
    const { state: dead, events } = runFrom(state, neutralSteps(HIT_TICK));
    expect(dead.over).toBe(true);
    expect(events.filter((e) => e.kind === 'playerDefeated')).toHaveLength(1);

    // Further steps are inert.
    const next = step(dead, moveTo(ARENA_WIDTH * 2, dead.player.position.y));
    expect(next.state).toBe(dead);
    expect(next.events).toEqual([]);
  });
});
