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

const WIDTH = 120;
const HEIGHT = 36;

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
  /** Draw, or hide when `stats` is null. */
  set(stats: FrameStats | null): void;
  dispose(): void;
}

export function createFpsOverlay(parent: HTMLElement): FpsOverlay {
  const root = document.createElement('div');
  root.dataset['fps'] = '';
  root.style.cssText = [
    'position:absolute',
    'top:8px',
    'left:8px',
    'display:none',
    'flex-direction:column',
    'gap:2px',
    'padding:4px 6px',
    'background:rgba(11,11,18,0.72)',
    'color:#c8c8d4',
    "font:11px ui-monospace,SFMono-Regular,Menlo,monospace",
    'pointer-events:none',
    'z-index:30',
  ].join(';');

  const text = document.createElement('div');
  text.dataset['fpsText'] = '';
  root.append(text);

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
    set(stats: FrameStats | null): void {
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
