/**
 * Where the socket is, said plainly (spec 144).
 *
 * A tab that is quietly not connected looks exactly like a tab where nothing is
 * happening, and over a real wire "nothing is happening" is the single most
 * likely thing to go wrong -- a server that is not running, a proxy that is not
 * forwarding, an asset hash the server refused. So the three states get a line
 * on screen rather than a line in the console.
 *
 * DOM only, and deliberately not drawn into the canvas: a refused connection is
 * exactly the case where the scene may never render a frame, and a message that
 * needs the renderer to work cannot report that the renderer has nothing to draw.
 * That is also why it is not built on `error-log.ts` (spec 143), which lives in
 * the world overlay and speaks about refused casts.
 *
 * `data-connection` and `data-text` follow the convention `view-controls.ts` and
 * `error-log.ts` already set -- a probe reads an attribute rather than
 * photographing a pixel.
 */

import type { ConnectionPhase } from '../../../server/net/transport-browser.js';

/** How long a successful connection stays on screen before it stops being news. */
const SETTLE_MS = 1500;

const COLOURS: Record<ConnectionPhase, string> = {
  connecting: '#d9a441',
  connected: '#6fbf73',
  closed: '#d95f5f',
};

export interface ConnectionBanner {
  /** Report a phase change from the channel. */
  set(phase: ConnectionPhase, url: string): void;
  /** A connection that was refused outright, with the server's reason. */
  refuse(reason: string): void;
  /** A note that survives alongside the phase -- a wrong map, say. */
  note(text: string): void;
  dispose(): void;
}

export function createConnectionBanner(root: HTMLElement): ConnectionBanner {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:absolute',
    'left:8px',
    'top:8px',
    // Above the loading overlay (spec 165), which is opaque and covers the whole
    // frame: the moments this banner exists for -- connecting, refused,
    // reconnecting -- are exactly the moments the loading screen is up, and a
    // refusal nobody can read is a hang as far as the player is concerned.
    'z-index:60',
    'padding:4px 8px',
    'border-radius:3px',
    'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
    'color:#f2f2f2',
    'background:rgba(12,12,18,0.82)',
    'pointer-events:none',
    'white-space:pre',
  ].join(';');
  el.hidden = true;
  root.append(el);

  let hideTimer = 0;
  let extra = '';

  function paint(phase: ConnectionPhase | 'refused', text: string): void {
    if (hideTimer !== 0) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
    const full = extra === '' ? text : `${text}\n${extra}`;
    el.hidden = false;
    el.textContent = full;
    el.style.borderLeft = `3px solid ${COLOURS[phase === 'refused' ? 'closed' : phase]}`;
    root.dataset['connection'] = phase;
    el.dataset['connection'] = phase;
    el.dataset['text'] = full;
    // Only a healthy connection with nothing else to say gets to disappear.
    // Anything else stays up, because it is the thing somebody needs to read.
    if (phase === 'connected' && extra === '') {
      hideTimer = window.setTimeout(() => {
        el.hidden = true;
        hideTimer = 0;
      }, SETTLE_MS);
    }
  }

  return {
    set(phase, url) {
      const where = url.replace(/^wss?:\/\//, '');
      paint(
        phase,
        phase === 'connecting'
          ? `connecting to ${where}...`
          : phase === 'connected'
            ? `connected to ${where}`
            : `disconnected from ${where}`,
      );
    },
    refuse(reason) {
      paint('refused', `connection refused: ${reason}`);
    },
    note(text) {
      extra = text;
      paint((root.dataset['connection'] as ConnectionPhase) ?? 'connecting', el.textContent?.split('\n')[0] ?? '');
    },
    dispose() {
      if (hideTimer !== 0) clearTimeout(hideTimer);
      el.remove();
    },
  };
}
