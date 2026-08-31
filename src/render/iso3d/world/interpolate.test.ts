import { describe, expect, it } from 'vitest';
import {
  EntityMotion,
  OBSERVATION_DEPTH,
  PLAYBACK_DELAY_TICKS,
  lerpAngle,
  shortestTurn,
} from './interpolate.js';
import { BROADCAST_EVERY_N_TICKS, SERVER_TICK_RATE } from '../../../server/config.js';

const DEG = Math.PI / 180;
const TICK_MS = 1000 / SERVER_TICK_RATE;

/**
 * Feeds a stream of observations and puts the playback head where it belongs,
 * which is what most of these tests want before they measure anything.
 *
 * The first `advance` sets the head outright -- there is nothing to steer
 * towards yet -- so one call after the stream is exact and every later one
 * moves it.
 */
function streamed(
  ticks: readonly number[],
  at: (tick: number) => { x: number; y?: number; z?: number; facing?: number },
): EntityMotion {
  const motion = new EntityMotion();
  for (const tick of ticks) {
    const p = at(tick);
    motion.observe(1, p.x, p.y ?? 0, p.z ?? 0, p.facing ?? 0, tick);
  }
  motion.advance(0);
  return motion;
}

/** Steps the head forward by whole frames and reports where the body was drawn. */
function drawnOver(motion: EntityMotion, frames: number, frameMs: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i += 1) {
    motion.advance(frameMs);
    const pose = motion.sample(1);
    if (pose) out.push(pose.x);
  }
  return out;
}

describe('shortestTurn', () => {
  it('takes the short way across the wrap', () => {
    expect(shortestTurn(350 * DEG, 10 * DEG)).toBeCloseTo(20 * DEG, 9);
    expect(shortestTurn(10 * DEG, 350 * DEG)).toBeCloseTo(-20 * DEG, 9);
  });

  it('stays within half a turn', () => {
    for (let from = -720; from <= 720; from += 17) {
      for (let to = -720; to <= 720; to += 23) {
        const delta = shortestTurn(from * DEG, to * DEG);
        expect(Math.abs(delta)).toBeLessThanOrEqual(Math.PI + 1e-9);
      }
    }
  });
});

describe('lerpAngle', () => {
  it('passes through zero rather than backwards through pi', () => {
    const mid = lerpAngle(350 * DEG, 10 * DEG, 0.5);
    // 350 -> 10 the short way is through 360/0.
    expect(mid).toBeCloseTo(360 * DEG, 9);
    // ...and emphatically not through 180.
    expect(Math.abs(mid - 180 * DEG)).toBeGreaterThan(Math.PI / 2);
  });
});

describe('EntityMotion', () => {
  it('draws a body it has seen once standing still', () => {
    const motion = new EntityMotion();
    motion.observe(1, 100, 50, 4, 0, 30);

    for (let i = 0; i < 20; i += 1) {
      motion.advance(TICK_MS);
      expect(motion.sample(1)).toEqual({ x: 100, y: 50, z: 4, facing: 0 });
    }
  });

  it('is monotone along the stream and never overshoots either end', () => {
    const ticks = [0, 3, 6, 9, 12, 15];
    const motion = streamed(ticks, (tick) => ({ x: tick * 2, y: tick * -3 }));

    let previous = -Infinity;
    for (let i = 0; i < 40; i += 1) {
      motion.advance(TICK_MS / 2);
      const pose = motion.sample(1);
      expect(pose).not.toBeNull();
      if (!pose) return;
      expect(pose.x).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(pose.x).toBeGreaterThanOrEqual(0);
      expect(pose.x).toBeLessThanOrEqual(30 + 1e-9);
      previous = pose.x;
    }
  });

  it('holds at the newest sample rather than extrapolating a late delta', () => {
    const motion = streamed([0, 3, 6, 9, 12, 15], (tick) => ({ x: tick * 2 }));

    // Far past anything the wire has said. The honest answer is the last one.
    const drawn = drawnOver(motion, 600, TICK_MS);
    expect(drawn[drawn.length - 1]).toBe(30);
    for (const x of drawn) expect(x).toBeLessThanOrEqual(30 + 1e-9);
  });

  it('plays a gap back over the time the gap is worth, not a fixed interval', () => {
    // The same body at the same speed, described at two cadences. This is the
    // property the fixed 50ms ramp did not have: it gave every gap one interval
    // of wall clock, so a gap of twice the ticks was twice the drawn speed --
    // which is what a stall delivering several deltas at once looks like.
    const speedAtCadence = (everyNTicks: number): number => {
      const motion = new EntityMotion();
      const drawn: number[] = [];
      for (let tick = 0; tick <= 600; tick += 1) {
        if (tick % everyNTicks === 0) motion.observe(1, tick * 2, 0, 0, 0, tick);
        motion.advance(TICK_MS);
        const pose = motion.sample(1);
        // The first stretch is the head finding its place; measure the rest.
        if (pose && tick > 120) drawn.push(pose.x);
      }
      const first = drawn[0] as number;
      const last = drawn[drawn.length - 1] as number;
      return (last - first) / (drawn.length - 1);
    };

    // Two units a tick, whichever cadence described it.
    expect(speedAtCadence(BROADCAST_EVERY_N_TICKS)).toBeCloseTo(2, 1);
    expect(speedAtCadence(BROADCAST_EVERY_N_TICKS * 2)).toBeCloseTo(2, 1);
    expect(speedAtCadence(BROADCAST_EVERY_N_TICKS * 4)).toBeCloseTo(2, 1);
  });

  it('keeps the head one and a half intervals behind the newest sample', () => {
    const motion = streamed([0, 3, 6, 9, 12, 15], (tick) => ({ x: tick * 2 }));
    expect(motion.playbackTick()).toBeCloseTo(15 - PLAYBACK_DELAY_TICKS, 9);
    // Which is a whole interval of headroom on each side of the pair it sits in.
    expect(PLAYBACK_DELAY_TICKS).toBeGreaterThanOrEqual(BROADCAST_EVERY_N_TICKS);
  });

  it('advances one tick per tick on a wire that is on time', () => {
    const motion = new EntityMotion();
    let tick = 0;
    const feed = (): void => {
      motion.observe(1, tick * 2, 0, 0, 0, tick);
      tick += BROADCAST_EVERY_N_TICKS;
    };
    feed();
    motion.advance(0);

    const before = motion.playbackTick();
    let frames = 0;
    for (let ms = 0; ms < 4000; ms += TICK_MS) {
      // A delta every interval, exactly on schedule.
      if (frames % BROADCAST_EVERY_N_TICKS === 0) feed();
      motion.advance(TICK_MS);
      frames += 1;
    }
    const advanced = motion.playbackTick() - before;
    // One tick per tick, to within the warp it is allowed.
    expect(advanced).toBeGreaterThan(frames * 0.9);
    expect(advanced).toBeLessThan(frames * 1.1);
  });

  it('steers rather than jumps, until the wire is a different wire', () => {
    const motion = streamed([0, 3, 6], (tick) => ({ x: tick }));
    const start = motion.playbackTick();
    // One frame can never move the head by much more than the frame is long.
    motion.advance(TICK_MS);
    expect(motion.playbackTick() - start).toBeLessThanOrEqual(1.15 + 1e-9);

    // A stall past the resync bound is not a late wire. The head is set.
    motion.observe(1, 1000, 0, 0, 0, 6000);
    motion.advance(TICK_MS);
    expect(motion.playbackTick()).toBeCloseTo(6000 - PLAYBACK_DELAY_TICKS, 9);
    // And the frame after a resync draws inside what has been observed.
    expect(motion.sample(1)?.x).toBe(1000);
  });

  it('ignores an observation older than the newest one', () => {
    const motion = new EntityMotion();
    motion.observe(1, 0, 0, 0, 0, 0);
    motion.observe(1, 30, 0, 0, 0, 6);
    motion.observe(1, 15, 0, 0, 0, 3);
    motion.advance(0);

    // The late arrival is dropped rather than making the body walk backwards.
    expect(motion.latest(1)?.x).toBe(30);
    const drawn = drawnOver(motion, 40, TICK_MS);
    let previous = -Infinity;
    for (const x of drawn) {
      expect(x).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = x;
    }
  });

  it('replaces an observation for the tick it already holds', () => {
    const motion = new EntityMotion();
    motion.observe(1, 0, 0, 0, 0, 0);
    motion.observe(1, 30, 0, 0, 0, 3);
    motion.observe(1, 33, 0, 0, 0, 3);

    // The correction lands, and the span it is played back over is unchanged.
    expect(motion.latest(1)?.x).toBe(33);
    motion.advance(0);
    expect(drawnOver(motion, 200, TICK_MS).pop()).toBe(33);
  });

  it('keeps only the last few samples', () => {
    const motion = new EntityMotion();
    for (let tick = 0; tick <= 3 * (OBSERVATION_DEPTH + 4); tick += 3) {
      motion.observe(1, tick, 0, 0, 0, tick);
    }
    // Nothing asserts the ring's length from outside; what it owes is that the
    // oldest sample it dropped is not the one being drawn.
    motion.advance(0);
    const drawn = motion.sample(1);
    expect(drawn?.x).toBeGreaterThan(0);
  });

  it('turns the short way between samples', () => {
    const motion = streamed([0, 3, 6, 9, 12, 15], (tick) => ({
      x: 0,
      facing: tick < 12 ? 350 * DEG : 10 * DEG,
    }));
    for (let i = 0; i < 40; i += 1) {
      motion.advance(TICK_MS / 4);
      const facing = motion.sample(1)?.facing ?? 0;
      // Never through 180: the turn is 20 degrees, not 340.
      expect(Math.abs(shortestTurn(350 * DEG, facing))).toBeLessThanOrEqual(20 * DEG + 1e-9);
    }
  });

  it('forgets a despawned body rather than holding a stale pose', () => {
    const motion = new EntityMotion();
    motion.observe(1, 5, 5, 0, 0, 0);
    motion.forget(1);

    expect(motion.sample(1)).toBeNull();
    expect(motion.has(1)).toBe(false);
  });

  it('retains only the entities still on screen', () => {
    const motion = new EntityMotion();
    motion.observe(1, 0, 0, 0, 0, 0);
    motion.observe(2, 0, 0, 0, 0, 0);
    motion.observe(3, 0, 0, 0, 0, 0);
    motion.retain(new Set([2]));
    motion.advance(0);

    expect(motion.sample(1)).toBeNull();
    expect(motion.sample(2)).not.toBeNull();
    expect(motion.sample(3)).toBeNull();
  });

  it('does not let a reused id inherit the pose it replaced', () => {
    const motion = new EntityMotion();
    motion.observe(7, 500, 500, 0, 0, 0);
    motion.retain(new Set());
    motion.observe(7, 10, 10, 0, 0, 30);
    motion.advance(0);

    expect(motion.sample(7)).toEqual({ x: 10, y: 10, z: 0, facing: 0 });
  });

  it('reports the newest pose unsmoothed', () => {
    const motion = new EntityMotion();
    motion.observe(1, 0, 0, 0, 0, 0);
    motion.observe(1, 30, 0, 0, 0, 3);

    expect(motion.latest(1)?.x).toBe(30);
    expect(motion.latest(99)).toBeNull();
  });
});

describe('EntityMotion across a reconnect', () => {
  it('follows the wire back down when a restarted server counts from zero', () => {
    const motion = new EntityMotion();
    // A long session. Ids 1 and 2 both have history far in the future of what
    // is about to arrive.
    for (let tick = 0; tick <= 90_000; tick += BROADCAST_EVERY_N_TICKS) {
      motion.observe(1, tick, 0, 0, 0, tick);
      motion.observe(2, tick, 0, 0, 0, tick);
    }
    motion.advance(TICK_MS);

    // The socket drops and comes back on a server that restarted. Same ids.
    for (let tick = 0; tick <= 60; tick += BROADCAST_EVERY_N_TICKS) {
      motion.observe(1, 500 + tick * 2, 0, 0, 0, tick);
      motion.observe(2, 900 + tick * 2, 0, 0, 0, tick);
      motion.advance(TICK_MS);
    }

    // Both bodies are being played back out of the new session, not held at the
    // last thing the old one said.
    expect(motion.latest(1)?.x).toBe(500 + 120);
    expect(motion.sample(1)?.x).toBeGreaterThan(500);
    expect(motion.sample(2)?.x).toBeGreaterThan(900);
    // ...and the head came back down with it, rather than sitting in a future
    // the new server will not reach for a quarter of an hour.
    expect(motion.playbackTick()).toBeLessThan(60);
  });
});
