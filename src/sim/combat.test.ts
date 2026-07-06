import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ARENA_MAX,
  ARENA_MIN,
  ENEMY_ATTACK_DAMAGE,
  ENEMY_IDLE_TICKS,
  ENEMY_WINDUP_TICKS,
  MANA_REGEN_PER_TICK,
  PLAYER_MAX_HEALTH,
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
      moveDir: fc.constantFrom(-1, 0, 1),
      attack: fc.boolean(),
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
    const { state, events } = runSim(1, defendAt(HIT_TICK - 3));
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH);
    expect(events.some((e) => e.kind === 'perfectDefense')).toBe(true);
  });

  it('a defend input just outside the perfect window registers normal (halved damage)', () => {
    const { state, events } = runSim(1, defendAt(HIT_TICK - 4));
    expect(state.player.health).toBe(PLAYER_MAX_HEALTH - Math.round(ENEMY_ATTACK_DAMAGE / 2));
    expect(events.some((e) => e.kind === 'normalDefense')).toBe(true);
    expect(events.some((e) => e.kind === 'perfectDefense')).toBe(false);
  });

  it('a defend input far outside any window whiffs and takes full damage', () => {
    const { state, events } = runSim(1, defendAt(HIT_TICK - ENEMY_WINDUP_TICKS + 1));
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
  it('clamps player position to the arena regardless of how long a direction is held', () => {
    const inputs = neutralSteps(1000).map((f) => ({ ...f, moveDir: -1 as const }));
    const { state } = runSim(3, inputs);
    expect(state.player.position).toBe(ARENA_MIN);

    const inputsRight = neutralSteps(1000).map((f) => ({ ...f, moveDir: 1 as const }));
    const { state: stateRight } = runSim(3, inputsRight);
    expect(stateRight.player.position).toBe(ARENA_MAX);
  });
});
