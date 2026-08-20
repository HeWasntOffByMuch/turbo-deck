/**
 * The worker's doorway (spec 180).
 *
 * Deliberately almost nothing: it owns a `MapWorkerCore` and forwards messages
 * to it. Everything that could be got wrong lives in the core, where it runs on
 * the main thread too and is therefore reachable from `npm test` -- a worker
 * entry is the one file in this feature no headless test can execute, so it is
 * the one file with no decisions in it.
 */

import { MapWorkerCore, transfersOf } from './map-worker-core.js';
import type { MapWorkerReply, MapWorkerRequest } from './map-worker-protocol.js';

const core = new MapWorkerCore();

function reply(message: MapWorkerReply): void {
  // Transferred, not cloned. See `transfersOf`.
  (self as unknown as { postMessage: (m: unknown, t: ArrayBuffer[]) => void }).postMessage(
    message,
    transfersOf(message),
  );
}

self.onmessage = (event: MessageEvent<MapWorkerRequest>): void => {
  const request = event.data;
  switch (request.kind) {
    case 'map':
      core.setMap(request.info, request.propRegionSize);
      return;
    case 'chunk':
      for (const out of core.addChunk(request.held)) reply(out);
      return;
    case 'nav': {
      const out = core.navGrid(request.radius);
      if (out) reply(out);
      return;
    }
    case 'props':
      for (const out of core.propRegions(request.rects)) reply(out);
      return;
  }
};
