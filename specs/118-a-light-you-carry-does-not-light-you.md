# 118 — A light you carry does not light you

## Problem

Spec 047 hung two `PointLight`s off the player: a torch at head height beside
the body, and an orb floating a little above it. Both were pointed at the world
and both also landed on the player, which is where they go wrong.

1. **The player is blown out.** A point light 13 units from a chest, tuned to
   still read on the ground 150 units away, puts a hard bright wash across the
   near flank of the body and leaves the far one black. The figure stops being
   the flat-shaded silhouette the whole look is built on and becomes a specular
   smear that changes shape as the flame gutters.
2. **The torch's brightest occluder is the person holding it.** The player's own
   body is the nearest thing to the flame, so the cube shadow map is mostly a
   silhouette of the player thrown across the ground they are standing on, in a
   direction that swings with the flicker. It reads as a second player made of
   shadow.
3. **The player goes dark when the light is *not* on them.** Simply excluding
   the body from the lights would leave it lit only by the moon at midnight,
   which is a figure you cannot see standing in a pool of light you can.

So the player wants the *fact* of carrying a light, not the light itself.

Everything here lives in `src/render/iso3d/`. No sim, no server, no game
outcome: the sim is not told any of it, and `presentation-only.test.ts` is the
existing assertion that keeps it that way.

## Shape

### The tint (`player-lights.ts`)

Pure, three.js-free and DOM-free, beside `torchFlicker` and `orbState`:

```ts
export interface TintSource {
  readonly color: number;       // 0xrrggbb, the light's own colour
  readonly brightness: number;  // what the panel's slider says
  readonly reference: number;   // the brightness that counts as "full"
  readonly intensity: number;   // the live flicker/pulse multiplier
}

export interface LightTint { readonly r: number; readonly g: number; readonly b: number; }

export function playerLightTint(sources: readonly TintSource[]): LightTint;
export const PLAYER_TINT_GAIN: number;   // lift per light at full brightness
export const MAX_PLAYER_TINT: number;    // per-channel ceiling
```

A **brightening filter, never a dimmer.** Each source's colour is normalised so
its largest channel is 1 before it is weighed in, and the weights are *added to*
1 rather than blended toward the colour. So no channel ever ends below 1: a deep
blue orb tints the body blue by lifting red and green less than blue, not by
taking red and green away. Blending toward a normalised colour would have made
the magic light a 40% dimmer on two channels, which is the opposite of what a
light is for.

`clamp01(brightness / reference)` caps each light's contribution at its default
brightness. Turning the torch up past its default lights the *world* harder,
which is what that slider is for; it must not keep lifting the player, because
the player has no falloff to absorb it and would simply clip to white.

`intensity` carries the flicker, so the body breathes with the flame instead of
sitting at a fixed offset next to a light that does not.

### The mask (`player-light-mask.ts`, new)

The three.js half, and the only place in the renderer that edits a shader
string. It attaches to whichever rig is the local player and does three things
to every **lit** material under it — the unlit `MeshBasicMaterial` pieces
(ground arrows, the flame core, the orb core) are left alone:

```ts
export class PlayerLightMask {
  /** Re-point at the rig that is the local player now; null detaches. */
  attach(root: THREE.Object3D | null): void;
  /** The brightening filter, written into a uniform every patched material shares. */
  setTint(tint: LightTint): void;
  /** Whether the player is drawn into point-light shadow maps at all. */
  setCastsPointShadow(on: boolean): void;
}
```

**Why a shader patch and not layers.** `Object3D.layers` looks like the answer
and is not: three 0.160 tests a light's layers against the **camera**
(`WebGLRenderer.projectObject`), never against the lit object, so a light is in
the frame or out of it and there is no per-object exclusion. The alternatives
are rendering the scene twice — which doubles the shadow pass for one rig — or
editing the one chunk that reads the point lights. The patch is two string
replacements against `THREE.ShaderChunk`, asserted by a test that fails if the
strings ever stop matching, which is the failure mode worth guarding.

Materials are patched **in place, not cloned**: every lit material under a body
is already private to that body — `attachHighlight` clones the shared
`flatMaterial` cache per rig, and `UnitRig` builds a fresh material per mesh per
load. Cloning again would leave the hover highlight writing emissive into a copy
nothing draws.

**Casting is `customDistanceMaterial`, not `castShadow`.** `castShadow` is per
object and would take the player out of the *sun's* shadow too, which is the one
shadow that should stay. `WebGLShadowMap.getDepthMaterial` reaches for
`object.customDistanceMaterial` only for point lights, so a distance material
with `colorWrite` and `depthWrite` off removes the player from the torch's cube
map and from nothing else. Layers cannot do this either — the shadow pass
layer-tests against the main camera, not the shadow camera.

The rig is re-scanned each frame. An authored unit's mesh arrives from a
`.glb` some frames after its body exists, so a scan done once at attach time
would mask a group that is still empty.

### Panel (`view-controls.ts`)

One new checkbox in the Player lights menu, under Torch:

```ts
readonly torchPlayerShadow: boolean;  // default false
```

`Torch shadows` keeps its meaning — whether the cube map is rendered at all —
and this says whether the player is drawn into it. Off by default, because the
player's silhouette swinging across their own feet is the artifact this spec
exists to remove; on for anyone who wants it back.

## Invariants tested

- `playerLightTint([])` is exactly `{1, 1, 1}` — no light on is no filter.
- Every channel of every result is `>= 1`: the filter only ever brightens. This
  is the headline assertion, and it is what tells a tint from a grade.
- A source's tint leans toward that source's hue — the torch lifts red above
  blue, the orb lifts blue above red — and the two together lean less far than
  either alone does.
- `brightness = 0` is the identity; brightness above `reference` gives the same
  tint as `reference` does, so the slider cannot blow the player out.
- Two lights lift more than one, and every channel stays at or below
  `MAX_PLAYER_TINT` however many are on.
- `intensity` scales the lift linearly, and a non-finite or negative input is
  treated as nothing rather than propagating a `NaN` into a material colour.
- The chunk the mask rewrites still contains the two markers it replaces, so a
  three.js upgrade that renames them fails a test rather than silently shipping
  a player lit by their own torch again.

## Out of scope

- Anything sim-visible. Nothing here reaches the server, and no `if` added by
  it changes a game outcome.
- Lights on anything other than the local player. Other players and monsters are
  not carrying one to be excluded from.
- The sun and the ambient fill, which light the player exactly as before.
- The magic orb's shadows. It has never cast any.
- The two tuning sandboxes, which have no player lights.
