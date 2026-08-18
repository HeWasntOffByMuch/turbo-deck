# Project delivery benchmark (specs 001–167, 2026-07-06 → 2026-08-17)

A benchmark of how effectively this project has progressed, scored against the
code, the tests and the commit record rather than against how confident anybody
sounded at the time. Full report, with the narrative analysis and the
failure/rework breakdown, is published as an artifact:
<https://claude.ai/code/artifact/7939ed4e-0cc1-47eb-a80e-32e9dbdbc993>

## The dataset, and what is missing from it

**No conversation transcripts exist for this project.** The container is cloned
fresh, `~/.claude/projects/` holds only the audit session itself, and all 89
pull requests carry zero comments and zero review threads. Nothing preserves
what was said.

What stands in for it is unusually good, and it is a property of this repo's own
workflow: 209 committed specs whose Problem sections narrate what went wrong and
sometimes quote the report verbatim, 422 commits whose messages describe why,
and a CLAUDE.md that documents rules alongside the mistakes that produced them.
Every conclusion about *conversational* dynamics — how often the assistant was
challenged, whether it ever abandoned a correct answer under pressure — is a
reconstruction from that record and is marked as such. Every conclusion about
*outcomes* rests on documents and on a live run of the gates.

The clone is also shallow (local history reaches 2026-08-07); everything earlier
came from the GitHub PR record and the spec files, which are all present.

## Final state, measured

| Gate | Result |
|---|---|
| `npm test` | 4,991 passed / 274 files, 0 failures |
| `npm run typecheck` | clean |
| `npm run lint` | clean |

## Headline metrics

Computed by script from the ledger below, so the tables cannot disagree.

| Metric | Result | n |
|---|---:|---:|
| Distinct tasks | 111 | — |
| Eventual success | 92.8% | 103/111 |
| Partially solved | 4.5% | 5/111 |
| Regressed / superseded | 2.7% | 3/111 |
| Not solved | 0 | 0/111 |
| First-attempt success | 66.7% | 74/111 |
| Average attempts | 2.04 | 226/111 |
| Median attempts | 1 | 111 |
| Rework rate | 41.4% | 46/111 |
| Reverted / abandoned approaches | 7.2% | 8/111 |
| Rework from requirement change | 10.8% | 12/111 |
| Corrective specs (conservative floor) | 33.0% | 69/209 |
| Orphan-subsystem discoveries | 13 | 13/209 |
| Duplicate spec numbers | 35 | 35/167 |
| User challenges | 64 | — |
| Correct user pushback | 59 | 59/64 |
| Incorrect / unnecessary pushback | 3 | 3/64 |
| **User pushback precision** | **95.2%** | 59/62 |
| Assistant self-corrections | 32 | 0.29/task |

**Effectiveness ≈ 86/100. Efficiency ≈ 57/100.** High-effectiveness,
low-efficiency: the work reliably arrives, expensively, and the expense is
concentrated in one fixable place.

## The finding that matters

Three of the top four root causes — 34 of 78 attributable rework events, 44% —
are the same failure wearing different faces: **work was declared done on the
strength of a green test suite that could not observe the thing the work was
for.** Not one is an implementation-quality problem. The code was right; the
definition of "finished" was wrong.

The sharpest instance is spec 165, which found that spec 140's entire held-object
format — document, canonical weapon space, three-node rig, calibrated socket, a
full green suite — had been *called by nobody* for 25 specs while every player was
drawn empty-handed. The same shape produced specs 052, 053, 111, 131, 134, 147
and 164. The check that finds it is one `grep -rn` for the new symbol under
`src/render`, and it was only ever run retrospectively.

The second most expensive pattern is partial diagnosis. Spec 090 records four
consecutive reports each following a failed fix, and spec 092 opens: *"This is
spec 090's opening report, still alive after four fixes."* Withdrawing from a
wind-up — the decision this game is built on — took roughly eleven spec-passes
across 079, 080, 088, 090, 091, 092, 094, 144, 155, 166 and 167. Each fix was
locally correct; none addressed the whole client/server/renderer seam.

## Trend

| Phase | Span | Tasks | Success | First-attempt | Rework | Self-corr./task |
|---|---|---:|---:|---:|---:|---:|
| P1 prototype, renderer, editor | Jul 6 – Aug 5, PR 1–29 | 45 | 89% | 76% | 33% | 0.13 |
| P2 server combat, look, units | Aug 5 – Aug 12, PR 30–64 | 39 | 95% | 59% | 46% | 0.26 |
| P3 GUI, multiplayer, RPG, anim | Aug 12 – Aug 17, PR 65–89 | 27 | 96% | 63% | 48% | 0.59 |

Controlled for difficulty (High + Very-high only), first-attempt success falls
monotonically: **67% (10/15) → 50% (11/22) → 36% (5/14)**. Self-correction rises
4.5×. Those two are the same shift, not a contradiction: as the codebase grew
past 200k lines the assistant stopped getting hard things right first and got
much better at noticing that it hadn't. Quality holds; cost rises.

The pattern that *was* learned: asserting a fact where a measurement was
available (`forwardAxis`, mixamo bone names, root-motion location) recurs through
P1 and early P2 and then stops after spec 120, converted into `facing.ts`,
`naming.ts`, `pose.ts` and `probe-travel.ts`. It does not recur.

The pattern that was **not** learned: "built but not wired" is first diagnosed at
specs 052/053 and then recurs six more times, the last in the final week.

## Task ledger

Attempts count distinct solution passes on one underlying problem; a planned
follow-up spec inside one brief counts as a pass, which is why designed arcs
(the GUI framework at 15, the hike look at 10, multiplayer at 9) read high. The
mean drops from 2.04 to 1.62 excluding six such arcs, and the median of 1 is the
more honest central figure.

| # | Task | Type | Difficulty | Outcome | Attempts | Challenged | Pushback correct? | Reverted | Confidence |
|---|---|---|---|---|---:|---:|---|---|---|
| T01 | Spec-first pipeline + CI | Build | Med | Solved | 1 | — | — | — | High |
| T02 | Card deck engine | Feature | Med | Solved | 1 | — | — | — | High |
| T03 | Combat sim core (1D) | Feature | High | Partial | 2 | — | — | — | High |
| T04 | Sim-card integration | Feature | Med | Solved | 1 | — | — | — | Medium |
| T05 | Pixi renderer + input | Feature | Med | Solved | 1 | — | — | — | Medium |
| T06 | Balance harness | Testing | Med | Solved | 1 | — | — | — | High |
| T07 | Top-down 2D combat rewrite | Arch | High | Solved | 1 | — | — | — | High |
| T08 | Readability and commitment | UIUX | Med | Solved | 1 | — | — | — | Medium |
| T09 | Emergent modifiers replace synergies | Arch | High | Solved | 1 | — | — | — | Medium |
| T10 | Juice windup sprites | UIUX | Med | Solved | 1 | — | — | — | Medium |
| T11 | Deterministic dude baker | Feature | Med | Solved | 1 | — | — | — | Medium |
| T12 | Enemy population + camera | Feature | Med | Solved | 1 | — | — | — | Medium |
| T13 | Balatro card hand + card VFX | UIUX | Med | Solved | 2 | — | — | — | Medium |
| T14 | Poker-combo design prototype | Research | Med | Solved | 1 | — | — | yes | Medium |
| T15 | Retro audio + themes | Feature | Med | Solved | 3 | 1 | all correct | — | Medium |
| T16 | Four-card poker + enemy cones | Tuning | Low | Solved | 1 | 1 | all correct | — | Medium |
| T17 | Wave speed scaling | Tuning | Low | Solved | 1 | — | — | — | Medium |
| T18 | Spell-card pivot | Arch | High | Solved | 1 | — | — | yes | High |
| T19 | Wave rewards + fire kit | Feature | Med | Solved | 2 | 1 | all correct | — | Medium |
| T20 | Adrenaline economy | Design | Med | Solved | 3 | 2 | 0 of 2 | yes | Medium |
| T21 | Arena character skins | UIUX | Low | Solved | 1 | — | — | — | Medium |
| T22 | MOBA movement | Feature | Med | Solved | 1 | — | — | — | Medium |
| T23 | RPG progression v1 (four stats) | Feature | Med | Regressed/superseded | 2 | — | — | yes | High |
| T24 | Dash i-frames | Feature | Low | Solved | 1 | — | — | — | Medium |
| T25 | iso3d renderer | Arch | High | Solved | 1 | — | — | — | High |
| T26 | Mech legs + movement sandbox | Feature | High | Solved | 3 | 2 | all correct | — | Medium |
| T27 | Camera and light controls | UIUX | Med | Solved | 2 | 1 | all correct | — | Medium |
| T28 | Rig debug viewport | Tooling | Med | Solved | 1 | — | — | — | Medium |
| T29 | Variable leg count | Refactor | High | Solved | 1 | — | — | — | Medium |
| T30 | Collision and pathfinding | Feature | High | Partial | 4 | 1 | all correct | — | High |
| T31 | Retro post filter | Feature | Med | Solved | 1 | — | — | — | High |
| T32 | Camera follow lag | UIUX | Low | Solved | 1 | 1 | all correct | — | Medium |
| T33 | Queued move orders | Feature | Med | Solved | 1 | — | — | — | Medium |
| T34 | Fullscreen window + wheel zoom | UIUX | Med | Solved | 2 | — | — | — | Medium |
| T35 | Terrain generation foundation | Arch | VHigh | Solved | 1 | — | — | — | High |
| T36 | Open-world movement + colliders | Feature | Med | Solved | 1 | — | — | — | Medium |
| T37 | Scene look pass forest | UIUX | Med | Solved | 2 | 1 | all correct | — | Medium |
| T38 | Hooded robe cloth | Feature | VHigh | Solved | 1 | — | — | — | Medium |
| T39 | Day night cycle + player lights | Feature | Med | Solved | 2 | — | — | — | High |
| T40 | Map serialization format | Arch | High | Partial | 3 | — | — | — | High |
| T41 | Map editor tools 049-054 | Feature | VHigh | Solved | 6 | — | — | — | High |
| T42 | Critter characters | Feature | High | Solved | 1 | — | — | — | Medium |
| T43 | Multiplayer sim layer | Arch | VHigh | Solved | 1 | — | — | — | High |
| T44 | Everything through the server | Arch | VHigh | Partial | 2 | — | — | — | High |
| T45 | Editor fences 058-061 | UIUX | Med | Solved | 4 | 3 | 1 of 3 | yes | Medium |
| T46 | Abilities projectiles casting | Arch | VHigh | Solved | 1 | — | — | — | High |
| T47 | Iso renderer on the server | Arch | High | Solved | 1 | — | — | — | High |
| T48 | Move orders and turning | Feature | Med | Solved | 2 | 1 | all correct | — | High |
| T49 | Committing to a blow | Feature | High | Solved | 2 | 1 | all correct | — | High |
| T50 | Sandbox tabs restored | Refactor | Low | Solved | 1 | 1 | all correct | — | High |
| T51 | Pathfinding narrow gaps + throttle | Bugfix | High | Solved | 2 | 1 | all correct | — | High |
| T52 | Prediction under latency | Arch | VHigh | Solved | 3 | 1 | all correct | — | High |
| T53 | Nothing interrupts nothing recovers | Design | Med | Solved | 1 | 1 | all correct | — | Medium |
| T54 | Right-click attack order | Feature | Med | Solved | 1 | — | — | — | High |
| T55 | Forgiving target picking | UIUX | Med | Regressed/superseded | 2 | 1 | 0 of 1 | yes | High |
| T56 | Map on the wire | Arch | High | Partial | 2 | — | — | — | High |
| T57 | Wind sway water weather panel | Feature | High | Solved | 2 | — | — | — | Medium |
| T58 | Spawners in the map | Feature | Med | Solved | 1 | — | — | — | Medium |
| T59 | Lobed canopy + conifer fixes | UIUX | Med | Solved | 3 | 1 | all correct | — | Medium |
| T60 | Chunk streaming seam | Bugfix | Med | Solved | 1 | 1 | all correct | — | Medium |
| T61 | Withdrawal correctness in the sim | Bugfix | VHigh | Solved | 6 | 5 | all correct | — | High |
| T62 | Attack timing model | Design | High | Solved | 2 | 1 | all correct | yes | High |
| T63 | Standing order lifecycle | Bugfix | Med | Solved | 1 | 1 | all correct | — | High |
| T64 | Aiming a skill before committing | Feature | Med | Solved | 1 | — | — | — | Medium |
| T65 | Projectile bodies and arcs | UIUX | Med | Solved | 2 | — | — | — | Medium |
| T66 | Map growth parts + perf | Feature | High | Solved | 4 | — | — | — | High |
| T67 | Phone controls and HUD | Feature | High | Solved | 3 | 1 | all correct | — | High |
| T68 | Phone device detection | Bugfix | Med | Solved | 2 | 1 | all correct | — | High |
| T69 | Damage number anchoring | Bugfix | Low | Solved | 1 | 1 | all correct | — | Medium |
| T70 | Short Hike look arc 097-106 | Feature | VHigh | Solved | 10 | — | — | — | High |
| T71 | Settings menu split | UIUX | Med | Solved | 1 | 1 | all correct | — | Medium |
| T72 | Unit authoring format | Arch | VHigh | Solved | 1 | — | — | — | High |
| T73 | Studio paid-call service | Arch | VHigh | Solved | 3 | 1 | all correct | — | High |
| T74 | Preview machine and in-game wiring | Feature | High | Solved | 3 | 1 | all correct | — | High |
| T75 | Asset manifest | Build | Med | Solved | 1 | — | — | — | Medium |
| T76 | Mesh-level unit checks | Testing | VHigh | Solved | 1 | — | — | — | High |
| T77 | Which way is forward | Debug | High | Solved | 1 | 1 | all correct | — | High |
| T78 | Rig bone naming vocabulary | Arch | High | Solved | 2 | — | — | — | High |
| T79 | Root motion and blend clock | Bugfix | High | Solved | 2 | 1 | all correct | — | High |
| T80 | Player-carried light | Bugfix | Low | Solved | 1 | — | — | — | Medium |
| T81 | VFX particle core and library | Arch | VHigh | Solved | 4 | — | — | — | High |
| T82 | VFX visual language corrections | UIUX | Med | Solved | 5 | 4 | all correct | yes | High |
| T83 | VFX tuning tab | Tooling | Med | Solved | 2 | 1 | all correct | — | Medium |
| T84 | Rock formations and stairs | Feature | VHigh | Solved | 8 | 2 | all correct | — | Medium |
| T85 | GUI framework and screens | Arch | VHigh | Solved | 15 | 3 | all correct | — | High |
| T86 | Interface mounted in the game | Integration | High | Solved | 1 | — | — | — | High |
| T87 | Window layout persistence | Bugfix | Med | Solved | 1 | — | — | — | High |
| T88 | Retro filter player exemption | Feature | Med | Solved | 1 | — | — | — | Medium |
| T89 | Turn swing and turn ease | Bugfix | High | Solved | 2 | 1 | all correct | — | High |
| T90 | Pig swing animation | Feature | VHigh | Solved | 3 | 1 | all correct | — | High |
| T91 | Rig family and the fox | Refactor | Med | Solved | 1 | — | — | — | Medium |
| T92 | Blood lighting and streaks | UIUX | Med | Solved | 1 | 1 | all correct | — | Medium |
| T93 | Held weapon format | Feature | High | Regressed/superseded | 2 | — | — | — | High |
| T94 | Refusal log in the corner | UIUX | Low | Solved | 1 | 1 | all correct | — | Medium |
| T95 | Browser socket multiplayer 144-152 | Arch | VHigh | Solved | 9 | — | — | — | High |
| T96 | Health bar chunk and flinch | UIUX | Med | Solved | 2 | 1 | all correct | — | Medium |
| T97 | Six-attribute progression | Arch | VHigh | Solved | 1 | — | — | — | High |
| T98 | Ground decals and body rings | Bugfix | High | Solved | 2 | 1 | all correct | — | High |
| T99 | Admin console | Tooling | Med | Solved | 1 | 1 | all correct | — | Medium |
| T100 | Monster look table and spider | Feature | Med | Solved | 1 | 1 | all correct | — | Medium |
| T101 | Health economy between fights | Feature | Med | Solved | 1 | — | — | — | Medium |
| T102 | Heal drawn as blood | Bugfix | Low | Solved | 1 | 1 | all correct | — | Medium |
| T103 | One player one connection | Bugfix | High | Solved | 1 | 1 | all correct | — | High |
| T104 | Painterly VFX rewrite 158-162 | Feature | VHigh | Solved | 5 | 3 | all correct | — | High |
| T105 | Loot drops and reveal | Feature | High | Solved | 2 | — | — | — | High |
| T106 | Monster temperaments | Feature | High | Solved | 1 | — | — | — | High |
| T107 | Run posture correction | Bugfix | Med | Solved | 1 | 1 | all correct | — | Medium |
| T108 | Bottom HUD bar and RPG wiring | Integration | High | Solved | 1 | — | — | — | High |
| T109 | Bow draw animation | Feature | High | Solved | 1 | 1 | all correct | — | High |
| T110 | Weapon visible in the game | Integration | Med | Solved | 1 | — | — | — | High |
| T111 | Attack cancel animation | Bugfix | High | Solved | 2 | 1 | all correct | — | High |

## Method

Tasks were reconstructed as distinct underlying problems, not messages or
commits. The base unit was the pull request (89); multi-spec bundles were split
where the parts were independently evaluable, and sagas spanning several PRs were
merged — the withdrawal work across specs 079–167 is one entry, not eleven.
Evidence was weighted final behaviour and tests first, then repository state,
then commits and specs. Work deleted by a deliberate design pivot (the card game,
retired at spec 062) is classified as requirement change, not failure.

Least certain: all pushback counts, which are inferred from four verbatim-quoted
reports plus ~28 specs describing an in-play observation — the true number of
times the assistant was challenged is certainly higher and unknowable. The claim
that it never abandoned a correct answer under challenge is the weakest here,
because that behaviour would live entirely in the missing conversation.
