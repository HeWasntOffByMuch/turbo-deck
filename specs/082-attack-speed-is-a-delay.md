# 082 — Attack speed is a delay, and a shot's speed is its own

## Problem

Three things, all of them the same complaint from different directions: the
numbers do not mean what they say.

1. **How often a body can attack is spread over two stats that fight.**
   `EffectiveStats` carries `attackCooldownTicks` (a base cadence, flat
   modifiers only) *and* `attackSpeed` (a multiplier, everything proportional),
   and neither is the answer — the answer is `attackIntervalTicks`, a third
   thing, computed by dividing one by the other at each of the two call sites
   that want it. Ask "how long until this body can swing again" and there is no
   field to read. Both halves ride the wire, so the client re-does the division
   too.

2. **The cadence is far too fast to read.** The base is 24 ticks and a level-1
   character's dexterity drives it to about 19 — under a third of a second
   between swings, against a wind-up of 0.2s. Spec 065 built this game around a
   commitment being long enough to be read; at that rate there is nothing
   between one blow and the next to read anything in.

3. **A shot's speed was tied to that same stat** (spec 081), which made sense
   while `attackSpeed` meant "how fast this weapon is" in general. It does not
   survive the stat becoming a duration: a *longer* delay would mean a *faster*
   arrow. How quickly the next shot can come and how fast the last one flies are
   two different questions, and only one of them is the weapon's speed.

## Shape

### 1. One stat, and it is the delay

`attackCooldownTicks` and `attackSpeed` collapse into the number the sim
actually wants:

```ts
// state/types.ts -- EffectiveStats
/**
 * Ticks that must pass after a basic attack before the next may begin.
 * The whole answer: nothing divides it, and nothing else is consulted.
 */
readonly attackDelayTicks: number;
```

`attackIntervalTicks(stats)` is **removed**. Its two callers — the sim stamping
a basic attack's cooldown, and the HUD drawing the swing timer — read the field.
A function whose whole body is `stats.attackDelayTicks` is a second name for a
number, and this spec exists because there were three.

`StatModifier` is untouched, and keeps meaning what it means: `attackSpeedPct`
is *percent faster*, so it shortens the delay; a flat `attackCooldownTicks`
still adds ticks to it. The derivation is one line, in the one place a stat may
come from:

```ts
// player/stats.ts
export const BASE_ATTACK_DELAY_TICKS = Math.round(SERVER_TICK_RATE * 1.2);
export const MIN_ATTACK_DELAY_TICKS  = Math.round(SERVER_TICK_RATE * 0.2);
export const MAX_ATTACK_DELAY_TICKS  = Math.round(SERVER_TICK_RATE * 5);

attackDelayTicks = clamp(
  round((BASE_ATTACK_DELAY_TICKS + bonus.attackCooldownTicks) / haste),
  MIN_ATTACK_DELAY_TICKS,
  MAX_ATTACK_DELAY_TICKS,
);
// haste = (1 + bonus.attackSpeed) * (1 + bonus.attackSpeedPct)
```

A floor as well as a ceiling, for the reason the old bounds existed: haste is a
divisor, and a stat that can reach zero is a stat that will.

**1.2 seconds is what a body with nothing on it attacks at**, and that is now
literally true rather than approximately: `ATTACK_SPEED_PER_AGILITY` leaves the
cadence. Dexterity is a *base stat*, not a modifier, and its haste link is the
last piece of the indirection this spec is removing — it keeps armour, crit and
turn rate, and a weapon that wants to be fast says `attackSpeedPct` like the
Keen Longsword already does. What each main hand comes out at:

| main hand | | delay |
|---|---|---|
| (empty), Worn Sword | | 1.20s |
| Keen Longsword | `+15%` | 1.04s |
| Weighted Stars | `+20%` | 1.00s |
| Hunting Bow | `-10%` | 1.33s |
| Iron Maul | `-20%` | 1.50s |

Monster rows keep naming their own delay, which is the point of a per-body stat:
a grazer is slow because its row says 1.6s, not because it is holding anything.

On the wire, `0x44 Stats` loses a `f32` and keeps a `u16`;
`PROTOCOL_VERSION` goes to **10**.

### 2. A shot's speed is the row's, and nothing else

`projectileSpeedFor` and `projectileLifetimeTicks` lose their `stats` argument.
Speed is `spec.speed * PROJECTILE_SPEED_SCALE`, the lifetime is re-timed by the
same constant so the reach is still exactly what the table describes (spec 081's
rule, and its reason, are unchanged), and `attackSpeed` decides only how soon
the next shot may be thrown.

### 3. The arrow

Two numbers, both look and neither mechanical:

- `ranged.shot`'s `arcHeight` goes **55 → 110**. `arcHeight` has bought nothing
  mechanical since spec 079, so this is a taller lob and nothing else.
- The drawn arrow shrinks to **0.3x**, via an `ARROW_DRAW_SCALE` beside the
  `SHURIKEN_DRAW_SCALE` that already exists. It was drawn at seven times its
  collision radius — longer than a player is wide — which read as a javelin.

## Invariants tested

- **A bare body attacks every 1.2 seconds.** `computeEffectiveStats` on a record
  with no items and no skills gives `attackDelayTicks === BASE_ATTACK_DELAY_TICKS`,
  and that is `SERVER_TICK_RATE * 1.2`.
- **Dexterity does not shorten it.** The same record at 5 and at 500 dexterity
  has the same delay — while still differing in armour, crit and turn rate, so
  the stat has been unhooked from cadence rather than deleted.
- **Modifiers still move it, in the right direction**: the Keen Longsword and
  the Weighted Stars shorten it, the Iron Maul and the Hunting Bow lengthen it,
  and a Finesse skill's flat `attackCooldownTicks` shortens it.
- **It is bounded at both ends**: a pathological `attackSpeedPct` (-1, -5,
  `NaN`, `Infinity`) still yields a finite delay inside
  `[MIN_ATTACK_DELAY_TICKS, MAX_ATTACK_DELAY_TICKS]`.
- **There is one number, and the sim reads it**: a basic attack's cooldown is
  stamped to exactly `stats.attackDelayTicks`, and a body that has just attacked
  is refused the next attack until that many ticks have passed and allowed it on
  the tick after.
- **Every monster row round-trips**, and the codec round-trips `EffectiveStats`
  with the collapsed field; `PROTOCOL_VERSION` is 10.
- **A shot's speed no longer asks about the shooter**: two casters whose delays
  differ loose projectiles at identical speeds and with identical lifetimes,
  and the speed is `spec.speed * PROJECTILE_SPEED_SCALE`.
- **Reach is still the table's**, for every projectile row, and still at least
  the ability's own range — the assertion spec 081 added, now with the shooter
  out of it.
- `arrowProfile` still scales linearly and still puts the head in front, at the
  new scale; the drawn arrow is strictly shorter than it was and still longer
  than it is wide.

## Out of scope

- **A global cooldown.** The delay gates *basic attacks*, which is what
  `attackSpeed` has always gated. A lockout that also covers hotbar abilities is
  a real mechanic with its own feel, and it is not this.
- **Retuning monsters.** Their rows already name their own delays and keep them.
- **Renaming `StatModifier.attackSpeed` / `attackSpeedPct`.** They still mean
  what they say — percent faster — and renaming them would touch every item and
  skill row for no gain.
- **Rebalancing anything for the slower cadence.** Damage, wind-ups and
  cooldowns are untouched; 1.2s is a number to play against, not a package.
- **The arrow's collision radius.** Only the drawn mesh shrinks, exactly as the
  shuriken's drawn plate already grows; `projectileHits` is unaffected.
