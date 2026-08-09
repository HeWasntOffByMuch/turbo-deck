/**
 * The clip timeline's arithmetic (spec 110).
 *
 * A scrubber is pixels one way and normalised time the other, and the two have
 * to agree exactly or a marker drifts every time it is picked up and put down.
 * That round trip is the whole reason this is a module rather than four
 * expressions inside a pointer handler.
 *
 * Frames matter as much as time. The machine advances in whole 60Hz ticks, so
 * per-frame stepping has to land on the same instants the machine will, or the
 * frame somebody parks an event on is not the frame it fires on.
 *
 * Pure: no DOM, no clock.
 */

export const DEFAULT_TICK_MS = 1000 / 60;

/** How close a pointer has to be, in pixels, to grab a marker. */
export const MARKER_GRAB_RADIUS = 7;

export function timeToX(normalizedTime: number, width: number): number {
  return Math.max(0, Math.min(1, normalizedTime)) * width;
}

export function xToTime(x: number, width: number): number {
  if (width <= 0) return 0;
  return Math.max(0, Math.min(1, x / width));
}

/**
 * How many frames a clip occupies at the simulation's tick rate.
 *
 * At least one: a clip shorter than a tick still has a frame to sit on, and a
 * zero here would divide through every snap below.
 */
export function frameCount(durationMs: number, rate = 1, tickMs = DEFAULT_TICK_MS): number {
  const effective = rate <= 0 ? 1 : rate;
  return Math.max(1, Math.round(durationMs / (tickMs * effective)));
}

/** The frame a normalised time falls on. */
export function timeToFrame(normalizedTime: number, frames: number): number {
  return Math.max(0, Math.min(frames - 1, Math.round(normalizedTime * (frames - 1))));
}

export function frameToTime(frame: number, frames: number): number {
  if (frames <= 1) return 0;
  return Math.max(0, Math.min(frames - 1, frame)) / (frames - 1);
}

/**
 * Steps by whole frames, clamping at the ends.
 *
 * Clamped rather than wrapped: single-stepping is for studying one instant, and
 * a step off the end that reappeared at the start would lose your place.
 */
export function stepFrame(normalizedTime: number, delta: number, frames: number): number {
  return frameToTime(timeToFrame(normalizedTime, frames) + delta, frames);
}

/** Snaps a time onto the nearest frame, which is where the machine can be. */
export function snapToFrame(normalizedTime: number, frames: number): number {
  return frameToTime(timeToFrame(normalizedTime, frames), frames);
}

export interface Marker {
  readonly name: string;
  readonly normalizedTime: number;
}

/**
 * The marker nearest a pointer, or null when none is close enough.
 *
 * Nearest rather than first-within-range, so two markers a few pixels apart can
 * still both be picked -- which is exactly the case where an accurate grab
 * matters, since that is when they are hardest to hit.
 */
export function markerAt(
  markers: readonly Marker[],
  x: number,
  width: number,
  radius = MARKER_GRAB_RADIUS,
): number | null {
  let best: number | null = null;
  let bestDistance = radius;
  markers.forEach((marker, index) => {
    const distance = Math.abs(timeToX(marker.normalizedTime, width) - x);
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * Where a dragged marker lands: on a frame, inside 0..1.
 *
 * Snapped, because an event between two frames fires on one of them anyway, and
 * a stored time that does not correspond to a frame makes the timeline disagree
 * with the runtime about where the marker is.
 */
export function dragMarkerTo(x: number, width: number, frames: number): number {
  return snapToFrame(xToTime(x, width), frames);
}

/**
 * Markers reordered after a drag, with their new times.
 *
 * `cliplib.json` requires strictly ascending events, so dragging one past
 * another has to re-sort rather than write a document the validator will
 * reject. Ties are nudged onto the next frame instead of being dropped: losing
 * a marker somebody was dragging is worse than moving it one frame.
 */
export function applyMarkerDrag(
  markers: readonly Marker[],
  index: number,
  normalizedTime: number,
  frames: number,
): readonly Marker[] {
  const moved = markers.map((marker, i) => (i === index ? { ...marker, normalizedTime } : marker));
  const sorted = [...moved].sort((a, b) => a.normalizedTime - b.normalizedTime);

  const step = frames <= 1 ? 0 : 1 / (frames - 1);
  const out: Marker[] = [];
  let previous = -1;
  for (const marker of sorted) {
    let time = marker.normalizedTime;
    if (time <= previous) time = Math.min(1, previous + step);
    out.push({ ...marker, normalizedTime: time });
    previous = time;
  }
  return out;
}

/** Tick labels for the ruler: a mark every `everyMs` of clip time. */
export function rulerTicks(durationMs: number, everyMs = 250): readonly { time: number; label: string }[] {
  if (durationMs <= 0) return [];
  const out: { time: number; label: string }[] = [];
  for (let ms = 0; ms <= durationMs + 0.001; ms += everyMs) {
    out.push({ time: ms / durationMs, label: `${Math.round(ms)}` });
  }
  return out;
}
