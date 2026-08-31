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
- **Visuals.** Every hook is state; nothing here draws anything. The
  `Overheated` mark borrows the `vulnerable` glyph until one is authored.
