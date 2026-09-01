# 263 — A body that arrives

## Problem

Nothing in this game arrives. A monster is a coordinate that did not have a
body on it and does on the next frame; a player who presses Respawn is standing
on the spawn pad between one frame and the next. Every other moment in this
game that matters has a picture — a blow throws paint (spec 121), a break rocks
the body (spec 173), an item is *thrown* and withholds itself (spec 158), a
Warden's beam telegraphs for half a second (spec 262) — and the one moment a
body enters the world has none at all.

Two presentations, and no more:

- **Generic.** A short white smoke poof at the spot. The default for everything.
- **Burrow.** The spider and the Warden share the mech rig, so they share this:
  the ground is disturbed, the legs come out first, and the legs pull the body
  up out of the hole.

Most of what this needs is already here and connected to nothing in this
direction:

- `MechRig` is the one rig in the game with **world-locked feet**. `stabilise`
  draws each leg from a hip carried through `carriage.matrix` to a foot that is
  *independent of it* (`rigs.ts:1772-1787`), which is the decoupling the whole
  emergence rests on — drop the carriage and the legs re-solve to keep their
  feet planted, which is a body being pushed up by its own legs and not a
  translation.
- `stagger-flinch.ts` is the pattern for a presentation-only offset read per
  body per frame and added to the drawn transform, with `forget`/`retain` for
  its own bookkeeping.
- `swing-vfx.ts` is the pattern for a **one-shot** effect fired on an event
  tick: a map keyed on the tick rather than a boolean, and no handle held,
  because the effect's own particle lifetimes retire it.
- `VFX_PALETTE` already has both palettes. `dustPale`/`dustSnow`/`smokeLight`
  are the poof and `dustEarth`/`paintBrown`/`paintSoot` are the dirt, so this
  invents no colour.

## Shape

### The one fact the server has to add

A client cannot tell a body that was *created* from one that walked into its
interest range: `EntityField.Spawn` is set "the first time an entity enters
this client's interest set" (`delta.ts:188`), which fires identically for both.
Playing a poof on that bit would poof every monster the player walks up to.

So `ServerEntity` records when it was made, and the `Spawn` field carries it:

```ts
// sim/world.ts
readonly spawnTick: number;   // the tick this body was created; 0 for a body from nowhere
```

```
| 0x01 | Spawn | u8 kind · str typeId · u32 spawnTick |
```

This is `LootDrop`'s decision verbatim and for its stated reason — *"its own
'when did I first see this' is not the answer — it would restart the
anticipation for somebody who walked up halfway through"* (`PROTOCOL.md:745`).
It is **identity**, so it rides the field whose own comment is "sent once when
the entity enters this client's interest set": four bytes once per body per
client, and nothing per tick.

**A respawn is deliberately not a spawn tick.** `respawn` heals and moves the
body it already has (`server.ts:2994`) — no body is created, the id survives,
and the `Spawn` field is not re-sent. So the client reads it the way
`stagger-flinch.ts` reads a break: **the window is replicated, the start is
observed.** A body seen dead on one frame and alive on the next is an edge this
client watched; one that arrives afterwards plays nothing, which is right and is
the same margin spec 158's loot pop runs.

### The presentation, pure

```ts
// render/iso3d/world/spawn-presentation.ts
export type SpawnStyle = 'generic' | 'burrow';

/** What one body's arrival is doing this frame. */
export interface SpawnStage {
  readonly style: SpawnStyle;
  /** True on the one frame the poof/dirt is fired. */
  readonly began: boolean;
  /** 0..1 through the emergence, or 1 for a body that has arrived. */
  readonly phase: number;
  /** How far under its own hidden depth the whole rig sits, 0..1. */
  readonly buried: number;
  /** How far the body is dropped below its own legs, 0..1. */
  readonly bodyDrop: number;
  /** Whether dirt is being thrown this frame, and how hard. 0 for none. */
  readonly dirt: number;
}

export const SETTLED: SpawnStage;   // style 'generic', phase 1, every offset 0

export function spawnStyleFor(appearance: Appearance): SpawnStyle;

export class SpawnPresentations {
  read(body: SpawnBody, tick: number): SpawnStage;
  forget(id: number): void;
  retain(live: ReadonlySet<number>): void;
}
```

`spawnStyleFor` is `burrow` exactly when the body draws on the mech rig, and it
answers that with the same two predicates `bodyFor`'s own chain is built from
(`authoredUnitFor`, then `monsterCritterFor`) rather than a list of type ids —
so a spider given a critter row stops burrowing without anybody remembering to
edit a table here.

### What the rig gains

One field and one reader, both additive, both no-ops at 0:

```ts
// rigs.ts, MechRig
/** How far the body is dropped below its own legs, 0..1 (spec 263). */
burrow = 0;
/** How far under the ground this rig has to sit to be out of sight. */
get hiddenDepth(): number;
```

`burrow` is subtracted from the carriage's Y *after* the sway clamp and bounded
by its own; the legs are untouched, so they re-solve from a dropped hip to a
planted foot, which is the emergence. `hiddenDepth` is a *getter* because the
depth is `(BODY_Y + …) * S` and `S` is `sizeScale` — the scene must not carry a
second copy of how big a mech is.

### The two effects

`spawn_poof` and `spawn_burrow_dirt`, built by `brushPoof` and `brushDirt` in
`vfx/brush.ts`, registered in `BRUSH_EFFECTS`, both one-shot (`durationTicks`
set, so nothing owes a stop) and both on **mesh shapes and blends the registry
already batches** — `brush-blot` and `brush-dab` in `alpha` — so
`library.test.ts`'s 25-batch ceiling does not move.

## Invariants tested

- A generic unit's arrival selects `generic`; a `small_spider`'s and a
  `warden`'s select `burrow`; every other monster in the roster, the player, a
  projectile, a prop and a drop select `generic`.
- The selection is the same for a spawn and for a respawn of the same body.
- A body first seen with a `spawnTick` older than the window plays nothing —
  walking into interest range is not an arrival.
- A body seen dead and then alive plays its arrival; a body first seen alive
  after somebody else's respawn plays nothing.
- The poof and the dirt are fired **once** per arrival, not once per frame.
- `phase` reaches exactly 1 and every offset reaches exactly 0 at the end.
- Repeated arrivals on one entity id leave no accumulated offset and no growing
  map: `retain` and `forget` drop tracks, and a settled body reads `SETTLED`.
- An arrival that is interrupted — the body dies, or acts — reads settled from
  that frame on, so nothing is drawn attacking from under the ground.
- `MechRig.burrow = 0` draws exactly what it draws today, vertex for vertex.
- The registry still holds ≤ 25 batches and both new effects put marks in the
  air.

## Out of scope

- **Any gameplay timing.** Nothing about when a body becomes targetable, can
  move or can attack changes: there is no spawn state on `ServerEntity` today
  and this does not add one. The presentation yields to the body rather than
  the other way round.
- A burrow for the critter rig or an authored unit. `Humanoid.poseLegs` is FK
  bone rotation of one skeleton with no world-locked foot to plant, so the
  emergence is not expressible there; those get the poof.
- Terrain deformation, a hole in the ground, procedural IK beyond what
  `MechLeg.pose` already solves.
- A despawn presentation. A body leaves for half a dozen reasons and only one
  of them is a death, which is already drawn.
