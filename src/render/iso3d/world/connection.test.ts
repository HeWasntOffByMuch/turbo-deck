/**
 * Which server, and who am I (spec 144).
 *
 * A table, because getting this wrong means two tabs claiming the same player
 * and the symptom looks like a server bug rather than a query-string bug.
 */

import { describe, expect, it } from 'vitest';
import type { StorageLike } from '../../../ui/core/layout-store.js';
import { planConnection, PLAYER_ID_KEY, PLAYER_NAME_KEY } from './connection.js';

function storage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/** A storage that refuses everything -- private browsing, a quota, a policy. */
function hostileStorage(): StorageLike {
  return {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };
}

const HTTP = { protocol: 'http:', host: 'localhost:5173' };
const HTTPS = { protocol: 'https:', host: 'play.example.com' };

function ids(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe('planConnection', () => {
  it('is single-player when nothing asks otherwise', () => {
    expect(planConnection('', HTTP, storage(), ids())).toEqual({ mode: 'loopback' });
    // Other params must not accidentally turn multiplayer on.
    expect(planConnection('?seed=4&units=grazer:pig', HTTP, storage(), ids())).toEqual({
      mode: 'loopback',
    });
  });

  it('defaults a bare ?server to the same origin', () => {
    const plan = planConnection('?server', HTTP, storage(), ids());
    expect(plan.mode).toBe('remote');
    if (plan.mode !== 'remote') return;
    expect(plan.url).toBe('ws://localhost:5173/ws');
  });

  it('uses wss when the page is https', () => {
    const plan = planConnection('?server', HTTPS, storage(), ids());
    if (plan.mode !== 'remote') throw new Error('expected remote');
    expect(plan.url).toBe('wss://play.example.com/ws');
  });

  it('takes an explicit url verbatim, and converts an http one', () => {
    const cases: readonly [string, string][] = [
      ['?server=ws://localhost:8787/ws', 'ws://localhost:8787/ws'],
      ['?server=wss://other.example.com/game', 'wss://other.example.com/game'],
      ['?server=http://localhost:8787/ws', 'ws://localhost:8787/ws'],
      ['?server=https://other.example.com/', 'wss://other.example.com/'],
    ];
    for (const [search, expected] of cases) {
      const plan = planConnection(search, HTTP, storage(), ids());
      if (plan.mode !== 'remote') throw new Error(`expected remote for ${search}`);
      expect(plan.url).toBe(expected);
    }
  });

  it('falls back to a real host when the page has no origin', () => {
    const plan = planConnection('?server', { protocol: 'file:', host: '' }, storage(), ids());
    if (plan.mode !== 'remote') throw new Error('expected remote');
    expect(plan.url).toBe('ws://localhost:8787/ws');
  });

  it('mints an id once and reuses it -- a reload is the same player', () => {
    const store = storage();
    const mint = ids();
    const first = planConnection('?server', HTTP, store, mint);
    const second = planConnection('?server', HTTP, store, mint);
    if (first.mode !== 'remote' || second.mode !== 'remote') throw new Error('expected remote');
    expect(first.playerId).toBe('id-1');
    expect(second.playerId).toBe('id-1');
    expect(store.map.get(PLAYER_ID_KEY)).toBe('id-1');
  });

  it('gives two tabs two players', () => {
    // Two sessionStorages is exactly what two tabs are.
    const mint = ids();
    const a = planConnection('?server', HTTP, storage(), mint);
    const b = planConnection('?server', HTTP, storage(), mint);
    if (a.mode !== 'remote' || b.mode !== 'remote') throw new Error('expected remote');
    expect(a.playerId).not.toBe(b.playerId);
  });

  it('lets ?id pin the identity, and stores it', () => {
    const store = storage();
    const plan = planConnection('?server&id=ana', HTTP, store, ids());
    if (plan.mode !== 'remote') throw new Error('expected remote');
    expect(plan.playerId).toBe('ana');
    expect(store.map.get(PLAYER_ID_KEY)).toBe('ana');
  });

  it('takes ?name, persists it, and derives one when absent', () => {
    const store = storage();
    const named = planConnection('?server&name=Ana', HTTP, store, ids());
    if (named.mode !== 'remote') throw new Error('expected remote');
    expect(named.displayName).toBe('Ana');
    expect(store.map.get(PLAYER_NAME_KEY)).toBe('Ana');

    // A reload without ?name keeps it.
    const again = planConnection('?server', HTTP, store, ids());
    if (again.mode !== 'remote') throw new Error('expected remote');
    expect(again.displayName).toBe('Ana');

    const anon = planConnection('?server&id=abcdef', HTTP, storage(), ids());
    if (anon.mode !== 'remote') throw new Error('expected remote');
    expect(anon.displayName).toBe('Player abcd');
  });

  it('costs a fresh id rather than an exception when storage refuses', () => {
    const mint = ids();
    const first = planConnection('?server&name=Ana', HTTP, hostileStorage(), mint);
    const second = planConnection('?server&name=Ana', HTTP, hostileStorage(), mint);
    if (first.mode !== 'remote' || second.mode !== 'remote') throw new Error('expected remote');
    expect(first.playerId).toBe('id-1');
    // Nothing persisted, so the next load is a new player -- degraded, not broken.
    expect(second.playerId).toBe('id-2');
    expect(first.displayName).toBe('Ana');
  });
});
