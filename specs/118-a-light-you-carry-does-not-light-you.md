# 118 — A carried light, held farther off

## Problem

Spec 047 hung two `PointLight`s off the player: a torch at head height beside
the body, and an orb floating a little above it. Both are pointed at the world,
and both also land on the player — from about 26 world units away, on a body
about 46 units tall. At that distance a point light is not lighting a figure, it
is being held against one:

1. **The near flank is blown out and the far one is black.** Illuminance falls as
   `1/d²`, so with the flame a fraction of the body's own height away the chest
   receives several times what the far hip does. The torch is tuned to still read
   on the ground 150 units off, which means at 26 units it is delivering roughly
   twenty times the level the brightness slider names.
2. **The light direction fans right across the body.** The same 26 units means
   the vector to the flame points sharply up at the feet and sharply down at the
   head, so the shading has a hot spot in it that slides around as the player
   turns — a flat-shaded silhouette lit like a studio product shot.
3. **All of it moves with a slider that should not touch it.** `pointIntensity`
   scales candela with the *square* of the range (spec 047), so widening the
   torch's reach quietly multiplies what the body receives, and the player's own
   appearance is a side effect of a control about how far the light throws.

The fix is not to take the light off the player. It is to light the player from
**farther away**: same colour, same direction, same flicker, evaluated as though
the source were out at a sane distance instead of pressed against the ribs.

Everything here lives in `src/render/iso3d/`. No sim, no server, no game
outcome: the sim is not told any of it, and `presentation-only.test.ts` is the
existing assertion that keeps it that way.

## Shape

### The distance (`player-lights.ts`)

Pure, three.js-free and DOM-free, beside `torchFlicker` and `orbState`:

```ts
export const APPARENT_LIGHT_FRACTION: number;                 // 0.5
export function apparentLightDistance(range: number): number; // range * fraction
```

**Half the light's own range**, and that number is not arbitrary — it is the one
distance the panel already defines everything in terms of. `pointIntensity`
exists because the brightness slider means *"roughly this much illuminance at
half range"*, so lighting the body from there gives it exactly the level the
slider names, whatever the range is set to. Two things fall out for free:

- The reach slider stops doubling as a brightness slider **on the player**,
  which is the same coupling `pointIntensity` was written to remove everywhere
  else. Dragging the torch's reach from 80 to 900 changes how far the light
  throws and leaves the figure alone.
- The falloff across the body goes from severe to imperceptible. At 150 units
  the near and far sides of a 46-unit body differ by well under a stop, and the
  direction fans by a few degrees rather than a hundred.

The apparent position is only ever pushed *out*: `max(trueDistance, apparent)`,
so a light that is already far away is left exactly where it is rather than
being dragged in.

### The look (`player-lighting.ts`, new)

The three.js half, and the only place in the renderer that edits a shader
string. It attaches to whichever rig is the local player and does two things:

```ts
export class PlayerLighting {
  /** Re-point at the rig that is the local player now; null detaches. */
  attach(root: THREE.Object3D | null): void;
  /** The body's middle, in view space -- where the lights are measured from. */
  setAnchor(x: number, y: number, z: number): void;
  /** Whether the player is drawn into point-light shadow maps at all. */
  setCastsPointShadow(on: boolean): void;
}
```

**The patch is three lines inside the point-light loop.** `pointLight` is a
local copy in `lights_fragment_begin`, so moving its `position` before
`getPointLightInfo` reads it is the whole change: the light is re-sited along
the true direction from the body's anchor, out to `apparentLightDistance`, and
everything downstream — colour, decay, the range window, the shadow lookup —
runs unmodified against it. The shadow coordinate is built in the vertex shader
from the light's *real* position and is deliberately not touched, so the
silhouettes on the ground stay geometrically honest.

**Measured from one anchor, not per fragment.** The anchor is the rig's origin
lifted to the middle of the body, handed in as a view-space uniform — the same
space `pointLight.position` and `geometryPosition` are already in. Per-fragment
would put the apparent light in a slightly different place for every pixel,
which is the fan this spec is removing.

**Why a shader patch and not layers or a second light.** three 0.160 tests a
light's layers against the **camera** (`WebGLRenderer.projectObject`), never
against the object being lit, so there is no per-object light state to reach
for. A second, dimmer PointLight for the player alone would be lit by everything
else too, for the same reason. The two markers this replaces are asserted by a
test, so a three.js upgrade that renames them fails in Node rather than shipping
a player quietly lit the old way.

Materials are patched **in place, not cloned**: every lit material under a body
is already private to that body — `attachHighlight` clones the shared
`flatMaterial` cache per rig, and `UnitRig` builds a fresh material per mesh per
load. Cloning again would leave the hover highlight writing emissive into a copy
nothing draws. The rig is re-scanned each frame, because an authored unit's mesh
arrives from a `.glb` some frames after its body exists.

**Casting is `customDistanceMaterial`, not `castShadow`.** `castShadow` is per
object and would take the player out of the *sun's* shadow too, which is the one
shadow that should stay. `WebGLShadowMap.getDepthMaterial` reaches for
`object.customDistanceMaterial` only for point lights, so a distance material
with `colorWrite` and `depthWrite` off removes the player from the torch's cube
map and from nothing else. Layers cannot do this either — the shadow pass
layer-tests against the main camera, not the shadow camera.

### Panel (`view-controls.ts`)

One new checkbox in the Player lights menu, under Torch:

```ts
readonly torchPlayerShadow: boolean;  // default false
```

`Torch shadows` keeps its meaning — whether the cube map is rendered at all —
and this says whether the player is drawn into it. Off by default: the player is
the nearest thing to a flame they are carrying, so what it adds is mostly their
own silhouette thrown across the ground under their feet, swinging as the flame
gutters. On for anyone who wants it back.

## Invariants tested

Headlessly, in `player-lights.test.ts`:

- `apparentLightDistance` is a fixed fraction of the range, linear in it, and
  positive for a range of 0 or a non-finite one — a distance that reaches the
  shader as `NaN` does not throw, it paints the body black.
- **A body at the apparent distance receives exactly the brightness the slider
  names, at every range.** Composed from `pointIntensity`, which is what makes
  this the same statement the panel already makes: `pointIntensity(b, r)` over
  `apparentLightDistance(r)²` is `b`, for any `r`. This is the headline
  assertion and the reason the fraction is a half.
- The apparent distance is further than a carried light ever is, so the
  push-out is a push-out at every range the panel allows.
- The chunk the patch rewrites still contains the marker it replaces, so a
  three.js upgrade that renames it fails a test rather than silently shipping a
  player lit from point blank again.

The rest is only true once a browser has compiled the patched shader, so
`npx tsx scripts/preview-player-lights.ts` drives the built page at midnight and
asserts on its pixels — three.js logs a failed compile and carries on drawing,
which looks exactly like a patch that worked:

- Switching a light on brightens the body and leans it toward that light's hue:
  warm for the torch, cool for the orb.
- The body is **lit, not blown out**: no channel is pinned at the top of the
  range with the torch at its default.
- **Top and bottom of the body land within a narrow ratio of each other.** This
  is the uniformity the spec is named for, and the thing a point light at 26
  units cannot do.
- **Pulling the torch's reach in drops the ground and leaves the body where it
  was.** Reach and candela are the same number squared, so this is what says the
  body is being lit from the apparent distance rather than the real one.
- Ticking `Player casts torch shadow` visibly changes the ground around the
  player, and changes it by *taking light away*, while leaving the body's own
  shading alone.

## Out of scope

- Anything sim-visible. Nothing here reaches the server, and no `if` added by
  it changes a game outcome.
- Lights on anything other than the local player. Other players and monsters are
  not carrying one to be re-sited.
- The sun and the ambient fill, which light the player exactly as before.
- The magic orb's shadows. It has never cast any.
- The two tuning sandboxes, which have no player lights.
