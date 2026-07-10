import { describe, expect, it } from 'vitest';
import { deckSize, HAND_SIZE, type SpellCard, type SpellDeck, type SpellId } from '../cards/spells.js';
import { Rng } from '../shared/prng.js';
import type { EnemyState } from '../sim/types.js';
import {
  CARD_DRAW_DELAY_TICKS,
  initSpellGame,
  stepSpellGame,
  SYNERGY_WINDOW_TICKS,
  type SpellGameEvent,
  type SpellGameState,
  type SpellInput,
} from './spell-session.js';

const NEUTRAL: SpellInput = { moveX: 0, moveY: 0, aimX: 1, aimY: 0, targetX: 0, targetY: 0 };

function play(slot: 0 | 1 | 2 | 3): SpellInput {
  return { ...NEUTRAL, playHandIndex: slot };
}

/** A wave-in-progress with one near-dead enemy standing in front of the player. */
function almostClearedWave(seed: number): { state: SpellGameState; attackSlot: 0 | 1 | 2 | 3 } {
  let s = initSpellGame(seed);
  let slot = s.deck.hand.findIndex((c) => c?.id === 'attack');
  while (slot < 0) {
    s = initSpellGame(++seed);
    slot = s.deck.hand.findIndex((c) => c?.id === 'attack');
  }
  const p = s.combat.player.position;
  const enemy: EnemyState = {
    id: 1,
    type: 'brawler',
    health: 5,
    maxHealth: 21,
    position: { x: p.x + 40, y: p.y },
    behavior: 'grazing',
    phase: 'idle',
    phaseEndsAtTick: 0,
    incomingAttackOutcome: 'none',
    attackAim: null,
    grazeTarget: null,
    grazeResumeTick: Number.MAX_SAFE_INTEGER,
  };
  return {
    state: { ...s, combat: { ...s.combat, enemies: [enemy], waveNumber: 1, nextEnemyId: 2 } },
    attackSlot: slot as 0 | 1 | 2 | 3,
  };
}

function run(state: SpellGameState, inputs: readonly SpellInput[]): { state: SpellGameState; events: SpellGameEvent[] } {
  let s = state;
  const events: SpellGameEvent[] = [];
  for (const input of inputs) {
    const r = stepSpellGame(s, input);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

/** Find the slot indices whose cards match `id` in the starting hand. */
function slotsWithId(state: SpellGameState, id: SpellId): number[] {
  return state.deck.hand.flatMap((c, i) => (c && c.id === id ? [i] : []));
}

/** Count copies of `id` across the whole deck. */
function countId(deck: SpellDeck, id: SpellId): number {
  return [...deck.drawPile, ...deck.hand.filter((c) => c !== null), ...deck.discardPile].filter((c) => c && c.id === id).length;
}

describe('spell session', () => {
  it('resolves a lone card as its base spell when the window closes', () => {
    const state = initSpellGame(7);
    const { events } = run(state, [play(0), ...Array.from({ length: SYNERGY_WINDOW_TICKS }, () => NEUTRAL)]);
    const resolved = events.find((e) => e.kind === 'spellsResolved');
    expect(resolved).toBeDefined();
    if (resolved && resolved.kind === 'spellsResolved') expect(resolved.ids).toHaveLength(1);
  });

  it('fuses two identical cards played inside the window into one cast', () => {
    // Seed chosen so the opening hand holds at least two of the same card.
    let seed = 1;
    let start = initSpellGame(seed);
    while (![...new Set(start.deck.hand.map((c) => c?.id))].some((id) => id && slotsWithId(start, id).length >= 2)) {
      start = initSpellGame(++seed);
    }
    const dup = [...new Set(start.deck.hand.map((c) => c?.id))].find((id) => id && slotsWithId(start, id).length >= 2) as SpellId;
    const [a, b] = slotsWithId(start, dup) as [number, number];

    const { events } = run(start, [
      play(a as 0 | 1 | 2 | 3),
      play(b as 0 | 1 | 2 | 3),
      ...Array.from({ length: SYNERGY_WINDOW_TICKS }, () => NEUTRAL),
    ]);
    const resolved = events.filter((e) => e.kind === 'spellsResolved');
    expect(resolved).toHaveLength(1); // one window, one cast
    if (resolved[0]?.kind === 'spellsResolved') expect(resolved[0].ids).toEqual([dup, dup]);
    const casts = events.filter((e) => e.kind === 'spellCast');
    expect(casts).toHaveLength(1);
  });

  it('ignores a play on an empty slot', () => {
    let state = initSpellGame(3);
    // Empty slot 0 by playing it, then immediately try to play it again.
    state = run(state, [play(0)]).state;
    const { events } = run(state, [play(0)]);
    expect(events.some((e) => e.kind === 'playIgnoredEmptySlot')).toBe(true);
  });

  it('leaves a played slot empty until the draw delay elapses', () => {
    const state = initSpellGame(5);
    const played = run(state, [play(1)]).state;
    expect(played.deck.hand[1]).toBeNull();
    // Still empty just before the delay, refilled just after.
    const justBefore = run(played, Array.from({ length: CARD_DRAW_DELAY_TICKS - 2 }, () => NEUTRAL)).state;
    expect(justBefore.deck.hand[1]).toBeNull();
    const justAfter = run(justBefore, Array.from({ length: 3 }, () => NEUTRAL)).state;
    expect(justAfter.deck.hand[1]).not.toBeNull();
  });

  it('replays identically for the same seed and inputs', () => {
    const inputs = [play(0), NEUTRAL, play(1), ...Array.from({ length: 30 }, () => NEUTRAL), play(2), ...Array.from({ length: 30 }, () => NEUTRAL)];
    const a = run(initSpellGame(11), inputs).state;
    const b = run(initSpellGame(11), inputs).state;
    expect(a).toEqual(b);
  });
});

describe('mis-timed window punishment', () => {
  const settle = Array.from({ length: SYNERGY_WINDOW_TICKS + 2 }, () => NEUTRAL);

  it('slows the player when a multi-card window holds a non-synergy', () => {
    // Two cards of different ids played together: neither fuses.
    let seed = 1;
    let start = initSpellGame(seed);
    let pair: [number, number] | null = null;
    for (let tries = 0; tries < 50 && !pair; tries++) {
      const ids = start.deck.hand.map((c) => c?.id);
      const a = ids.findIndex((id) => id != null);
      const b = ids.findIndex((id, i) => id != null && i !== a && id !== ids[a]);
      if (a >= 0 && b >= 0) pair = [a, b];
      else start = initSpellGame(++seed);
    }
    if (!pair) throw new Error('no seed produced two different cards');
    const [a, b] = pair;
    const after = run(start, [play(a as 0 | 1 | 2 | 3), play(b as 0 | 1 | 2 | 3), ...settle]).state;
    expect(after.combat.player.moveSlowUntilTick).toBeGreaterThan(after.combat.tick);
  });

  it('does not slow when both cards fuse into a synergy', () => {
    let seed = 1;
    let start = initSpellGame(seed);
    while (![...new Set(start.deck.hand.map((c) => c?.id))].some((id) => id && slotsWithId(start, id).length >= 2)) {
      start = initSpellGame(++seed);
    }
    const dup = [...new Set(start.deck.hand.map((c) => c?.id))].find((id) => id && slotsWithId(start, id).length >= 2) as SpellId;
    const [a, b] = slotsWithId(start, dup) as [number, number];
    const after = run(start, [play(a as 0 | 1 | 2 | 3), play(b as 0 | 1 | 2 | 3), ...settle]).state;
    expect(after.combat.player.moveSlowUntilTick).toBe(0); // fused cleanly, no punishment
  });

  it('does not slow a single card played alone', () => {
    const after = run(initSpellGame(3), [play(0), ...settle]).state;
    expect(after.combat.player.moveSlowUntilTick).toBe(0);
  });
});

describe('refill never stalls (regression)', () => {
  const card = (id: SpellId, instanceId: number): SpellCard => ({ id, instanceId, level: 1 });

  it('refills a slot emptied by a Remove reward instead of stalling on "drawing"', () => {
    // meteorStrike lives only in the hand, so removing it nulls a hand slot.
    const deck: SpellDeck = {
      drawPile: [card('dash', 10), card('attack', 11), card('fireBlast', 12)],
      hand: [card('meteorStrike', 0), card('dash', 1), card('attack', 2), card('fireBlast', 3)],
      discardPile: [],
      rng: Rng.fromSeed(1),
    };
    const start: SpellGameState = {
      ...initSpellGame(1),
      deck,
      pendingReward: [
        { kind: 'remove', cardId: 'meteorStrike' },
        { kind: 'upgrade', cardId: 'dash' },
        { kind: 'addFire', cardId: 'meteorStrike' },
      ],
    };
    // Choose Remove (opens the picker), then pick meteorStrike.
    const picking = run(start, [{ ...NEUTRAL, chooseReward: 0 }]).state;
    expect(picking.pendingPick?.kind).toBe('remove');
    const idx = (picking.pendingPick?.candidates ?? []).indexOf('meteorStrike');
    expect(idx).toBeGreaterThanOrEqual(0);
    const chosen = run(picking, [{ ...NEUTRAL, chooseCard: idx }]).state;
    expect(chosen.deck.hand[0]).toBeNull(); // removal emptied the slot

    const after = run(chosen, Array.from({ length: CARD_DRAW_DELAY_TICKS + 2 }, () => NEUTRAL)).state;
    expect(after.deck.hand[0]).not.toBeNull(); // self-healed, not stuck
    expect(after.deck.hand.every((c) => c !== null)).toBe(true);
  });

  it('never thins the deck below a full hand', () => {
    const deck: SpellDeck = {
      drawPile: [],
      hand: [card('dash', 0), card('attack', 1), card('fireBlast', 2), card('blazeAura', 3)],
      discardPile: [],
      rng: Rng.fromSeed(1),
    };
    const start: SpellGameState = {
      ...initSpellGame(1),
      deck,
      pendingReward: [
        { kind: 'remove', cardId: 'dash' },
        { kind: 'upgrade', cardId: 'attack' },
        { kind: 'addFire', cardId: 'meteorStrike' },
      ],
    };
    const after = run(start, [{ ...NEUTRAL, chooseReward: 0 }]).state;
    expect(deckSize(after.deck)).toBe(HAND_SIZE); // remove refused at the floor
    expect(after.deck.hand.every((c) => c !== null)).toBe(true);
  });
});

describe('adrenaline synergy spend (spec 023)', () => {
  const card = (id: SpellId, instanceId: number): SpellCard => ({ id, instanceId, level: 1 });
  const settle = Array.from({ length: SYNERGY_WINDOW_TICKS + 2 }, () => NEUTRAL);

  /** A game with a chosen hand and a pre-loaded adrenaline bank. */
  function withBank(hand: [SpellCard, SpellCard, SpellCard, SpellCard], adrenaline: number): SpellGameState {
    const base = initSpellGame(1);
    const deck: SpellDeck = { drawPile: [card('dash', 20), card('dash', 21)], hand, discardPile: [], rng: Rng.fromSeed(1) };
    return { ...base, deck, combat: { ...base.combat, player: { ...base.combat.player, adrenaline } } };
  }

  it('empowers a fused synergy by the bank and spends it to zero', () => {
    const start = withBank([card('fireBlast', 0), card('fireBlast', 1), card('dash', 2), card('attack', 3)], 5);
    const { state: after, events } = run(start, [play(0), play(1), ...settle]);
    const resolved = events.find((e) => e.kind === 'spellsResolved');
    if (!resolved || resolved.kind !== 'spellsResolved') throw new Error('expected a resolved cast');
    const cone = resolved.specs[0];
    if (!cone || cone.kind !== 'cone') throw new Error('expected a cone');
    expect(cone.damage).toBe(Math.round(50 * (1 + 0.2 * 5))); // fused 50, doubled by 5 adrenaline
    expect(after.combat.player.adrenaline).toBe(0); // synergy spent the bank
  });

  it('does not empower or spend on a lone (non-synergy) card', () => {
    const start = withBank([card('fireBlast', 0), card('dash', 1), card('attack', 2), card('dash', 3)], 5);
    const { state: after, events } = run(start, [play(0), ...settle]);
    const resolved = events.find((e) => e.kind === 'spellsResolved');
    if (!resolved || resolved.kind !== 'spellsResolved') throw new Error('expected a resolved cast');
    const cone = resolved.specs[0];
    if (!cone || cone.kind !== 'cone') throw new Error('expected a cone');
    expect(cone.damage).toBe(16); // base fire blast, un-empowered
    expect(after.combat.player.adrenaline).toBe(5); // bank untouched
  });
});

describe('wave rewards', () => {
  it('offers three deck edits when the wave is cleared', () => {
    const { state, attackSlot } = almostClearedWave(1);
    const { state: after, events } = run(state, [play(attackSlot), ...Array.from({ length: SYNERGY_WINDOW_TICKS + 2 }, () => NEUTRAL)]);
    expect(after.combat.enemies).toHaveLength(0);
    const offered = events.find((e) => e.kind === 'rewardOffered');
    expect(offered).toBeDefined();
    expect(after.pendingReward).toHaveLength(3);
    expect(after.pendingReward?.map((o) => o.kind)).toEqual(['remove', 'upgrade', 'addFire']);
  });

  it('applies the chosen reward and clears the panel', () => {
    const { state, attackSlot } = almostClearedWave(1);
    const cleared = run(state, [play(attackSlot), ...Array.from({ length: SYNERGY_WINDOW_TICKS + 2 }, () => NEUTRAL)]).state;
    const addOffer = cleared.pendingReward?.[2];
    expect(addOffer?.kind).toBe('addFire');
    const countAll = (s: SpellGameState, id?: SpellId): number =>
      [...s.deck.drawPile, ...s.deck.discardPile, ...s.deck.hand].filter((c) => c && c.id === id).length;
    const before = countAll(cleared, addOffer?.cardId);
    const after = run(cleared, [{ ...NEUTRAL, chooseReward: 2 }]).state;
    expect(after.pendingReward).toBeNull();
    expect(countAll(after, addOffer?.cardId)).toBe(before + 1); // the fire card was added
  });

  it('ignores Spawn Wave while a reward is pending', () => {
    const { state, attackSlot } = almostClearedWave(1);
    const cleared = run(state, [play(attackSlot), ...Array.from({ length: SYNERGY_WINDOW_TICKS + 2 }, () => NEUTRAL)]).state;
    expect(cleared.pendingReward).not.toBeNull();
    const blocked = run(cleared, [{ ...NEUTRAL, spawnWave: true }]).state;
    expect(blocked.combat.waveNumber).toBe(1); // no new wave spawned
  });
});

describe('reward pickers (spec 022)', () => {
  const clearWave = (seed = 1): SpellGameState => {
    const { state, attackSlot } = almostClearedWave(seed);
    return run(state, [play(attackSlot), ...Array.from({ length: SYNERGY_WINDOW_TICKS + 2 }, () => NEUTRAL)]).state;
  };

  it('Remove opens a picker of every deck card, and the chosen one is removed', () => {
    const cleared = clearWave();
    const picking = run(cleared, [{ ...NEUTRAL, chooseReward: 0 }]).state;
    expect(picking.pendingReward).toBeNull();
    expect(picking.pendingPick?.kind).toBe('remove');
    const cands = picking.pendingPick?.candidates ?? [];
    expect(cands.length).toBeGreaterThan(0);
    const target = cands[0] as SpellId;
    const before = countId(picking.deck, target);
    const done = run(picking, [{ ...NEUTRAL, chooseCard: 0 }]).state;
    expect(done.pendingPick).toBeNull();
    expect(countId(done.deck, target)).toBe(before - 1);
  });

  it('Upgrade offers only non-attack, non-dash cards and raises the chosen level', () => {
    const cleared = clearWave();
    const picking = run(cleared, [{ ...NEUTRAL, chooseReward: 1 }]).state;
    expect(picking.pendingPick?.kind).toBe('upgrade');
    const cands = picking.pendingPick?.candidates ?? [];
    expect(cands).not.toContain('attack');
    expect(cands).not.toContain('dash');
    expect(cands.length).toBeGreaterThan(0);
    const target = cands[0] as SpellId;
    const topLevel = (s: SpellGameState): number =>
      Math.max(...[...s.deck.drawPile, ...s.deck.discardPile, ...s.deck.hand.filter((c) => c)].filter((c) => c && c.id === target).map((c) => (c as { level: number }).level));
    const before = topLevel(picking);
    const done = run(picking, [{ ...NEUTRAL, chooseCard: 0 }]).state;
    expect(done.pendingPick).toBeNull();
    expect(topLevel(done)).toBe(before + 1);
  });

  it('ignores Spawn Wave while a card picker is open', () => {
    const picking = run(clearWave(), [{ ...NEUTRAL, chooseReward: 0 }]).state;
    expect(picking.pendingPick).not.toBeNull();
    const blocked = run(picking, [{ ...NEUTRAL, spawnWave: true }]).state;
    expect(blocked.combat.waveNumber).toBe(1);
  });
});
