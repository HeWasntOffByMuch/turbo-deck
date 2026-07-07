# 014 — Poker-combo stance prototype

## Problem

We want to answer one design question before building more card systems: **is
"hold cards for a combo vs. play them as single actions" a fun decision, turn
after turn?** The only thing this prototype needs to surface is whether the
player ever feels *torn* between spending a card now and holding it for a
payoff. If the hesitation never happens, the tension isn't there.

To force that hesitation, every card must have a genuine dual identity: useful
right now as an action, *and* a component of a stronger hand you could cash in
later. A standard 52-card deck gives us that for free — suit is the action,
rank/suit-composition is the combo.

This is a self-contained prototype mode. It reuses the deterministic combat sim
but replaces the existing card catalog/passive model with a standard deck. The
legacy game (`src/game/session.ts`) and its renderer are left untouched.

## Shape

### Cards (`src/cards/`, pure)

- `standard.ts` — a standard deck.
  - `type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'`
  - `type Rank = 2..14` (11=J, 12=Q, 13=K, 14=A)
  - `interface PlayingCard { readonly instanceId: number; readonly suit: Suit; readonly rank: Rank }`
  - `HAND_SIZE = 5`
  - `interface StandardDeck { drawPile, hand: (PlayingCard|null)[5], discardPile, rng }`
  - `initStandardDeck(rng): StandardDeck` — 52 instances, shuffled, deal 5.
  - `playFromHand(deck, index): { deck, card }` — discard the card, refill that
    one slot (reshuffle discard when the draw pile empties).
  - `activateHand(deck): { deck, cards }` — discard all 5, draw a fresh 5. The
    caller evaluates `cards` for the combo before calling.

- `poker.ts` — `evaluateHand(cards: PlayingCard[]): { category: PokerCategory; strength: number }`
  where `strength` is an ordinal 0..8 (high card … straight flush). Ace plays
  high, and also low for the A-2-3-4-5 wheel. Pure, total over any 5 cards.

- `stance.ts` — the two mappings that give cards their dual identity.
  - `cardAction(card): CardAction` — suit → effect, rank → magnitude:
    clubs = damage, hearts = heal, spades = guard (brief damage reduction),
    diamonds = slow (brief enemy slow). Higher rank = bigger effect.
  - `handStance(cards): StanceGrant` — combo payoff. Poker `strength` sets the
    magnitude/duration tier; **suit composition** sets which stats get the
    bonus (clubs→attack, spades→damage-reduction, hearts→regen,
    diamonds→enemy-slow), each scaled by that suit's share of the hand. A flush
    therefore reads as a pure, maxed stance of one flavor.

### Sim (`src/sim/`, additive)

New timed, deterministic buffs stored in sim state (not recomputed from held
cards, unlike legacy modifiers):

- `PlayerState`: `stanceExpiresAtTick`, `stanceAttackBonus`, `stanceReductionPct`,
  `stanceRegenPerTick`, `guardExpiresAtTick`, `guardReductionPct`,
  `activateLockUntil`.
- `EnemyState`: optional `attackDamage` override (wave scaling); falls back to
  the type's damage when absent.
- `CombatState`: `enemySlowExpiresAtTick`, `enemySlowMultiplier`, `waveNumber`,
  `ambientSpawner` (legacy spawner on/off).
- New `ExternalEffect` kinds: `guard`, `slowEnemies`, `applyStance`.
- New `InputFrame.spawnWave?: boolean`.
- `initCombat(seed, opts?)` — `opts.ambientSpawner` / `opts.initialEnemies`
  default to the legacy values, so existing callers are unchanged.
- New `SimEvent`s: `stanceApplied`, `stanceRejectedLocked`, `waveSpawned`.

Damage the player deals gains `stanceAttackBonus`; damage the player takes is
reduced by `stanceReductionPct + guardReductionPct` (capped); regen gains
`stanceRegenPerTick`; enemy move speed and telegraph durations are stretched by
`enemySlowMultiplier`. A wave spawns `WAVE_BASE_COUNT + waveNumber` hunting
enemies with health/damage scaled up each wave.

### Game (`src/game/combo-session.ts`)

`initComboGame(seed)` / `stepComboGame(state, input)` where input carries
`playHandIndex?: 0..4`, `activate?: boolean`, `spawnWave?: boolean` plus the
usual move/attack/defend frame. Play → `cardAction` → sim effect + slot refill.
Activate (only when `tick >= activateLockUntil`) → `handStance` → `applyStance`
effect + consume/redraw the whole hand. Deterministic: `(seed, inputs)` replays
identically.

### Render (`src/render/combo/`, thin)

Canvas2D arena (fit-to-view, no camera) drawing the player, enemies, attack
telegraphs and floating damage/heal numbers, plus a DOM HUD: the five cards as
real playing cards, a live poker readout of the current hand with the stance it
would grant, an Activate button (with lockout timer) and a Spawn Wave button
(with wave counter), and health. No game rules live here.

## Invariants tested

- `initStandardDeck` deals 5 cards from 52 distinct instances; total card count
  (draw + hand + discard) is conserved across any sequence of plays/activations.
- Reshuffle: playing through the whole deck never loses or duplicates a card.
- `evaluateHand` classifies known hands correctly (flush, straight incl. wheel,
  full house, four of a kind, straight flush) and its `strength` is monotonic.
- `handStance`: a flush concentrates its bonus in the single matching stat; a
  higher poker strength never yields a smaller magnitude for the same suit mix.
- Sim: an active stance raises the player's outgoing damage and reduces incoming
  damage; `applyStance` is rejected (event, no effect) while `activateLockUntil`
  is in the future; a slow stance/effect stretches the enemy telegraph.
- Sim regression: with `ambientSpawner` on and no new effects, `initCombat`
  and `step` behave exactly as before (legacy tests stay green).
- `stepComboGame` conserves cards, keeps the hand at 5, and replays identically
  for a fixed `(seed, inputs)`.

## Out of scope

- Balance/tuning of the numbers — this build exists to feel the *decision*, not
  to be fair. The balance harness is not wired to this mode.
- Mana costs on single-card actions: the cost of playing a card is that you
  spend it and degrade the hand, nothing more.
- Persisting the legacy passive/active catalog into this mode, multiplayer, and
  any art beyond simple shapes + the DOM card faces.
