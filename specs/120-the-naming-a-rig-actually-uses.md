# 120 — The naming a rig actually uses

## Problem

`naming` is a field on the skeleton document whose enum has one value:
`"mixamo"`. Every rig this project generates is asked for on the **`tripo`**
spec, and has been since `config.rigSpec` defaulted to it, for a reason written
down beside it: a rig built to the mixamo naming spec is refused by every
retarget call, so asking for mixamo names buys a skeleton no Tripo clip can be
bound to.

So the one value the format can express is the one value our rigs are never
built to. `skeleton-from-rig.ts` notices — it runs a name check, finds nothing,
warns *"the bone names do not look like the mixamo contract, so this is recorded
as mixamo anyway"* — and then writes `naming: "mixamo"`. The document asserts a
contract its own bones do not follow, and `npm run validate:units` passes,
because nothing checks the claim against the bones.

An inaccurate field would be a cosmetic problem if nothing read it. Three things
look bones up by mixamo name, and all three quietly degrade on every rig we
actually ship:

- **Sockets.** Derivation matches `RightHand`, `LeftHand`, `Spine2`, `Head`. The
  pig has `R_Hand`, `L_Hand`, `Spine02`, `Head`, so only `anchor.head` resolves
  and `pig.skeleton.json` ships `"sockets": []`. There is no `weapon.main` on
  the only unit in the game.
- **Facing.** `REQUIRED_BONES` is `hips, leftfoot, rightfoot, leftupleg,
  rightupleg`; the pig answers to none, so the facing probe falls back to its
  shape search and `handednessOk` goes null — left/right is never verified on
  the rigs where it is least obvious.
- **Bind pose.** `classifyBindPose` looks up `Arm`/`ForeArm`/`Hand` and returns
  `unmeasured`. The comment beside it already names the cause: *"the generated
  rigs are not on that contract: `L_Upperarm`, `L_Forearm`, `L_Hand` answer none
  of it."*

Each was found and documented separately, as a shrug in a comment. They are one
fault with one cause.

## What the rigs are actually named

Spec 117 recorded Tripo's vocabulary as `tripo::Root, tripo::Spine_0,
tripo::0_Left_Limb_0..6` — numbered limb chains of unequal length, *"with
nothing in the vocabulary saying which pair is legs"*, and concluded the only
way forward was to resolve sockets structurally.

That is not what the rigs come back as. The pig's 41 bones are:

```
Root, Hip, Pelvis, Waist, Spine01, Spine02, NeckTwist01..02, Head,
L_Thigh, L_Calf, L_Foot, L_ToeBase,   R_Thigh, R_Calf, R_Foot, R_ToeBase,
L_Clavicle, L_Upperarm, L_Forearm, L_Hand,   R_Clavicle, R_Upperarm, R_Forearm, R_Hand,
+ 16 twist bones
```

A named, sided, humanoid vocabulary — every role this format needs is stated by
the rig. So the expensive half of 117 is not required to address these rigs: a
second name table is. 117 remains the answer for a rig that names nothing, and
its rejection of *renaming bones to mixamo after the fact* still stands — the
topologies do not correspond, and a rename would produce a document that
validates and a skeleton that lies.

## Shape

**One module owns the vocabularies, and every by-name lookup goes through it.**

- `src/units/naming.ts`, pure: `NamingSpec = 'mixamo' | 'tripo'`, a canonical
  `BoneRole` set (hips, chest, head, the four limb chains, toes), the names each
  vocabulary gives each role, and `detectNaming`/`findRole` over them. Names are
  compared under one normalization, so `mixamorig:LeftHand`, `mixamorigLeftHand`
  and `LeftHand` are one bone said three ways.
- `naming` becomes a two-value enum in the schema and the type. The document
  records what the rig **is**, detected from its bones, not what was hoped for.
  When detection is certain the derived value wins; when no vocabulary matches,
  the spec the rig was asked for is recorded and the warning says so.
- Socket derivation, `facing.ts`'s bone lookup and `mesh-check.ts`'s arm and leg
  chains resolve by role instead of by mixamo name. Their diagnostics name the
  vocabulary they looked in rather than asserting mixamo.
- `biped-dev` — the reference mannequin — stays mixamo-named and stays its own
  family. It is the control the facing probe is calibrated against.

## Invariants tested

- The pig's skeleton detects as `tripo`, and the mannequin's as `mixamo`, off
  their real bone lists. Neither vocabulary's names resolve under the other.
- Socket derivation on the pig's rig yields `weapon.main`/`weapon.off` on
  `R_Hand`/`L_Hand`, `fx.body` on `Spine02` and `anchor.head` on `Head`; on the
  mannequin it yields the same roles on the mixamo bones the hand-authored
  document already names. Same roles, both vocabularies — that agreement is the
  check.
- `facing.ts` measures the pig by `names` rather than by `structure`, and
  `handednessOk` is no longer null on it.
- `classifyBindPose` returns a measured verdict for the pig instead of
  `unmeasured`.
- A skeleton document whose `naming` disagrees with its own bones is a
  validation error, so this cannot silently come back.
- Every existing test over the reference unit still passes unchanged.

## Out of scope

- Structural resolution for a rig that names nothing — spec 117 stands for that,
  and is what a future rig off both vocabularies needs.
- Non-biped rigs. A quadruped's four chains resolve differently and belong in
  their own spec.
- Anything at runtime *reading* the sockets this now derives. `UnitRig` still
  has no attach API and the wire still does not say what a unit is holding;
  putting a weapon in the pig's hand is a separate piece of work that this
  unblocks rather than does.
