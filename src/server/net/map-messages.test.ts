/**
 * The map survives the wire exactly (spec 070).
 *
 * "Exactly" is the whole test. A chunk that decoded to values a few ulps off
 * would look perfect and be wrong: the client's `heightAt` would sit
 * fractionally below the server's, and the sim would answer that with position
 * corrections on ground that appears flat. So every comparison here is
 * `toEqual`, never `toBeCloseTo`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { isKnownPropKind, parseMap, type MapChunk } from '../../terrain/map.js';
import { BufferReader } from './codec.js';
import {
  decodeChunkDenied,
  decodeMapChunk,
  decodeMapInfo,
  encodeChunkDenied,
  encodeMapChunk,
  encodeMapInfo,
} from './map-messages.js';
import { decodeClientMessage, decodeServerMessage, encodeClientMessage, encodeServerMessage } from './messages.js';
import { ChunkDeniedReason, ClientMessageType, ServerMessageType } from './protocol.js';
import { buildMapIndex, mapIdOf } from '../world/map-index.js';

const text = readFileSync('maps/arena.json', 'utf8');
const doc = parseMap(text);
const index = buildMapIndex(doc, mapIdOf(text));

/** Skip the type byte the encoders write, so a reader starts on the payload. */
function payload(bytes: Uint8Array): BufferReader {
  const reader = new BufferReader(bytes);
  reader.u8();
  return reader;
}

describe('the shipped map', () => {
  it('parses, and has chunks', () => {
    expect(doc.version).toBe(1);
    expect(doc.layers.length).toBeGreaterThan(0);
    expect(index.layers[0]?.coords.length).toBeGreaterThan(0);
  });

  it('only contains props the renderer can build', () => {
    for (const species of index.species) expect(isKnownPropKind(species)).toBe(true);
  });

  it('has nav baked, so no client has to re-derive it', () => {
    for (const layer of doc.layers) {
      for (const chunk of layer.chunks) expect(chunk.nav).not.toBeNull();
    }
  });
});

describe('MapChunk round trip', () => {
  const chunks: { layer: number; chunk: MapChunk }[] = [];
  for (let l = 0; l < doc.layers.length; l++) {
    for (const chunk of doc.layers[l]?.chunks ?? []) chunks.push({ layer: l, chunk });
  }

  it('reproduces every chunk of the shipped map exactly', () => {
    for (const { layer, chunk } of chunks) {
      const bytes = encodeMapChunk({
        type: ServerMessageType.MapChunk,
        mapId: index.mapId,
        layer,
        chunk,
      });
      const back = decodeMapChunk(payload(bytes));
      expect(back.layer).toBe(layer);
      expect(back.mapId).toBe(index.mapId);
      // Deep equality over the whole chunk: heights, the run-length arrays, the
      // nav bytes, the props with their optional flags, and the markers.
      expect(back.chunk).toEqual(chunk);
    }
  });

  it('reproduces heights bit for bit, not merely close', () => {
    const chunk = chunks[0]?.chunk;
    expect(chunk).toBeDefined();
    if (!chunk) return;
    const back = decodeMapChunk(
      payload(encodeMapChunk({ type: ServerMessageType.MapChunk, mapId: index.mapId, layer: 0, chunk })),
    );
    for (let i = 0; i < chunk.heights.length; i++) {
      expect(Object.is(back.chunk.heights[i], chunk.heights[i])).toBe(true);
    }
  });

  it('is self-contained: decoding needs no earlier frame', () => {
    // The species table travels with the chunk, so a decoder that has never seen
    // a MapInfo still reads it. Guards the statelessness of decodeServerMessage.
    const withProps = chunks.find((c) => c.chunk.props.length > 0);
    expect(withProps).toBeDefined();
    if (!withProps) return;
    const message = {
      type: ServerMessageType.MapChunk,
      mapId: index.mapId,
      layer: withProps.layer,
      chunk: withProps.chunk,
    } as const;
    const back = decodeServerMessage(encodeServerMessage(message));
    expect(back).toEqual(message);
  });

  it('costs less on the wire than the JSON it came from', () => {
    const chunk = chunks.find((c) => c.chunk.props.length > 0)?.chunk;
    expect(chunk).toBeDefined();
    if (!chunk) return;
    const bytes = encodeMapChunk({
      type: ServerMessageType.MapChunk,
      mapId: index.mapId,
      layer: 0,
      chunk,
    });
    expect(bytes.length).toBeLessThan(JSON.stringify(chunk).length);
  });
});

describe('MapInfo round trip', () => {
  const message = {
    type: ServerMessageType.MapInfo,
    mapId: index.mapId,
    seed: index.seed,
    cellSize: index.cellSize,
    chunkCells: index.chunkCells,
    arena: index.arena,
    species: index.species,
    layers: index.layers.map((l) => ({
      id: l.id,
      seed: l.seed,
      bounds: l.bounds,
      baseY: l.baseY,
      waterLevel: l.waterLevel,
      coords: l.coords,
    })),
  } as const;

  it('reproduces the grid, the arena and every layer', () => {
    expect(decodeMapInfo(payload(encodeMapInfo(message)))).toEqual(message);
  });

  it('survives the top-level dispatch', () => {
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
  });

  it('carries a species table that covers every chunk', () => {
    // The chunk-local tables are the authority; this one is advisory, and the
    // two must not be allowed to drift.
    for (const layer of doc.layers) {
      for (const chunk of layer.chunks) {
        for (const prop of chunk.props) expect(message.species).toContain(prop.species);
      }
    }
  });

  it('announces a null water level as null, not as zero', () => {
    const first = message.layers[0];
    if (!first) throw new Error('the shipped map has no layers');
    const dry = { ...message, layers: [{ ...first, waterLevel: null }] };
    expect(decodeMapInfo(payload(encodeMapInfo(dry))).layers[0]?.waterLevel).toBeNull();
  });
});

describe('the small messages', () => {
  it('round-trips a denial with its reason', () => {
    const message = {
      type: ServerMessageType.ChunkDenied,
      layer: 0,
      cx: -3,
      cz: 7,
      reason: ChunkDeniedReason.OutOfRange,
    } as const;
    expect(decodeChunkDenied(payload(encodeChunkDenied(message)))).toEqual(message);
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
  });

  it('round-trips a request, including negative coordinates', () => {
    const message = {
      type: ClientMessageType.RequestChunk,
      layer: 1,
      cx: -12,
      cz: 40,
    } as const;
    expect(decodeClientMessage(encodeClientMessage(message))).toEqual(message);
  });
});

describe('mapId', () => {
  it('is stable for the same text', () => {
    expect(mapIdOf(text)).toBe(mapIdOf(text));
  });

  it('changes when the document does', () => {
    expect(mapIdOf(text)).not.toBe(mapIdOf(`${text} `));
  });
});
