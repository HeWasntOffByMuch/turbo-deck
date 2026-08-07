# 085 — A shot that arcs like a shot

## Problem

A lobbed shot's height is currently

```ts
// world.ts, the projectile pass
z: context.terrain.heightAt(x, y) + arcHeightAt(progress, flight.arcHeight)
```

which is wrong in two separate ways, and flat in a third.

1. **The ground under the flight moves the shot.** An arrow crossing a dip
   *dives into it* and climbs back out; one crossing a rise gets shoved upward.
   The arc is drawn relative to whatever happens to be underneath, so the same
   shot over the same distance is a different curve depending on the terrain it
   passes over — and over broken ground it is not a curve at all, it is the
   heightfield with a bump added. An arrow's path is decided when it leaves the
   bow. The ground it happens to pass over is not consulted.

2. **The arc does not know how far it is going.** `arcHeight` is a constant per
   ability, so `ranged.shot` throws its 110-unit lob at a body 40 units away
   exactly as hard as at one 420 units away. At point-blank that is a shot fired
   almost **straight up** — `tan θ = 4h/d`, so 110 over 40 units is 84 degrees —
   which reads as a mortar round, arrives via the sky, and looks like a bug
   because it is one.

3. **Nothing in it is a launch angle.** The one number a thrown thing actually
   has is the angle it left at, and there is no way to say "this weapon throws
   at up to 45 degrees" — only "this weapon's arc is 110 units tall", which
   means nothing without a distance beside it.

## Shape

### 1. The arc is the ballistic one, and the distance sets it

For a shot leaving at speed `v` under gravity `g`, range is `v²·sin(2θ)/g`,
which is maximised at **45 degrees**, giving `Rmax = v²/g`. To reach something
nearer than that, a real shooter takes the *low* solution — the shallower of the
two angles that reach it:

```
sin(2θ) = d / Rmax        θ = ½·asin(d / Rmax)
peak h  = Rmax/4 · (1 − √(1 − (d/Rmax)²))
```

That single expression is the whole feature:

| distance | | launch angle | peak |
|---|---|---|---|
| at max range | | **45°** | `Rmax / 4` |
| half max range | | 15° | `Rmax · 0.033` |
| a tenth of it | | 2.9° | `Rmax · 0.0013` |

Far things get the optimal 45; near things get a flick of the wrist; and because
`h ≈ d²/(8·Rmax)` for small `d`, the point-blank shot is *flat*, which is what
was wanted and what the constant could never give.

`Rmax` is the ability's own `range` — the farthest the cast may be aimed is by
definition the farthest it can throw, so the two numbers stop being independent.

Pure and headlessly tested, in `src/server/sim/ballistics.ts`:

```ts
/** The steepest a shot ever leaves at: the range-maximising angle. */
export const MAX_LAUNCH_ANGLE = Math.PI / 4;

/** Peak height above the launch-to-target line, for a shot of this reach. */
export function ballisticPeak(distance: number, maxRange: number, arc: number): number;

/** The angle it leaves at, in radians. `atan(4·peak/distance)`, and the reason. */
export function launchAngle(distance: number, maxRange: number, arc: number): number;

/** Height at a point in the flight: the chord, plus the parabola over it. */
export function shotHeightAt(
  progress: number, launchZ: number, targetZ: number, peak: number,
): number;
```

### 2. Per-row character is a fraction of that, not a height

`ProjectileSpec.arcHeight` (world units) becomes `arc` (0…1): **how much of the
optimal arc this weapon throws**. `1` is a true 45-degree shot at its maximum
range; `0` is flat and keeps every flat shot exactly as flat as it is now.

| id | | arc | 45° reached at | peak there |
|---|---|---|---|---|
| `ranged.shot` | Hunting Shot | 1 | 420 | 105 |
| `bolt.lob` | Firepot | 1 | 520 | 130 |
| `bolt.seek` | Seeking Bolt | 0.35 | — (max 16°) | 42 |
| `ranged.star` | Throwing Star | 0 | — | 0 |
| `bolt.arcane` | Arcane Bolt | 0 | — | 0 |

The two full-arc rows land within a few units of the constants they replace at
maximum range — `bolt.lob`'s 130 is exactly `520/4`, which is the tell that the
constant was always a 45-degree shot with the distance filed off.

The peak is **committed at launch**, from the distance at launch, and does not
change afterwards. A tracking shot (spec 079) still follows its mark
horizontally, but the arc it was loosed with is the arc it flies: a shot that
grew a taller arc because its target ran would be climbing after it had left the
bow.

### 3. The path is a chord, and the ground is not consulted

```ts
z = launchZ + (targetZ − launchZ)·progress + arcHeightAt(progress, peak)
```

Terrain is sampled at exactly two points — where the shot started and where it
is aimed — and nowhere in between. `ProjectileState` gains `originZ` (stamped at
launch); `targetZ` is re-read each tick from the terrain under the current aim,
so a tracked target running uphill is still arrived at rather than passed over.

A flat shot (`arc: 0`) is the same expression with a zero peak: it flies the
straight line from launch to target instead of following the heightfield, which
is what "flat" meant all along.

### 4. A shot leaves a hand, not a foot

Both ends move up by a constant, because a shot that starts and finishes at
ankle height cannot read as an arc however correct the curve is — and the flat
ones currently *plough the dirt*, which is why spec 083's shuriken trace needed
lifting clear of the ground it was skimming.

```ts
export const SHOT_LAUNCH_HEIGHT = 26;   // roughly the shooter's hand
export const SHOT_IMPACT_HEIGHT = 18;   // roughly where it lands on a body
```

`projectileHits` measures in the ground plane only, so this changes what a shot
looks like and nothing about what it hits — the same division of labour
`arcHeight` has had since spec 079.

## Invariants tested

- **The far shot is the 45-degree one.** `launchAngle(range, range, 1)` is
  `MAX_LAUNCH_ANGLE` to within a rounding error, and `ballisticPeak(range, range, 1)`
  is `range/4`.
- **Nearer is shallower, always.** Over a sweep of distances from 0 to `range`,
  both the angle and the peak increase strictly with distance, and neither ever
  exceeds its value at maximum range.
- **Point-blank is nearly flat**: at a tenth of maximum range the launch angle is
  under 5 degrees, where the old constant produced over 80.
- **The arc fraction scales it**: `arc: 0` is a zero peak and a zero angle at
  every distance; `arc: 0.35` is 35% of the peak of `arc: 1` at the same
  distance; and no `arc` in 0…1 ever exceeds 45 degrees.
- **Beyond maximum range is clamped** rather than producing `NaN` from a negative
  square root, and a zero or negative `maxRange`, a negative distance, `NaN` and
  `Infinity` all yield a finite peak.
- **The ground under the path is not consulted.** The decisive one: a shot flown
  over violently broken terrain and the same shot flown over flat ground —
  same launch point, same target, same everything else — produce the *same
  sequence of heights*, to the floating-point bit. Sampling the heightfield
  anywhere between the endpoints is what this makes impossible.
- **The endpoints are still met**: a shot fired uphill arrives at its target's
  height, and one fired downhill likewise; `progress` 0 gives the launch height
  and 1 gives the target height, for any peak.
- **The peak is committed at launch**: a tracked target that runs after the loose
  does not change the shot's `arcHeight`.
- **A lobbed shot still gets there.** Every existing projectile row still lands
  on a standing target at short, middling and maximum range, on the same tick as
  a flat one — the arc remains a look, and spec 079's "the arc changes nothing
  but the picture" still holds.
- **Determinism survives**: the same seed and inputs replay bit-identically, and
  the arc is a pure function of `(progress, launchZ, targetZ, peak)`.

## Out of scope

- **Making the arc mechanical.** Still spec 079's rule, and now with a stronger
  reason to keep it: the height is a two-point interpolation, so "what is the
  shot passing over" is a question this code deliberately cannot answer.
- **Terrain or prop collision for projectiles.** A shot is still stopped by a
  body or by its lifetime and by nothing else; flying *through* a hill remains
  possible and remains out of scope, as it has been since spec 079.
- **A high-angle solution.** Every shot takes the shallow root. Choosing the
  mortar arc to clear an obstacle is a real mechanic and would need the
  obstacle to exist first.
- **Air drag, or a speed that varies with the angle.** A shot's speed is still
  `PROJECTILE_SPEED_SCALE` times its row's, unchanged by spec 084; only the
  *shape* of the path is ballistic, and the travel is still at constant
  horizontal speed along it.
- **Retuning ranges, damage or lifetimes.** The only numbers that move are the
  five `arcHeight` constants becoming five `arc` fractions.
