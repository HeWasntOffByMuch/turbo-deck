/**
 * The map survives the wire exactly (spec 072).
 *
 * "Exactly" is the whole test. A chunk that decoded to values a few ulps off
 * would look perfect and be wrong: the client's `heightAt` would sit
 * fractionally below the server's, and the sim would answer that with position
 * corrections on ground that appears flat. So every comparison here is
 * `toEqual`, never `toBeCloseTo`.
 */

import { describe, expect, it } from 'vitest';

import { MAP_VERSION, isKnownPropKind, type MapChunk } from '../../terrain/map.js';
import { MAX_SIGN_TEXT } from '../../terrain/vegetation.js';
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
import { loadMapFile } from '../../server/world/map-file.js';

const shipped = loadMapFile();
const doc = shipped.doc;
const index = buildMapIndex(doc, shipped.mapId);

/** Skip the type byte the encoders write, so a reader starts on the payload. */
function payload(bytes: Uint8Array): BufferReader {
  const reader = new BufferReader(bytes);
  reader.u8();
  return reader;
}

describe('the shipped map', () => {
  it('parses, and has chunks', () => {
    expect(doc.version).toBe(MAP_VERSION);
    expect(doc.layers.length).toBeGreaterThan(0);
    expect(index.layers[0]?.coords.length).toBeGreaterThan(0);
  });

  it('only contains props the renderer can build', () => {
    for (const species of index.species) expect(isKnownPropKind(species)).toBe(true);
  });

  it('carries no baked walkability, in the document or on the wire', () => {
    // Spec 204. It was a run list per chunk sent to every client and read by
    // exactly one thing -- the editor's overlay, which loads the map off disk
    // and has never streamed.
    expect(JSON.stringify(doc)).not.toContain('"nav"');
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

  it('reproduces a chunk sitting west and north of the origin', () => {
    // A grown map's chunks have negative coordinates (spec 083). They are
    // zigzag varints, so this costs no more bytes than a positive one -- but
    // only if the sign actually survives.
    const chunk = chunks[0]?.chunk;
    expect(chunk).toBeDefined();
    if (!chunk) return;
    const west = { ...chunk, cx: -3, cz: -11 };
    const back = decodeMapChunk(
      payload(encodeMapChunk({ type: ServerMessageType.MapChunk, mapId: index.mapId, layer: 0, chunk: west })),
    );
    expect(back.chunk).toEqual(west);
  });

  /**
   * A fixture's own numbers cross too (spec 250).
   *
   * The shipped map's four fixtures all burn at their kind's defaults and so
   * carry *no* override -- which is the point of the defaults and is also why
   * the test above cannot cover this. Without a flag on the wire the override
   * would be silently dropped somewhere between the map file and the client,
   * and every fixture in the game would look correct: it would simply be the
   * table's brightness rather than the one somebody set.
   */
  it("reproduces a fixture's own brightness and reach", () => {
    const chunk = chunks[0]?.chunk;
    expect(chunk).toBeDefined();
    if (!chunk) return;
    const lit: MapChunk = {
      ...chunk,
      props: [
        { species: 'campfire', x: 10, z: 20, rotation: 0, scale: 1, tint: 0, light: { brightness: 1.25, radius: 250 } },
        // Beside one that carries none, so the flag is proved to be per prop
        // rather than per chunk -- and so a decoder that read two numbers it was
        // not sent would desynchronise on this one and fail loudly.
        { species: 'lamp-post', x: 30, z: 40, rotation: 0, scale: 1, tint: 0 },
        { species: 'campfire', x: 50, z: 60, rotation: 0, scale: 2, tint: 0.5, light: { brightness: 6, radius: 900 } },
      ],
    };
    const back = decodeMapChunk(
      payload(encodeMapChunk({ type: ServerMessageType.MapChunk, mapId: index.mapId, layer: 0, chunk: lit })),
    );
    expect(back.chunk).toEqual(lit);
  });

  /**
   * A sign's message crosses too (spec 259).
   *
   * The second optional block on a prop, which is what this is really about:
   * with two of them the *order* has to be agreed, and a decoder that read the
   * string before the light -- or read one it was not sent -- would not lose a
   * message, it would desynchronise every prop after it in the chunk. Hence a
   * chunk holding one of each and one of both.
   */
  it("reproduces a sign's message, beside a light on the same chunk", () => {
    const chunk = chunks[0]?.chunk;
    expect(chunk).toBeDefined();
    if (!chunk) return;
    const said: MapChunk = {
      ...chunk,
      props: [
        { species: 'sign', x: 10, z: 20, rotation: 0, scale: 1, tint: 0, text: 'Hearthstead, two miles' },
        { species: 'campfire', x: 30, z: 40, rotation: 0, scale: 1, tint: 0, light: { brightness: 2, radius: 300 } },
        // Neither, so the flags byte is proved to be per prop.
        { species: 'well', x: 50, z: 60, rotation: 0, scale: 1, tint: 0 },
        // Quotes, a backslash and a newline: a message is the one field in a
        // prop record that holds text somebody typed.
        { species: 'sign', x: 70, z: 80, rotation: 0, scale: 1, tint: 0, text: 'He said "no".\nC:\\road' },
        // The longest a document may carry, so the length prefix is exercised
        // past one byte.
        { species: 'sign', x: 90, z: 100, rotation: 0, scale: 1, tint: 0, text: 'x'.repeat(MAX_SIGN_TEXT) },
      ],
    };
    const back = decodeMapChunk(
      payload(encodeMapChunk({ type: ServerMessageType.MapChunk, mapId: index.mapId, layer: 0, chunk: said })),
    );
    expect(back.chunk).toEqual(said);
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
      origin: l.origin,
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

  /**
   * A grown map has chunks west and north of its origin (spec 083), and the
   * origin itself no longer sits at the layer's corner. Both travel, and both
   * stay exact: an offset dropped here would land every streamed chunk a chunk
   * away from where the server put it.
   */
  it('carries an origin that is not the layer corner, and negative coordinates', () => {
    const first = message.layers[0];
    if (!first) throw new Error('the shipped map has no layers');
    const grown = {
      ...message,
      layers: [
        {
          ...first,
          origin: { x: 120.5, z: -80.25 },
          bounds: { minX: -2000, minZ: -2000, maxX: 2800, maxZ: 2500 },
          coords: [
            { cx: -4, cz: -7 },
            { cx: 0, cz: 0 },
            { cx: 13, cz: 6 },
          ],
        },
      ],
    };
    const back = decodeMapInfo(payload(encodeMapInfo(grown))).layers[0];
    expect(back?.origin).toEqual({ x: 120.5, z: -80.25 });
    expect(back?.coords).toEqual(grown.layers[0]?.coords);
    expect(back?.bounds).toEqual(grown.layers[0]?.bounds);
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
  // Still the text hash, because that is what `mapIdOf` is. Since spec 204 the
  // *world's* identity comes off the manifest instead -- a hash of ordered
  // region hashes -- and this remains the primitive underneath both.
  const sample = 'a map, as text';

  it('is stable for the same text', () => {
    expect(mapIdOf(sample)).toBe(mapIdOf(sample));
  });

  it('changes when the document does', () => {
    expect(mapIdOf(sample)).not.toBe(mapIdOf(`${sample} `));
  });

  it('is what the shipped map is served under', () => {
    expect(shipped.mapId).toHaveLength(8);
    expect(index.mapId).toBe(shipped.mapId);
  });
});
