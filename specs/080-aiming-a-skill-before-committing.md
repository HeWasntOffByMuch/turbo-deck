# 080 — Aiming a skill before committing to it

## Problem

A hotbar press is a commitment made blind. `view.ts`'s `useAbility` reads
whatever ground point the cursor happens to be over at the instant the key goes
down, drops the standing move order and the attack target, and sends the cast.
The body then turns and winds up — at that point, and in that direction, whether
or not anything is there.

Three things follow from that, and all three are wrong:

1. **There is no way to say what you meant.** A blast with a 140-unit radius is
   placed by where the mouse was mid-motion. A cone is aimed at a pixel. Nothing
   is drawn before the commitment, so the first time you see the shape of the
   blow is the tick it lands.
2. **Range is a refusal rather than a walk.** `startCast` refuses a
   point-targeted cast beyond its range (`outOfRange`), so using a skill on
   something across the field means walking there by hand first and pressing the
   key again. The right-click attack order has closed that gap since spec 070 —
   it chases and then swings — and skills never got the same treatment.
3. **A press cannot be taken back.** The commitment starts on key-down. `Esc`
   withdraws from the wind-up (spec 062) and a move order does too since spec
   079, but both of those are withdrawing from something already begun. There is
   no step between deciding to look and deciding to throw.

This spec puts a step there. A hotbar press stops being a cast and becomes an
**aim**: the shape of the blow is drawn on the ground, a left-click confirms it,
and only then does the body walk into range and commit. A right-click calls the
whole thing off without moving, attacking or spending anything — because
nothing has been asked for yet.

## Shape

### The gesture is a property of the ability

`AbilityTargeting` gains one member, and it is the only data change the sim
sees:

```ts
// data/abilities.ts
export type AbilityTargeting = 'direction' | 'point' | 'unit' | 'self';
```

One field, not two. The aim gesture a skill asks for is a total function of it,
because the thing you have to supply and the thing the blow resolves against are
the same thing:

| `targeting` | Gesture | Resolves against |
|---|---|---|
| `'self'` | none — casts on the press, as today | the caster |
| `'unit'` | left-click a body | that body and nothing else |
| `'point'` | left-click the ground | the point, range-gated |
| `'direction'` | left-click the ground | the cone/line from the caster |

`'unit'` is the one genuinely new rule in the sim, and it is small, because
spec 070 and spec 079 already built everything under it: a cast carrying
`targetEntityId` is already single-target for melee, already tracked for a
projectile, and already gated at `range + targetRadius`. `'unit'` is that
behaviour made mandatory rather than incidental.

```ts
// sim/abilities.ts
export type CastRejection = /* ... */ | 'noTarget';
```

- The range gate that read `targeting === 'point'` now reads
  `'point' | 'unit'`.
- A `'unit'` cast arriving with `targetEntityId === 0` is refused `noTarget`
  and changes no state. The reason is a string on the wire already, so
  `PROTOCOL_VERSION` does not move.

Nothing else in `startCast`, `advanceCast`, `landAbility` or `launchProjectile`
changes: they branch on `cast.targetEntityId > 0`, which a `'unit'` cast always
satisfies and no other kind is required to.

### One row of content, so the new gesture is reachable

No existing row changes. `melee.heavy` was the obvious candidate for `'unit'`
— it is a blow you land on a thing — and converting it was tried and put back:
twenty-odd tests use it as *the* long-wind-up ability to exercise turning,
withdrawal, cost refunds and cooldowns, none of which is about targeting, and
they would all have started failing `noTarget` for reasons unrelated to what
they assert. A retune that drags the wind-up suite behind it is a retune, and
this spec does not do those.

One new row instead, so `'unit'` is exercised at a range worth walking:

| id | name | kind | targeting | range | wind-up |
|---|---|---|---|---|---|
| `bolt.seek` | Seeking Bolt | `projectile` | `unit` | 480 | 0.45s |

It tracks its mark in flight and is disjointed by its death, for free — that is
spec 079's projectile, reached by naming a body. It joins `HOTBAR` as key `5`,
which leaves every gesture on the bar: a cone (`melee.slash`, `melee.heavy`,
`channel.drain`), a lane (`bolt.arcane`), a circle (`bolt.lob`,
`ground.quake`), a body (`bolt.seek`) and nothing at all (`self.mend`).

### The aim, and the order it becomes

New pure module, `render/iso3d/world/aim.ts`, beside `intent.ts` and `target.ts`
and for the reason those give: an aim is *input*. What it produces is a per-tick
move vector and an ability request, both of which the server validates exactly
as it validates a held key and a right-click. Nothing here decides whether a
blow lands.

```ts
export type AimGesture = 'none' | 'unit' | 'ground';
export function aimGesture(ability: AbilityDefinition): AimGesture;

/** What to draw on the ground while aiming. Derived from the ability's geometry. */
export type AimShape =
  | { readonly kind: 'none' }
  | { readonly kind: 'circle'; readonly radius: number }
  | { readonly kind: 'cone'; readonly halfAngle: number; readonly length: number }
  | { readonly kind: 'line'; readonly length: number; readonly width: number };
export function aimShape(ability: AbilityDefinition): AimShape;
```

`aimShape` reads the numbers the blow is actually made of, in this order, so a
retune moves the picture with it and no third field has to agree:

- `'self'` or `'unit'` → `none`. The body is the indicator; a ring goes under it.
- `arcCosSq` → `cone`, half-angle `acos(sqrt(arcCosSq))`, length `range`.
- `radius` → `circle` of that radius, at the aimed point. Covers a ground blast
  and a lobbed pot that bursts alike.
- `projectile` → `line` of length `range` and width `2 * projectile.radius` —
  the straight shot, drawn as the lane it flies down.

The confirmed aim is an order, and one tick of it is decided the same way one
tick of an attack order is:

```ts
export interface AimOrder {
  readonly abilityId: string;
  /** The body named, or 0 for an order placed on the ground. */
  readonly targetEntityId: number;
  /** Where it was placed. For a unit order, re-read from the body each tick. */
  readonly x: number;
  readonly y: number;
  readonly range: number;
}

export interface CastOrderInput {
  readonly self: Point;
  readonly order: AimOrder | null;
  /** The named body as the view last saw it, or null when it is gone. */
  readonly target: TargetSnapshot | null;
  readonly rooted: boolean;
  readonly readyAtTick: number;
  readonly tick: number;
}

export interface CastOrderStep {
  readonly chaseTo: Point | null;
  /** The request to send this tick, or null. Sending it consumes the order. */
  readonly cast: {
    readonly abilityId: string;
    readonly x: number;
    readonly y: number;
    readonly targetEntityId: number;
  } | null;
  /** The order is spent or its mark is gone: the view should forget it. */
  readonly drop: boolean;
}

export function castOrder(input: CastOrderInput): CastOrderStep;
```

The rules are `autoAttack`'s, and it imports `STANDOFF_FRACTION` and
`HOLD_FRACTION` from `target.ts` rather than restating them — there is one
standoff, and the reasoning in that file for why there have to be two numbers
applies here unchanged.

- No order, nothing.
- A unit order whose mark is dead or despawned: `drop`. Nothing to walk to.
- `rooted`: hold. A committed body neither walks nor re-commits (spec 079).
- Out past `reach * HOLD_FRACTION` — where `reach` is `range` plus the mark's
  radius, and `0` for a point — chase to the standoff and ask for nothing.
- In reach and off cooldown: `cast`, and `drop`. **One confirm is one cast**,
  not a cadence. That is the difference between this and an attack order, and
  it is the whole difference.
- In reach and still on cooldown: hold the order. It waits on the cooldown the
  same way it waits on the range, which is the only answer that does not need a
  second rule for "you pressed it a quarter-second early".

### The clicks

| Input | Aim pending | No aim pending |
|---|---|---|
| `1`..`8`, hotbar button | replaces the aim | starts one (or casts, for `'self'`) |
| Left-click a unit | confirms a `'unit'` aim | nothing, as today |
| Left-click the ground | confirms a `'ground'` aim; a `'unit'` aim ignores it and stays live | nothing |
| Right-click | **cancels the aim, and nothing else** | drops a standing order, then target / move order as before |
| `Esc` | cancels the aim | cancels a wind-up, forgets the target |
| `W`/`A`/`S`/`D` | walks, aim survives | walks, drops orders |

Two of those rows are the ones worth being deliberate about.

**Right-click while aiming does not fall through.** It cancels and returns; it
does not become a move order or an attack order on whatever was under it. The
button that means "no" cannot also mean "and go there instead" — and it is the
only reading under which cancelling is free.

That is about a *pending* aim. A right-click over an order that is already
walking is an ordinary change of orders: the order is dropped and the click
means what it has always meant, the way a new move order replaces an attack
target. There is nothing to protect at that point — the decision was made, and
this is the next one.

**A movement key does not drop a pending aim.** Walking while you decide where
to put a blast is the point of being allowed to decide. A *confirmed* order is
dropped by a movement key, because from then on the order is steering — it
writes `destination` every tick — and a held key already outranks a destination
in `moveIntent`; leaving both standing would be two things fighting over one
vector. Confirming an aim likewise clears the auto-attack target, for the same
reason `useAbility` clears it today: reaching for a skill is taking control
back.

### What is drawn

`FrameInfo` gains one nullable field, and the scene draws it and nothing else:

```ts
// scene.ts — FrameInfo
readonly aim: {
  readonly shape: AimShape;
  /** The caster, for a cone or a line. */
  readonly origin: Point;
  /** The aimed ground point — the cursor while aiming, the placement once ordered. */
  readonly point: Point;
  /** The body under the cursor, or the ordered mark, for a unit aim. */
  readonly unitId: number | null;
  readonly range: number;
  /** False when the placement is beyond range, so the indicator says "you will walk". */
  readonly inRange: boolean;
} | null;
```

- circle → `CircleGeometry(radius)` laid flat at `point`
- cone → `CircleGeometry(length, 28, start, sweep)` — a wedge, at `origin`,
  swept about the direction to `point`
- line → `PlaneGeometry(width, length)` laid flat, from `origin` toward `point`
- unit → no ground shape; a ring under `unitId`, in the aim's colour rather than
  the attack ring's, so "what a click would pick" and "what is being hit" are
  never the same mark

Plus a faint range ring at `origin` whenever `inRange` is false, which is the
only thing on screen that says the confirm will be a walk before it is a blow.
All of it is `MeshBasicMaterial`, `depthWrite: false`, over the ground the same
way the ground telegraph in `syncTelegraphs` already is; the meshes are built
once per shape kind and re-scaled, not rebuilt per frame.

The HUD lights the aimed slot and says what the click will do — one line,
`Aiming Quake — left-click to place, right-click to cancel` — in the notice area
that already exists.

## Invariants tested

- `aimGesture` is `none` for `'self'`, `unit` for `'unit'`, and `ground` for
  `'point'` and `'direction'`; every ability in the table has a gesture.
- `aimShape` is `none` for self and unit abilities; a cone for one with
  `arcCosSq` (half-angle recovering the table's wedge); a circle of the table's
  `radius` for a ground blast and for a bursting lob; a line of the table's
  `range` for a projectile with no radius. Every ability in the table produces a
  shape without throwing.
- `castOrder` asks for nothing with no order; chases when the placement is out
  of reach and stops chasing inside it; asks for the cast exactly once and
  drops in the same step; holds while `rooted`; holds while on cooldown and then
  casts when the cooldown passes; drops a unit order whose mark died or
  despawned.
- A unit order's reach is measured to the mark's edge (`range + radius`), and
  its chase point comes to rest inside `range` — the same property spec 079
  asserts for the attack order, against the smallest body in the game.
- A point order's chase comes to rest within `range` of the placement, so the
  cast that follows is not refused `outOfRange`.
- `castOrder` re-reads a moving mark: the chase point follows the body, and the
  request carries the body's current position rather than the position it had
  when the click landed.
- **The sim.** A `'unit'` ability cast with no `targetEntityId` is refused
  `noTarget` and changes no state — no cost spent, no cooldown stamped. One
  carrying a target beyond `range + targetRadius` is refused `outOfRange`; one
  inside it commits and launches a projectile that tracks its mark.
- Every `AbilityDefinition` with `targeting: 'unit'` has a non-zero `range`, and
  none carries `arcCosSq` — the cone is not a thing a single-target blow has.
- **Determinism** survives the new targeting: the same seed and the same input
  sequence, `'unit'` casts included, replay to bit-identical state and events.

## Out of scope

- **Server-side aiming.** The server still answers one cast request at a time
  and holds no notion of a pending aim, exactly as spec 070 left it. The aim is
  client state and the chase is client input, for the prediction reason
  `target.ts` gives.
- **A line or rectangle that damages.** The straight shot is drawn as a lane
  because that is the lane the projectile flies down; the projectile still
  resolves against the first body it overlaps (or its named mark). A
  rectangular AoE would be new geometry in `sim/combat.ts` and needs a reason
  beyond an indicator wanting to exist.
- **Queueing.** One aim at a time, one cast per confirm. A second press
  replaces the first rather than lining up behind it.
- **Smart-cast, self-cast modifiers, or a hold-to-aim key.** The gesture is the
  ability's, not the player's; there is no key that turns a placed blast into an
  instant one.
- **Retuning.** No wind-up, damage, cost or range in the existing table moves.
  `melee.heavy` loses a field that stopped describing it and gains nothing;
  `bolt.seek` exists to exercise a gesture, not to be balanced.
- **Aiming a monster's abilities.** `monsterIntent` asks for casts directly and
  is untouched — a monster has no cursor.
- **An aim that follows the terrain.** The indicator is a flat mesh lifted off
  the ground height at its centre, like every other decal in `scene.ts`. A
  decal projected onto a heightfield is its own change.
