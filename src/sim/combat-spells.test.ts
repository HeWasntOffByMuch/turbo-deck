import { describe, expect, it } from 'vitest';
import type { SpellSpec } from '../shared/spell-spec.js';
import { ARENA_HEIGHT, ARENA_WIDTH, ENEMY_STANDOFF } from './constants.js';
import { initCombat, step } from './combat.js';
import { NEUTRAL_INPUT, type CombatState, type EnemyState, type InputFrame, type SimEvent } from './types.js';

const CENTER = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

function arena(seed = 1): CombatState {
  return initCombat(seed, { ambientSpawner: false, initialEnemies: 0 });
}

/** Drop a stationary (idle, never-wandering) enemy into the arena. */
function withEnemy(state: CombatState, partial: Partial<EnemyState> & { position: EnemyState['position'] }): CombatState {
  const enemy: EnemyState = {
    id: state.nextEnemyId,
    type: 'brawler',
    health: 200,
    maxHealth: 200,
    behavior: 'grazing',
    phase: 'idle',
    phaseEndsAtTick: 0,
    incomingAttackOutcome: 'none',
    attackAim: null,
    grazeTarget: null,
    grazeResumeTick: Number.MAX_SAFE_INTEGER, // stands still forever
    ...partial,
  };
  return { ...state, enemies: [...state.enemies, enemy], nextEnemyId: state.nextEnemyId + 1 };
}

function cast(spells: SpellSpec[], target = CENTER, aim = { x: 1, y: 0 }): InputFrame {
  return { ...NEUTRAL_INPUT, externalEffect: { kind: 'castSpells', spells, aimX: aim.x, aimY: aim.y, targetX: target.x, targetY: target.y } };
}

function run(state: CombatState, inputs: readonly InputFrame[]): { state: CombatState; events: SimEvent[] } {
  let s = state;
  const events: SimEvent[] = [];
  for (const input of inputs) {
    const r = step(s, input);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

const only = (s: CombatState): EnemyState => {
  const e = s.enemies[0];
  if (!e) throw new Error('expected an enemy');
  return e;
};

describe('cone spell', () => {
  it('damages an enemy in the cone but spares one behind the player', () => {
    let state = withEnemy(arena(), { id: 1, position: { x: CENTER.x + 40, y: CENTER.y } });
    state = withEnemy(state, { id: 2, position: { x: CENTER.x - 40, y: CENTER.y } });
    const spec: SpellSpec = { kind: 'cone', range: 72, arcCosSq: 0.5, damage: 12 };
    const after = run(state, [cast([spec])]).state;
    expect(after.enemies.find((e) => e.id === 1)?.health).toBe(200 - 12);
    expect(after.enemies.find((e) => e.id === 2)?.health).toBe(200);
  });
});

describe('rect spell', () => {
  it('damages an enemy in the rectangle and spares one beside it', () => {
    let state = withEnemy(arena(), { id: 1, position: { x: CENTER.x + 80, y: CENTER.y } }); // in front
    state = withEnemy(state, { id: 2, position: { x: CENTER.x + 40, y: CENTER.y + 60 } }); // off to the side
    const spec: SpellSpec = { kind: 'rect', length: 165, halfWidth: 26, damage: 16 };
    const after = run(state, [cast([spec])]).state;
    expect(after.enemies.find((e) => e.id === 1)?.health).toBe(200 - 16);
    expect(after.enemies.find((e) => e.id === 2)?.health).toBe(200);
  });
});

describe('aura spell', () => {
  it('pulses damage to a nearby enemy on a cadence', () => {
    const state = withEnemy(arena(), { id: 1, position: { x: CENTER.x + 50, y: CENTER.y } });
    const spec: SpellSpec = { kind: 'aura', radius: 95, pulseDamage: 5, pulseIntervalTicks: 12, durationTicks: 180 };
    // Cast, then idle for two pulse intervals.
    const inputs = [cast([spec]), ...Array.from({ length: 26 }, () => NEUTRAL_INPUT)];
    const after = run(state, inputs).state;
    expect(only(after).health).toBe(200 - 10); // exactly two 5-damage pulses
  });
});

describe('telegraphed point AOE', () => {
  it('only damages at the impact tick', () => {
    const state = withEnemy(arena(), { id: 1, position: { x: CENTER.x + 100, y: CENTER.y } });
    const target = { x: CENTER.x + 100, y: CENTER.y };
    const spec: SpellSpec = { kind: 'pointAoe', origin: 'target', radius: 92, damage: 40, stunTicks: 0, delayTicks: 30, count: 1, spreadTicks: 0 };
    const early = run(state, [cast([spec], target), ...Array.from({ length: 5 }, () => NEUTRAL_INPUT)]);
    expect(only(early.state).health).toBe(200); // telegraph still pending
    const late = run(early.state, Array.from({ length: 30 }, () => NEUTRAL_INPUT));
    expect(only(late.state).health).toBe(200 - 40);
    expect(late.events.some((e) => e.kind === 'aoeImpact')).toBe(true);
  });
});

describe('stun', () => {
  it('freezes a hunting enemy so it stops closing in', () => {
    const start = { x: CENTER.x + 300, y: CENTER.y };
    const state = withEnemy(arena(), { id: 1, position: start, behavior: 'hunting', phaseEndsAtTick: 1_000_000 });
    const spec: SpellSpec = { kind: 'pointAoe', origin: 'target', radius: 92, damage: 0, stunTicks: 60, delayTicks: 0, count: 1, spreadTicks: 0 };
    const casted = run(state, [cast([spec], start)]).state;
    const frozenAt = only(casted).position; // stun lands after this tick's homing step
    const after = run(casted, Array.from({ length: 20 }, () => NEUTRAL_INPUT)).state;
    // Once stunned, an idle hunter must stop closing in entirely.
    expect(only(after).position).toEqual(frozenAt);
    expect(only(after).stunnedUntilTick).toBeGreaterThan(after.tick);
  });
});

describe('dash spell', () => {
  it('moves the player and a damaging dash strikes a body once', () => {
    const state = withEnemy(arena(), { id: 1, position: { x: CENTER.x + 60, y: CENTER.y } });
    const spec: SpellSpec = { kind: 'dash', distance: 320, durationTicks: 17, damage: 16 };
    const after = run(state, [cast([spec], CENTER, { x: 1, y: 0 }), ...Array.from({ length: 20 }, () => NEUTRAL_INPUT)]).state;
    expect(after.player.position.x).toBeGreaterThan(CENTER.x + 100); // travelled forward
    expect(only(after).health).toBe(200 - 16); // struck exactly once, not per tick
  });
});

describe('shield', () => {
  it('absorbs an enemy slam before the player takes damage', () => {
    const base = arena();
    const p = base.player.position;
    const withShield: CombatState = {
      ...base,
      player: { ...base.player, shieldAmount: 100, shieldExpiresAtTick: base.tick + 100 },
    };
    // A hunting enemy planted mid-wind-up, aimed at the player, slamming next tick.
    const enemyPartial = {
      id: 1,
      position: { x: p.x + ENEMY_STANDOFF, y: p.y },
      behavior: 'hunting' as const,
      phase: 'windup' as const,
      phaseEndsAtTick: base.tick + 1,
      attackAim: { x: -1, y: 0 },
    };
    const shielded = run(withEnemy(withShield, enemyPartial), [NEUTRAL_INPUT]).state;
    const bare = run(withEnemy(base, enemyPartial), [NEUTRAL_INPUT]).state;
    expect(shielded.player.health).toBe(base.player.health); // fully absorbed
    expect(shielded.player.shieldAmount).toBeLessThan(100); // shield spent
    expect(bare.player.health).toBeLessThan(base.player.health); // control: no shield => hurt
  });
});

describe('Conjure Flame (empower)', () => {
  it('adds bonus damage to the next cone cast, once per charge', () => {
    const state = withEnemy(arena(), { id: 1, position: { x: CENTER.x + 40, y: CENTER.y } });
    const empower: SpellSpec = { kind: 'empower', charges: 3, bonusDamage: 10 };
    const cone: SpellSpec = { kind: 'cone', range: 72, arcCosSq: 0.5, damage: 12 };
    // Empower then a cone in the same cast: the cone is buffed (12 + 10).
    const after = run(state, [cast([empower, cone])]).state;
    expect(only(after).health).toBe(200 - 22);
    expect(after.player.attackFlameCharges).toBe(2); // one of three spent
  });
});

describe('Basking Path (fire trail)', () => {
  it('lays ground fire that burns an enemy standing in the path', () => {
    const state = withEnemy(arena(), { id: 1, position: { x: CENTER.x + 80, y: CENTER.y } });
    const spec: SpellSpec = {
      kind: 'dash',
      distance: 220,
      durationTicks: 14,
      damage: 0, // all damage must come from the trail
      trailRadius: 55,
      trailPulseDamage: 4,
      trailPulseIntervalTicks: 12,
      trailDurationTicks: 150,
    };
    const after = run(state, [cast([spec], CENTER, { x: 1, y: 0 }), ...Array.from({ length: 60 }, () => NEUTRAL_INPUT)]).state;
    const dmg = 200 - only(after).health;
    expect(dmg).toBeGreaterThan(0);
    expect(dmg % 4).toBe(0); // only 4-damage trail pulses
  });
});

describe('Fire Storm (nearest-enemy AOE)', () => {
  it('centres on the foe nearest the cursor and catches its neighbours', () => {
    const a = { x: CENTER.x + 200, y: CENTER.y };
    let state = withEnemy(arena(), { id: 1, position: a }); // nearest the cursor
    state = withEnemy(state, { id: 2, position: { x: a.x + 60, y: a.y } }); // adjacent to A
    state = withEnemy(state, { id: 3, position: { x: a.x, y: a.y - 400 } }); // far away
    const spec: SpellSpec = { kind: 'pointAoe', origin: 'nearestEnemyToTarget', radius: 110, damage: 26, stunTicks: 0, delayTicks: 8, count: 1, spreadTicks: 0 };
    const after = run(state, [cast([spec], a), ...Array.from({ length: 12 }, () => NEUTRAL_INPUT)]).state;
    const hp = (id: number): number => after.enemies.find((e) => e.id === id)?.health ?? -1;
    expect(hp(1)).toBe(200 - 26);
    expect(hp(2)).toBe(200 - 26); // caught in the blast around A
    expect(hp(3)).toBe(200); // out of range
  });
});

describe('determinism', () => {
  it('replays identically for the same seed and inputs', () => {
    const spec: SpellSpec = { kind: 'aura', radius: 95, pulseDamage: 5, pulseIntervalTicks: 12, durationTicks: 180 };
    const inputs = [cast([spec]), ...Array.from({ length: 40 }, (_, i) => ({ ...NEUTRAL_INPUT, moveX: (i % 3 === 0 ? 1 : 0) as -1 | 0 | 1 }))];
    const a = run(withEnemy(arena(9), { id: 1, position: { x: CENTER.x + 50, y: CENTER.y } }), inputs).state;
    const b = run(withEnemy(arena(9), { id: 1, position: { x: CENTER.x + 50, y: CENTER.y } }), inputs).state;
    expect(a).toEqual(b);
  });
});
