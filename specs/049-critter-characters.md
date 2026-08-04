# 049 — Critter characters: bipedal farm animals as player units

## Problem

The scene has exactly two character rigs, and neither is a *character*: the mech
is a machine, and the hooded robe is deliberately faceless because it exists to
carry a cloth simulation. There is no way to add a playable unit that reads as
somebody, and no way to add a second one without writing a third bespoke rig
class from scratch.

What the game wants is a family of cozy, low-poly farm/woodland animals standing
on two feet — a pig, a cow, and however many follow — that share a skeleton, a
walk cycle and a construction vocabulary, and differ only in **data**: their
proportions, the blocks their body is made of, and their colours. On top of that
the player picks their own coat colour from a fixed palette, so two players
running the same species still read apart at a glance.

The binding constraint is **legibility at 64 px**. These are units seen from an
isometric camera at unit scale, not portraits. A ~90-unit-tall character drawn
64 px high is ~1.4 world units per pixel, which means any detail thinner than
~3 units is under two pixels and is a waste of geometry, and any two adjacent
colours that are close in luminance merge into one blob. The species data has to
be checkable against that, not eyeballed.

## Shape

Three layers, matching how `cloth/` already splits from `iso3d/`.

### 1. `src/render/critters/` — pure species data, no three.js

Reuses the existing bone structure from `cloth/figure.ts` (`BONE`,
`boneRestLayout`, `FigureMetrics`) rather than inventing a second skeleton, so
every critter is posed by the same walk cycle the robed figure uses.

```ts
export type CritterId = 'pig' | 'cow';

/** A colour slot. `coat*` follow the player's pick; the rest are species accents. */
export type CoatRole =
  | 'coat' | 'coatShade' | 'coatLight'
  | 'skin' | 'skinDeep'          // snout, ear lining, udder — tinted toward the coat
  | 'marking' | 'horn' | 'hoof' | 'eye';

/** An animated attachment point the bones do not provide: ears, snout, tail. */
export interface SocketSpec {
  readonly socket: string;
  readonly parentBone: number;          // index into BONE
  readonly pos: readonly [number, number, number];
  readonly rot?: readonly [number, number, number];
  readonly wobble?: WobbleSpec;         // secondary motion, data-driven
  readonly mirror?: boolean;            // also emit `${socket}R`, mirrored in z
}

export interface WobbleSpec {
  readonly axis: 'x' | 'y' | 'z';
  readonly strideAmp: number;   // radians, driven by the stride cycle
  readonly phase?: number;      // cycles
  readonly idleAmp?: number;    // radians of idle sway
  readonly idleHz?: number;
  readonly leanAmp?: number;    // radians per rad/s of turn (a tail swings out)
}

/**
 * One piece of a body. Attached to a bone index or a socket name.
 *
 * The important shape is `hull`: a **skin lofted through a stack of profile
 * rings**, smoothed with a Catmull-Rom. The torso, head, muzzle and limbs are
 * each one of these. The first cut of this spec built bodies from intersecting
 * balls and cones and the result looked like intersecting balls and cones -- a
 * lump at every join, a silhouette that stepped instead of tapering. A body is
 * one surface, so it is modelled as one surface.
 */
export interface PartSpec {
  readonly name: string;
  readonly attach: number | string;     // BONE index, or socket name
  readonly shape: 'hull' | 'box' | 'ball' | 'cone';
  readonly role: CoatRole;
  readonly size: readonly [number, number, number];   // full extents, world units
  readonly pos: readonly [number, number, number];
  readonly rot?: readonly [number, number, number];
  readonly mirror?: boolean;            // duplicate with z negated
  readonly rings?: readonly HullRing[]; // hull: the profile, along `axis`
  readonly axis?: 'x' | 'y';            // hull: which way the loft runs
  readonly smooth?: number;             // hull: sections per declared ring
  readonly paint?: readonly PaintBlob[];// surface regions in another role
}

/** One cross-section of a loft. `dx`/`dz` offset it, so a belly can bulge forward. */
export interface HullRing {
  readonly along: number;
  readonly rx: number;
  readonly rz: number;
  readonly dx?: number;
  readonly dz?: number;
}

/**
 * A region of a part's surface drawn in another role: every *face* whose centre
 * falls inside the ellipsoid takes `role` instead of the part's own.
 *
 * This is how a cow gets patches that lie *on* its skin. Modelled as another
 * ball pushed through the surface, a patch has to protrude to be visible, and
 * anything that protrudes is a lump rather than a marking. Painting costs no
 * geometry -- it splits the mesh into material groups -- and it is decided per
 * face rather than per triangle, or a marking's edge saws along the quad
 * diagonals and stripes where it crosses a ring.
 */
export interface PaintBlob {
  readonly role: CoatRole;
  readonly at: readonly [number, number, number];
  readonly r: readonly [number, number, number];
}

export interface CritterSpecies {
  readonly id: CritterId;
  readonly name: string;
  readonly blurb: string;                       // the picker's tooltip
  readonly metrics: FigureMetrics;              // proportions; same bone layout
  readonly sockets: readonly SocketSpec[];
  readonly parts: readonly PartSpec[];
  readonly defaultCoat: number;
  /** Roles pinned to a fixed colour regardless of the player's coat. */
  readonly accents: Partial<Record<CoatRole, number>>;
}

export const CRITTERS: Record<CritterId, CritterSpecies>;
export const CRITTER_IDS: readonly CritterId[];
```

`body.ts` holds the shared anatomy builders every species composes from —
`torso()`, `head()`, `muzzle()`, `bipedArms()`, `bipedLegs()`, `earPair()` — each
returning `PartSpec[]` from a profile and a few numbers. Profiles are given in
**world height at rest**, so a species writes "the belly is widest at y = 30" — a
number readable straight off a reference image — and the builder rebases it onto
the right joint. Adding a sheep is a new data file that calls the same builders
and adds its own head furniture; it touches no rendering code.

`palette.ts` holds the player coat swatches and the derivation from one picked
colour to the full role map:

```ts
export interface CoatSwatch { readonly id: string; readonly name: string; readonly hex: number; }
export const PLAYER_COATS: readonly CoatSwatch[];   // the 12 provided swatches
export function deriveCoat(species: CritterSpecies, coat: number): Record<CoatRole, number>;
```

### 2. `src/render/iso3d/critter.ts` — the rig

```ts
export class CritterRig implements SandboxUnit {
  constructor(species: CritterSpecies, opts?: { tuning?: CritterTuning; coat?: number });
  readonly group: THREE.Group;
  readonly orientsWithGroupYaw = true;
  get locomotionState(): string;
  setCoat(coat: number): void;      // live recolour, no rebuild
  jump(): void;
  update(dt: number, worldPos: Vec2, ry: number): void;
}
```

It builds a `Humanoid` on the species' metrics, hangs the species' parts off the
bones and sockets, and after each `Humanoid.update` drives the sockets from the
stride phase, speed and turn rate. Materials are per-rig instances (not the
shared `flatMaterial` cache) so `setCoat` can retint one critter without
touching every other object of that colour in the scene.

Two supporting changes to existing code, both narrowing rather than adding:

- `cloth/params.ts` gains `FigureTuning` — the five fields `Humanoid.update`
  actually reads (`bodyScale`, `strideScale`, `armSwing`, `jumpHeight`,
  `gravityMultiplier`) — and `RobeTuning extends FigureTuning`. `Humanoid` takes
  `FigureTuning`, so it no longer requires a robe to be posed.
- `Humanoid` takes an optional *dresser* callback for the visible geometry; the
  current robe body becomes the default. The skeleton, gait, colliders and jump
  are unchanged and stay shared.

`iso3d/motion.ts` is a small `MotionObserver` that turns the scene's
`(worldPos, ry, dt)` into the `GaitInput` the humanoid wants (smoothed velocity,
acceleration, turn rate, distance travelled, teleport rejection).

### 3. Sandbox wiring

`UnitKind` becomes `'spider' | 'walker' | 'robe' | CritterId`, so a new species
is a new unit in the picker for free. The movement sandbox gains a wrapping chip
row, a **coat swatch grid** shown while a critter is selected, and a critter
tuning section (body scale, stride, arm swing, ear floppiness, tail swish, hop
height). The rig-debug viewport accepts the same kinds and frames critters on
their own height.

## Invariants tested

Species data (pure, no GL):

- Every `PartSpec.attach` resolves: a valid `BONE` index or a declared socket
  name (including mirrored `…R` sockets). Every `SocketSpec.parentBone` is a
  valid bone index.
- **64 px legibility — geometry.** Every part's largest extent is ≥ 3 world
  units, i.e. at least ~2 px at unit scale. No sub-pixel detail ships.
- **64 px legibility — contrast.** For every species and *every one of the 12
  player coats*, each accent role actually used by that species differs from the
  coat in relative luminance by at least a fixed threshold — so a cow's patches
  and a pig's snout read on a pale coat and a dark one alike.
- **Silhouette.** Head width is at least 30 % of the body's widest point, and
  overall height falls inside the band that reads as a unit next to the scene's
  86-unit trees; the two feet are separated in z.
- `deriveCoat` is total (returns every role), stays in 24-bit gamut for every
  swatch, and orders `coatShade < coat < coatLight` in luminance.

Rig (three.js, headless, no canvas):

- Each species builds without throwing, produces one mesh per part (two per
  mirrored part), and every mirrored pair is a genuine z-mirror of its twin.
- Every hull lofts to within a bounded factor of the extent its own rings
  declare, so the derived `size` the legibility tests measure through cannot
  drift from the body actually on screen.
- No position buffer contains a non-finite value: the loft's spline can overshoot
  its control points, and one NaN takes a whole mesh off screen silently.
- A painted part's material groups tile its triangles exactly -- none undrawn,
  none drawn twice -- and every face's triangles land in the *same* group.
- `setCoat` retints painted (multi-material) meshes as well as plain ones.
- `setCoat` retints an existing rig in place — same mesh count, changed
  material colours — and never mutates the shared `flatMaterial` cache, so a
  recoloured pig cannot repaint the terrain.
- Driving a rig with a fixed input sequence twice produces identical socket
  rotations and bone matrices: the cosmetic layer is deterministic given
  `(dt, worldPos, ry)`.
- Walking advances the stride phase and reports `walking`/`running`, standing
  still reports `idle`, and the feet stay within a small band of the ground
  through a full cycle.

## Out of scope

- Replacing the player rig in the combat view (`scene.ts`). The critters are
  selectable in the movement sandbox and the rig-debug viewport; promoting one
  to *the* player character is a separate change, and nothing here blocks it.
- Cloth. Critters wear no garments; the robe keeps its own rig.
- Sim changes of any kind. This is entirely cosmetic — no new sim state, no new
  inputs, no effect on determinism of `src/sim` or `src/cards`.
- Per-part colour customisation. The player picks one coat; everything else is
  derived or is a species accent.
- Facial animation, blinking, and hand/finger detail — all of it invisible at
  64 px.
