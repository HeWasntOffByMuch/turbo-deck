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
  ENEMY_WINDUP_TICKS,
  MANA_REGEN_PER_TICK,
  NORMAL_WINDOW_TICKS,
  PERFECT_WINDOW_TICKS,
  PLAYER_ATTACK_RANGE,
  PLAYER_MAX_HEALTH,
  PLAYER_RADIUS,
} from './constants.js';
import { initCombat, runSim, step } from './combat.js';
import { NEUTRAL_INPUT, type InputFrame } from './types.js';

const HIT_TICK = ENEMY_IDLE_TICKS + ENEMY_WINDUP_TICKS; // first attack's resolution tick

function neutralSteps(count: number): InputFrame[] {
  return Array.from({ length: count }, () => NEUTRAL_INPUT);
}

/** Builds a full run through the first attack's resolution, pressing a defend input at `tick`. */
function defendAt(tick: number, type: 'parry' | 'dodge' = 'parry'): InputFrame[] {
  const inputs = neutralSteps(HIT_TICK);
  inputs[tick - 1] = { ...NEUTRAL_INPUT, parry: type === 'parry', dodge: type === 'dodge' };
  return inputs;
}

describe('combat sim determinism', () => {
  it('reproduces identical state and events for the same seed and input sequence', () => {
    const inputArb: fc.Arbitrary<InputFrame> = fc.record({
      moveX: fc.constantFrom(-1, 0, 1),
      moveY: fc.constantFrom(-1, 0, 1),
      attack: fc.boolean(),
      aimX: fc.constantFrom(-1, 0, 1),
      aimY: fc.constantFrom(-1, 0, 1),
      parry: fc.boolean(),
      dodge: fc.boolean(),
    });

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
    const { state, events } = runSim(1, defendAt(HIT_TICK));
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH);
    expect(events).toContainEqual({ kind: 'perfectDefense', defenseType: 'parry', tick: HIT_TICK });
    expect(events.some((e) => e.kind === 'playerHit')).toBe(false);
  });

  it('a defend input at the edge of the perfect window still registers perfect', () => {
    const { state, events } = runSim(1, defendAt(HIT_TICK - PERFECT_WINDOW_TICKS));
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH);
    expect(events.some((e) => e.kind === 'perfectDefense')).toBe(true);
  });

  it('a defend input just outside the perfect window registers normal (halved damage)', () => {
    const { state, events } = runSim(1, defendAt(HIT_TICK - PERFECT_WINDOW_TICKS - 1));
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH - Math.round(ENEMY_ATTACK_DAMAGE / 2));
    expect(events.some((e) => e.kind === 'normalDefense')).toBe(true);
    expect(events.some((e) => e.kind === 'perfectDefense')).toBe(false);
  });

  it('a defend input far outside any window whiffs and takes full damage', () => {
    const { state, events } = runSim(1, defendAt(HIT_TICK - NORMAL_WINDOW_TICKS - 5));
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH - ENEMY_ATTACK_DAMAGE);
    expect(events.some((e) => e.kind === 'perfectDefense')).toBe(false);
    expect(events.some((e) => e.kind === 'normalDefense')).toBe(false);
    expect(events.some((e) => e.kind === 'playerHit')).toBe(true);
  });

  it('no defend input at all takes full damage', () => {
    const { state, events } = runSim(1, neutralSteps(HIT_TICK));
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH - ENEMY_ATTACK_DAMAGE);
    expect(events).toContainEqual({ kind: 'playerHit', damage: ENEMY_ATTACK_DAMAGE, tick: HIT_TICK });
  });

  it('only the first defend input in a windup is registered; a second one is a no-op', () => {
    const inputs = neutralSteps(HIT_TICK);
    inputs[HIT_TICK - 10] = { ...NEUTRAL_INPUT, parry: true }; // normal-window attempt, locks in 'normal'
    inputs[HIT_TICK - 1] = { ...NEUTRAL_INPUT, parry: true }; // would be perfect, but should be ignored
    const { state, events } = runSim(1, inputs);
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
  it('clamps player position to the arena rectangle regardless of how long a direction is held', () => {
    const topLeft = neutralSteps(1000).map((f) => ({ ...f, moveX: -1 as const, moveY: -1 as const }));
    const { state } = runSim(3, topLeft);
    expect(state.player.position.x).toBe(PLAYER_RADIUS);
    expect(state.player.position.y).toBe(PLAYER_RADIUS);

    const bottomRight = neutralSteps(1000).map((f) => ({ ...f, moveX: 1 as const, moveY: 1 as const }));
    const { state: br } = runSim(3, bottomRight);
    expect(br.player.position.x).toBe(ARENA_WIDTH - PLAYER_RADIUS);
    expect(br.player.position.y).toBe(ARENA_HEIGHT - PLAYER_RADIUS);
  });
});

describe('positional telegraph', () => {
  it('moving fully out of the danger zone during windup avoids the hit', () => {
    // Sprint sideways (with open floor ahead) the whole run; the zone is snapshotted
    // at the player's position when windup begins, so by resolution the player is clear.
    const inputs = neutralSteps(HIT_TICK).map((f) => ({ ...f, moveX: 1 as const }));
    const { state, events } = runSim(7, inputs);
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH);
    expect(events.some((e) => e.kind === 'playerHit')).toBe(false);
    expect(events.some((e) => e.kind === 'enemyAttackAvoided')).toBe(true);
  });

  it('standing still inside the zone with no defense takes the full hit', () => {
    const { state, events } = runSim(7, neutralSteps(HIT_TICK));
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH - ENEMY_ATTACK_DAMAGE);
    expect(events.some((e) => e.kind === 'playerHit')).toBe(true);
    expect(events.some((e) => e.kind === 'enemyAttackAvoided')).toBe(false);
  });
});

describe('aimed attack cone', () => {
  // Craft a state with the enemy planted just within reach, directly to the player's right.
  function stateWithEnemyInRange(): ReturnType<typeof step>['state'] {
    const base = initCombat(9);
    const enemyX = base.player.position.x + PLAYER_ATTACK_RANGE + ENEMY_RADIUS - 5;
    return { ...base, enemy: { ...base.enemy, position: { x: enemyX, y: base.player.position.y } } };
  }

  it('connects when the enemy is in range and inside the aim cone', () => {
    const s = stateWithEnemyInRange();
    const { events } = step(s, { ...NEUTRAL_INPUT, attack: true, aimX: 1, aimY: 0 }); // aim right, at the enemy
    expect(events.some((e) => e.kind === 'enemyHit')).toBe(true);
    expect(events.some((e) => e.kind === 'attackMissed')).toBe(false);
  });

  it('misses an in-range enemy when aimed away from it', () => {
    const s = stateWithEnemyInRange();
    const { events } = step(s, { ...NEUTRAL_INPUT, attack: true, aimX: -1, aimY: 0 }); // aim left, away from the enemy
    expect(events.some((e) => e.kind === 'attackMissed')).toBe(true);
    expect(events.some((e) => e.kind === 'enemyHit')).toBe(false);
  });
});

describe('attack commitment (stop when attacking)', () => {
  it('roots the player on the swing and through the root window, then resumes', () => {
    let s = initCombat(11);
    const startX = s.player.position.x;
    // Swing on tick 1 while holding right: the player must not move.
    s = step(s, { ...NEUTRAL_INPUT, attack: true, moveX: 1, aimX: 1 }).state;
    expect(s.player.position.x).toBe(startX);
    // Still planted for the rest of the root window despite holding right.
    for (let t = 2; t <= ATTACK_ROOT_TICKS; t++) s = step(s, { ...NEUTRAL_INPUT, moveX: 1 }).state;
    expect(s.player.position.x).toBe(startX);
    // Once the root expires, movement resumes.
    s = step(s, { ...NEUTRAL_INPUT, moveX: 1 }).state;
    expect(s.player.position.x).toBeGreaterThan(startX);
  });
});

describe('enemy plants while attacking', () => {
  it('holds position across every windup and recovery tick, moving only during idle', () => {
    let s = initCombat(13);
    let windupPos: string | null = null;
    let recoveryPos: string | null = null;
    let idleMoved = false;
    const cycle = ENEMY_IDLE_TICKS + ENEMY_WINDUP_TICKS + ENEMY_RECOVERY_TICKS;
    let prevIdleKey: string | null = null;
    for (let t = 1; t <= cycle; t++) {
      const before = s.enemy.position;
      s = step(s, NEUTRAL_INPUT).state;
      const key = `${s.enemy.position.x},${s.enemy.position.y}`;
      if (s.enemy.phase === 'windup') {
        if (windupPos === null) windupPos = key;
        else expect(key).toBe(windupPos);
      } else if (s.enemy.phase === 'recovery') {
        if (recoveryPos === null) recoveryPos = key;
        else expect(key).toBe(recoveryPos);
      } else {
        // idle: it should be closing on the (stationary) player at least once
        const movedNow = s.enemy.position.x !== before.x || s.enemy.position.y !== before.y;
        if (movedNow && prevIdleKey !== key) idleMoved = true;
        prevIdleKey = key;
      }
    }
    expect(idleMoved).toBe(true);
  });
});
