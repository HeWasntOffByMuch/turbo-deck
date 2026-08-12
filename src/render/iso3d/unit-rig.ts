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
import {
  rootMotionMessage,
  rootMotionTrackNames,
  trackTravel,
  travelMessage,
  withoutTravel,
} from '../../units/root-motion.js';
import type { PoseSample } from '../../units/machine.js';
import type { SkeletonSocket } from '../../units/types.js';
import { socketPivot } from './weapon-rig.js';

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
  const source = mesh.material as THREE.Material & {
    color?: THREE.Color;
    map?: THREE.Texture | null;
  };
  mesh.material = new THREE.MeshLambertMaterial({
    color: source.color?.clone() ?? new THREE.Color(DEFAULT_COLOR),
    // The texture comes with it. Dropping the map was fine for as long as the
    // only authored unit was the reference mannequin, which has none -- and it
    // rendered every *generated* unit as a flat-shaded lump of its own base
    // colour, which is what a texture the generator was paid to produce looks
    // like when the loader throws it away.
    ...(source.map ? { map: source.map } : {}),
    flatShading: true,
  });
}

/**
 * The skeleton's root bone in a loaded model.
 *
 * Read off the rig rather than taken from a document, because the two can
 * disagree and only one of them is what the clips will actually animate. The
 * root is the bone with no parent inside the skeleton -- everything above it is
 * the armature or the scene.
 */
function findRootBone(model: THREE.Object3D): string | null {
  let found: string | null = null;
  model.traverse((object) => {
    if (found !== null || !(object instanceof THREE.SkinnedMesh)) return;
    const bones = object.skeleton.bones;
    const names = new Set(bones.map((bone) => bone.name));
    const root = bones.find((bone) => bone.parent === null || !names.has(bone.parent.name));
    found = root?.name ?? null;
  });
  return found;
}

/**
 * The root bone and every named node above it, up to the model.
 *
 * The skin's joints are the bones that *deform* the mesh, and a real rig moves
 * the body with a node that does not: this project's generated rigs carry the
 * travel on `Root`, which sits above `Hip` and is not skinned. So the topmost
 * joint is `Hip`, the strip ran against `Hip`, `Root.position` was never
 * matched, and the import reported itself clean while the body walked out of
 * the scene -- with a preview that showed it doing so.
 *
 * Everything at or above the root positions the body; nothing at or above it
 * poses the body. So all of them are fair game, and taking the chain rather
 * than one name is what makes this robust to a rig with two such nodes, which
 * is common enough (`Armature` over `Root` over `Hip`).
 */
function findRootChain(model: THREE.Object3D): readonly string[] {
  const rootBone = findRootBone(model);
  if (rootBone === null) return [];

  const chain: string[] = [];
  let node: THREE.Object3D | null = model.getObjectByName(rootBone) ?? null;
  while (node !== null && node !== model) {
    if (node.name !== '') chain.push(node.name);
    node = node.parent;
  }
  // The model's own node too: a scene root carrying the travel is still travel,
  // and a track bound to it moves the same body the same way.
  if (model.name !== '') chain.push(model.name);
  return chain;
}

/** The suffix three gives a translation track, and the rest value of a bone with none. */
const POSITION = '.position';
const ZERO: readonly [number, number, number] = [0, 0, 0];

/** How far a bone must go, as a fraction of reach, before it is travelling. */
const TRAVEL_FRACTION_OF_REACH = 0.1;

/**
 * Every bone's bind-pose local translation, keyed the way its tracks are.
 *
 * By `object.name` rather than by anything from a document, because that is
 * what three matched the track against -- the same reason the root bone is
 * found in the loaded rig. `mixorig:Hips` in a file is `mixamorigHips` here.
 */
function readRestPose(model: THREE.Object3D): Map<string, readonly [number, number, number]> {
  const rest = new Map<string, readonly [number, number, number]>();
  model.traverse((node) => {
    if (node instanceof THREE.Bone && node.name !== '') {
      rest.set(node.name, [node.position.x, node.position.y, node.position.z]);
    }
  });
  return rest;
}

/**
 * How far the rig reaches in its own units: the longest bone offset in it.
 *
 * A scale-free stand-in for "how big is this thing", so the travel threshold
 * means the same on a rig exported at 1.7 units and one exported at 55. Mirrors
 * `rigReach` in `scripts/validate-units.ts`, which measures the same quantity
 * off the same numbers in the file.
 */
function reachOf(rest: ReadonlyMap<string, readonly [number, number, number]>): number {
  let reach = 0;
  for (const [x, y, z] of rest.values()) reach = Math.max(reach, Math.hypot(x, y, z));
  return reach;
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
  /** The skeleton's own root bone, found in the loaded rig. */
  private rootBone: string | null = null;
  /** The root and every node above it, which is where travel actually lives. */
  private rootChain: readonly string[] = [];
  /** Each bone's bind-pose local translation, by the name its tracks use. */
  private restPose = new Map<string, readonly [number, number, number]>();
  /** How far the rig reaches in its own units, which sets what counts as travel. */
  private reach = 0;
  /** The skeleton's sockets by id, so `attach` can name one (spec 140). */
  private readonly sockets = new Map<string, SkeletonSocket>();
  /** What is currently hung off each socket, so a switch replaces rather than adds. */
  private readonly attached = new Map<string, THREE.Group>();
  /** The host's import scale, which a socket pivot has to undo (spec 140). */
  private importScale = 1;

  /** Why the load failed, or null. */
  get error(): string | null {
    return this.failure;
  }

  /** Root translation channels found and removed, one message each. */
  get rootMotion(): readonly string[] {
    return this.stripped;
  }

  /**
   * The bone the root-motion check ran against, or null when there is no rig.
   *
   * Worth being able to read. A check that silently ran against a bone this
   * model does not have finds nothing and looks exactly like a clean import.
   */
  get rootBoneName(): string | null {
    return this.rootBone;
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
      this.importScale = assets.importScale;
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.castShadow = true;
        object.receiveShadow = true;
        retexture(object);
      });

      // Every attachment was a child of the *old* model's bones, so a reload
      // orphans them. Cleared here rather than in `dispose`, because a rig that
      // reloads is not a rig that is going away.
      this.attached.clear();
      this.object.clear();
      this.object.add(model);
      this.model = model;
      this.rootBone = findRootBone(model);
      this.rootChain = findRootChain(model);
      // Snapshotted here, before a single clip has been handed to the mixer:
      // once one has, a bone's `position` is whatever the last pose wrote and
      // the rest pose is no longer readable off the rig at all.
      this.restPose = readRestPose(model);
      this.reach = reachOf(this.restPose);
      this.mixer = new THREE.AnimationMixer(model);
      this.actions.clear();
      this.clipDurations.clear();
      this.stripped.length = 0;

      for (const [id, url] of Object.entries(assets.clipUrls)) {
        const clipGltf = await loader.loadAsync(url);
        const clip = clipGltf.animations[0];
        if (!clip) continue;
        // The rig's own root *and everything above it*, not a name from a
        // document. The document might describe a different rig entirely --
        // which is exactly what happened: a generated unit was checked against
        // the reference skeleton's `mixamorig:Hips`, matched nothing, stripped
        // nothing, and walked away from where the server had put it. And the
        // chain rather than the single topmost joint, because the node that
        // carries the travel is usually not a joint at all.
        const roots = this.rootChain.length > 0 ? this.rootChain : [assets.rootBone ?? ''].filter(Boolean);
        this.stripRootMotion(clip, unitId, id, roots);
        this.correctTravel(clip, unitId, id);

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
  private stripRootMotion(clip: THREE.AnimationClip, unitId: string, clipId: string, roots: readonly string[]): void {
    if (roots.length === 0) return;
    const names = clip.tracks.map((track) => track.name);
    const offending = rootMotionTrackNames(names, roots);
    if (offending.length === 0) return;

    clip.tracks = clip.tracks.filter((track) => !offending.includes(track.name));
    // Named by what was actually stripped rather than by everything checked:
    // the chain is several nodes and usually only one of them was moving.
    const stripped = offending.map((name) => name.slice(0, -'.position'.length));
    const message = rootMotionMessage(unitId, clipId, stripped);
    this.stripped.push(message);
    console.error(`[units] ${message}`);
  }

  /**
   * Takes the travel out of any bone that is carrying it (spec 118).
   *
   * The strip above asks *which node* a track sits on and deletes it whole.
   * That is right for a node that exists to position the body and wrong for
   * everything else, which is why it is aimed so narrowly -- and why it found
   * nothing on the pig, whose auto-rig left `Root` rotating in place and baked
   * the entire stride onto `Hip`, a bone whose translation the walk is also
   * made of. Deleting that track would have taken the gait with the fault.
   *
   * So this one asks the values instead: a cycle ends where it began, so a
   * translation track whose last key is not its first is travelling wherever it
   * sits. Only the component along that displacement comes out; the bob, the
   * sway and the crouch are perpendicular to it and survive key for key.
   *
   * The threshold is a tenth of the rig's own reach, the same rule
   * `npm run validate:units` applies to the same files -- the gate and the
   * importer disagreeing about what counts is the failure mode this whole
   * module is arranged to prevent.
   */
  private correctTravel(clip: THREE.AnimationClip, unitId: string, clipId: string): void {
    const minimum = this.reach * TRAVEL_FRACTION_OF_REACH;
    if (!(minimum > 0)) return;

    for (const track of clip.tracks) {
      if (!track.name.endsWith(POSITION)) continue;
      const travel = trackTravel(track.values);
      if (travel.distance < minimum) continue;

      const bone = track.name.slice(0, -POSITION.length);
      const rest = this.restPose.get(bone) ?? ZERO;
      track.values = new Float32Array(withoutTravel(track.values, rest, track.times));

      const message = travelMessage(unitId, clipId, bone, travel.distance);
      this.stripped.push(message);
      console.error(`[units] ${message}`);
    }
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
   * Hangs an object off a named socket (spec 140).
   *
   * **Parented, not copied.** The object becomes a child of the socket's bone
   * through a pivot carrying the socket's own offset and rotation, so it rides
   * the pose through three's own graph and there is no per-frame code for it
   * anywhere. Reading the bone's world matrix each frame and writing it onto a
   * detached object would produce the same picture at 144fps and a weapon
   * lagging its own hand at every rate below that, because spec 118's LOD
   * throttles how often a pose is applied and a copy would be on the renderer's
   * clock rather than the machine's.
   *
   * Replaces rather than accumulates: attaching twice to one socket leaves one
   * object, which is what a weapon switch needs and is the difference between
   * changing swords and holding two.
   *
   * Returns false when the rig has no such socket or no such bone -- a caller
   * that wanted a sword drawn should be able to tell that it was not, rather
   * than find out by looking.
   */
  attach(socketId: string, object: THREE.Object3D): boolean {
    const socket = this.sockets.get(socketId);
    const bone = socket === undefined ? undefined : this.model?.getObjectByName(socket.bone);
    if (!socket || !bone) return false;

    this.detach(socketId);
    // The pivot undoes the host's import scale, so what hangs off it is in
    // **world** units. Everything under a bone inherits the ~56x the model root
    // carries, and a weapon whose document says "38 world units long" would
    // otherwise be drawn 56 times that. Compensating here rather than in the
    // weapon means a sword is one size whatever holds it, and the socket's own
    // `offset` stays in the rig units every other vec3 in a skeleton document
    // is in -- three applies translation before scale, so the two do not fight.
    const pivot = socketPivot(socket.offset, socket.rotationDeg, this.importScale);
    pivot.name = `socket:${socketId}`;
    pivot.add(object);
    bone.add(pivot);
    this.attached.set(socketId, pivot);
    return true;
  }

  /** Empties a socket. Safe on one that was never filled. */
  detach(socketId: string): void {
    const pivot = this.attached.get(socketId);
    if (!pivot) return;
    pivot.removeFromParent();
    pivot.clear();
    this.attached.delete(socketId);
  }

  /** Which sockets currently hold something, for a panel or a test. */
  attachedSockets(): readonly string[] {
    return [...this.attached.keys()];
  }

  /**
   * The sockets this rig knows about, from the skeleton document.
   *
   * Handed in rather than read off the `.glb`, because a socket is authored --
   * it is a *name* for a bone plus a calibration, and neither is in the mesh.
   * Set before `load` or after; the attachments are rebuilt either way, since a
   * caller that swapped skeletons mid-session has bigger problems than this.
   */
  setSockets(sockets: readonly SkeletonSocket[]): void {
    this.sockets.clear();
    for (const socket of sockets) this.sockets.set(socket.id, socket);
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

  /**
   * How tall the loaded body stands, in world units.
   *
   * Measured off the model as drawn -- import scale already applied -- because
   * that is the number anything hung above its head needs. Zero when nothing
   * has loaded, so a caller can tell "not yet" from "flat".
   */
  drawnHeight(): number {
    if (!this.model) return 0;
    const box = new THREE.Box3().setFromObject(this.model);
    const height = box.max.y - box.min.y;
    return Number.isFinite(height) && height > 0 ? height : 0;
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
    for (const socket of [...this.attached.keys()]) this.detach(socket);
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.actions.clear();
    this.clipDurations.clear();
    this.object.clear();
    this.model = null;
  }
}
