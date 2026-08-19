# 184 — A number for what the kill was worth

## Problem

A blow says what it took off a body. Nothing says what the body was worth.

Experience reaches the client as a whole `Stats` message — a level and an
experience count, replacing whatever was there before — and the only thing that
reads it is the strip along the bottom of the frame (spec 164). The strip is
correct and it is six pixels tall at the far edge of the screen, so the reward
for a kill is a fill that grew slightly somewhere nobody was looking. Every
other consequence of a blow already floats off the body it happened to.

Two smaller things fall out of drawing it:

**Where it goes must not be where the damage went.** The killing blow's number
is spawned on the same tick, on the same body, from the same anchor. Spec 096's
lanes fan a *burst* of damage out so three hits read as three numbers, but they
are one cycle over one field — an experience number taking the next lane would
land on top of the blow that earned it.

The first cut answered that by sweeping the reward out to the side on an
ease-out. It separated the pair perfectly and looked wrong: nothing else in this
game leaves a body at 45 degrees, and reading the pair meant tracking two marks
going different ways. So the reward is **stacked under the blow, in the blow's
own lane, rising at the blow's own rate** — one column, nothing to follow — and
earns its moment by *outliving* the number above it instead.

**The gold is taken.** The strip is gold on black, and so is a cast that can
still be called off. Experience is the one thing on screen a player is
accumulating rather than spending or losing, and it now has two places it is
shown; giving it a colour of its own costs nothing and makes the floating number
and the strip the same fact.

## Shape

`world/xp-gain.ts` — new, pure. Experience arrives as a *total*, so a gain is a
difference, and a level-up moves the count backwards:

```ts
/** Every point earned to reach this exact standing. Monotonic across level-ups. */
export function cumulativeExperience(level: number, experience: number): number;

export class XpGains {
  /**
   * The amount gained since the last observation, or 0.
   *
   * The first observation only establishes the baseline: a client that reported
   * a gain on connect would throw a session's worth of experience at somebody
   * who has just logged in. A backwards move (an admin reset, a respec) reports
   * nothing and re-baselines, because a negative reward is not a thing.
   */
  observe(level: number, experience: number): number;
}
```

`world/damage-popup.ts` — the field learns a second trail. The trail is a
property of one popup rather than of the field, so both kinds share the
capacity, the projection and the expiry that spec 096 already got right:

```ts
/** Which path a number takes. `damage` is spec 096's, unchanged. */
export type PopupTrail = 'damage' | 'xp';

add(group: number, at: WorldAnchor, trail?: PopupTrail): { id, expired }
```

`damage` is a lane off the cycle and a linear rise over `NUMBER_LIFE`. `xp` is
the same line, `XP_GAP` lower and `XP_EXTRA_LIFE` longer. Four choices in that,
each of which is the fix for the version without it:

- **The blow's lane, not a lane of its own.** The two are one reading — what the
  hit took off and what the body was worth — so they belong in one column. A
  reward with no damage before it takes the centre lane, where a lone number
  belongs anyway.
- **The blow's rate, not its own.** `XP_RISE` is derived, not authored:
  `NUMBER_RISE * XP_LIFE / NUMBER_LIFE`. A rate of its own would have the two
  converge or separate, which is the diagonal's problem in another direction.
- **Half a second longer** (`XP_EXTRA_LIFE`, 30 frames at 60fps). A blow's
  number is one of a burst and gets out of the way; the reward is the last thing
  to happen to that body, and outliving the blow is what gives it a moment on
  its own.
- **It reads the lane counter without consuming one**, so a kill's reward cannot
  shift where the next blow on that body draws its number. Successive rewards on
  one group step down through `XP_STACK` gaps rather than piling up.

`hud.ts` — one palette for the two places experience is shown, replacing
`XP_GOLD`/`XP_GOLD_LIT`/`XP_EMPTY`:

```ts
const XP_PURPLE = '#a878e8';       // the number's fill and the strip's fill
const XP_PURPLE_LIT = '#d3b6ff';   // the strip's inset highlight
const XP_PURPLE_DARK = '#200d36';  // the number's outline and the strip's ground
```

and a second entry beside `addDamage`:

```ts
/** `amount` experience was earned, at the world point `at` (spec 184). */
addExperience(group: number, at: WorldAnchor, amount: number): void;
```

`world/view.ts` — the join, and it is a join because the two halves arrive in
different messages with nothing linking them. A kill by the local player
remembers the anchor the damage number was already given; the frame that sees
the experience total move spends it there. No kill on record — an admin grant, a
quest — puts the number over the player's own body, which is the only other
place it could honestly go.

## Invariants tested

`xp-gain.test.ts`

- The first observation reports 0 whatever it is handed.
- A rise in experience at the same level reports the difference.
- A level-up reports the real gain: crossing from `(1, cost-5)` to `(2, 3)`
  reports 8, not −(cost−8).
- Several levels in one observation still report the sum.
- A backwards move reports 0, and the next real gain is measured from the new
  standing rather than from the old one.
- Non-finite and negative inputs report 0 and never throw.

`damage-popup.test.ts` (added to)

- For every frame the blow is alive, the reward is in its column (same `left`)
  and exactly `XP_GAP` below it. Not "separated" — *stationary* relative to it.
- The reward takes whichever lane the body's last blow took, for lanes 1, 2 and
  3, and the centre lane when nothing hit the body first.
- It outlives the blow, is still climbing every frame after the blow has gone,
  and expires `XP_EXTRA_LIFE` frames later.
- A whole `NUMBER_LIFE` of its own life climbs exactly `NUMBER_RISE`: the rate is
  shared, and the extra distance is only the extra time.
- Two rewards on one group step down by `XP_GAP`, and the stack starts over at
  `XP_STACK` rather than walking off the bottom of the world.
- An xp number does not consume a damage lane: a blow, a reward and a second
  blow puts the second blow in lane 1.
- Both kinds count against the one capacity and expire through the one path.
- Spec 096's own numbers are unchanged — a blow still rises `NUMBER_RISE / 2` at
  half its life with a reward beside it.

`scripts/probe-xp-popup.ts` — the half that only exists in a browser, over the
`hud-probe.html` rig spec 164 built, because the way this feature fails is "the
field changed and nothing was drawn":

- The reward has an element, and it is the count alone: measured as a width,
  because the page draws paths and not text, and `24` is 26px where the `+24 XP`
  this replaced was 70.
- Its fill and its outline are the purple palette, read out of the SVG rather
  than out of the constant — a number that reached the DOM in the damage colours
  fails here.
- The strip's computed background is the same purple, so the two ends agree.
- Sampled across the climb, the reward holds the blow's column to within 2px
  and stays a fixed distance under it — the drift over the whole sample is the
  measurement, not the separation.
- Past `NUMBER_LIFE` the blow's element is gone, the reward's is not, and it is
  still higher on the next sample. Then it goes too.

## Out of scope

- Any new message on the wire. Experience is already replicated; this reads it.
- Attributing a gain to the *right* kill when two die in one tick. The client is
  told a total, not a ledger, so the second kill's number lands on the first's
  body. Both are within a body's width of each other in practice and inventing
  a per-kill message to fix a tie is not worth a protocol change.
- The strip's shape, its subdivisions, its hover line and its height. Only the
  three colours move.
- A sound. Cues are names emitted into a sink (spec 158) and nobody has authored
  one for this.
