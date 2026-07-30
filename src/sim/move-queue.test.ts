import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { SpellSpec } from '../shared/spell-spec.js';
import { ARENA_HEIGHT, ARENA_WIDTH, MOVE_ARRIVE_EPS, MOVE_QUEUE_MAX } from './constants.js';
import { initCombat, runSim, step } from './combat.js';
import { NEUTRAL_INPUT, type CombatState, type InputFrame, type Vec2 } from './types.js';

/**
 * Queued move orders (spec 038): a shift-click stacks a destination behind the
 * standing order instead of replacing it, and the queue is walked one leg at a
 * time. These are sim-level assertions -- the renderer only reports the shift.
 */

const CENTER: Vec2 = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

function arena(seed = 1): CombatState {
  return initCombat(seed, { ambientSpawner: false, initialEnemies: 0 });
}

/** A plain move order to a world point (the un-shifted click). */
function moveTo(x: number, y: number): InputFrame {
  return { ...NEUTRAL_INPUT, moveTarget: { x, y } };
}

/** A queued move order to a world point (the shift-click). */
function queueTo(x: number, y: number): InputFrame {
  return { ...NEUTRAL_INPUT, moveTarget: { x, y }, queueMove: true };
}

/** Step until the standing order and its queue are both exhausted, or `max` ticks pass. */
function walkOut(state: CombatState, max = 900): CombatState {
  let s = state;
  for (let i = 0; i < max; i++) {
    if (s.player.moveTarget === null && s.player.moveQueue.length === 0) break;
    s = step(s, NEUTRAL_INPUT).state;
  }
  return s;
}

describe('queued move orders (spec 038)', () => {
  it('starts with an empty queue', () => {
    expect(arena().player.moveQueue).toEqual([]);
  });

  it('a shift-click keeps the standing order and stacks behind it', () => {
    const first = { x: CENTER.x + 150, y: CENTER.y };
    const second = { x: CENTER.x + 150, y: CENTER.y + 150 };
    let s = step(arena(), moveTo(first.x, first.y)).state;
    s = step(s, queueTo(second.x, second.y)).state;

    expect(s.player.moveTarget).toEqual(first);
    expect(s.player.moveQueue).toEqual([second]);
  });

  it('a plain click replaces the standing order and wipes the queue', () => {
    let s = step(arena(), moveTo(CENTER.x + 150, CENTER.y)).state;
    s = step(s, queueTo(CENTER.x + 150, CENTER.y + 150)).state;
    expect(s.player.moveQueue).toHaveLength(1);

    const fresh = { x: CENTER.x - 150, y: CENTER.y };
    s = step(s, moveTo(fresh.x, fresh.y)).state;
    expect(s.player.moveTarget).toEqual(fresh);
    expect(s.player.moveQueue).toEqual([]);
  });

  it('a shift-click with nothing to queue behind becomes the standing order', () => {
    const target = { x: CENTER.x + 150, y: CENTER.y };
    const s = step(arena(), queueTo(target.x, target.y)).state;
    expect(s.player.moveTarget).toEqual(target);
    expect(s.player.moveQueue).toEqual([]);
  });

  it('walks the whole queue in order, then stops with nothing standing', () => {
    const first = { x: CENTER.x + 160, y: CENTER.y };
    const second = { x: CENTER.x + 160, y: CENTER.y + 160 };
    let s = step(arena(), moveTo(first.x, first.y)).state;
    s = step(s, queueTo(second.x, second.y)).state;

    // The first leg is walked to its end before the second is ever adopted.
    let promotedAt: Vec2 | null = null;
    for (let i = 0; i < 900; i++) {
      s = step(s, NEUTRAL_INPUT).state;
      if (promotedAt === null && s.player.moveQueue.length === 0) {
        promotedAt = s.player.position;
        break;
      }
    }
    expect(promotedAt).not.toBeNull();
    expect(Math.hypot((promotedAt as Vec2).x - first.x, (promotedAt as Vec2).y - first.y)).toBeLessThanOrEqual(MOVE_ARRIVE_EPS);
    expect(s.player.moveTarget).toEqual(second);

    s = walkOut(s);
    expect(Math.hypot(s.player.position.x - second.x, s.player.position.y - second.y)).toBeLessThanOrEqual(MOVE_ARRIVE_EPS);
    expect(s.player.moveTarget).toBeNull();
    expect(s.player.moveQueue).toEqual([]);
  });

  it('routes a queued leg around walls when it is promoted, not when it is queued', () => {
    // The second leg sits behind the wall spanning x 500..700 at y 200..240, so
    // it needs a route; the first leg is in plain sight and gets none.
    const first = { x: CENTER.x, y: CENTER.y - 120 };
    const behindWall = { x: 600, y: 150 };
    let s = step(arena(), moveTo(first.x, first.y)).state;
    s = step(s, queueTo(behindWall.x, behindWall.y)).state;
    expect(s.player.movePath).toEqual([]); // queuing routes nothing

    for (let i = 0; i < 900 && s.player.moveQueue.length > 0; i++) s = step(s, NEUTRAL_INPUT).state;
    expect(s.player.moveTarget).toEqual(behindWall);
    expect(s.player.movePath.length).toBeGreaterThan(0); // routed on promotion
  });

  it('cancelMove drops the queue along with the standing order', () => {
    let s = step(arena(), moveTo(CENTER.x + 200, CENTER.y)).state;
    s = step(s, queueTo(CENTER.x + 200, CENTER.y + 200)).state;
    s = step(s, { ...NEUTRAL_INPUT, cancelMove: true }).state;

    expect(s.player.moveTarget).toBeNull();
    expect(s.player.moveQueue).toEqual([]);
    const held = s.player.position;
    expect(step(s, NEUTRAL_INPUT).state.player.position).toEqual(held);
  });

  it('caps the queue, dropping further shift-clicks rather than rotating it', () => {
    let s = step(arena(), moveTo(CENTER.x + 100, CENTER.y)).state;
    for (let i = 0; i < MOVE_QUEUE_MAX + 5; i++) s = step(s, queueTo(CENTER.x + 100, CENTER.y + 10 + i)).state;

    expect(s.player.moveQueue).toHaveLength(MOVE_QUEUE_MAX);
    // The kept entries are the first MOVE_QUEUE_MAX shift-clicks, in click order.
    expect(s.player.moveQueue[0]).toEqual({ x: CENTER.x + 100, y: CENTER.y + 10 });
    expect(s.player.moveQueue[MOVE_QUEUE_MAX - 1]).toEqual({ x: CENTER.x + 100, y: CENTER.y + 10 + MOVE_QUEUE_MAX - 1 });
  });

  it('a queued order does not cancel a winding-up attack, but a plain one does', () => {
    const cone: SpellSpec = { kind: 'cone', range: 72, arcCosSq: 0.5, damage: 12 };
    const swing: InputFrame = {
      ...NEUTRAL_INPUT,
      externalEffect: { kind: 'castSpells', spells: [cone], aimX: 1, aimY: 0, targetX: CENTER.x, targetY: CENTER.y },
    };
    const winding = step(arena(), swing).state;
    expect(winding.player.pendingAttack).not.toBeNull();

    const queued = step(winding, queueTo(CENTER.x, CENTER.y + 200));
    expect(queued.events.some((e) => e.kind === 'attackCancelled')).toBe(false);
    expect(queued.state.player.pendingAttack).not.toBeNull();

    const plain = step(winding, moveTo(CENTER.x, CENTER.y + 200));
    expect(plain.events.some((e) => e.kind === 'attackCancelled')).toBe(true);
    expect(plain.state.player.pendingAttack).toBeNull();
  });

  it('replays bit-identically for the same seed and queued-order sequence', () => {
    const inputArb: fc.Arbitrary<InputFrame> = fc.record(
      {
        attack: fc.constant(false),
        aimX: fc.constantFrom(-1, 0, 1),
        aimY: fc.constantFrom(-1, 0, 1),
        parry: fc.constant(false),
        dodge: fc.constant(false),
        moveTarget: fc.record({ x: fc.integer({ min: 0, max: ARENA_WIDTH }), y: fc.integer({ min: 0, max: ARENA_HEIGHT }) }),
        queueMove: fc.boolean(),
        cancelMove: fc.boolean(),
      },
      { requiredKeys: ['attack', 'aimX', 'aimY', 'parry', 'dodge'] },
    );

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.array(inputArb, { maxLength: 200 }), (seed, inputs) => {
        expect(runSim(seed, inputs).state).toEqual(runSim(seed, inputs).state);
      }),
      { numRuns: 25 },
    );
  });
});
