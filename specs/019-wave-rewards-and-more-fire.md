# 019 — Wave rewards, card upgrades & more fire cards

## Problem

Follow-up to spec 018. Four gaps: (1) clearing a wave gives no progression;
(2) cards cannot grow; (3) the fire kit is thin; (4) cone attacks (Attack, Fire
Blast) and ground fire have no on-screen presence, and long card names overflow
their HUD face. This spec adds an end-of-wave reward choice (thin / upgrade /
add), a per-card upgrade level, three new fire cards, and the render/HUD fixes.

## Shape

### Cards (`src/cards/spells.ts`)

```ts
// New fire ids added to SpellId:
'baskingPath' | 'conjureFlame' | 'fireStorm'
FIRE_CARD_IDS: SpellId[]                 // the fire set, for the "add a fire card" reward

interface SpellCard { instanceId; id; level: number }   // level defaults to 1
// Deck edits used by rewards (operate across all piles, deterministic order):
removeOneCard(deck, id): SpellDeck
upgradeOneCard(deck, id): SpellDeck      // +1 level on one instance of id
addCard(deck, id): SpellDeck             // fresh level-1 card into the discard pile
deckCardIds(deck): SpellId[]             // distinct ids currently in the deck
```

### Synergy + specs (`src/cards/synergy.ts`, `src/shared/spell-spec.ts`)

`resolveSynergies` now takes the played cards with their level and scales the
group's damage by its upgrades: `mult = 1 + 0.4 * (sumLevel - count)`.

New / extended `SpellSpec`s:

```ts
{ kind:'empower'; charges; bonusDamage }                 // Conjure Flame
dash: + optional trailRadius, trailPulseDamage,          // Basking Path
       trailPulseIntervalTicks, trailDurationTicks
pointAoe.origin: + 'nearestEnemyToTarget'                // Fire Storm centres on a foe
```

Fusion entries: baskingPath (dash+fire trail; ×2 longer/hotter), conjureFlame
(3 charges; ×2 bigger bonus), fireStorm (AOE on the nearest foe to the cursor;
×2 bigger/stronger).

### Sim (`src/sim/`)

New `PlayerState` fields (identity defaults): `groundFires[]` (stationary DOT
patches), `attackFlameCharges` + `attackFlameBonus` (Conjure Flame buff on cone
casts), and a `dashTrail` config consumed while dashing. `castSpells` gains:
- `empower` sets the flame charges/bonus; a cone cast consumes one charge and
  adds the bonus to its damage.
- a dash with trail fields drops a `groundFire` under the player as it travels.
- `pointAoe` origin `nearestEnemyToTarget` centres on the enemy nearest the
  cursor (falls back to the cursor point when the arena is empty).
Ground fires pulse like auras but at a fixed spot until they expire.

### Game (`src/game/spell-session.ts`)

On the wave-clear transition (enemies dropped to zero with `waveNumber >= 1`)
the session rolls three `RewardOffer`s from a deterministic session `rng` and
sets `pendingReward`. `SpellInput.chooseReward?: 0|1|2` applies one and clears
it; `spawnWave` is ignored while a reward is pending. `spellsResolved` now also
carries the resolved `specs` + aim so the renderer can draw cone/rect flashes.

```ts
type RewardKind = 'remove' | 'upgrade' | 'addFire'
interface RewardOffer { kind: RewardKind; cardId: SpellId }
```

### Render (`src/render/spells/`)

- HUD card face: constrained layout so long names/blurbs never overflow; a `Lv2+`
  badge on upgraded cards; a reward panel (3 buttons) shown while a reward is pending.
- Arena: transient cone/rect flashes from `spellsResolved`, drawn ground-fire
  patches, and a small flame-charge pip on the player.

## Invariants tested

- `removeOneCard` drops exactly one copy; `upgradeOneCard` raises one copy's
  level by one and leaves counts unchanged; `addCard` adds one level-1 copy.
- `resolveSynergies` scales a group's damage with its total upgrades and is
  unchanged for all-level-1 input (back-compatible with 018 numbers).
- Sim: a Conjure Flame charge adds bonus damage to the next cone then is spent;
  a Basking Path dash lays ground fire that damages an enemy standing in it;
  Fire Storm centres its blast on the nearest enemy to the cursor; determinism
  holds across the new fields.
- Session: clearing a wave sets three offers; `chooseReward` applies the matching
  deck edit and clears the panel; `spawnWave` is ignored while a reward is pending;
  same seed + inputs ⇒ identical state.

## Out of scope

- Rewards target a randomly-rolled card per offer (shown on the button), not a
  full card-picker screen.
- No new earth/regular cards; no persistence between runs.
