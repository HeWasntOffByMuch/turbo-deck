# 117 — The rig names its own bones

## Problem

Spec 107 built the unit format on one sentence: *every unit shares the mixamo
bone contract*. `biped.skeleton.json` lists 25 mixamo bones, sockets address
`mixamorig:RightHand`, the family check compares a new rig against them, and the
export validates every generated unit against that document.

The service that makes our rigs will not animate such a rig:

> retargeting of Mixamo skeletons is not supported

A rig asked for with `spec: mixamo` is built, charged for, and then refused by
every retarget call. The two specs are not two spellings of one skeleton — they
are a choice, made at the rig call, between **Tripo's animation library** and
**Mixamo's**. A game needs clips, so the choice is `tripo`, and the bone names
that come with it look like this:

```
tripo::Root, tripo::Spine_0, tripo::Spine_1, tripo::Head_0..2,
tripo::0_Left_Limb_0..6, tripo::0_Right_Limb_0..5,
tripo::1_Left_Limb_0..2, tripo::1_Right_Limb_0..2
```

Numbered limb chains, of *unequal length between left and right*, with nothing
in the vocabulary saying which pair is legs. Nothing in this repository can
address that skeleton: not the sockets, not the family check, not the export,
not `unit-rig.ts`'s root-motion strip.

So the mixamo contract has to be replaced rather than patched around. It was
load-bearing and it is no longer available.

## Shape

**The family contract comes from a rig, not from a naming convention.**

`skeleton-from-rig.ts` already exists (spec 115) and already does the hard half:
it derives a skeleton document from a rigged `.glb` and fills in a provisional
family. The change is to stop treating mixamo as the *expected* answer:

- A new `biped-tripo.skeleton.json`, derived from a real rig rather than
  authored, becomes the family generated units belong to. `biped-dev` — the
  reference mannequin — stays mixamo-named and stays a *separate family*, which
  the format already supports and which keeps the control the facing probe needs.
- `sockets` stop being bone names in a document and become **roles resolved
  against the rig**: `weapon.main` is the tip of an arm chain, not
  `mixamorig:RightHand`. The resolution is `facing.ts`'s structural search,
  promoted from a diagnostic to a part of the format — legs are the two chains
  whose tips are lowest, arms are the other two, the tip of a chain is its
  effector.
- `validate.ts` checks the family a unit *claims*, and stops asserting mixamo
  names for every unit.

Explicitly rejected: **renaming the bones to mixamo after the fact.** Patching
`nodes[i].name` in the glTF JSON is cheap and safe — indices are what skins and
animation channels reference — but the topologies do not correspond. A mixamo
leg is `UpLeg → Leg → Foot → ToeBase → Toe_End`; this rig's is a chain of seven
on one side and six on the other. A rename would produce a document that
validates and a skeleton that lies.

## Invariants tested

- A unit generated on the `tripo` spec validates, exports, loads and poses —
  today it fails at the family check.
- Socket resolution finds the same bone on the reference mannequin as the
  hand-authored mixamo socket named, which is the check that the structural
  rule and the naming rule agree where both exist.
- Left and right resolve to the correct sides, measured against the mesh's own
  front rather than assumed from a bone name.
- The reference unit is untouched: it is authored, mixamo-named, its own family,
  and every existing test over it still passes.

## Out of scope

- Making the *facing* correct. That is a separate fault with a separate cause
  and it is not fixed by any of this; the gait mismatch is measured and open.
- Non-biped rigs. Quadrupeds resolve differently — four chains whose tips are
  all on the ground — and belong in their own spec once a biped works.
- Retargeting clips ourselves. Tripo's presets are what the roster is built on;
  authoring or remapping animation is a different project.
