# 168 — A stagger that stops you

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

A staggered body is handed a **null intent**, not a zeroed one:

```ts
const intent = staggered(steered, tick)
  ? null
  : rawIntent && steered.cast !== null
    ? { ...rawIntent, moveX: 0, moveY: 0 }
    : rawIntent;
```

Null rather than `{...rawIntent, moveX: 0, moveY: 0}` because a cast and a
stagger want different things from the *facing*. A caster keeps steering — spec
067 holds the aim live right up to the commit, and that is the feature. A
staggered body is not aiming at anything; `resolveFacing` falls through to
`entity.facing` on a null input, so the body holds the heading it was broken on.
A staggered monster that keeps tracking you reads as unaffected, which is the
whole thing this spec is fixing.

### Gate 2 — the hands (`src/server/sim/abilities.ts`)

A new refusal, beside the eight that exist:

```ts
export type CastRejection =
  | ...
  /** Inside a poise break's window (spec 168). */
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

**The prediction:**

- `asEntity` reports the replicated activity, and `decideCast` on a staggered
  mirror refuses with `'staggered'` — the client and the server give the same
  answer about the same body.

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
