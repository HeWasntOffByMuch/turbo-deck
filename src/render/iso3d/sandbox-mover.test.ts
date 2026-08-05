import { describe, expect, it } from 'vitest';
import { initMover, moverSpeed, moverTurnRate, stepMover, type MoverInput, type MoverState } from './sandbox-mover.js';
import { characterAt, CHARACTERS } from '../../sim/characters.js';
import { createWorldColliders } from '../../sim/collision.js';
import {
  MOVE_ARRIVE_EPS,
  MOVE_FACING_THRESHOLD_DEG,
  MOVE_SPEED_HARD_MAX,
  MOVE_SPEED_HARD_MIN,
  PLAYER_RADIUS,
  TICK_RATE,
} from '../../sim/constants.js';
import type { Rect, Vec2 } from '../../sim/types.js';

// An empty stretch of the play area, well clear of the hand-authored barricades,
// so a test that is about turning is not secretly about a wall.
const START: Vec2 = { x: 600, y: 450 };
const OPEN = createWorldColliders([], []);

/** Run `ticks` ticks, feeding `input` on the first one and nothing after it. */
function run(state: MoverState, ticks: number, input: MoverInput = {}, world = OPEN): MoverState {
  let s = state;
  for (let i = 0; i < ticks; i++) s = stepMover(s, i === 0 ? input : {}, world);
  return s;
}

describe('initMover', () => {
  it('starts standing still, facing +x, with no order', () => {
    const s = initMover(START);
    expect(s.position).toEqual(START);
    expect(s.facing).toBe(0);
    expect(s.moveTarget).toBeNull();
    expect(s.path).toEqual([]);
  });

  it('wraps an out-of-range archetype index rather than yielding an undefined character', () => {
    expect(initMover(START, CHARACTERS.length + 1).characterIndex).toBe(1);
    expect(initMover(START, -1).characterIndex).toBe(CHARACTERS.length - 1);
  });
});

describe('with no order', () => {
  it('holds both position and heading -- it does not turn to follow the cursor', () => {
    const s = run({ ...initMover(START), facing: 1.2 }, 30);
    expect(s.position).toEqual(START);
    expect(s.facing).toBe(1.2);
    expect(s.moveTarget).toBeNull();
  });
});

describe('the facing gate (spec 028)', () => {
  // Almost straight behind the body: a reversal well past the 135-degree gate,
  // at a turn rate slow enough that it takes many ticks.
  const BEHIND: Vec2 = { x: START.x - 300, y: START.y + 30 };
  const SLOW: MoverInput = { turnRate: 60 };

  it('rotates in place until the heading is within the gate, then travels', () => {
    let s = stepMover(initMover(START), { ...SLOW, moveTarget: BEHIND }, OPEN);
    const desired = Math.atan2(BEHIND.y - START.y, BEHIND.x - START.x);
    const gate = MOVE_FACING_THRESHOLD_DEG * (Math.PI / 180);

    let turnedInPlace = 0;
    while (Math.abs(desired - s.facing) > gate) {
      expect(s.position).toEqual(START); // still pivoting: not one unit of travel
      s = stepMover(s, SLOW, OPEN);
      turnedInPlace++;
      expect(turnedInPlace).toBeLessThan(TICK_RATE * 5); // a turn, not a hang
    }
    expect(turnedInPlace).toBeGreaterThan(0);

    // The gate is open now, so the very next tick moves.
    const moved = stepMover(s, SLOW, OPEN);
    expect(moved.position).not.toEqual(START);
  });

  it('turns at the rate it was given: a faster rate opens the gate sooner', () => {
    const ticksToMove = (turnRate: number): number => {
      let s = stepMover(initMover(START), { turnRate, moveTarget: BEHIND }, OPEN);
      for (let i = 1; i < TICK_RATE * 5; i++) {
        const next = stepMover(s, { turnRate }, OPEN);
        if (next.position.x !== s.position.x || next.position.y !== s.position.y) return i;
        s = next;
      }
      throw new Error('never started moving');
    };
    expect(ticksToMove(360)).toBeLessThan(ticksToMove(60));
  });
});

describe('travel', () => {
  it('walks to the destination and clears the order on arrival', () => {
    const target: Vec2 = { x: START.x + 200, y: START.y };
    // Straight ahead of the starting heading, so no turn time is spent.
    let s = stepMover(initMover(START), { moveTarget: target }, OPEN);
    for (let i = 0; i < TICK_RATE * 5 && s.moveTarget !== null; i++) s = stepMover(s, {}, OPEN);

    expect(s.moveTarget).toBeNull();
    expect(s.path).toEqual([]);
    expect(Math.hypot(s.position.x - target.x, s.position.y - target.y)).toBeLessThanOrEqual(MOVE_ARRIVE_EPS);
  });

  it('covers the archetype speed over a second of straight-line travel', () => {
    const target: Vec2 = { x: START.x + 1000, y: START.y };
    // Straight ahead of the starting heading again, so the gate is open from the
    // first tick and a second of ticks is a second of travel.
    const s = run(initMover(START), TICK_RATE, { moveTarget: target });
    const speed = moverSpeed(initMover(START), {});
    expect(s.position.x - START.x).toBeCloseTo(speed, 6);
    expect(s.position.y).toBe(START.y);
  });

  it('re-issuing the destination it is already walking to keeps the same route', () => {
    const target: Vec2 = { x: START.x + 200, y: START.y };
    const first = stepMover(initMover(START), { moveTarget: target }, OPEN);
    const again = stepMover(first, { moveTarget: { ...target } }, OPEN);
    expect(again.path).toBe(first.path);
  });
});

describe('speed and turn rate', () => {
  it('come from the active archetype, and an override replaces them', () => {
    const s = initMover(START);
    expect(moverSpeed(s, {})).toBe(Math.round(characterAt(0).moveSpeed));
    expect(moverTurnRate(s, {})).toBe(characterAt(0).turnRate);
    expect(moverSpeed(s, { moveSpeed: 200 })).toBe(200);
    expect(moverTurnRate(s, { turnRate: 90 })).toBe(90);
  });

  it('clamp the speed to the hard caps, and ignore a value that is not a number', () => {
    const s = initMover(START);
    expect(moverSpeed(s, { moveSpeed: 10_000 })).toBe(MOVE_SPEED_HARD_MAX);
    expect(moverSpeed(s, { moveSpeed: 1 })).toBe(MOVE_SPEED_HARD_MIN);
    expect(moverSpeed(s, { moveSpeed: NaN })).toBe(Math.round(characterAt(0).moveSpeed));
    expect(moverTurnRate(s, { turnRate: NaN })).toBe(characterAt(0).turnRate);
  });

  it('never lets a bad override produce a NaN position or heading', () => {
    const s = run(initMover(START), 10, { moveTarget: { x: START.x + 100, y: START.y }, moveSpeed: NaN, turnRate: NaN });
    expect(Number.isFinite(s.position.x)).toBe(true);
    expect(Number.isFinite(s.position.y)).toBe(true);
    expect(Number.isFinite(s.facing)).toBe(true);
  });
});

describe('cycleCharacter', () => {
  it('walks the archetype list and wraps', () => {
    let s = initMover(START);
    for (let i = 1; i <= CHARACTERS.length; i++) {
      s = stepMover(s, { cycleCharacter: true }, OPEN);
      expect(s.characterIndex).toBe(i % CHARACTERS.length);
    }
  });
});

describe('walls', () => {
  // A barrier across the direct line, with a gap well off to one side.
  const WALL: Rect = { x: START.x + 100, y: START.y - 400, w: 40, h: 700 };
  const WALLED = createWorldColliders([WALL], []);
  const BEYOND: Vec2 = { x: START.x + 400, y: START.y };

  it('routes an order that is behind a wall, and steers straight at one in plain sight', () => {
    expect(stepMover(initMover(START), { moveTarget: BEYOND }, WALLED).path.length).toBeGreaterThan(0);
    expect(stepMover(initMover(START), { moveTarget: BEYOND }, OPEN).path).toEqual([]);
  });

  it('never ends a tick inside the wall', () => {
    let s = stepMover(initMover(START), { moveTarget: BEYOND }, WALLED);
    for (let i = 0; i < TICK_RATE * 10 && s.moveTarget !== null; i++) {
      s = stepMover(s, {}, WALLED);
      const nx = Math.max(WALL.x, Math.min(s.position.x, WALL.x + WALL.w));
      const ny = Math.max(WALL.y, Math.min(s.position.y, WALL.y + WALL.h));
      expect(Math.hypot(s.position.x - nx, s.position.y - ny)).toBeGreaterThanOrEqual(PLAYER_RADIUS - 1e-6);
    }
  });
});

describe('replay', () => {
  // The property CLAUDE.md asks of anything that steps on a fixed timestep: the
  // same start and the same timed inputs produce the same state, every run.
  const SCRIPT: readonly (readonly [number, MoverInput])[] = [
    [0, { moveTarget: { x: START.x - 250, y: START.y + 180 } }],
    [20, { cycleCharacter: true }],
    [45, { moveTarget: { x: START.x + 320, y: START.y - 90 }, turnRate: 90 }],
    [80, { moveSpeed: 300 }],
  ];

  const replay = (): MoverState => {
    let s = initMover(START);
    for (let tick = 0; tick < 200; tick++) {
      const scripted = SCRIPT.find(([at]) => at === tick);
      s = stepMover(s, scripted ? scripted[1] : {}, OPEN);
    }
    return s;
  };

  it('produces a bit-identical state from the same seed of inputs', () => {
    expect(replay()).toEqual(replay());
    // And it is not trivially identical because nothing happened.
    expect(replay().position).not.toEqual(START);
  });
});
