# 173 — A stagger that stops you

## Problem

Spec 147 built poise as "the mechanic Strength exists to use", and `poise.ts`
still describes a broken body as **rooted, its cast dropped, its Flow gone, for
`staggerTicks`**. Two of those three are true. The root was never written.

`ActivityValue.Stunned` is set at `sim/blow.ts:251` and, in the whole server, is
read exactly twice: `blow.ts:166` gates Strength's execute bonus, and
`world.ts:1062` slows poise regen — which is nearly moot, because the break has
already refilled the pool to full. Nothing else asks. Specifically:

- The movement pass (`world.ts`) zeroes intent on `steered.cast !== null` and on
  nothing else. A break sets `cast: null` (`poise.ts:145`), so a staggered body
  keeps walking at full speed the same tick it was broken.
- `startCast` checks health, cast, cooldown, resource, charges, target and range.
  It never reads `activity`. A staggered body commits a fresh cast on the next
  tick, and that cast writes `activity: Casting`, ending the stagger early —
  so the window does not even last `staggerTicks`.
- `poiseBroken` never reaches the wire. `server.ts`'s dispatch has no case for
  it; only `sim/metrics.ts` consumes it, for `npm run balance`. Nothing in
  `src/render/` branches on `Stunned`, so a staggered body is drawn exactly like
  an idle one.

So the balance harness's `staggersCaused`/`ticksStaggered` columns — the ones
CLAUDE.md tells you to read Strength's identity off — currently count an event
with almost no consequence. This spec makes the docstring true and makes the
result visible.

## Shape

### The predicate (`src/server/sim/poise.ts`)

```ts
/** Whether this body is inside a poise break's window, and so not its own. */
export function staggered(
  entity: Pick<ServerEntity, 'activity' | 'activityUntilTick'>,
  tick: number,
): boolean;
```

One function, exported from the file that owns the mechanic, so the two gates
below cannot come to different answers about what "staggered" means. It reads
`activity === Stunned && tick < activityUntilTick`, which is the same pair
`expireActivity` already uses to decide when to stop being stunned.

### Gate 1 — the legs (`src/server/sim/world.ts`, movement pass)

A staggered body has its movement zeroed *and its facing pinned* to where it
already points:

```ts
const intent = !rawIntent
  ? rawIntent
  : staggered(steered, tick)
    ? { ...rawIntent, moveX: 0, moveY: 0, facing: steered.facing }
    : steered.cast !== null
      ? { ...rawIntent, moveX: 0, moveY: 0 }
      : rawIntent;
```

The facing is what separates the two roots. A caster keeps steering — spec 067
holds the aim live right up to the commit, and that is the feature. A staggered
body is aiming at nothing, and one that kept tracking you through its own
stagger would read as unaffected, which is the whole thing this spec is fixing.

**The intent is pinned, never nulled**, and that was learned by writing it the
other way first. A null intent is how the movement pass says *no request
arrived*, and `casters` is built from exactly that (`world.ts`, `if (intent !==
null || next.cast !== null)`). Nulling it hid the body's **cast request** along
with its movement: the swing was not refused, it was never considered, so the
client was never answered and sat out `PREDICTED_CAST_TIMEOUT_TICKS` on every
blow it tried to throw. Measured, that was 82 asks becoming 39 commits with
*zero* rejections recorded and the player idle 65% of a fight. Spec 080's rule
covers this case too, and it is why the dead-body branch a few lines above
exists: **a request that cannot be honoured still gets an answer.**

### Gate 2 — the hands (`src/server/sim/abilities.ts`)

A new refusal, beside the eight that exist:

```ts
export type CastRejection =
  | ...
  /** Inside a poise break's window (spec 173). */
  | 'staggered'
```

checked in `startCast` **after** `dead` and `alreadyCasting` and before the
cooldown, because the answer "you are staggered" is more useful than "that is on
cooldown" when both are true.

### The mirror stops lying (`src/server/client/combat.ts`)

`asEntity` currently hardcodes `activity: 0, activityUntilTick: 0`. With gate 2
in place that is a lie the client would act on: it would light a button the
server is about to refuse. `activity` and `activityUntilTick` are already
replicated (`FIELD_ACTIVITY`), so `Mirror` gains both and passes them through —
the same rule `poise`, `shield` and `fallbackCharges` already follow in that
file. Statuses stay blank; this is not a change to that decision.

### The order stops asking (`src/render/iso3d/world/target.ts`)

`AutoAttackInput` gains `staggered`, beside `rooted` and `pending`, and the
standing attack order holds while it is true — no ask, no chase, and the mark is
kept, because a stagger is half a second and losing your target as well as your
footing would double what a break costs.

It needs its own field rather than folding into `rooted`, for the reason that
runs through this whole spec: `rooted` is a commitment this body made and can
call off, and a stagger is something done to it. `GameClient` publishes it as
`selfStaggered` on the view, beside `selfRoot` and computed through the sim's
own `staggered`, so a screen cannot come to a different answer than the server
about whether a button should ask.

Without this the order asked sixty times a second through every break: **146
refusals in one measured fight**, all `'staggered'`. That is precisely the storm
`pending` exists to prevent and for the same reason — the answer cannot change
until the window ends, so nothing is learned by asking again before it does.

### What is *not* predicted, and why that is the honest answer

The onset of a stagger cannot be predicted. Spec 067's `selfRoot` works because
the client knows it pressed the button; nobody knows they are about to be hit.
So for up to one round trip a staggered client keeps sending movement the server
discards, and the correction pulls it back.

That cost is accepted rather than designed around, and it is bounded three ways.
It is one round trip, not a continuous divergence — which is the distinction
spec 147 drew when it deleted `flowMovePct`: a *multiplier* on movement diverges
on every tick it is held, where a discrete replicated state diverges once, at a
moment both ends agree on. It happens at the instant of a landed blow, which is
already the loudest moment on screen (spec 145's chunk, spec 146's kick), so a
correction there is masked by feedback the player is already reading. And the
client stops it as soon as it sees the replicated `Stunned`: `GameClient` zeroes
its own movement intent while staggered, so the divergence is the round trip and
never longer.

### The reaction is derived, not announced (`src/render/`)

`poiseBroken` stays off the wire and no new field is added. `activity` is
already replicated for every entity, and `UnitFacts` already carries it — so
entry into `Stunned` is an edge the client can see for itself. This follows the
rule spec 158 states for the loot pop: **whether to react at all is derived
rather than announced**, so every observer reacts to the same fight with no
message carrying it, and a reconnecting client is never told about a stagger
that finished before it arrived.

Two channels, because they fail differently:

1. **`unit-driver.ts` raises a `stagger` trigger** on the edge into `Stunned`,
   edge-detected against `previous` exactly as `attack`/`shoot` already are. A
   unitdef that never declared the state falls back to raising nothing, which is
   the same fallback `triggerFor` already applies to `shoot` — no unit in the
   tree has an authored stagger clip today, so on its own this channel is
   currently silent.
2. **`stagger-flinch.ts`**, a new pure module beside `health-bar.ts`: a decaying
   oscillation, driven by the drawn tick, that knocks the *body* off its heading
   for the length of the break. This is the channel that needs no authored
   content, so it is the one that actually ships a visible stagger. It is the
   same vocabulary spec 146 gave the health bar's kick, and deliberately so —
   the two play on the same blow and a second easing shape would read as two
   unrelated events.

Time is an argument in both, and the argument is the drawn tick the bodies are
already interpolated by — never a second clock.

## Invariants tested

**The sim (Node, through the real `world.step()`, not by calling helpers):**

- A body broken by a real blow does not move on the following tick, given a
  movement input it would otherwise have honoured. Position identical.
- That body's *facing* is also unchanged, given an input carrying a new facing.
- `startCast` refuses with `'staggered'` for the whole window, for a basic
  attack and for an ability, with resource and cooldown both ample.
- The refusal is spent-nothing: resource, cooldowns and flask charges are
  identical across it.
- The window is exactly `staggerTicks` long: the last refused tick is
  `breakTick + staggerTicks - 1`, and the body moves and casts again on
  `breakTick + staggerTicks`. Asserted from both sides, as `attack-cancel.test.ts`
  does for the withdrawal boundary.
- A staggered body cannot end its own stagger early by casting — the hole gate 2
  closes, asserted directly.
- A staggered *monster* neither walks nor swings, so the gate is on the body and
  not on the input path.
- `STAGGER_IMMUNE_TICKS` still holds: a body inside the immunity window is not
  re-broken, so the root cannot be chained past 2s by a second attacker.
- Determinism: same seed, same inputs, identical state, with a stagger in the
  sequence.
- **A refused swing is still answered.** A staggered body that asks for a cast
  produces a `castRejected` event carrying `'staggered'` — the regression that
  the null-intent version silently failed, and the one worth pinning because its
  symptom was a client hang rather than a wrong number.

**The prediction:**

- `asEntity` reports the replicated activity, and `decideCast` on a staggered
  mirror refuses with `'staggered'` — the client and the server give the same
  answer about the same body.
- `autoAttack` asks for nothing while `staggered`, and keeps its mark.
- `moveIntent` asks for no movement **and no turn** while staggered, and that
  branch outranks a held key, a wind-up aim, a standing attack mark and a move
  order — each asserted separately, because each is a different branch that
  would otherwise supply a heading.
- `castOrder` neither chases nor casts while staggered, keeps its order, and
  still drops one whose mark has died.
- Over a real loopback session: a client told it is staggered predicts **no**
  movement for the window, ends it in the same place the server has it, walks
  again once the window passes, and earns `'staggered'` for a cast it asks for
  inside it. The movement case is checked to be load-bearing — with the client
  root disabled it predicts 19.3 units the server discards.

**The mark (pure, headless):**

- Drawn for a stunned body inside its window and for nothing else, including a
  body first seen mid-break — the opposite of the flinch's rule, and the point
  of it being stateless.
- Not drawn for a window that has already passed, so a stale delta cannot leave
  a swirl over a body that is free again.
- Turns one way throughout, and completes at least one full rotation inside the
  shortest stagger there is — under that it reads as a tilted glyph rather than
  a spinning one.
- Full strength on the frame it appears; thins into the end over a fixed number
  of ticks, identical for a long window and a short one.
- A pure function of its three arguments, and finite for anything off a hostile
  wire.
- Over a real loopback session against something that fights back, **every**
  refusal the loop earns is `'staggered'` and there are fewer of them than there
  are commits. Any other reason appearing there is the mirror going stale.

**The render half (pure, headless):**

- `driveUnit` raises `stagger` exactly once on the edge into `Stunned`, not on
  each tick of the window.
- A unitdef with no `stagger` parameter raises nothing and does not throw.
- The flinch is a pure function of the drawn tick: same tick, same offset; it
  decays to exactly zero by the end of the window; and it restarts on a *second*
  break rather than merging, because a break is a contact and every one of them
  is a new event (spec 146's rule for the kick, and the opposite of the chunk's).
- `presentation-only.test.ts` extends to cover it: the same seed and inputs with
  the animation layer driven and not driven produce identical authoritative
  state, with a stagger in the sequence.

### The mark (`src/render/iso3d/world/stun-icon.ts`, `icons.ts`, `hud.ts`)

The flinch draws the *contact* -- a couple of tenths of a second of rocking --
and then the body stands unnaturally still for the rest of the window with
nothing saying why. A swirl over the head says the state, for as long as the
state lasts.

```ts
export function stunMark(
  activity: number,
  activityUntilTick: number,
  drawnTick: number,
): StunMark;   // { visible, spin, opacity }
```

**Stateless, and that is the whole difference from the flinch.** A flinch is a
contact: it must be started by an edge somebody watched, so it keeps a
per-entity track and refuses to fire for a body that walked into view already
broken. A swirl is a state: a body that is stunned right now is stunned whether
or not this client saw the blow, and the honest thing to draw for one that
arrived mid-break is the swirl. So there is no map, no `retain`, and nothing to
leak -- and every observer of one fight draws the same angle on the same tick,
because the phase is measured off the replicated `activityUntilTick` rather than
off an observed start.

It fades over a fixed **count** of ticks rather than a fraction of the window,
because a fraction needs the window's length and this function is given only its
end. That turns out to be the better rule anyway: the tail reads the same for a
30-tick stagger and a 48-tick one. There is no fade *in*, for the reason the
flinch starts at full throw -- a mark that ramps up reads as unrelated to the
hit that caused it.

`hud.ts` owns the element, the division `health-bar.ts` already keeps. It goes
in the existing per-body holder above the name, so it rides the body with no
second projection and is pruned by the same `live` set, and it is drawn in the
cast bar's amber rather than the guard's blue: both ambers mean "committed to
something it cannot get out of", where the blue marks the bar that ran out.

## What the first cut of this spec missed

An audit of the client after the gates landed found two holes. Both are the same
mistake -- `autoAttack` was taught about the stagger and its neighbours were not.

**The drawn heading kept turning.** `moveIntent` had no notion of a stagger, so a
player holding a key, or with a standing attack target, kept asking for a
heading while the server pinned `steered.facing` and turned the body not at all.
That is worse than a mispredicted step, because a `Correction` carries a
position and **no facing at all** -- a predicted step is pulled back within a
round trip, where a predicted turn is an error nothing ever corrects. The
stagger branch is now first in `moveIntent`, ahead of the wind-up aim and ahead
of a held key, since the key is the one branch a player is actively driving.

**A standing cast order acted straight through the window.** `CastOrderInput`
had only `rooted`, which is "a cast is in progress" -- and a break *clears* the
cast it interrupted, so `rooted` is false for the whole stagger. The order
chased, and in reach it sent a `useAbility` the server answered `'staggered'`,
then dropped itself as though it had been spent. It now holds, and keeps the
order, for the same reason the attack order keeps its mark.

## What landing this measured, and the number to decide about

The gate turns a flag into a cost, and the cost is now measurable. Driven
through a real loopback session against a pack of stalkers, a starting character
spends **21% of the fight staggered** — 1178 ticks in 5392 — across about 38
separate breaks.

That is not a bug and it is very close to the bound spec 147 chose on purpose:
`staggerTicks` is 31 ticks against a `STAGGER_IMMUNE_TICKS` of 120, so 25% is
the most any number of attackers can hold a body, and the measurement sits just
under it. The immunity window is doing exactly the job 147 built it for.

Two things about the shape of it are worth having written down before anybody
tunes it, because both are the kind of fact that gets rediscovered as a
complaint:

- **It is a pack mechanic, not a duel mechanic.** One stalker applies 10.6 poise
  a second to a 55-point pool regenerating 5.75, which is a break every eleven
  seconds — barely a mechanic. Three apply it three times over and hit the
  immunity floor. Poise pressure adds linearly across attackers while the
  window that bounds it is a constant, so stagger goes from irrelevant at 1v1 to
  a hard ceiling at 3v1 with nothing in between.
- **The player breaks monsters far less often than the reverse.** In the same
  measured fight the monsters were staggered *zero* times. The arithmetic allows
  it — 12.5 per blow into a 20-point pool regenerating 6 is a break in three
  consecutive landed swings — but "three consecutive" is the problem: a break
  nulls the caster's wind-up, so a player being broken every two seconds rarely
  strings three swings together, while the monsters have no such trouble.

None of that is retuned here, deliberately: this spec's job is to make the
window mean something, and a balance pass wants the mechanic live or it is
measuring the old nothing. But the asymmetry is the first thing `npm run
balance` should be pointed at now, and `monsterPoiseRegen`, `minPoise` and
`STAGGER_IMMUNE_TICKS` are the three dials that shape it.

## Out of scope

- **Any change to the poise numbers.** `staggerPower`, `staggerTicks`,
  `maxPoise`, the regen and the 2s immunity are spec 147's and are not retuned
  here. This spec makes the existing window mean something; what it should cost
  is a balance pass with `npm run balance` behind it, and that pass wants this
  landed first or it is measuring the old nothing.
- **A stagger clip.** Channel 1 above is the wiring; authoring a `stagger` state
  for the pig is a unit-authoring change in the register of spec 143.
- **A stagger VFX cue.** Unauthored cues are silence by design (spec 158), and
  adding a name without an effect would only look like the feature was finished.
- **Diminishing returns on repeated breaks.** The 2s immunity is the whole
  anti-chain mechanism and this spec does not add a second one.
- **Interrupting a *channelled* ability.** Nothing in the table channels; the
  break already nulls `cast`.
- **Telling the player why the button refused.** `'staggered'` joins the
  rejection type and reaches the existing refusal log path unchanged; wording
  and presentation are `error-log.ts`'s and are not touched.
