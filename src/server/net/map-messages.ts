/**
 * The map on the wire (spec 072).
 *
 * Kept out of `messages.ts` because it is a different kind of traffic: the game
 * messages describe a world that is changing twenty times a second, and these
 * describe one that does not change at all. They are requested rather than
 * pushed, they are large, and each one is sent to a given client exactly once.
 *
 * **Every coordinate here is an integer of thousandths, never an `f32`.** A map
 * document is quantized to 3 decimals (`MAP_QUANTUM`), and most such values have
 * no exact `f32`. Decoding to a float that is a few ulps off would give a client
 * a heightfield fractionally below the server's, and the sim would answer that
 * with position corrections on ground that looks perfectly flat. Sending the
 * integer and dividing on arrival makes the two sides equal, not close.
 */

import {
  MAP_QUANTUM,
  type MapChunk,
  type MapMarker,
  type MapMarkerKind,
  type MapPoint,
  type MapProp,
  type MapRect,
} from '../../terrain/map.js';
import { BufferReader, BufferWriter, CodecError } from './codec.js';
import {
  MapMarkerKindValue,
  MapPropFlag,
  ServerMessageType,
  ClientMessageType,
} from './protocol.js';

/** A document number as the integer it was quantized to. */
function q(value: number): number {
  return Math.round(value * MAP_QUANTUM);
}

/** ...and back. Exact for anything `quantize` produced. */
function unq(value: number): number {
  const r = value / MAP_QUANTUM;
  return r === 0 ? 0 : r;
}

export interface ChunkCoordMsg {
  readonly cx: number;
  readonly cz: number;
}

export interface MapLayerInfoMsg {
  readonly id: string;
  readonly seed: number;
  /**
   * The world point the layer's chunk grid is anchored at (spec 083).
   *
   * Sent rather than inferred from `bounds`: since a map can grow, the two are
   * no longer the same point, and a client that assumed they were would place
   * every streamed chunk at an offset from where the server put it.
   */
  readonly origin: MapPoint;
  readonly bounds: MapRect;
  readonly baseY: number;
  readonly waterLevel: number | null;
  readonly coords: readonly ChunkCoordMsg[];
}

export interface MapInfoMessage {
  readonly type: typeof ServerMessageType.MapInfo;
  readonly mapId: string;
  readonly seed: number;
  readonly cellSize: number;
  readonly chunkCells: number;
  readonly arena: MapRect;
  /**
   * Every species in the document. Advisory: a chunk carries its own table and
   * decodes without this. It is here so a renderer can build one instanced mesh
   * per species up front rather than discovering a new one mid-stream.
   */
  readonly species: readonly string[];
  readonly layers: readonly MapLayerInfoMsg[];
}

export interface MapChunkMessage {
  readonly type: typeof ServerMessageType.MapChunk;
  readonly mapId: string;
  readonly layer: number;
  readonly chunk: MapChunk;
}

export interface ChunkDeniedMessage {
  readonly type: typeof ServerMessageType.ChunkDenied;
  readonly layer: number;
  readonly cx: number;
  readonly cz: number;
  readonly reason: number;
}

export interface RequestChunkMessage {
  readonly type: typeof ClientMessageType.RequestChunk;
  readonly layer: number;
  readonly cx: number;
  readonly cz: number;
}

// --- rects -----------------------------------------------------------------

function writeRect(w: BufferWriter, rect: MapRect): void {
  w.varint(q(rect.minX)).varint(q(rect.minZ)).varint(q(rect.maxX)).varint(q(rect.maxZ));
}

function readRect(r: BufferReader): MapRect {
  return {
    minX: unq(r.varint()),
    minZ: unq(r.varint()),
    maxX: unq(r.varint()),
    maxZ: unq(r.varint()),
  };
}

// --- run-length arrays -----------------------------------------------------

/**
 * The document already stores `solid`/`materials`/`tones` as flat `value, count`
 * pairs, so they go over as-is rather than being expanded and re-encoded. Both
 * members are small non-negative integers, which is the varuint's best case.
 */
function writeRuns(w: BufferWriter, runs: readonly number[]): void {
  w.varuint(runs.length);
  for (const value of runs) w.varuint(value);
}

function readRuns(r: BufferReader): number[] {
  const length = r.count();
  const runs: number[] = new Array<number>(length);
  for (let i = 0; i < length; i++) runs[i] = r.varuint();
  return runs;
}

// --- the messages ----------------------------------------------------------

export function encodeMapInfo(msg: MapInfoMessage): Uint8Array {
  const w = new BufferWriter(1024);
  w.u8(ServerMessageType.MapInfo);
  w.str(msg.mapId);
  w.u32(msg.seed >>> 0);
  w.varint(q(msg.cellSize));
  w.varuint(msg.chunkCells);
  writeRect(w, msg.arena);

  w.varuint(msg.species.length);
  for (const s of msg.species) w.str(s);

  w.varuint(msg.layers.length);
  for (const layer of msg.layers) {
    w.str(layer.id);
    w.u32(layer.seed >>> 0);
    w.varint(q(layer.origin.x)).varint(q(layer.origin.z));
    writeRect(w, layer.bounds);
    w.varint(q(layer.baseY));
    w.bool(layer.waterLevel !== null);
    w.varint(layer.waterLevel === null ? 0 : q(layer.waterLevel));
    w.varuint(layer.coords.length);
    for (const c of layer.coords) w.varint(c.cx).varint(c.cz);
  }
  return w.toBytes();
}

export function decodeMapInfo(r: BufferReader): MapInfoMessage {
  const mapId = r.str();
  const seed = r.u32();
  const cellSize = unq(r.varint());
  const chunkCells = r.varuint();
  const arena = readRect(r);

  const speciesCount = r.count();
  const species: string[] = new Array<string>(speciesCount);
  for (let i = 0; i < speciesCount; i++) species[i] = r.str();

  const layerCount = r.count();
  const layers: MapLayerInfoMsg[] = new Array<MapLayerInfoMsg>(layerCount);
  for (let i = 0; i < layerCount; i++) {
    const id = r.str();
    const layerSeed = r.u32();
    const origin = { x: unq(r.varint()), z: unq(r.varint()) };
    const bounds = readRect(r);
    const baseY = unq(r.varint());
    const hasWater = r.bool();
    const water = unq(r.varint());
    const coordCount = r.count();
    const coords: ChunkCoordMsg[] = new Array<ChunkCoordMsg>(coordCount);
    for (let c = 0; c < coordCount; c++) coords[c] = { cx: r.varint(), cz: r.varint() };
    layers[i] = {
      id,
      seed: layerSeed,
      origin,
      bounds,
      baseY,
      waterLevel: hasWater ? water : null,
      coords,
    };
  }

  return {
    type: ServerMessageType.MapInfo,
    mapId,
    seed,
    cellSize,
    chunkCells,
    arena,
    species,
    layers,
  };
}

/**
 * The distinct species in a chunk, sorted. A chunk holds tens of props drawn
 * from two or three species, so a local table plus an index per prop beats a
 * string per prop several times over.
 *
 * Local to the chunk rather than shared with `MapInfo`'s table on purpose:
 * `decodeServerMessage` is stateless, and a frame that could only be read by a
 * client that had already seen an *earlier* frame would quietly break that.
 * Three short strings is a cheap price for a self-contained message.
 */
function speciesTableOf(chunk: MapChunk): string[] {
  const seen = new Set<string>();
  for (const prop of chunk.props) seen.add(prop.species);
  return [...seen].sort();
}

/** One chunk, self-contained: everything needed to decode it is in the frame. */
export function encodeMapChunk(msg: MapChunkMessage): Uint8Array {
  const c = msg.chunk;
  const species = speciesTableOf(c);
  // Sized for the common case so the writer does not grow mid-chunk: ~2 bytes a
  // corner plus room for the runs and props.
  const w = new BufferWriter(4096);
  w.u8(ServerMessageType.MapChunk);
  w.str(msg.mapId);
  w.varuint(msg.layer);
  w.varint(c.cx).varint(c.cz);
  w.varuint(c.cols).varuint(c.rows);

  // Heights, delta-encoded against the previous corner. Neighbouring corners of
  // a heightfield are close, so the deltas are small and the zigzag varint keeps
  // most of them to one or two bytes -- roughly half the size of the raw values,
  // and exact, since it is integer arithmetic throughout.
  w.varuint(c.heights.length);
  let previous = 0;
  for (const height of c.heights) {
    const value = q(height);
    w.varint(value - previous);
    previous = value;
  }

  writeRuns(w, c.solid);
  writeRuns(w, c.materials);
  writeRuns(w, c.tones);

  // `nav` left this wire in spec 204. It was a run list per chunk carrying baked
  // walkability to every client, and the only thing that ever read it was the
  // *editor's* overlay -- which loads the map off disk and never streams.

  w.varuint(species.length);
  for (const s of species) w.str(s);

  w.varuint(c.props.length);
  for (const prop of c.props) {
    const index = species.indexOf(prop.species);
    if (index < 0) throw new CodecError(`prop species not in table: ${prop.species}`);
    w.varuint(index);
    w.varint(q(prop.x)).varint(q(prop.z));
    w.varint(q(prop.rotation)).varint(q(prop.scale)).varint(q(prop.tint));
    w.u8(
      (prop.align === true ? MapPropFlag.Align : 0) |
        (prop.uniform === true ? MapPropFlag.Uniform : 0) |
        (prop.light ? MapPropFlag.Light : 0) |
        (prop.text === undefined ? 0 : MapPropFlag.Text),
    );
    // A fixture's own numbers, and only where the document carries them
    // (spec 250). Quantized like every other number on this frame, which is
    // exact for anything `quantize` produced -- and the document's own writer
    // quantizes them, so a light survives the round trip unchanged.
    if (prop.light) w.varint(q(prop.light.brightness)).varint(q(prop.light.radius));
    // And a sign's message after it (spec 260). *After* the light, because the
    // reader takes them in this order and two optional blocks on one prop only
    // work if both ends agree which comes first.
    if (prop.text !== undefined) w.str(prop.text);
  }

  w.varuint(c.markers.length);
  for (const marker of c.markers) {
    const kind = MapMarkerKindValue.indexOf(marker.kind);
    if (kind < 0) throw new CodecError(`unknown marker kind: ${marker.kind}`);
    w.u8(kind);
    w.str(marker.id);
    w.varint(q(marker.x)).varint(q(marker.z));
    w.str(marker.label ?? '');
  }

  return w.toBytes();
}

export function decodeMapChunk(r: BufferReader): MapChunkMessage {
  const mapId = r.str();
  const layer = r.varuint();
  const cx = r.varint();
  const cz = r.varint();
  const cols = r.varuint();
  const rows = r.varuint();

  const heightCount = r.count();
  const heights: number[] = new Array<number>(heightCount);
  let previous = 0;
  for (let i = 0; i < heightCount; i++) {
    previous += r.varint();
    heights[i] = unq(previous);
  }

  const solid = readRuns(r);
  const materials = readRuns(r);
  const tones = readRuns(r);

  const speciesCount = r.count();
  const species: string[] = new Array<string>(speciesCount);
  for (let i = 0; i < speciesCount; i++) species[i] = r.str();

  const propCount = r.count();
  const props: MapProp[] = new Array<MapProp>(propCount);
  for (let i = 0; i < propCount; i++) {
    const index = r.varuint();
    const name = species[index];
    if (name === undefined) throw new CodecError(`prop species index out of range: ${index}`);
    const x = unq(r.varint());
    const z = unq(r.varint());
    const rotation = unq(r.varint());
    const scale = unq(r.varint());
    const tint = unq(r.varint());
    const flags = r.u8();
    // Read unconditionally where the flag says so, and *before* the object is
    // built: the two numbers are in the stream whether or not this build has a
    // use for them, so skipping the read would desynchronise every prop after
    // this one rather than losing one light.
    const light =
      (flags & MapPropFlag.Light) !== 0
        ? { brightness: unq(r.varint()), radius: unq(r.varint()) }
        : undefined;
    // Read here for the reason the light above is: the string is in the stream
    // whether or not this build has a use for it, so skipping the read would
    // desynchronise every prop after this one rather than losing one message.
    const text = (flags & MapPropFlag.Text) !== 0 ? r.str() : undefined;
    // The optional fields are omitted rather than written as false, so a decoded
    // chunk deep-equals the document chunk it was encoded from.
    props[i] = {
      species: name,
      x,
      z,
      rotation,
      scale,
      tint,
      ...((flags & MapPropFlag.Align) !== 0 ? { align: true } : {}),
      ...((flags & MapPropFlag.Uniform) !== 0 ? { uniform: true } : {}),
      ...(light ? { light } : {}),
      ...(text === undefined ? {} : { text }),
    };
  }

  const markerCount = r.count();
  const markers: MapMarker[] = new Array<MapMarker>(markerCount);
  for (let i = 0; i < markerCount; i++) {
    const kindIndex = r.u8();
    const kind = MapMarkerKindValue[kindIndex] as MapMarkerKind | undefined;
    if (kind === undefined) throw new CodecError(`marker kind out of range: ${kindIndex}`);
    const id = r.str();
    const x = unq(r.varint());
    const z = unq(r.varint());
    const label = r.str();
    markers[i] = { kind, id, x, z, ...(label === '' ? {} : { label }) };
  }

  return {
    type: ServerMessageType.MapChunk,
    mapId,
    layer,
    chunk: { cx, cz, cols, rows, heights, solid, materials, tones, props, markers },
  };
}

export function encodeChunkDenied(msg: ChunkDeniedMessage): Uint8Array {
  const w = new BufferWriter(16);
  w.u8(ServerMessageType.ChunkDenied);
  w.varuint(msg.layer).varint(msg.cx).varint(msg.cz).u8(msg.reason);
  return w.toBytes();
}

export function decodeChunkDenied(r: BufferReader): ChunkDeniedMessage {
  return {
    type: ServerMessageType.ChunkDenied,
    layer: r.varuint(),
    cx: r.varint(),
    cz: r.varint(),
    reason: r.u8(),
  };
}

