# 149 — Hitting what you saw

## Problem

Every blow in this game resolves against the server's present.
`landOnTarget` reads `target.position` as it stands this tick and misses if the
distance is over reach; `landCone` and `landBlast` do the same. On a loopback
that is exactly right. Over a wire it means a player swings at a body drawn
where it was 200ms ago and the server answers about a body that has since moved
— so the shot that visibly connected misses, and the miss is unexplainable from
the attacker's side because their screen showed the hit. Nothing in the tree
keeps a history of where anything was, so there is nothing to resolve against
but now.

## The trade, stated first

Lag compensation does not remove unfairness; it moves it. Rewinding to what the
attacker saw makes **"I hit them"** true and makes **"I was hit after I got
behind cover"** true at the same time. Both players are describing their own
screen accurately and the two screens disagree. There is no setting that makes
both false.

What a cap chooses is *whose* screen wins and by how much. This spec picks the
attacker's, bounded — because a miss on a shot you watched land is
unattributable (it looks like the game is broken), while a hit that arrives a
fraction late is legible (it looks like lag, which it is). And the bound is what
keeps the second one a fraction rather than a second.

## Assumptions

- **The wind-up is the game.** `landOnTarget`'s own comment is the rule
  everything here has to respect: "Range is measured at the *release*, not at
  the commit... a target that walked out of reach during the wind-up is a miss.
  The alternative would make the wind-up unreadable from the other side." A
  rewind of `R` ticks eats the last `R` ticks of that dodge window. That is what
  sizes the cap, not a number from another game.
- **The rewind belongs at the release, not at the commit.** The attacker
  watches the whole wind-up and sees the target move throughout, delayed. At the
  instant the blow lands they are looking at the target `R` ticks in the past.
  Rewinding to commit time instead would let a swing land on somebody who dodged
  before it even started, which is the exact thing the comment above refuses.

## Shape

### The cap, and why it is 12

`MAX_REWIND_TICKS = 12` — 200ms at 60Hz. Three independent readings agree on it:

- **It is under half the shortest wind-up.** The shortest in the table is 27
  ticks (`ranged.star`, 0.45s). At 12, a dodge begun in the first half of *any*
  wind-up in the game always works, whatever the attacker's connection. The
  readable wind-up shortens; it does not disappear.
- **It is exactly the worst connection the client is tuned for.**
  `latency.test.ts` characterises 0, 3, 6 and 12 ticks — loopback, 50ms, 100ms,
  200ms. Compensating to 12 covers everything prediction was measured against
  and nothing beyond it. A player worse off than the worst case the client
  handles does not also get the most generous rewind.
- **It is about two body-widths of cover.** At 155 units/s a body covers 31
  units in 200ms, against a 16-unit radius. So "I was already behind that
  rock" is wrong by up to roughly two body-widths, and no further. That is the
  price, in the units the game is actually played in.

### A history, bounded by the cap

```ts
// src/server/world/position-history.ts — pure, deterministic core
export class PositionHistory {
  /** Record where everything is, at the end of a tick. */
  record(tick: number, entities: Iterable<ServerEntity>): void;
  /** How far this attacker's view lags the server, in ticks. Clamped here. */
  noteLag(entityId: number, ticks: number): void;
  ticksFor(attackerId: number): number;
  positionAt(entityId: number, ticksAgo: number): Vec3 | null;
}
```

A ring of `MAX_REWIND_TICKS + 1` ticks and nothing more, so the memory is
bounded by the cap rather than by how long the server has been up. `positionAt`
returns null for an entity that was not alive then, and the caller falls back to
the live position — a body that has only just spawned cannot have been dodged.

### One byte on the wire

`InputMessage` gains `renderLagTicks: varuint` — how far behind the server's
clock the client believes the world it is *drawing* is (`estimatedTick` minus
the last delta's tick, which is one-way latency plus up to a broadcast
interval). `PROTOCOL_VERSION` 13 → 14.

It is client-reported, and that is a thing to say out loud rather than bury: a
client can claim any number it likes. The server clamps it to
`[0, MAX_REWIND_TICKS]` on arrival, and the clamp is the whole security
argument — the worst a liar achieves is the compensation an honest player on a
200ms connection already gets. Spec 151 hardens what the protocol accepts in
general; this field is designed so that it needs no special case there.

### Where it is applied

One place, in `world.ts`, where `candidates` is already built:

```ts
const candidates = [...working.values()].filter(...);
const seen = rewindTargets(candidates, casting.id, context.rewind);
const advanced = advanceCast(casting, seen, tick, rng);
// ...and every entity the landing touched gets its live position back.
```

`abilities.ts` does not change at all. It is handed bodies whose positions are
where the attacker saw them and resolves exactly as it always has, which is
the point: there is no second set of hit rules to keep in step with the first.

Two things the substitution must get right:

- **Only targets move, never the attacker.** The caster is where the server
  says; their own position is what prediction and reconciliation already agree
  on, and rewinding it would move the origin of every range measurement.
- **The write-back restores the live position.** `landOnTarget` returns the
  damaged entity, and that entity is carrying a position from 200ms ago. Written
  back unmodified it would teleport the target into its own past. Health,
  effects and cooldowns are the result; position is not.

`StepContext` gains `rewind?: RewindLookup`, absent meaning no compensation —
so every existing test, the loopback tab and every headless sim run behave
exactly as before, and their assertions still describe them.

## Invariants tested

- **The shot that connected, connects.** A target walking out of reach, an
  attacker 200ms behind: without compensation the swing misses; with it, it
  hits. Both in one test, because the second means nothing without the first.
- **And the cap is a cap.** The same test with the target having left 300ms ago
  — beyond the window — misses even for a client claiming a huge lag. A client
  reporting 10000 gets exactly the same answer as one reporting 12.
- **The dodge still works.** A target that begins moving in the first half of a
  wind-up is out of reach at the release *and* was out of reach 12 ticks before
  it, so it is a miss at any compensation this spec can grant. This is the
  property the cap exists to protect and it is asserted directly.
- **The attacker is never rewound.** A caster who moved during the wind-up
  measures range from where the server has them, not from where they were.
- **Nobody is teleported by being hit.** After a compensated hit the target's
  position is its live one, to the bit; only its health changed.
- **The history is bounded.** After thousands of ticks it holds
  `MAX_REWIND_TICKS + 1` and no more; an entity that has left is not retained;
  `positionAt` past the ring returns null.
- **Determinism is untouched.** Same seed, same inputs, same reported lags,
  identical authoritative state — including through spec 147's bad wire, where
  the reported lag varies every tick.
- **No compensation is the old behaviour, exactly.** `StepContext` without
  `rewind` produces bit-identical results to today across the existing combat
  suites, which are left unmodified.

## Out of scope

- **Projectiles.** A shot that flies is resolved by contact along its own path
  over many ticks, and it is already the case that the attacker aimed at a
  place rather than a body. Rewinding a flight is a different problem and a
  bigger one; `landOnTarget`, `landCone` and `landBlast` are what this covers.
- **Rewinding the world.** Only entity positions are recorded. Terrain and
  props do not move, and nothing here rewinds health, so a target who died in
  the last 200ms is dead — you cannot hit a corpse into being alive.
- **Telling the victim.** There is no "you were hit from the past" feedback.
  The damage number and the blood are what they always were; explaining the
  rewind to the person on the receiving end is a UI question and a later one.
- **Adapting the cap to the connection.** One number for everybody. A cap that
  grew for a worse connection would reward having one.
