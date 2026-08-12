/**
 * How hard does this body swing when it pivots? (spec 139)
 *
 *   npx tsx scripts/probe-turn-swing.ts [unitDir]
 *
 * The turn rate is a number in `CHARACTERS` and the lever arm it acts on is a
 * property of a pose in a `.glb`, and nothing in the repo could see both at once.
 * That is how a rate tuned for the cow rig survived onto a body whose run pose
 * reaches twice as far: every number involved was individually defensible, and
 * the product of them -- extremities travelling at 2.4x the speed the animal can
 * run -- was written down nowhere.
 *
 * So this measures the product. It loads the real unit through the real
 * `UnitRig`, applies each clip's poses the way the game does, and skins the mesh
 * on the CPU at each of them to ask where the body's furthest vertex actually is.
 * The arithmetic on top is `src/render/iso3d/turn-swing.ts`, which is tested in
 * CI; what only exists here is the mesh.
 *
 * Skinned deliberately, rather than reading bones or a bounding box. A snout is
 * geometry and no bone sits in it, and `Box3.setFromObject` on a `SkinnedMesh`
 * reads the bind-space geometry box through the node matrix, which for this pig
 * reports a body 17.9 units tall when it is really 55.6.
 *
 * Runs in Node with no GL context: nothing here rasterises. Three's loader wants
 * a handful of browser globals to fetch and decode a texture, and they are
 * shimmed below rather than pretended away -- the same shims, for the same
 * reason, as `probe-travel.ts` beside it.
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What three's `FileLoader` and texture path reach for and Node does not have.
 * Set before three is imported, because the module reads some of them at load.
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
const { CHARACTERS } = await import('../src/sim/characters.js');
const { TURN_RATE_PER_AGILITY } = await import('../src/sim/constants.js');
const { MAX_SWEEP_RATIO, REVERSAL_DEGREES, sweepOf, turnSeconds, widestSweep } = await import(
  '../src/render/iso3d/turn-swing.js'
);

const PORT = 4401;
const DEFAULT_DIR = 'assets/units/pig_a_pose_full';

/**
 * How many phases of each clip to pose the body at.
 *
 * The reach is a maximum over the cycle, so this is a sampling density and not a
 * cosmetic number: too few and a gallop's fully extended frame falls between two
 * samples. Twenty-four is a frame every 1.5 degrees of phase on the shortest clip
 * here, and the reach it finds stops moving well before that.
 */
const PHASES = 24;

/**
 * The dexterity a fresh character has (`player-manager.ts`), so the rate this
 * reports is the rate somebody is actually playing at rather than the base.
 * Reading the base and calling it the answer is the mistake spec 139 exists to
 * correct, so this file does the derivation `computeEffectiveStats` does.
 */
const FRESH_DEXTERITY = 5;

interface Pose {
  readonly clipId: string;
  readonly reach: number;
  readonly centre: { readonly x: number; readonly z: number };
  readonly height: number;
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
    clips: readonly { id: string; source: string }[];
  };

  const character = CHARACTERS[0];
  if (!character) throw new Error('no character archetypes to measure against');
  const turnRate = character.turnRate + TURN_RATE_PER_AGILITY * FRESH_DEXTERITY;
  const moveSpeed = character.moveSpeed;

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

    const skins = skinsOf(rig.object);
    if (skins.length === 0) throw new Error('nothing skinned to measure -- is this a rigged unit?');

    console.log(
      `  ${character.name}: ${moveSpeed} units/s, turning at ${turnRate} deg/s ` +
        `(${character.turnRate} base + ${TURN_RATE_PER_AGILITY} x ${FRESH_DEXTERITY} dexterity), ` +
        `so a ${REVERSAL_DEGREES}-degree reversal takes ` +
        `${(turnSeconds(REVERSAL_DEGREES, turnRate) * 1000).toFixed(0)}ms`,
    );
    console.log(`  budget: an extremity may not exceed ${MAX_SWEEP_RATIO}x the body's own speed\n`);

    // The bind pose first, before a clip has touched the skeleton: it is the
    // control, and a mesh that is off-centre *there* is a different fault with a
    // different fix -- one for the export, not for the turn rate.
    const bind = measure(rig, skins, null);
    console.log(
      `  ${'(bind)'.padEnd(12)} reach ${bind.reach.toFixed(1).padStart(5)}  ` +
        `centre (${bind.centre.x.toFixed(1).padStart(5)},${bind.centre.z.toFixed(1).padStart(5)})  ` +
        `height ${bind.height.toFixed(1).padStart(5)}`,
    );

    const sweeps = clipDoc.clips.map((clip) => {
      const pose = measure(rig, skins, clip.id);
      const sweep = sweepOf(pose, turnRate, moveSpeed);
      console.log(
        `  ${clip.id.padEnd(12)} reach ${pose.reach.toFixed(1).padStart(5)}  ` +
          `centre (${pose.centre.x.toFixed(1).padStart(5)},${pose.centre.z.toFixed(1).padStart(5)})  ` +
          `height ${pose.height.toFixed(1).padStart(5)}  ` +
          `sweeps ${sweep.speed.toFixed(0).padStart(4)} units/s = ` +
          `${sweep.ratio.toFixed(2)}x speed  ` +
          `reversal moves it ${sweep.reversal.toFixed(0).padStart(3)} units  ` +
          `${sweep.withinBudget ? 'ok' : 'TOO WIDE'}`,
      );
      if (!sweep.withinBudget) {
        failures.push(
          `${clip.id}: its furthest point travels ${sweep.speed.toFixed(0)} units/s while turning, ` +
            `${sweep.ratio.toFixed(2)}x the ${moveSpeed} this body can run -- ` +
            `either the pose reaches too far (${pose.reach.toFixed(1)} units, and its centre sits ` +
            `${sweep.offset.toFixed(1)} off the pivot) or ${turnRate} deg/s is too fast for it`,
        );
      }
      return sweep;
    });

    const worst = widestSweep(sweeps);
    if (worst) {
      console.log(
        `\n  widest: ${worst.clipId}, at ${worst.ratio.toFixed(2)}x -- ` +
          `${(MAX_SWEEP_RATIO - worst.ratio).toFixed(2)} of headroom, and its pivot sits ` +
          `${worst.offset.toFixed(1)} units off the body's own centre`,
      );
    }
  } finally {
    server.close();
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('every pose keeps its extremities under the budget when the body pivots');
}

function findUnitDef(dir: string): string {
  const named = `${dir.split('/').pop()}.unitdef.json`;
  const path = join(dir, named);
  if (!existsSync(path)) throw new Error(`no ${named} in ${dir}`);
  return path;
}

function skinsOf(object: InstanceType<typeof THREE.Object3D>): InstanceType<typeof THREE.SkinnedMesh>[] {
  const skins: InstanceType<typeof THREE.SkinnedMesh>[] = [];
  object.traverse((node) => {
    if ((node as { isSkinnedMesh?: boolean }).isSkinnedMesh) {
      skins.push(node as InstanceType<typeof THREE.SkinnedMesh>);
    }
  });
  return skins;
}

/**
 * The widest the body gets over one pass of a clip, in world units about the
 * pivot -- or in the bind pose, when `clipId` is null.
 *
 * Every vertex through `applyBoneTransform` and then into world space, which is
 * the same linear blend the GPU does. The reach is a maximum over the cycle
 * because that is what a turn will catch; the centre and the height are averaged
 * over it, because a body's stride bobs and its limbs cross, and one frame of
 * that is not what the pose *is*.
 */
function measure(
  rig: InstanceType<typeof UnitRig>,
  skins: readonly InstanceType<typeof THREE.SkinnedMesh>[],
  clipId: string | null,
): Pose {
  const vertex = new THREE.Vector3();
  let reach = 0;
  let centreX = 0;
  let centreZ = 0;
  let height = 0;
  const phases = clipId === null ? 1 : PHASES;

  for (let phase = 0; phase < phases; phase += 1) {
    if (clipId !== null) rig.applyPoses([{ clipId, normalizedTime: phase / phases, weight: 1 }]);
    rig.object.updateMatrixWorld(true);

    const box = new THREE.Box3();
    for (const skin of skins) {
      const position = skin.geometry.getAttribute('position');
      for (let index = 0; index < position.count; index += 1) {
        vertex.fromBufferAttribute(position, index);
        skin.applyBoneTransform(index, vertex);
        skin.localToWorld(vertex);
        box.expandByPoint(vertex);
        reach = Math.max(reach, Math.hypot(vertex.x, vertex.z));
      }
    }
    centreX += (box.min.x + box.max.x) / 2;
    centreZ += (box.min.z + box.max.z) / 2;
    height += box.max.y - box.min.y;
  }

  return {
    clipId: clipId ?? '(bind)',
    reach,
    centre: { x: centreX / phases, z: centreZ / phases },
    height: height / phases,
  };
}

await main();
