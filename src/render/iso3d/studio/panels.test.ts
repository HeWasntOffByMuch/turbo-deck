/**
 * The tuning panels' arithmetic (spec 110): the timeline, the timing bar and the
 * state machine's layout.
 *
 * All three are the sort of code that looks obviously right and is off by one:
 * a marker that drifts a frame each time it is picked up, a bar whose spans
 * leave a gap, a graph that draws four arrows where the author wrote one.
 */

import { describe, expect, it } from 'vitest';
import {
  applyMarkerDrag,
  dragMarkerTo,
  frameCount,
  frameToTime,
  markerAt,
  rulerTicks,
  snapToFrame,
  stepFrame,
  timeToFrame,
  timeToX,
  xToTime,
} from './timeline.js';
import { ANY_NODE, edgeAt, layoutGraph, nodesOverlap } from './graph-layout.js';
import { markerOnBar, phaseAt, phaseSpans, timingVerdict } from './timing-bar.js';
import type { ActionTiming, StateMachine } from '../../../units/types.js';

// --- timeline ----------------------------------------------------------------

describe('timeline mapping', () => {
  it('round-trips time through pixels', () => {
    for (const time of [0, 0.25, 0.5, 0.75, 1]) {
      expect(xToTime(timeToX(time, 400), 400)).toBeCloseTo(time, 9);
    }
  });

  it('clamps outside the track rather than running off it', () => {
    expect(xToTime(-50, 400)).toBe(0);
    expect(xToTime(900, 400)).toBe(1);
    expect(timeToX(-1, 400)).toBe(0);
    expect(timeToX(3, 400)).toBe(400);
  });

  it('survives a zero-width track', () => {
    expect(xToTime(10, 0)).toBe(0);
  });
});

describe('frames', () => {
  it('counts a clip in ticks of the simulation', () => {
    // 1000ms at 60Hz is 60 frames, which is what the machine will step through.
    expect(frameCount(1000)).toBe(60);
    expect(frameCount(500)).toBe(30);
  });

  it('accounts for the playback rate', () => {
    expect(frameCount(1000, 2)).toBe(30);
    expect(frameCount(1000, 0.5)).toBe(120);
  });

  it('never returns zero, however short the clip', () => {
    expect(frameCount(1)).toBe(1);
    expect(frameCount(0)).toBe(1);
    expect(frameCount(1000, 0)).toBe(60);
  });

  it('steps whole frames and clamps at the ends', () => {
    const frames = 60;
    expect(timeToFrame(stepFrame(0, 1, frames), frames)).toBe(1);
    expect(timeToFrame(stepFrame(1, 1, frames), frames)).toBe(59);
    expect(timeToFrame(stepFrame(0, -1, frames), frames)).toBe(0);
  });

  it('round-trips a frame through time', () => {
    for (const frame of [0, 1, 29, 59]) {
      expect(timeToFrame(frameToTime(frame, 60), 60)).toBe(frame);
    }
  });

  it('snaps a time onto a frame the machine can actually be on', () => {
    const snapped = snapToFrame(0.5049, 60);
    expect(timeToFrame(snapped, 60)).toBe(30);
    expect(snapToFrame(snapped, 60)).toBe(snapped);
  });
});

describe('markers', () => {
  const markers = [
    { name: 'a', normalizedTime: 0.1 },
    { name: 'b', normalizedTime: 0.6 },
  ];

  it('picks the nearest within the grab radius', () => {
    expect(markerAt(markers, timeToX(0.1, 400), 400)).toBe(0);
    expect(markerAt(markers, timeToX(0.6, 400), 400)).toBe(1);
  });

  it('picks nothing outside the radius', () => {
    expect(markerAt(markers, timeToX(0.35, 400), 400)).toBeNull();
  });

  it('picks the closer of two that are nearly on top of each other', () => {
    // The case where an accurate grab matters most, since it is the one where
    // aiming is hardest.
    const close = [
      { name: 'a', normalizedTime: 0.5 },
      { name: 'b', normalizedTime: 0.52 },
    ];
    expect(markerAt(close, timeToX(0.519, 400), 400)).toBe(1);
    expect(markerAt(close, timeToX(0.501, 400), 400)).toBe(0);
  });

  it('drags onto a frame inside the track', () => {
    const frames = 60;
    const dropped = dragMarkerTo(-40, 400, frames);
    expect(dropped).toBe(0);
    expect(dragMarkerTo(9999, 400, frames)).toBe(1);
    expect(snapToFrame(dragMarkerTo(203, 400, frames), frames)).toBe(dragMarkerTo(203, 400, frames));
  });

  it('re-sorts when a marker is dragged past another', () => {
    // cliplib.json requires strictly ascending events, so a drag that crosses
    // has to reorder rather than write a document the validator will reject.
    const dragged = applyMarkerDrag(markers, 0, 0.9, 60);
    expect(dragged.map((marker) => marker.name)).toEqual(['b', 'a']);
    expect(dragged[0]?.normalizedTime).toBeLessThan(dragged[1]?.normalizedTime ?? 0);
  });

  it('nudges a collision apart rather than dropping a marker', () => {
    const dragged = applyMarkerDrag(markers, 0, 0.6, 60);
    expect(dragged).toHaveLength(2);
    expect(dragged[0]?.normalizedTime).toBeLessThan(dragged[1]?.normalizedTime ?? 0);
  });

  it('keeps every marker inside 0..1 after a drag', () => {
    const many = [
      { name: 'a', normalizedTime: 0.97 },
      { name: 'b', normalizedTime: 0.98 },
      { name: 'c', normalizedTime: 0.99 },
    ];
    for (const marker of applyMarkerDrag(many, 0, 1, 60)) {
      expect(marker.normalizedTime).toBeGreaterThanOrEqual(0);
      expect(marker.normalizedTime).toBeLessThanOrEqual(1);
    }
  });
});

describe('the ruler', () => {
  it('marks the start and the end', () => {
    const ticks = rulerTicks(1000, 250);
    expect(ticks[0]?.time).toBe(0);
    expect(ticks[ticks.length - 1]?.time).toBeCloseTo(1, 6);
    expect(ticks).toHaveLength(5);
  });

  it('is empty for a clip with no length', () => {
    expect(rulerTicks(0)).toEqual([]);
  });
});

// --- the timing bar ----------------------------------------------------------

function timing(patch: Partial<ActionTiming> = {}): ActionTiming {
  return {
    actionId: 'basic.attack',
    windupMs: 380,
    activeMs: 120,
    recoveryMs: 280,
    clipRef: 'attack',
    eventMap: {},
    ...patch,
  };
}

describe('the timing bar', () => {
  it('lays three spans across the full width with no gap', () => {
    // Three independently rounded widths leave a pixel of background showing,
    // which reads as a rendering bug rather than as rounding.
    for (const width of [100, 237, 400, 999]) {
      const spans = phaseSpans(timing(), width);
      expect(spans.reduce((sum, span) => sum + span.width, 0), `width ${width}`).toBe(width);
      expect(spans[0]?.x).toBe(0);
      for (let i = 1; i < spans.length; i += 1) {
        expect(spans[i]?.x).toBe((spans[i - 1]?.x ?? 0) + (spans[i - 1]?.width ?? 0));
      }
    }
  });

  it('collapses to nothing for a zero-length action rather than dividing by zero', () => {
    const spans = phaseSpans(timing({ windupMs: 0, activeMs: 0, recoveryMs: 0 }), 400);
    expect(spans.every((span) => span.width === 0)).toBe(true);
  });

  it('reports the rate the clip is rescaled by', () => {
    // 900ms of clip over a 780ms action: 1.15x, comfortably inside the limit.
    const verdict = timingVerdict(timing(), 900, 2);
    expect(verdict.totalMs).toBe(780);
    expect(verdict.rate).toBeCloseTo(900 / 780, 6);
    expect(verdict.overLimit).toBe(false);
  });

  it('flags a clip stretched past the limit, and says what to do', () => {
    const verdict = timingVerdict(timing({ windupMs: 2000 }), 300, 2);
    expect(verdict.overLimit).toBe(true);
    expect(verdict.note).toContain('different clip');
  });

  it('flags a clip crammed past the limit too', () => {
    // Two-sided: making a wind-up snappier must not quietly become a flicker.
    expect(timingVerdict(timing({ windupMs: 20, activeMs: 10, recoveryMs: 20 }), 900, 2).overLimit).toBe(true);
  });

  it('passes exactly on the limit', () => {
    expect(timingVerdict(timing({ windupMs: 250, activeMs: 100, recoveryMs: 100 }), 900, 2).overLimit).toBe(false);
  });

  it('places a marker in the phase it falls in', () => {
    // 380/120/280 of 780: wind-up ends at 0.487, active at 0.641.
    expect(phaseAt(timing(), 0.2)).toBe('windup');
    expect(phaseAt(timing(), 0.55)).toBe('active');
    expect(phaseAt(timing(), 0.9)).toBe('recovery');
    expect(markerOnBar(1.4)).toBe(1);
  });
});

// --- the graph ---------------------------------------------------------------

const MACHINE: StateMachine = {
  parameters: [
    { name: 'speed', type: 'float' },
    { name: 'attack', type: 'trigger' },
  ],
  states: [
    { id: 'idle', clipRef: 'idle', loop: true, timeScale: 1, blendInMs: 150, category: 'loop' },
    { id: 'locomotion', clipRef: 'move', loop: true, timeScale: 1, blendInMs: 150, category: 'loop' },
    { id: 'swing', clipRef: 'attack', loop: false, timeScale: 1, blendInMs: 60, category: 'locking' },
    { id: 'down', clipRef: 'death', loop: false, timeScale: 1, blendInMs: 200, category: 'terminal' },
  ],
  blendTrees: [],
  transitions: [
    { from: 'idle', to: 'locomotion', condition: 'speed > 5', durationMs: 150, interruptible: true },
    { from: 'locomotion', to: 'idle', condition: 'speed < 5', durationMs: 150, interruptible: true },
    { from: '*', to: 'swing', condition: 'attack', durationMs: 60, interruptible: false },
    { from: 'swing', to: 'idle', condition: 'exit', durationMs: 120, interruptible: false },
  ],
  actionTimings: [],
};

describe('the graph layout', () => {
  const graph = layoutGraph(MACHINE, 'idle');

  it('places every state', () => {
    for (const state of MACHINE.states) {
      expect(graph.nodes.some((node) => node.id === state.id), state.id).toBe(true);
    }
  });

  it('places a state nothing reaches except an any-state transition', () => {
    // A state you cannot see is a state you cannot fix. `down` is reachable only
    // from `*` in a variant of this machine, and must still appear.
    const orphaned = layoutGraph({ ...MACHINE, transitions: MACHINE.transitions.slice(0, 2) }, 'idle');
    expect(orphaned.nodes.some((node) => node.id === 'down')).toBe(true);
  });

  it('draws an any-state transition once, not once per source', () => {
    // Four states would mean four arrows into `swing`, which turns the picture
    // into a hairball and misstates what the author wrote.
    const intoSwing = graph.edges.filter((edge) => edge.to === 'swing');
    expect(intoSwing).toHaveLength(1);
    expect(intoSwing[0]?.from).toBe('*');
    expect(graph.nodes.some((node) => node.id === ANY_NODE)).toBe(true);
  });

  it('omits the any-state node when nothing uses it', () => {
    const plain = layoutGraph({ ...MACHINE, transitions: MACHINE.transitions.filter((t) => t.from !== '*') }, 'idle');
    expect(plain.nodes.some((node) => node.id === ANY_NODE)).toBe(false);
  });

  it('never overlaps two nodes', () => {
    for (let i = 0; i < graph.nodes.length; i += 1) {
      for (let j = i + 1; j < graph.nodes.length; j += 1) {
        const a = graph.nodes[i];
        const b = graph.nodes[j];
        if (!a || !b) continue;
        expect(nodesOverlap(a, b), `${a.id} over ${b.id}`).toBe(false);
      }
    }
  });

  it('ranks left to right from the entry state', () => {
    const idle = graph.nodes.find((node) => node.id === 'idle');
    const locomotion = graph.nodes.find((node) => node.id === 'locomotion');
    expect((idle?.x ?? 0) < (locomotion?.x ?? 0)).toBe(true);
  });

  it('is the same layout every time it is opened', () => {
    // A graph whose shape moves cannot be learned.
    expect(layoutGraph(MACHINE, 'idle')).toEqual(layoutGraph(MACHINE, 'idle'));
  });

  it('carries the transition index, so an edit knows what it edits', () => {
    for (const edge of graph.edges) {
      expect(MACHINE.transitions[edge.index]?.to).toBe(edge.to);
    }
  });

  it('picks the edge nearest a click and nothing far away', () => {
    const edge = graph.edges[0];
    expect(edgeAt(graph, edge?.midX ?? 0, edge?.midY ?? 0)?.index).toBe(0);
    expect(edgeAt(graph, -500, -500)).toBeNull();
  });

  it('fits its own bounds', () => {
    for (const node of graph.nodes) {
      expect(node.x + node.width).toBeLessThanOrEqual(graph.width);
      expect(node.y + node.height).toBeLessThanOrEqual(graph.height);
    }
  });
});
