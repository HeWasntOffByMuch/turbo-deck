import { describe, expect, it } from 'vitest';
import { ENEMY_IDLE_TICKS, ENEMY_STANDOFF, ENEMY_WINDUP_TICKS, PLAYER_ATTACK_DAMAGE, PLAYER_ATTACK_WINDUP_TICKS, WAVE_BASE_COUNT } from './constants.js';
import { initCombat, step } from './combat.js';
import { enemyTypeByKey } from './enemies.js';
import { NEUTRAL_INPUT, type CombatState, type EnemyState, type ExternalEffect, type InputFrame, type SimEvent } from './types.js';

/** A wave-mode arena: no ambient spawns, no starting enemies. */
function waveArena(seed = 1): CombatState {
  return initCombat(seed, { ambientSpawner: false, initialEnemies: 0 });
}

function plant(state: CombatState, enemy: Partial<EnemyState>): CombatState {
  const p = state.player.position;
  const brawler = enemyTypeByKey('brawler');
  const base: EnemyState = {
    id: 1,
    type: 'brawler',
    health: brawler.maxHealth,
    maxHealth: brawler.maxHealth,
    position: { x: p.x + ENEMY_STANDOFF, y: p.y },
    behavior: 'hunting',
    phase: 'idle',
    phaseEndsAtTick: ENEMY_IDLE_TICKS,
    incomingAttackOutcome: 'none',
    attackAim: null,
    grazeTarget: null,
    grazeResumeTick: 0,
    ...enemy,
  };
  return { ...state, enemies: [base] };
}

function runFrom(state: CombatState, inputs: readonly InputFrame[]): { state: CombatState; events: SimEvent[] } {
  let s = state;
  const events: SimEvent[] = [];
  for (const input of inputs) {
    const r = step(s, input, undefined);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

function firstHitDamage(events: readonly SimEvent[]): number | undefined {
  return events.find((e): e is Extract<SimEvent, { kind: 'playerHit' }> => e.kind === 'playerHit')?.damage;
}

describe('wave spawner', () => {
  it('spawns an escalating burst of hunting enemies and counts the wave', () => {
    const r1 = step(waveArena(3), { ...NEUTRAL_INPUT, spawnWave: true });
    expect(r1.events.some((e) => e.kind === 'waveSpawned')).toBe(true);
    expect(r1.state.waveNumber).toBe(1);
    expect(r1.state.enemies).toHaveLength(WAVE_BASE_COUNT + 1);
    expect(r1.state.enemies.every((e) => e.behavior === 'hunting')).toBe(true);
    // Wave 1 uses base stats.
    for (const e of r1.state.enemies) expect(e.maxHealth).toBe(enemyTypeByKey(e.type).maxHealth);

    const idAfterWave1 = r1.state.nextEnemyId;
    const r2 = step(r1.state, { ...NEUTRAL_INPUT, spawnWave: true });
    expect(r2.state.waveNumber).toBe(2);
    const wave2 = r2.state.enemies.filter((e) => e.id >= idAfterWave1);
    expect(wave2).toHaveLength(WAVE_BASE_COUNT + 2);
    // Wave 2 enemies are tougher than their type's base health and hit harder.
    for (const e of wave2) {
      expect(e.maxHealth).toBeGreaterThan(enemyTypeByKey(e.type).maxHealth);
      expect(e.attackDamage ?? 0).toBeGreaterThan(enemyTypeByKey(e.type).attackDamage);
    }
  });

  it('with the ambient spawner off, no enemies appear without a wave', () => {
    let s = waveArena(5);
    for (let i = 0; i < 400; i++) s = step(s, NEUTRAL_INPUT).state;
    expect(s.enemies).toHaveLength(0);
  });
});

describe('wave speed & attack-speed scaling (spec 016)', () => {
  const only = (s: CombatState): EnemyState => {
    const e = s.enemies[0];
    if (e === undefined) throw new Error('expected exactly one enemy');
    return e;
  };
  const advance = (s: CombatState, n: number): CombatState => {
    for (let i = 0; i < n; i++) s = step(s, NEUTRAL_INPUT).state;
    return s;
  };

  it('leaves wave 1 at base speed but escalates later waves', () => {
    const r1 = step(waveArena(3), { ...NEUTRAL_INPUT, spawnWave: true });
    for (const e of r1.state.enemies) {
      expect(e.speedMult).toBe(1);
      expect(e.attackSpeedMult).toBe(1);
    }
    const idAfterWave1 = r1.state.nextEnemyId;
    const r2 = step(r1.state, { ...NEUTRAL_INPUT, spawnWave: true });
    for (const e of r2.state.enemies.filter((e) => e.id >= idAfterWave1)) {
      expect(e.speedMult ?? 1).toBeGreaterThan(1);
      expect(e.attackSpeedMult ?? 1).toBeGreaterThan(1);
    }
  });

  it('a higher speedMult homes toward the player faster', () => {
    const base = waveArena(1);
    const start = { x: base.player.position.x + 400, y: base.player.position.y };
    // Kept idle the whole time (phase never ends) so both only home, never plant for a swing.
    const slow = plant(base, { position: { ...start }, speedMult: 1, phase: 'idle', phaseEndsAtTick: 100_000 });
    const fast = plant(base, { position: { ...start }, speedMult: 1.5, phase: 'idle', phaseEndsAtTick: 100_000 });
    // Both close in (x decreases toward the player); the faster one covers more ground.
    expect(only(advance(fast, 20)).position.x).toBeLessThan(only(advance(slow, 20)).position.x);
  });

  it('a higher attackSpeedMult shortens the attack phases', () => {
    const base = waveArena(1);
    // phaseEndsAtTick 0 => the first step flips idle -> windup; read the resulting windup length.
    const windupLen = (mult: number): number => {
      const after = step(plant(base, { phase: 'idle', phaseEndsAtTick: 0, attackSpeedMult: mult }), NEUTRAL_INPUT).state;
      const e = only(after);
      expect(e.phase).toBe('windup');
      return e.phaseEndsAtTick - after.tick;
    };
    expect(windupLen(2)).toBeLessThan(windupLen(1));
  });

  it('replays identically across waves for a fixed seed and inputs', () => {
    const run = (): CombatState => {
      let s = waveArena(7);
      for (let i = 0; i < 5; i++) {
        s = step(s, { ...NEUTRAL_INPUT, spawnWave: true }).state;
        s = advance(s, 120);
      }
      return s;
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe('activated stance', () => {
  const bigStance = (over: Partial<Extract<ExternalEffect, { kind: 'applyStance' }>>): ExternalEffect => ({
    kind: 'applyStance',
    attackBonus: 0,
    reductionPct: 0,
    regenPerTick: 0,
    slowMultiplier: 1,
    durationTicks: 600,
    lockoutTicks: 600,
    ...over,
  });

  it('raises the player outgoing strike damage while held', () => {
    // A grazing enemy planted at standoff, in front of the player and within cone reach.
    const state = plant(waveArena(2), { behavior: 'grazing', phase: 'idle' });

    const attackAim: InputFrame = { ...NEUTRAL_INPUT, attack: true, aimX: 1, aimY: 0 };
    const withStance = runFrom(state, [
      { ...attackAim, externalEffect: bigStance({ attackBonus: 10 }) },
      ...Array.from({ length: PLAYER_ATTACK_WINDUP_TICKS }, () => NEUTRAL_INPUT),
    ]);
    const hit = withStance.events.find((e): e is Extract<SimEvent, { kind: 'enemyHit' }> => e.kind === 'enemyHit');
    expect(hit?.damage).toBe(PLAYER_ATTACK_DAMAGE + 10);
  });

  it('reduces incoming slam damage while held', () => {
    const hitTicks = ENEMY_IDLE_TICKS + ENEMY_WINDUP_TICKS + 2;
    const seq = (effect?: ExternalEffect): number | undefined => {
      const first: InputFrame = effect ? { ...NEUTRAL_INPUT, externalEffect: effect } : NEUTRAL_INPUT;
      const inputs = [first, ...Array.from({ length: hitTicks }, () => NEUTRAL_INPUT)];
      return firstHitDamage(runFrom(plant(waveArena(1), {}), inputs).events);
    };
    const baseline = seq();
    const reduced = seq(bigStance({ reductionPct: 0.5 }));
    expect(baseline).toBeGreaterThan(0);
    expect(reduced).toBeGreaterThan(0);
    expect(reduced as number).toBeLessThan(baseline as number);
  });

  it('is refused while the lockout is still in the future', () => {
    // First stance sets a long lockout; a second activate the next tick is rejected.
    const r1 = step(waveArena(1), { ...NEUTRAL_INPUT, externalEffect: bigStance({ attackBonus: 5 }) });
    expect(r1.events.some((e) => e.kind === 'stanceApplied')).toBe(true);
    const r2 = step(r1.state, { ...NEUTRAL_INPUT, externalEffect: bigStance({ attackBonus: 99 }) });
    expect(r2.events.some((e) => e.kind === 'stanceRejectedLocked')).toBe(true);
    expect(r2.state.player.stanceAttackBonus).toBe(5); // unchanged
  });
});

describe('enemy slow', () => {
  it('stretches the enemy telegraph so the slam lands later', () => {
    const hitTickOf = (effect?: ExternalEffect): number | null => {
      let s = plant(waveArena(1), {});
      let tick = 0;
      const first: InputFrame = effect ? { ...NEUTRAL_INPUT, externalEffect: effect } : NEUTRAL_INPUT;
      for (let i = 0; i < ENEMY_IDLE_TICKS + 4 * ENEMY_WINDUP_TICKS; i++) {
        const r = step(s, i === 0 ? first : NEUTRAL_INPUT);
        s = r.state;
        tick++;
        if (r.events.some((e) => e.kind === 'playerHit')) return tick;
      }
      return null;
    };
    const baseline = hitTickOf();
    const slowed = hitTickOf({ kind: 'slowEnemies', multiplier: 0.5, durationTicks: 600 });
    expect(baseline).not.toBeNull();
    expect(slowed).not.toBeNull();
    expect(slowed as number).toBeGreaterThan(baseline as number);
  });
});
