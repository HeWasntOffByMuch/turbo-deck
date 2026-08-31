/**
 * What spec 253 is actually for: a body walking a straight line is drawn
 * walking a straight line.
 *
 * Every other test in `interpolate.test.ts` asserts a rule. This one plays the
 * wire -- broadcasts on the server's clock, arriving with jitter, applied on a
 * socket callback, read by a frame loop that is not in step with either -- and
 * measures the *drawn speed frame to frame*, which is the thing a player is
 * complaining about when they say movement is jaggedy.
 *
 * The numbers in the spec's table came from this model. Under the ramp it
 * replaced, one frame in ten drew the body standing still and one in ten drew
 * it at nearly twice its speed, with the mean perfectly correct throughout --
 * which is why nothing that measured a position ever caught it.
 */
import { describe, expect, it } from 'vitest';
import { EntityMotion } from './interpolate.js';
import { BROADCAST_EVERY_N_TICKS, SERVER_TICK_RATE } from '../../../server/config.js';

const TICK_MS = 1000 / SERVER_TICK_RATE;

/**
 * A player's walking speed, in world units a second. A fixture rather than an
 * import: every assertion below is a fraction of it, so what it is worth is
 * only that it is the right order of magnitude for a body somebody is watching.
 */
const WALK_SPEED = 155;

/** Deterministic, so a red run is a red run rather than an unlucky one. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

interface Wire {
  readonly label: string;
  /** Spread of arrival times around the broadcast, in ms. */
  readonly jitterMs: number;
  /** How fast the browser paints. */
  readonly frameMs: number;
  /**
   * How far the server's broadcast clock runs from this browser's frame clock.
   * Two independent clocks always disagree; 0.2% is unremarkable.
   */
  readonly driftPpm: number;
  /**
   * The share of frames allowed to hold still, where that is not zero.
   *
   * Stated per wire rather than as one blanket threshold, because a budget that
   * covers the worst row silently forgives every other one. Only jitter past
   * half a broadcast interval has any, and what it buys is written down beside
   * it: `PLAYBACK_DELAY_TICKS` is the number to spend if a real connection ever
   * needs more headroom than the derivation gives it.
   */
  readonly frozenBudget?: number;
}

interface Drawn {
  readonly meanSpeed: number;
  readonly sd: number;
  readonly frozen: number;
  readonly sprinting: number;
}

/** Walks a body across `wire` and reports what the frames drew. */
function walk(wire: Wire): Drawn {
  const random = makeRandom(12345);
  const durationMs = 20_000;
  const scale = 1 + wire.driftPpm / 1e6;

  // Every broadcast the server will make, and when this client sees it.
  const arrivals: { at: number; tick: number; x: number }[] = [];
  for (let tick = 0; tick * TICK_MS < durationMs; tick += BROADCAST_EVERY_N_TICKS) {
    arrivals.push({
      at: tick * TICK_MS * scale + (random() * 2 - 1) * wire.jitterMs,
      tick,
      x: (WALK_SPEED * tick * TICK_MS) / 1000,
    });
  }
  arrivals.sort((a, b) => a.at - b.at);

  const motion = new EntityMotion();
  const speeds: number[] = [];
  let next = 0;
  let previousX: number | null = null;

  for (let now = 0; now < durationMs; now += wire.frameMs) {
    // Deltas land on a socket callback, so everything that arrived since the
    // last frame is already in the replica by the time this frame reads it.
    while (next < arrivals.length && (arrivals[next] as { at: number }).at <= now) {
      const arrival = arrivals[next] as { tick: number; x: number };
      motion.observe(1, arrival.x, 0, 0, 0, arrival.tick);
      next += 1;
    }
    motion.advance(wire.frameMs);
    const pose = motion.sample(1);
    if (!pose) continue;
    // The head is allowed a moment to find its place before anything is judged.
    if (previousX !== null && now > 3000) {
      speeds.push((pose.x - previousX) / (wire.frameMs / 1000));
    }
    previousX = pose.x;
  }

  const meanSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const variance = speeds.reduce((a, b) => a + (b - meanSpeed) ** 2, 0) / speeds.length;
  return {
    meanSpeed,
    sd: Math.sqrt(variance),
    frozen: speeds.filter((v) => v < WALK_SPEED * 0.15).length / speeds.length,
    sprinting: speeds.filter((v) => v > WALK_SPEED * 1.85).length / speeds.length,
  };
}

const WIRES: Wire[] = [
  { label: 'a clean wire', jitterMs: 0, frameMs: 1000 / 60, driftPpm: 0 },
  { label: 'two clocks that disagree', jitterMs: 0, frameMs: 1000 / 60, driftPpm: 2000 },
  { label: 'a LAN', jitterMs: 4, frameMs: 1000 / 60, driftPpm: 2000 },
  { label: 'wifi', jitterMs: 15, frameMs: 1000 / 60, driftPpm: 2000 },
  // Jitter of 30ms is 60% of a whole broadcast interval. Past the 75ms the
  // head sits back by, a delta is late enough that the body genuinely has
  // nowhere further to be drawn -- one frame in a thousand, against 19% of them
  // under the ramp this replaced.
  { label: 'poor wifi', jitterMs: 30, frameMs: 1000 / 60, driftPpm: 2000, frozenBudget: 0.002 },
  { label: 'wifi at 144fps', jitterMs: 15, frameMs: 1000 / 144, driftPpm: 2000 },
  { label: 'wifi at 30fps', jitterMs: 15, frameMs: 1000 / 30, driftPpm: 2000 },
];

describe('a remote body walking a straight line', () => {
  for (const wire of WIRES) {
    it(`is drawn at a steady speed over ${wire.label}`, () => {
      const drawn = walk(wire);

      // The mean was never the problem -- it is right under the ramp too, which
      // is exactly why this is asserted as a control rather than as the finding.
      expect(drawn.meanSpeed).toBeGreaterThan(WALK_SPEED * 0.97);
      expect(drawn.meanSpeed).toBeLessThan(WALK_SPEED * 1.03);

      // The finding. Under the ramp this replaced these were 37 to 112, with
      // 3% to 19% of frames frozen and a comparable share at double speed.
      expect(drawn.sd).toBeLessThan(20);
      expect(drawn.frozen).toBeLessThanOrEqual(wire.frozenBudget ?? 0);
      expect(drawn.sprinting).toBe(0);
    });
  }
});
