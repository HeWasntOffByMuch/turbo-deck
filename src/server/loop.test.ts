import { describe, expect, it } from 'vitest';
import { MAX_CATCHUP_TICKS, TickLoop } from './loop.js';

/** A clock the test moves by hand, so nothing here waits on wall time. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let at = 0;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

describe('tick loop', () => {
  it('runs one tick per elapsed interval, and none before', () => {
    const clock = fakeClock();
    const ticks: number[] = [];
    const loop = new TickLoop((tick) => ticks.push(tick), { tickMs: 50, now: clock.now });
    loop.start();

    clock.advance(49);
    loop.pump();
    expect(ticks).toEqual([]);

    clock.advance(1);
    loop.pump();
    expect(ticks).toEqual([1]);

    clock.advance(150);
    loop.pump();
    expect(ticks).toEqual([1, 2, 3, 4]);
    loop.stop();
  });

  it('keeps the remainder rather than drifting', () => {
    const clock = fakeClock();
    let count = 0;
    const loop = new TickLoop(() => (count += 1), { tickMs: 50, now: clock.now });
    loop.start();

    // Thirty pumps of 30ms is 900ms, which is 18 ticks at 50ms.
    for (let i = 0; i < 30; i++) {
      clock.advance(30);
      loop.pump();
    }
    expect(count).toBe(18);
    loop.stop();
  });

  it('caps a catch-up burst and reports the backlog it dropped', () => {
    const clock = fakeClock();
    let count = 0;
    let dropped = 0;
    const loop = new TickLoop(() => (count += 1), {
      tickMs: 50,
      now: clock.now,
      onLag: (lost) => {
        dropped = lost;
      },
    });
    loop.start();

    // A ten-second stall: running all 200 ticks would fall further behind.
    clock.advance(10_000);
    loop.pump();

    expect(count).toBe(MAX_CATCHUP_TICKS);
    expect(dropped).toBeGreaterThan(0);

    // And it is caught up afterwards, not still buried.
    clock.advance(50);
    loop.pump();
    expect(count).toBe(MAX_CATCHUP_TICKS + 1);
    loop.stop();
  });

  it('does not let a tick start inside another one', () => {
    const clock = fakeClock();
    let depth = 0;
    let worstDepth = 0;
    const loop = new TickLoop(
      () => {
        depth += 1;
        worstDepth = Math.max(worstDepth, depth);
        // A handler that re-enters the loop, which a socket callback could.
        loop.pump();
        depth -= 1;
      },
      { tickMs: 50, now: clock.now },
    );
    loop.start();
    clock.advance(100);
    loop.pump();
    expect(worstDepth).toBe(1);
    loop.stop();
  });

  it('stops ticking once stopped', () => {
    const clock = fakeClock();
    let count = 0;
    const loop = new TickLoop(() => (count += 1), { tickMs: 50, now: clock.now });
    loop.start();
    clock.advance(50);
    loop.pump();
    expect(count).toBe(1);

    loop.stop();
    clock.advance(500);
    loop.pump();
    expect(count).toBe(1);
    expect(loop.isRunning).toBe(false);
  });
});
