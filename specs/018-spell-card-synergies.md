# 018 — Spell cards & synergy window

## Problem

The poker-combo prototype (spec 014/015) is retired. Combat is re-centred on a
small hand of **spell cards** drawn from a deck. The player walks freely, but
every attack and dash is a card — there is no free melee. Playing a card opens a
short **synergy window**; any further cards played inside it are consumed
together, and when two-or-more of the same card land in one window they fuse into
a stronger, different effect (e.g. two Blaze Auras become three explosions at the
player). This replaces the whole poker layer.

## Shape

### Cards (`src/cards/spells.ts`) — pure data + a hand-of-4 deck

```ts
type SpellId =
  | 'attack' | 'dash'                         // regular
  | 'fireBlast' | 'blazeAura' | 'meteorStrike'// fire set
  | 'groundStomp' | 'rockyRaise' | 'buryFeet' // earth set
type CardSet = 'regular' | 'fire' | 'earth'

interface SpellCardDef { id: SpellId; name: string; set: CardSet }
const SPELL_CARDS: Record<SpellId, SpellCardDef>

HAND_SIZE = 4
STARTING_DECK: SpellId[] = 3×dash, 3×attack, 2×fireBlast, 1×blazeAura

interface SpellCard { instanceId: number; id: SpellId }
interface SpellDeck { drawPile; hand: [c|null ×4]; discardPile; rng }
initSpellDeck / discardFromHand / drawIntoSlot         // delayed-refill friendly
```

### Synergy resolution (`src/cards/synergy.ts`) — pure

```ts
// A geometric spell the sim knows how to execute (no card names leak into sim).
type SpellSpec =
  | { kind:'cone';    range; arcCosSq; damage }
  | { kind:'rect';    length; halfWidth; damage }
  | { kind:'aura';    radius; pulseDamage; pulseIntervalTicks; durationTicks }
  | { kind:'pointAoe';radius; damage; stunTicks; delayTicks; count; spreadTicks }
  | { kind:'dash';    distance; durationTicks; damage }
  | { kind:'shield';  amount; durationTicks }

resolveSynergies(playedIds: SpellId[]): SpellSpec[]
```

Rule: group the played cards by `SpellId`, resolve each group by its **count**
(1 = base, 2 = fused, 3 = fused-3 for dash), emit one `SpellSpec` per group.
Counts above the highest defined tier clamp to that tier. Documented fusions:

- attack ×2 → wider/stronger cone. dash ×2 → longer dash; dash ×3 → long dash
  that deals damage.
- fireBlast ×2 → bigger cone. blazeAura ×2 → 3 explosions at the player.
  meteorStrike ×2 → bigger meteor.
- groundStomp ×2 → longer/wider rect. rockyRaise ×2 → bigger shield.
  buryFeet ×2 → bigger/longer stun.

### Sim (`src/sim/`)

New `ExternalEffect`: `{ kind:'castSpells'; spells: SpellSpec[]; aimX; aimY; targetX; targetY }`.
The sim executes each `SpellSpec` deterministically and gains state (identity
defaults, so existing behaviour is untouched):

- `PlayerState`: `shieldAmount`, `shieldExpiresAtTick`, `auras[]`,
  `pendingAoes[]`, dash velocity + `dashExpiresAtTick` + `dashDamage`.
- `EnemyState`: `stunnedUntilTick` (stunned enemies neither move nor attack).
- Shield absorbs incoming enemy-slam damage before health. Auras pulse on a
  cadence around the *current* player position. Point AOEs impact after their
  telegraph delay. Dashing overrides movement and (when armed) damages enemies
  it passes through.

### Game (`src/game/spell-session.ts`) — composition root

Owns the deck + combat. Holds a synergy window: the first card played this
window sets `windowClosesAtTick = tick + SYNERGY_WINDOW_TICKS`; later plays in
the window join a buffer. Cards leave the hand immediately and their slot refills
`CARD_DRAW_DELAY_TICKS` later. When the window closes the buffered ids are run
through `resolveSynergies` and cast as one `castSpells` effect. Movement/aim pass
straight through; `input.attack` melee is never used (attacks are cards).

## Invariants tested

- Deck: `initSpellDeck` fills 4 hand slots from the 9-card starting deck; drawing
  past exhaustion reshuffles the discard; identical seed ⇒ identical order.
- `resolveSynergies`: one played card ⇒ its base spec; two identical ⇒ the fused
  spec; three dashes ⇒ dash with `damage > 0`; two different cards ⇒ two specs;
  order-independent by id; counts above max tier clamp.
- Sim determinism: same seed + same input sequence (including `castSpells`) ⇒
  bit-identical `CombatState`. Adding the new fields does not change any existing
  sim/integration test outcome.
- Sim mechanics: a cone spec damages enemies in the cone; a rect spec damages
  enemies in the rectangle and spares those beside it; an aura pulses on cadence;
  a delayed point-AOE damages/stuns only at impact tick; a stunned enemy skips
  its wind-up; a dash moves the player and (when armed) damages a body in its
  path; a shield absorbs a slam before health drops.
- Session: playing two identical cards inside the window casts the *fused* spec
  once, not two base specs; the window closing with a lone card casts the base
  spec; a played card's slot is empty until `CARD_DRAW_DELAY_TICKS` later; same
  seed + inputs ⇒ identical session state.

## Out of scope

- No mana economy for casting — cards are gated only by the hand + draw delay.
- No new enemy types or wave changes; the existing sim combat/defense loop and
  the legacy catalog game (`session.ts`) are left as-is.
- Cross-set fusions (fire + earth) are not special-cased — mixed windows just
  emit each group's spec.
- Audio/visual polish beyond drawing the new effects is minimal.
