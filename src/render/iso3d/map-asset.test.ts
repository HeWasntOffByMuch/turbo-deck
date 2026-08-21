/**
 * One fetch of the map per page, and a failure you can retry (spec 199).
 *
 * The memo is the whole of this module, so it is the whole of this file: three
 * tabs share one document and switching between them must not fetch 11.5 MB
 * again, while a dropped request must not become a permanent decision that the
 * world does not exist.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadShippedMapText, resetShippedMapText } from './map-asset.js';

const real = globalThis.fetch;

afterEach(() => {
  resetShippedMapText();
  globalThis.fetch = real;
});

function respondWith(body: string): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = vi.fn(() => {
    calls += 1;
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as unknown as typeof fetch;
  return { calls: () => calls };
}

describe('the shipped map asset', () => {
  it('fetches once however many readers ask', async () => {
    const stub = respondWith('{"map":true}');
    const [a, b, c] = await Promise.all([
      loadShippedMapText(),
      loadShippedMapText(),
      loadShippedMapText(),
    ]);
    expect(stub.calls()).toBe(1);
    expect(a).toBe('{"map":true}');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('caches the promise, not the string, so a race costs one request', async () => {
    // Three callers arriving before the first resolves is the ordinary case --
    // the Play tab and the editor are two tabs of one page. Caching the string
    // would only help the callers that arrived after it landed.
    const stub = respondWith('x');
    const first = loadShippedMapText();
    const second = loadShippedMapText();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(stub.calls()).toBe(1);
  });

  it('still answers from the memo after it has resolved', async () => {
    const stub = respondWith('y');
    await loadShippedMapText();
    await loadShippedMapText();
    expect(stub.calls()).toBe(1);
  });

  it('refuses a response that is not ok, and says which status', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response('nope', { status: 404, statusText: 'Not Found' })),
    ) as unknown as typeof fetch;
    await expect(loadShippedMapText()).rejects.toThrow(/404/);
  });

  it('lets a failure be retried rather than deciding the world is gone', async () => {
    // The memo is cleared on the way out. Without it, one dropped request would
    // be inherited by every later caller that never asked -- and the retry is
    // somebody pressing the tab again, which should be allowed to work.
    let attempt = 0;
    globalThis.fetch = vi.fn(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(new Response('recovered', { status: 200 }));
    }) as unknown as typeof fetch;

    await expect(loadShippedMapText()).rejects.toThrow('offline');
    await expect(loadShippedMapText()).resolves.toBe('recovered');
    expect(attempt).toBe(2);
  });
});
