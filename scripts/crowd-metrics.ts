// What a crowd trace is worth, as numbers (spec 186).
//
// Beside `crowd-scenarios.ts` rather than inside it, because a scenario is a
// world and a metric is a question about one, and the two change for different
// reasons. Everything here is pure and reads only a `Trace`, so the picture and
// the test cannot disagree about what "worst overlap" means.
//
// The one judgement running through all of it: a *maximum* is almost never the
// number to look at. One tick of one body doing something odd is a spike, and a
// crowd feature is about what a crowd does for seconds at a time -- so these
// report shares and percentiles, and where a maximum is genuinely the question
// (did anybody ever stand inside anybody) it says so.

import type { Actor, Trace } from './crowd-scenarios.js';
import { finalOf } from './crowd-scenarios.js';

/** How far two bodies overlapped, as a share of the gap they should have kept. */
export function worstOverlap(trace: Trace): number {
  const actors = trace.scenario.actors;
  let worst = 0;
  for (const frame of trace.frames) {
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      const at = frame.at[i];
      if (!a || !at || a.player) continue;
      for (let j = i + 1; j < actors.length; j++) {
        const b = actors[j];
        const there = frame.at[j];
        // Players are left out: a player and a monster overlap exactly as much
        // as they always have, which is spec 186's stated limit rather than a
        // failure of it.
        if (!b || !there || b.player) continue;
        const reach = a.radius + b.radius;
        const gap = Math.hypot(at.x - there.x, at.y - there.y);
        if (gap < reach) worst = Math.max(worst, (reach - gap) / reach);
      }
    }
  }
  return worst;
}

/** The share of sampled body-frames where two bodies were inside each other at all. */
export function overlapShare(trace: Trace): number {
  const actors = trace.scenario.actors;
  let touching = 0;
  let counted = 0;
  for (const frame of trace.frames) {
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      const at = frame.at[i];
      if (!a || !at || a.player) continue;
      counted += 1;
      for (let j = 0; j < actors.length; j++) {
        if (i === j) continue;
        const b = actors[j];
        const there = frame.at[j];
        if (!b || !there || b.player) continue;
        if (Math.hypot(at.x - there.x, at.y - there.y) < a.radius + b.radius) {
          touching += 1;
          break;
        }
      }
    }
  }
  return counted === 0 ? 0 : touching / counted;
}

/**
 * How hard bodies changed velocity from one tick to the next, as a share of
 * their own top speed.
 *
 * The instrument for jitter, and it took two goes to get right. The first
 * version measured each sample's pace against the run's median pace, which
 * reads a body politely slowing to a crawl in a doorway as a swing of 0.9 --
 * the exact behaviour the feature is *for*, scored as its worst failure. What
 * shuddering actually is is a body whose velocity changes direction or size
 * sharply and repeatedly, which is a difference between consecutive ticks and
 * nothing to do with any average.
 *
 * A distribution rather than a maximum, because one hard swerve while squeezing
 * past somebody is a body avoiding somebody. The number that decides is the
 * 95th percentile: a crowd that shudders does it constantly.
 *
 * Requires a trace sampled every tick; a coarser one smears the difference it
 * is trying to measure and reports calm.
 */
export function jerk(trace: Trace): { p50: number; p95: number; max: number } {
  const actors = trace.scenario.actors;
  const samples: number[] = [];
  for (let f = 2; f < trace.frames.length; f++) {
    const first = trace.frames[f - 2];
    const middle = trace.frames[f - 1];
    const last = trace.frames[f];
    if (!first || !middle || !last) continue;
    const spanA = middle.tick - first.tick;
    const spanB = last.tick - middle.tick;
    if (spanA <= 0 || spanB <= 0) continue;
    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i];
      const a = first.at[i];
      const b = middle.at[i];
      const c = last.at[i];
      if (!actor || !a || !b || !c || actor.player) continue;
      // Only while it has business moving: a body that has arrived and stopped
      // has no velocity to change.
      if (!b.moving && !c.moving) continue;
      const beforeX = (b.x - a.x) / spanA;
      const beforeY = (b.y - a.y) / spanA;
      const afterX = (c.x - b.x) / spanB;
      const afterY = (c.y - b.y) / spanB;
      samples.push(Math.hypot(afterX - beforeX, afterY - beforeY) / (actor.speed / 60));
    }
  }
  if (samples.length === 0) return { p50: 0, p95: 0, max: 0 };
  samples.sort((a, b) => a - b);
  return {
    p50: samples[Math.floor(samples.length * 0.5)] ?? 0,
    p95: samples[Math.floor(samples.length * 0.95)] ?? 0,
    max: samples[samples.length - 1] ?? 0,
  };
}

/** How many bodies of `group` ended within `within` of the point they were after. */
export function reached(trace: Trace, group: number, goal: { x: number; y: number }, within: number): number {
  let count = 0;
  for (const actor of trace.scenario.actors) {
    if (actor.group !== group || actor.player) continue;
    const entity = finalOf(trace, actor);
    if (!entity) continue;
    if (Math.hypot(entity.position.x - goal.x, entity.position.y - goal.y) <= within) count += 1;
  }
  return count;
}

/** The first sampled tick by which `count` bodies of `group` were past `x`. */
export function tickPast(trace: Trace, group: number, x: number, count: number): number | null {
  const actors = trace.scenario.actors;
  for (const frame of trace.frames) {
    let through = 0;
    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i];
      const at = frame.at[i];
      if (!actor || !at || actor.player || actor.group !== group) continue;
      if (at.x > x) through += 1;
    }
    if (through >= count) return frame.tick;
  }
  return null;
}

/**
 * How far round a target its attackers ended up, as the largest angular gap
 * left empty -- so a full turn means everybody arrived on one bearing and a
 * small number means they spread.
 *
 * A gap rather than a spread or a variance, because what "they all piled onto
 * one side" looks like is a big empty arc, and an average would be dragged
 * about by one straggler on the far side.
 */
export function widestGap(trace: Trace, centre: { x: number; y: number }, within: number): number {
  const angles: number[] = [];
  for (const actor of trace.scenario.actors) {
    if (actor.player) continue;
    const entity = finalOf(trace, actor);
    if (!entity) continue;
    const dx = entity.position.x - centre.x;
    const dy = entity.position.y - centre.y;
    if (Math.hypot(dx, dy) > within) continue;
    angles.push(Math.atan2(dy, dx));
  }
  if (angles.length === 0) return Math.PI * 2;
  angles.sort((a, b) => a - b);
  let widest = 0;
  for (let i = 0; i < angles.length; i++) {
    const here = angles[i] ?? 0;
    const next = angles[(i + 1) % angles.length] ?? 0;
    const gap = i === angles.length - 1 ? next + Math.PI * 2 - here : next - here;
    widest = Math.max(widest, gap);
  }
  return widest;
}

/** How far the front of `group` got along x by the end. */
export function frontOf(trace: Trace, group: number): number {
  let front = -Infinity;
  for (const actor of trace.scenario.actors) {
    if (actor.group !== group || actor.player) continue;
    const entity = finalOf(trace, actor);
    if (entity) front = Math.max(front, entity.position.x);
  }
  return front;
}

/** How many of `fast` finished ahead of the median of `slow`. */
export function overtook(trace: Trace, fast: number, slow: number): number {
  const behind: number[] = [];
  for (const actor of trace.scenario.actors) {
    if (actor.group !== slow || actor.player) continue;
    const entity = finalOf(trace, actor);
    if (entity) behind.push(entity.position.x);
  }
  behind.sort((a, b) => a - b);
  const median = behind[Math.floor(behind.length / 2)] ?? 0;
  let ahead = 0;
  for (const actor of trace.scenario.actors) {
    if (actor.group !== fast || actor.player) continue;
    const entity = finalOf(trace, actor);
    if (entity && entity.position.x > median) ahead += 1;
  }
  return ahead;
}

/** How many bodies of a group there are, players excluded. */
export function sizeOf(trace: Trace, group: number): number {
  return trace.scenario.actors.filter((a) => !a.player && a.group === group).length;
}

/**
 * The share of sampled body-frames in which a body stood still.
 *
 * The instrument for "constant stopping". Read against the scenario: in a herd
 * crossing open ground it should be near zero, and in a converge it should end
 * up near one, because arriving is the point.
 */
export function stillShare(trace: Trace, actors: readonly Actor[] = trace.scenario.actors): number {
  let still = 0;
  let counted = 0;
  const index = new Map(trace.scenario.actors.map((a, i) => [a.id, i]));
  for (const frame of trace.frames) {
    for (const actor of actors) {
      if (actor.player) continue;
      const at = frame.at[index.get(actor.id) ?? -1];
      if (!at) continue;
      counted += 1;
      if (!at.moving) still += 1;
    }
  }
  return counted === 0 ? 0 : still / counted;
}

/**
 * The share of body-frames in the last `tail` of a run in which a body stood
 * still.
 *
 * The settling question, which the whole-run figure cannot answer: a herd that
 * crosses open ground and then packs round its quarry is moving for most of the
 * run and ought to be still by the end, while a crowd that never settles reads
 * the same as one that arrived, averaged over the whole thing. What this
 * catches is the failure mode where a crowd arrives and then shuffles forever.
 */
export function settledShare(trace: Trace, tail = 0.25): number {
  const from = Math.floor(trace.frames.length * (1 - tail));
  const tailFrames = trace.frames.slice(from);
  if (tailFrames.length === 0) return 0;
  let still = 0;
  let counted = 0;
  for (const frame of tailFrames) {
    trace.scenario.actors.forEach((actor, i) => {
      if (actor.player) return;
      const at = frame.at[i];
      if (!at) return;
      counted += 1;
      if (!at.moving) still += 1;
    });
  }
  return counted === 0 ? 0 : still / counted;
}
