/**
 * The handle the frame holds, and the twin it falls back to (spec 180).
 *
 * Two implementations of one interface, and the second is not a courtesy:
 *
 * - `npm test` runs in Node, where the `Worker` global does not exist. Without
 *   an in-process twin the entire load pipeline would be reachable only from a
 *   browser, which is the state spec 165 spent four follow-ups regretting.
 * - `new Worker` can simply fail -- a stale service worker, a CSP, a browser
 *   with modules off -- and a world that does not load is a worse outcome than
 *   a world that loads the way it used to.
 * - `?perf=noworker` is how the two are compared on one machine, which is the
 *   only honest way to say what the change bought.
 *
 * The twin runs the identical `MapWorkerCore` on the calling thread and hands
 * its replies back through the same callback, so nothing above this file knows
 * which one it has.
 *
 * There is no `dispose`. The Play tab is mounted once per page and reused --
 * `shell-tabs` hides a view rather than destroying it -- so the worker's
 * lifetime is the page's, like the socket's and the renderer's, and a
 * `terminate` that only ever ran at unload is a method that exists to look
 * tidy. Hiding the tab must *not* stop it: chunks already offered are still
 * owed, and dropping their replies is spec 165's hole-that-never-fills-in.
 */

import { MapWorkerCore } from './map-worker-core.js';
import type { MapWorkerReply, MapWorkerRequest } from './map-worker-protocol.js';

export interface MapWorkerHandle {
  /** Whether the work is actually happening somewhere else. */
  readonly threaded: boolean;
  send(request: MapWorkerRequest): void;
}

/**
 * A worker, or the twin if one cannot be had.
 *
 * `onReply` is called with each result. On the twin it is called *during*
 * `send`, synchronously -- which is a difference the caller must not care
 * about, and does not: replies go into an inbox either way and the frame drains
 * it.
 */
export function createMapWorker(
  onReply: (reply: MapWorkerReply) => void,
  options: { readonly threaded?: boolean } = {},
): MapWorkerHandle {
  if (options.threaded !== false) {
    const worker = spawn(onReply);
    if (worker) return worker;
  }
  return inProcess(onReply);
}

function spawn(onReply: (reply: MapWorkerReply) => void): MapWorkerHandle | null {
  if (typeof Worker === 'undefined') return null;
  try {
    // `new URL(..., import.meta.url)` is what makes this a bundled entry rather
    // than a runtime path: Vite rewrites it in dev and in the build, and a
    // string here would resolve against the page and 404.
    const worker = new Worker(new URL('./map-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<MapWorkerReply>): void => onReply(event.data);
    return { threaded: true, send: (request) => worker.postMessage(request) };
  } catch {
    // Deliberately silent about *which* way it failed: there is nothing the
    // player can do about any of them, and the twin below means there is
    // nothing to report beyond a slower load.
    return null;
  }
}

function inProcess(onReply: (reply: MapWorkerReply) => void): MapWorkerHandle {
  const core = new MapWorkerCore();
  return {
    threaded: false,
    send(request) {
      switch (request.kind) {
        case 'map':
          // The twin shares this thread's module graph, so the size is already
          // set -- passed anyway, because a twin that took a different path
          // from the worker is a twin that stops proving anything.
          core.setMap(request.info, request.propRegionSize);
          return;
        case 'chunk':
          for (const out of core.addChunk(request.held)) onReply(out);
          return;
        case 'nav': {
          const out = core.navGrid(request.radius);
          if (out) onReply(out);
          return;
        }
        case 'props':
          for (const out of core.propRegions(request.rects)) onReply(out);
          return;
      }
    },
  };
}
