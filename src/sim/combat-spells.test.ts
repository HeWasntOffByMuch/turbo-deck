import { describe, expect, it } from 'vitest';
import type { SpellSpec } from '../shared/spell-spec.js';
import { ARENA_HEIGHT, ARENA_WIDTH, ATTACK_ANIM_TICKS, ENEMY_STANDOFF, MAX_ADRENALINE } from './constants.js';
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

// An attack (cone/rect) turns to face its aim then plays the attack animation
// before firing (spec 028); this casts it and advances past that windup.
const ATTACK_SETTLE = 60; // covers a full 180-degree turn (slowest preset) + the animation
function fireCast(state: CombatState, first: InputFrame): { state: CombatState; events: SimEvent[] } {
  return run(state, [first, ...Array.from({ length: ATTACK_SETTLE }, () => NEUTRAL_INPUT)]);
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
    const after = fireCast(state, cast([spec])).state;
    expect(after.enemies.find((e) => e.id === 1)?.health).toBe(200 - 12);
    expect(after.enemies.find((e) => e.id === 2)?.health).toBe(200);
  });
});

describe('rect spell', () => {
  it('damages an enemy in the rectangle and spares one beside it', () => {
    let state = withEnemy(arena(), { id: 1, position: { x: CENTER.x + 80, y: CENTER.y } }); // in front
    state = withEnemy(state, { id: 2, position: { x: CENTER.x + 40, y: CENTER.y + 60 } }); // off to the side
    const spec: SpellSpec = { kind: 'rect', length: 165, halfWidth: 26, damage: 16 };
    const after = fireCast(state, cast([spec])).state;
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
    const after = fireCast(state, cast([empower, cone])).state;
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

describe('mis-timed window slow', () => {
  it('slows the player\'s walk for the punishment window and announces it', () => {
    const casted = run(arena(), [
      { ...NEUTRAL_INPUT, externalEffect: { kind: 'castSpells', spells: [], aimX: 1, aimY: 0, targetX: 0, targetY: 0, playerSlowTicks: 90 } },
    ]);
    expect(casted.events.some((e) => e.kind === 'playerSlowed')).toBe(true);
    expect(casted.state.player.moveSlowUntilTick).toBeGreaterThan(casted.state.tick);

    const walk = { ...NEUTRAL_INPUT, moveTarget: { x: CENTER.x + 10000, y: CENTER.y } };
    const slowedDist = run(casted.state, Array.from({ length: 10 }, () => walk)).state.player.position.x - casted.state.player.position.x;
    const freshDist = run(arena(), Array.from({ length: 10 }, () => walk)).state.player.position.x - CENTER.x;
    expect(slowedDist).toBeGreaterThan(0);
    expect(slowedDist).toBeLessThan(freshDist); // slowed covers less ground
  });
});

describe('Burning Speed', () => {
  const bs = (over: Partial<Extract<SpellSpec, { kind: 'burningSpeed' }>> = {}): SpellSpec => ({
    kind: 'burningSpeed',
    hasteMult: 1.5,
    durationTicks: 30,
    selfBurnDps: 4,
    foeBurnRadius: 120,
    foeBurnDps: 10,
    foeBurnDurationTicks: 120,
    ...over,
  });

  it('hastes the walk while active', () => {
    const casted = run(arena(), [cast([bs({ durationTicks: 600 })])]).state;
    const walk = { ...NEUTRAL_INPUT, moveTarget: { x: CENTER.x + 10000, y: CENTER.y } };
    const hasted = run(casted, Array.from({ length: 10 }, () => walk)).state.player.position.x - casted.player.position.x;
    const fresh = run(arena(), Array.from({ length: 10 }, () => walk)).state.player.position.x - CENTER.x;
    expect(hasted).toBeGreaterThan(fresh);
  });

  it('self-burn drains health but never downs the player', () => {
    const base = arena();
    const low: CombatState = { ...base, player: { ...base.player, health: 5 } };
    const after = run(low, [cast([bs({ durationTicks: 600, selfBurnDps: 100 })]), ...Array.from({ length: 70 }, () => NEUTRAL_INPUT)]).state;
    expect(after.player.health).toBe(1); // floored, not defeated
    expect(after.over).toBe(false);
  });

  it('ignites adjacent foes when it ends', () => {
    const state = withEnemy(arena(), { id: 1, position: { x: CENTER.x + 50, y: CENTER.y } });
    const after = run(state, [cast([bs()], CENTER), ...Array.from({ length: 70 }, () => NEUTRAL_INPUT)]).state;
    expect(only(after).health).toBeLessThan(200); // caught the end-of-effect burn
  });
});

describe('burning condition', () => {
  it('burns an enemy over time and can kill it', () => {
    const state = withEnemy(arena(), { id: 1, position: { x: CENTER.x + 50, y: CENTER.y }, health: 10, burningUntilTick: 100000, burningDps: 8 });
    const after = run(state, Array.from({ length: 90 }, () => NEUTRAL_INPUT)).state;
    expect(after.enemies).toHaveLength(0); // ~3 pulses of 4 > 10 hp
  });
});

describe('basic-attack interrupt (spec 023)', () => {
  const BASIC: SpellSpec = { kind: 'cone', range: 72, arcCosSq: 0.5, damage: 12, interrupt: true };
  const PLAIN: SpellSpec = { kind: 'cone', range: 72, arcCosSq: 0.5, damage: 12 };

  /** A hunting enemy poised to slam the player, one tick from its wind-up ending. */
  const aboutToSlam = (state: CombatState): CombatState =>
    withEnemy(state, {
      id: 1,
      position: { x: CENTER.x + 40, y: CENTER.y },
      behavior: 'hunting',
      phase: 'windup',
      // The enemy's wind-up outlasts the attack animation, so a timely attack can
      // still catch it (attacks are no longer instant, spec 028).
      phaseEndsAtTick: state.tick + ATTACK_ANIM_TICKS + 12,
      attackAim: { x: -1, y: 0 },
    });

  it('cancels a wind-up it catches so the slam never lands', () => {
    const state = aboutToSlam(arena());
    const { state: after, events } = fireCast(state, cast([BASIC]));
    expect(after.player.health).toBe(state.player.maxHealth); // no slam damage taken
    expect(only(after).phase).toBe('recovery'); // dropped out of its wind-up
    expect(events.some((e) => e.kind === 'playerHit')).toBe(false);
  });

  it('a plain cone does not interrupt — the slam still lands', () => {
    const state = aboutToSlam(arena());
    const { state: after, events } = fireCast(state, cast([PLAIN]));
    expect(after.player.health).toBeLessThan(state.player.maxHealth); // took the hit
    expect(events.some((e) => e.kind === 'playerHit')).toBe(true);
  });
});

describe('attacks turn to the mouse then animate; dashes fire at once (spec 028)', () => {
  const ATTACK: SpellSpec = { kind: 'cone', range: 220, arcCosSq: 0.5, damage: 10, interrupt: true };

  it('an attack aims at the mouse: the unit turns to it, animates, then fires', () => {
    // Unit faces east; the cursor aims WEST at an enemy due west. It does not fire
    // this tick (turning + winding up), but connects with the west enemy in time.
    const s = withEnemy(arena(), { id: 1, position: { x: CENTER.x - 60, y: CENTER.y } });
    const first = step(s, cast([ATTACK], CENTER, { x: -1, y: 0 }));
    expect(first.events.some((e) => e.kind === 'enemyHit')).toBe(false); // not instant
    expect(first.state.player.pendingAttack).not.toBeNull();
    const r = fireCast(s, cast([ATTACK], CENTER, { x: -1, y: 0 }));
    expect(r.state.enemies.find((e) => e.id === 1)?.health).toBe(200 - 10); // west enemy hit
    expect(Math.cos(r.state.player.facing)).toBeLessThan(-0.99); // turned to face west
  });

  it('a move command during the attack animation cancels it (no hit)', () => {
    const s = withEnemy(arena(), { id: 1, position: { x: CENTER.x + 60, y: CENTER.y } });
    let cur = step(s, cast([ATTACK], CENTER, { x: 1, y: 0 })); // start the attack (east, aligned)
    expect(cur.state.player.pendingAttack).not.toBeNull();
    // Move a few ticks in: cancels the attack and emits attackCancelled.
    cur = step(cur.state, { ...NEUTRAL_INPUT, moveTarget: { x: CENTER.x, y: CENTER.y + 300 } });
    expect(cur.events.some((e) => e.kind === 'attackCancelled')).toBe(true);
    expect(cur.state.player.pendingAttack).toBeNull();
    const r = run(cur.state, Array.from({ length: 30 }, () => NEUTRAL_INPUT));
    expect(r.state.enemies.find((e) => e.id === 1)?.health).toBe(200); // never fired
  });

  it('the faster-turning preset fires a behind-aimed attack sooner', () => {
    const ticksToHit = (characterIndex: number): number => {
      const base = withEnemy(arena(), { id: 1, position: { x: CENTER.x - 60, y: CENTER.y } });
      let cur = { state: { ...base, player: { ...base.player, characterIndex } }, events: [] as SimEvent[] };
      for (let t = 1; t <= 80; t++) {
        cur = step(cur.state, cast([ATTACK], CENTER, { x: -1, y: 0 }));
        if (cur.events.some((e) => e.kind === 'enemyHit')) return t;
      }
      return -1;
    };
    expect(ticksToHit(0)).toBeGreaterThan(ticksToHit(1)); // Warden (360) slower than Zephyr (900)
  });

  it('a dash fires immediately in the mouse direction and re-points the unit that way', () => {
    // Unit faces east; dash aimed WEST goes west at once and turns the unit west.
    const s = arena();
    const first = step(s, cast([{ kind: 'dash', distance: 320, durationTicks: 17, damage: 0 }], CENTER, { x: -1, y: 0 }));
    expect(first.state.player.dashDx).toBeLessThan(0); // moving west immediately
    expect(Math.cos(first.state.player.facing)).toBeLessThan(-0.99); // re-pointed west
    const after = run(first.state, Array.from({ length: 20 }, () => NEUTRAL_INPUT)).state;
    expect(after.player.position.x).toBeLessThan(CENTER.x - 100); // travelled west
  });
});

describe('adrenaline (spec 023)', () => {
  const BASIC: SpellSpec = { kind: 'cone', range: 72, arcCosSq: 0.5, damage: 12, interrupt: true };
  const PLAIN: SpellSpec = { kind: 'cone', range: 72, arcCosSq: 0.5, damage: 12 };
  const inCone = { x: CENTER.x + 40, y: CENTER.y };

  it('banks one point when a basic attack connects', () => {
    const state = withEnemy(arena(), { id: 1, position: inCone });
    const { state: after, events } = fireCast(state, cast([BASIC]));
    expect(after.player.adrenaline).toBe(1);
    expect(events.some((e) => e.kind === 'adrenalineChanged' && e.delta === 1)).toBe(true);
  });

  it('banks nothing when the basic attack hits no one', () => {
    const state = withEnemy(arena(), { id: 1, position: { x: CENTER.x - 200, y: CENTER.y } }); // behind, out of cone
    const after = fireCast(state, cast([BASIC])).state;
    expect(after.player.adrenaline).toBe(0);
  });

  it('a non-interrupt cone never banks adrenaline', () => {
    const state = withEnemy(arena(), { id: 1, position: inCone });
    const after = fireCast(state, cast([PLAIN])).state;
    expect(after.player.adrenaline).toBe(0);
  });

  it('caps at MAX_ADRENALINE no matter how many basics connect', () => {
    let s = withEnemy(arena(), { id: 1, position: inCone, health: 100000 });
    for (let i = 0; i < MAX_ADRENALINE + 3; i++) s = fireCast(s, cast([BASIC])).state;
    expect(s.player.adrenaline).toBe(MAX_ADRENALINE);
  });

  it('spendAdrenaline deducts exactly the given amount, leaving the rest banked', () => {
    const base = withEnemy(arena(), { id: 1, position: inCone });
    const state: CombatState = { ...base, player: { ...base.player, adrenaline: 4 } };
    const spend: InputFrame = {
      ...NEUTRAL_INPUT,
      externalEffect: { kind: 'castSpells', spells: [PLAIN], aimX: 1, aimY: 0, targetX: CENTER.x, targetY: CENTER.y, spendAdrenaline: 2 },
    };
    const { state: after, events } = fireCast(state, spend);
    expect(after.player.adrenaline).toBe(2); // 4 - 2 spent
    expect(events.some((e) => e.kind === 'adrenalineChanged' && e.delta === -2)).toBe(true);
  });

  it('applies a basic-attack gain before the spend in the same cast', () => {
    const base = withEnemy(arena(), { id: 1, position: inCone });
    const state: CombatState = { ...base, player: { ...base.player, adrenaline: 2 } };
    const spend: InputFrame = {
      ...NEUTRAL_INPUT,
      externalEffect: { kind: 'castSpells', spells: [BASIC], aimX: 1, aimY: 0, targetX: CENTER.x, targetY: CENTER.y, spendAdrenaline: 1 },
    };
    const after = fireCast(state, spend).state;
    expect(after.player.adrenaline).toBe(2); // 2 + 1 (hit) - 1 (spend)
  });

  it('never drives the bank below zero', () => {
    const base = withEnemy(arena(), { id: 1, position: inCone });
    const state: CombatState = { ...base, player: { ...base.player, adrenaline: 1 } };
    const spend: InputFrame = {
      ...NEUTRAL_INPUT,
      externalEffect: { kind: 'castSpells', spells: [PLAIN], aimX: 1, aimY: 0, targetX: CENTER.x, targetY: CENTER.y, spendAdrenaline: 5 },
    };
    expect(fireCast(state, spend).state.player.adrenaline).toBe(0);
  });
});

describe('adrenaline move speed (spec 025)', () => {
  it('speeds the walk by 4% per banked point', () => {
    const withAdr = (adr: number): CombatState => {
      const base = arena();
      return { ...base, player: { ...base.player, adrenaline: adr } };
    };
    const walk: InputFrame = { ...NEUTRAL_INPUT, moveTarget: { x: CENTER.x + 10000, y: CENTER.y } };
    const dx0 = run(withAdr(0), [walk]).state.player.position.x - CENTER.x;
    const dx5 = run(withAdr(5), [walk]).state.player.position.x - CENTER.x;
    expect(dx0).toBeGreaterThan(0);
    expect(dx5).toBeCloseTo(dx0 * (1 + 0.04 * 5), 6); // +20% at a full bank
  });
});

describe('determinism', () => {
  it('replays identically for the same seed and inputs', () => {
    const spec: SpellSpec = { kind: 'aura', radius: 95, pulseDamage: 5, pulseIntervalTicks: 12, durationTicks: 180 };
    const inputs = [
      cast([spec]),
      ...Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? { ...NEUTRAL_INPUT, moveTarget: { x: CENTER.x + 10000, y: CENTER.y } } : NEUTRAL_INPUT)),
    ];
    const a = run(withEnemy(arena(9), { id: 1, position: { x: CENTER.x + 50, y: CENTER.y } }), inputs).state;
    const b = run(withEnemy(arena(9), { id: 1, position: { x: CENTER.x + 50, y: CENTER.y } }), inputs).state;
    expect(a).toEqual(b);
  });
});
