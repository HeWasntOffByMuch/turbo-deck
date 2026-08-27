# 230 — A cast that lands on its own wind-up

## Problem

Every spell in the game is drawn as a sword chop. `attackTriggerFor` has two
answers -- `shoot` for an ability that puts an arrow in the air, `attack` for
everything else -- so Quake, Mend, Blight, Arc Lash, Rime Touch, Scorched Earth
and Drain are all a pig swinging a blade overhead. Spec 164 fixed exactly this
for the bow and left the other half of the roster where it was: a level-6 sigil
and a basic attack look identical, and the wind-up this whole game is built on
-- the thing an opponent is supposed to read and act inside -- says the wrong
thing about what is coming.

There is a second problem underneath it, and it is the one that decides the
shape of this spec. `slash` and `shoot` were each authored for **one** ability,
so each clip's own beat *is* that ability's wind-up and `attackRate` -- the
ratio of the authored wind-up to the one the sim is running -- is already the
right playback rate. A cast clip is the first clip in this tree that is
**shared** across abilities whose wind-ups differ by nearly three to one
(`channel.drain` at 0.5s against `ground.quake` at 1.4s). Authored at one length
and played at rate 1, it would draw the hands coming forward half a second after
Quake had already landed, and a third of the way through Drain's.

## Shape

### The clip

`src/units/pig-cast.ts`, in the register of `pig-strike.ts` and `pig-shot.ts`: a
table of key poses in the body's own axes, sampled at 60Hz by `clip-author.ts`,
written to `assets/units/clips/cast.glb` by `scripts/make-pig-cast.ts` and
reviewed as a diff of the table rather than as a blob of bytes.

```ts
export const CAST_CLIP_ID = 'cast';
export const CAST_DURATION_MS = 1250;
export const CAST_RELEASE_MS = 850;
export const CAST_KEY_MS = { ready: 0, gather: 260, focus: 620,
                             release: CAST_RELEASE_MS, follow: 950,
                             settle: CAST_DURATION_MS };
export const PIG_CAST: AuthoredClip;
export const CAST_EVENTS: readonly ClipEvent[];  // swing.start, swing.impact
```

The action is: hands swept in to the chest, a coil that creeps rather than
freezes, and both arms thrown forward on the release frame. Legs and hips are
`STRIKE_GUARD_LEGS` plus the shot's own 8-degree hip, identical in every key --
the shot's rule, and it buys the same property for free, which is that a clip
that never moves a hip cannot slide a foot and so needs none of
`plant-foot.ts`.

**`CAST_RELEASE_MS` is derived, not chosen.** The clip has to cover every cast
wind-up in the table within the pig's `maxTimeScale` of 2, which puts the
authored release in `[0.5 * 1400, 2 * 500] = [700, 1000]`ms. The value that
minimises the worst stretch over that span is the geometric mean,
`sqrt(500 * 1400) = 837`ms; 850 is the nearest point on the 50ms grid both other
authored clips are already on, and it is a whole 60Hz sample of a 1250ms clip.
Worst stretch at 850 is **1.70x**, against a bound of 2.

The **400ms recovery** after it is longer than either other clip's and was
measured rather than picked. A cast's hands travel further coming home than
going out -- the push starts from the chest, which is already half way -- so at
the swing's 300ms the settle came back **four times faster than the extension**,
which reads as the body being yanked rather than as a follow-through. Two things
fix it together: a `ready` pose with the hands already up in front rather than
at the idle's own hanging position, and this.

### Which abilities are cast rather than swung

An optional presentation field on the ability row, in the same register as
`ProjectileLook` and for the same reason -- it is a picture and nothing more,
nothing under `src/server/sim/` reads it, and it rides no wire:

```ts
export type CastLook = 'focus';
readonly castLook?: CastLook;   // on AbilityDefinition
```

A field on the row rather than a list of ids in the renderer, because
`attackTriggerFor` already states that rule: *"a fact read off the content table
rather than a list of ids to keep in sync with it."* A new spell says what it
looks like in its own row and nothing else is edited.

It has to be authored rather than derived, and that is the finding worth
writing down: **there is no mechanical fact that separates a spell from a
weapon skill here.** `skill.whirlwind` and `skill.rimeTouch` are both
`kind: 'area'`, both `targeting: 'self'`, both a circle on the caster's own
feet, and one is a blade going all the way round while the other is cold coming
off the ground. Whether a body focuses or swings is a fact about the picture.

Seven rows take it: `ground.quake`, `self.mend`, `skill.blight`,
`skill.arcLash`, `skill.rimeTouch`, `skill.scorchedEarth`, `channel.drain`.

### The trigger and the rate

`DRIVEN_PARAMETERS.cast`, a third trigger beside `attack` and `shoot`, reached
through the same `triggerFor` fallback -- a unit that declares no `cast`
parameter keeps the swing, which is spec 164's rule and its reason: *a silently
dropped trigger is a body standing perfectly still through its own attack.*

The rescale is one exported function and one multiply:

```ts
export function clipStretch(trigger: string, abilityId: string | null): number
```

1 for every clip authored for a single ability -- the swing and the draw, whose
own release *is* that ability's wind-up -- and `CAST_RELEASE_TICKS /
ability.windupTicks` for the cast, so

```
rate = attackRate * clipStretch = (authoredWindup / span) * (clipRelease / authoredWindup)
     = clipRelease / span
```

which is the sentence the whole spec is about: **the clip's own release lands on
the tick the sim resolves the spell**, whatever ability it is and whatever a
status did to that ability's wind-up. It is applied only where the trigger
actually resolved to `cast`, so a unit that fell back to the swing is driven at
exactly the rate it is driven at today.

### The documents

`biped.core.cliplib.json` gains the `cast` clip; `pig_a_pose_full.unitdef.json`
gains a `cast` trigger parameter, a `focus` state on it (`oneshot`, 60ms blend,
for the reason `swing` is one rather than `locking`), a `* -> focus` transition,
and a `spell.cast` action timing so the Studio timing panel can play it.

## Invariants tested

- The release is on `CAST_RELEASE_MS` and `CAST_EVENTS`' `swing.impact` is at
  `CAST_RELEASE_MS / CAST_DURATION_MS`; the committed `cast.glb` is what this
  table samples to, frame for frame.
- Every ability carrying a `castLook` is inside the pig's `maxTimeScale` at
  `CAST_RELEASE_MS` -- so a new spell authored outside the window fails a test
  rather than shipping as a twitch or as slow motion.
- The hands come **in** to the chest and get **closer together** through the
  gather and the coil, and are **further from the chest at the release than at
  any earlier frame**.
- The extension is the **fastest movement of the cast**, and the recovery is
  never faster than it -- which is the bound the 400ms settle exists to meet,
  asserted against the extension's own measured peak rather than against a
  number somebody typed.
- Both hands end the release ahead of the chest, in front of the body -- the
  arms extend forward rather than up or out -- and the follow-through leaves
  them further out and further **apart** than the release did.
- The coil creeps rather than freezing: some movement on every frame between
  `gather` and `release`, and none of it a quarter as fast as the extension.
- The torso **uncoils** through the release: it leans further forward than the
  ready pose at the coil and further back than it at the release. Where
  `pig-shot.ts` keeps its chest turning the same way through the loose, a cast
  is thrown by the body opening.
- The release lands on a sampled frame rather than between two, so the pose on
  the frame the spell exists is the authored pose.
- No foot moves on any frame, and the legs are the ones the swing and the draw
  stand on.
- The clip begins and ends in the same pose, so a cast thrown at the end of a
  cast has nothing to jump over.
- `attackTriggerFor` answers `cast` for a row with a `castLook` and is unchanged
  for every other row; a unit with no `cast` parameter falls back to `attack`.
- `driveUnit` enters the `focus` state on the tick a spell's cast begins, and
  the `swing.impact` event fires on the tick the sim resolves it -- asserted for
  the shortest and the longest cast in the table, which is the rescale.
- `clipStretch` is exactly 1 for the swing and the draw.

## Out of scope

- **The other rigs.** The pig is the only unit with authored clips and it is
  what the player is drawn as, so it is the only one that gets this. The
  mannequin and the fox fall back to the swing, unchanged.
- **A channel that is drawn while it channels.** `channel.drain` gets its cast
  drawn and then returns to the loop while the drain pulses for two more
  seconds. Drawing the channel itself needs a looping state entered from a
  one-shot and left on a replicated fact, which is a machine change rather than
  a clip.
- **`self.hearthdraught`.** A draught is a drink, not a spell, and neither the
  chop it draws today nor a focus is right for it. Spec 164's rule applies --
  *a wrong animation is worse than a generic one* -- so it keeps what it has.
- **The turn before the cast.** `startedCasting` fires on `CastPhase.Turning`,
  so a cast that has to come round first starts its clip before its wind-up
  does. That is the swing's behaviour too, it is what spec 065 costs, and
  re-triggering at alignment would restart the clip mid-cast.
- **`skill.poisonDart`'s draw.** It carries `look: 'arrow'`, so it plays the
  1150ms `shoot` clip against a 0.4s wind-up, unrescaled -- the same class of
  mismatch this spec fixes, one clip over. Fixing it means rebasing the draw as
  well, which changes an animation nobody asked about; measured and left.
- **A runtime clamp on the rate.** The bound is a test on the authored rows, not
  a clamp in the driver: a clamp would hide the one case the test exists to
  catch.
