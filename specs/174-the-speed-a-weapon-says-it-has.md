# 174 — The speed a weapon says it has

## Problem

Four weapon rows in `data/items.ts` have authored an `attackSpeedPct` since
spec 070, and nothing has read it since spec 091. The Keen Longsword — rare,
level 5, 90 coins — carries `attackSpeedPct: 0.15` under a comment that reads
*"Keen: the speed is the point of it"*, and equipping it changes the attack
factor by exactly nothing.

Spec 088 made attack speed a delay and left the weapon's modifiers applying to
it. Spec 091 reversed that half deliberately — *"the cadence is a property of
attacking, not of what the body is holding"* — and listed deleting the two
modifier fields as out of scope, so they stayed *"as stats, unread by the
cadence"*. Spec 144 then rebuilt the whole timing model around
`AttackSpeedInputs`, wrote `attackSpeedFromHaste` for exactly this conversion,
and declined to call it: *"a content decision rather than a refactor, so it is
left undone rather than done quietly."*

Nothing since made that decision, and the item rows were never brought into
line with the reader that had gone away. The result is a table that advertises
numbers no code path consumes, and the imbalance runs both directions:

| row | claims | what it actually did |
|---|---|---|
| `sword.keen` | `attackSpeedPct: 0.15` | lost its stated defining feature |
| `stars.weighted` | `attackSpeedPct: 0.2` | lost an upside |
| `maul.iron` | `attackSpeedPct: -0.2` | kept `+14` damage and `+2` Strength, paid nothing |
| `bow.hunting` | `attackSpeedPct: -0.1` | kept `+5` damage, paid nothing |

The two heavy weapons were priced against a drawback they never charged for.
No screen renders an item's modifiers, so the only way to discover any of this
is to equip the thing and read the character sheet — which is how it was
found.

This spec makes the decision spec 144 deferred: the socket gets plugged in, for
the weapon half.

## Shape

Three lines in `computeEffectiveStats` (`player/stats.ts`), replacing a literal
`0` and a `...NO_ATTACK_SPEED` spread:

```ts
const baseAttackTimeTicks = baseAttackTimeTicksFrom(bonus.attackCooldownTicks);
const attackSpeed = attackSpeedFromHaste(bonus.attackSpeed);
const attackSpeedPct = Number.isFinite(bonus.attackSpeedPct) ? bonus.attackSpeedPct : 0;
const attackSpeedMultiplier = 1 + Math.max(0, attackSpeedPct);
const attackSpeedSlowMultiplier = 1 + Math.min(0, attackSpeedPct);
```

No other file changes shape. `EffectiveStats` already carries the three fields,
`writeStats` already puts all three on the wire, and `attackTimingFor` already
passes `entity.stats` straight in as the `AttackSpeedInputs` — so the client's
prediction, the cast bar, the cooldown sweep and the animation's time scale all
follow with no edit. That is spec 144's plumbing working as designed; this spec
supplies the only thing it was missing, which is a source.

### One factor, three spans

`resolveAttackTiming` divides the interval, the attack point and the backswing
by the same factor. So a faster weapon does not merely stand still for less
time between identical swings — the whole blow gets quicker:

| main hand | factor | interval | wind-up | backswing | attacks/s |
|---|---|---|---|---|---|
| *(bare / `sword.worn`)* | 1.00 | 1.200s | 0.500s | 0.400s | 0.833 |
| `sword.keen` | 1.15 | 1.050s | 0.433s | 0.350s | 0.952 |
| `maul.iron` | 0.80 | 1.500s | 0.633s | 0.500s | 0.667 |
| `bow.hunting` | 0.90 | 1.333s | 0.883s | 0.383s | 0.750 |
| `stars.weighted` | 1.20 | 1.000s | 0.367s | 0.250s | 1.000 |

That is the property worth having and the reason this is not just a cadence
change. Spec 065 built this game on a commitment being long enough to be read;
a weapon that swung at the same speed but came round again sooner would make
the *pause* the stat rather than the blow. The maul now telegraphs for 0.633s
and is a genuinely heavier decision to commit to; the stars flick out in
0.367s.

### The two buckets

`attackSpeedPct` is one summed fraction, split by sign across
`attackSpeedMultiplier` and `attackSpeedSlowMultiplier`. Arithmetically that is
identical to putting it all in one bucket — the factor is their product and the
other is 1 — and it is written this way so a slow arriving later as a status
lands beside the slows instead of being netted off against an item's haste
before either is applied.

### What this does not reverse

Spec 147's structural commitment stands untouched: **every Agility scale is on
the attack point and the backswing, and nothing an attribute writes reaches
`baseAttackTimeTicks` or any of the three inputs.** Only content — an item's
modifier — moves the cadence. The fast stat still cannot become the mandatory
damage stat by shortening the clock, which is the thing the one-way rule in
`attackTimingFor` exists to protect.

The skill half of spec 091 also stands, and for free: no skill in `data/skills.ts`
authors `attackSpeedPct` or `attackCooldownTicks`, so wiring the reader changes
nothing a player can spend a point on. `attackCooldownTicks` is wired anyway —
it is the argument `baseAttackTimeTicksFrom` exists to take, and a caller
permanently passing `0` is what let this bug sit for eighty specs. Note it
changes BAT and therefore the interval, and *not* the wind-up or the backswing,
which come from the ability.

### The character sheet stops apologising

Two hints in `world/character-model.ts` currently say this is not implemented —
the Attack speed row reads *"Not implemented: no item, buff or attribute grants
attack speed yet. Always +0."* Both become true statements, and the Attack
speed row shows the factor rather than the permanently-zero additive stat,
since the sheet's own rule is to say what a number does or say that it does
nothing.

## Invariants tested

- A bare body is unchanged: factor exactly 1, interval exactly
  `BASE_ATTACK_TIME_TICKS`, and the three inputs at `NO_ATTACK_SPEED`'s values.
- `sword.worn` and every armour, off-hand and trinket row leave the factor at 1
  — only rows authoring `attackSpeedPct` move it.
- A weapon with positive `attackSpeedPct` shortens **all three** of interval,
  attack point and backswing; one with negative lengthens all three. Asserted
  per row against the table above.
- The factor is `1 + attackSpeedPct` exactly, and lands in the haste bucket
  when positive and the slow bucket when negative.
- Attributes still do not touch the cadence: a body at 500 Agility has the same
  `baseAttackTimeTicks`, the same three inputs and the same interval as one at
  5, and still gets its shorter backswing.
- No skill allocation changes the interval (spec 091's surviving half).
- `attackCooldownTicks` reaches BAT, and a value large enough to blow past the
  interval bounds is clamped rather than escaping them.
- Swept over the whole of `ALL_ITEMS`: every equippable row leaves the three
  inputs finite and the factor inside the clamp, and the factor is 1 for
  exactly those rows that author no `attackSpeedPct`. A non-finite modifier
  costs the bonus rather than poisoning the factor -- the guard is reachable
  from the table sweep rather than from a hand-built record, since a player
  record has no way to carry a raw modifier.
- Non-basic abilities are unaffected: `attackTimingFor` passes
  `NO_ATTACK_SPEED` for anything without `basicAttack`, so a weapon's speed
  never shortens a heavy ability's wind-up or a cooldown.

## Out of scope

- **Retuning the four rows.** They are made to mean what they already say. If
  `maul.iron` is now too slow to be worth `+14` damage that is a balance
  finding for `npm run balance` to report, not something to pre-empt here.
- **Attack speed from attributes, skills or buffs.** The socket now has one
  source and one only. Giving Agility a share of it is the exact move spec 147
  ruled out and would need its own argument.
- **A second weapon's worth of speed.** Only the main hand authors it today;
  an off-hand that did would sum, which is already what `sumModifiers` does and
  needs nothing here.
- **Showing an item's modifiers in the bag or the shop.** The reason this was
  invisible is that no screen renders them, which is a real gap and a separate
  spec — a tooltip is a UI feature, not a stat fix.
- **The flat `attackSpeed` haste field.** Wired through `attackSpeedFromHaste`
  because it is one line beside the other two, but nothing authors it and this
  spec does not add a source.
