# 081 — The player is a cow

## Problem

The Play tab still draws the spec 031 bird: a navy blob with a beak and two
flapping wings, built before the critter rig existed. Spec 055 gave us real
animal characters — a shared skeleton, a walk cycle, painted markings, a coat
palette — and the two sandboxes have been the only place you can see one. The
main game should draw the same rig the rest of the project has been building,
and the cow is the species that reads best at 64 px.

Swapping the body is also the moment to say what the player's *movement* is,
rather than leaving it at the "Warden" archetype spec 028 picked for a
different silhouette. A cow at 0.7 scale takes a longer step than its size
suggests and pivots much faster than the old figure did.

## Shape

Two numbers change and one rig is replaced.

`src/sim/characters.ts` — the first entry of `CHARACTERS` is the player's base
movement, read by `src/server/player/stats.ts` as `BASE_MOVE_SPEED` /
`BASE_TURN_RATE`. It becomes the cow:

```ts
{ name: 'Cow', moveSpeed: 155, turnRate: 540 }
```

`src/render/iso3d/world/appearance.ts` — the pure "what do I build for this"
layer gains the player's species and the two figure knobs that differ from the
critter default:

```ts
export const PLAYER_CRITTER: CritterId;                              // 'cow'
export const PLAYER_FIGURE: Pick<FigureTuning, 'bodyScale' | 'strideScale'>;
                                                                     // 0.7, 1.3
```

`src/render/iso3d/world/scene.ts` — `rig === 'player'` builds a
`CritterRig(CRITTERS[PLAYER_CRITTER], { tuning: { ...defaultCritterTuning(),
...PLAYER_FIGURE } })` instead of a `PlayerRig`. `CritterRig` observes its own
motion from the world positions it is handed, so the `Body.previous` /
`moved` bookkeeping the bird needed goes away and the player is updated the
same way a monster is: `update(dt, { x, y }, -facing)`.

## Invariants tested

- `PLAYER_CRITTER` names a species that exists in the `CRITTERS` table.
- `PLAYER_FIGURE` stays inside `CRITTER_BOUNDS` for both knobs it sets, so the
  player's figure is one the panel could also have produced.
- `PLAYER_FIGURE` is exactly `{ bodyScale: 0.7, strideScale: 1.3 }` — the
  numbers are the spec, so a silent drift is a failing test.
- `CHARACTERS[0]` is `moveSpeed: 155`, `turnRate: 540`, and both are inside the
  sim's `MOVE_SPEED_HARD_MIN`/`MOVE_SPEED_HARD_MAX` clamp.
- A fresh player's effective `moveSpeed` is 155 (no starter item moves it) and
  its `turnRate` is `540 + TURN_RATE_PER_AGILITY * dexterity`, i.e. the base is
  the character's and the bonus is still dexterity's.

## Out of scope

- Letting a player *choose* a species or a coat. The play view draws one cow in
  the species default coat; the picker in `critter-panel.ts` stays a sandbox
  thing.
- `PlayerRig` itself. The bird stays in `rigs.ts` as the small, cloth-free rig
  the outline and hover tests build against; it is simply no longer what the
  play view reaches for.
- The second `CHARACTERS` entry ("Zephyr"). The movement sandbox still cycles
  between two archetypes; only the first — the one the server reads — is the
  player's.
- Any sim-side notion of a species. The wire still carries `EntityKind.Player`
  and nothing else; which animal that draws as is a renderer decision.
