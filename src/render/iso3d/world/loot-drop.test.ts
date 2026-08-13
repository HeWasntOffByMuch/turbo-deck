/**
 * What a drop looks like while it is still withholding itself (spec 154).
 *
 * The claims worth a test here are the ones a screenshot cannot make: that the
 * label is genuinely absent rather than merely unstyled, that a cue fires once
 * and only for a transition this client actually watched, and that ordinary
 * loot is quieter than everything else at *every* instant rather than on
 * average.
 */

import { describe, expect, it } from 'vitest';
import type { DropView } from '../../../server/client/game-client.js';
import { anticipationTickFor, RevealPhase, revealPhaseAt } from '../../../server/sim/loot.js';
import { rarityRow } from '../../../server/data/loot.js';
import { RARITY_IDS, type RarityId } from '../../../server/data/items.js';
import { DropPresenter, flareAt, pickupOrderFor, REVEAL_SETTLE_TICKS } from './loot-drop.js';

/** A drop exactly as the client would have built it off the wire. */
function view(rarity: RarityId, spawnTick = 0, revealed = false): DropView {
  const row = rarityRow(rarity);
  const revealTick = spawnTick + row.revealTicks;
  const known = revealed || row.revealTicks === 0;
  return {
    entityId: 7,
    rarity,
    spawnTick,
    anticipationTick: anticipationTickFor(rarity, spawnTick, revealTick),
    revealTick,
    phase: revealPhaseAt({ anticipationTick: spawnTick, revealTick }, spawnTick),
    defId: known ? 'sword.keen' : null,
    name: known ? 'Keen Longsword' : null,
    count: known ? 1 : 0,
  };
}

describe('the flare', () => {
  it('stays inside its tier’s own band, at every tick', () => {
    for (const rarity of RARITY_IDS) {
      const row = rarityRow(rarity);
      const drop = view(rarity);
      for (let tick = 0; tick <= drop.revealTick + REVEAL_SETTLE_TICKS * 3; tick++) {
        const flare = flareAt(drop, tick);
        expect(flare, `${rarity} @ ${tick}`).toBeGreaterThanOrEqual(row.restFlare - 1e-9);
        expect(flare, `${rarity} @ ${tick}`).toBeLessThanOrEqual(row.peakFlare + 1e-9);
      }
    }
  });

  /**
   * The contrast rule, measured: ordinary loot never competes with the drop
   * that is worth looking at. See `docs/reward-philosophy.md` §3.
   */
  it('keeps common loot dimmer than every other tier at every tick', () => {
    const common = view('common');
    for (const rarity of RARITY_IDS.filter((id) => id !== 'common')) {
      const loud = view(rarity);
      for (let tick = 0; tick <= loud.revealTick + REVEAL_SETTLE_TICKS * 2; tick++) {
        expect(flareAt(common, tick), `${rarity} @ ${tick}`).toBeLessThan(flareAt(loud, tick));
      }
    }
  });

  it('leaves a common drop flat -- no run-up, no flash, no settle', () => {
    const drop = view('common');
    const row = rarityRow('common');
    for (let tick = 0; tick < 300; tick++) expect(flareAt(drop, tick)).toBeCloseTo(row.restFlare, 9);
  });

  it('rises through the anticipation and settles after the reveal', () => {
    const drop = view('exceptional');
    const row = rarityRow('exceptional');
    expect(flareAt(drop, drop.spawnTick)).toBeCloseTo(row.restFlare, 9);
    expect(flareAt(drop, drop.revealTick - 1)).toBeGreaterThan(row.restFlare);
    expect(flareAt(drop, drop.revealTick)).toBeCloseTo(row.peakFlare, 9);
    // ...and comes all the way back down, rather than leaving a lit object.
    expect(flareAt(drop, drop.revealTick + REVEAL_SETTLE_TICKS)).toBeCloseTo(row.restFlare, 9);
    expect(flareAt(drop, drop.revealTick + 10_000)).toBeCloseTo(row.restFlare, 9);
  });

  it('rises monotonically through the run-up', () => {
    const drop = view('rare');
    let previous = -1;
    for (let tick = drop.anticipationTick; tick <= drop.revealTick; tick++) {
      const flare = flareAt(drop, tick);
      expect(flare).toBeGreaterThanOrEqual(previous);
      previous = flare;
    }
  });
});

describe('the label', () => {
  it('is null for as long as the server is withholding the item', () => {
    const presenter = new DropPresenter();
    const drop = view('rare');
    for (let tick = drop.spawnTick; tick < drop.revealTick; tick++) {
      const shown = presenter.read(drop, tick);
      expect(shown.label, `@ ${tick}`).toBeNull();
      expect(shown.phase).not.toBe(RevealPhase.Revealed);
    }
  });

  /**
   * And there is no placeholder either. A "???" is the interface announcing
   * that it is hiding something, which is the opposite of noticing an object.
   */
  it('is the item’s real name once it arrives, and nothing before it', () => {
    const presenter = new DropPresenter();
    expect(presenter.read(view('rare'), 0).label).toBeNull();
    const revealed = view('rare', 0, true);
    expect(presenter.read(revealed, revealed.revealTick).label).toBe('Keen Longsword');
  });
});

describe('the cues', () => {
  it('fires spawn, then anticipation, then reveal -- each exactly once', () => {
    const presenter = new DropPresenter();
    const drop = view('rare');
    const fired: { tick: number; cue: string }[] = [];
    for (let tick = 0; tick <= drop.revealTick + 60; tick++) {
      for (const cue of presenter.read(drop, tick).cues) fired.push({ tick, cue });
    }
    expect(fired.map((entry) => entry.cue)).toEqual([
      'loot.spawn.rare',
      'loot.anticipation.rare',
      'loot.reveal.rare',
    ]);
    expect(fired[1]?.tick).toBe(drop.anticipationTick);
    expect(fired[2]?.tick).toBe(drop.revealTick);
  });

  it('says nothing but "something landed" for a common drop', () => {
    const presenter = new DropPresenter();
    const drop = view('common');
    const fired: string[] = [];
    for (let tick = 0; tick < 200; tick++) fired.push(...presenter.read(drop, tick).cues);
    expect(fired).toEqual(['loot.spawn.common']);
  });

  /** A frame drawn twice on one tick must not double every cue. */
  it('is silent on a re-read of the same tick', () => {
    const presenter = new DropPresenter();
    const drop = view('rare');
    expect(presenter.read(drop, 0).cues).toEqual(['loot.spawn.rare']);
    expect(presenter.read(drop, 0).cues).toEqual([]);
    expect(presenter.read(drop, drop.revealTick).cues).toEqual([
      'loot.anticipation.rare',
      'loot.reveal.rare',
    ]);
  });

  /**
   * The late-observer rule: somebody who walks up to a drop that resolved a
   * minute ago gets the object, not a fanfare for an event they missed.
   */
  it('gives a late observer the spawn cue and nothing else', () => {
    const presenter = new DropPresenter();
    const drop = view('exceptional', 0, true);
    const first = presenter.read(drop, drop.revealTick + 500);
    expect(first.cues).toEqual(['loot.spawn.exceptional']);
    expect(first.label).toBe('Keen Longsword');
    expect(presenter.read(drop, drop.revealTick + 501).cues).toEqual([]);
  });

  it('forgets a drop that has left, and remembers one that has not', () => {
    const presenter = new DropPresenter();
    presenter.read(view('rare'), 0);
    expect(presenter.tracked).toBe(1);
    presenter.retain(new Set([7]));
    expect(presenter.tracked).toBe(1);
    presenter.retain(new Set());
    expect(presenter.tracked).toBe(0);
  });
});

describe('walking over to it', () => {
  const drop = { entityId: 3, x: 100, y: 0 };

  it('walks while it is out of reach and stops when it is not', () => {
    const far = pickupOrderFor({
      self: { x: 0, y: 0 },
      selfHealth: 100,
      drop,
      reach: 50,
      pending: false,
    });
    expect(far.walkTo).toEqual({ x: 100, y: 0 });
    expect(far.ask).toBe(false);

    const near = pickupOrderFor({
      self: { x: 70, y: 0 },
      selfHealth: 100,
      drop,
      reach: 50,
      pending: false,
    });
    expect(near.walkTo).toBeNull();
    expect(near.ask).toBe(true);
  });

  /** One ask, not sixty a second while the answer is in flight. */
  it('does not ask twice while a request is unanswered', () => {
    const order = pickupOrderFor({
      self: { x: 100, y: 0 },
      selfHealth: 100,
      drop,
      reach: 50,
      pending: true,
    });
    expect(order.ask).toBe(false);
    expect(order.walkTo).toBeNull();
  });

  it('does nothing without an order, and nothing while dead', () => {
    expect(
      pickupOrderFor({ self: { x: 0, y: 0 }, selfHealth: 100, drop: null, reach: 50, pending: false }),
    ).toEqual({ walkTo: null, ask: false });
    expect(
      pickupOrderFor({ self: { x: 100, y: 0 }, selfHealth: 0, drop, reach: 50, pending: false }),
    ).toEqual({ walkTo: null, ask: false });
  });
});
