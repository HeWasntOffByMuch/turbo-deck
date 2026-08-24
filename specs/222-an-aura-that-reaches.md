# 222 — An aura that reaches the bodies inside it

## Problem

Every landing this game has resolves **once**. `landOnTarget` names a body,
`landBlast` a point, `landArea` a shape, `launchProjectile` a flight — and each
of them runs its effect list at one instant and is finished. Spec 190 added the
one thing that outlives its own delivery, an affliction, but an affliction is
carried by the body it was put on: nothing in the sim has ever said *this
ground is dangerous while I am standing on it*.

So a whole shape of skill is inexpressible. "A fire you carry with you" is not
a bigger Whirlwind, and it is not `ground.quake` with a longer window: it is a
region that follows a body, that touches whoever walks into it on the tick they
do, and that lets go of them shortly after they walk out. Every part of that is
about *time and position together*, which is exactly what a landing cannot say.

There is a second, smaller gap of the same age. `aurasFor` (spec 121) has
carried a `statuses` parameter and this promise in its own header since it was
written:

> The day a status list is replicated, `aurasFor` gains a branch and nothing
> else in the renderer changes.

Spec 186 replicated the status list. The branch was never written, and — worse
— **nothing anywhere plays an aura at all**. The rune-ring sigil spec 124 built
(three generated meshes, an orientation mode added to the mesh batch for it,
`hardStop` added to the effect format for it) has been reachable from the
Studio tab and from nowhere else for a hundred specs.

## Shape

### The table

`data/aura-fields.ts` — new, pure, in the same register as
`data/damage-over-time.ts`, and one row.

```ts
export interface AuraFieldDefinition {
  /** The {@link StatusId} its **carrier** wears. The field is that status. */
  readonly id: string;
  readonly name: string;
  /** How far it reaches, carrier's centre to a body's edge. World units. */
  readonly radius: number;
  /** The affliction it lays on whoever is inside. A row in `DAMAGE_OVER_TIME`. */
  readonly dotId: string;
  /** How much of that affliction is left the moment a body steps out. */
  readonly lingerTicks: number;
  /** How many bodies one tick of it may reach. Nearest first, ties on id. */
  readonly maxTargets: number;
  /** The ring drawn for it. The radius above is the ring's, so they are one number. */
  readonly auraEffectId: string;
  readonly description: string;
}
```

A row is `a reach + an affliction + a linger`, and every one of those three is
a system that already exists. **Nothing here is a rate, a cadence or a length**
— those are `data/damage-over-time.ts`'s to say, whole, and spec 190's rule
that every Burn in the game is the same Burn is exactly what makes "step out
and it goes out shortly" a sentence a player can reason about.

One derivation, and it is the same one that file already states once:

```
window = lingerTicks + 1
```

A pulse fires on `elapsed % interval === 0` and `statusOf` refuses an entry at
`tick >= expiresAtTick`, so a window of exactly `lingerTicks` loses a boundary
landing on its last tick. One tick of slack, stated in `lingerWindowTicks` and
nowhere else.

### The pass

`sim/aura-field.ts`, one exported function, mutating `working` and returning
nothing — it raises no events, because everything it does is somebody else's
to report:

```ts
export function pulseAuraFields(
  working: Map<number, ServerEntity>,
  tick: number,
  context: DotContext,
): void;
```

For every simulated, afflictable body carrying a live field status, it lays
`window` ticks of the field's affliction on every hostile, simulated,
afflictable body whose **edge** is inside `radius` — the reach measured the way
`landOnTarget` and `landBlast` already measure theirs, so a big body is caught
by the edge of the fire rather than only by its centre.

It runs as **3c**, immediately before the affliction pass, which is the only
correctly bracketed slot: every body has finished moving (1c/1d), so the
positions it measures are the tick's, and `pulsesOn` requires `elapsed > 0`, so
a body that steps in on this tick cannot also take a pulse for it.

Three rules, and each is the fix for the version without it.

**It writes through the same lander every other affliction does.** `applyDot`
puts a whole row on a body and `spread` puts *what is left* of one on the next
body along — the second is already an affliction landing with a shortened
window, so this is a third caller of a rule that exists rather than a new one.
`landDot` comes out of `damage-over-time.ts` for it and all three go through
it, which also closes a latent divergence: `spread` did not apply Corrosion's
`Sundered` rider, which is invisible only because no spreading row has one.

**It never puts out a bigger fire.** `applyStatus` refreshes a clock in *both*
directions — the mistake spec 190 records having made with Corrosion's Sundered
— so a body carrying a full four seconds of Burn from an Ember Toss that walked
into a one-second field would have had three of them cancelled by the fire it
was standing in. The window is `max(what is left, the linger)`.

**It never stacks with itself.** It re-applies every tick, so any rule but this
reaches a stacking affliction's ceiling in `maxStacks` ticks. It lays one stack
and then holds whatever concentration somebody *else's* skill put there:
`maxStacks: max(1, stacks already held)`, which is a no-op on a body at one
stack and cannot cut a five-stack Poison down to one.

It draws **nothing from the Rng** — `applyStatus` never has — so adding a field
to a fight cannot move a single draw in the world after it. Order is the entity
map's insertion order, and `maxTargets` cuts by distance then by entity id,
which is `crowd.ts`'s rule.

### The content

Nothing new in the ability system. `landSelf` has run `applyEffects` since spec
190, so the skill is a row:

```ts
{
  id: 'skill.scorchedEarth', kind: 'self', targeting: 'self', skill: true,
  windupTicks: seconds(0.6), cooldownTicks: seconds(24), cost: 7, damage: 0,
  effects: [{ kind: 'applyStatus', statusId: StatusId.ScorchedEarth,
              durationTicks: seconds(8) }],
}
```

`StatusId.ScorchedEarth` is a **boon** — it is the carrier's, and what it does
to everybody else is the field's. Its `STATUS_VISUALS` row authors no `effect`
sentence, for the reason the seven afflictions author none: the mechanic is a
row in a table, so `describeStatus` derives its lines from `AURA_FIELDS` the
way it already derives an affliction's from `DAMAGE_OVER_TIME`. Nothing
derivable may be authored.

`sigil.scorchedEarth` carries it, `slot: 'skill'`, no numbers of its own.

### The ring

`aura_scorched` in `vfx/library.ts`, at `SCORCHED_EARTH.radius` — **imported,
not retyped**. The ring is not decoration around a mechanic, it *is* where the
fire is, and a player who cannot tell which bodies are inside it cannot play
the skill at all. Two literals that have to agree is the drift `ground-decal.ts`
exists to refuse one level down.

`world/aura-vfx.ts` is the driver, built to `affliction-vfx.ts`'s three rules
because the machinery and the failure modes are the same: it holds **handles**
rather than ids (`play` returns 0 on refusal, and a tracker recording ids
cannot tell "asked for, did not start" from "started"), it asks `isLive` every
frame (a full instance pool *evicts* rather than refusing and bumps the slot's
generation), and **the stop is owed** — nothing in the particle system stops
itself, and a `HELD` particle left on a despawned body hangs in the air for ten
minutes holding one of 128 slots.

`AuraTracker` is the tested machinery for exactly this shape and is still what
a future ring should use where an id is enough; it cannot be used here for the
stated handle reason. `aurasFor` gains its promised branch and is finally
*called*.

## Invariants tested

**The pass**

- A hostile body inside the radius is burning after one tick; one outside is not.
- The reach is measured to a body's **edge**: a body whose centre is outside and
  whose edge is inside is caught.
- A body that leaves has exactly `lingerTicks` of the affliction left, and stops
  burning within a second of leaving.
- A body that **stays** never runs out: the expiry keeps moving and
  `appliedAtTick` does not, so the pulses keep their cadence rather than
  restarting.
- A longer application already on the body is **not shortened**.
- A five-stack Poison is not cut to one by a Poison field, and a field cannot
  raise a body past one stack on its own.
- Allies, the carrier itself, corpses, projectiles, drops and unsimulated bodies
  are untouched.
- Hostility is re-asked every tick, so a field cannot carry a wilderness fight
  across a safe-zone line.
- **Determinism**: the `Rng` state after twenty seconds of a field over six
  bodies equals the state after twenty seconds with no field at all; the same
  seed and inputs replay to bit-identical state.
- The pass costs nothing when nobody is carrying a field.

**The content**

- Every `AURA_FIELDS` row names a `StatusId` with a `STATUS_VISUALS` row, a
  `dotId` with a `DAMAGE_OVER_TIME` row, and an `auraEffectId` the vfx registry
  knows.
- `aura_scorched`'s ring radius equals `SCORCHED_EARTH.radius`.
- The sigil names an ability that exists, the ability is `skill: true`, and the
  status glyph and the bar sprite are drawn rather than falling back.
- `describeStatus(ScorchedEarth)` derives its reach, its affliction and its
  linger, and authors none of them.

**The client**

- `aurasFor` returns the field's ring for a body carrying it and nothing for one
  that is not, in `AURA_ORDER`.
- The driver starts once, stops once, restarts after an eviction, refuses to
  commit a refused handle, and leaves nothing running on a despawned body.

## Out of scope

- **A field anchored to the ground.** This one follows its carrier, which is
  what "an aura" means; a patch of burning ground somebody walks away from is a
  world entity with a position and a lifetime, and that is a different spec.
- **Fields on monsters.** The pass is general and a monster carrying the status
  works, but no monster row grants one.
- Any second ring. `aura_selected`, `aura_channel` and `aura_telegraph` were
  authored in spec 121 against facts this driver deliberately does not supply —
  the target ring is already a `GroundDecal`, and switching the other two on is
  a look change with its own decision to make.
- Cleansing, dispelling, or a field the target can resist.
