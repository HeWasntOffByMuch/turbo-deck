/**
 * Does the body actually stay where the server put it? (spec 118)
 *
 *   npx tsx scripts/probe-travel.ts [unitDir]
 *
 * Everything about the travel rule is checked in Node already -- the
 * measurement, the correction, and both of them over the committed clips. All
 * of it can be green while the game still slides, because the half that is left
 * is three's `GLTFLoader` deciding what a track is called, `UnitRig` finding a
 * bone by that name, and an `AnimationMixer` writing the result onto a
 * skeleton. That chain is exactly where the last root-motion bug lived: the
 * strip ran against a name from a document, matched nothing, and reported a
 * clean import.
 *
 * So this loads the real unit through the real `UnitRig` and asks the only
 * question that matters -- where are the hips, over a cycle, in world units.
 * A clip that travels shows up as drift; one whose correction was too greedy
 * shows up as an excursion of zero, which is a body whose hips do not move at
 * all. Both are failures and they are failures in opposite directions.
 *
 * It runs in Node with no GL context, because nothing here rasterises. Three's
 * loader wants a handful of browser globals to fetch and decode a texture, and
 * they are shimmed below rather than pretended away -- the shims are all in one
 * place so it is obvious how little of a browser this is.
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What three's `FileLoader` and texture path reach for and Node does not have.
 *
 * Set before three is imported, because the module reads some of them at load.
 * None of it renders: the image is never sampled, only awaited.
 */
const globals = globalThis as unknown as Record<string, unknown>;
globals['ProgressEvent'] ??= class {
  constructor(
    public type: string,
    public init?: unknown,
  ) {}
};
globals['self'] ??= globalThis;
globals['createImageBitmap'] ??= async () => ({ width: 1, height: 1, close: () => undefined });

const THREE = await import('three');
const { UnitRig } = await import('../src/render/iso3d/unit-rig.js');

const PORT = 4399;
const DEFAULT_DIR = 'assets/units/pig_a_pose_full';

/** How far the hips may end from where they started, as a fraction of height. */
const MAX_DRIFT = 0.01;
/** And how still they may be before the correction has clearly eaten the pose. */
const MIN_EXCURSION = 0.002;

interface Reading {
  readonly clip: string;
  /** Distance from the first sampled pose to the last, in world units. */
  readonly drift: number;
  /** The furthest the hips get from where they started, in world units. */
  readonly excursion: number;
  readonly mean: { readonly x: number; readonly y: number; readonly z: number };
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? DEFAULT_DIR;
  const unitPath = findUnitDef(dir);
  const unitDoc = JSON.parse(readFileSync(unitPath, 'utf8')) as {
    meshRef: string;
    clipLibRef: string;
    import: { scale: number };
  };
  const clipDoc = JSON.parse(readFileSync(join(dir, unitDoc.clipLibRef), 'utf8')) as {
    clips: readonly { id: string; source: string; loop: boolean }[];
  };

  // Three fetches over HTTP and does not read `file:`, so the repo is served.
  const server = createServer((request, response) => {
    try {
      response.end(readFileSync(join('.', decodeURIComponent((request.url ?? '').slice(1)))));
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  const base = `http://localhost:${PORT}/${dir}/`;

  const failures: string[] = [];
  try {
    const rig = new UnitRig();
    await rig.load(
      {
        meshUrl: base + unitDoc.meshRef,
        clipUrls: Object.fromEntries(clipDoc.clips.map((clip) => [clip.id, base + clip.source])),
        importScale: unitDoc.import.scale,
      },
      dir.split('/').pop() ?? 'unit',
    );
    if (!rig.loaded) throw new Error(`the unit did not load: ${rig.error ?? 'no reason given'}`);

    const height = rig.drawnHeight();
    console.log(`  ${rig.stats().bones} bones, root "${rig.rootBoneName}", drawn ${height.toFixed(1)} units tall`);
    for (const message of rig.rootMotion) console.log(`  corrected: ${message.split('. ')[0]}.`);

    // The hips: the bone a rig carries its body on, and the one every generated
    // rig so far has had the travel baked onto.
    const hips = findHips(rig.object);
    if (!hips) throw new Error('no bone below the root to measure -- is this a skinned rig?');

    for (const clip of clipDoc.clips) {
      const reading = measure(rig, hips, clip.id);
      const drift = reading.drift / height;
      const excursion = reading.excursion / height;
      // Drift is only a slide on a clip that loops, where every cycle hands the
      // body on a step further along. A one-shot ending somewhere else is a
      // pose -- a recoil, a body on the ground -- and the machine blends out of
      // it. So the one-shots are measured and printed, and not judged.
      const travels = clip.loop && drift > MAX_DRIFT;
      const verdict = travels ? 'TRAVELS' : excursion < MIN_EXCURSION ? 'FROZEN' : clip.loop ? 'in place' : 'one-shot';
      console.log(
        `  ${clip.id.padEnd(12)} drift ${reading.drift.toFixed(2).padStart(7)}  ` +
          `excursion ${reading.excursion.toFixed(2).padStart(7)}  ` +
          `mean (${reading.mean.x.toFixed(1)}, ${reading.mean.y.toFixed(1)}, ${reading.mean.z.toFixed(1)})  ${verdict}`,
      );
      if (travels) {
        failures.push(
          `${clip.id}: it loops, and the hips end ${reading.drift.toFixed(2)} units from where they started`,
        );
      }
      if (excursion < MIN_EXCURSION) {
        failures.push(`${clip.id}: the hips never move -- the correction took the pose with the travel`);
      }
    }
  } finally {
    server.close();
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('every clip plays in place, and none of them plays still');
}

function findUnitDef(dir: string): string {
  const named = `${dir.split('/').pop()}.unitdef.json`;
  const path = join(dir, named);
  if (!existsSync(path)) throw new Error(`no ${named} in ${dir}`);
  return path;
}

/** The topmost bone the clips actually pose: the root's first child bone. */
function findHips(object: InstanceType<typeof THREE.Object3D>): InstanceType<typeof THREE.Bone> | null {
  let deepestRoot: InstanceType<typeof THREE.Bone> | null = null;
  object.traverse((node) => {
    if (deepestRoot === null && node instanceof THREE.Bone) deepestRoot = node;
  });
  const root = deepestRoot as InstanceType<typeof THREE.Bone> | null;
  const child = root?.children.find((node) => node instanceof THREE.Bone);
  return (child as InstanceType<typeof THREE.Bone> | undefined) ?? root;
}

/** Where a bone goes over one pass of a clip, sampled evenly. */
function measure(
  rig: InstanceType<typeof UnitRig>,
  bone: InstanceType<typeof THREE.Bone>,
  clipId: string,
  samples = 60,
): Reading {
  const positions: InstanceType<typeof THREE.Vector3>[] = [];
  for (let i = 0; i <= samples; i += 1) {
    rig.applyPoses([{ clipId, normalizedTime: i / samples, weight: 1 }]);
    rig.object.updateMatrixWorld(true);
    positions.push(bone.getWorldPosition(new THREE.Vector3()));
  }
  const first = positions[0] ?? new THREE.Vector3();
  const last = positions[positions.length - 1] ?? first;
  const mean = positions
    .reduce((total, at) => total.add(at), new THREE.Vector3())
    .multiplyScalar(1 / positions.length);
  return {
    clip: clipId,
    drift: first.distanceTo(last),
    excursion: Math.max(...positions.map((at) => at.distanceTo(first))),
    mean: { x: mean.x, y: mean.y, z: mean.z },
  };
}

await main();
