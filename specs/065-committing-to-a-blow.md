# 065 — Committing to a blow

## Problem

Five gaps found by playing spec 064. Four are combat; one is that you cannot
read the numbers.

1. **Monsters cannot path.** `src/sim/pathfinding.ts` survived every deletion —
   A* on a nav grid, string-pulled, with `navGridFor` cached per world and body
   radius — and nothing in `src/server/` has ever imported it. `monsterIntent`
   steers by straight-line homing, so a monster walks into a tree and slides
   along it until the player happens to come back into the open.

2. **A blow lands before the body has turned to face it.** `startCast` captures
   the aim, spends the cost and starts the wind-up clock in the same tick, so
   the wind-up runs while the body is still rotating. Turning is now rate-limited
   (spec 064) and that made the gap visible: commit facing north, and the swing
   resolves south on schedule, from a body still halfway round. Turning to face
   what you are about to hit is a combat mechanic, not an animation.

3. **Knockback and hitstop.** Displacement on hit, and a 1–12 tick freeze scaled
   by the fraction of health removed. Both are server-only and unpredicted, which
   makes every hit taken a correction — they were the main source of the drift
   that showed up once a monster was actually landing blows. Out, for now.

4. **Cooldowns are invisible.** `entity.cooldowns` is server state that appears
   nowhere on the wire. The client cannot know an ability is unavailable until it
   asks and is refused, so a hotbar button cannot show what it is doing.

5. **Damage numbers are system text.** They are drawn in the browser's monospace
   UI font over a deliberately posterized, low-resolution world. Nothing else on
   screen looks like that.

## Shape

### Turning is part of the cast

A new phase, before the wind-up:

```ts
const CastPhase = { Turning: 3, Windup: 0, Channel: 1, Recovery: 2 };
```

Committing still captures the aim and spends the cost — a cast you have paid for
and are turning into is a cast you have committed to, and cancelling still
refunds everything, because `refundable` is `tick < releaseTick` and that is
still true. What changes is that `releaseTick` and `endTick` are **provisional**
while turning, and are re-stamped from the tick alignment is reached:

```
commit ──turning──▶ aligned ──windup──▶ release ──recovery/channel──▶ end
       ^ cost spent          ^ releaseTick set here
```

The server emits a fresh `CastState` on the transition so the client's bar is
never drawn against a release tick that has since moved.

Alignment is `|shortestTurn(facing, aimAngle)| <= TURN_ALIGN_EPS`. Exact in
practice: the caster is rooted, so the aim angle is constant, and `turnToward`
lands exactly on its target on the last tick of the turn.

A monster commits through the same path, so this is not a player rule.

### Pathfinding, in the monster's intent

`ServerEntity` gains path state, and it is plain data on an immutable entity like
everything else, so a replay reproduces the same route:

```ts
readonly path: readonly Vec2[] | null;
readonly pathIndex: number;
readonly repathAtTick: number;
```

`monsterIntent` asks for a direction the way it always did; what changes is where
the direction comes from. When `segmentClear` says the line to the target is
open, it steers straight — the common case, and free. Otherwise it follows
waypoints from `findPath`, replanning every `PATH_REPLAN_TICKS` or when the
target has moved far enough from the goal the path was planned to.

Grid cost is not a concern and was measured before designing around it: 10ms to
build the 20k-cell grid once per world and radius, ~1.2ms per search.

### Knockback and hitstop come out

Out of the sim (`knockbackX/Y`, `knockbackUntilTick`, `hitstopUntilTick` on the
entity, and the decay in `resolveMovement`), out of `combat.ts`, out of the stats
table (`knockbackResist` buys nothing once nothing is displaced), and **out of
the wire** — `CombatResultMessage` carries `hitstopTicks`, `knockbackX`,
`knockbackY` and `knockbackTicks` today, and `StatsMessage` carries
`knockbackResist`. `PROTOCOL_VERSION` goes to 3.

One thing deliberately kept: **a hit still interrupts a cast**. That is a
separate mechanic that merely happened to be keyed on `hitstopTicks > 0`. It
keeps working, on its own terms.

### Cooldowns on the wire

A new server message, sent to the owning connection whenever their cooldown map
changes — which is cheap to detect, because entities are immutable and the map
object is only rebuilt when it actually changes:

```ts
interface CooldownsMessage {
  type: ServerMessageType.Cooldowns;
  entries: readonly { abilityId: string; readyAtTick: number }[];
}
```

The client stores it and the HUD draws the remaining fraction as a sweep. The
client computes `readyAtTick - tick`; it never computes a cooldown's *length*,
which stays a server fact read from the ability table.

### A pixel font, as data

No font may be fetched and none is vendored, so the glyphs are a table:

```ts
// src/render/iso3d/world/pixel-font.ts -- pure, no DOM
const GLYPHS: Record<string, readonly string[]>;   // 5x7, one string per row
function glyphRects(text: string): readonly Rect[];
function pixelTextSvg(text: string, opts): string; // one <path>, crisp edges
```

Digits, `+`, `-` and `!`. Rendered as an SVG path of lit pixels with a hard
outline, which is scalable, crisp at any size, and the same blocky register as
the world behind it.

## Invariants tested

- **A cast waits for the turn.** A caster facing away from its aim stays in
  `Turning` until aligned, then winds up for the ability's full `windupTicks`
  from that moment; a caster already aligned never enters `Turning` at all. A
  slow body takes longer to land the same blow than a fast one.
- **Cancelling during the turn refunds everything**, cost and cooldown, exactly
  as cancelling during the wind-up does.
- **A path goes round.** With a wall between monster and player, the returned
  waypoints avoid it, every leg is walkable, and following them closes the
  distance — where straight-line homing stalls against the wall.
- **A clear line costs nothing**: an unobstructed target yields a straight steer
  and no search.
- **Nothing is displaced.** A hit changes health and nothing else about where the
  target is; no entity, message or stat mentions knockback or hitstop.
- **A hit still interrupts a cast.**
- **Cooldowns replicate**: after a cast the owner is told its ready tick, after a
  cancel it is told the cooldown is gone, and the numbers match the server's.
- **Every glyph is 5x7** and every character the HUD can emit has one.

## Out of scope

- **Pathfinding for the player's move order.** Right-click still steers straight
  and slides. Monsters first; the player's own orders are a follow-up.
- **Flow fields or crowd steering.** One path per monster, replanned on a timer.
- **Reintroducing displacement later.** When it comes back it will need to be
  predicted, not merely sent.
- **Retuning any ability.** The turn phase changes when a blow lands, not what
  it does; no number in `data/abilities.ts` moves.
