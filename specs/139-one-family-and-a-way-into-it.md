# 139 — One family, and a way into it

## Problem

A rig family is the unit format's central idea — one skeleton, one clip library,
N bodies — and until the fox arrived no second body had ever joined one. Three
things had quietly grown around the assumption that a unit owns its clips.

The **names** stopped describing anything. The family every shipped character
animates on is called `pig`, which reads as a species and is now also worn by a
fox. The name `biped` is held by an unused 25-bone mixamo document whose bind
pose was never measured, and `biped-dev` by the reference mannequin — so the one
word that should name the real family names two documents that are not it, on a
naming convention this project does not generate.

The **layout** put a family's shared assets inside one member's folder, so the
second member reached sideways into `pig_a_pose_full/clips/` for animation it
co-owns. That is what made `unit-assets.ts` resolve clip paths against the wrong
directory: for as long as those two folders were the same one, nothing could
tell that it was resolving against the unit rather than the library.

And the **Studio preview** builds its clips from `job.artifacts.clipGlbs` alone.
A job that establishes a rig and buys no retarget has none, so the preview mounts
a motionless body — the exact case a family exists to serve, and the one the tool
cannot show. Adding a body to a family is currently a hand-edit of a generated
JSON document against a contract nobody can see, which is how the fox shipped
pointing at a clip library that did not exist.

## Shape

**One family, named for what it is.** `pig` becomes `biped`; the unused mixamo
`biped.skeleton.json` is deleted rather than renamed, because it describes a
contract no rig in this repo has ever met. The reference mannequin's family
becomes `mannequin-dev`, so `biped` is unambiguous and the fixture survives.

**Shared assets live at family level**, one directory above the units:

```
assets/units/
  biped.skeleton.json          the contract
  biped.core.cliplib.json      the clips every member plays
  clips/*.glb
  <unit>/<unit>.unitdef.json   a member: its mesh, its machine, and two refs
  <unit>/<unit>.glb
```

A unit folder holds only that unit. Nothing reaches sideways, because there is
no sideways left — a member reaches *up*, which is what membership is.

**A family is addressable.** `src/render/iso3d/world/unit-assets.ts` grows

```ts
export interface FamilyAssets {
  readonly id: string;                              // "biped"
  readonly clipLib: ClipLib;
  readonly clipUrls: Readonly<Record<string, string>>;
}
export function familyAssets(id: string): FamilyAssets | null;
```

derived from the same manifest and the same glob the units come from, so the
family's clips are reachable without naming a member. The Studio preview uses a
job's own retargeted clips when it has them and the family's when it does not,
which is what makes a rig-only job previewable.

**A way in.** `scripts/add-unit.ts`:

```sh
npx tsx scripts/add-unit.ts <rigged.glb> --id <unitId> [--family biped]
```

reads the rig, derives its skeleton with `skeletonFromRig`, holds it against the
family with `compareToFamily`, and refuses on a missing bone — the clips drive
bones by name, and a rig short of one is a clip set applied to nothing. On a
pass it measures the import scale against the family's canonical height, writes
`<unitId>/<unitId>.unitdef.json` pointed up at the family with the family's own
state machine, and re-bakes the manifest. It composes existing pure functions;
none of them had a caller outside the Studio service.

## Invariants tested

- Every authored unit resolves every clip its library lists. A unit whose clips
  live in another directory resolves exactly as many as one whose clips sit
  beside it — the property that would have caught the fox's empty clip set.
- `familyAssets` returns the same clip set for a family regardless of which
  member asked, and `null` for a family id nothing declares.
- Path resolution flattens `.` and `..` before matching, so a reference relative
  to the document that made it resolves from any depth.
- `add-unit` refuses a rig missing a family bone, and names the bones; it
  accepts a rig with extra bones, and says which will not be driven.
- The unitdef `add-unit` writes validates under `npm run validate:units` with no
  errors, and the import scale it computes puts the body within a tolerance of
  the family's canonical height.
- The Studio preview mounts a clip set for a job with no retargeted clips of its
  own, and prefers the job's own clips when it has them.

## Out of scope

- **The proportion problem.** A family's clips carry constant translation on
  every non-root bone, so a member is drawn with the family's bone lengths
  rather than its own — 20 of the fox's 39 differ by more than 5%. Real, and a
  change to a documented rule in `root-motion.ts`; it gets its own spec.
- Buying a retarget from `add-unit`. This script spends nothing and touches no
  API; a unit that wants clips of its own goes through the Studio.
- The mannequin's mixamo contract. `mannequin-dev` is renamed and otherwise left
  alone — it is the pipeline's only free test subject and it works.
- Sockets. `biped.skeleton.json` ships `"sockets": []` and derives none; that is
  spec 120's open thread and is not made worse or better here.
