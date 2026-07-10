import {
  addCard,
  deckCardIds,
  deckSize,
  discardFromHand,
  drawIntoSlot,
  FIRE_CARD_IDS,
  HAND_SIZE,
  initSpellDeck,
  removeOneCard,
  upgradeOneCard,
  type SpellCard,
  type SpellDeck,
  type SpellId,
} from '../cards/spells.js';
import { resolveSynergies, type SpellCardPlay } from '../cards/synergy.js';
import type { SpellSpec } from '../shared/spell-spec.js';
import { Rng } from '../shared/prng.js';
import { initCombat, step as combatStep } from '../sim/combat.js';
import { TICK_RATE } from '../sim/constants.js';
import { type CombatState, type ExternalEffect, type InputFrame, type SimEvent } from '../sim/types.js';

/**
 * Composition root for the spell-card game (spec 018/019): the only place a
 * played card becomes a sim effect. It owns the deck alongside the combat sim
 * and threads them deterministically -- the same (seed, inputs) always replays
 * to the same state.
 *
 * The interesting piece is the synergy window. Playing a card does not fire an
 * effect immediately: it drops the card into a short buffer. Any further cards
 * played before the window closes join the buffer, and when it closes they are
 * resolved together -- two of the same card fuse into a stronger effect, and
 * upgraded cards hit harder. Clearing a wave offers one of three deck edits.
 */

/** How long the window stays open for follow-up cards after the first play (0.25s). */
export const SYNERGY_WINDOW_TICKS = Math.round(0.25 * TICK_RATE);

/**
 * A spent hand slot refills only after this delay -- long enough (roughly an
 * enemy's slam cadence) that you cannot answer every threat with a fresh card.
 */
export const CARD_DRAW_DELAY_TICKS = Math.round(1.5 * TICK_RATE);

/**
 * Mis-timed window punishment (spec 021): playing two-or-more cards in a window
 * where at least one does not fuse into a synergy slows the player's walk for
 * this long. Combo carefully or pay for the fumble.
 */
export const MISPLAY_SLOW_TICKS = Math.round(1.5 * TICK_RATE);

export type RewardKind = 'remove' | 'upgrade' | 'addFire';
/** One of the three deck edits offered when a wave is cleared (spec 019). */
export interface RewardOffer {
  readonly kind: RewardKind;
  readonly cardId: SpellId;
}

export interface SpellGameState {
  readonly combat: CombatState;
  readonly deck: SpellDeck;
  /** Per hand slot: the tick its delayed refill draws, or null if not pending. */
  readonly refillAtTick: readonly (number | null)[];
  /** Cards played into the open synergy window (id + level), in play order. */
  readonly windowCards: readonly SpellCardPlay[];
  /** Tick the open window resolves, or null when no window is open. */
  readonly windowClosesAtTick: number | null;
  /** Three deck-edit offers shown after a wave clear, or null when none pending. */
  readonly pendingReward: readonly RewardOffer[] | null;
  /** Session RNG for reward rolls, kept separate from the sim/deck streams. */
  readonly rng: Rng;
}

export interface SpellInput {
  readonly moveX: -1 | 0 | 1;
  readonly moveY: -1 | 0 | 1;
  /** Aim direction (player -> cursor) for cones, rects and dashes. */
  readonly aimX: number;
  readonly aimY: number;
  /** Cursor world point for target-origin AOEs (meteor, bury feet, fire storm). */
  readonly targetX: number;
  readonly targetY: number;
  /** Play the card in this hand slot into the synergy window. */
  readonly playHandIndex?: 0 | 1 | 2 | 3;
  /** Take the reward offer at this index (only while one is pending). */
  readonly chooseReward?: 0 | 1 | 2;
  /** Summon the next escalating wave. */
  readonly spawnWave?: boolean;
}

export type SpellGameEvent =
  | { readonly kind: 'cardPlayed'; readonly index: number; readonly id: SpellId }
  | { readonly kind: 'playIgnoredEmptySlot' }
  | {
      readonly kind: 'spellsResolved';
      readonly ids: readonly SpellId[];
      readonly specs: readonly SpellSpec[];
      readonly aimX: number;
      readonly aimY: number;
    }
  | { readonly kind: 'rewardOffered'; readonly offers: readonly RewardOffer[] }
  | { readonly kind: 'rewardChosen'; readonly offer: RewardOffer }
  | SimEvent;

export function initSpellGame(seed: number, ids?: readonly SpellId[]): SpellGameState {
  return {
    // Wave mode: the arena starts empty; the Spawn Wave control populates it.
    combat: initCombat(seed, { ambientSpawner: false, initialEnemies: 0 }),
    deck: initSpellDeck(Rng.fromSeed(seed), ids),
    refillAtTick: Array.from({ length: HAND_SIZE }, () => null),
    windowCards: [],
    windowClosesAtTick: null,
    pendingReward: null,
    rng: Rng.fromSeed((seed ^ 0x5f356495) >>> 0),
  };
}

/** Roll three deck-edit offers: thin a card, upgrade a card, or gain a fire card. */
function rollRewards(deck: SpellDeck, rng: Rng): { offers: RewardOffer[]; rng: Rng } {
  const present = deckCardIds(deck);
  let r = rng;
  const pick = <T>(arr: readonly T[]): T => {
    const [i, next] = r.nextInt(0, arr.length - 1);
    r = next;
    return arr[i] as T;
  };
  const offers: RewardOffer[] = [
    { kind: 'remove', cardId: pick(present) },
    { kind: 'upgrade', cardId: pick(present) },
    { kind: 'addFire', cardId: pick(FIRE_CARD_IDS) },
  ];
  return { offers, rng: r };
}

function applyReward(deck: SpellDeck, offer: RewardOffer): SpellDeck {
  switch (offer.kind) {
    case 'remove':
      // Never thin the deck below a full hand, or slots could never refill.
      return deckSize(deck) > HAND_SIZE ? removeOneCard(deck, offer.cardId) : deck;
    case 'upgrade':
      return upgradeOneCard(deck, offer.cardId);
    case 'addFire':
      return addCard(deck, offer.cardId);
  }
}

export function stepSpellGame(state: SpellGameState, input: SpellInput): { state: SpellGameState; events: SpellGameEvent[] } {
  const events: SpellGameEvent[] = [];
  let deck = state.deck;
  let windowCards = state.windowCards;
  let windowClosesAtTick = state.windowClosesAtTick;
  let pendingReward = state.pendingReward;
  // Slots emptied this tick; their delayed refill is scheduled after combat steps.
  const emptied: number[] = [];

  // --- Take a wave reward, if one is pending and the player picks an offer ---
  if (pendingReward !== null && input.chooseReward !== undefined) {
    const offer = pendingReward[input.chooseReward];
    if (offer) {
      deck = applyReward(deck, offer);
      events.push({ kind: 'rewardChosen', offer });
      pendingReward = null;
    }
  }

  // --- Play a card into the synergy window ---
  if (input.playHandIndex !== undefined) {
    const idx = input.playHandIndex;
    const card: SpellCard | null = deck.hand[idx];
    if (card) {
      deck = discardFromHand(deck, idx).deck;
      emptied.push(idx);
      windowCards = [...windowCards, { id: card.id, level: card.level }];
      // The first card of a window arms the timer; later plays just join the buffer.
      if (windowClosesAtTick === null) windowClosesAtTick = state.combat.tick + SYNERGY_WINDOW_TICKS;
      events.push({ kind: 'cardPlayed', index: idx, id: card.id });
    } else {
      events.push({ kind: 'playIgnoredEmptySlot' });
    }
  }

  // --- Resolve the window if it is due (the tick advances in combatStep) ---
  const tick = state.combat.tick + 1;
  let externalEffect: ExternalEffect | undefined;
  let resolved: { ids: SpellId[]; specs: SpellSpec[] } | null = null;
  if (windowClosesAtTick !== null && tick >= windowClosesAtTick) {
    const specs = resolveSynergies(windowCards);
    // Punish a fumbled combo: more than one card played, but at least one of them
    // stood alone (its id had no partner to fuse with) in the window.
    const counts = new Map<SpellId, number>();
    for (const p of windowCards) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    const misplay = windowCards.length > 1 && [...counts.values()].some((c) => c === 1);
    externalEffect = {
      kind: 'castSpells',
      spells: specs,
      aimX: input.aimX,
      aimY: input.aimY,
      targetX: input.targetX,
      targetY: input.targetY,
      ...(misplay ? { playerSlowTicks: MISPLAY_SLOW_TICKS } : {}),
    };
    resolved = { ids: windowCards.map((p) => p.id), specs };
    windowCards = [];
    windowClosesAtTick = null;
  }

  const combatInput: InputFrame = {
    moveX: input.moveX,
    moveY: input.moveY,
    // Attacks are cards; the sim's built-in melee is never triggered here.
    attack: false,
    aimX: input.aimX,
    aimY: input.aimY,
    parry: false,
    dodge: false,
    ...(externalEffect ? { externalEffect } : {}),
    // A wave cannot be summoned while a reward is still on offer.
    ...(input.spawnWave && pendingReward === null ? { spawnWave: true } : {}),
  };

  const hadEnemies = state.combat.enemies.length > 0;
  const combatResult = combatStep(state.combat, combatInput);
  events.push(...combatResult.events);
  if (resolved !== null) events.push({ kind: 'spellsResolved', ids: resolved.ids, specs: resolved.specs, aimX: input.aimX, aimY: input.aimY });

  // --- Wave cleared: offer three deck edits (once) ---
  let rng = state.rng;
  if (pendingReward === null && hadEnemies && combatResult.state.enemies.length === 0 && combatResult.state.waveNumber >= 1) {
    const rolled = rollRewards(deck, rng);
    pendingReward = rolled.offers;
    rng = rolled.rng;
    events.push({ kind: 'rewardOffered', offers: rolled.offers });
  }

  // Schedule delayed refills for slots emptied this tick, then draw any now due.
  const refillAtTick = [...state.refillAtTick];
  for (const slot of emptied) refillAtTick[slot] = tick + CARD_DRAW_DELAY_TICKS;
  // Self-heal: any empty slot without a pending refill (e.g. a card removed from
  // hand by a wave reward) gets one scheduled, so no slot can stall on "drawing".
  for (let slot = 0; slot < HAND_SIZE; slot++) {
    if (deck.hand[slot] === null && (refillAtTick[slot] === null || refillAtTick[slot] === undefined)) {
      refillAtTick[slot] = tick + CARD_DRAW_DELAY_TICKS;
    }
  }
  for (let slot = 0; slot < HAND_SIZE; slot++) {
    const at = refillAtTick[slot];
    if (at !== null && at !== undefined && tick >= at) {
      const drawn = drawIntoSlot(deck, slot);
      deck = drawn.deck;
      // Only clear the schedule once a card actually landed; if the deck is
      // momentarily dry, keep it pending so the slot retries instead of stalling.
      if (drawn.card) refillAtTick[slot] = null;
    }
  }

  return {
    state: { combat: combatResult.state, deck, refillAtTick, windowCards, windowClosesAtTick, pendingReward, rng },
    events,
  };
}
