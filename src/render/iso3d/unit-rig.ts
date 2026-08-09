/**
 * A loaded authored unit, posed by a machine (spec 111).
 *
 * The three.js half of "the tool and the game read the same files". It was
 * originally inside the Studio preview, which meant the preview was the only
 * thing that knew how to turn three documents and four `.glb`s into something
 * that moves — so the game would have needed a second implementation, and the
 * moment there are two, the interesting question stops being "is the format
 * right" and becomes "which of them is wrong".
 *
 * What it owns is narrow on purpose: load, strip root motion, hold the actions,
 * write a pose. It does not own a scene, a camera, a light or a material policy
 * beyond the project's flat-shaded look, because those differ between a preview
 * on a black backdrop and a body standing on a heightfield.
 *
 * ## The mixer never runs a clock
 *
 * `mixer.update(0)` — a zero delta, every time. Each action's `time` is written
 * from a normalized position the machine derived from an *integer tick*, so the
 * pose is a pure function of a tick count. That is the whole reason an event
 * lands on the same frame at 30fps as at 144, and it is why nothing here takes a
 * `dt`.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { rootMotionMessage, rootMotionTrackNames } from '../../units/root-motion.js';
import type { PoseSample } from '../../units/machine.js';

/** Where a unit's bytes are. Ids match the clip library's, not the file names. */
export interface UnitAssets {
  readonly meshUrl: string;
  /** Clip id -> the animation-only .glb's URL. */
  readonly clipUrls: Readonly<Record<string, string>>;
  /** Applied to the loaded mesh so it stands at gameplay scale. */
  readonly importScale: number;
  /**
   * The rig's root bone, for the root-motion check.
   *
   * Optional because a caller that has not loaded the skeleton document cannot
   * know it; absent, the check is skipped rather than guessed at. Guessing
   * `Hips` would be right for mixamo and wrong the first time it is not, and a
   * wrong root means either a silent miss or a stripped track the rig needed.
   */
  readonly rootBone?: string;
}

/** What a body looks like once it is standing there. */
export interface UnitStats {
  readonly triangles: number;
  readonly vertices: number;
  readonly bones: number;
}

const DEFAULT_COLOR = 0xc9b79a;

/**
 * Applies the project's look to an imported material.
 *
 * Replaced rather than tweaked: a generated mesh arrives with whatever PBR
 * material its exporter felt like, and a scene lit for flat Lambert with one
 * key light renders that as a shiny grey blob. The colour is kept because it is
 * the one thing the generator got right.
 */
function retexture(mesh: THREE.Mesh): void {
  const source = mesh.material as THREE.Material & { color?: THREE.Color };
  mesh.material = new THREE.MeshLambertMaterial({
    color: source.color?.clone() ?? new THREE.Color(DEFAULT_COLOR),
    flatShading: true,
  });
}

export class UnitRig {
  /** The thing to add to a scene. Always present, empty until `load` resolves. */
  readonly object = new THREE.Group();

  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly clipDurations = new Map<string, number>();
  private model: THREE.Object3D | null = null;
  private failure: string | null = null;
  private readonly stripped: string[] = [];

  /** Why the load failed, or null. */
  get error(): string | null {
    return this.failure;
  }

  /** Root translation channels found and removed, one message each. */
  get rootMotion(): readonly string[] {
    return this.stripped;
  }

  get loaded(): boolean {
    return this.model !== null;
  }

  /**
   * Loads the mesh and every clip.
   *
   * Clips arrive as separate animation-only files bound by bone name — one clip
   * set serving N units is the whole architecture — so each is parsed and its
   * tracks land on this model's own skeleton by name, which is what three's
   * mixer does when the track paths match.
   *
   * A clip that fails to load is skipped rather than fatal. A unit missing its
   * run cycle should walk everywhere, not fail to appear.
   */
  async load(assets: UnitAssets, unitId = 'unit'): Promise<void> {
    const loader = new GLTFLoader();
    try {
      const gltf = await loader.loadAsync(assets.meshUrl);
      const model = gltf.scene;
      model.scale.setScalar(assets.importScale);
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.castShadow = true;
        object.receiveShadow = true;
        retexture(object);
      });

      this.object.clear();
      this.object.add(model);
      this.model = model;
      this.mixer = new THREE.AnimationMixer(model);
      this.actions.clear();
      this.clipDurations.clear();
      this.stripped.length = 0;

      for (const [id, url] of Object.entries(assets.clipUrls)) {
        const clipGltf = await loader.loadAsync(url);
        const clip = clipGltf.animations[0];
        if (!clip) continue;
        this.stripRootMotion(clip, unitId, id, assets.rootBone);

        const action = this.mixer.clipAction(clip);
        action.play();
        // Paused with a weight of zero: the machine decides what plays, and
        // three is only ever asked to evaluate a pose at a time we hand it.
        action.paused = true;
        action.setEffectiveWeight(0);
        this.actions.set(id, action);
        this.clipDurations.set(id, clip.duration);
      }
      this.failure = null;
    } catch (cause) {
      this.failure = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /**
   * Removes root translation, and complains about having had to.
   *
   * The server owns where a body is; a clip that also moves it fights the
   * position every frame and snaps back on the next delta. Stripping is the
   * right fix and every pipeline does it — what is wrong is doing it *quietly*,
   * because then a clip authored with a two-metre stride ships as one that
   * moon-walks and nobody finds out until they watch it. So the tracks come out
   * and the console says so, `npm run validate:units` fails on the same
   * condition, and the Studio panel shows it.
   */
  private stripRootMotion(clip: THREE.AnimationClip, unitId: string, clipId: string, rootBone?: string): void {
    if (rootBone === undefined) return;
    const names = clip.tracks.map((track) => track.name);
    const offending = rootMotionTrackNames(names, rootBone);
    if (offending.length === 0) return;

    clip.tracks = clip.tracks.filter((track) => !offending.includes(track.name));
    const message = rootMotionMessage(unitId, clipId, [rootBone]);
    this.stripped.push(message);
    console.error(`[units] ${message}`);
  }

  /**
   * Writes the machine's poses onto the mixer.
   *
   * Every action is zeroed first rather than only the ones being replaced: a
   * state left over from a transition that finished would otherwise keep its
   * weight and blend into everything after it, which reads as a unit that never
   * quite stops doing the last thing it did.
   */
  applyPoses(poses: readonly PoseSample[]): void {
    if (!this.mixer) return;
    for (const action of this.actions.values()) action.setEffectiveWeight(0);
    for (const pose of poses) {
      const action = this.actions.get(pose.clipId);
      const duration = this.clipDurations.get(pose.clipId);
      if (!action || duration === undefined) continue;
      action.setEffectiveWeight(pose.weight);
      action.time = Math.max(0, Math.min(duration, pose.normalizedTime * duration));
    }
    this.mixer.update(0);
  }

  /**
   * Scales the model so it stands exactly `targetHeight` tall, and says what
   * scale that took.
   *
   * A generated rig arrives at whatever size its generator felt like, and the
   * import scale in a unitdef is supposed to be a *measured* number rather than
   * one somebody typed -- the reference unit's 32.35 was measured, and reusing
   * it for a different rig would draw every generated unit at a size that is
   * simply wrong. With the player silhouette standing beside it in the preview,
   * wrong by 40% is obvious and wrong by 5% is not, which is the case this
   * exists for.
   *
   * Returns the absolute scale, so it can be written into the document as the
   * import override rather than recomputed by whatever loads it next.
   */
  fitToHeight(targetHeight: number): number {
    if (!this.model || !(targetHeight > 0)) return 1;
    const box = new THREE.Box3().setFromObject(this.model);
    const height = box.max.y - box.min.y;
    if (!(height > 0)) return this.model.scale.y;
    const factor = targetHeight / height;
    this.model.scale.multiplyScalar(factor);
    return this.model.scale.y;
  }

  /**
   * Each loaded clip's real length in milliseconds.
   *
   * The number Export refuses to invent, and the reason it refuses: a made-up
   * duration validates and then silently rescales every action timing built on
   * it. This is where the real one comes from -- read off the file three just
   * decoded, not off a document that claims it.
   */
  durationsMs(): Readonly<Record<string, number>> {
    const found: Record<string, number> = {};
    for (const [id, seconds] of this.clipDurations) found[id] = seconds * 1000;
    return found;
  }

  /** How many triangles and bones the loaded model actually has. */
  stats(): UnitStats {
    let triangles = 0;
    let vertices = 0;
    let bones = 0;
    this.model?.traverse((object) => {
      if (object instanceof THREE.SkinnedMesh) bones = Math.max(bones, object.skeleton.bones.length);
      if (object instanceof THREE.Mesh) {
        const geometry = object.geometry;
        const index = geometry.getIndex();
        const position = geometry.getAttribute('position');
        triangles += index ? index.count / 3 : (position?.count ?? 0) / 3;
        vertices += position?.count ?? 0;
      }
    });
    return { triangles, vertices, bones };
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.actions.clear();
    this.clipDurations.clear();
    this.object.clear();
    this.model = null;
  }
}
