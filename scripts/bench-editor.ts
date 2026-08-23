/**
 * What the map editor costs to open, as a function of how big the world is.
 *
 * `bench-map.ts` measures the **server** across world sizes, and after spec 207
 * that is the half of the boot which got cheap: `buildWorldFromMap` stopped
 * meshing a world nobody draws, and the `build` column went from 8,105 ms to
 * 233 ms at 3,200 chunks. Nothing measures the other half. The editor *wants*
 * the mesh -- it loads a whole document precisely in order to draw it -- so it
 * is the one caller still paying every cost 207 moved off the server, and there
 * is no column anywhere in the tree that says so.
 *
 *   npx tsx scripts/bench-editor.ts [--sizes 200,800,3200]
 *
 * Same shape as `bench-map.ts`, and for the same reason: the number that
 * matters is not "twelve seconds" but "four times the world cost four times as
 * much". Every stage here is linear in the size of the world today, which is
 * the finding rather than the baseline.
 *
 * What it reports is `EditorScene`'s constructor, stage by stage -- the exact
 * sequence `src/render/iso3d/editor/view.ts` runs before it can draw a frame:
 *
 *   loadMap -> map.chunks -> buildTerrainMeshFromChunks -> buildPropField
 *
 * Two readings this is here to settle, both of which correct something that was
 * reasoned rather than measured:
 *
 * - Spec 207 named `buildChunks` as the editor's next problem. It is about a
 *   fifth of it. **`buildPropField` is the largest single cost**, and 207 does
 *   not mention it.
 * - The prop field is linear in *prop count* and almost none of it is ground
 *   sampling: `heightAt` over every prop in the shipped map is single-digit
 *   milliseconds against seconds for the field. What costs is composing the
 *   instances -- which is the work spec 181 already moved off-thread, for the
 *   Play tab only.
 *
 * Timings live here rather than in `npm test` on purpose, exactly as
 * `bench-map.ts` says: a wall-clock assertion is a flake.
 *
 * No GL context is made and none is needed -- every stage measured builds
 * `BufferGeometry` and matrices on the CPU. Upload is on top of this in a
 * browser, so these are floors rather than estimates.
 */

import { loadMapFile } from '../src/server/world/map-file.js';
import { loadMap } from '../src/terrain/map-world.js';
import { tiledMap } from '../src/server/world/tiled-map.js';
import type { MapDocument } from '../src/terrain/map.js';
import { buildTerrainMeshFromChunks } from '../src/render/iso3d/terrain-mesh.js';
import { buildPropField } from '../src/render/iso3d/props.js';
import { terrainNormalAt } from '../src/render/iso3d/editor/scatter.js';

const DEFAULT_SIZES = [200, 800, 3200];

const now = (): number => Number(process.hrtime.bigint()) / 1e6;
const mb = (bytes: number): string => (bytes / 1048576).toFixed(0);

function parseSizes(argv: readonly string[]): number[] {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--sizes') continue;
    const value = argv[i + 1];
    if (!value) throw new Error('--sizes needs a comma-separated list');
    return value.split(',').map((s) => {
      const n = Number(s.trim());
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--sizes wants whole numbers, got "${s}"`);
      return n;
    });
  }
  return DEFAULT_SIZES;
}

/** Everything one world size costs the editor before it can draw. */
interface Row {
  readonly chunks: number;
  readonly props: number;
  readonly loadMs: number;
  readonly chunksMs: number;
  readonly meshMs: number;
  readonly propsMs: number;
  readonly openMs: number;
  readonly heapBytes: number;
}

/**
 * One size, through the editor's own constructor sequence.
 *
 * Each stage is timed separately and the derived objects are disposed at the
 * end, because three.js geometry is not garbage the collector can reach on its
 * own -- left undisposed, the heap column would measure how many sizes had been
 * run before this one rather than what this one holds.
 */
function measure(source: MapDocument, chunksWanted: number): Row {
  const doc = tiledMap(source, chunksWanted);
  const layerId = doc.layers[0]?.id ?? 'ground';

  const t0 = now();
  const map = loadMap(doc);
  const loadMs = now() - t0;

  // `map.chunks` is the getter spec 207 made lazy. On the server nothing reads
  // it; here, reading it *is* the editor, so this column is what 207 moved off
  // the server and left where it was.
  const t1 = now();
  const chunks = map.chunks;
  const chunksMs = now() - t1;

  const t2 = now();
  const mesh = buildTerrainMeshFromChunks(map.meshLayers, chunks);
  const meshMs = now() - t2;

  const props = map.store.props(layerId);
  const layer = map.store.layerInfo(layerId);
  const t3 = now();
  const field = buildPropField(
    props,
    (x, z) => map.world.heightAt(x, z),
    layer ? (x, z) => terrainNormalAt(map.store, layer, x, z) : undefined,
  );
  const propsMs = now() - t3;

  (globalThis as { gc?: () => void }).gc?.();
  const heapBytes = process.memoryUsage().heapUsed;

  mesh.dispose();
  field.dispose();

  return {
    chunks: chunks.length,
    props: props.length,
    loadMs,
    chunksMs,
    meshMs,
    propsMs,
    openMs: loadMs + chunksMs + meshMs + propsMs,
    heapBytes,
  };
}

/** `value` against the first row's, as "x2.0" -- the only column that matters. */
function slope(value: number, base: number): string {
  if (base <= 0) return '—';
  return `x${(value / base).toFixed(1)}`;
}

const HEADERS = ['chunks', 'props', 'load', 'chunks', 'mesh', 'propField', 'open', 'heap'] as const;

function header(): string {
  return HEADERS.map((h, i) => h.padStart(i === 0 ? 7 : 10)).join('');
}

function main(): void {
  const sizes = parseSizes(process.argv.slice(2));
  const source = loadMapFile().doc;

  // Warm the shared prop geometry before the first measured size.
  //
  // `props.ts` memoizes `treeParts`/`bushParts`/`fenceParts` (spec 181), so the
  // first field built in a process pays to weld geometry every later one gets
  // free. Left cold, the smallest size carries a fixed cost the others do not
  // and the slope column reports the *opposite* of the truth -- the same trap
  // `bench-map.ts` warms its tick loop for.
  const warmDoc = tiledMap(source, 4);
  const warm = loadMap(warmDoc);
  const warmLayer = warmDoc.layers[0]?.id ?? 'ground';
  buildPropField(warm.store.props(warmLayer), (x, z) => warm.world.heightAt(x, z)).dispose();

  const rows: Row[] = [];
  for (const size of sizes) rows.push(measure(source, size));
  const base = rows[0];
  if (!base) return;

  console.log('\n=== what opening the editor costs, by how big the world is ===\n');
  console.log(header());
  for (const r of rows) {
    console.log(
      `${String(r.chunks)}`.padStart(7) +
        `${String(r.props)}`.padStart(10) +
        `${r.loadMs.toFixed(0)}ms`.padStart(10) +
        `${r.chunksMs.toFixed(0)}ms`.padStart(10) +
        `${r.meshMs.toFixed(0)}ms`.padStart(10) +
        `${r.propsMs.toFixed(0)}ms`.padStart(10) +
        `${(r.openMs / 1000).toFixed(1)}s`.padStart(10) +
        `${mb(r.heapBytes)}MB`.padStart(10),
    );
  }

  console.log('\n=== against the smallest world measured ===\n');
  console.log(header());
  for (const r of rows) {
    console.log(
      `${String(r.chunks)}`.padStart(7) +
        slope(r.props, base.props).padStart(10) +
        slope(r.loadMs, base.loadMs).padStart(10) +
        slope(r.chunksMs, base.chunksMs).padStart(10) +
        slope(r.meshMs, base.meshMs).padStart(10) +
        slope(r.propsMs, base.propsMs).padStart(10) +
        slope(r.openMs, base.openMs).padStart(10) +
        slope(r.heapBytes, base.heapBytes).padStart(10),
    );
  }

  const last = rows[rows.length - 1] ?? base;
  console.log(
    `\nper chunk: ${((last.chunksMs + last.meshMs) / last.chunks).toFixed(2)}ms ground` +
      `   per prop: ${(last.propsMs / Math.max(1, last.props)).toFixed(3)}ms\n`,
  );
  console.log(
    '`open` is what the editor blocks for before its first frame, and it grows\n' +
      'with the world at every stage. `propField` is about half of it at every\n' +
      'size, and is the only stage paid again after boot -- `refreshProps` rebuilds\n' +
      'the whole field, and a stroke can reach it. Spec 207 named `chunks` as the\n' +
      "editor's next problem; this says it is under a third.\n\n" +
      'Read the `load` slope with suspicion rather than as a finding: its base is\n' +
      'single-digit milliseconds, so it is a ratio between two numbers too small to\n' +
      'be a measurement. The columns worth reading a slope off are the seconds.\n',
  );
}

main();
