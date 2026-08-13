# 156 — A drop you notice before you read it

## Problem

Nothing drops. A monster dies, `blow.ts` emits `died`, `server.ts` grants the
experience off its row, and the body is swept away leaving the world exactly as
it was. `addToInventory` has carried the comment "the starting kit today, loot
later" since spec 126 and `LiveConfig.dropRateMultiplier` has been a live knob
scaling a roll that does not exist since spec 056. This is the roll.

The reason to write it now is not that the game needs a sword generator. It is
that the *presentation* decision has to be made while there is one drop path
rather than after there are five. `docs/reward-philosophy.md` states the
direction this branch commits to: excitement comes from the world responding to
play, not from a reward card. The concrete form of that for loot is **notice →
wonder → recognition** rather than **read label → see object**: an unusual thing
lands, something about it is audibly and visibly not ordinary, and what it
actually is resolves a beat later.

The trap to avoid is doing that with timers scattered through the renderer. The
reveal has to be a state with an authoritative clock behind it, or "when does
the label appear" becomes a different answer per observer, per frame rate and
per reconnect.

## Shape

### Rarity is a property of the row, not of the drop

```ts
// src/server/data/items.ts
readonly rarity?: RarityId;   // absent means 'common'
```

Three tiers and no more: `common`, `rare`, `exceptional`. Rarity is authored on
the `ItemDefinition`, which keeps spec 062's contract intact — *an entity only
ever stores an id* — and means a drop cannot have a rarity its item does not.
There is no per-drop rarity roll, because a rarity that varied between two
copies of the same sword would only mean something if affixes existed, and they
do not.

Three because three is what the presentation ladder needs: quiet, delayed,
longer. A fourth tier would be a tier with nothing to say.

### The loot table and the reveal timings are content

```ts
// src/server/data/loot.ts  -- pure, read by both ends
export const RARITY_IDS = ['common', 'rare', 'exceptional'] as const;

export interface RarityRow {
  readonly id: RarityId;
  readonly name: string;
  /** Ticks from the drop landing to its identity being told. 0 = at once. */
  readonly revealTicks: number;
  /** Ticks from landing to the anticipation cue. Always <= revealTicks. */
  readonly anticipationTicks: number;
  readonly cues: { readonly spawn: string; readonly anticipation: string; readonly reveal: string };
}

export function rarityOf(defId: string): RarityId;
export function rollLoot(rng: Rng, monsterId: string, dropRate: number): [ItemStack | null, Rng];
```

`cues` are **names** — `'loot.spawn.rare'` — emitted into whatever sink the
renderer has. No asset is named in core loot logic and the server never learns
what a cue is.

### The drop is an entity, like a projectile

`EntityKindValue.Drop = 4`, with a `drop: DropState | null` beside
`projectile: ProjectileState | null` on `ServerEntity`. Interest management,
delta tracking, despawn and reconnect then apply to it unchanged, which is the
argument spec 062 made for projectiles and it has not got worse.

```ts
// src/server/sim/loot.ts -- pure
export const RevealPhase = { Spawned: 0, Anticipation: 1, Revealed: 2 } as const;

export interface DropState {
  readonly defId: string;      // authoritative identity, from the tick it landed
  readonly count: number;
  readonly rarity: RarityId;
  readonly ownerPlayerId: string | null;   // whose kill this was
  readonly spawnTick: number;
  readonly anticipationTick: number;
  readonly revealTick: number;
  readonly expiresTick: number;
}

export function revealPhaseAt(drop: DropState, tick: number): RevealPhaseValue;
```

**`defId` is decided on the tick the body is swept and never changes.** The
reveal is presentation unfolding over a determined fact; it is not a deferred
roll, and there is nothing about it a player could wait out for a better answer.

The three ticks are stamped at the drop, from the rarity row scaled by the live
`lootRevealScale`, for the reason spec 144 snapshots attack timing: a knob turned
mid-reveal must not move a reveal that is already running.

### The entity record carries no item id

A drop replicates through the ordinary `Delta` with `typeId: ''`. Its identity
travels on one message of its own:

```
0x55 LootDrop
varuint entityId · u8 rarity · u32 spawnTick · u32 revealTick ·
str defId · varuint count
```

Sent when the drop first enters a connection's interest set — which the delta
already computes, so there is no second visibility system — and again on the
tick it reveals. **`defId` is empty and `count` is `0` until the reveal**, so a
client that has not been told what the item is genuinely does not have it: not
hidden behind a flag, absent from the wire. A client entering interest after the
reveal gets the filled version on first sight, so a late observer and a
reconnecting one need no special case.

The rarity *is* sent up front, and deliberately: the anticipation cue is
tier-shaped, so playing it needs the tier. That is the "notice" step — the world
saying *something happened here*. What is withheld is the payoff, which is what
the thing is.

### Picking it up does not wait for the show

```
0x19 PickUpItem   varuint requestId · varuint entityId
```

Answered with `Inventory` at that request id, exactly as `MoveItem` is, plus
`Error(RejectedAction)` on a refusal. The server checks: the entity is a drop,
the asker is alive, they own it, they are within `PICKUP_RANGE`, and the bag has
room. `addToInventory` does the rest.

**A pickup before the reveal is legal and is served immediately.** The item
arrives in the bag with its real name on it, the entity is removed, and the
reveal that was pending simply never happens. Anticipation must not be a lock on
the player's hands; a drop that could not be taken for two seconds would be a
timer wearing a costume.

### Presentation is a pure function of the drop and the drawn tick

```ts
// src/render/iso3d/world/loot-drop.ts -- pure, no three.js
export interface DropPresentation {
  readonly phase: RevealPhaseValue;
  readonly flare: number;        // 0..1, what the glow is scaled and lit by
  readonly label: string | null; // null until revealed -- never a placeholder
  readonly cue: string | null;   // the cue crossing into this tick, or null
}
export function presentDrop(drop: DropView, tick: number, seen: SeenCues): DropPresentation;
```

`flare` for a common drop is a flat, low constant — it has no anticipation
window at all, `revealTicks` being 0 — so the contrast survives. The scene reads
`flare` for a glow and forwards `cue` to the vfx/sound sink, and contains no
timing arithmetic of its own.

### Testing it without farming

`admin:triggerEvent 'drop'` with `magnitude` as the rarity ordinal puts a drop of
a chosen tier at a chosen point, and `lootRevealScale` is a `LiveConfig` key, so
the delay is tunable on a running server from the admin console.

## Invariants tested

- The server decides the item: the same seed and the same kills produce the same
  drops, and a replay reproduces them exactly.
- **A drop's `defId` and `count` never change between spawn and pickup**,
  across every phase transition.
- `revealPhaseAt` is monotone in `tick` and lands on `Revealed` exactly at
  `revealTick`; a common drop is `Revealed` on the tick it spawns.
- `LootDrop` sent before the reveal carries `defId: ''` and `count: 0`; sent at
  or after it, the true pair. Asserted on the encoded frame, not on the object.
- A client that first sees a drop after its reveal is told the identity on first
  sight — the late-observer and the reconnect case are the same case.
- The client cannot change a rarity: a replica told a different `defId` is
  overwritten by the next authoritative `LootDrop`, and the bag is only ever
  what the server's `Inventory` says.
- Pickup before the reveal succeeds and yields the same stack as pickup after
  it. Pickup out of range, of somebody else's drop, or into a full bag is
  refused and moves nothing.
- **A drop can be picked up exactly once**: two pickups of the same entity, from
  one player or from two, put one stack in one bag and refuse the other. The
  reveal is not a second grant path — no code path creates an item on reveal.
- A drop expires on its own tick and is removed like any other entity; an
  unrevealed drop that expires reveals nothing.
- Drops are inert: not hostile, not targetable, not hit by projectiles, and they
  do not walk.
- Basic loot stays quiet: a `common` drop has `revealTicks === 0`, no
  anticipation cue, and a `flare` below every other tier's at every tick.
- Presentation cannot change state: the same fight with the drop presentation
  driven and undriven produces identical authoritative state.

## Out of scope

Deliberately not built here, and named because the philosophy document lists
them as directions rather than as work:

- contextual loot — no combat state biases what drops;
- bad-luck protection or any pity meter;
- affixes, instanced item state, or a second rarity axis;
- shared or rolled loot. A drop belongs to the killer, full stop;
- persistence. A drop lives in the world state and dies with the process, which
  is what everything else in the sim already does;
- consuming, destroying or dropping *from* the bag. Items go one way today;
- a loot feed, a reward popup, or any screen that interrupts. There is no new
  window in this spec and there is not meant to be one.
