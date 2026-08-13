/**
 * The drop and its clock (spec 154).
 *
 * The properties here are the ones the whole feature rests on: the item is
 * decided once, the reveal is derived rather than stored, and the roll is a
 * pure function of a seed. Everything about presentation is downstream of
 * these three and none of them needs a server, a socket or a frame.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../../shared/prng.js';
import { MAX_REVEAL_SCALE, SERVER_TICK_RATE } from '../config.js';
import { ALL_ITEMS, rarityOf, RARITY_IDS, rarityFromByte, rarityToByte } from '../data/items.js';
import { ALL_RARITIES, DROP_LIFETIME_TICKS, DROP_TABLES, rarityRow, rollLoot } from '../data/loot.js';
import { isRevealed, makeDrop, RevealPhase, revealPhaseAt, revealsOn } from './loot.js';

describe('the rarity table', () => {
  it('has a row for every tier, and only for tiers', () => {
    expect(ALL_RARITIES.map((row) => row.id).sort()).toEqual([...RARITY_IDS].sort());
  });

  it('round-trips every tier through a byte', () => {
    for (const id of RARITY_IDS) expect(rarityFromByte(rarityToByte(id))).toBe(id);
  });

  /** A build behind should draw a quiet drop, not throw halfway through a frame. */
  it('reads an unknown byte as common', () => {
    for (const byte of [-1, 3, 200, Number.NaN]) expect(rarityFromByte(byte)).toBe('common');
  });

  /**
   * The contrast rule, as a test rather than as a comment: ordinary loot has no
   * beat at all, so the rare one keeps its meaning. See
   * `docs/reward-philosophy.md` §3.
   */
  it('gives common loot no reveal, no anticipation and no cue', () => {
    const common = rarityRow('common');
    expect(common.revealTicks).toBe(0);
    expect(common.anticipationTicks).toBe(0);
    expect(common.cues.anticipation).toBe('');
    expect(common.cues.reveal).toBe('');
  });

  it('escalates strictly with the tier, and never past the drop lifetime', () => {
    const rows = RARITY_IDS.map((id) => rarityRow(id));
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1];
      const row = rows[i];
      if (!previous || !row) throw new Error('missing row');
      expect(row.revealTicks).toBeGreaterThan(previous.revealTicks);
      expect(row.restFlare).toBeGreaterThan(previous.restFlare);
    }
    for (const row of rows) {
      expect(row.anticipationTicks).toBeLessThanOrEqual(row.revealTicks);
      // Even at the loudest a knob may be turned to, the reveal has to land
      // well inside the drop's own life -- an item that expired without ever
      // saying what it was is a bug with a config value in front of it.
      expect(row.revealTicks * MAX_REVEAL_SCALE).toBeLessThan(DROP_LIFETIME_TICKS);
    }
  });

  /** A beat, not a wait: the whole reveal fits inside a couple of seconds. */
  it('keeps every reveal under two seconds at the authored scale', () => {
    for (const row of ALL_RARITIES) expect(row.revealTicks).toBeLessThanOrEqual(SERVER_TICK_RATE * 2);
  });
});

describe('a drop is decided at once and revealed afterwards', () => {
  it('stamps a common drop as revealed on the tick it lands', () => {
    const drop = makeDrop('potion.minor', 1, 'common', 'ana', 500, 1);
    expect(drop.revealTick).toBe(500);
    expect(revealPhaseAt(drop, 500)).toBe(RevealPhase.Revealed);
    expect(isRevealed(drop, 500)).toBe(true);
    // ...and therefore announces nothing: the first message a client gets
    // already carries the answer.
    expect(revealsOn(drop, 500)).toBe(false);
  });

  it('walks a rare drop through all three phases, in order, and lands exactly', () => {
    const drop = makeDrop('sword.keen', 1, 'rare', 'ana', 100, 1);
    const row = rarityRow('rare');
    expect(drop.anticipationTick).toBe(100 + row.anticipationTicks);
    expect(drop.revealTick).toBe(100 + row.revealTicks);

    expect(revealPhaseAt(drop, 100)).toBe(RevealPhase.Spawned);
    expect(revealPhaseAt(drop, drop.anticipationTick - 1)).toBe(RevealPhase.Spawned);
    expect(revealPhaseAt(drop, drop.anticipationTick)).toBe(RevealPhase.Anticipation);
    expect(revealPhaseAt(drop, drop.revealTick - 1)).toBe(RevealPhase.Anticipation);
    expect(revealPhaseAt(drop, drop.revealTick)).toBe(RevealPhase.Revealed);
  });

  it('is monotone in tick, and never goes backwards', () => {
    const drop = makeDrop('trinket.bloodstone', 1, 'exceptional', 'ana', 0, 1);
    let highest = RevealPhase.Spawned as number;
    for (let tick = 0; tick <= drop.revealTick + 30; tick++) {
      const phase = revealPhaseAt(drop, tick);
      expect(phase).toBeGreaterThanOrEqual(highest);
      highest = phase;
    }
    expect(highest).toBe(RevealPhase.Revealed);
  });

  /** The property the sim's one-message-per-reveal rule is built on. */
  it('crosses into revealed on exactly one tick', () => {
    const drop = makeDrop('sword.keen', 1, 'rare', 'ana', 7, 1);
    let crossings = 0;
    for (let tick = 0; tick <= drop.revealTick + 100; tick++) if (revealsOn(drop, tick)) crossings++;
    expect(crossings).toBe(1);
    expect(revealsOn(drop, drop.revealTick)).toBe(true);
  });

  /**
   * Asking about a drop is not a way of advancing it. Nothing here is stored, so
   * reading it a thousand times leaves the drop the object it was.
   */
  it('is not changed by being asked', () => {
    const drop = makeDrop('sword.keen', 1, 'rare', 'ana', 0, 1);
    const before = JSON.stringify(drop);
    for (let tick = 0; tick < 200; tick++) revealPhaseAt(drop, tick);
    expect(JSON.stringify(drop)).toBe(before);
  });

  it('honours the reveal scale, and clamps a nonsense one', () => {
    const row = rarityRow('rare');
    expect(makeDrop('sword.keen', 1, 'rare', null, 0, 0).revealTick).toBe(0);
    expect(makeDrop('sword.keen', 1, 'rare', null, 0, 2).revealTick).toBe(row.revealTicks * 2);
    expect(makeDrop('sword.keen', 1, 'rare', null, 0, -5).revealTick).toBe(0);
    expect(makeDrop('sword.keen', 1, 'rare', null, 0, 1e9).revealTick).toBe(
      row.revealTicks * MAX_REVEAL_SCALE,
    );
  });

  /** A lead that overshot its own reveal would fire a cue for a closed window. */
  it('never puts the anticipation past the reveal, at any scale', () => {
    for (const id of RARITY_IDS) {
      for (const scale of [0, 0.01, 0.5, 1, 3, MAX_REVEAL_SCALE]) {
        const drop = makeDrop('x', 1, id, null, 0, scale);
        expect(drop.anticipationTick).toBeLessThanOrEqual(drop.revealTick);
        expect(drop.spawnTick).toBeLessThanOrEqual(drop.anticipationTick);
      }
    }
  });

  it('expires long after it reveals, whatever the scale', () => {
    for (const id of RARITY_IDS) {
      const drop = makeDrop('x', 1, id, null, 0, MAX_REVEAL_SCALE);
      expect(drop.expiresTick).toBeGreaterThan(drop.revealTick);
    }
  });
});

describe('the roll', () => {
  it('reproduces exactly from a seed', () => {
    const run = (): (string | null)[] => {
      let rng = Rng.fromSeed(4242);
      const out: (string | null)[] = [];
      for (let i = 0; i < 200; i++) {
        const [stack, next] = rollLoot(rng, 'ravager', 1);
        rng = next;
        out.push(stack?.defId ?? null);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  /**
   * The rule `blow.ts` states about rolling crit before the weak point, and it
   * applies just as hard here: a body that drew a different number of values
   * depending on its own outcome would change every fight after it.
   */
  it('draws the same number of values whatever the outcome', () => {
    let rng = Rng.fromSeed(9);
    const states: string[] = [];
    for (let i = 0; i < 40; i++) {
      const [, next] = rollLoot(rng, 'grazer', 1);
      rng = next;
      states.push(JSON.stringify(rng.getState()));
    }
    // Every step advanced the generator, hit or miss.
    expect(new Set(states).size).toBe(states.length);
  });

  it('drops nothing for a monster with no table, without touching the rng', () => {
    const rng = Rng.fromSeed(3);
    const [stack, next] = rollLoot(rng, 'dummy', 1);
    expect(stack).toBeNull();
    expect(next.getState()).toEqual(rng.getState());
  });

  it('drops nothing at all when the multiplier is zero', () => {
    let rng = Rng.fromSeed(11);
    for (let i = 0; i < 500; i++) {
      const [stack, next] = rollLoot(rng, 'ravager', 0);
      rng = next;
      expect(stack).toBeNull();
    }
  });

  it('drops something every time when the multiplier is high enough', () => {
    let rng = Rng.fromSeed(12);
    for (let i = 0; i < 200; i++) {
      const [stack, next] = rollLoot(rng, 'ravager', 100);
      rng = next;
      expect(stack).not.toBeNull();
    }
  });

  it('only ever names items that exist, in counts a bag can hold', () => {
    let rng = Rng.fromSeed(77);
    for (let i = 0; i < 400; i++) {
      const [stack, next] = rollLoot(rng, 'slinger', 4);
      rng = next;
      if (!stack) continue;
      expect(ALL_ITEMS.some((item) => item.id === stack.defId)).toBe(true);
      expect(stack.count).toBeGreaterThanOrEqual(1);
    }
  });

  it('names only real items in every authored table', () => {
    for (const [monsterId, table] of DROP_TABLES) {
      expect(table.chance, monsterId).toBeGreaterThan(0);
      expect(table.chance, monsterId).toBeLessThanOrEqual(1);
      for (const entry of table.entries) {
        expect(ALL_ITEMS.some((item) => item.id === entry.defId), entry.defId).toBe(true);
        expect(entry.weight, entry.defId).toBeGreaterThan(0);
        expect(entry.count, entry.defId).toBeGreaterThanOrEqual(1);
      }
    }
  });

  /**
   * Ordinary drops have to outnumber the noteworthy ones by a lot, or the beat
   * stops meaning anything -- the contrast argument, measured rather than
   * asserted in a comment.
   */
  it('leaves the loud tiers rare against the quiet one', () => {
    let rng = Rng.fromSeed(2026);
    const tally = { common: 0, rare: 0, exceptional: 0 };
    for (let i = 0; i < 4000; i++) {
      const [stack, next] = rollLoot(rng, 'ravager', 1);
      rng = next;
      if (stack) tally[rarityOf(stack.defId)] += 1;
    }
    expect(tally.common).toBeGreaterThan(tally.rare * 1.5);
    expect(tally.rare).toBeGreaterThan(tally.exceptional * 3);
  });
});
