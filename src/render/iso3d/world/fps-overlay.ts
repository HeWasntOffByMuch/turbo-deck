/**
 * The frame-time readout and its graph (spec 165).
 *
 * A small canvas rather than the game's 5x7 face or the UI layer. Three reasons,
 * and they are the same three that keep the developer readout in the browser's
 * own type: this draws a *curve* rather than a shout or a quantity; it has to
 * work in the frames before the interface layer exists, since the frames worth
 * measuring are the loading ones; and a diagnostic that costs measurable frame
 * time is a diagnostic that changes what it is measuring -- one `putImageData`
 * of a 120x36 buffer does not.
 *
 * It decides nothing. {@link FrameMeter} does the arithmetic; this is pixels.
 */

import { STALL_MS, type FrameStats } from './fps-meter.js';

/** What {@link FpsOverlay.set} is told about the simulation half of the frame. */
export interface SimCost {
  /** Mean milliseconds a frame spends advancing the sim, over the meter's window. */
  readonly meanMs: number;
  /** The worst single frame's share -- a correction replaying its input buffer. */
  readonly worstMs: number;
  /** Mean fixed ticks drained per frame. Below 60fps this is why the cost alternates. */
  readonly ticksPerFrame: number;
}

/**
 * What {@link FpsOverlay.set} is told about the rendering half (spec 191).
 *
 * Split at the first draw call, because "the renderer is slow" has two
 * unrelated causes. `prepareMs` is JavaScript building the frame -- rigs,
 * effects, the scene graph -- and is fixed by doing less work. `drawMs` is
 * handing commands to the driver, and is fixed by submitting fewer of them.
 */
export interface RenderCost {
  readonly prepareMs: number;
  readonly drawMs: number;
}

const WIDTH = 180;
const HEIGHT = 56;

/**
 * The frame time the graph's full height means.
 *
 * 50ms, so 60Hz sits low in the band and a stall runs off the top rather than
 * compressing everything else into the bottom two pixels. The 16.7ms and 33.3ms
 * rules are drawn across it, because a curve with no scale on it says only
 * "something happened" -- with them it says which frame rate was lost.
 */
const SCALE_MS = STALL_MS;

export interface FpsOverlay {
  /**
   * Draw, or hide when `stats` is null.
   *
   * `workMs` is the frame's *streaming* cost -- inserting chunks, meshing them,
   * rebuilding props, warming the nav grid. Shown beside the frame time because
   * the two answer different questions: a slow frame on a weak GPU and a slow
   * frame because the world is still arriving look identical in `fps` and are
   * nothing alike, and only one of them is worth fixing here.
   */
  set(
    stats: FrameStats | null,
    workMs?: number,
    worstStage?: string,
    worstStageMs?: number,
    scene?: { calls: number; triangles: number },
    sim?: SimCost,
    render?: RenderCost,
  ): void;
  dispose(): void;
}

export function createFpsOverlay(parent: HTMLElement): FpsOverlay {
  const root = document.createElement('div');
  root.dataset['fps'] = '';
  root.style.cssText = [
    'position:absolute',
    // Top *right*, under the settings buttons. The top-left corner already has
    // two things that want it -- the developer readout and the connection
    // banner -- and a performance readout you have to hunt for is a performance
    // readout nobody uses. This corner is empty in the shipped layout, and the
    // settings popovers that open under these buttons are transient.
    'top:52px',
    'right:8px',
    'display:none',
    'flex-direction:column',
    'gap:2px',
    'padding:4px 6px',
    'background:rgba(11,11,18,0.72)',
    'color:#c8c8d4',
    "font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace",
    'pointer-events:none',
    // Above the loading overlay, deliberately: the frames worth measuring on the
    // grown map are the loading ones, and a meter that appears once the load is
    // over cannot say anything about the part that was slow.
    'z-index:55',
  ].join(';');

  const text = document.createElement('div');
  text.dataset['fpsText'] = '';
  root.append(text);

  const draws = document.createElement('div');
  draws.dataset['fpsDraws'] = '';
  draws.style.cssText = 'color:#8fa0b8;';

  const work = document.createElement('div');
  work.dataset['fpsWork'] = '';
  work.style.cssText = 'color:#e0b45a;';

  // The simulation's share of the frame (spec 189), on its own line and in its
  // own colour, because it answers a different question from the two above it:
  // `draws` is what the GPU was asked for and `work` is the loader, and neither
  // can say that a frame went on `server.tick()`. Green, since the number it is
  // compared against is the frame time in the line at the top.
  const sim = document.createElement('div');
  sim.dataset['fpsSim'] = '';
  sim.style.cssText = 'color:#6edc96;';
  // The rendering half, and the remainder (spec 191). Its own colour again, and
  // the remainder is the number the whole line exists to show: the frame minus
  // everything this thread can account for. Large, and the answer is not on this
  // thread at all.
  const render = document.createElement('div');
  render.dataset['fpsRender'] = '';
  render.style.cssText = 'color:#8fb6dc;';
  root.append(draws);
  root.append(sim);
  root.append(render);
  root.append(work);

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px;display:block;`;
  root.append(canvas);
  parent.append(root);

  const ctx = canvas.getContext('2d');

  const drawRule = (ms: number, colour: string): void => {
    if (!ctx) return;
    const y = HEIGHT - Math.min(HEIGHT, (ms / SCALE_MS) * HEIGHT);
    ctx.strokeStyle = colour;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(WIDTH, y + 0.5);
    ctx.stroke();
  };

  return {
    set(
      stats: FrameStats | null,
      workMs = 0,
      worstStage = '',
      worstStageMs = 0,
      scene?: { calls: number; triangles: number },
      simCost?: SimCost,
      renderCost?: RenderCost,
    ): void {
      if (!stats) {
        root.style.display = 'none';
        return;
      }
      root.style.display = 'flex';
      // Both numbers, always. The average alone hides every stutter, and the
      // worst frame alone makes a healthy session look broken.
      text.textContent =
        `${stats.fps.toFixed(0)} fps  ${stats.avgMs.toFixed(1)}ms` +
        `  1%:${stats.p99Ms.toFixed(0)}  max:${stats.worstMs.toFixed(0)}`;
      // Blank rather than "0ms" once the world has settled: a line that is
      // always there stops being read, and its whole job is to say "this frame
      // was the loader, not your machine".
      work.textContent =
        workMs > 0.5
          ? `streaming ${workMs.toFixed(0)}ms  worst: ${worstStage} ${worstStageMs.toFixed(0)}ms`
          : worstStage
            ? `worst since load: ${worstStage} ${worstStageMs.toFixed(0)}ms`
            : '';
      root.dataset['fpsWork'] = workMs.toFixed(1);
      if (scene) {
        draws.textContent = `${scene.calls} draws  ${(scene.triangles / 1000).toFixed(0)}k tris`;
        root.dataset['fpsDrawCalls'] = String(scene.calls);
        root.dataset['fpsTriangles'] = String(scene.triangles);
      }
      if (simCost) {
        // Mean and worst together, always. The mean is the share of the frame
        // and the worst is the spike, and a tick accumulator produces both --
        // below 60fps some frames drain one tick and some two, so the mean says
        // what the simulation costs and only the worst says what it costs on the
        // frame that felt bad. `t/f` is the reason they differ.
        sim.textContent =
          `sim ${simCost.meanMs.toFixed(1)}ms  worst ${simCost.worstMs.toFixed(1)}` +
          `  ${simCost.ticksPerFrame.toFixed(1)}t/f`;
        root.dataset['fpsSim'] = simCost.meanMs.toFixed(2);
        root.dataset['fpsSimWorst'] = simCost.worstMs.toFixed(2);
        root.dataset['fpsTicksPerFrame'] = simCost.ticksPerFrame.toFixed(2);
      }
      if (renderCost) {
        // `rest` is the point of the line: a frame is the sim, the preparation,
        // the submission, and whatever is left. What is left is the GPU, the
        // driver and the compositor -- none of which this thread can time -- so
        // it is computed rather than measured, and a big one means the fix is
        // not in any of the three numbers beside it.
        const accounted = renderCost.prepareMs + renderCost.drawMs + (simCost?.meanMs ?? 0);
        const rest = Math.max(0, stats.avgMs - accounted);
        render.textContent =
          `prep ${renderCost.prepareMs.toFixed(1)}  draw ${renderCost.drawMs.toFixed(1)}` +
          `  rest ${rest.toFixed(1)}ms`;
        root.dataset['fpsPrepare'] = renderCost.prepareMs.toFixed(2);
        root.dataset['fpsDraw'] = renderCost.drawMs.toFixed(2);
        root.dataset['fpsRest'] = rest.toFixed(2);
      }
      root.dataset['fpsWorstStage'] = worstStage;
      root.dataset['fpsWorstStageMs'] = worstStageMs.toFixed(1);
      // Published for the harness, which cannot read a canvas but can read this.
      root.dataset['fpsValue'] = stats.fps.toFixed(1);
      root.dataset['fpsWorst'] = stats.worstMs.toFixed(1);
      root.dataset['fpsStalls'] = String(stats.stalls);

      if (!ctx) return;
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = 'rgba(30,30,42,0.9)';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      drawRule(1000 / 60, 'rgba(110,220,150,0.35)');
      drawRule(1000 / 30, 'rgba(230,180,90,0.35)');

      // One column per sample, newest at the right, so the graph scrolls the way
      // every other time series does and a spike walks off the left edge.
      const samples = stats.samples;
      const from = Math.max(0, samples.length - WIDTH);
      for (let i = from; i < samples.length; i++) {
        const ms = samples[i] ?? 0;
        const height = Math.min(HEIGHT, (ms / SCALE_MS) * HEIGHT);
        ctx.fillStyle = ms > STALL_MS ? '#e06a6a' : ms > 1000 / 45 ? '#e0b45a' : '#6f7ae8';
        ctx.fillRect(WIDTH - (samples.length - i), HEIGHT - height, 1, height);
      }
    },
    dispose(): void {
      root.remove();
    },
  };
}
