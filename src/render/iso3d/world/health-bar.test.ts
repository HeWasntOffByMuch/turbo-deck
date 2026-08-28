import { describe, expect, it } from 'vitest';
import {
  FLASH_DRAIN_MS,
  FLASH_HOLD_MS,
  HealthFlashes,
  SHAKE_MS,
  SHAKE_PIXELS,
  type BarFill,
} from './health-bar.js';

/** One body, so every test reads as a story about a single bar. */
const BODY = 7;

describe('the white chunk a blow leaves', () => {
  it('draws nothing but the fill on a body nobody has hit', () => {
    const flashes = new HealthFlashes();
    expect(flashes.read(BODY, 100, 100, 0)).toEqual({ health: 1, ghost: 1, shakeX: 0, shakeY: 0 });
    expect(flashes.read(BODY, 100, 100, 5_000)).toEqual({ health: 1, ghost: 1, shakeX: 0, shakeY: 0 });
  });

  it('does not flash for damage it never saw land', () => {
    // A monster that walks into view already wounded is a first read, not a hit.
    const flashes = new HealthFlashes();
    const fill = flashes.read(BODY, 40, 100, 0);
    expect(fill).toEqual({ health: 0.4, ghost: 0.4, shakeX: 0, shakeY: 0 });
  });

  it('puts the white at the health before the blow, at once', () => {
    const flashes = new HealthFlashes();
    flashes.read(BODY, 100, 100, 0);
    const hit = flashes.read(BODY, 70, 100, 100);
    expect(hit.health).toBeCloseTo(0.7, 6);
    expect(hit.ghost).toBeCloseTo(1, 6);
  });

  it('holds the chunk flat for the whole window', () => {
    const flashes = new HealthFlashes();
    flashes.read(BODY, 100, 100, 0);
    flashes.read(BODY, 70, 100, 100);
    for (let now = 100; now < 100 + FLASH_HOLD_MS; now += 16) {
      const fill = flashes.read(BODY, 70, 100, now);
      expect(fill.ghost).toBeCloseTo(1, 6);
      expect(fill.health).toBeCloseTo(0.7, 6);
    }
  });

  it('lands the retreat exactly on the fill, and never below it', () => {
    const flashes = new HealthFlashes();
    flashes.read(BODY, 100, 100, 0);
    flashes.read(BODY, 70, 100, 0);

    let previous = 1;
    for (let now = FLASH_HOLD_MS; now <= FLASH_HOLD_MS + FLASH_DRAIN_MS; now += 8) {
      const fill = flashes.read(BODY, 70, 100, now);
      expect(fill.ghost).toBeLessThanOrEqual(previous + 1e-9);
      expect(fill.ghost).toBeGreaterThanOrEqual(0.7 - 1e-9);
      previous = fill.ghost;
    }
    const settled = flashes.read(BODY, 70, 100, FLASH_HOLD_MS + FLASH_DRAIN_MS + 1);
    expect(settled.ghost).toBeCloseTo(0.7, 6);
  });

  it('grows one chunk for a burst, and resolves it from the first blow', () => {
    // This is the throttle the whole module exists for: three quick hits are
    // one white chunk that goes when the *first* one's window is up, not three
    // slivers each cancelling the last.
    const flashes = new HealthFlashes();
    flashes.read(BODY, 100, 100, 0);
    flashes.read(BODY, 90, 100, 0);
    expect(flashes.read(BODY, 80, 100, 120).ghost).toBeCloseTo(1, 6);
    const third = flashes.read(BODY, 60, 100, 240);
    expect(third.health).toBeCloseTo(0.6, 6);
    expect(third.ghost).toBeCloseTo(1, 6);

    // Still one chunk right up to the window's edge...
    expect(flashes.read(BODY, 60, 100, FLASH_HOLD_MS - 1).ghost).toBeCloseTo(1, 6);
    // ...and gone one drain later, measured from the first blow rather than the last.
    const after = flashes.read(BODY, 60, 100, FLASH_HOLD_MS + FLASH_DRAIN_MS + 1);
    expect(after.ghost).toBeCloseTo(0.6, 6);
  });

  it('opens the next window from wherever the white had got to', () => {
    const flashes = new HealthFlashes();
    flashes.read(BODY, 100, 100, 0);
    flashes.read(BODY, 80, 100, 0);
    const middle = FLASH_HOLD_MS + FLASH_DRAIN_MS / 2;
    const halfway = flashes.read(BODY, 80, 100, middle);
    expect(halfway.ghost).toBeGreaterThan(0.8);
    expect(halfway.ghost).toBeLessThan(1);

    // A blow mid-retreat must not jump the chunk back up the bar.
    const next = flashes.read(BODY, 70, 100, middle);
    expect(next.ghost).toBeCloseTo(halfway.ghost, 6);
    expect(next.health).toBeCloseTo(0.7, 6);
    // And it is a fresh hold: still there a full drain after the *old* window.
    expect(flashes.read(BODY, 70, 100, middle + FLASH_HOLD_MS - 1).ghost).toBeCloseTo(halfway.ghost, 6);
  });

  it('lets a heal close the window rather than pinning white above the fill', () => {
    const flashes = new HealthFlashes();
    flashes.read(BODY, 100, 100, 0);
    flashes.read(BODY, 60, 100, 0);
    const partial = flashes.read(BODY, 80, 100, 100);
    expect(partial.health).toBeCloseTo(0.8, 6);
    expect(partial.ghost).toBeCloseTo(1, 6);

    const healed = flashes.read(BODY, 100, 100, 150);
    expect(healed).toMatchObject({ health: 1, ghost: 1 });
    // Closed, not merely covered: the hold is not still running underneath.
    expect(flashes.read(BODY, 100, 100, 200)).toMatchObject({ health: 1, ghost: 1 });
  });

  it('keeps both fractions inside the bar, whatever the numbers do', () => {
    const flashes = new HealthFlashes();
    flashes.read(BODY, 100, 100, 0);
    // Overkill, a zero max, and a max that moves under the body.
    const overkill = flashes.read(BODY, -30, 100, 10);
    expect(overkill.health).toBe(0);
    expect(overkill.ghost).toBeCloseTo(1, 6);

    const noMax = flashes.read(BODY, 0, 0, 20);
    expect(noMax).toMatchObject({ health: 0, ghost: 0 });

    const grown = flashes.read(BODY, 150, 200, 30);
    expect(grown.health).toBeCloseTo(0.75, 6);
    expect(grown.ghost).toBeGreaterThanOrEqual(grown.health);
    expect(grown.ghost).toBeLessThanOrEqual(1);
  });

  it('never draws white below the fill, over a long scripted fight', () => {
    const flashes = new HealthFlashes();
    let health = 100;
    for (let frame = 0; frame < 600; frame++) {
      const now = frame * 16;
      // A deterministic script rather than a clock or a die: hits in bursts,
      // with heals between them.
      if (frame % 37 < 3) health = Math.max(0, health - 7);
      if (frame % 91 === 0) health = Math.min(100, health + 25);
      const fill = flashes.read(BODY, health, 100, now);
      expect(fill.ghost).toBeGreaterThanOrEqual(fill.health);
      expect(fill.ghost).toBeLessThanOrEqual(1);
      expect(fill.health).toBeGreaterThanOrEqual(0);
    }
  });

  it('holds rather than resolving early when the clock steps backwards', () => {
    // `drawnTick` is an estimate and a correction can walk it back a little.
    const flashes = new HealthFlashes();
    flashes.read(BODY, 100, 100, 1_000);
    flashes.read(BODY, 70, 100, 1_000);
    expect(flashes.read(BODY, 70, 100, 980).ghost).toBeCloseTo(1, 6);
  });

  it('replays a call sequence to the same fills', () => {
    const script: readonly (readonly [number, number])[] = [
      [100, 0],
      [88, 50],
      [88, 120],
      [70, 300],
      [70, 600],
      [70, 900],
      [95, 950],
    ];
    const run = (): unknown[] => {
      const flashes = new HealthFlashes();
      return script.map(([health, now]) => flashes.read(BODY, health, 100, now));
    };
    expect(run()).toEqual(run());
  });

  it('forgets a body the frame its bar goes', () => {
    const flashes = new HealthFlashes();
    flashes.read(1, 100, 100, 0);
    flashes.read(2, 100, 100, 0);
    flashes.read(3, 100, 100, 0);
    expect(flashes.tracked).toBe(3);
    flashes.retain(new Set([2]));
    expect(flashes.tracked).toBe(1);
    flashes.retain(new Set());
    expect(flashes.tracked).toBe(0);
  });
});

/** How far off its anchor a fill is knocked, whichever way it went. */
function throwOf(fill: BarFill): number {
  return Math.hypot(fill.shakeX, fill.shakeY);
}

describe('the flinch a blow gives a bar', () => {
  it('leaves an untouched bar exactly where it is', () => {
    const flashes = new HealthFlashes();
    expect(throwOf(flashes.read(BODY, 100, 100, 0))).toBe(0);
    expect(throwOf(flashes.read(BODY, 100, 100, 4_000))).toBe(0);
  });

  it('displaces the bar in the frame the blow lands', () => {
    // The point of the whole thing: contact reads as contact, not as a swing
    // that begins a quarter of a cycle after the hit.
    const flashes = new HealthFlashes();
    flashes.read(BODY, 100, 100, 0);
    const struck = flashes.read(BODY, 75, 100, 0);
    expect(Math.abs(struck.shakeX)).toBeCloseTo(SHAKE_PIXELS, 6);
    expect(struck.shakeY).toBeCloseTo(0, 6);
  });

  it('settles onto the anchor, and stays there', () => {
    const flashes = new HealthFlashes();
    flashes.read(BODY, 100, 100, 0);
    flashes.read(BODY, 75, 100, 0);
    // Sampled at the peaks -- one whole cycle apart -- so this is the envelope
    // decaying rather than the oscillation passing through zero.
    const cycle = 1000 / 15;
    let previous = throwOf(flashes.read(BODY, 75, 100, 0));
    for (let now = cycle; now < SHAKE_MS; now += cycle) {
      const swing = throwOf(flashes.read(BODY, 75, 100, now));
      expect(swing).toBeLessThan(previous);
      previous = swing;
    }
    expect(throwOf(flashes.read(BODY, 75, 100, SHAKE_MS))).toBe(0);
    expect(throwOf(flashes.read(BODY, 75, 100, SHAKE_MS + 500))).toBe(0);
  });

  it('kicks once per blow, where the chunk grows once per burst', () => {
    // The two rules pull in opposite directions on purpose (spec 146), so this
    // is the assertion that they are actually independent.
    const flashes = new HealthFlashes();
    flashes.read(BODY, 100, 100, 0);
    flashes.read(BODY, 90, 100, 0);

    // Most of the way through the first kick, it has decayed a long way...
    const fading = throwOf(flashes.read(BODY, 90, 100, SHAKE_MS * 0.75));
    // ...and the second blow of the same burst throws it out again.
    const second = flashes.read(BODY, 80, 100, SHAKE_MS * 0.75);
    expect(throwOf(second)).toBeGreaterThan(fading * 2);
    // While the white chunk is still the one the *first* blow opened.
    expect(second.ghost).toBeCloseTo(1, 6);
  });

  it('kicks harder for a bigger blow', () => {
    const light = new HealthFlashes();
    light.read(BODY, 100, 100, 0);
    const scratch = throwOf(light.read(BODY, 98, 100, 0));

    const heavy = new HealthFlashes();
    heavy.read(BODY, 100, 100, 0);
    const wallop = throwOf(heavy.read(BODY, 60, 100, 0));

    expect(wallop).toBeGreaterThan(scratch);
    // ...and a scratch still registers rather than rounding to nothing.
    expect(scratch).toBeGreaterThan(0.3);
  });

  it('never throws the bar off the head it belongs to', () => {
    const flashes = new HealthFlashes();
    flashes.read(BODY, 100, 100, 0);
    // Overkill, a zero max, a max that moves, and a long burst.
    let health = 100;
    for (let frame = 0; frame < 400; frame++) {
      const now = frame * 16;
      if (frame % 5 === 0) health -= 30;
      const max = frame % 97 === 0 ? 0 : 100;
      const fill = flashes.read(BODY, health, max, now);
      expect(Math.abs(fill.shakeX)).toBeLessThanOrEqual(SHAKE_PIXELS + 1e-9);
      expect(Math.abs(fill.shakeY)).toBeLessThanOrEqual(SHAKE_PIXELS + 1e-9);
      if (health <= 0) health = 100;
    }
  });

  it('does not kick for a heal', () => {
    const flashes = new HealthFlashes();
    flashes.read(BODY, 50, 100, 0);
    expect(throwOf(flashes.read(BODY, 80, 100, 10))).toBe(0);
    expect(throwOf(flashes.read(BODY, 100, 100, 20))).toBe(0);
  });

  it('holds the kick rather than swinging when the clock steps backwards', () => {
    const flashes = new HealthFlashes();
    flashes.read(BODY, 100, 100, 1_000);
    const struck = flashes.read(BODY, 75, 100, 1_000);
    const rewound = flashes.read(BODY, 75, 100, 985);
    expect(throwOf(rewound)).toBeCloseTo(throwOf(struck), 6);
  });
});
