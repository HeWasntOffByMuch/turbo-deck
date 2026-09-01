# 259 — The Warden commits

## Problem

Every monster in this game fights the same way: close to standoff, swing,
repeat. The player's whole decision is *their own* commitment — the wind-up
they can withdraw from (spec 144), the follow-through they can walk out of
(spec 258) — and nothing on the other side of a fight ever commits to
anything the player can read and exploit. A ravager that is winding up is a
ravager that will hit you wherever you stand; there is no blow in the game you
beat by *moving somewhere else*.

The Warden is one enemy built to teach the other half of that lesson:

    lock-on -> committed laser -> reposition -> overheat -> punish -> disengage

The identity is the laser cycle and nothing else. It is not a boss with a kit.

Everything it needs already exists and three of the pieces are sockets nothing
has ever plugged into:

- `kind: 'channel'` has **no rows**. `sim/abilities.ts` has carried a complete
  channel path since spec 062 — a wind-up, an attack point, a pulse clock, an
  end — and `abilities.test.ts` records that it is "live and unreachable from
  content". A lock-on *is* a wind-up and a beam *is* a pulse train.
- `SkillArea`'s `line` shape (spec 188) is a lane with a width and a range,
  measured to a body's edge. That is a beam. No row uses it.
- `Exposed` and `Vulnerable` are the game's own vocabulary for "this body is
  open right now", and both already ride the wire and draw a mark (spec 186).

## Shape

### The tuning, in one file

```ts
// data/warden.ts -- the encounter's numbers, in `data/scaling.ts`'s register
export interface LaserCycle {
  readonly abilityId: string;
  readonly lockOnTicks: number;        // the wind-up: aiming, and readable
  readonly firingTicks: number;        // the channel
  readonly pulseIntervalTicks: number; // damage tick rate
  readonly cooldownTicks: number;      // between cycles, from the attack point
  readonly range: number;
  readonly width: number;              // the lane's full width
  readonly damage: number;             // per pulse
  readonly guardDamage: number;        // per pulse, absolute
  readonly firingTurnRateDeg: number;  // degrees per second while committed
  readonly overheatTicks: number;
  readonly overheatExposure: number;   // the `Exposed` magnitude of the window
}

export function laserCycleFor(typeId: string): LaserCycle | null;
export function cycleByAbility(abilityId: string): LaserCycle | null;

/** The four states, derived from replicated facts and readable by both ends. */
export const WardenPhase = { Normal: 0, LockOn: 1, Firing: 2, Overheated: 3 } as const;
export function wardenPhaseOf(
  cycle: LaserCycle | null,
  castAbilityId: string | null,
  castPhase: number | null,
  overheated: boolean,
): WardenPhaseValue;

/** Where the beam is, from a body's own position and heading. */
export function beamOf(cycle: LaserCycle, x: number, y: number, facing: number): Beam;
```

A table keyed by monster type id rather than a bare constant, in the register
of `FIXTURE_LIGHTS` and `SHOT_ART`: one row today, and a second laser mech is a
row rather than an edit to the sim.

### The ability

One row in `data/abilities.ts`, every number read from `WARDEN_LASER`:

```ts
{
  id: 'warden.laser',
  kind: 'channel',        // the socket: wind-up, attack point, pulse clock, end
  targeting: 'unit',      // names ONE body, and is refused without one
  windupTicks: lockOnTicks,
  channelTicks: firingTicks,
  pulseIntervalTicks,
  cooldownTicks,
  range,
  damage,
  castAngleDeg: 360,      // the lock-on *is* the turn; see below
  area: { shape: 'line', width, range },
  effects: [{ kind: 'damage' }, { kind: 'poiseDamage', amount: guardDamage }],
}
```

`landAbility`'s `channel` case gains one branch: a channel with an `area`
sweeps that area, and one without is the cone it has always been. That is the
only change to the ability system.

### The state machine

Four states, and **not one new entity field**. Each is derived from something
already replicated:

| State | Read from |
|---|---|
| `Normal` | none of the below |
| `LockOn` | `cast.abilityId === 'warden.laser'`, phase `Turning`/`Windup` |
| `Firing` | the same cast, phase `Channel` |
| `Overheated` | `StatusId.Overheated` is live |

Transitions:

- **Normal -> LockOn** — `wardenOpening` asks for the cast when the body is
  engaged, the laser is off cooldown and the target is in range. `startCast`
  is the gate; nothing else decides.
- **LockOn -> Firing** — `advanceCast`'s attack point, unchanged.
- **Firing -> Overheated** — `coolAfterBeam`, a pass driven off this tick's
  `castEnded(Released)` events in `rally`'s register. Only a *completed* beam
  overheats: a beam interrupted by a break or a death does not.
- **Overheated -> Normal** — the status expires.

### Committed aiming

`resolveFacing` already drives a casting body from `cast.targetX/targetY` and
ignores the intent's facing. So **the aim is the steering**, and the Warden's
AI owns its own laser's aim in both phases:

- **LockOn**: the aim is the target's live position. The body turns at its own
  `turnRate` (200 deg/s), which is what "tracks the target" means.
- **Firing**: the aim is the body's **own heading**, rotated toward the target
  by at most `firingTurnRateDeg / tickRate` this tick. Since that step is far
  inside `turnRate / tickRate`, `turnToward` lands on it exactly, so the aim
  the beam is measured from and the facing every client draws are the same
  angle by construction.

That is the whole commitment rule: **the beam goes where the barrel points**,
and the barrel turns twenty-five times slower once the trigger is pulled.

### Overheat

`activity: ActivityValue.Stunned` for `overheatTicks`, plus three statuses.
`Stunned` is reused rather than duplicated because it is exactly the state
mechanically — three existing readers give the whole of what section 4 asks
for and no new code gives any of it:

- the movement pass pins a staggered body's legs and its facing,
- `startCast` refuses its hands,
- `regenPoise` drops to `poiseRegenStaggered`, which is 0 for a monster.

It is applied *directly* rather than through `stagger()`, deliberately: that
function stamps `staggerImmuneUntilTick`, which would make the Warden
unbreakable during the one window the player is meant to punish it in.

The window is the existing vocabulary and nothing new:

- `StatusId.Exposed` at `overheatExposure` — every attacker's damage is
  amplified, through the multiplier `resolveBlow` already applies.
- `StatusId.Vulnerable` — the weak-point read Perception is built to use.
- `StatusId.Overheated` — one new id, and its job is to be the *state*: the AI
  reads it, and it is what a client tells an overheat from a stagger by.

### Multiplayer

`cast.targetEntityId` is the authoritative target, chosen once by `startCast`
and never re-read by anything that could move it. The AI reads **that id and
not `monster.targetId`** while a beam is live, so a second player hitting the
Warden mid-beam cannot swing it round. Everything else falls out: other
players attack normally, the beam commits to one of them, and the encounter is
identical solo.

## Invariants tested

**The cycle**

- Normal -> LockOn -> Firing -> Overheated -> Normal, in order, off the real
  tick, with the phase read through `wardenPhaseOf`.
- The lock-on lasts `lockOnTicks` and the beam `firingTicks`.

**Commitment**

- The aim tracks a moving target during lock-on, to within a tick of turning.
- Firing does **not** follow a target that runs: total rotation over a whole
  beam is bounded by `firingTurnRateDeg * firingTicks / tickRate`, and the
  measured sweep against a player sprinting laterally is far short of the
  bearing change it would need to keep up.
- `firingTurnRateDeg` is far below the body's own `turnRate` — asserted
  against the row, so retuning either cannot silently make the beam track.
- A player who steps aside after the commit stops being hit.

**The laser**

- A body inside the lane is hit; a body outside it, at the same distance, is
  not.
- A body past `range` along the beam is not hit.
- Sustained exposure lands one pulse per `pulseIntervalTicks` and no more.
- Guard pressure runs through `applyPoiseDamage`: the pool falls by the
  configured amount per pulse, and emptying it produces the game's own
  `poiseBroken` and `Stunned`, not a second stagger system.

**Overheat**

- The Warden cannot start another laser during it, and cannot for the rest of
  the cooldown after it.
- It does not move, does not swing, and regains no Guard.
- `Exposed` and `Vulnerable` are live for exactly the window, and a blow
  landed inside it does measurably more damage than the same blow outside it.
- The window ends on its own clock and the Warden fights normally after.

**Multiplayer**

- With two players in range, exactly one is named by the cast.
- A second player hitting the Warden mid-beam does not move the beam.
- The second player's own attacks resolve normally throughout.

**Anti-camping**

- The lock-on out-turns a player circling at full speed, at every distance
  from touching to the edge of its notice range. This is the measurement that
  says the rear vent in the brief is unnecessary: there is no standing position
  a player can hold that the next lock-on does not simply turn to face.

## The picture

First-pass visuals, and the whole of them is one line drawn two ways, the red
light it throws, and one effect already being sent.

**The line runs from the head's opening to just off the ground at the far end**,
and both of its ends are load-bearing. The near end is the opening because that
is the only part of this machine that turns -- `lowerBodyTurns: false`, so the
legs plant in a world-fixed frame and only the turret comes round, which makes
the eye the part of the body that tells you where the shot is going. The far end
is near the ground because the sim's lane damages everything from the muzzle
outward: a level beam at head height is a weapon that visibly passes over the
body it is hurting.

| | shape | width | opacity | what it says |
|---|---|---|---|---|
| lock-on | 23 dots, `SIGHT_SPACING` 26 apart, sliding outward | 2 raster pixels, unattenuated | 0.38 -> 0.68 as it settles | this way, and soon |
| firing, the shaft | a box along the line | 34% of the lane, 24 | 0.85 | this line, now |
| the core | a box inside it | 12% of the lane, 8 | 0.92, shimmering | it is live |

The two phases differ in **shape** and not in brightness alone, which is
deliberate: the retro pass quantizes brightness and cannot quantize a shape, so
a telegraph that differed only in opacity is a telegraph some frames do not
show. Dots against a solid shaft is the largest difference two things drawn
along the same line can have.

The sight **slides** rather than twinkling. Which dots are lit is not
information, so a travelling pattern says the machine is scanning where a random
flicker says the picture is noisy; `sightDotAt` wraps modulo the length, so the
pattern runs forever out of a fixed number of points and nothing is allocated
per frame. The count is capped at `LANCE_SIGHT_DOTS` and the surplus is parked on
the head, because a `Points` cloud rebuilt whenever a dot crosses the end is a
`Float32Array` sixty times a second for as long as somebody is being aimed at.

### Nothing is painted on the ground

There was a decal at the lane's full width under the shaft, on the argument that
the honest picture of a danger zone is the danger zone. It read as a painted
road: a hard-edged band six hundred units long over the grass, wider and more
solid than the weapon making it, and the thing an eye went to.

What replaces it is **light**. A firing beam hangs `BEAM_GLOW_LIGHTS` red point
lights along itself and the ground under it is lit rather than painted, which is
the register the rest of this game says it in -- a campfire does not draw a disc
on the floor either. They go in as ordinary `LightRequest`s beside the map's own
fixtures rather than as a pool of their own, so **the number of lights in the
scene never changes when a Warden fires**: the count is part of three's program
key, and a beam that allocated its own would recompile every material in the
scene at the moment the frame is busiest. What that costs is that a beam can be
outranked -- `assignLights` ranks on distance to the camera's focus and will not
put a held light out for one less than `swapMargin` nearer -- so firing into a
lit village square can leave the beam unlit. That is the pool's own graceful
degradation and it is one-directional: a beam may go dark, and it can never cost
a frame.

Three numbers, and two of them were got wrong first.

**`BEAM_GLOW_HEIGHT` is 145, three times the muzzle's own height**, and it is
the constant that decides whether this works. What a point light lands on flat
ground with is `brightness * (radius/2)^2 * facing / d^2`, and directly beneath
it `d` *is* the height -- so a light on the beam, at the 5 units its far end sits
at, delivers about two thousand times what it delivers a body-length away. The
first cut did exactly that and drew white holes in the grass with dark ground
between them. Lifted, the pool runs 2.3 under the beam, 1.4 a body-length off
it, 0.7 at 150 units and nothing by 300.

**`GLOW_BRIGHTNESS` is 1.4, under a campfire's 2.2**, and it was chosen against
the **retro pass** rather than by eye. `preview-lance.ts` reports how far the
light moves the ground in *colour bands*, and there are five: a wash under half a
band is one the quantize rounds away, which is the trap spec 074's streak and
spec 252's ground both fell into. Measured, 15% of the frame moves by a full
band. At 0.5 it was 2% and mostly invisible; at 3.1 the ground blew out and the
beam read as lava.

**The flicker is three incommensurate sines**, per light, with a phase of its
own. One sine is a *pulse* -- machinery idling -- and three that never line up
have no beat to hear; lit in step they are one lamp on a dimmer, and out of step
they are an unstable line. It is bounded at two thirds of the peak rather than
running to zero: a strobe over a weapon somebody is trying to walk out of takes
the ground away at the moment they most need to see it.

What this costs is worth stating plainly. A lit pool has no edge, so **the shaft
is now the only hard statement of where the beam is, and it is 34% of the lane**.
A player at the lane's rim can be hit with nothing solid drawn on them. `width`
is what the fight below was measured against, so the honest fix if that reads
badly is to bring the lane down to the shaft -- not to paint the ground again.

### The rest

`world/warden-beam.ts` is the pure half and decides all of it from the replicated
cast through `data/warden.ts`'s own `wardenPhaseOf` -- the same function the sim
asks, so what is drawn and what is happening cannot be two derivations. The
*direction* is the body's **drawn** heading and never the cast's aim: they agree
while it is firing (the sim keeps them equal and asserts it), and during the
lock-on they do not -- so drawing the barrel makes the sight sweep onto you where
drawing the aim would make it teleport.

**The sparks are `brushBeam`**, registered as `warden.laser.impact`. Nothing new
drives them: `landArea` already sends `${ability.id}.impact` at the caster's feet
with the lane's bearing, once per damage pulse, hit or miss -- so the cadence is
the sim's own damage tick. Two layers, and the builder takes **two widths**
because they belong to two different things: sparks are thrown out of the shaft's
flanks, sized against the shaft, riding the sloping line via `fromHeight`/
`toHeight` rather than sitting at one altitude; scorch marks are a flat spray of
`brush-mark` spread across the *lane*, which is the ground that damages.

That second layer carries `collision`, which is the one part that could not be
authored as a position: an offset is a point in the effect's flat frame, and six
hundred units down-range on a slope that is a mark floating over a valley -- so
it falls onto whatever the scene says the ground is.

Nothing is drawn during the lock-on but the dots. No flash, no smoke, no light
and no mass anywhere: the beam is continuous and the sparks are played eight
times over it, so anything with weight would stack eight deep over the body
standing in it.

## Tuning, measured

Not balance -- the brief asks for a first pass -- but the two numbers that were
*not* free were found by fighting rather than by arithmetic, so they are written
down with what they were measured against.

Three play styles were driven through the real tick against a level-1 character
in the starter kit (68 health, a 1-3 sword, no flask use modelled):

- **pressure** -- fight it normally, and walk out of the beam when it commits.
- **facetank** -- stand in front of it and trade.
- **rhythm** -- disengage entirely, and only attack during the overheat.

At the first cut (56 health, a 5-damage stomp) *every* style lost: pressure got
it to 9 health and died. The stomp is now **4**, which still out-trades a fresh
character's sword by about a third, and the result is:

| | outcome | time | player left | beam pulses taken |
|---|---|---|---|---|
| pressure | **wins** | 38s | 9 / 68 | 16 |
| facetank | dies | 18s | 0 | 19, and the Warden at 43% |
| rhythm | dies | 56s | 0 | 19 |

Two findings worth keeping. **The winning play is pressure, not disengagement**:
giving up the four seconds a cycle the Warden spends being an ordinary monster
costs more than the beam does, so "bait and punish" here means *stay on it and
respect the lance* rather than kiting. And **the beam is the threat, as asked**:
16 of the 19 pulses a losing player takes are most of their health bar, where
the stomp alone would be a fight they win.

Against a level-6 character with a few points spent, pressure wins in 27s with
72% of its health -- and facetank now survives with 12. That gap is the shape
section 9 asks for: the tool makes it easier, and understanding it still makes
it safer.

## Out of scope

- **The vent / backblast.** Built only if rear camping is optimal, and the
  test above says it is not: a lock-on turns 200 deg/s and a player circling
  at 155 units/s never exceeds 148 deg/s at any radius a body can stand at.
  Adding a second attack "to satisfy the specification" would be the boss kit
  the brief forbids.
- **A directional damage subsystem.** Section 5's positioning reward is the
  beam itself: in front of the Warden while it is firing is the dangerous
  place, and beside it is not. No armour facing, no rear multiplier.
- **`Sundered` from the beam.** Spec 190 records re-stamping a shared status
  once per pulse as a *bug* — Corrosion's pulses were shortening a longer
  `Sundered` somebody else had applied. A per-pulse armour strip would be that
  bug reintroduced knowingly.
- **Placing it on `maps/arena`.** Where the encounter lives is a level-design
  decision, in the same family as the visuals; the map editor's marker tool
  and the admin console's spawn both reach it today.
- **A beam in the air.** The lance is drawn on the ground, which is where the
  damage is and where every other readable indicator in this game lives. A
  raised beam mesh is a look decision with geometry behind it, and this is a
  first pass.
- **The overheat's own paint.** It has a status mark and the machine visibly
  stops; what venting *looks* like is a later pass.
