# 115 — What the mesh itself says

## Problem

Every check this repo makes on a generated unit reads a *document*. The spec 107
validator reads JSON. The spec 113 bake reads a `.glb`'s JSON chunk and counts
an accessor's `count` — it has never looked at a vertex. So the failures that
actually happen to a generated rig are the ones nothing can see:

- weights that do not sum to 1, so the mesh shrinks toward the origin as it
  poses;
- a vertex bound to more than four bones, which the runtime silently truncates;
- a vertex bound to nothing, which stays in bind position while the body walks
  away from it;
- a bind pose that is the *idle*, not a T or A — the single most common thing
  wrong with a generated rig, and the reason "the animations twist the body and
  legs into odd shapes";
- deformation that only collapses at the extremes of the range the clips
  actually use.

All five are visible in the vertex data. None of them is visible in a schema.
"The mesh looks fine standing still" is exactly how each of them ships.

## Shape

A binary reader, pure, `src/units/glb-read.ts`:

```ts
export interface GlbBinary { readonly json: Record<string, unknown>; readonly bin: Uint8Array }
export function splitGlb(bytes: Uint8Array): GlbBinary;
/** An accessor's data, de-interleaved and de-normalized to Float32 (or the integer type for JOINTS_n). */
export function readAccessor(glb: GlbBinary, index: number): Float32Array | Uint32Array;
export function readSkinnedMesh(glb: GlbBinary): SkinnedMeshData | null;   // positions, normals, joints, weights, indices, jointNodes
export function readNodeTree(glb: GlbBinary): readonly GlbReadNode[];      // name, parent, TRS, world matrix
```

The checks, pure, `src/units/mesh-check.ts`, returning the existing `Issue`
shape so they print through `formatIssue` like every other finding:

```ts
export function checkSkinning(mesh: SkinnedMeshData): readonly Issue[];
export function classifyBindPose(nodes, skeleton): BindPoseVerdict;   // 'T' | 'A' | 'posed'
export function checkDeformation(mesh, nodes, poses): readonly Issue[];
```

and the extreme poses themselves as data — a small table of joint rotations at
the limits the clip vocabulary reaches (arm fully back and fully through, knee
fully bent, spine twisted), applied with linear blend skinning in
`src/units/skin.ts`.

Wired into `npm run bake:units`, which already opens every mesh. A skinning or
bind-pose error fails the bake; a deformation finding warns, because a lumpy
elbow is a judgement and a build should not be the one making it.

Plus `npx tsx scripts/preview-deform.ts`, which photographs the extreme poses
into `.claude/screenshots/deform.png`. The numbers are the gate; the picture is
how a person decides whether a warning matters.

## Invariants tested

- Weight sums outside `1 ± 1e-3` are found, per vertex, and reported with the
  worst offender's index and sum rather than a count.
- A `WEIGHTS_1`/`JOINTS_1` attribute set is refused: glTF's `VEC4` makes four
  bones structural, so a fifth influence can only arrive as a second set, and
  the runtime drops it silently.
- A joint index outside the skin's joint list is an error, not a clamp.
- A vertex with every weight zero is found (it never moves), and so is a vertex
  no triangle references (it is not drawn, and it drags the bounding box).
- `classifyBindPose` returns `T` for arms within 25° of horizontal, `A` for
  arms 25–60° below, and `posed` for anything else — including the case that
  matters, arms hanging at the sides with bent elbows, which is an idle.
- A left/right asymmetry beyond a few degrees is reported even when the pose
  classifies, because a mirrored rig that is not mirrored is a retarget that
  will lean.
- Skinning is exact for the identity pose: posing a mesh at bind reproduces its
  bind positions to float tolerance. This is the property that makes every
  deformation number below meaningful.
- At each extreme pose: no triangle's winding inverts relative to bind, the
  mesh's volume stays above a fraction of its bind volume, and no vertex
  travels beyond a multiple of the rig's height.
- The reference unit passes all of it. It is a real skinned biped authored at a
  T pose, so a check that fails on it is a check that is wrong.

## Out of scope

- Decimation, meshopt and KTX2. Still deferred, still for want of a chosen
  dependency; this reader makes *reading* a mesh possible, not rewriting one.
- Texture and material checks. A generated unit's texture is a picture, and
  nothing here can say whether it is the right one.
- Screenshot *baselines* — committed reference images compared pixel-wise. The
  deform script writes a picture to look at; making it a diff gate needs a
  stable rasteriser and is its own spec.
- Reading a `.glb` at runtime. three's `GLTFLoader` is still the only loader in
  the browser; this is a build-time and test-time reader.
