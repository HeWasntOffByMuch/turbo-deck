/**
 * What a drop looks like while it is still withholding itself (spec 158).
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
import { BROADCAST_EVERY_N_TICKS } from '../../../server/config.js';
import {
  DropPresenter,
  flareAt,
  heartbeatAt,
  pickupLead,
  HEARTBEAT_TICKS,
  pickupOrderFor,
  HIDDEN_PEAK_FLARE,
  REVEAL_SETTLE_TICKS,
  TIER_BLEND_TICKS,
  tierMixAt,
  tossAt,
  TOSS_TICKS,
} from './loot-drop.js';

const ORIGIN = { x: 100, y: 100, z: 0 };
const LANDING = { x: 124, y: 118, z: 0 };

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
    origin: ORIGIN,
    phase: revealPhaseAt({ anticipationTick: spawnTick, revealTick }, spawnTick),
    defId: known ? 'sword.keen' : null,
    name: known ? 'Keen Longsword' : null,
    count: known ? 1 : 0,
  };
}

describe('the flare', () => {
  /**
   * The bug this replaced a test for.
   *
   * The old assertion was that common is *dimmer* than every other tier at
   * every tick -- which is true, and was the leak: on the landing tick a rare
   * drop's halo was fourteen times a common one's and an exceptional's
   * thirty-four, so the tier was readable off the aura instantly. A test can
   * enforce a bug as easily as it can catch one.
   */
  it('is identical across every tier until each one reveals', () => {
    const common = view('common');
    for (const rarity of RARITY_IDS.filter((id) => id !== 'common')) {
      const hidden = view(rarity);
      for (let tick = hidden.spawnTick; tick < hidden.revealTick; tick++) {
        // ...and identical to what ordinary loot looks like at rest, at the
        // moment it lands, so a drop that is about to be something gives
        // nothing away by lying there.
        if (tick === hidden.spawnTick) {
          expect(flareAt(hidden, tick), `${rarity} @ landing`).toBeCloseTo(flareAt(common, tick), 9);
        }
        // Rare and exceptional run up to the same place, so neither says which
        // it is on the way.
        const other = RARITY_IDS.filter((id) => id !== 'common' && id !== rarity)[0];
        if (!other) continue;
        const peer = view(other);
        if (tick < peer.revealTick) {
          const throughA = (tick - hidden.anticipationTick) / (hidden.revealTick - hidden.anticipationTick);
          const throughB = (tick - peer.anticipationTick) / (peer.revealTick - peer.anticipationTick);
          // Compared at the same point *through* each run-up rather than at the
          // same tick: the run-ups are different lengths on purpose -- a longer
          // build is the anticipation doing its job -- but they travel between
          // the same two values.
          if (throughA > 0 && throughA < 1 && Math.abs(throughA - throughB) < 0.02) {
            expect(flareAt(hidden, tick)).toBeCloseTo(
              flareAt(peer, peer.anticipationTick + throughA * (peer.revealTick - peer.anticipationTick)),
              6,
            );
          }
        }
      }
    }
  });

  /** ...and only *after* the reveal does the tier show in the resting glow. */
  it('separates the tiers only once each has revealed', () => {
    const common = view('common');
    for (const rarity of RARITY_IDS.filter((id) => id !== 'common')) {
      const loud = view(rarity);
      const settled = loud.revealTick + REVEAL_SETTLE_TICKS;
      expect(flareAt(common, settled)).toBeLessThan(flareAt(loud, settled));
    }
  });

  /**
   * The contrast rule, measured where it applies: once everything has resolved,
   * ordinary loot does not compete with the drop worth looking at. See
   * `docs/reward-philosophy.md` §3.
   */
  it('leaves ordinary loot the quietest thing in the world, once resolved', () => {
    const resting = RARITY_IDS.map((rarity) => {
      const drop = view(rarity);
      return flareAt(drop, drop.revealTick + REVEAL_SETTLE_TICKS * 2);
    });
    for (let i = 1; i < resting.length; i++) {
      expect(resting[i]).toBeGreaterThan(resting[i - 1] ?? 0);
    }
  });

  it('leaves a common drop flat -- no run-up, no flash, no settle', () => {
    const drop = view('common');
    const row = rarityRow('common');
    for (let tick = 0; tick < 300; tick++) expect(flareAt(drop, tick)).toBeCloseTo(row.restFlare, 9);
  });

  it('holds still for half a second before anything starts to change', () => {
    for (const rarity of ['rare', 'exceptional'] as const) {
      const drop = view(rarity);
      const hidden = flareAt(drop, drop.spawnTick);
      // Half a second, and the throw is over well inside it -- so the object
      // lands, settles, and only then does something begin.
      expect(drop.anticipationTick - drop.spawnTick).toBe(30);
      expect(drop.anticipationTick - drop.spawnTick).toBeGreaterThan(TOSS_TICKS);
      for (let tick = drop.spawnTick; tick <= drop.anticipationTick; tick++) {
        expect(flareAt(drop, tick), `${rarity} @ ${tick}`).toBeCloseTo(hidden, 9);
      }
      // ...and then it does.
      expect(flareAt(drop, drop.anticipationTick + 6)).toBeGreaterThan(hidden);
    }
  });

  it('rises through the anticipation and holds after the reveal', () => {
    const drop = view('exceptional');
    const row = rarityRow('exceptional');
    const hidden = flareAt(view('common'), 0);
    // Starts where ordinary loot sits...
    expect(flareAt(drop, drop.spawnTick)).toBeCloseTo(hidden, 9);
    // ...builds to the shared peak, which says nothing about the tier...
    expect(flareAt(drop, drop.revealTick)).toBeCloseTo(HIDDEN_PEAK_FLARE, 9);
    // ...and climbs the rest of the way to its own, where it stays.
    expect(flareAt(drop, drop.revealTick + REVEAL_SETTLE_TICKS)).toBeCloseTo(row.restFlare, 9);
    expect(flareAt(drop, drop.revealTick + 10_000)).toBeCloseTo(row.restFlare, 9);
  });

  /**
   * The rule the whole curve is built on: **it never decreases.**
   *
   * It used to climb to 0.85 through the anticipation and then halve to a
   * rare's resting 0.45 -- the aura deflating at the exact moment the reveal
   * was meant to be paying off.
   */
  it('never gets dimmer than it has been, at any tier, ever', () => {
    for (const rarity of RARITY_IDS) {
      const drop = view(rarity);
      let previous = -Infinity;
      for (let tick = drop.spawnTick; tick <= drop.revealTick + REVEAL_SETTLE_TICKS * 4; tick++) {
        const flare = flareAt(drop, tick);
        expect(flare, `${rarity} @ ${tick}`).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = flare;
      }
    }
  });

  /** The table has to hold up its end of that, or the curve cannot. */
  it('authors no tier that would sag at its own reveal', () => {
    for (const rarity of RARITY_IDS) {
      const row = rarityRow(rarity);
      if (row.revealTicks === 0) continue;
      expect(row.restFlare, rarity).toBeGreaterThanOrEqual(HIDDEN_PEAK_FLARE);
    }
  });
});

describe('the throw', () => {
  it('starts at the body and ends at the landing, exactly', () => {
    const drop = view('rare');
    expect(tossAt(drop, LANDING, drop.spawnTick)).toEqual(ORIGIN);
    expect(tossAt(drop, LANDING, drop.spawnTick + TOSS_TICKS)).toEqual(LANDING);
    // ...and stays there. A client that connected a minute later computes the
    // resting position from the same two numbers, with no branch saying so.
    expect(tossAt(drop, LANDING, drop.spawnTick + 100_000)).toEqual(LANDING);
  });

  it('arcs above the straight line in between, and comes back down', () => {
    const drop = view('rare');
    let highest = -Infinity;
    let previousGround = -1;
    for (let i = 0; i <= TOSS_TICKS; i++) {
      const at = tossAt(drop, LANDING, drop.spawnTick + i);
      highest = Math.max(highest, at.z);
      // The ground track is monotone: it travels one way, however it arcs.
      const along = Math.hypot(at.x - ORIGIN.x, at.y - ORIGIN.y);
      expect(along).toBeGreaterThanOrEqual(previousGround - 1e-9);
      previousGround = along;
    }
    expect(highest).toBeGreaterThan(Math.max(ORIGIN.z, LANDING.z));
    expect(tossAt(drop, LANDING, drop.spawnTick + TOSS_TICKS).z).toBe(LANDING.z);
  });

  /** A drop that barely moved still hops, or it reads as having been placed. */
  it('still arcs when the scatter was tiny', () => {
    const drop = view('common');
    const nearby = { x: ORIGIN.x + 1, y: ORIGIN.y, z: 0 };
    const mid = tossAt(drop, nearby, drop.spawnTick + TOSS_TICKS / 2);
    expect(mid.z).toBeGreaterThan(1);
  });

  it('is the same throw for every observer, because it is a function of two ticks', () => {
    const drop = view('exceptional');
    const early = tossAt(drop, LANDING, drop.spawnTick + 5);
    const same = tossAt(drop, LANDING, drop.spawnTick + 5);
    expect(early).toEqual(same);
  });
});

describe('the heartbeat', () => {
  it('does not beat for common loot, ever', () => {
    const drop = view('common');
    for (let tick = 0; tick < HEARTBEAT_TICKS * 3; tick++) {
      expect(heartbeatAt(drop, tick)).toBe(1);
    }
  });

  /** The correction: a pulse before the reveal says "rare or better" for free. */
  it('is withheld entirely until the reveal', () => {
    for (const rarity of ['rare', 'exceptional'] as const) {
      const drop = view(rarity);
      for (let tick = drop.spawnTick; tick < drop.revealTick; tick++) {
        expect(heartbeatAt(drop, tick), `${rarity} @ ${tick}`).toBe(1);
      }
    }
  });

  /** ...and the first beat lands *on* the reveal, as its punctuation. */
  it('starts its cycle at the reveal tick', () => {
    const drop = view('exceptional');
    expect(heartbeatAt(drop, drop.revealTick)).toBeGreaterThan(1.05);
    expect(heartbeatAt(drop, drop.revealTick - 1)).toBe(1);
  });

  it('beats twice a cycle -- a big one and a small one behind it', () => {
    const drop = view('rare');
    const cycle: number[] = [];
    for (let t = 0; t < HEARTBEAT_TICKS; t++) cycle.push(heartbeatAt(drop, drop.revealTick + t));

    // Count local maxima strictly above the resting scale.
    const peaks: number[] = [];
    for (let t = 1; t < cycle.length - 1; t++) {
      const here = cycle[t] ?? 1;
      if (here > (cycle[t - 1] ?? 1) && here > (cycle[t + 1] ?? 1) && here > 1.001) peaks.push(t);
    }
    // The lub sits at t=0 (the cycle boundary, so not a local max inside it) and
    // the dub is the one interior peak.
    expect(peaks).toHaveLength(1);
    expect(cycle[0]).toBeGreaterThan(1.05);
    // ...and the second beat is genuinely smaller than the first.
    expect(cycle[peaks[0] ?? 0] ?? 0).toBeLessThan(cycle[0] ?? 0);
  });

  it('rests between beats rather than throbbing continuously', () => {
    const drop = view('exceptional');
    // Most of the second is quiet: that is what makes it a heart.
    let quiet = 0;
    for (let t = 0; t < HEARTBEAT_TICKS; t++) {
      if ((heartbeatAt(drop, drop.revealTick + t) ?? 1) < 1.01) quiet++;
    }
    expect(quiet).toBeGreaterThan(HEARTBEAT_TICKS * 0.6);
  });

  it('stays slight, and never shrinks the object', () => {
    for (const rarity of RARITY_IDS) {
      const drop = view(rarity);
      for (let t = 0; t < HEARTBEAT_TICKS * 2; t++) {
        const beat = heartbeatAt(drop, drop.revealTick + t);
        expect(beat).toBeGreaterThanOrEqual(1);
        expect(beat).toBeLessThan(1.2);
      }
    }
  });

  it('is phased off the reveal tick, so every client beats together', () => {
    const early = view('rare', 0);
    const late = view('rare', 1000);
    for (let i = 0; i < HEARTBEAT_TICKS * 2; i++) {
      expect(heartbeatAt(late, late.revealTick + i)).toBeCloseTo(
        heartbeatAt(early, early.revealTick + i),
        9,
      );
    }
  });

  /**
   * The whole withholding, stated once: nothing about a drop distinguishes one
   * tier from another *categorically* before its reveal. The flare differs by
   * tier and is meant to -- an intensity is "something is unusual", where a
   * colour and a pulse are "it is this kind of unusual".
   */
  it('leaves colour, pulse and aura all silent about the tier before the reveal', () => {
    const common = view('common');
    for (const rarity of RARITY_IDS) {
      const drop = view(rarity);
      for (let tick = drop.spawnTick; tick < drop.revealTick; tick++) {
        expect(tierMixAt(drop, tick), `${rarity} mix @ ${tick}`).toBe(0);
        expect(heartbeatAt(drop, tick), `${rarity} beat @ ${tick}`).toBe(1);
      }
      // And on the tick it lands, it is the ordinary object in every channel.
      expect(flareAt(drop, drop.spawnTick), `${rarity} flare @ landing`).toBeCloseTo(
        flareAt(common, common.spawnTick),
        9,
      );
    }
  });

  /**
   * The audio channel is a channel too. `spawn` and `anticipation` both fire
   * before the identity is known, so a tier in either name would leak it the
   * moment anything is authored for them.
   */
  it('names no tier in any cue that fires before the reveal', () => {
    const spawns = new Set(RARITY_IDS.map((id) => rarityRow(id).cues.spawn));
    expect(spawns.size, 'one landing sound for every tier').toBe(1);
    for (const rarity of RARITY_IDS) {
      const row = rarityRow(rarity);
      for (const cue of [row.cues.spawn, row.cues.anticipation]) {
        for (const tier of RARITY_IDS) {
          expect(cue, `${rarity} early cue`).not.toContain(tier);
        }
      }
      // ...and the reveal cue is exactly where the tier is allowed to be said.
      if (row.revealTicks > 0) expect(row.cues.reveal).toContain(rarity);
    }
  });
});

describe('the tier colour', () => {
  /** The correction this spec needed: the tier is not readable before the reveal. */
  it('is entirely withheld until the reveal tick', () => {
    for (const rarity of ['rare', 'exceptional'] as const) {
      const drop = view(rarity);
      for (let tick = drop.spawnTick; tick < drop.revealTick; tick++) {
        expect(tierMixAt(drop, tick), `${rarity} @ ${tick}`).toBe(0);
      }
      expect(tierMixAt(drop, drop.revealTick)).toBe(0);
      expect(tierMixAt(drop, drop.revealTick + TIER_BLEND_TICKS)).toBe(1);
    }
  });

  it('blends in rather than snapping', () => {
    const drop = view('exceptional');
    const half = tierMixAt(drop, drop.revealTick + TIER_BLEND_TICKS / 2);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
  });

  it('lets a common drop wear its own colour from the first frame', () => {
    // Its tier colour *is* the neutral one, so there is nothing to withhold.
    const drop = view('common');
    expect(tierMixAt(drop, drop.spawnTick)).toBe(0);
    expect(tierMixAt(drop, drop.spawnTick + TIER_BLEND_TICKS)).toBe(1);
  });
});

describe('the label', () => {
  it('is null for as long as the server is withholding the item', () => {
    const presenter = new DropPresenter();
    const drop = view('rare');
    for (let tick = drop.spawnTick; tick < drop.revealTick; tick++) {
      const shown = presenter.read(drop, LANDING, tick);
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
    expect(presenter.read(view('rare'), LANDING, 0).label).toBeNull();
    const revealed = view('rare', 0, true);
    expect(presenter.read(revealed, LANDING, revealed.revealTick).label).toBe('Keen Longsword');
  });
});

describe('the cues', () => {
  it('fires spawn, then anticipation, then reveal -- each exactly once', () => {
    const presenter = new DropPresenter();
    const drop = view('rare');
    const fired: { tick: number; cue: string }[] = [];
    for (let tick = 0; tick <= drop.revealTick + 60; tick++) {
      for (const cue of presenter.read(drop, LANDING, tick).cues) fired.push({ tick, cue });
    }
    expect(fired.map((entry) => entry.cue)).toEqual([
      // Neither of the first two names a tier: they fire before the identity is
      // known. Only the last one may say what it was.
      'loot.spawn',
      'loot.anticipation',
      'loot.reveal.rare',
    ]);
    expect(fired[1]?.tick).toBe(drop.anticipationTick);
    expect(fired[2]?.tick).toBe(drop.revealTick);
  });

  it('says nothing but "something landed" for a common drop', () => {
    const presenter = new DropPresenter();
    const drop = view('common');
    const fired: string[] = [];
    for (let tick = 0; tick < 200; tick++) fired.push(...presenter.read(drop, LANDING, tick).cues);
    expect(fired).toEqual(['loot.spawn']);
  });

  /** A frame drawn twice on one tick must not double every cue. */
  it('is silent on a re-read of the same tick', () => {
    const presenter = new DropPresenter();
    const drop = view('rare');
    expect(presenter.read(drop, LANDING, 0).cues).toEqual(['loot.spawn']);
    expect(presenter.read(drop, LANDING, 0).cues).toEqual([]);
    expect(presenter.read(drop, LANDING, drop.revealTick).cues).toEqual([
      'loot.anticipation',
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
    const first = presenter.read(drop, LANDING, drop.revealTick + 500);
    expect(first.cues).toEqual(['loot.spawn']);
    expect(first.label).toBe('Keen Longsword');
    expect(presenter.read(drop, LANDING, drop.revealTick + 501).cues).toEqual([]);
  });

  it('forgets a drop that has left, and remembers one that has not', () => {
    const presenter = new DropPresenter();
    presenter.read(view('rare'), LANDING, 0);
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
      lead: 0,
      pending: false,
    });
    expect(far.walkTo).toEqual({ x: 100, y: 0 });
    expect(far.ask).toBe(false);

    const near = pickupOrderFor({
      self: { x: 70, y: 0 },
      selfHealth: 100,
      drop,
      reach: 50,
      lead: 0,
      pending: false,
    });
    expect(near.walkTo).toBeNull();
    expect(near.ask).toBe(true);
  });

  /**
   * The bug this exists for: the client's prediction leads the server while it
   * walks, so arriving at *its* copy of the reach and asking earns an
   * out-of-range refusal from a server holding the body a stride further back.
   */
  it('keeps closing while the lead would put the server out of range', () => {
    const far = { entityId: 3, x: 60, y: 0 };
    // 60 away, reach 50: out of range on both clocks, so it walks.
    expect(
      pickupOrderFor({ self: { x: 0, y: 0 }, selfHealth: 100, drop: far, reach: 50, lead: 20, pending: false }).ask,
    ).toBe(false);
    // 45 away: inside the client's own reach, and *not* inside it once the
    // 20-unit lead is taken off. It keeps walking rather than asking.
    const edge = pickupOrderFor({
      self: { x: 15, y: 0 },
      selfHealth: 100,
      drop: far,
      reach: 50,
      lead: 20,
      pending: false,
    });
    expect(edge.ask).toBe(false);
    expect(edge.walkTo).toEqual({ x: 60, y: 0 });
    // 25 away: inside even with the lead taken off. Now it asks, and stops.
    const arrived = pickupOrderFor({
      self: { x: 35, y: 0 },
      selfHealth: 100,
      drop: far,
      reach: 50,
      lead: 20,
      pending: false,
    });
    expect(arrived.ask).toBe(true);
    expect(arrived.walkTo).toBeNull();
  });

  /** It stops and asks at the same distance -- or it stands there being refused. */
  it('never stops walking at a distance it will not ask from', () => {
    for (const lead of [0, 5, 20, 49, 200]) {
      for (let gap = 0; gap <= 80; gap += 1) {
        const order = pickupOrderFor({
          self: { x: 0, y: 0 },
          selfHealth: 100,
          drop: { entityId: 1, x: gap, y: 0 },
          reach: 50,
          lead,
          pending: false,
        });
        expect(order.ask, `lead ${lead} gap ${gap}`).toBe(order.walkTo === null);
      }
    }
  });

  it('derives the lead from the connection rather than assuming one', () => {
    // A body doing 150 units/s on a 12-tick round trip is 30 units ahead.
    expect(pickupLead(150, 12, 60, 126)).toBeCloseTo(30, 6);
    // A pathological connection cannot eat the whole reach.
    expect(pickupLead(150, 10_000, 60, 126)).toBe(63);
    // A body that cannot move needs no margin at all.
    expect(pickupLead(0, 12, 60, 126)).toBe(0);
  });

  /**
   * The bug: on a fast connection the measured round trip rounds to zero, the
   * lead came out zero, and the order asked from *exactly* the distance the
   * server refuses past. A prediction is never zero ticks ahead, so that was
   * one refusal and a retry on every single pickup -- "it says too far away and
   * then picks it up".
   */
  it('never lets a moving body ask from the boundary itself', () => {
    for (const rtt of [0, 1, 2, 3]) {
      const lead = pickupLead(155, rtt, 60, 126);
      expect(lead, `round trip ${rtt}`).toBeGreaterThan(0);
      // At least a broadcast interval of travel, which is the coarsest this
      // client's knowledge of where the server put it ever is.
      expect(lead, `round trip ${rtt}`).toBeCloseTo((155 * BROADCAST_EVERY_N_TICKS) / 60, 6);
    }
    // ...and a measured round trip past that floor still wins.
    expect(pickupLead(155, 20, 60, 126)).toBeGreaterThan(pickupLead(155, 0, 60, 126));
  });

  /** One ask, not sixty a second while the answer is in flight. */
  it('does not ask twice while a request is unanswered', () => {
    const order = pickupOrderFor({
      self: { x: 100, y: 0 },
      selfHealth: 100,
      drop,
      reach: 50,
      lead: 0,
      pending: true,
    });
    expect(order.ask).toBe(false);
    expect(order.walkTo).toBeNull();
  });

  it('does nothing without an order, and nothing while dead', () => {
    expect(
      pickupOrderFor({ self: { x: 0, y: 0 }, selfHealth: 100, drop: null, reach: 50, lead: 0, pending: false }),
    ).toEqual({ walkTo: null, ask: false });
    expect(
      pickupOrderFor({ self: { x: 100, y: 0 }, selfHealth: 0, drop, reach: 50, lead: 0, pending: false }),
    ).toEqual({ walkTo: null, ask: false });
  });
});
