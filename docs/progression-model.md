# The progression model

**One pool, six tracks.** What a progression point is, what it buys, and what
the conversion from the old two-currency model actually moved. Spec 244 is the
change; this is the standing description.

Its companions: `progression-and-scaling.md` is what a *number* is allowed to do
(and holds the two rules every content change is reviewed against);
`mechanics-vocabulary.md` is how a mechanic is *described*;
`reward-philosophy.md` is what a reward is *for*.

---

## 1. One point economy

There is exactly one currency: **`unspentProgressionPoints`**.

| | Earned |
|---|---|
| A fresh character | `SCALING.startingPoints` = **6** |
| Per level | `SCALING.pointsPerLevel` = **4** |
| At level `n` | `pointsEarned(n)` = `6 + 4 * (n - 1)` |

`player/attributes.ts`'s `pointsEarned` is the **only** award schedule. It was
two — attribute points at 5 + 3/level, and skill points at 1 + 1/level — and the
numbers above are those two summed, so a level-20 character earns the same 82
points of purchasing power they always did. That is a conversion and not a
rebalance: whether 4 a level is right for a pool that now buys two things is a
pacing question, deliberately left open, with the schedule centralized in
`SCALING` so it can be answered in one edit.

A point buys exactly one of two things:

```
one progression point
  ├── an attribute point   → the attribute rises by 1, the track advances
  └── a specialization tier → the mechanic deepens, the attribute does NOT rise
```

**Spending on a specialization never raises the attribute.** Nothing in
`player/specializations.ts` writes `baseStats`, and reaching the next milestone
therefore always costs points spent on the track itself. That is the opportunity
cost the whole system exists to present, and it is a property of the module
graph rather than a rule somebody remembers.

## 2. Attribute advancement

An attribute is a **track**. Spending a point on it:

- consumes one point,
- raises the authoritative attribute value by 1 (`allocateAttributePoint`),
- re-derives every baseline scale (`computeEffectiveStats`),
- may cross one or more thresholds, meeting milestones and unlocking
  specializations,
- and is replicated back as a whole `Stats` message.

Bounded by `SCALING.startingAttribute` (5) below and `SCALING.attributeHardCap`
(60) above. Server-authoritative throughout: the request names an attribute
**ordinal** and carries no value.

## 3. Milestones — what is automatic

A **milestone** is a threshold at 20, 35 or 50 that grants a `StatModifier` the
moment the attribute reaches it. Eighteen of them, three per attribute, in
`data/milestones.ts`. Nothing is bought and nothing is chosen; reaching the
number is the whole of it.

Every milestone **deepens a specialization the track unlocked earlier** — the
`deepens` field, and all eighteen have one. Strength 10 makes Crushing Blows
purchasable; Strength 20 improves it whether or not a tier was ever bought. That
is why the same name appears twice on a track, and recording the link is what
lets the sheet draw one mechanic growing rather than two things with one name.

## 4. Specialization tiers — what is bought

A **specialization** is a mechanic a milestone makes available, bought a **tier**
at a time out of the one pool. Thirty-six of them, six per attribute, in
`data/specializations.ts`, unlocked at 10, 25 or 40.

Reaching the threshold makes it *available*, never bought:

```
Reach STR 10   → Crushing Blows becomes available   [---]
Spend a point  → Crushing Blows I                   [#--]
Spend another  → Crushing Blows II                  [##-]
```

A tier costs `costPerTier`, which is absent on every row and therefore 1.
The field exists so a variable cost is a data edit rather than a schema change;
inventing a cost curve now would be tuning a system nobody has played.

**Points spent on a specialization do not count toward its own requirement**, or
toward any other threshold. Twelve points into Crushing Blows leaves Strength
where it was.

## 5. The tracks, as converted

Six nodes per track: three that unlock specializations, three that fire a
milestone. **No threshold moved and no mechanic was invented** — the thirty-six
skills became thirty-six specializations and the eighteen milestones stayed
automatic, in place.

```
STRENGTH   5 ──── 10 ──── 20 ──── 25 ──── 35 ──── 40 ──── 50
                   │       │       │       │       │       │
                   │    (auto)     │    (auto)     │    (auto)
                   ├ Crushing Blows ●●●            │
                   ├ Committed Swing ●●●───────────┘
                   │                 ├ Brutal Follow-Through ●●●
                   │                 ├ Heavy Handling ●●●
                   │                 └ Overkill ●●●
                   └ Unstoppable ● ───────────────────────────┘
```

| Track | 10 (buy) | 20 (auto) | 25 (buy) | 35 (auto) | 40 (buy) | 50 (auto) |
|---|---|---|---|---|---|---|
| **STR** Overpower | Crushing Blows ×3, Committed Swing ×3 | Crushing Blows | Brutal Follow-Through ×3, Heavy Handling ×3, Overkill ×3 | Committed Swing | Unstoppable ×1 | Unstoppable |
| **AGI** Outmaneuver | Quick Recovery ×3, Mobile Offense ×3 | Quick Recovery | Lightfoot ×3, Rapid Handling ×3, Flow ×3 | Mobile Offense | Perfect Exit ×1 | Perfect Exit |
| **INT** Manipulate | Arcane Potency ×3, Spell Shaping ×3 | Spell Shaping | Prepared Casting ×3, Catalysis ×3, Efficient Construction ×3 | Prepared Casting | Arcane Overflow ×1 | Arcane Overflow |
| **CON** Endure | Deep Reserves ×3, Steady Frame ×3 | Steady Frame | Second Wind ×3, Hard to Kill ×3, Sustained Effort ×3 | Hard to Kill | Overflow Vitality ×1 | Overflow Vitality |
| **PER** Exploit | Weak-Point Study ×3, Opening Read ×3 | Weak-Point Study | Steady Aim ×3, Hunter's Eye ×3, Exploit ×3 | Opening Read | Resource Sense ×1 | Resource Sense |
| **WIS** Sustain | Resource Discipline ×3, Measured Recovery ×3 | Resource Discipline | Mastery ×3, Conservation ×3, Adaptation ×3 | Adaptation | Conversion ×1 | Conversion |

**Every old skill became a specialization; none was removed and none was merged.**
Two were considered for merging because a milestone shares the name — Crushing
Blows and the rest — and neither was, because spec 239 deliberately budgeted the
four sources of `windupPoiseArmor` to sum to exactly its 0.9 cap and the three
sources of `attunedCostPct` to exactly its 0.2. Removing either half of such a
pair would leave a fully-invested character short of where they used to end, and
"every purchased tier does something" would start failing on the survivors.

The one thing that *did* change name is the word: the thirty-six were "skills",
which already meant the four **active abilities** a character equips
(`skill1..skill4`, `activeSkillId`, `SkillSlot`). Those are untouched and remain
a separate system with a separate UI.

**Current rule — Mobile Offense pays cooldown, not recovery (spec 254).** The
row and its milestone are the one place a conversion since 244 has changed what
a tier is *worth*, and the reason is that the loop was a circle: cancel the
follow-through, gain Flow, have Flow shorten the follow-through. The player has
already left the recovery by the time the reward lands, and a shorter backswing
is fewer ticks in which the trigger can be reached at all — a reward that makes
its own trigger rarer. The trigger is unchanged; each tier now takes
`SCALING.agility.mobileOffenseCooldownTicks` (0.4s) off **every active ability
that is cooling**, and the Agility 35 milestone deepens it by one more tier's
worth. The basic attack's own entry in `cooldowns` is barred, which is what
keeps spec 144's rule — cancelling buys movement, never attacks per second —
true by construction rather than by care, and the flask is barred because its
pacing is charges as well as a timer.

Flow itself keeps its effect on the follow-through, because Mobile Offense is no
longer a source of it and two purchases still are: the Agility 20 milestone that
introduces Flow, and the **Flow** specialization at 25, whose whole payoff it is.
With `flowArmorPct`, `flowWeakPoint`, `flowCostPct` and `spellbladeHandling` all
in the granted-by-nothing list below, taking that away would leave the Flow
status with no live effect at all and two purchases buying nothing — so what Flow
is *for* past the follow-through is a design question with content behind it,
listed there rather than answered here.

**Current rule — Agility moves the cancel point, not the length (spec 258).**
That effect is `flowBackswingCancelPct` now rather than `flowBackswingPct`, and
the change is the other half of the circle 254 took apart. Its own complaint was
that a shorter backswing is *fewer ticks in which the trigger can be reached at
all* — and Quick Recovery, the Flow specialization and the Agility attribute
itself were all still shortening it, so the window Mobile Offense is played in
went on shrinking with every point spent on the tree that pays for using it.

So the follow-through is a fixed length for everybody and what Agility buys is
the tick it may be **left** on: `backswingCancelPct` is the fraction of it a body
is committed to, 0.7 with nothing bought, and the attribute (0.11 at the cap),
Quick Recovery (0.05 a tier) and Flow (0.05 a stack) subtract from it against a
floor of 0.25. Nothing in the tree reaches that floor, so no purchase is bought
into a filled cap. `backswingScale` and `backswingReduction` are gone, and
`attackTimingFor` no longer lets anything Agility writes reach
`baseAttackBackswingTicks`.

The gate sits **above** the payout, in `cancelCast`, so a walk-out asked for too
early earns neither the cooldown nor the Flow — it is refused outright and the
swing runs on. An interrupt is exempt, because dying and having your guard broken
are not decisions the player is making. **Strength wins commitment; Agility
controls commitment.**

## 6. Explicit pair synergies

**Removed.** `data/synergies.ts` and its fifteen authored two-attribute bonuses
are deleted. No pair of attributes contributes a modifier that neither attribute
contributes alone, and three tests say so: in the tables
(`progression-tables.test.ts`), in the resolution over all fifteen pairs
(`derived.test.ts`), and in the client view (`character-model.test.ts`).

The framework went with the content rather than being left dormant. It was not
expensive, but it was not inert either — it had a field on `Progression`, a
branch in `resolveProgression` and a name in the read model's rules — and a
capability that leaks into resolution while holding nothing is worse than one
that is absent. Bringing it back is a table, a `metSynergies`, and one line in
hop 2.

**Twenty-one `TraitStats` fields are now granted by nothing**, and that is
recorded rather than repaired. Each was reachable only through a pair:

```
abilityPoiseFactor   appliesSundered      exploitPoiseFactor   executeBonus
executeBelow         breakResource        breakCooldownRefund  flowArmorPct
poiseRegenMoving     spellbladeHandling   handlingCooldowns    flowWeakPoint
flowCostPct          damageToShield       abilityWeakPoints    preparedMastery
vsVulnerableReduction  healingSurge       healingSurgeBelow
exposedTeamResource  attunedFromWeakPoints
```

`adaptationCap` left that list in spec 275, and how it left is the pattern worth
copying: it was **not** resurrected by re-creating the pair that used to grant
it. Wisdom's Adaptation needed a purchasable ceiling -- every tier and the
milestone converged on `SCALING`'s 0.3, so deep investment bought only
hits-to-cap -- and the field that expresses "how far can this body adapt"
already existed. A dormant field earns its way back by a live mechanic needing
exactly what it says, or it stays dormant.

Two fields that were never on this list were also granted by nothing, and spec
274 found both in Wisdom:

- `cooldownReduction`, which sat beside the very-much-used `costReduction` and
  reads as a hook nothing was ever pointed at. Composure grants it now.
- `masteryRelief`, which was worse than dormant -- it was derived, clamped,
  given a wire slot and replicated in every `Stats` message while the mechanic
  it named ran through a *parallel* reader in `player/specializations.ts`. The
  field is gone and its wire slot carries the new Mastery's three.

The lesson for the audit is recorded with them: `audit:progression` reports a
purchase as ACTIVE when a value on `EffectiveStats` or `TraitStats` moves, and
has no notion of whether anything *reads* that value. `masteryRelief` scored
ACTIVE for its whole life.

They are live in `deriveTraits` and in the sim, and unreachable from content --
the same shape as `kind: 'channel'`, which has no ability rows and a complete
code path. Removing them is not free: `TraitStats` is replicated field by field
through `TRAIT_WIRE_ORDER`, so deleting one is a protocol change, and the audit's
`TRAIT_DIRECTION` table is asserted to cover `TraitStats` exactly. Whether they
come back with authored synergies, get attached to specializations, or get
deleted is a design decision with content behind it either way, and this is the
list to decide from. The tests that reached them through a pair now assert the
*negative* -- that nothing grants the flag -- so a default acquired by accident
still fails.

**Systemic interaction is not removed and is expected.** Strength pressures
Guard; Perception reads and exploits Vulnerable and Weak Points; Agility moves
the attack point and the follow-through's cancel point without touching the
interval; Wisdom
stretches the resource economy; Constitution absorbs. Two builds compose because
those mechanics meet, not because a row said they should. Whether that is
*enough* is the question removing the authored layer exists to make answerable —
if playtesting says it is not, synergies come back deliberately, with content
behind them, in a spec of their own.

## 7. Respec

`respecProgression` returns attribute points **and** specialization tiers
together, in one operation, for `SCALING.respecCost` (40 coins).

That is the atomic-refund answer to the dependency problem, and it makes the bad
state unrepresentable rather than handled: **there is no path in the game that
lowers an attribute and leaves a tier standing above its own milestone**, so
nothing downstream has to ask whether one is stranded.

It also closes a leak. Before spec 244 a respec reset `baseStats` alone and left
the tiers to `sanitizeSpecializations` on the next recalculation, which *dropped*
the ones whose threshold was no longer met and refunded nothing for them — a
respec quietly burned every point spent in the tree. Under two budgets that was a
rough edge; under one it is the pool leaking.

`sanitizeSpecializations` survives for the case a respec no longer causes: a
table edit that raises a threshold or removes a row. It drops what can no longer
be justified and `reconcileProgressionPoints` hands the points back at the next
login.

## 8. Persistence, and the local reset

`PersistedPlayer` carries three progression fields:

```ts
baseStats: BaseStats;                                  // six attributes, allocated
specializations: readonly SpecializationAllocation[];  // { specializationId, tier }
unspentProgressionPoints: number;
```

`unspentSkillPoints`, `unspentAttributePoints` and `skills` are gone, and nothing
writes them. `PLAYER_SAVE_VERSION` is **2**.

**Old local characters are reset, not migrated.** A row at save version 1 is
refused by name (`UnsupportedSaveVersion`) rather than reinterpreted: a version-1
document holds two point pools and skill ranks, and read as a version-2 one every
progression field silently defaults, which is a character who has lost their
build and cannot tell. There is deliberately **no conversion code** — the only
saves at version 1 are local development characters, and a migration written to
preserve a handful of them is a migration to be maintained forever.

What was reset:

- **`data/game.db`** — the SQLite database `npm run server` opens and migrates
  itself. It is gitignored (`/data/`, `*.db`) and is a developer's save file
  rather than source, so there is nothing committed to delete; a developer with
  one from before this change deletes it, and the refusal message says so.
- Test fixtures and harness records, which are constructed in code and were
  updated with the schema.

No production data is touched by any of this: the database is per-developer and
per-deployment, and the refusal is a startup-time failure with a stated fix
rather than a silent rewrite.

## 9. What the server owns, and what the client renders

The **server** owns attribute values, the unspent pool, which milestones are met,
which tiers are held, every legality rule, the derived traits, persistence and
respec. The `Stats` message carries **state**: the six attributes as allocated,
the six as resolved, the pool, the tier list, and the full `EffectiveStats`.

The **client** owns layout. It composes the six tracks itself, from that state
plus the content tables it already imports — so no coordinate, ordering hint or
pixel size crosses the wire, and the *shape* of a track
(`data/tracks.ts`) is content rather than something replicated per frame.

A purchase is one request:

```ts
SpendProgressionPoint {
  target: ProgressionTarget.Attribute      → attribute: <ordinal>
        | ProgressionTarget.Specialization → specializationId: <string>
}
```

**It names a target, never a result.** There is no attribute value, no tier
number and no amount, so a forged progression state is unrepresentable rather
than merely refused — there is no field on the message a client could lie in.
The client never updates optimistically; the answer is the `Stats` that follows,
or a refusal in the corner.

`character-model.ts` runs the server's own `validateAttributeSpend` and
`validateSpecializationSpend` against the client's copy of the record, so a
greyed-out "+" and a server refusal cannot disagree, and the "why" a player reads
is the server's own words.

## 10. Keeping it true

`npm run audit:progression` answers, for every specialization, at every tier, at
every attribute value where that tier can legally be bought: does the purchase
reach the simulation? Four verdicts — `ACTIVE`, `REDUNDANT`, `INERT`,
`BACKWARDS` — and `player/progression-audit.test.ts` is the same thing as a CI
gate with an explicit allowlist. Spec 241's rule is unchanged by the rename:
**every purchased tier must change a value the simulation reads, at every
attribute value where that tier can legally be bought.**

`npm run balance` fights the build presets through the real sim. Twelve of them
compare *attributes* and spend nothing on tiers, exactly as they always did; four
more compare *spending*, which is the axis one pool created — deep track,
specialized early, mixed, and generalist. What that table is for is the shape of
a row, not equality between rows: the failure it exists to catch is one of "push
the number" or "buy the tier" being obviously right every time.
