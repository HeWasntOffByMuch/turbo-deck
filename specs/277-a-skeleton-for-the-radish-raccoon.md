# 277 — A skeleton for the radish raccoon

## Problem

`assets/units/radish_raccoon_2/` is a generated model with an auto-rig that
cannot be used. Tripo returned the `biped` family's 41 bones, and measured off
the file the right leg is not in the animal: `R_Calf` sits at x -0.325 and
`R_CalfTwist01` at -0.326, on a body whose widest point is 0.497 and whose right
foot is at 0.235. The knee is a body's width outside the creature, out where the
tail is. `scripts/bake-units.ts` refuses the unit on a second count as well --
`mesh.bindpose.posed`, elbows bent 69 degrees against a straight 180, sides
disagreeing by 58 -- so the rest pose is somebody's idle rather than a bind pose
and every clip retargeted onto it would inherit that idle's offsets.

Neither is a surprise and neither is fixable by re-generating. A humanoid
auto-rig looks for a humanoid, and this animal is a sphere with three leaves in
it: no visible legs, arms that are mittens stuck to its front, a tail longer
than its body, and ears. There is nothing limb-shaped for the rigger to find, so
it puts the chain where the silhouette is widest.

What is wanted is a body that can walk and stand about: a rig for *this* animal,
and the two clips that make it look alive.

## Shape

A new rig family, `radish_raccoon`, alongside `biped` rather than inside it --
`compareToFamily` would reject a 31-bone rig against a 41-bone contract on every
count, correctly, and the biped's clip library animates bones this creature does
not have.

**`src/units/radish-raccoon-rig.ts`** — the bone table. 31 bones: `Root`, `Hip`,
`Spine01`, `Head`, two ears, a `Crown` with three two-bone leaves under it, a
four-bone tail, two three-bone arms and two four-bone legs. Every rest position
is measured off the mesh. Plus `MESH_OFFSET`, the XZ shift that stands the
animal over its own feet, and `CHAIN_TIPS`, the measured tip each open chain
points at.

```ts
interface RigBone { name: string; parent: string | null; rest: Rest; part: PartId }
const RADISH_RACCOON_BONES: readonly RigBone[]
const MESH_OFFSET: Rest
const CHAIN_TIPS: Readonly<Record<string, Rest>>
```

**`src/units/radish-raccoon-skin.ts`** — the skin, in three passes: label every
vertex with a part, weight it along that part's own bone chain, then relax the
whole weight field over the mesh's welded surface graph so a hard label becomes
a soft seam.

```ts
function isGreens(p: Vec3): boolean
function labelOf(p: Vec3): PartId
function buildSkin(mesh: SkinMeshInput, offset: Rest): SkinResult
```

**`src/units/radish-raccoon-clips.ts`** — `run` (600ms) and `idle` (4800ms), as
functions of the cycle phase rather than as lists of keys.

**`clip-author.ts` gains `PoseKey.bones`** — a second, optional turn table keyed
by the rig's own bone names, beside the existing role-keyed one. The tail, the
ears and the leaves are real bones the biped vocabulary has no role for.
`pose.ts`'s `turnQuat` splits into a lookup plus `turnQuatOn`, which is every
line of the existing arithmetic with the role resolved out of it.

**Scripts.** `make-radish-raccoon.ts` writes the rigged `.glb` and derives
`radish_raccoon.skeleton.json` from it; `make-radish-raccoon-clips.ts` writes
the two clip `.glb`s and `radish_raccoon.core.cliplib.json`;
`preview-radish-raccoon.ts` photographs the parts, the rig and the clips.

## Invariants tested

- Every bone's parent precedes it, there is exactly one root, and every `L_`
  bone has an `R_` mirror — so the derived skeleton document validates.
- The rig answers to the `tripo` vocabulary: all seven signature roles resolve,
  so `detectNaming` claims it rather than returning `unknown`.
- The bind pose classifies as `T` or `A` with both elbows and both knees within
  a degree of straight and the two sides within the symmetry tolerance.
- Every vertex's weights sum to 1 and name only bones that exist; no vertex is
  left bound to nothing.
- The relaxation actually relaxes: a measurable share of vertices are shared
  between parts, and a measurable share still ride one bone. Both extremes are
  failures — all-shared is mush, none-shared is a tear.
- A part's bones only ever hold vertices that part labelled: no leaf vertex
  carries head weight and no tail vertex carries hip weight beyond the seam.
- Both clips close: the pose at phase 0 equals the pose at phase 1, bone for
  bone, so neither hitches on the wrap.
- Neither clip writes a translation channel, on any bone — the server owns where
  a body is.
- `run` alternates: the two feet are never at the top of their lift at the same
  time, and each leaves the ground once per cycle.
- `idle` steps: each foot lifts clear of its rest height at least once, on a
  different beat from the other.
- The ear flick is a flick: it lasts under a fifth of a second, it happens twice
  a cycle on different ears, and the ear is still for most of the clip.
- `PoseKey.bones` is additive: every existing clip authored without it produces
  byte-identical output.

## Out of scope

- **Wiring it to a monster.** Nothing in `data/monsters.ts` or
  `unit-catalog.ts` names this unit; it is reachable from `?units=<type>:radish_raccoon_2`
  and from the preview. Giving it a row is a content decision with a temperament,
  an idle plan, a loot table and a spawner behind it, and it is not this spec's.
- **A death clip, a hurt clip and an attack.** The state machine declares
  `speed` and nothing else, deliberately: `driveUnit` writes a parameter only if
  the document declares one, and a `dead` parameter with no terminal state
  behind it is a socket with nothing plugged into it.
- **A walk.** Two clips is what the blend tree has, so it reaches `run` at 40
  rather than at the biped's 150. A middle gait is a third clip and a threshold.
- **A third naming vocabulary.** The rig is named to the `tripo` contract where
  a role exists, because a rig on neither vocabulary silently loses its sockets,
  its facing measurement and its bind-pose check. The bones with no role are
  posed by name instead of being given invented roles that exactly one family
  could ever resolve.
- **Re-generating the mesh.** The sculpt's own asymmetries -- one paw tucked in,
  one out; a tail swept to the right -- are kept and the rig is built around
  them.
