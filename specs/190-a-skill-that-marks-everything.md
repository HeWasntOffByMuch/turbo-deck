# 190 — A skill that marks everything

## Problem

Spec 186 put nine statuses on the wire and drew a mark for each of them, and
its own probe found the row broken at full width — eight 13px marks in a 52px
flex box shrink to 3px specks, all of them true and none of them readable.
Spec 188 made a skill an assembled row that can apply one.

Nothing can put more than two of those marks on one body. Every row that writes
a status writes one or two: a weak point leaves `Exposed`, a commit leaves
`Vulnerable`, Crippling Strike leaves `Slowed`. The rest are milestone-gated, so
the full row — the case `MAX_VISIBLE_STATUSES` bounds, the case the packer's
`adapt:` fold is for, the case the mark layout was wrong in — can only be
reached by building a character that earns each one and then arranging a fight
in which they all overlap at once. `admin:triggerEvent 'status'` writes one at a
time and is the developer path for exactly that reason.

So the thing that has never been looked at is the whole row, on one body, in the
game rather than in a probe. This is a **test row** and says so in its name: it
exists to produce every mark at once and to change as little else as it can.

## Shape

Two table rows and no new machinery, which is the whole of what makes it cheap
— spec 188's claim is that a skill is `targeting + casting + costs + cooldown +
effects`, and a row that needed anything new here would be that claim failing.

`data/abilities.ts` — beside the four skills of spec 188:

```ts
{
  id: 'skill.testStatuses',
  name: 'Test Statuses',
  kind: 'melee',
  targeting: 'unit',
  skill: true,
  windupTicks: seconds(0.3),
  castAngleDeg: 35,
  cooldownTicks: seconds(2),
  cost: 0,
  range: 85,
  damage: 1,
  effects: [ /* one damage, then every visible status */ ],
}
```

`data/items.ts` — `sigil.testStatuses`, `slot: 'skill'`, `levelRequirement: 1`,
`value: 0`. Zero because `value` is what both prices are derived from, so a `0`
row cannot be bought or sold: this is not economy content, and it is in **no
loot table and no vendor stock**. `admin:giveItem` is how a tester gets one,
which is the same path any other operator action takes.

### What "every status" means

`sim/statuses.ts` holds twelve ids plus the per-ability `adapt:` family, and
they are deliberately not all the same kind of thing. The row applies **every
status the mark layer can draw** — the nine rows of `STATUS_VISUALS`, with the
`adapt:` key built from `adaptedKey` — and the split is stated rather than
implied:

| Status | How it arrives |
|---|---|
| Flow, Momentum, Prepared, Attuned | authored `applyStatus` |
| Exposed, Vulnerable, Sundered, Slowed | authored `applyStatus` |
| Adapted (`adapt:skill.testStatuses`) | authored `applyStatus` |
| `recentlyHit`, `inCombat` | **the blow itself** — `markTarget` writes both |
| `secondWind.spent`, `perfectExit.spent` | **not applied, on purpose** |

Those last two are *inverted* flags: carrying one means the mechanic has fired
and has not re-armed, so writing them would silently switch Second Wind and
Perfect Exit off on whatever the tester is measuring. A test tool that disables
two mechanics while claiming to add nine states is worse than one that names the
two it leaves alone. Neither has a mark, so nothing is lost from the picture.

Magnitudes are **small and real** rather than zero. A zero magnitude produces
the mark and no effect, and a `Slowed` mark over a body moving at full speed is
the interface asserting something untrue — the same objection spec 158 makes to
a placeholder name. So: 20% off the move speed, 5% more damage taken, 0.1 armour
off, 10% off the next wind-up. Enough to be measurable, small enough that the
row is not balance content.

Damage is `1`, through the ordinary `{ kind: 'damage' }` effect and therefore
through `resolveBlow`. Kept rather than dropped for two reasons: it makes the
skill land as a real blow — a `hit` event, aggro, a damage number, and the two
in-a-fight timers above — and an ability blow carries
`staggerPower * abilityPoiseFactor` of guard damage, which is zero for everyone
except the Strength+Intelligence pair, so it cannot stagger what it marks.

Every effect lands on the **target**, which is what puts the whole row over one
head. Nothing is aimed at the caster: `EffectSubject` already allows it, and a
second copy of nine effects to see the row over your own head is a bigger row
for a worse picture than getting hit by one.

## Invariants tested

- One cast leaves **every** row in `STATUS_VISUALS` live on the target at once
  — the assertion is written over the visual table rather than over a list of
  ids, so a tenth status added to that table fails this test until this row
  applies it too.
- It never applies `secondWind.spent` or `perfectExit.spent`, so a body it
  marked can still fire both.
- Its damage is the single point the row authors — asserted with spell power
  flattened, which is what `active-skills.test.ts` already does so a damage
  assertion is arithmetic — and it cannot kill a full-health dummy however many
  times it lands.
- It does not stagger what it hits: the target's activity is unchanged and its
  guard pool is where it was.
- It is refused unless it is carried, like every other `skill: true` row.
- The sigil is worth nothing and is in no loot table and no vendor stock.
- `skillAbilityIdsOf` reads it out of any of the four skill slots.

## Out of scope

- **Balance.** Nothing here is content: no loot weight, no vendor, no level
  gate above 1, and no attempt to make the row a thing anybody would choose.
- **The stun.** A stagger is an `Activity` and not a status, it roots what it
  lands on, and `skill.stunningBlow` already covers it. Adding one here would
  make every mark measured through a body that cannot move.
- **A second subject.** No `on: 'caster'` copy, per the note above.
- **A new status.** If the sim gains one, this row gains a line; it does not
  gain a mechanic.
