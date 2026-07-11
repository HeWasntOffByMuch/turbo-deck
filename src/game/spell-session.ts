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
  SPELL_CARDS,
  upgradeOneCard,
  type SpellCard,
  type SpellDeck,
  type SpellHand,
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

/**
 * Adrenaline cost to play one non-regular (fire/earth) card (spec 024). The
 * regular set -- `attack` (which builds adrenaline) and `dash` -- is free.
 */
export const ADRENALINE_COST_PER_SPELL = 1;

/** Adrenaline a card costs to play: 0 for the regular set, the flat cost otherwise. */
export function spellCardCost(id: SpellId): number {
  return SPELL_CARDS[id].set === 'regular' ? 0 : ADRENALINE_COST_PER_SPELL;
}

/** True while the player has no way to build adrenaline: broke and holding no `attack`. */
function needsGenerator(deck: SpellDeck, adrenaline: number): boolean {
  return adrenaline === 0 && !deck.hand.some((c) => c?.id === 'attack');
}

/** Lowest unused instanceId, so a minted card never collides with a live one. */
function nextInstanceId(deck: SpellDeck): number {
  let max = -1;
  for (const c of deck.drawPile) max = Math.max(max, c.instanceId);
  for (const c of deck.hand) if (c) max = Math.max(max, c.instanceId);
  for (const c of deck.discardPile) max = Math.max(max, c.instanceId);
  return max + 1;
}

/**
 * Pull one `attack` out of the piles (draw first, then discard) to hold deck
 * composition, minting a fresh one only when the deck has none left. Returns the
 * card and the piles with it removed.
 */
function takeAttack(deck: SpellDeck): { card: SpellCard; drawPile: SpellCard[]; discardPile: SpellCard[] } {
  const drawPile = [...deck.drawPile];
  const discardPile = [...deck.discardPile];
  const di = drawPile.findIndex((c) => c.id === 'attack');
  if (di >= 0) return { card: drawPile.splice(di, 1)[0] as SpellCard, drawPile, discardPile };
  const ci = discardPile.findIndex((c) => c.id === 'attack');
  if (ci >= 0) return { card: discardPile.splice(ci, 1)[0] as SpellCard, drawPile, discardPile };
  return { card: { instanceId: nextInstanceId(deck), id: 'attack', level: 1 }, drawPile, discardPile };
}

/**
 * Draw-bias for the generator guarantee (spec 024/025): fill an *empty* slot with
 * an `attack` instead of the top card, so a broke hand refills into a generator on
 * the normal draw-delay rhythm rather than by an instant swap. Returns the drawn
 * card (never null -- it mints if the piles are dry).
 */
function drawAttackIntoSlot(deck: SpellDeck, slot: number): { deck: SpellDeck; card: SpellCard } {
  const { card, drawPile, discardPile } = takeAttack(deck);
  const hand = [...deck.hand] as (SpellCard | null)[];
  hand[slot] = card;
  return { deck: { drawPile, hand: hand as unknown as SpellHand, discardPile, rng: deck.rng }, card };
}

/**
 * Dead-end breaker (spec 024/025): only for the state draw-bias cannot fix -- a
 * full hand of unaffordable spell cards with no free card to cycle, so no slot
 * ever empties. Replace one spell card with an `attack` (the displaced card
 * returns to the discard) so the hand can never hard-lock.
 */
function breakGeneratorDeadEnd(deck: SpellDeck): SpellDeck {
  const hand = [...deck.hand] as (SpellCard | null)[];
  const slot = hand.findIndex((c) => c !== null && spellCardCost(c.id) > 0);
  if (slot < 0) return deck; // nothing to convert (shouldn't happen at a dead-end)
  const { card, drawPile, discardPile } = takeAttack(deck);
  const displaced = hand[slot];
  if (displaced) discardPile.push(displaced);
  hand[slot] = card;
  return { drawPile, hand: hand as unknown as SpellHand, discardPile, rng: deck.rng };
}

export type RewardKind = 'remove' | 'upgrade' | 'addFire';
/**
 * One of the three deck edits offered when a wave is cleared (spec 019). Only
 * addFire carries a card up front; Remove/Upgrade open a picker instead (spec 022).
 */
export interface RewardOffer {
  readonly kind: RewardKind;
  readonly cardId?: SpellId;
}

/** The open card picker for a chosen Remove/Upgrade action (spec 022). */
export interface RewardPick {
  readonly kind: 'remove' | 'upgrade';
  readonly candidates: readonly SpellId[];
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
  /** An open card picker after choosing Remove/Upgrade, or null. */
  readonly pendingPick: RewardPick | null;
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
  /** Pick a card from the open Remove/Upgrade picker (index into its candidates). */
  readonly chooseCard?: number;
  /** Summon the next escalating wave. */
  readonly spawnWave?: boolean;
}

export type SpellGameEvent =
  | { readonly kind: 'cardPlayed'; readonly index: number; readonly id: SpellId }
  | { readonly kind: 'playIgnoredEmptySlot' }
  | { readonly kind: 'playRejectedNoAdrenaline'; readonly index: number; readonly id: SpellId }
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
    pendingPick: null,
    rng: Rng.fromSeed((seed ^ 0x5f356495) >>> 0),
  };
}

/**
 * Roll the three wave-clear offers. Remove and Upgrade are chosen from a picker
 * later (spec 022), so they carry no card here; only the fire gift is rolled now.
 */
function rollRewards(rng: Rng): { offers: RewardOffer[]; rng: Rng } {
  const [i, r] = rng.nextInt(0, FIRE_CARD_IDS.length - 1);
  const offers: RewardOffer[] = [
    { kind: 'remove' },
    { kind: 'upgrade' },
    { kind: 'addFire', cardId: FIRE_CARD_IDS[i] as SpellId },
  ];
  return { offers, rng: r };
}

/** Cards the Upgrade reward may target: any non-regular card in the deck (spec 022). */
function upgradeCandidates(deck: SpellDeck): SpellId[] {
  return deckCardIds(deck).filter((id) => id !== 'attack' && id !== 'dash');
}

export function stepSpellGame(state: SpellGameState, input: SpellInput): { state: SpellGameState; events: SpellGameEvent[] } {
  const events: SpellGameEvent[] = [];
  let deck = state.deck;
  let windowCards = state.windowCards;
  let windowClosesAtTick = state.windowClosesAtTick;
  let pendingReward = state.pendingReward;
  let pendingPick = state.pendingPick;
  // Slots emptied this tick; their delayed refill is scheduled after combat steps.
  const emptied: number[] = [];

  // --- Reward step 1: choose an action. addFire applies now; Remove/Upgrade open a picker. ---
  if (pendingReward !== null && input.chooseReward !== undefined) {
    const offer = pendingReward[input.chooseReward];
    if (offer) {
      if (offer.kind === 'addFire' && offer.cardId) {
        deck = addCard(deck, offer.cardId);
        events.push({ kind: 'rewardChosen', offer });
      } else if (offer.kind === 'remove') {
        // Never let the deck be thinned below a full hand (spec 021 floor).
        const candidates = deckSize(deck) > HAND_SIZE ? deckCardIds(deck) : [];
        if (candidates.length > 0) pendingPick = { kind: 'remove', candidates };
      } else if (offer.kind === 'upgrade') {
        const candidates = upgradeCandidates(deck);
        if (candidates.length > 0) pendingPick = { kind: 'upgrade', candidates };
      }
      pendingReward = null;
    }
  }

  // --- Reward step 2: pick the card the chosen action targets ---
  if (pendingPick !== null && input.chooseCard !== undefined) {
    const cardId = pendingPick.candidates[input.chooseCard];
    if (cardId) {
      if (pendingPick.kind === 'remove') {
        if (deckSize(deck) > HAND_SIZE) {
          deck = removeOneCard(deck, cardId);
          events.push({ kind: 'rewardChosen', offer: { kind: 'remove', cardId } });
        }
      } else {
        deck = upgradeOneCard(deck, cardId);
        events.push({ kind: 'rewardChosen', offer: { kind: 'upgrade', cardId } });
      }
    }
    pendingPick = null;
  }

  // --- Play a card into the synergy window ---
  if (input.playHandIndex !== undefined) {
    const idx = input.playHandIndex;
    const card: SpellCard | null = deck.hand[idx];
    if (card) {
      // Costed cards (spec 024) are gated on the bank, counting what the open
      // window has already committed so a burst can't overspend.
      const cost = spellCardCost(card.id);
      const committed = windowCards.reduce((sum, p) => sum + spellCardCost(p.id), 0);
      if (cost > 0 && state.combat.player.adrenaline < committed + cost) {
        events.push({ kind: 'playRejectedNoAdrenaline', index: idx, id: card.id });
      } else {
        deck = discardFromHand(deck, idx).deck;
        emptied.push(idx);
        windowCards = [...windowCards, { id: card.id, level: card.level }];
        // The first card of a window arms the timer; later plays just join the buffer.
        if (windowClosesAtTick === null) windowClosesAtTick = state.combat.tick + SYNERGY_WINDOW_TICKS;
        events.push({ kind: 'cardPlayed', index: idx, id: card.id });
      }
    } else {
      events.push({ kind: 'playIgnoredEmptySlot' });
    }
  }

  // --- Resolve the window if it is due (the tick advances in combatStep) ---
  const tick = state.combat.tick + 1;
  let externalEffect: ExternalEffect | undefined;
  let resolved: { ids: SpellId[]; specs: SpellSpec[] } | null = null;
  if (windowClosesAtTick !== null && tick >= windowClosesAtTick) {
    const baseSpecs = resolveSynergies(windowCards);
    const counts = new Map<SpellId, number>();
    for (const p of windowCards) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    // Punish a fumbled combo: more than one card played, but at least one of them
    // stood alone (its id had no partner to fuse with) in the window.
    const misplay = windowCards.length > 1 && [...counts.values()].some((c) => c === 1);
    // Adrenaline no longer empowers the cast (spec 025) -- it buys walk speed. The
    // cast still spends the played cards' cost so banking/spending is intact.
    const specs = baseSpecs;
    const spendAdrenaline = windowCards.reduce((sum, p) => sum + spellCardCost(p.id), 0);
    externalEffect = {
      kind: 'castSpells',
      spells: specs,
      aimX: input.aimX,
      aimY: input.aimY,
      targetX: input.targetX,
      targetY: input.targetY,
      ...(misplay ? { playerSlowTicks: MISPLAY_SLOW_TICKS } : {}),
      ...(spendAdrenaline > 0 ? { spendAdrenaline } : {}),
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
    // A wave cannot be summoned while a reward or its picker is still open.
    ...(input.spawnWave && pendingReward === null && pendingPick === null ? { spawnWave: true } : {}),
  };

  const hadEnemies = state.combat.enemies.length > 0;
  const combatResult = combatStep(state.combat, combatInput);
  events.push(...combatResult.events);
  if (resolved !== null) events.push({ kind: 'spellsResolved', ids: resolved.ids, specs: resolved.specs, aimX: input.aimX, aimY: input.aimY });

  // --- Wave cleared: offer three deck edits (once) ---
  let rng = state.rng;
  if (pendingReward === null && pendingPick === null && hadEnemies && combatResult.state.enemies.length === 0 && combatResult.state.waveNumber >= 1) {
    const rolled = rollRewards(rng);
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
  const adrenaline = combatResult.state.player.adrenaline;
  for (let slot = 0; slot < HAND_SIZE; slot++) {
    const at = refillAtTick[slot];
    if (at !== null && at !== undefined && tick >= at) {
      // Generator guarantee (spec 024/025): while broke and holding no attack, bias
      // the refill draw to an attack (keeping the draw-delay rhythm) instead of the
      // top card, re-checked each fill so it only supplies one.
      const drawn = needsGenerator(deck, adrenaline) ? drawAttackIntoSlot(deck, slot) : drawIntoSlot(deck, slot);
      deck = drawn.deck;
      // Only clear the schedule once a card actually landed; if the deck is
      // momentarily dry, keep it pending so the slot retries instead of stalling.
      if (drawn.card) refillAtTick[slot] = null;
    }
  }

  // Dead-end breaker: draw-bias can only act on an empty slot, so a full hand of
  // unaffordable spell cards (no attack, no free card to cycle) would never refill.
  // Swap an attack in immediately for exactly that locked state.
  if (needsGenerator(deck, adrenaline) && deck.hand.every((c) => c !== null) && !deck.hand.some((c) => c && spellCardCost(c.id) === 0)) {
    deck = breakGeneratorDeadEnd(deck);
  }

  return {
    state: { combat: combatResult.state, deck, refillAtTick, windowCards, windowClosesAtTick, pendingReward, pendingPick, rng },
    events,
  };
}
