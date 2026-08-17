# 163 — Four ways to meet a player

## Problem

Every monster in the game meets a player the same way: it ignores them
completely until it is hit, and then it fights to the death. That is one
behaviour, and it is the *absence* of a behaviour rather than a choice — spec
076 deleted the proximity scan on purpose and left a note saying so, because
what it replaced was a radius and nothing else:

> `MonsterDefinition.aggroRange` stays in the table, unread, because it is the
> number a later spec turns back on per-monster — and `passive` stays for the
> same reason.

This is that spec. It turns proximity back on, and it does it as a *temperament*
rather than a radius, because the interesting part of meeting an enemy is not how
far away it noticed you — it is what it does about it.

Four temperaments, which is the smallest set that covers the range from "not
worth fighting" to "you are already in trouble":

- **skittish** — being hit makes it run, not fight.
- **defensive** — being hit makes it fight. Today's rule, kept, because it is
  a real behaviour and not just the default.
- **territorial** — it notices you at a distance, *watches you for a beat*, and
  then commits. The beat is the point: it is a wind-up for the fight itself, and
  it is long enough to read and short enough to matter.
- **ferocious** — it notices you and comes at once, and it answers a blow landed
  on a neighbour as if it were its own.

The territorial alert is the one that carries the game's stated rule up a level.
A blow already telegraphs itself; an *encounter* did not. A body that turns to
face you and holds for a second is the same offer a wind-up makes — read it and
withdraw, or accept it — made about the fight rather than about one swing.

## Shape

### The data

`aggroRange` and `passive` both go. They were two fields describing one thing,
one of them unread for eighty specs, and neither of them could say what the body
was going to do. A temperament is a discriminated union, so **a row only authors
a number the behaviour it chose actually reads** — there is no `alertTicks` on a
body that never alerts, and no notice range on a body that never notices.

```ts
// src/server/data/monsters.ts
export type Temperament =
  /** Being hit makes it run from its attacker, for `fleeTicks`. */
  | { readonly kind: 'skittish'; readonly fleeTicks: number }
  /** Being hit makes it fight back. It initiates nothing. */
  | { readonly kind: 'defensive' }
  /** Notices at `noticeRange`, faces its quarry for `alertTicks`, then commits. */
  | { readonly kind: 'territorial'; readonly noticeRange: number; readonly alertTicks: number }
  /** Notices at `noticeRange` and commits at once; answers a blow landed within
   *  `assistRange` of it as if it had been struck itself. */
  | { readonly kind: 'ferocious'; readonly noticeRange: number; readonly assistRange: number };

export interface MonsterDefinition {
  // ... unchanged, minus `aggroRange` and `passive`
  readonly temperament: Temperament;
}
```

The roster:

| row | temperament | numbers |
|---|---|---|
| `grazer` | skittish | flees 2.5s |
| `ravager` | defensive | — |
| `stalker` | territorial | notices 320, alerts 1.0s |
| `slinger` | territorial | notices 380, alerts 1.4s |
| `small_spider` | ferocious | notices 300, assists 260 |
| `dummy` | defensive | — |

Two of those assignments are arguments rather than bookkeeping. The **slinger**
alerts longer than the stalker because it opens the fight from a distance with a
thrown star: a ranged opener that arrives with no warning is a hit the player
never had the information to avoid, and the extra 0.4s is reach paid back as
time. The **spider** assists at 260 and notices at 300 — the call for help
deliberately does not carry further than the spider can see, so a nest answers
together and the far side of the field does not.

### What reading the numbers cost

`aggroRange` had never been read by anything, and switching it on found two
places where the world had quietly been built around it meaning nothing.

The slinger's range drops from **520 to 380**. The arena is 1200 by 900 with
`DEFAULT_SPAWN` at its centre, so 520 is one body watching nearly half the
playable world — and there is no point in the arena except a far corner where a
slinger could stand without seeing the tile every character starts and respawns
on. 380 is still comfortably past the 300 the star reaches, which is all the
range was ever for.

And one marker moves in `maps/arena.json`: `spawner-11`, the slinger, from
(578, 548) to (1131, 592). It was **100 units from the spawn point, inside
Hearthstead's own bounds** — placed by spec 076 as "something to fight in every
direction" in a world where nothing initiated, which made a spawner in the town
square harmless. It is not harmless now.

Neither of those is protected by anything today, and that is worth stating
plainly rather than leaving to be rediscovered: **Hearthstead is not a
sanctuary.** Its `pvp: false` gates player-versus-player damage and its `rest:
true` gates regeneration; no zone flag has ever gated a monster, and none is
added here. What guards the spawn point instead is a test —
`spawners.test.ts` asserts that no spawner on the shipped map can see
`DEFAULT_SPAWN` from where it stands, with a margin. That is a product of two
numbers in two files that do not mention each other, so it is exactly the kind
of thing that holds by accident until it does not. A real no-aggro zone is a
better answer and a separate spec; this one only has to not ship a spawn-death
loop.

### The mind, beside the body

`activity` is what a body is *doing* — Idle, Moving, Casting, Stunned, Dead. It
cannot express what a body has *decided*, and it must not learn to: a monster
holding still during its alert and a monster holding still because it has nothing
to do are the same `Idle`, and the whole feature is that they are not the same
thing. So the mind is a second pair of fields in the shape of the first:

```ts
// src/server/sim/types.ts
export const AggroValue = { Calm: 0, Alert: 1, Engaged: 2, Fleeing: 3 } as const;

interface ServerEntity {
  // ...
  /** What this body has decided about its target (spec 163). */
  readonly aggro: number;
  /** When Alert becomes Engaged, or Fleeing becomes Calm. 0 when neither. */
  readonly aggroUntilTick: number;
}
```

`Calm` and `targetId === null` are the same state seen from two sides, and the
sim keeps them that way: every transition that drops a target sets `Calm`, and
every transition that takes one leaves it.

### One file for the rules

`src/server/sim/aggro.ts` — pure, no route state, no steering. Every rule about
*whether* a body has business with another body lives here; `world.ts` keeps
every rule about how it walks there.

```ts
/** What a landed blow does to the victim's mind. */
export function provoke(target: ServerEntity, attackerId: number, tick: number): ServerEntity;

/** What standing near a player does to a calm monster's mind. */
export function notice(
  monster: ServerEntity,
  entities: ReadonlyMap<number, ServerEntity>,
  tick: number,
): ServerEntity;

/** Whether an alert has run out, a flight has ended, or a quarry has backed off. */
export function settle(monster: ServerEntity, target: ServerEntity | null, tick: number): ServerEntity;

/** What a blow landed on one body does to the bodies around it. */
export function rally(
  hits: readonly HitFact[],
  entities: ReadonlyMap<number, ServerEntity>,
  tick: number,
  zones: ZoneLookup,
): ReadonlyMap<number, ServerEntity>;
```

`provoke` replaces the one line in `sim/blow.ts` that was the entire aggro system
(`targetId: target.targetId ?? attacker.id`). It keeps that line's behaviour for
everything without a temperament — a player, a prop — and reads the row for
everything with one:

- **skittish** → `Fleeing`, `aggroUntilTick = tick + fleeTicks`, and `targetId`
  is **overwritten** rather than kept, because a body running away is running
  from whoever hit it *last*. A second blow refreshes the clock.
- **defensive**, **ferocious** → `Engaged`, target kept if it had one.
- **territorial** → `Engaged`, **including out of `Alert`**. A body that is shot
  while it is sizing you up does not finish sizing you up.

### The alert

Held entirely in `monsterIntent`'s existing shape — an `Alert` monster returns an
intent with a zero move vector, a facing pointed at its quarry, and no
`castAbilityId`. It is not a new movement mode; it is the one the code already
has for "in range, stop and face", with the swing withheld.

Two ways out, and both matter:

- `tick >= aggroUntilTick` → `Engaged`. The fight is on and leaving the notice
  range no longer helps; only the leash takes the target away now.
- the quarry leaves `noticeRange` first → `Calm`, target dropped. **This is the
  feature**, not a tidy-up: the alert is an offer, and backing out of it has to
  be an answer the player can actually give.

### The flight

A `Fleeing` monster routes to a point `FLEE_DISTANCE` directly away from its
target, through the same `routeToward` a chase uses, so a fleeing grazer goes
round a rock rather than pressing into it. It never swings, whatever it is
standing next to.

It is also **exempt from the leash**, which is the one place this spec touches
spec 076's rule. The leash exists to stop a body being *dragged* off its anchor
by a player walking backwards; a body sprinting away under its own power that
got dropped by the leash would turn around at the boundary and walk home through
the thing chasing it. When the flight ends the target is dropped, `walkHome`
takes over, and the leash's job resumes with nothing to do.

### The herd

`rally` runs as a new pass in `step()`, after the cast and projectile passes have
produced their `hit` events and before the dead are swept. For each hit whose
victim is a monster, every `ferocious` monster that is `Calm`, within its own
`assistRange` of the victim, and hostile to the attacker, becomes `Engaged` on
the attacker.

Being an event pass rather than a scan is what keeps it bounded. A rallied
spider is not itself hit, so it does not rally a third — the call carries exactly
one hop from each *actual blow*, and a chain across the map would need a chain of
actual blows to carry it. A per-tick scan for "an ally who looks angry" is the
version of this that cascades, and it is not what this does.

Cost is a linear scan of the entity map per monster hit, on ticks where a monster
was hit. There is no broadphase in this repo to reach for and this does not add
one; `notice`'s scan is the same shape and the same size as the one spec 076
deleted.

### What the player sees

Nothing new on the wire. The alert's tell is the body **turning to face you and
standing still**, and facing and position are already replicated at 20Hz — so the
one-second read the feature is built on arrives on the client for free. A
dedicated indicator would need an `EntityField` bit, a protocol bump and a
renderer that draws a mood, and none of that is needed to find out whether the
mood itself is worth having.

## Invariants tested

- **Skittish runs.** A hit grazer's distance from its attacker increases every
  tick of `fleeTicks`, it emits no `hit` event of its own however close the
  attacker stays, and when the clock runs out it drops the target and heads back
  toward its anchor.
- **Defensive is unchanged.** A ravager ignores a player standing on top of it
  for ten seconds, and fights back on the tick it is hit. (The existing
  `world.test.ts` case, kept, because the point is that this behaviour survived.)
- **Territorial waits, and the wait is the authored length.** A stalker with a
  player inside 320 units turns to face them, does not move, and lands no blow
  before `alertTicks`; it lands one after. The last tick it is silent and the
  first tick it swings are both asserted, from both sides.
- **Backing out works.** A player who enters a stalker's notice range and leaves
  it before the alert expires leaves a monster that is `Calm`, holds no target,
  and never swings.
- **A blow cuts the alert short.** A stalker hit during its alert is `Engaged`
  on the same tick, without waiting out the remainder.
- **Ferocious needs no invitation.** A spider with a player in range and no input
  at all attacks, from proximity alone.
- **The herd answers, and only within its range.** Hit one spider: a second
  inside `assistRange` acquires the attacker without being touched; a third
  outside it stays `Calm`. A grazer standing in the middle of them stays `Calm`
  too — assisting is a temperament, not a proximity.
- **The call does not cascade.** One blow rallies the spiders around the victim
  and no others, however they overlap: the rallied bodies were not hit, so they
  raise no call of their own.
- **The leash still takes a target away**, for every temperament that can hold
  one — and a fleeing body is not dropped by it mid-flight.
- **Nothing on the shipped map can see the spawn point.** Every spawner in
  `maps/arena.json`, measured against its own row's notice range with a margin.
  A fresh character's first move is the player's.
- **Replay.** A seed and an input sequence against a map holding all four
  temperaments produce bit-identical state, twice. No temperament draws from the
  `Rng`, so which enemies are on the map cannot shift a combat roll.

## Out of scope

- **No wire field, no indicator.** Argued above: the tell is the facing, which
  already replicates. A drawn mood is its own spec, and it should be written
  after somebody has played against the alert and can say what it needs to show.
- **No threat table.** A monster still holds exactly one `targetId` and the last
  thing to provoke it wins. Multi-attacker threat, taunts and pulling are a
  different feature and would change what `targetId` means.
- **No pack coordination.** Rallied spiders converge on the same player because
  they each chose it, not because anything is steering them as a group. Flanking,
  surrounding and spacing are not here.
- **No wandering.** A calm monster still stands on its anchor. Patrol routes
  would need a path the map document authors, which is a map feature.
- **No fleeing at low health.** The skittish rule reads a blow, not a health
  fraction. "Runs away when badly hurt" is a good behaviour and a different one,
  and giving it to `defensive` would make two of the four temperaments the same
  body at different health.
