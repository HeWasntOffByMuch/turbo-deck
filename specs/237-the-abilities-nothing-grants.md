# 237 — The abilities nothing grants

## Problem

Nine of the game's twenty-five abilities are reachable by no player and no
monster. They are spec 062's starting set, and that file says outright what
they were for: *"The starting set exists to exercise each AbilityKind end to
end, not to be balanced. One melee, one flat projectile, one lobbed projectile,
one ground-targeted blast, one self-buff-shaped heal, and one channel."*

Spec 188 replaced them. What a player casts now comes from a **sigil** in one of
four skill slots, and `startCast` refuses a `skill: true` ability that is not in
one. The demo rows were never given sigils and were never removed, so they sit
in the table: not `skill: true`, castable by any client that names them, priced
and tuned against a game that has moved twice since — and, because `melee.heavy`
and `ground.quake` out-damage every real skill, they are what `npm run balance`
has been measuring the twelve builds with.

## Shape

Nothing is added. Seven rows leave `data/abilities.ts`:

| removed | was | why it stayed reachable |
|---|---|---|
| `melee.heavy` | melee, 1.1s | nothing granted it |
| `bolt.arcane` | flat projectile | nothing granted it |
| `bolt.lob` | lobbed projectile | nothing granted it |
| `bolt.seek` | unit-targeted projectile | nothing granted it |
| `ground.quake` | ground blast | nothing granted it |
| `self.mend` | self heal | nothing granted it |
| `channel.drain` | the one channel | nothing granted it |

Two of the nine orphans **stay**, because an item table cannot see what reaches
them: `melee.slash` is `BASIC_ATTACK_ID` — bare hands and every melee monster —
and `self.hearthdraught` is `VIAL_ABILITY_ID`, the flask on the action bar.

`STARTING_ABILITIES` goes with them. It was that list of nine, and its one
reader is the balance harness.

### What has to move with them

- **`scripts/balance-builds.ts`.** `CASTABLE` is derived from the sigils in
  `data/items.ts` instead — every `activeSkillId`, so a thirteenth sigil is in
  the harness the moment it is in the game — and the presets wear four of them,
  the same four for all twelve, for the reason they all carry the same sword.
- **`render/iso3d/world/character-model.ts`** loses seven icon rows,
  **`ui/gallery/render.ts`**'s demo bar is repointed at rows that exist, and
  **`scripts/preview-shots.ts`** draws one orb rather than a flat/lobbed pair.
- **`vfx-wire.ts`**'s `REDUNDANT_SERVER_EFFECTS` loses `self.mend.self`.
- Tests that used a demo row as a fixture are repointed onto a surviving
  ability **of the same shape** — a ground blast for a ground blast, a
  unit-targeted projectile for one — and, where they drive `startCast`, are
  given a sigil to carry, because that is now the only way to cast anything
  that is not a weapon's own swing.

## Invariants tested

- Every ability in the table is reachable: granted by an item's
  `activeSkillId`, named by an item's or a monster's `basicAttackId`, or one of
  the two constants above. Nothing is castable by naming an id nobody carries.
- `npm run balance` still casts: `CASTABLE` is non-empty and the presets carry
  what it names.
- Every existing invariant those fixtures asserted still holds — the repointing
  changes which row a test drives, never what it claims.

## Out of scope, and one finding

**The channel mechanism stays.** `channel.drain` was the only `kind: 'channel'`
row, so the mechanism now has none: `sim/abilities.ts`'s `CastPhase.Channel`,
`nextPulseTick` and `endTickFor`'s channel branch, `client/combat.ts`'s
prediction of it, and `data/description.ts`'s cadence line are all live and
unreachable from content. It is left alone here because removing it means
taking a member out of the middle of `CastPhaseValue`, which renumbers the two
after it — a protocol change, and one that deserves its own spec. Two sim tests
that could only be written against a real channel row are removed with a note
saying what to restore; the description branch is kept under test against a row
the test constructs.

**A finding, not fixed here.** `attackTimingFor` sends a non-basic ability's
`cooldownTicks` through `resolveAttackTiming` as though it were a Base Attack
Time, which clamps it to `MAX_ATTACK_INTERVAL_SECONDS`. That constant's own
comment says *"nothing in the content reaches either bound"*, which is true of
BAT and false of this: **twelve of the fourteen non-basic rows are over five
seconds, so every one of them is silently on a five-second cooldown.** Scorched
Earth's authored 24s is 5s; Stunning Blow's 14s is 5s. It was invisible while
the ability these tests drove was `melee.heavy`, whose cooldown was inside the
bound. `abilities.test.ts` now asserts the clamped value and names it, so the
behaviour is written down rather than assumed; changing it is a balance
decision and a change to `attack-timing.ts`.

**The unused art stays.** `ability:heavy`, `:bolt`, `:lob`, `:quake`, `:mend`
and `:drain` are authored sprites in `theme/atlas-source.ts` with no consumer
now. A sprite costs a few bytes and is the next skill's for free; a rule nothing
enforces is a different kind of thing.
