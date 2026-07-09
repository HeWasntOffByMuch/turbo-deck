# 015 — Four-card poker, ranged cone enemies, combo/card SFX

## Problem

Three tuning/feel changes to the combo prototype (spec 014) and the shared
combat sim, plus an audio pass:

1. **Four-card poker, not five.** A five-card hand was too much to read and
   track at a glance. Drop to a four-card hand and use the common four-card
   variant ranking (no full house — it needs five cards).
2. **Enemies attack only when in range.** Today a hunting enemy winds up on a
   fixed idle cadence regardless of where the player is, telegraphing and
   slamming into empty air. It should only commit to an attack once the player
   is actually within reach; otherwise it keeps closing the distance.
3. **Cone attacks, not circles.** The enemy slam is a circular danger zone
   snapshotted at the player's position. Replace it with a forward cone (wedge)
   rooted at the enemy, aimed where the player stood at wind-up start, so the
   player can side-step out of the arc.
4. **Audio.** Every played card already voices by suit; give **each poker
   combo its own activation sound**, escalating with the hand's strength.

## Data / API shape

- `src/cards/standard.ts`: `HAND_SIZE = 4`; `StandardHand` is a 4-tuple.
- `src/cards/poker.ts`: `POKER_ORDER` drops `fullHouse` and is reordered to the
  four-card variant ranking (weakest→strongest):
  `highCard, pair, twoPair, straight, flush, trips, straightFlush, fourKind`.
  `MAX_POKER_STRENGTH = POKER_ORDER.length - 1` (= 7). A straight is four
  consecutive ranks (ace-low wheel `A-2-3-4`, ace-high `J-Q-K-A`); a flush is
  four cards of one suit.
- `src/sim/types.ts`: `EnemyState.attackZoneCenter: Vec2 | null` becomes
  `attackAim: Vec2 | null` — the unit cone direction captured at wind-up start
  (the cone's apex is the enemy's own, planted, position); null otherwise.
- `src/sim/constants.ts`: replace `ENEMY_ATTACK_RADIUS` with
  `ENEMY_ATTACK_RANGE` (cone length), `ENEMY_ATTACK_ARC_COS_SQ` (squared cosine
  of the half-angle, `0.5` = 90° wedge) and `ENEMY_ATTACK_TRIGGER_RANGE` (the
  distance within which an enemy commits to a wind-up).
- `src/render/sfx.ts`: a `COMBO_SFX` map from `PokerCategory` to an SFX id, one
  fanfare per category; `sfxForComboEvent('activated')` routes by category.

## Invariants (tested)

- `evaluateHand` classifies every four-card variant category correctly, and
  `strength` is the index in `POKER_ORDER`, strictly increasing across the
  ranking with max = `MAX_POKER_STRENGTH`.
- Determinism holds: same `(seed, inputs)` replays bit-identically for both the
  combat sim and the combo game (four-card hand, 52-card multiset conserved).
- An enemy does **not** enter wind-up while the player is beyond
  `ENEMY_ATTACK_TRIGGER_RANGE`; it does once the player is inside it.
- A slam connects only when the player is inside the cone at resolution:
  standing in the arc takes the hit; side-stepping out of the arc during the
  wind-up avoids it (emits `enemyAttackAvoided`).
- Every `PokerCategory` maps to a real entry in the `SFX` library.

## Out of scope

- No change to the single-card suit → action mapping or to stance stat math
  beyond rescaling against the new `MAX_POKER_STRENGTH`.
- No new enemy types or per-type cone tuning; the cone shape is shared.
