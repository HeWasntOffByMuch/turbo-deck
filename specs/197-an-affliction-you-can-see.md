# 197 — An affliction you can see

## Problem

Spec 190 gave the game seven afflictions. Spec 186 draws a thirteen-pixel glyph
over the head of a body carrying one. Between them, **from the neck down a
burning body and a poisoned body are identical** — the only thing separating
four seconds of fire from ten seconds of rot is which icon sits in a row of
icons above the health bar.

That is the wrong place for the information, because it is the wrong shape of
information. Every other damage in this game arrives *at* a body and is over:
`blow.ts` resolves it, `vfx-wire.ts` throws paint at the contact point, and the
picture and the number land on the same frame. An affliction is the one thing
here that **stays on the body after the thing that did it has walked away** —
which is exactly what a mark on the body would say and what a glyph in a legend
cannot.

Three sockets in the tree have been waiting for precisely this work, each with a
comment naming it:

- `world/auras.ts` (spec 121) — *"no status is replicated … the day a status
  list is replicated, `aurasFor` gains a branch and nothing else in the renderer
  changes."* Spec 186 replicated the status list. `aurasFor` and `AuraTracker`
  have no caller anywhere outside their own test file: seventy-five specs of
  written, tested, mounted-nowhere code.
- `EmitterShape`'s `{ kind: 'mesh' }` (spec 118) — *"the surface of whatever the
  effect is attached to … which is what makes a **burning-unit** definition safe
  to preview in isolation."* There is no burning-unit definition, and
  `scene.ts` passes no `surface` hook, so in the game that shape has never once
  resolved to anything but a point.
- `scene.ts`'s `attach` hook (spec 121) — *"The effects that need a socket — **a
  burning unit**, a weapon trail — arrive with the fire and slash work."*

And the painted vocabulary (specs 158–162) has three builders, all of them
*events*: `bloodHit`, `brushExplosion`, `brushCross`. Nothing in it holds to a
body, and nothing in it lasts longer than a second and a bit.

## Shape

### 1. `brushAffliction` — paint that clings (`vfx/brush.ts`)

A fourth builder beside the three, and a builder rather than a `bloodHit` with
the numbers turned down: a hit is a burst thrown outward and over in thirty
ticks, and a hit that never stops bursting is a body standing inside a
permanent spatter. Three layers, deliberately one fewer than the hit's:

```ts
export interface BrushAfflictionParams {
  readonly id: string;
  /** Roughly the body this clings to, in world units. Every length derives from it. */
  readonly scale: number;
  /** Marks held ON the body, per second. The layer that says "stained". */
  readonly cling?: number;
  /** Marks leaving it, per second. The layer that says which affliction. */
  readonly shed?: number;
  /** Where the shed goes: +1 rises (burn), -1 falls (poison, corrosion, decay). */
  readonly rise?: number;
  /** How far a shed mark wanders. What separates a creep from a crackle. */
  readonly turbulence?: number;
  /** Ticks a cling mark lives. Short: paint that is being renewed, not accumulating. */
  readonly clingLifeTicks?: readonly [number, number];
  readonly shedLifeTicks?: readonly [number, number];
  readonly severity?: number;            // 1 = light, 2 = heavy. Count, never alpha.
  readonly bright: PaletteKey;
  readonly mid: PaletteKey;
  readonly deep: PaletteKey;
  readonly priority?: Priority;
}
export function brushAffliction(params: BrushAfflictionParams): EffectDefinition;
```

- **(a) the cling** — `shape: { kind: 'mesh' }`, `emission: { kind: 'rate' }`,
  `mesh: { shape: 'brush-blot' }`, near-zero speed, `strokeDecay: 'fizzle'`, and
  **`worldSpace: false`**. Held to the body, renewed continuously, each mark
  short-lived. This is the layer that reads at a glance.
- **(b) the shed** — `brush-dab` and `brush-flick` born on the same surface and
  leaving it along `rise`. Direction is information in this vocabulary and
  up/down is the cheapest direction there is: fire goes up, rot goes down.
- The effect is `durationTicks: 0` — it burns until stopped — and takes the
  **soft** stop, not `hardStop`: a cling mark lives about half a second, so
  letting the last few dry is what an affliction ending should look like. The
  aura's `hardStop` argument was a single particle held for ten minutes, which
  is not this.

Four things about the vocabulary decide the rest, and each is a fact about
`meshes.ts` rather than a preference:

**`worldSpace: false` is the whole of "it clings".** The compiled default is
`true` (`compile.ts:284`), and attaching an effect to an entity moves only the
*emission origin* — a mark born on a walking body and left in world space is a
mark the body walks out of. The cling and the shed both ride; only the pulse,
which is a flick thrown off the body, is left behind.

**The shape choice is the orientation choice.** `orientOf` gives `brush-blot`
`tumble` (world space, which is where this vocabulary's sense of depth comes
from), `brush-dab` `velocity`, and `brush-slash`/`brush-flick` `cardVelocity` —
camera-facing, so they always read. A stain on a body wants to turn with the
body, so the cling is a blot; the pulse has to read from any angle, so it is a
slash. `brush-mark` is `ground` — flat in XZ — and is therefore the one brush
shape that cannot go on a body at all.

**`fizzle`, not `retract`, for anything held long enough to be watched.** Spec
161 states the rule and spec 159 states why: a retract walks an eroding
threshold from the mark's own root and pulls the spine after it, which played
slowly is the brush retracing its path backwards — the stroke being *un-painted*
rather than anything thinning away. The cling fizzles. The pulse, over in a few
ticks, retracts like every other flick in the file.

**`blend: 'alpha'`, and nothing additive below the flash.** Paint is opaque, and
two translucent marks crossing make a third colour in neither of them. (The
header of `brush.ts` still says `dither-cutout` "almost throughout"; spec 159
deleted the mesh shader's Bayer discard and every emitter in the file has been
`alpha` since, bar the explosion's four-tick additive flash. The comment is
stale and this spec does not inherit it.)

`priority: 1` and a modest `cullDistance`, because a cling holds an instance
slot for its whole life against a budget of 128: an affliction on a body across
the arena is the first thing that should yield, and the fight in front of you is
the last.

### 2. The pulse is a beat, and it is derived rather than sent

`WireStatus` carries an **absolute** `expiresAtTick`, `dotDurationTicks(row)` is
shared code, and `intervalTicks` is on the row. So

```
elapsed  = tick - (expiresAtTick - dotDurationTicks(row))
pulse k lands when elapsed === k * intervalTicks,  k >= 1
```

is a pure function of one replicated record and the tick being drawn — the same
rule `loot-drop.ts`'s reveal phase and `stun-icon.ts`'s swirl already are. Every
client beats together, nothing new crosses the wire, and **the paint lands on
the frame the damage number does**. Burn licks every half second, Shock cracks
every three quarters of a second, on the tick the jolt actually resolves.

That splits the feature exactly along the line `auras.ts` already draws — *"a
hit happens; a poison lasts"*:

| | what it is | how it is driven | state it needs |
|---|---|---|---|
| the cling | a **state** | started once, stopped once, via a tracker | none per frame |
| the pulse | an **event** | `play`ed one-shot on the tick it lands | the last pulse index fired |

The pulse needing an edge and the cling not is the same division
`stagger-flinch.ts` (a contact, needs an edge somebody watched) and
`stun-icon.ts` (a state, stateless) already keep, and it is why the pulse memory
is honest rather than a smell.

A refresh moves `expiresAtTick` and does not move the sim's `appliedAtTick`, so
after one the derived phase can sit up to `intervalTicks - 1` off the real one.
The **cadence stays exact** — same interval, same rate — and the offset is
sub-half-second on every row. Stated because it is a real limit, and accepted
rather than fixed with a protocol change: putting `appliedAtTick` on the wire
buys a frame of alignment nobody can see.

### 3. Two severities, not five

`WireStatus.stacks` rides. Poison at five stacks and Poison at one must not look
alike, because getting to five *is* Poison. But the count is already drawn — the
mark over the head carries it (spec 186) — so what the paint owes is
**severity**, and two tiers is the honest resolution at 300 pixels tall.

More paint, never brighter paint: severity scales the mark **count**, because
brightness is what a pulse already says, and one signal meaning two things is a
legend nobody can read. The tier crosses at half of `maxStacks`, and it is a
different id (`affliction_poison` / `affliction_poison_heavy`), so the tracker's
own diff does the swap for free and nothing new is needed to change severity
mid-fight.

Frostbite has `maxStacks: 1` and ramps instead — `rampPerSecond: 0.35` to
`rampCap: 3`, *"harmless for a moment, dangerous if you let it stay on"*. Its
tier is decided by **elapsed** rather than by stacks, from the same derivation
the beat uses. Same rule, one input different.

### 4. The `surface` hook, finally supplied (`world/scene.ts`)

```ts
surface: (entityId, rng, out, at) => boolean
```

A point on the body's own volume, sampled from the footprint radius and the
headroom the health bar already hangs off — not from the mesh. A capsule is what
a painted mark clinging to a body needs at this resolution, and reading vertices
would put a skinning cost on every spawned particle. `Body` gains a `radius`
alongside its `headroom`, written from the same `appearanceOf(entity)` the hover
volume is already built from.

With no attachment the shape degrades to `point`, which is what the type
promised and what keeps a definition previewable in isolation.

### 5. `world/affliction-vfx.ts` — the decision, pure

```ts
export interface AfflictionFacts {
  readonly statuses: readonly WireStatus[];
  readonly tick: number;
}
/** The cling ids that should be live on this body now, in a fixed order. */
export function afflictionVfxFor(facts: AfflictionFacts): readonly string[];
/** The one-shot ids whose beat lands on this tick, and the pulse index of each. */
export function afflictionPulses(facts: AfflictionFacts): readonly AfflictionPulse[];
```

Pure — no three.js, no DOM, no `GameClient` — and lint-guarded as such, the
discipline `auras.ts`, `vfx-wire.ts` and `unit-driver.ts` all keep. A stale
entry is refused on read by the same `tick >= expiresAtTick` comparison
`statusOf` and `statusMarks` make, so correctness does not depend on the delta
saying "it fell off" having arrived. Order is fixed by wire index, for the
reason `AURA_ORDER` is fixed.

The impure half is `AfflictionVfxDriver`, which owns
`Map<entityId, Map<effectId, handle>>` and is the only thing here that touches
the system. It does the diff itself rather than through `AuraTracker`, and the
reason is specific: **`play` returns `0` on refusal** — unknown id, over budget,
or beyond `cullDistance` — and `AuraTracker` has no way to say "wanted, asked
for, did not start". Committing a refused id would leave a body silently
unmarked for the rest of its life, which is the worse of the two failures by a
distance. Holding handles instead makes a refusal simply mean "not started yet",
so a body that walks into range gets its paint on the frame it does.

The other half of owning the handles is the obligation that comes with them: on
despawn **nothing stops itself**. The attach hook answers false, the instance
stays where it last resolved, and a persistent effect hangs in the air forever.
The driver is therefore called from the despawn sweep in `syncBodies` as well as
from the per-entity loop, and `forget(entityId)` stops everything that body
still owns. Nothing in the game has ever held a persistent attached effect
before, so this establishes the pattern rather than following one.

`aurasFor` is deliberately **not** wired. Its rings are spec 124's drawn-sigil
direction, and rings plus paint would be two answers to one question; the rest
of what it decides (selected, channelling, telegraphing) is a separate mount and
not this spec's business.

### 6. The palette gains two

Five of the seven already have their ramp: Burn (`fireCore`/`fireBody`/
`fireDeep`), Poison (`poisonPale`/`poisonDeep`/`poisonMurk`), Shock
(`boltWhite`/`boltYellow`/`boltViolet`), Frostbite (`iceWhite`/`icePale`/
`iceDeep`), Bleed (`bloodBright`/`bloodFresh`/`bloodInk`). Two do not, and both
need to be *unmistakable against the neighbour they would otherwise be read as*:

- **Corrosion** — an acid yellow-green that is not Poison's leaf green, since
  the two would otherwise be the same affliction in two intensities.
- **Decay** — a sick olive-violet rot that is not Corrosion's acid and not
  Poison's green.

Six new keys (a bright/mid/deep for each). The cap is against **invented**
colour and these are the damage-type language `docs/vfx-plan.md` §6 already
writes down, the same argument spec 185 made when the three tier colours moved
into the palette.

Authored bright, for the reason the file states at length: the particle shaders
write `gl_FragColor` themselves with no encode on the way out, so a colour is
displayed roughly as its own **linear** value and a dark one lands near black.

### 7. Seeing it

- `npx tsx scripts/preview-afflictions-vfx.ts` — a contact sheet through the
  real `brush-scene.html` (full resolution, MSAA, no palette), one row per
  affliction, columns across the life, plus a stacked/heavy row. It reports the
  same four measured numbers `preview-brush-vfx.ts` already computes — **isolated
  ink** (stipple), **largest connected mass**, **variation between seeds**, and
  ink area — because "crisp" is a measurable property in this vocabulary and not
  an opinion.
- `admin:triggerEvent 'affliction'` — one **named** affliction on every body in
  reach, `magnitude` as the ordinal into `ALL_DOTS`, in the same register as
  `'drop'`, whose `magnitude` is already a tier ordinal. The existing `'status'`
  trigger puts all seven on at once, which is right for reading the icon row and
  useless for looking at one effect.

## Invariants tested

- `brushAffliction` returns an effect with `durationTicks: 0`, no `hardStop`, and
  every emitter `blend: 'alpha'` — the painted vocabulary's opacity rule.
- Every id `afflictionVfxFor` and `afflictionPulses` can return exists in the
  compiled registry. A stub table is exactly where a typo survives.
- `afflictionVfxFor` is a pure function of its arguments: same facts, same list,
  in wire order, whatever order the statuses arrive in.
- A status whose `expiresAtTick` has passed contributes nothing, without any
  pruning having happened.
- A status with no affliction row (every boon, and `adapted`) contributes
  nothing — absent is the default, the rule `visualFor` already keeps.
- The derived beat agrees with the sim: for a fresh application, the pulse ticks
  `afflictionPulses` reports are exactly the ticks
  `sim/damage-over-time.ts` fires on. Asserted against the real resolver, not
  against a restatement of its arithmetic.
- Exactly one pulse per beat: driving the driver at 1, 2 and 3 ticks a frame
  over a whole affliction produces `row.pulses` pulses in every case, and none
  after the window.
- Severity: below half `maxStacks` is the light id and at or above it the heavy
  one; Frostbite crosses on elapsed rather than on stacks.
- `AfflictionVfx` starts each cling once and stops it once across an apply /
  refresh / expire cycle; a severity change is exactly one stop and one play; a
  **refused** play is retried rather than believed; and `forget` stops everything
  a despawning body still owns.
- `sampleCapsuleSurface` lands **on** the capsule for every draw at every
  height, area-weights the caps against the side so a tall body is stained
  evenly rather than given a hat and boots, degenerates to a sphere for a body
  shorter than it is wide, and writes only the three floats it was given room
  for -- the second half of that scratch buffer is the spawn direction.
- The measured crispness holds: isolated ink well under a tenth (a dithered fill
  is about half), the mass in a handful of pieces, and every heavy tier
  measurably more ink than its light one -- "more paint, never brighter paint"
  as a number rather than as a claim.
- `presentation-only.test.ts` gains the affliction driver: the same seed and
  inputs twice, once with it driven and once without, identical authoritative
  state.

## Out of scope

- **No new protocol.** `appliedAtTick` does not go on the wire; the derived beat
  and its stated post-refresh offset are the answer.
- **The aura rings stay unmounted.** See §5.
- **No stains.** An affliction does not write to `DecalField`; what a burning
  body leaves on the ground is a separate question and a separate budget.
- **No sound.** Cues are names emitted into a sink and nothing plays them yet;
  an unauthored cue is silence, deliberately.
- **Nothing for the boons.** Flow, Momentum, Prepared, Attuned, Exposed,
  Vulnerable, Sundered and Adapted keep their head-marks. Seven afflictions is
  the coherent set — they share a mechanic, a cadence and a resolver — and a
  boon's picture is a different argument.
