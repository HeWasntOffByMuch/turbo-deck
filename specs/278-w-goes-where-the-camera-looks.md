# 278 — W goes where the camera looks

## Problem

`W` walks north. Not up the screen — **north**, the sim's `-y`, whatever the
camera happens to be pointing at.

That was defensible for exactly as long as the camera was fixed. It has not
been since spec 129, which gave the player `[` and `]` and made turning the view
the answer to "there is a rock in the way", and spec 140, which put the same
turn on a two-finger swipe. So today a player can put the camera anywhere on a
full turn around their own body, and the four movement keys keep pointing at the
compass:

| camera azimuth | what `W` does on screen |
|---|---|
| 45° (the default) | up and to the **right** |
| 135° | up and to the **left** |
| 225° | **down** and to the left |
| 315° | **down** and to the right |

At the opening framing `W` is already 45° off the screen's own up, which is the
version everybody has learned to live with. Turn the camera half a turn — which
is one press of `]` held for two seconds — and `W` walks toward the viewer while
`S` walks away. There is no reading of that a hand can be trained on, because
the mapping is a function of a slider the player is also holding.

Nothing else in this client has that problem, and the reason is that everything
else is aimed with the cursor: a right-click order, an aim, an attack mark are
all points in the world that the player picked *off the screen*, so they are
camera-relative by construction. The keys are the one control expressed in world
axes, and they are the one control that stopped meaning anything.

## Shape

**One rotation, at the one place the keys become a vector.** No new message, no
server change, no protocol version: the client already sends a world-space unit
vector and the server has never known where the camera is. What moves is which
world direction the keys resolve to before that vector is built — so prediction,
the replay after a correction, and what the server acts on are all the same
rotated vector, and none of them can disagree.

### The basis

```ts
// src/render/iso3d/world/intent.ts
export interface IntentInput {
  /** The unit vector `move.north` walks along, or absent for true north. */
  readonly moveBasis?: Point | null;
  // ...unchanged
}
```

`keyDirection` sums `MOVE_ACTIONS` exactly as it does today and then rotates the
result into that basis:

```
f = basis                     // unit, "up the screen"
r = (-f.y, f.x)               // "screen right", derived rather than authored
walk = k.x * r - k.y * f
```

A **vector, not an angle**, and that is the whole of why there is no
trigonometry in this change: the camera's offset is already a pair of
components, so an angle would be an `atan2` on the way in and a `cos`/`sin` on
the way out for a quantity neither end wants in radians. `r` is derived from `f`
rather than passed alongside it, so the two cannot come apart — a basis and a
right vector authored separately are a reflection waiting for whoever edits one.

Absent reads as `(0, -1)`, which makes the rotation the identity **exactly**
(every term is a multiplication by 0 or 1), so the two sandboxes, the bots and
every existing test behave byte for byte as they did.

### Where the basis comes from

```ts
// src/render/iso3d/view-settings.ts — pure, no three.js
export function groundForward(offset: Vec3): { x: number; z: number };

// src/render/iso3d/world/scene.ts
viewBasis(): { x: number; y: number };   // that, in the sim's axes
```

`groundForward` is the camera's bearing flattened onto the ground plane — the
normalised `-offset` with its height thrown away — and it is a function in
`view-settings.ts` rather than two expressions because **it already existed
twice over**: `listenerPose` computes exactly this for the audio listener and
spends four lines saying why, and this is the same question asked by the legs.
Two files deriving it separately agree until one is edited.

**It is read from the drawn camera (`camOffsetCurrent`), never from the control's
target azimuth**, and that is the load-bearing decision rather than a detail.
`applyControls` eases the offset toward the panel's angle at `CAMERA_SMOOTH` a
frame, so the bearing the player is *looking* along lags the one the slider
holds. Steered by the target, a flicked two-finger swipe would re-aim the walk
instantly and leave the picture to catch up — the body veering off toward a
bearing that is not on screen yet. Steered by the drawn offset, the walk turns
with the view, at the view's own rate, because it **is** the view's rate: there
is no easing in this change at all, and there must not be a second one.

The two ways a player turns the camera are already continuous in different
places, which is what makes reading the drawn offset cover both. Holding `[`
or `]` moves the *target* continuously (`ORBIT_DEG_PER_SECOND`, a quarter turn
a second), and a swipe moves it in one jump (`ORBIT_DEG_PER_PX`) with the lerp
doing the smoothing. Nothing here needs to know which happened.

### What the player is told

The four action **ids** do not move — `move.north` is what a stored profile
references, and spec 189 is explicit that a renamed id is a binding silently
discarded. The four **labels** do:

    Move north  ->  Move forward
    Move south  ->  Move back
    Move west   ->  Move left
    Move east   ->  Move right

`bindings.json`'s `version` does not move either, because a label is not
persisted: `migrateBindings` reads overrides keyed by id, and an older build
handed this file reads the same four bindings under the same four names.

### The observable

`data-move-basis` on the root element: the world bearing `move.north` currently
walks along, in degrees, **published from the vector actually handed to
`moveIntent`** rather than recomputed at publish time — the rule
`data-props` and `data-held-weapons` already follow, and for their reason. A
basis that was computed and reached nothing reads as absent.

Beside `data-camera-orbit`, which is the *target* azimuth off the slider, it is
also the measurement of the easing: the two disagree during a swing by exactly
the lag and converge after it, which is a fact about the frame rather than about
this file's bookkeeping and is the only way to see the ease at all on a
container that paints five frames a second.

## Invariants tested

`view-settings.test.ts`:

- `groundForward` is the normalised, flattened, negated offset: unit length, no
  height in it, and the bearing is the azimuth turned half a turn.
- A camera straight overhead has no bearing, and falls back rather than dividing
  by zero.

`intent.test.ts`:

- **No basis is north**, exactly: `W` is `(0, -1)` and `D` is `(1, 0)` with no
  float slack, so every existing caller is unchanged.
- A basis rotates the cardinals: with the camera looking east, `W` walks east,
  `D` walks south, `S` walks west, `A` walks north.
- It **rotates and never reflects**: `A` is a quarter turn anticlockwise from
  `W` at every basis, so the handedness cannot be inverted by a sign.
- The diagonal stays unit length under any basis, so `W+D` is still not a
  sprint.
- Opposed keys still cancel to an **exact** `(0, 0)`, not to a rotated zero.
- The body faces where it walks: `facing` is the bearing of the rotated vector.
- A degenerate basis — zero length, or a non-finite component — falls back to
  north rather than emitting a NaN the server would have to defend against.
- The basis reaches the keys and nothing else: a move order, a route, a cast
  aim, a drop aim and a target aim are world points and are untouched by it.

`scene.ts` (through `view-settings.test.ts` and the probe):

- `viewBasis` and `listenerPose` answer the same bearing, because they are one
  function.

`scripts/probe-camera-relative.ts` — the half no headless test can reach, since
every rule above is green in Node beside a `view.ts` that passes no basis at
all:

- Holding `W` on the shipped build walks the body along `data-move-basis`.
- Turning the camera a quarter turn turns the walked bearing by the same
  quarter turn, measured off `data-self-at` rather than off the attribute that
  claims it.
- `data-move-basis` trails `data-camera-orbit` during a swing and converges on
  it after — the ease, measured rather than asserted.

## Out of scope

- **The two sandboxes.** `src/render/iso3d/movement.ts` and `debug-view.ts` have
  their own mover and their own camera, and they are workbenches for tuning a
  gait rather than something anybody plays. They keep world-axis keys.
- **Rebinding the camera turn.** `[` and `]` are still hard-coded key codes
  rather than actions (spec 129 said "rebindable later"), and that is a row in
  `bindings.json` and a `POINTER_CODES`-shaped decision of its own.
- **A camera-relative *facing*.** A body still faces where it walks and aims
  where the cursor is; nothing about cursor aiming changes, because it was
  camera-relative already.
- **Snapping the camera behind the body**, or any coupling in the other
  direction. The camera follows the body's position and never its heading, and
  that stays true.
