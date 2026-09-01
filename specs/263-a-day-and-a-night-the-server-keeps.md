# 263 — A day and a night the server keeps

## Problem

There is a day/night cycle in this repo and it is not in the game. Spec 047
built the whole of it — `daynight.ts`'s sun arc, its nine-key colour ramp,
`shadow.ts`'s horizon effect, the terminator fade that makes the sun/moon
handover invisible — and wired it to a **checkbox in a tuning panel that opens
unticked**, behind `view-controls.ts`. Spec 254 then hid the tuning panels in
the shipped build. So the cycle is not merely off by default in the game people
play: it is unreachable from it, and the only lighting the world has ever had is
`FIXED_DAYLIGHT`, a permanent mid-afternoon.

Three things follow, and the third is the one that makes this a spec rather than
a default change.

1. **A clock in a panel is a per-client clock.** Every player would be at their
   own hour, so the one thing a day/night cycle is *for* in a multiplayer game
   — everyone standing in the same evening — is exactly what a panel cannot
   express. Spec 047 says so in as many words: *"the sim is never told the time.
   A day/night rule would have to put the clock in sim state stepped at 60Hz,
   which is a different spec."* This is that spec.

2. **The clock runs at one rate.** `advanceTimeOfDay` is linear in `dt`, so day
   and night are each half a cycle. Ten minutes of day and two of night is a 5:1
   split, and no single rate produces it.

3. **Nothing in the game can ask what time it is.** There is no answer to "is it
   night" reachable from `src/server/sim/`, so no mechanic can be written
   against one.

## Shape

### The world clock (`src/server/data/day-night.ts`, new)

Pure and deterministic, in the same register as `data/damage-over-time.ts`:
`src/server/data/**` is linted as part of the deterministic core, and the client
already reads content tables out of it. No `Date`, no `Math.random`, no state.

**The clock is a pure function of the server's tick.** That is the whole of
"the server drives it", and the whole of why **nothing crosses the wire**: the
client already holds `ClientView.estimatedTick`, the server's clock re-synced to
every delta with half the round trip added, so both ends compute the same hour
from the same number. It is the pattern this repo already uses for the loot
reveal's phase, the stun swirl's angle and the affliction beat (spec 215:
*"the beat is derived, not sent"*), and it means a shared cycle costs zero bytes,
zero protocol version and zero new state to persist, replicate or forget to
clear.

```ts
export const DayPhase = { Day: 0, Dusk: 1, Night: 2, Dawn: 3 } as const;
export type DayPhaseValue = (typeof DayPhase)[keyof typeof DayPhase];

export interface DayNightSegment {
  readonly phase: DayPhaseValue;
  readonly seconds: number;    // real time
  readonly fromHours: number;  // clock hours, the span this segment covers
  readonly toHours: number;
  readonly ticks: number;      // seconds * SERVER_TICK_RATE, an integer
}

export interface WorldClock {
  readonly tick: number;
  readonly cycleTick: number;       // ticks into this cycle
  readonly cycleCount: number;      // whole cycles since tick 0 -- "day 3"
  readonly phase: DayPhaseValue;
  readonly phaseProgress: number;   // 0..1 through the current segment
  readonly phaseTicksLeft: number;
  readonly hours: number;           // 0..24, what skyAt() takes
  readonly sunUp: boolean;          // above the horizon: 06:00 <= hours < 18:00
  readonly darkness: number;        // 0 by day, 1 through night
}

export function worldClockAt(tick: number): WorldClock;
export function phaseBeganAt(tick: number): DayPhaseValue | null;
export function ticksUntilPhase(tick: number, phase: DayPhaseValue): number;
export function tickForHours(hours: number): number;
```

### The cycle: four segments, each with its own rate

The mapping from real time to clock hours is **piecewise linear with a
different rate per segment**. That is what makes a 10-minute day and a
2-minute night expressible at all, and it is the only thing this spec changes
about *what the sky looks like*: `skyAt(hours)` is untouched, so the ramp spec
047 tuned, the terminator fade and the horizon shadow all still describe the
code exactly.

| Segment | Clock hours | Real seconds | Ticks | Hours/second |
|---|---|---|---|---|
| Day | 07:30 → 16:30 | **600** | 36000 | 0.0150 |
| Dusk | 16:30 → 19:48 | 45 | 2700 | 0.0733 |
| Night | 19:48 → 04:30 | **120** | 7200 | 0.0725 |
| Dawn | 04:30 → 07:30 | 45 | 2700 | 0.0667 |

24.0 clock hours, 810 real seconds, 48,600 ticks — every count an integer, so
the phase is integer arithmetic on the tick with no float drift to accumulate
over a session.

**The boundaries are `SKY_KEYS` entries, and that is the point rather than a
coincidence.** The ramp already has keys at 4.5, 7.5, 16.5 and 19.8; the
segments *are* the ramp's own structure. A segment boundary therefore always
lands on a keyframe and never in the middle of a colour transition, which is
what keeps the rate changing where the colour is not.

That property is worth stating as a number, because a piecewise-linear clock's
one hazard is a visible kink where the rate jumps. Three of the four boundaries
barely have one: dusk→night is 0.0733 → 0.0725 and night→dawn is 0.0725 →
0.0667, a few percent. The two real steps are dawn→day (4.4× slower) and
day→dusk (4.9× faster), and both sit where the ramp is flattest — 07:30 and
16:30 are the ends of the long, nearly-constant daylight stretch, so what slows
down and speeds up is a colour that is barely moving either way.

**Day and night are authored independently, and the transitions have a budget of
their own.** 600 and 120 are exactly the ten minutes and two minutes asked for,
and moving one does not silently move the other or eat the sunrise. What it
costs is that the cycle is 13m30s rather than 12m, which is stated rather than
hidden. Measured against the horizon rather than the segment names, the sun is
actually up for 10m43s and down for 2m47s — the named phases are the flat parts,
and the transitions divide between them.

**Dawn is 45 seconds and it spans a genuine sunrise.** 04:30 → 07:30 crosses the
horizon at 06:00, so it is 22.5s of the sky going from deep night to the warm
`0xd98a63` sunrise key with the sun still down, then 22.5s of the sun climbing
into full morning. It is the same 45s as dusk. Asymmetry would need a reason and
there is not one; what makes dawn read as the payoff for a short night is that it
is 45 seconds against night's 120, not that it differs from dusk.

**Tick 0 is the first tick of Day**, which is why the table is authored starting
at Day: the cycle's own order from its own epoch, so there is no offset constant
to get wrong. A fresh server therefore opens in morning light with the full ten
minutes ahead of it, and every harness that boots a server and photographs it
inside a minute is photographing daylight. The cost is that the game no longer
opens on spec 045's tuned 15:00 framing; the trade is deliberate, because with
the clock always running that framing is now an hour the world passes through
rather than the hour it sits at.

### `darkness` — the hook that is a number

`phase` is the discrete hook and `darkness` is the continuous one: 0 through
Day, smoothstepped 0 → 1 across Dusk, 1 through Night, smoothstepped 1 → 0
across Dawn. Smoothstepped rather than linear for `horizonShadow.strength`'s
reason — anything that scales by it inherits its kink, and a rate that jumps at
a boundary is exactly what the segment table is arranged to avoid.

Deliberately **not** derived from the sky's light intensity. That is
presentation, tuned by eye and free to be retuned; this is a gameplay quantity
with a stated shape, and a mechanic reading the ramp would be a rule that moves
when somebody adjusts a colour.

There is deliberately **no `isNight`**, because it would mean two different
things — the Night *phase* (19:48–04:30) and the sun being *down*
(18:00–06:00) — and a caller would get whichever the author happened to pick.
`phase` and `sunUp` are each unambiguous and a mechanic states which it meant.

### Hooks: a function, not an event and not a field

`worldClockAt(tick)` is the whole surface, and every pass in the sim already has
the tick in hand. So there is no new `ServerWorldState` field to persist and
replicate, no `StepContext` member every test fixture would have to supply, and
no `ServerSimEvent` member with a `switch` arm in every consumer — a socket that
would sit un-plugged in each of those places. `phaseBeganAt(tick)` is the edge
for a mechanic that wants one, and it is `worldClockAt(tick).phase !==
worldClockAt(tick - 1).phase` rather than a fired event, so nothing can forget to
raise it.

`worldClockAt` memoizes its last answer on the tick. A one-entry cache keyed on
the only input is pure by construction — same tick, same object — so a pass
asking once per body pays for one computation per tick.

**No game rule reads it yet, and that is what was asked for.** The renderer's sky
is the consumer that proves the path end to end.

### The sky, and the panel as an override

`src/render/iso3d/world/sky-source.ts` (new, pure) is
`carried-light.ts`'s shape one system along, and holds its rule: **the panel wins
where it is asking for something, and the game decides where it is not.**

```ts
export interface SkySettings {
  readonly cycleOn: boolean;       // 'Day/night cycle', now ticked by default
  readonly overrideClock: boolean; // 'Override the clock', unticked by default
  readonly panelHours: number;     // the 'Time' slider
}
export function resolveSkyHours(settings: SkySettings, clock: WorldClock | null): number | null;
```

`null` means "the manual `Direction`/`Elevation` sliders own the sun", which is
what unticking `Day/night cycle` has always meant and what spec 033 built those
sliders for. Ticked and not overriding — the default, and what anybody who never
opens the panel gets — is the world clock. Ticked and overriding is spec 047's
behaviour byte for byte, including the `Run the clock` and `Day length` rows,
which is what keeps the panel useful for the thing it is for: looking at an hour
on purpose.

`FrameInfo` gains `clock: WorldClock`, computed by `view.ts` from the same
`drawnTick` the cast bars are read against and pushed in like every other frame
fact.

### `?clock=` — pinning the hour

`?clock=15`, `?clock=night`, `?clock=dawn`. In the register of `?seed=`,
`?slots=` and `?field=`, and needed rather than convenient: a sky that moves is a
sky no harness can photograph twice, and `probe-living-ground.ts` already stills
the weather clock for exactly this reason.

It resolves to a **fixed cycle tick**, so everything downstream is identical to
the running case rather than a second path. An unrecognised value **defers**
rather than picking an hour — `device.ts`'s rule, so a misspelling costs the flag
and not the frame.

It pins **what this client draws and nothing else**. The server's clock is
unmoved, which is the honest line for a shared cycle: one player cannot make it
night for everybody.

### Readout

`data-world-clock` on the HUD root, beside `data-world-lights` and `data-auras`,
published from the clock the frame actually drew with: `phase=day hours=07:42
darkness=0.00 cycle=0`.

### `scripts/preview-day-night.ts`

The instrument, and a `preview-` rather than a `probe-` because what is being
judged is a **schedule**. It prints the segment table, then walks a whole cycle
through the real `worldClockAt` and the real `skyAt`, reporting per sample the
phase, the hour, darkness, the sun's elevation and the sky's colour — and the
two acceptance numbers a table hides: the largest per-frame step in any sky
channel, and the rate ratio across each of the four boundaries.

## Invariants tested

- The segments sum to exactly 24 clock hours, 810 real seconds and 48,600 ticks,
  and every segment's tick count is an integer.
- Every segment boundary hour is a key in `daynight.ts`'s `SKY_KEYS`.
- `worldClockAt` is a pure function of the tick: the same tick gives an equal
  clock, and the memo never changes an answer.
- Day lasts exactly 600 real seconds and Night exactly 120, measured by counting
  ticks through a whole cycle rather than by reading the table back.
- The cycle repeats: `worldClockAt(t)` and `worldClockAt(t + CYCLE_TICKS)` agree
  on everything but `tick` and `cycleCount`.
- `hours` is continuous and strictly increasing (mod 24) across the whole cycle —
  in particular across every segment boundary, where the *rate* changes and the
  value must not.
- Tick 0 is the first tick of Day, at exactly 07:30.
- `worldClockAt` is total for a negative tick and for a tick far past 2^31.
- `darkness` is 0 across Day, 1 across Night, continuous at all four boundaries,
  and monotone within Dusk and Dawn.
- `sunUp` is true exactly when `6 <= hours < 18`, and therefore true for part of
  Dawn and part of Dusk — the sun is up before Day begins and after it ends.
- `phaseBeganAt` answers non-null on exactly four ticks per cycle, and on the
  first tick of each segment.
- `ticksUntilPhase` is 0 on the tick a phase begins, never negative, and never
  more than `CYCLE_TICKS`.
- `tickForHours` inverts `worldClockAt(...).hours` to within a tick, for every
  hour on a fine sweep.
- **The sky does not step.** Sampled a frame apart at 60fps across a whole cycle,
  every channel of every colour and both intensities move by far less than the
  retro pass's 12 steps per channel can resolve — including across the two
  boundaries where the rate changes by ~5×. This is the assertion that pins the
  piecewise clock, and it is spec 047's own headline test re-stated against a
  non-uniform rate.
- `resolveSkyHours` returns the world clock's hour by default, the panel's hour
  when overriding, the panel's hour when there is no clock yet, and null when the
  cycle is switched off.
- `parseClockFlag` reads an hour, each of the four phase names, and defers on
  anything else, on empty, and on a non-finite number.
- A pinned clock is a real clock: `?clock=night` resolves to a tick whose phase is
  Night.

## Out of scope

- **Any game rule that reads the clock.** The hooks are exposed and no mechanic
  consumes them, which is what was asked for. Nothing spawns, aggros, heals,
  drops or prices differently at night, and the balance harness is unmoved.
- **Anything on the wire.** No new message, no protocol version bump, no field on
  `Welcome`. The clock is derived at both ends from a tick both ends already
  have.
- **Persisting the cycle across a server restart.** The tick resets to 0, so a
  restart puts the world back at the start of a morning. Carrying it would mean
  an epoch in the database and an offset on the wire, and neither is worth it
  before there is a mechanic that would notice.
- **Setting the time from the admin console.** `admin:triggerEvent` is the
  register it would live in, and it wants a decision this spec does not need to
  take: whether an operator moving the clock moves it for everybody (an offset on
  the wire) or only for themselves (`?clock=`, which already exists).
- **World fixtures lighting at dusk.** Spec 250's campfires, lamps and torches
  burn at a constant intensity, and a lamp lit at noon is the obvious next
  consumer of `darkness`. It is a change to how the world looks that this spec
  does not need to make, and it is the first thing to reach for when a consumer
  is wanted.
- Stars, a moon disc, clouds, weather, fog, and shadows from the moon — all still
  spec 047's out-of-scope list, unchanged.
