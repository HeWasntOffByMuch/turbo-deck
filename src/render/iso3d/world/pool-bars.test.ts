import { describe, expect, it } from 'vitest';
import type { ClientView } from '../../../server/client/game-client.js';
import { hasGlyph } from './pixel-font.js';
import { poolBars } from './pool-bars.js';

function viewFixture(overrides: Record<string, unknown> = {}): ClientView {
  return {
    selfEntityId: 7,
    entities: [{ id: 7, health: 84, maxHealth: 120 }],
    resource: 12,
    stats: { maxHealth: 120, maxResource: 30 },
    ...overrides,
  } as unknown as ClientView;
}

describe('the pool bars', () => {
  it('reads health off the body and resource off the client’s own pool', () => {
    const bars = poolBars(viewFixture());
    expect(bars.health.fraction).toBeCloseTo(0.7, 5);
    expect(bars.health.text).toBe('84 / 120');
    expect(bars.resource.fraction).toBeCloseTo(0.4, 5);
    expect(bars.resource.text).toBe('12 / 30');
  });

  it('shows an unknown maximum as unknown, not as empty', () => {
    // Before the first `Stats` message there is no stat block. Dividing by the
    // zero standing in for it paints an empty health bar over a player at full
    // health for the opening frames of every session.
    const bars = poolBars(viewFixture({ stats: null }));
    expect(bars.health.known).toBe(false);
    expect(bars.health.fraction).toBe(0);
    expect(bars.health.text).toBe('-- / --');
  });

  it('is empty at zero health rather than negative', () => {
    const bars = poolBars(
      viewFixture({ entities: [{ id: 7, health: -30, maxHealth: 120 }] }),
    );
    expect(bars.health.fraction).toBe(0);
    expect(bars.health.current).toBe(0);
  });

  it('never overflows its track', () => {
    const bars = poolBars(viewFixture({ resource: 999 }));
    expect(bars.resource.fraction).toBe(1);
  });

  it('says nothing the game’s font cannot draw', () => {
    // Drawn in `pixel-font.ts`, which has one case and a fixed set of symbols --
    // the em dash the unknown label used to be came out as a solid block.
    for (const view of [viewFixture(), viewFixture({ stats: null })]) {
      const bars = poolBars(view);
      for (const bar of [bars.health, bars.resource]) {
        for (const character of bar.text) {
          expect(hasGlyph(character), `${JSON.stringify(character)} in "${bar.text}"`).toBe(true);
        }
      }
    }
  });

  it('is empty for a client with no body yet', () => {
    const bars = poolBars(viewFixture({ entities: [] }));
    expect(bars.health.fraction).toBe(0);
    // The maximum is still known, so the bar draws a track rather than a dash.
    expect(bars.health.known).toBe(true);
  });
});
