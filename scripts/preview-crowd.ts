// Dev-only: what a crowd actually does (spec 187).
// Not part of the app. `npx tsx scripts/preview-crowd.ts`
//
// Five scenarios, each flown through the **real `step`** -- real monsters, real
// aggro, real casts, real collision -- and drawn from above as trails. The
// numbers under each panel are the acceptance figures the spec is written
// against, and `src/server/sim/crowd.test.ts` asserts the same ones off the
// same harness, so a panel that looks wrong and a test that passes cannot both
// be true.
//
// Rasterised in software rather than photographed in a browser, and that is not
// a shortcut: none of this is drawn by the renderer at all. It is authoritative
// server state, so a browser would only add a camera between the measurement
// and the thing measured.
//
// Reading a panel: a body's trail runs from pale to solid, so the direction of
// travel is legible without arrows; the filled circle at the end is the body at
// its real radius, which is what makes an overlap something you can see rather
// than something you have to be told. A quarry is a cross with its standoff
// ring round it -- the ring is where attackers stop, so a panel where bodies
// are stacked *inside* it is a panel where something has gone wrong.

import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import {
  converge,
  cross,
  gate,
  herd,
  overtake,
  run,
  type Scenario,
  type Trace,
} from './crowd-scenarios.js';
import {
  frontOf,
  overlapShare,
  overtook,
  reached,
  sizeOf,
  settledShare,
  stillShare,
  tickPast,
  jerk,
  widestGap,
  worstOverlap,
} from './crowd-metrics.js';

const PANEL_W = 900;
const PANEL_MAX_H = 380;
const GAP = 8;
const LABEL = 16;

const BACKDROP: readonly [number, number, number] = [16, 18, 22];
const WALL: readonly [number, number, number] = [70, 74, 84];
const QUARRY: readonly [number, number, number] = [235, 235, 240];
const RING: readonly [number, number, number] = [70, 78, 96];
/** One per group: quarry, the first crowd, the second. */
const GROUPS: readonly (readonly [number, number, number])[] = [
  [235, 235, 240],
  [96, 190, 255],
  [255, 156, 92],
];

interface Panel {
  readonly trace: Trace;
  readonly lines: readonly string[];
}

/**
 * One scale per panel, taken from the panel's own window, and the panel's
 * height taken from that -- so a scenario that happens in a square gets a
 * square rather than a letterbox with everything in the middle of it. Every
 * body inside one panel is still drawn at one scale, which is the part that
 * matters: the whole point of drawing a body at its real radius is that two of
 * them can be compared.
 */
function scaleOf(scenario: Scenario): number {
  return Math.min(PANEL_W / scenario.window.w, PANEL_MAX_H / scenario.window.h);
}

function heightOf(scenario: Scenario): number {
  return Math.ceil(scenario.window.h * scaleOf(scenario));
}

function toPixel(scenario: Scenario, x: number, y: number, top: number): { x: number; y: number } {
  const scale = scaleOf(scenario);
  return {
    x: (x - scenario.window.x) * scale,
    y: top + (y - scenario.window.y) * scale,
  };
}

const panels: Panel[] = [];

// --- the runs, and what each one is asked -------------------------------

{
  const trace = run(herd(40), 1300, 1);
  const turns = jerk(trace);
  panels.push({
    trace,
    lines: [
      `worst overlap ${(worstOverlap(trace) * 100).toFixed(1)}% of the gap they should keep, touching on ${(overlapShare(trace) * 100).toFixed(1)}% of body-frames`,
      `tick-to-tick velocity change p50 ${turns.p50.toFixed(3)} / p95 ${turns.p95.toFixed(3)} / max ${turns.max.toFixed(2)} of top speed -- the jitter number`,
      `standing still on ${(stillShare(trace) * 100).toFixed(1)}% of body-frames, ${(settledShare(trace) * 100).toFixed(1)}% over the last quarter; front at x=${frontOf(trace, 1).toFixed(0)} of 2400`,
    ],
  });
}

{
  const trace = run(overtake(), 1800, 1);
  const fast = sizeOf(trace, 2);
  panels.push({
    trace,
    lines: [
      `${overtook(trace, 2, 1)} of ${fast} fast bodies finished ahead of the slow median -- the overtaking number`,
      `fast front x=${frontOf(trace, 2).toFixed(0)}, slow front x=${frontOf(trace, 1).toFixed(0)}`,
      `worst overlap ${(worstOverlap(trace) * 100).toFixed(1)}%, standing still ${(stillShare(trace) * 100).toFixed(1)}%`,
    ],
  });
}

{
  const scenario = gate(24);
  const trace = run(scenario, 1500, 1);
  const through = reached(trace, 1, { x: 1700, y: 900 }, 520);
  panels.push({
    trace,
    lines: [
      `${through} of 24 bodies got through the gap and to the far side`,
      `half of them past the wall by tick ${tickPast(trace, 1, 1160, 12) ?? '(never)'}, all by ${tickPast(trace, 1, 1160, 24) ?? '(never)'}`,
      `worst overlap ${(worstOverlap(trace) * 100).toFixed(1)}%, jitter p95 ${jerk(trace).p95.toFixed(3)}`,
    ],
  });
}

{
  const trace = run(converge(20), 900, 1);
  const gapDeg = (widestGap(trace, { x: 1200, y: 900 }, 200) * 180) / Math.PI;
  panels.push({
    trace,
    lines: [
      `widest empty arc round the quarry ${gapDeg.toFixed(0)} degrees -- 360 would be everybody on one bearing`,
      `${reached(trace, 1, { x: 1200, y: 900 }, 110)} of 20 ended inside 110 units (the stalker standoff is 68.8)`,
      `worst overlap ${(worstOverlap(trace) * 100).toFixed(1)}%, touching on ${(overlapShare(trace) * 100).toFixed(1)}% of body-frames, settled ${(settledShare(trace) * 100).toFixed(1)}% by the end`,
    ],
  });
}

{
  const trace = run(cross(15), 1500, 1);
  panels.push({
    trace,
    lines: [
      `east-bound reached ${reached(trace, 1, { x: 2200, y: 900 }, 400)} of 15; west-bound ${reached(trace, 2, { x: 200, y: 900 }, 400)} of 15`,
      `worst overlap ${(worstOverlap(trace) * 100).toFixed(1)}%, touching on ${(overlapShare(trace) * 100).toFixed(1)}% of body-frames`,
      `jitter p50 ${jerk(trace).p50.toFixed(3)} / p95 ${jerk(trace).p95.toFixed(3)}, standing still ${(stillShare(trace) * 100).toFixed(1)}%`,
    ],
  });
}

// --- the picture ---------------------------------------------------------

const height = panels.reduce((sum, panel) => sum + heightOf(panel.trace.scenario) + LABEL + GAP, GAP);
const png = new PNG({ width: PANEL_W, height });
for (let i = 0; i < png.data.length; i += 4) {
  png.data[i] = BACKDROP[0];
  png.data[i + 1] = BACKDROP[1];
  png.data[i + 2] = BACKDROP[2];
  png.data[i + 3] = 255;
}

function put(x: number, y: number, colour: readonly [number, number, number], alpha = 1): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= PANEL_W || py >= height) return;
  const at = (py * PANEL_W + px) * 4;
  for (let c = 0; c < 3; c++) {
    const was = png.data[at + c] ?? 0;
    png.data[at + c] = Math.round(was + ((colour[c] ?? 0) - was) * alpha);
  }
}

function disc(x: number, y: number, r: number, colour: readonly [number, number, number], alpha = 1): void {
  const span = Math.ceil(r);
  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      put(x + dx, y + dy, colour, alpha);
    }
  }
}

function circle(x: number, y: number, r: number, colour: readonly [number, number, number], alpha = 1): void {
  const steps = Math.max(24, Math.ceil(r * 6));
  for (let i = 0; i < steps; i++) {
    const angle = (i * 2 * Math.PI) / steps;
    put(x + Math.cos(angle) * r, y + Math.sin(angle) * r, colour, alpha);
  }
}

let top = GAP;
for (const panel of panels) {
  const scenario = panel.trace.scenario;
  const scale = scaleOf(scenario);
  const panelH = heightOf(scenario);

  // The walls, so a gap is visibly a gap.
  for (const rect of scenario.world.rects) {
    const a = toPixel(scenario, rect.x, rect.y, top);
    const b = toPixel(scenario, rect.x + rect.w, rect.y + rect.h, top);
    for (let y = Math.max(top, a.y); y <= Math.min(top + panelH, b.y); y++) {
      for (let x = Math.max(0, a.x); x <= Math.min(PANEL_W - 1, b.x); x++) put(x, y, WALL);
    }
  }

  // Trails, pale to solid.
  panel.trace.frames.forEach((frame, f) => {
    if (f % 4 !== 0) return;
    const alpha = 0.06 + 0.5 * (f / Math.max(1, panel.trace.frames.length - 1));
    scenario.actors.forEach((actor, i) => {
      const at = frame.at[i];
      if (!at || actor.player) return;
      const pixel = toPixel(scenario, at.x, at.y, top);
      put(pixel.x, pixel.y, GROUPS[actor.group % GROUPS.length] ?? QUARRY, alpha);
    });
  });

  // Where everybody ended up, at its real radius.
  const last = panel.trace.frames[panel.trace.frames.length - 1];
  scenario.actors.forEach((actor, i) => {
    const at = last?.at[i];
    if (!at) return;
    const pixel = toPixel(scenario, at.x, at.y, top);
    if (actor.player) {
      // A quarry: a cross, and the ring attackers stop on.
      circle(pixel.x, pixel.y, 68.8 * scale, RING, 0.55);
      for (let d = -4; d <= 4; d++) {
        put(pixel.x + d, pixel.y, QUARRY);
        put(pixel.x, pixel.y + d, QUARRY);
      }
      return;
    }
    disc(pixel.x, pixel.y, Math.max(1.5, actor.radius * scale), GROUPS[actor.group % GROUPS.length] ?? QUARRY, 0.85);
  });

  top += panelH + LABEL + GAP;
}

mkdirSync('.claude/screenshots', { recursive: true });
writeFileSync('.claude/screenshots/crowd.png', PNG.sync.write(png));

console.log(`.claude/screenshots/crowd.png  ${PANEL_W}x${height}`);
for (const panel of panels) {
  const { scenario } = panel.trace;
  console.log('');
  console.log(`${scenario.name}: ${scenario.claim}`);
  console.log(`  ${panel.trace.frames.length} samples over ${panel.trace.elapsedMs}ms of wall clock`);
  for (const line of panel.lines) console.log(`  ${line}`);
}
