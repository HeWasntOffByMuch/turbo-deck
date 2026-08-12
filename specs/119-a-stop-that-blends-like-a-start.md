# 119 — A stop that blends like a start

## Problem

Setting off blends. Stopping does not: the run pose is gone in a single tick
and the idle is simply there. The transitions are symmetric — the pig's
unitdef authors `idle -> locomotion` and `locomotion -> idle` both at 150ms —
so the asymmetry is not in what was authored.

It is in the two kinds of blend the machine has, and the fact that only one of
them is time-based.

- A **state transition** fades over `durationMs`, in ticks.
- A **blend tree** is a pure function of its parameter, evaluated fresh every
  time it is asked — including for the *outgoing* layer of a transition, since
  `clipsOf` reads `this.parameters` live.

The sim has no acceleration. A body's velocity is instantaneous, so `speed`
steps between 0 and ~147.5 (the base move speed) in one tick. Put those
together and the two directions are not alike at all:

| | outgoing layer | incoming layer | what is seen |
|---|---|---|---|
| **start** | `idle` state → `idle` clip | `locomotion` tree at 147.5 → `run` clip | a real 150ms cross-fade |
| **stop** | `locomotion` tree at **0** → `idle` clip | `idle` state → `idle` clip | idle→idle: nothing |

On stop the outgoing layer stops being a run *before the transition it is the
outgoing half of has done anything*. The run pose does not fade — it is not
there to fade. The cross-fade then dutifully blends the idle clip into the idle
clip over 150ms and looks like a cut.

Starting hides the same fault because the tree's step lands on the value the
cross-fade is heading *to*, so the fade does the work and the step is invisible.

## Design

The blend tree's parameter is the only input to any of this that is allowed to
jump, so that is what changes: `speed` is **slewed** toward its measured value
at a bounded rate rather than assigned.

```ts
// src/render/iso3d/world/unit-driver.ts
export const BLEND_SLEW_PER_SECOND: number;
export function slewSpeed(
  current: number, target: number, ticks: number, tickSeconds: number,
  rate?: number,
): number;
```

A rate limit rather than an exponential decay, because the settle time is then
a number somebody chose instead of one that emerges from a half-life: at 1000
units/s the run threshold of 150 is reached from a standstill, or given up, in
150ms — the same 150ms the unitdefs author their locomotion transitions at.

It advances on `ticks`, not on the frame delta, for the reason spec 118 exists:
a frame that drained no tick must not advance a signal that the sim clock owns.

This is presentation only and lives with the rest of the driver. Nothing about
the authoritative state changes, and the slewed value is never read back into
anything the sim can see.

**Both directions get it, not just the fall.** Damping only the way down would
fix the reported symptom and leave the two paths different in kind, which is
what made this hard to see in the first place. Rising, the slew is invisible:
the transition condition is `speed > 5`, which a 1000 units/s ramp crosses
inside the first tick, and the tree then walks up through the walk band under a
cross-fade that was already running.

## Invariants tested

- `slewSpeed` reaches its target and stops there, never overshoots, and is
  monotone toward it from either side.
- It is framerate independent on the sim clock: six one-tick steps and one
  six-tick step land on the same value, and a frame that drained no tick
  changes nothing.
- Full run speed to zero takes the authored 150ms, and zero to the `speed > 5`
  transition threshold takes less than one tick.
- The regression: stopping from a run, the parameter **visits the walk band**
  (34..150) for several consecutive ticks instead of stepping over it, so the
  tree emits `walk` on the way down. Asserted against the pig's real thresholds.
- Driven end to end through the real unitdef, a stop produces a run→walk→idle
  sequence of blend weights rather than a single-tick swap.

## Out of scope

- **Acceleration in the sim.** A body that eased into and out of its top speed
  would fix this at the source and is a gameplay change with collision,
  prediction and reconciliation consequences. This is a presentation fix, and
  it is the correct layer for one: the server's answer for where a body is does
  not change by a millimetre.
- **The 150/34 thresholds** and the 150ms transition durations. `scaffold.ts`
  writes them; nothing here re-tunes them.
- **Turn-in-place, and blending by direction.** A body that reverses without
  stopping still swaps its facing in one tick. Different fault, different spec.
