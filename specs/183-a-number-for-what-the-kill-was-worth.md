# 183 — A number for what the kill was worth

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
be a fourth damage number in the same fan, rising at the same rate, in the same
direction. It has to be legible as a different kind of thing before it is read.

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

`damage` is a fixed lane offset and a linear rise. `xp` is a curve: it sweeps
sideways *away from the side the group's last damage number took* and rises on
an ease-out, so the two separate immediately and keep separating. Away-from
rather than a fixed side, because the whole point is the pair, and a constant
right-hand drift collides with lane 3 of every burst.

`hud.ts` — one palette for the two places experience is shown, replacing
`XP_GOLD`/`XP_GOLD_LIT`/`XP_EMPTY`:

```ts
const XP_PURPLE = '#c9a6ff';       // the number's fill and the strip's fill
const XP_PURPLE_LIT = '#efe4ff';   // the strip's inset highlight
const XP_PURPLE_DARK = '#2a1147';  // the number's outline and the strip's ground
```

and a second entry beside `addDamage`:

```ts
/** `amount` experience was earned, at the world point `at` (spec 183). */
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

- An `xp` popup and a `damage` popup on the same group, spawned on the same
  frame from the same anchor, are never at the same place on any frame of their
  lives, and the horizontal gap between them only grows.
- The xp trail drifts to the side the group's last damage lane did not take,
  for a lane on the left and for one on the right.
- The xp rise is an ease-out: more than half of it is spent in the first half of
  its life. The damage rise stays linear — spec 096's numbers are unchanged, and
  the existing tests are the assertion.
- An xp popup with no damage before it still picks a side and still leaves the
  centre lane free.
- Both kinds count against the one capacity and expire through the one path.

`hud.ts`'s wiring, via the existing `presentation-only.test.ts`

- Driving experience popups changes no authoritative state.

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
