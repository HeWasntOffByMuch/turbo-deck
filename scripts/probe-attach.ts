/**
 * Does a weapon actually land in the hand? (spec 121)
 *
 * Everything either side of this is checkable in Node against something built
 * by hand: the socket table validates, the resolver matches names, the profile
 * arithmetic is arithmetic. What none of that can tell you is whether the real
 * pig, loaded through the real `GLTFLoader`, has a node that `weapon.main`
 * resolves against -- because the answer depends on what three named the bones
 * when it built the scene, and only three knows that.
 *
 * That is the same gap `probe-travel.ts` exists for, and this borrows its
 * harness: real asset, real loader, no GL context, because nothing rasterises.
 *
 * It asserts the two things that would each look like success from outside:
 * that the socket resolves at all, and that what is hung off it comes out the
 * size it was authored rather than multiplied by the rig's ~32x import scale.
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** What three's `FileLoader` and texture path reach for and Node does not have. */
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
const { validateSkeleton } = await import('../src/units/validate.js');
const { readInverseBindMatrices, splitGlb } = await import('../src/units/glb-read.js');
const { weaponKindFor, weaponProfile, weaponExtent } = await import(
  '../src/render/iso3d/world/weapon-shape.js'
);

const PORT = 4401;
const DEFAULT_DIR = 'assets/units/pig_a_pose_full';
/** The starter weapon: what a player is holding before they touch anything. */
const ITEM = process.argv[3] ?? 'sword.worn';

function findUnitDef(dir: string): string {
  const hit = readdirSync(dir).find((name) => name.endsWith('.unitdef.json'));
  if (hit === undefined) throw new Error(`no .unitdef.json in ${dir}`);
  return join(dir, hit);
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? DEFAULT_DIR;
  const unitPath = findUnitDef(dir);
  const unitDoc = JSON.parse(readFileSync(unitPath, 'utf8')) as {
    meshRef: string;
    clipLibRef: string;
    skeletonRef: string;
    import: { scale: number };
  };
  const skeletonPath = join(dir, unitDoc.skeletonRef);
  if (!existsSync(skeletonPath)) throw new Error(`no skeleton at ${skeletonPath}`);
  const skeleton = validateSkeleton(JSON.parse(readFileSync(skeletonPath, 'utf8')) as unknown).value;
  if (!skeleton) throw new Error(`${skeletonPath} does not validate`);

  const sockets = Object.fromEntries(skeleton.sockets.map((socket) => [socket.id, socket.bone]));
  console.log(`${dir}: ${skeleton.sockets.length} socket(s) declared, naming ${skeleton.naming} bones`);
  for (const socket of skeleton.sockets) console.log(`  ${socket.id.padEnd(12)} -> ${socket.bone}`);

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
      { meshUrl: base + unitDoc.meshRef, clipUrls: {}, importScale: unitDoc.import.scale, sockets },
      dir.split('/').pop() ?? 'unit',
    );
    if (!rig.loaded) throw new Error(`the unit did not load: ${rig.error ?? 'no reason given'}`);

    const height = rig.drawnHeight();
    // All three axes, because a body is sized against the one it is drawn
    // along and a quadruped's longest axis is not its height.
    const box = new THREE.Box3().setFromObject(rig.object);
    const span = { x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z };
    console.log(
      `\n  loaded: ${rig.stats().bones} bones, drawn ${height.toFixed(1)} tall ` +
        `(bbox ${span.x.toFixed(1)} x ${span.y.toFixed(1)} x ${span.z.toFixed(1)}, ` +
        `import ${unitDoc.import.scale.toFixed(2)}x)`,
    );
    console.log(`  attachable: ${rig.attachable.join(', ') || '(nothing)'}`);

    // Where the hand actually is on this body. A weapon socket is only as good
    // as the limb it hangs off, and on a quadruped rig the "hand" is a front
    // foot -- which is a fact about the unit, not about the attachment.
    rig.object.updateMatrixWorld(true);
    // Against the body's own base and height, both taken the way the renderer
    // takes them -- a fraction measured against the mesh node's box would be
    // the very number this probe just proved wrong.
    let footY = Number.POSITIVE_INFINITY;
    rig.object.traverse((node: unknown) => {
      if (!(node instanceof THREE.Bone)) return;
      const at = new THREE.Vector3();
      node.getWorldPosition(at);
      footY = Math.min(footY, at.y);
    });
    const probeAt = (id: string): string => {
      const marker = new THREE.Object3D();
      if (!rig.attach(id, marker)) return 'unresolved';
      rig.object.updateMatrixWorld(true);
      const at = new THREE.Vector3();
      marker.getWorldPosition(at);
      rig.attach(id, null);
      const fraction = (at.y - footY) / Math.max(1e-6, height);
      return `${(fraction * 100).toFixed(0)}% up the body`;
    };
    for (const id of ['weapon.main', 'anchor.head']) console.log(`  ${id.padEnd(12)} sits ${probeAt(id)}`);

    // Whether the bones and the drawn mesh are even in the same space.
    //
    // They need not be. Skinning sends a vertex through `boneWorld x
    // inverseBind`, so a rig whose inverse bind matrices carry a scale draws a
    // correct body out of bones that sit somewhere else entirely -- and the
    // skinning is self-consistent, so nothing about the animation looks wrong.
    // It is only hanging something off a bone that finds out, which is why this
    // is measured here and nowhere else.
    const bind = readInverseBindMatrices(splitGlb(new Uint8Array(readFileSync(join(dir, unitDoc.meshRef)))));
    const bindScale = bind.length === 0 ? 1 : Math.hypot(bind[0]?.[0] ?? 1, bind[0]?.[1] ?? 0, bind[0]?.[2] ?? 0);
    console.log(`  inverse bind scale: ${bindScale.toFixed(3)}x`);

    // The body as its *bones* span it, which is what the skinned mesh actually
    // occupies. glTF says a skinned mesh's own node transform is ignored when
    // skinning; `Box3.setFromObject` applies it regardless, so the box can be a
    // different size from the body on screen.
    let boneLow = Number.POSITIVE_INFINITY;
    let boneHigh = Number.NEGATIVE_INFINITY;
    rig.object.traverse((node: unknown) => {
      if (!(node instanceof THREE.Bone)) return;
      const at = new THREE.Vector3();
      node.getWorldPosition(at);
      boneLow = Math.min(boneLow, at.y);
      boneHigh = Math.max(boneHigh, at.y);
    });
    console.log(
      `  bones span ${(boneHigh - boneLow).toFixed(1)} units vs a mesh box of ${height.toFixed(1)} ` +
        `(canonical ${skeleton.canonicalHeight})`,
    );
    if (bindScale < 0.9 || bindScale > 1.1) {
      failures.push(
        `the rig's inverse bind matrices carry a ${bindScale.toFixed(2)}x scale, so the bones are not in the ` +
          `same space as the body they draw. The skinning is self-consistent and looks right; anything hung ` +
          `off a socket lands ${(1 / bindScale).toFixed(2)}x out from where the hand appears to be.`,
      );
    }

    // 1. The socket a weapon needs has to resolve against the loaded rig.
    if (!rig.attachable.includes('weapon.main')) {
      failures.push(
        `weapon.main did not resolve against the loaded rig. The document hangs it off ` +
          `"${sockets['weapon.main'] ?? '(nothing)'}"; three built ${rig.stats().bones} bones with other names.`,
      );
    }

    // 2. What is attached has to come out the size it was authored. A rig
    //    imported at ~32x scales its whole bone chain, and a sword that
    //    inherits that is a quarter-mile long and still "attached".
    const kind = weaponKindFor(ITEM);
    if (kind === null) {
      failures.push(`${ITEM} draws nothing: there is no row for it in weapon-shape.ts`);
    } else {
      const profile = weaponProfile(kind, height);
      const extent = weaponExtent(profile);
      const sword = new THREE.Object3D();
      sword.name = 'probe.weapon';
      const marker = new THREE.Object3D();
      // A point at the weapon's tip, in the weapon's own units.
      marker.position.set(0, extent, 0);
      sword.add(marker);

      const attached = rig.attach('weapon.main', sword);
      if (!attached) {
        failures.push('attach("weapon.main") returned false on a rig that lists it as attachable');
      } else {
        rig.object.updateMatrixWorld(true);
        const tip = new THREE.Vector3();
        marker.getWorldPosition(tip);
        const hand = new THREE.Vector3();
        sword.getWorldPosition(hand);
        const drawn = tip.distanceTo(hand);
        const ratio = drawn / extent;
        console.log(
          `\n  ${ITEM} (${kind}): authored ${extent.toFixed(1)} units, drawn ${drawn.toFixed(1)} ` +
            `(${ratio.toFixed(3)}x), body ${height.toFixed(1)} tall`,
        );
        // A tenth either way is generous; the failure being caught is ~32x.
        if (ratio < 0.9 || ratio > 1.1) {
          failures.push(
            `an attached weapon is drawn ${ratio.toFixed(2)}x its authored size -- the import scale is ` +
              `leaking through the bone chain (rig imports at ${unitDoc.import.scale.toFixed(3)}x)`,
          );
        }
        if (drawn > height) {
          failures.push(`the ${kind} is drawn ${drawn.toFixed(1)} units against a body ${height.toFixed(1)} tall`);
        }
      }

      // 3. Replacing and emptying, on the real rig rather than a fixture.
      const second = new THREE.Object3D();
      rig.attach('weapon.main', second);
      if (sword.parent !== null) failures.push('attaching a second weapon left the first one in the hand');
      rig.attach('weapon.main', null);
      if (second.parent !== null) failures.push('attach(id, null) did not empty the socket');
      if (rig.attach('weapon.nonesuch', new THREE.Object3D())) {
        failures.push('attaching to a socket that does not exist returned true');
      }
    }
  } finally {
    server.close();
  }

  if (failures.length > 0) {
    console.error(`\nFAIL\n${failures.map((line) => `  - ${line}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nOK: the weapon socket resolves and what hangs off it is the size it was authored.');
}

await main();
