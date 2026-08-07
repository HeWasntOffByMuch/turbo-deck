# 087 — Arrows, shuriken, and a shot slow enough to watch

*Renumbered twice while this branch waited -- from 081 when the player became a
cow, and from 083 when the map learned to grow. Its siblings moved with it: the
attack delay is 088 and the arc is 089.*

## Problem

Spec 079 gave the game two ranged basic attacks, and shots that travel, track
and can be outrun. What it never gave them is a *body*. Every projectile in the
world — the hunting arrow, the throwing star, the firepot, the arcane bolt —
draws as the same pale icosahedron in `PALETTE.magicCore`, sized only by its
ability's `projectile.radius`. A bow and a handful of stars are the same picture
in flight, so the one thing a travelling shot exists to buy — you can see it
coming, and you can move — reads as a dot that arrives.

Two things sit behind that:

1. **There is no per-projectile look anywhere.** `appearanceOf` reaches into the
   ability table for a radius and stops; `bodyFor` builds one icosahedron for
   every `rig: 'projectile'`. Nothing in the codebase can say "this one is an
   arrow".
2. **A shot is over before it can be looked at.** `ranged.star` crosses its
   whole 300-unit range in 16 ticks — a quarter of a second, three frames at
   60Hz once interpolation has smoothed it. A distinctive silhouette that exists
   for three frames is a blur, and dodging one is reflex rather than reading.

And one thing the tuning has never had: **a shot's speed is a table constant.**
Which weapon loosed it decides *which row is read* (spec 079's `basicAttackId`),
but nothing about the shooter changes how fast the thing flies. The Weighted
Stars say `attackSpeedPct: 0.2` and throw exactly as fast as a bow does.

## Shape

### 1. A projectile has a look

One optional field on the spec that already describes the flight, defaulting to
what every projectile draws as today:

```ts
// data/abilities.ts
export type ProjectileLook = 'orb' | 'arrow' | 'shuriken';

export interface ProjectileSpec {
  readonly speed: number;
  readonly arcHeight: number;
  readonly radius: number;
  readonly lifetimeTicks: number;
  /** What it draws as. Absent is an orb -- the look every shot had before. */
  readonly look?: ProjectileLook;
}
```

`ranged.shot` is an `arrow`, `ranged.star` a `shuriken`; `bolt.arcane`,
`bolt.lob` and `bolt.seek` stay orbs, because a thrown weapon and a conjured one
should not read the same and the bolts are the conjured ones.

**Nothing goes on the wire.** A projectile entity's `typeId` is already its
ability id, and `data/abilities.ts` is shared code the client imports — so the
look is a lookup the client does, not a field the server sends.
`PROTOCOL_VERSION` stays at 9.

`Appearance` carries it through, and stays total the way it already promises to
be — an ability id this build has never heard of gets an orb rather than
throwing halfway through a frame:

```ts
// render/iso3d/world/appearance.ts
export interface Appearance {
  readonly rig: RigKind;
  readonly typeId: string;
  readonly radius: number;
  readonly showsHealth: boolean;
  /** How a shot draws, or null for a body that is not one. */
  readonly look: ProjectileLook | null;
}
```

The silhouettes themselves are pure, in `render/iso3d/world/projectile-shape.ts`
— the same call `lobe.ts` makes for the canopy tree, and for the same reason:
the outline *is* the species, so it is checked in Node rather than by eye.

```ts
export interface ArrowProfile {
  readonly shaftLength: number; readonly shaftRadius: number;
  readonly headLength: number;  readonly headRadius: number;
  readonly fletchLength: number; readonly fletchSpan: number;
  /** Distance from the arrow's centre back to the nock, so the mesh centres on
   *  the entity the sim moves rather than on its own nose. */
  readonly centreOffset: number;
}
/** Every dimension derived from the shot's radius, so a bigger arrow is the
 *  same arrow bigger rather than a differently proportioned one. */
export function arrowProfile(radius: number): ArrowProfile;

/** `2 * points` vertices, alternating outer and inner, closed. */
export function shurikenOutline(radius: number, points?: number): readonly Vec2[];
```

`scene.ts` is the three.js half: an arrow built along `+x` (the convention
`bodyFor` already draws to, since the group is yawed by `-facing` and the sim
re-stamps a shot's facing to its flight direction every tick) which additionally
**pitches to its climb**, so a lobbed arrow noses over at the top of its arc; and
a shuriken lying flat, **spinning about its own axis** at a fixed rate. Both are
frame-rate-driven visuals with no reading back into the sim.

### 2. The shuriken leaves a trace

A pure ring buffer plus the strip built from it, in
`render/iso3d/world/trail.ts`:

```ts
export interface TrailSample { readonly x: number; readonly y: number; readonly z: number }

export interface TrailRibbon {
  /** Flat `x,y,z` triples, two per sample: left edge then right edge. */
  readonly positions: readonly number[];
  /** One per vertex, 1 at the head falling to 0 at the tail. */
  readonly alphas: readonly number[];
  /** Triangle indices over the strip; empty below two samples. */
  readonly indices: readonly number[];
}

export class Trail {
  constructor(capacity: number, minSpacing: number);
  /** Ignored if it has not moved `minSpacing` from the current head. */
  push(sample: TrailSample): void;
  clear(): void;
  /** Newest first. Never longer than `capacity`. */
  get samples(): readonly TrailSample[];
  ribbon(halfWidth: number, lift: number): TrailRibbon;
}
```

`minSpacing` is what makes the trace a property of *distance flown* rather than
of frame rate: a machine drawing at 144Hz and one drawing at 30Hz lay down the
same streak behind the same shot. The width tapers with the alpha, so the tail
narrows into nothing instead of ending in a cut edge.

The strip is built flat in the ground plane, offset perpendicular to each
segment, and lifted by a small render-only constant — a flat shot flies at
exactly terrain height (`arcHeightAt(progress, 0)` is 0), so a streak laid at its
own z would z-fight the ground it is skimming.

### 3. Slower, and the weapon decides

Two changes to one number, both in `player/stats.ts` beside
`attackIntervalTicks` — the existing precedent for "a stat the table's number is
run through":

```ts
/**
 * Every shot flies at this fraction of its table speed. A deliberate global
 * knob, not a per-row retune: one line to move when the flight has been
 * watched enough to know what it should be.
 */
export const PROJECTILE_SPEED_SCALE = 0.3;

/** World units per second, for a shot this body looses. */
export function projectileSpeedFor(baseSpeed: number, stats: EffectiveStats): number;

/** Ticks before that shot expires, so its *reach* is what the table says. */
export function projectileLifetimeTicks(spec: ProjectileSpec, stats: EffectiveStats): number;
```

`projectileSpeedFor` is `baseSpeed * clamp(attackSpeed) * PROJECTILE_SPEED_SCALE`,
clamped by the same `MIN_ATTACK_SPEED`/`MAX_ATTACK_SPEED` that
`attackIntervalTicks` uses — one stat, one clamp, whichever end of the weapon it
is read from. `attackSpeed` is *the* weapon speed stat here: it is what
`attackSpeedPct` on the Keen Longsword and the Weighted Stars feeds, so tying a
shot to it means the fast weapon both swings and looses fast, and the Iron
Maul's `-0.2` reads as heft in both halves of what it does.

**Reach is preserved, and that is not a nicety.** A projectile's reach in world
units is `speed / 60 * lifetimeTicks`. Cut the speed to 30% and leave the ticks
alone, and `bolt.arcane` expires at 372 units of its 700-unit range, `bolt.lob`
at 360 of 520 — two abilities that can no longer reach what `startCast` will
happily let you aim at. That is not a speed change, it is a silent range nerf.
So `lifetimeTicks` is read as the distance it describes at the table's speed:

```ts
lifetime = round(spec.lifetimeTicks * spec.speed / projectileSpeedFor(spec.speed, stats))
```

Every existing row keeps the exact reach it has today, for every shooter. The
only thing that moves is how long the flight takes — which is the whole point.
`launchProjectile` already has `caster` in scope, so both calls land there.

## Invariants tested

- **Every projectile ability keeps its reach.** For every row in the table with
  a `projectile`, the launched `speed * (expiresAtTick - tick)` equals the
  table's `speed / 60 * lifetimeTicks` (to within a tick's rounding) — for a
  slow shooter, a fast one, and a default one alike.
- **Every projectile ability can still reach its own range**: that reach is
  `>= ability.range` for every row, which is the assertion that would have
  caught the naive speed cut.
- **A shot flies at 30% of its table speed** for a body whose `attackSpeed` is
  1, and `PROJECTILE_SPEED_SCALE` is the only place that fraction is written.
- **The weapon decides.** A caster with a higher `attackSpeed` looses a
  proportionally faster shot and a proportionally shorter-lived one; the same
  shot from a slower caster arrives strictly later, and both arrive.
- **The stat is clamped at both ends**, so a pathological `attackSpeed` (0,
  negative, `Infinity`, `NaN`) can neither freeze a shot in the air nor teleport
  it, and `expiresAtTick` is always a finite tick in the future.
- **A slower shot is still a shot**: driven through the real tick, a hunting
  arrow and a thrown star each still cross the gap and kill a grazer, and a
  tracked shot still lands later on a target that ran.
- **Determinism survives**: the same seed and inputs replay to bit-identical
  state and events with the new speeds — the scale is a constant, not a reading
  of anything ambient.
- `appearanceOf` returns `look: 'arrow'` for `ranged.shot`, `'shuriken'` for
  `ranged.star`, `'orb'` for the three bolts, `'orb'` for an ability id that
  does not exist, and `null` for a player, a monster and a prop.
- **The silhouettes are the shapes they claim to be**: `shurikenOutline` returns
  `2 * points` finite vertices alternating strictly outer/inner radius, centred
  on the origin and rotationally even; `arrowProfile` puts the head in front of
  the shaft and the fletching behind it, every dimension positive and finite,
  and scales linearly with the radius it was given.
- **The trace is a distance, not a frame rate**: pushes closer together than
  `minSpacing` are dropped, so the same flight lays down the same samples
  whatever the frame rate; the buffer never exceeds `capacity`; the oldest
  sample is the one dropped.
- **The ribbon is well-formed**: two vertices per sample, one alpha per vertex,
  alpha strictly decreasing head to tail from 1, indices addressing only
  existing vertices, every number finite — including for a trail holding zero,
  one, and two samples, and for one whose samples repeat a position.

## Out of scope

- **A `projectileSpeedPct` modifier of its own.** A shot reads the weapon speed
  stat that already exists. A second stat that only ranged weapons carry is a
  thing to add when a weapon wants to be slow to swing and fast to loose, and
  nothing in the table does yet.
- **Retuning anything else.** No damage, range, wind-up, cooldown or
  `arcHeight` moves. `PROJECTILE_SPEED_SCALE` is explicitly a temporary global.
- **Predicting a projectile client-side.** Still spec 079's rule: a shot is a
  replicated entity drawn from the deltas.
- **Where a flat shot flies relative to the ground.** A star skims terrain
  height because `arcHeight` is 0; the trace is lifted clear of it, and the
  question of whether a thrown weapon should fly at chest height is a tuning
  question for the arc, not for this.
- **Trails on anything else.** The arrow and the orbs leave nothing. A general
  streak for every fast-moving thing is a different feature with a different
  budget.
- **Making the look mechanical.** `look` is a picture, exactly as `arcHeight`
  became one in spec 079. Nothing in `src/server/sim/` reads it.
- **New projectile abilities or weapons.** The arrow and the shuriken are the
  two shots spec 079 already added; this gives them a shape, not a sibling.
