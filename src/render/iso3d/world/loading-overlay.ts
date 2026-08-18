/**
 * The bar over the world while it loads (spec 165).
 *
 * DOM rather than the UI canvas, and for one reason: this has to be on screen
 * before there is a world, before the first `MapInfo`, and while the interface
 * layer is still deciding what scale to draw at. A screen whose whole job is to
 * cover the moments before everything is ready cannot be built out of the things
 * that are not ready yet.
 *
 * It holds no state and decides nothing -- {@link LoadGate} works out the phase
 * and the fraction, and this draws what it is handed. The one judgement here is
 * that the bar never animates *backwards*: it is handed a monotonic fraction and
 * eases toward it, so a jump from 40% to 90% when a burst lands reads as
 * progress rather than as a glitch.
 */

import type { LoadProgress } from './loading.js';

/** How long the overlay takes to fade out once the world is ready. */
const FADE_MS = 260;

export interface LoadingOverlay {
  set(progress: LoadProgress): void;
  dispose(): void;
}

export function createLoadingOverlay(parent: HTMLElement): LoadingOverlay {
  const root = document.createElement('div');
  root.dataset['loading'] = 'true';
  root.style.cssText = [
    'position:absolute',
    'inset:0',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:14px',
    'background:#0b0b12',
    'color:#c8c8d4',
    "font:12px ui-monospace,SFMono-Regular,Menlo,monospace",
    'letter-spacing:0.08em',
    'text-transform:uppercase',
    `transition:opacity ${FADE_MS}ms ease-out`,
    'opacity:1',
    // Above the HUD (5) and the interface layer (40), because a loading screen
    // that a window can be drawn on top of is not a loading screen. Below the
    // connection banner, which is the one thing that must still reach the player
    // while this is up: a refused connection behind an opaque "Connecting" reads
    // as a hang, and the fix for it is the message this would have hidden.
    'z-index:50',
  ].join(';');

  const label = document.createElement('div');
  label.dataset['loadingLabel'] = '';
  root.append(label);

  const track = document.createElement('div');
  track.style.cssText = 'width:min(320px,60vw);height:3px;background:#1e1e2a;overflow:hidden;';
  const fill = document.createElement('div');
  fill.dataset['loadingFill'] = '';
  // Eased rather than snapped: chunk counts arrive in steps of eight or more, so
  // an unanimated bar is a row of jumps, which reads as stalling between them.
  fill.style.cssText = 'width:0%;height:100%;background:#6f7ae8;transition:width 180ms linear;';
  track.append(fill);
  root.append(track);

  const detail = document.createElement('div');
  detail.dataset['loadingDetail'] = '';
  detail.style.cssText = 'color:#5a5a6e;font-size:10px;';
  root.append(detail);

  parent.append(root);

  let done = false;
  let timer = 0;

  return {
    set(progress: LoadProgress): void {
      if (done) return;
      label.textContent = progress.label;
      fill.style.width = `${Math.round(progress.fraction * 100)}%`;
      // The chunk count while chunks are the thing; a percentage once the bar is
      // measuring something a player has no unit for. Either way a number, so
      // "slow" and "stuck" stay distinguishable.
      detail.textContent =
        progress.phase === 'routing'
          ? `${Math.round(progress.fraction * 100)}%`
          : progress.needed > 0
            ? `${progress.held} / ${progress.needed} chunks`
            : '';
      root.dataset['loadingPhase'] = progress.phase;

      if (progress.phase !== 'ready') return;
      done = true;
      root.style.opacity = '0';
      // Removed rather than left transparent over the world: an element with
      // `inset:0` still eats every pointer event that lands on it, and a
      // finished loading screen that silently swallows the first click is worse
      // than one that never faded.
      timer = window.setTimeout(() => root.remove(), FADE_MS);
    },
    dispose(): void {
      window.clearTimeout(timer);
      root.remove();
    },
  };
}
