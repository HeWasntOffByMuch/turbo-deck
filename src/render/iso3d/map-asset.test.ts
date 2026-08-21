/**
 * Fetching the map the browser's way, in Node (specs 202, 203).
 *
 * `import.meta.glob` resolves every region's URL at build time, and vitest runs
 * the same transform -- so the loader under test is the one that ships, and the
 * only thing stubbed is `fetch`. It answers out of `maps/arena/`, which makes
 * this a round trip through the *real* split rather than through a fabricated
 * body: the manifest is the shipped manifest, the regions are the shipped
 * regions, and the document that comes back is the world.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadShippedMap, resetShippedMap } from './map-asset.js';
import { loadMapFile } from '../../server/world/map-file.js';

const real = globalThis.fetch;

afterEach(() => {
  resetShippedMap();
  globalThis.fetch = real;
});

/**
 * Serve `maps/arena/` over the stub, and count the requests.
 *
 * A URL from `import.meta.glob` is a path into the source tree, so the last two
 * segments are all that is needed to find the file again.
 */
function serveTheRealMap(): { requests: () => number } {
  let requests = 0;
  globalThis.fetch = vi.fn((input: unknown) => {
    requests += 1;
    const url = String(input);
    const clean = url.split('?')[0] ?? url;
    const name = clean.slice(clean.lastIndexOf('/') + 1);
    const path = clean.includes('/r/') ? join('maps/arena/r', name) : join('maps/arena', name);
    try {
      return Promise.resolve(new Response(readFileSync(path, 'utf8'), { status: 200 }));
    } catch {
      return Promise.resolve(new Response('missing', { status: 404, statusText: 'Not Found' }));
    }
  }) as unknown as typeof fetch;
  return { requests: () => requests };
}

describe('the shipped map, fetched', () => {
  it('comes back as the world the server reads off disk', async () => {
    serveTheRealMap();
    const fetched = await loadShippedMap();
    const onDisk = loadMapFile();

    // The identity is the thing both ends compare, so it is the thing worth
    // asserting first.
    expect(fetched.mapId).toBe(onDisk.mapId);
    expect(fetched.doc.layers[0]?.chunks).toHaveLength(onDisk.doc.layers[0]?.chunks.length ?? -1);
    expect(fetched.doc.version).toBe(onDisk.doc.version);
  });

  it('asks for the manifest and every region it names, once each', async () => {
    const stub = serveTheRealMap();
    const fetched = await loadShippedMap();
    const regions = fetched.manifest.layers.reduce((n, l) => n + l.regions.length, 0);
    expect(stub.requests()).toBe(regions + 1);
  });

  it('fetches once however many readers ask', async () => {
    const stub = serveTheRealMap();
    const [a, b, c] = await Promise.all([loadShippedMap(), loadShippedMap(), loadShippedMap()]);
    const regions = a.manifest.layers.reduce((n, l) => n + l.regions.length, 0);
    expect(stub.requests()).toBe(regions + 1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('caches the promise, not the result, so a race costs one set of requests', async () => {
    // Three callers arriving before the first resolves is the ordinary case --
    // the Play tab and the editor are two tabs of one page.
    serveTheRealMap();
    const first = loadShippedMap();
    const second = loadShippedMap();
    expect(first).toBe(second);
    await Promise.all([first, second]);
  });

  it('refuses a response that is not ok, and says which status', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response('nope', { status: 404, statusText: 'Not Found' })),
    ) as unknown as typeof fetch;
    await expect(loadShippedMap()).rejects.toThrow(/404/);
  });

  it('lets a failure be retried rather than deciding the world is gone', async () => {
    // The memo is cleared on the way out. Without it one dropped request would
    // be inherited by every later caller that never asked -- and the retry is
    // somebody pressing the tab again, which should be allowed to work.
    let attempt = 0;
    const good = serveTheRealMap;
    globalThis.fetch = vi.fn(() => {
      attempt += 1;
      return Promise.reject(new Error('offline'));
    }) as unknown as typeof fetch;

    await expect(loadShippedMap()).rejects.toThrow('offline');
    expect(attempt).toBe(1);
    good();
    await expect(loadShippedMap()).resolves.toHaveProperty('mapId');
  });
});
