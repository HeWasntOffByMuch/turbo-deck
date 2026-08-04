import {
  DEFAULT_CHUNK_OPTIONS,
  sampleLayer,
  type ChunkOptions,
  type TerrainChunk,
} from './chunk.js';
import { TERRAIN_MATERIALS, rectContains, type Rect, type TerrainWorld } from './types.js';
import type { Prop, PropKind } from './vegetation.js';

/**
 * The map document (spec 048): a world written down.
 *
 * Until now the world was a *closure* -- `createArenaWorld(seed)` composes a
 * hard-coded feature list into a `sample(x, z)` and every chunk is re-derived
 * from it on demand. That is fine for a generated world and impossible to edit:
 * there is nothing to change but TypeScript.
 *
 * This module inverts the authority. A baked chunk -- its corner heights, its
 * per-cell material, the props standing on it -- becomes the truth, and the
 * feature list is demoted to the generator that produces the first bake. The
 * document is what an editor edits; the field is just where it started.
 *
 * Three properties the format is built around:
 *
 * - **Human-readable and diffable.** Plain JSON, no binary blobs, and heights
 *   emitted one terrain *row* per line, so a document reads as a grid and an
 *   edit to one hillside shows up as a handful of changed lines.
 * - **Chunk-local.** Everything placed at a point -- a prop, a marker -- is
 *   stored relative to its chunk's origin, so a chunk is meaningful on its own
 *   and moving one does not rewrite its contents. The single exception is
 *   `arena`, a rectangle spanning many chunks with no chunk to be local to.
 * - **Declarative.** Numbers, indices and enum strings. No expressions, no code
 *   strings, nothing that has to be evaluated to be understood.
 *
 * What is stored is only what cannot be recomputed. The corner **jitter** and
 * the smooth corner **normals** are pure functions of `(layer seed, cell size,
 * global corner index)` and the heights themselves, so they are rebuilt on load
 * rather than written out -- storing them would triple the file and let it
 * contradict itself. `TerrainRegion` is likewise absent: it exists to feed
 * `classify`, and in a baked map the materials are authoritative.
 */

export const MAP_VERSION = 1;

/**
 * Decimal places kept for every stored coordinate. Terrain relief here spans a
 * few hundred units, so a thousandth is far below anything visible -- and
 * quantising is what makes `export(load(export(w)))` a fixed point instead of
 * drifting in the last bits of a float every save.
 */
const PRECISION = 3;
const QUANTUM = 10 ** PRECISION;

export interface MapRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** A prop instance, positioned in its chunk's local space. */
export interface MapProp {
  /** Species id. `'tree'` and `'bush'` today; open for the editor's palette. */
  readonly species: string;
  readonly x: number;
  readonly z: number;
  readonly rotation: number;
  readonly scale: number;
  readonly tint: number;
  /** Lie the prop along the ground rather than standing it up (spec 051). */
  readonly align?: boolean;
}

export type MapMarkerKind = 'spawn' | 'objective' | 'campfire' | 'trigger';

/** A point of interest, positioned in its chunk's local space. */
export interface MapMarker {
  readonly kind: MapMarkerKind;
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly label?: string;
}

export interface MapChunk {
  readonly cx: number;
  readonly cz: number;
  readonly cols: number;
  readonly rows: number;
  /** `(cols + 1) * (rows + 1)` corner heights, row-major in z. */
  readonly heights: readonly number[];
  /** `cols * rows` cell values, run-length encoded as flat `value, count` pairs. */
  readonly solid: readonly number[];
  readonly materials: readonly number[];
  readonly tones: readonly number[];
  readonly props: readonly MapProp[];
  readonly markers: readonly MapMarker[];
  /** Baked walkability, one flag per cell. Null until the nav bake exists. */
  readonly nav: readonly number[] | null;
}

export interface MapLayer {
  readonly id: string;
  /** Seeds the corner jitter, so it has to survive the round trip. */
  readonly seed: number;
  readonly bounds: MapRect;
  readonly baseY: number;
  readonly waterLevel: number | null;
  readonly chunks: readonly MapChunk[];
}

export interface MapDocument {
  readonly version: number;
  /** The seed this map was baked from. Provenance; the layers carry their own. */
  readonly seed: number;
  readonly grid: { readonly cellSize: number; readonly chunkCells: number };
  readonly layers: readonly MapLayer[];
  /** The sim's play rectangle, in world space -- see the note on `arena` above. */
  readonly arena: MapRect;
}

/** Round to the document's quantum, normalising `-0` so serialisation is stable. */
export function quantize(value: number): number {
  const r = Math.round(value * QUANTUM) / QUANTUM;
  return r === 0 ? 0 : r;
}

/**
 * Run-length encode a byte array as flat `value, count` pairs.
 *
 * The per-cell arrays are the repetitive half of a map -- solidity is one long
 * run over any layer without islands, and materials change only at a shoreline,
 * a trail edge or a snow line. Encoded, a 784-cell chunk of open meadow is four
 * numbers instead of 784, and the run boundaries are exactly the terrain
 * features a reader is looking for.
 */
export function encodeRuns(values: ArrayLike<number>): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < values.length) {
    const value = values[i] ?? 0;
    let count = 1;
    while (i + count < values.length && values[i + count] === value) count++;
    out.push(value, count);
    i += count;
  }
  return out;
}

/** Inverse of `encodeRuns`. Throws if the runs do not add up to `length`. */
export function decodeRuns(runs: readonly number[], length: number): Uint8Array {
  if (runs.length % 2 !== 0) throw new Error(`run-length data must be value/count pairs, got ${runs.length} entries`);
  const out = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const value = runs[i] ?? 0;
    const count = runs[i + 1] ?? 0;
    if (count < 0 || at + count > length) throw new Error(`run-length data overflows ${length} cells`);
    out.fill(value, at, at + count);
    at += count;
  }
  if (at !== length) throw new Error(`run-length data covers ${at} of ${length} cells`);
  return out;
}

/** Cells spanning a layer's bounds on each axis, matching `chunk.ts`'s grid. */
export function layerCellCounts(bounds: MapRect, cellSize: number): { totalCols: number; totalRows: number } {
  return {
    totalCols: Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellSize)),
    totalRows: Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cellSize)),
  };
}

export interface ExportMapInput {
  readonly world: TerrainWorld;
  /** Every prop standing in the world, in world space. */
  readonly props: readonly Prop[];
  /** The seed the world was generated from. */
  readonly seed: number;
  /** The sim's play rectangle. */
  readonly arena: MapRect;
  readonly options?: ChunkOptions;
  /** Markers to place, in world space; they are made chunk-local here. */
  readonly markers?: readonly (MapMarker & { readonly layerId?: string })[];
}

/** A prop or marker, reduced to what placement needs. */
interface Placeable {
  readonly x: number;
  readonly z: number;
}

/**
 * Which chunk of a layer owns a world point: the chunk containing it, clamped to
 * the layer's grid so a point just past the bounds still lands somewhere rather
 * than being dropped.
 */
function owningChunk(
  point: Placeable,
  bounds: MapRect,
  opt: ChunkOptions,
): { cx: number; cz: number } {
  const { totalCols, totalRows } = layerCellCounts(bounds, opt.cellSize);
  const chunksX = Math.ceil(totalCols / opt.chunkCells);
  const chunksZ = Math.ceil(totalRows / opt.chunkCells);
  const col = Math.floor((point.x - bounds.minX) / opt.cellSize);
  const row = Math.floor((point.z - bounds.minZ) / opt.cellSize);
  return {
    cx: Math.min(chunksX - 1, Math.max(0, Math.floor(col / opt.chunkCells))),
    cz: Math.min(chunksZ - 1, Math.max(0, Math.floor(row / opt.chunkCells))),
  };
}

const chunkKey = (cx: number, cz: number): string => `${cx},${cz}`;

/**
 * Bake a live world and its props into a document.
 *
 * Every layer is sampled into chunks exactly as the mesher would, then the parts
 * that cannot be recomputed are written down. Props are bucketed into the chunk
 * that contains them and rewritten into that chunk's local space; a prop is
 * assigned to the first layer whose bounds hold it, so with one ground layer --
 * the world as it stands -- every prop lands on it.
 *
 * Pure and deterministic: the same `(world, props, seed)` always bakes the same
 * document, which is what lets a test compare two exports byte for byte.
 */
export function exportMap(input: ExportMapInput): MapDocument {
  const opt = input.options ?? DEFAULT_CHUNK_OPTIONS;
  const layers: MapLayer[] = [];

  /** Bucket points into `${cx},${cz}` for the layer that owns them. */
  const bucket = <T extends Placeable>(
    items: readonly T[],
    layerIndex: number,
    bounds: MapRect,
  ): Map<string, T[]> => {
    const byChunk = new Map<string, T[]>();
    for (const item of items) {
      if (ownerLayer(item) !== layerIndex) continue;
      const { cx, cz } = owningChunk(item, bounds, opt);
      const key = chunkKey(cx, cz);
      const at = byChunk.get(key);
      if (at) at.push(item);
      else byChunk.set(key, [item]);
    }
    return byChunk;
  };

  /** First layer whose bounds contain the point, else the first layer. */
  const ownerLayer = (point: Placeable): number => {
    const found = input.world.layers.findIndex((layer) => rectContains(layer.bounds, point.x, point.z));
    return found < 0 ? 0 : found;
  };

  input.world.layers.forEach((layer, layerIndex) => {
    // `Prop` names its ground-plane axes x/y; the document calls the second one
    // z, since in the scene it is depth. Same number, honest name.
    const props = input.props.map((p) => ({ x: p.x, z: p.y, prop: p }));
    const propsByChunk = bucket(props, layerIndex, layer.bounds);
    const markersByChunk = bucket(input.markers ?? [], layerIndex, layer.bounds);

    const chunks = sampleLayer(layer, opt).map((chunk): MapChunk => {
      const key = chunkKey(chunk.coord.cx, chunk.coord.cz);
      return {
        cx: chunk.coord.cx,
        cz: chunk.coord.cz,
        cols: chunk.cols,
        rows: chunk.rows,
        heights: Array.from(chunk.heights, quantize),
        solid: encodeRuns(chunk.solid),
        materials: encodeRuns(chunk.materials),
        tones: encodeRuns(chunk.tones),
        props: (propsByChunk.get(key) ?? []).map(({ prop }) => ({
          species: prop.kind as string,
          x: quantize(prop.x - chunk.originX),
          z: quantize(prop.y - chunk.originZ),
          rotation: quantize(prop.rotation),
          scale: quantize(prop.scale),
          tint: quantize(prop.tint),
          // Omitted when upright, so the generated forest's JSON is unchanged.
          ...(prop.alignToNormal ? { align: true } : {}),
        })),
        markers: (markersByChunk.get(key) ?? []).map((m) => ({
          kind: m.kind,
          id: m.id,
          x: quantize(m.x - chunk.originX),
          z: quantize(m.z - chunk.originZ),
          ...(m.label === undefined ? {} : { label: m.label }),
        })),
        nav: null,
      };
    });

    layers.push({
      id: layer.id,
      seed: layer.seed,
      bounds: {
        minX: quantize(layer.bounds.minX),
        minZ: quantize(layer.bounds.minZ),
        maxX: quantize(layer.bounds.maxX),
        maxZ: quantize(layer.bounds.maxZ),
      },
      baseY: quantize(layer.baseY),
      waterLevel: layer.waterLevel === null ? null : quantize(layer.waterLevel),
      chunks,
    });
  });

  return {
    version: MAP_VERSION,
    seed: input.seed,
    grid: { cellSize: opt.cellSize, chunkCells: opt.chunkCells },
    layers,
    arena: {
      minX: quantize(input.arena.minX),
      minZ: quantize(input.arena.minZ),
      maxX: quantize(input.arena.maxX),
      maxZ: quantize(input.arena.maxZ),
    },
  };
}

/** Bake the chunks of one layer straight out of a live world, for a rebuild. */
export function sampleLayerChunks(
  world: TerrainWorld,
  layerId: string,
  opt: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): TerrainChunk[] {
  const layer = world.layers.find((l) => l.id === layerId);
  return layer ? sampleLayer(layer, opt) : [];
}

// --- Serialisation -------------------------------------------------------
//
// Hand-rolled rather than `JSON.stringify(doc, null, 2)`, for one reason: the
// default pretty-printer puts every number of a 841-corner height array on its
// own line, and the compact form puts all of them on one. Neither is readable.
// Here a height array is emitted one terrain *row* per line, so the document
// shows the shape of the ground and a hillside edit is a few changed lines.

const INDENT = '  ';

function writeScalar(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

/** A number array on a single line: `[1, 2, 3]`. */
function writeInline(values: readonly number[]): string {
  return `[${values.join(', ')}]`;
}

/** A number array wrapped every `perLine` values, each line indented. */
function writeWrapped(values: readonly number[], perLine: number, indent: string): string {
  if (values.length === 0) return '[]';
  const lines: string[] = [];
  for (let i = 0; i < values.length; i += perLine) {
    lines.push(indent + INDENT + values.slice(i, i + perLine).join(', '));
  }
  return `[\n${lines.join(',\n')}\n${indent}]`;
}

function writeObject(entries: readonly (readonly [string, string])[], indent: string): string {
  if (entries.length === 0) return '{}';
  const body = entries.map(([k, v]) => `${indent + INDENT}${JSON.stringify(k)}: ${v}`).join(',\n');
  return `{\n${body}\n${indent}}`;
}

function writeRect(rect: MapRect): string {
  return `{ "minX": ${rect.minX}, "minZ": ${rect.minZ}, "maxX": ${rect.maxX}, "maxZ": ${rect.maxZ} }`;
}

function writeProp(prop: MapProp): string {
  return (
    `{ "species": ${writeScalar(prop.species)}, "x": ${prop.x}, "z": ${prop.z}, ` +
    `"rotation": ${prop.rotation}, "scale": ${prop.scale}, "tint": ${prop.tint}` +
    `${prop.align ? ', "align": true' : ''} }`
  );
}

function writeMarker(marker: MapMarker): string {
  const label = marker.label === undefined ? '' : `, "label": ${writeScalar(marker.label)}`;
  return `{ "kind": ${writeScalar(marker.kind)}, "id": ${writeScalar(marker.id)}, "x": ${marker.x}, "z": ${marker.z}${label} }`;
}

function writeList(items: readonly string[], indent: string): string {
  if (items.length === 0) return '[]';
  return `[\n${items.map((s) => indent + INDENT + s).join(',\n')}\n${indent}]`;
}

function writeChunk(chunk: MapChunk, indent: string): string {
  const inner = indent + INDENT;
  return writeObject(
    [
      ['cx', String(chunk.cx)],
      ['cz', String(chunk.cz)],
      ['cols', String(chunk.cols)],
      ['rows', String(chunk.rows)],
      // One corner row per line: the array reads as the grid it is.
      ['heights', writeWrapped(chunk.heights, chunk.cols + 1, inner)],
      ['solid', writeInline(chunk.solid)],
      ['materials', writeInline(chunk.materials)],
      ['tones', writeInline(chunk.tones)],
      ['props', writeList(chunk.props.map(writeProp), inner)],
      ['markers', writeList(chunk.markers.map(writeMarker), inner)],
      ['nav', chunk.nav === null ? 'null' : writeInline(chunk.nav)],
    ],
    indent,
  );
}

function writeLayer(layer: MapLayer, indent: string): string {
  const inner = indent + INDENT;
  return writeObject(
    [
      ['id', writeScalar(layer.id)],
      ['seed', String(layer.seed)],
      ['bounds', writeRect(layer.bounds)],
      ['baseY', String(layer.baseY)],
      ['waterLevel', layer.waterLevel === null ? 'null' : String(layer.waterLevel)],
      ['chunks', writeList(layer.chunks.map((c) => writeChunk(c, inner + INDENT)), inner)],
    ],
    indent,
  );
}

/**
 * The document as text: stable key order, stable spacing, no dependence on
 * anything ambient. The same document always serialises to the same bytes, which
 * is the property the round-trip test rests on.
 */
export function serializeMap(doc: MapDocument): string {
  return (
    writeObject(
      [
        ['version', String(doc.version)],
        ['seed', String(doc.seed)],
        ['grid', `{ "cellSize": ${doc.grid.cellSize}, "chunkCells": ${doc.grid.chunkCells} }`],
        ['arena', writeRect(doc.arena)],
        ['layers', writeList(doc.layers.map((l) => writeLayer(l, INDENT + INDENT)), INDENT)],
      ],
      '',
    ) + '\n'
  );
}

// --- Parsing -------------------------------------------------------------

function fail(message: string): never {
  throw new Error(`invalid map: ${message}`);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${what} must be a finite number`);
  return value;
}

function asNumbers(value: unknown, what: string): number[] {
  if (!Array.isArray(value)) fail(`${what} must be an array of numbers`);
  return (value as unknown[]).map((v, i) => asNumber(v, `${what}[${i}]`));
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(`${what} must be a string`);
  return value;
}

function asRect(value: unknown, what: string): MapRect {
  const r = asRecord(value, what);
  return {
    minX: asNumber(r['minX'], `${what}.minX`),
    minZ: asNumber(r['minZ'], `${what}.minZ`),
    maxX: asNumber(r['maxX'], `${what}.maxX`),
    maxZ: asNumber(r['maxZ'], `${what}.maxZ`),
  };
}

const MARKER_KINDS: readonly MapMarkerKind[] = ['spawn', 'objective', 'campfire', 'trigger'];

function parseMarker(value: unknown, what: string): MapMarker {
  const r = asRecord(value, what);
  const kind = asString(r['kind'], `${what}.kind`);
  if (!MARKER_KINDS.includes(kind as MapMarkerKind)) fail(`${what}.kind is not a known marker kind: ${kind}`);
  const label = r['label'];
  return {
    kind: kind as MapMarkerKind,
    id: asString(r['id'], `${what}.id`),
    x: asNumber(r['x'], `${what}.x`),
    z: asNumber(r['z'], `${what}.z`),
    ...(label === undefined ? {} : { label: asString(label, `${what}.label`) }),
  };
}

function parseProp(value: unknown, what: string): MapProp {
  const r = asRecord(value, what);
  const align = r['align'];
  if (align !== undefined && typeof align !== 'boolean') fail(`${what}.align must be a boolean`);
  return {
    species: asString(r['species'], `${what}.species`),
    x: asNumber(r['x'], `${what}.x`),
    z: asNumber(r['z'], `${what}.z`),
    rotation: asNumber(r['rotation'], `${what}.rotation`),
    scale: asNumber(r['scale'], `${what}.scale`),
    tint: asNumber(r['tint'], `${what}.tint`),
    ...(align === true ? { align: true } : {}),
  };
}

function parseChunk(value: unknown, what: string): MapChunk {
  const r = asRecord(value, what);
  const cols = asNumber(r['cols'], `${what}.cols`);
  const rows = asNumber(r['rows'], `${what}.rows`);
  const heights = asNumbers(r['heights'], `${what}.heights`);
  const corners = (cols + 1) * (rows + 1);
  if (heights.length !== corners) {
    fail(`${what}.heights has ${heights.length} entries, expected ${corners} for ${cols}x${rows}`);
  }
  const cells = cols * rows;
  const nav = r['nav'];
  const chunk: MapChunk = {
    cx: asNumber(r['cx'], `${what}.cx`),
    cz: asNumber(r['cz'], `${what}.cz`),
    cols,
    rows,
    heights,
    solid: asNumbers(r['solid'], `${what}.solid`),
    materials: asNumbers(r['materials'], `${what}.materials`),
    tones: asNumbers(r['tones'], `${what}.tones`),
    props: (Array.isArray(r['props']) ? r['props'] : fail(`${what}.props must be an array`)).map((p, i) =>
      parseProp(p, `${what}.props[${i}]`),
    ),
    markers: (Array.isArray(r['markers']) ? r['markers'] : fail(`${what}.markers must be an array`)).map((m, i) =>
      parseMarker(m, `${what}.markers[${i}]`),
    ),
    nav: nav === null || nav === undefined ? null : asNumbers(nav, `${what}.nav`),
  };
  // Decoding is the length check: a run list that does not cover exactly the
  // cell count throws here rather than producing a silently short chunk.
  decodeRuns(chunk.solid, cells);
  decodeRuns(chunk.materials, cells);
  decodeRuns(chunk.tones, cells);
  if (chunk.nav !== null && chunk.nav.length !== cells) {
    fail(`${what}.nav has ${chunk.nav.length} entries, expected ${cells}`);
  }
  return chunk;
}

function parseLayer(value: unknown, what: string): MapLayer {
  const r = asRecord(value, what);
  const waterLevel = r['waterLevel'];
  return {
    id: asString(r['id'], `${what}.id`),
    seed: asNumber(r['seed'], `${what}.seed`),
    bounds: asRect(r['bounds'], `${what}.bounds`),
    baseY: asNumber(r['baseY'], `${what}.baseY`),
    waterLevel: waterLevel === null || waterLevel === undefined ? null : asNumber(waterLevel, `${what}.waterLevel`),
    chunks: (Array.isArray(r['chunks']) ? r['chunks'] : fail(`${what}.chunks must be an array`)).map((c, i) =>
      parseChunk(c, `${what}.chunks[${i}]`),
    ),
  };
}

/**
 * Read a document back, validating as it goes. Everything a later stage would
 * have to trust -- the version, the array lengths against the declared chunk
 * size, the marker kinds -- is checked here, so a malformed file fails at the
 * file boundary with a path to the bad field rather than as a wrong-looking
 * render three steps later.
 */
export function parseMap(text: string): MapDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    fail(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const r = asRecord(raw, 'document');
  const version = asNumber(r['version'], 'document.version');
  if (version !== MAP_VERSION) fail(`unsupported version ${version}, expected ${MAP_VERSION}`);
  const grid = asRecord(r['grid'], 'document.grid');
  return {
    version,
    seed: asNumber(r['seed'], 'document.seed'),
    grid: {
      cellSize: asNumber(grid['cellSize'], 'document.grid.cellSize'),
      chunkCells: asNumber(grid['chunkCells'], 'document.grid.chunkCells'),
    },
    arena: asRect(r['arena'], 'document.arena'),
    layers: (Array.isArray(r['layers']) ? r['layers'] : fail('document.layers must be an array')).map((l, i) =>
      parseLayer(l, `document.layers[${i}]`),
    ),
  };
}

/** The prop kinds the renderer knows how to build, for validating a species id. */
const KNOWN_PROP_KINDS: readonly string[] = ['tree', 'bush', 'fence-wood', 'fence-stone'];

/** True when a species id maps onto a `PropKind` the prop field can draw. */
export function isKnownPropKind(species: string): species is PropKind {
  return KNOWN_PROP_KINDS.includes(species);
}

/** Material name for a stored index, falling back to grass on an unknown one. */
export function materialName(index: number): (typeof TERRAIN_MATERIALS)[number] {
  return TERRAIN_MATERIALS[index] ?? 'grass';
}

export type { Rect };
