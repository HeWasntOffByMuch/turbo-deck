/**
 * The preview viewport (spec 110).
 *
 * The bar this had to clear is that **what it shows is what the game will
 * show**. A preview that flatters moves numbers in the wrong direction and does
 * it convincingly, so everything here is the game's own path:
 *
 *  - the same `RetroPass` the world renders through, with the same palette and
 *    dither;
 *  - the same `createViewControls` cog, so the switches, their defaults and
 *    their ranges are the ones the Play tab has rather than a preset that looks
 *    similar today;
 *  - `MeshLambertMaterial` with `flatShading`, which is what every rig in the
 *    scene already uses.
 *
 * One honest caveat, stated here rather than discovered later: this is the same
 * *panel type* as Play's, not a shared instance. Play builds its controls inside
 * `WorldScene`, and reaching across to hold one object between two tabs would
 * mean changing the Play tab, which the brief puts off limits. The guarantee
 * that matters -- same code, same defaults, no second copy of the look to drift
 * -- holds; the switches simply have to be thrown in both places.
 *
 * ## Time comes from the machine, never from the frame
 *
 * The mixer is driven with `mixer.update(0)` after each action's `time` and
 * weight are written from {@link UnitMachine}'s integer tick. So the pose is a
 * pure function of a tick count, the same at any framerate, and the events the
 * machine reports land on the frame it says they do rather than on whichever one
 * the browser happened to paint.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RetroPass } from '../retro-pass.js';
import { createViewControls, type ViewControls } from '../view-controls.js';
import { PALETTE } from '../palette.js';
import { internalRenderSize } from '../view-frame.js';
import type { PoseSample } from '../../../units/machine.js';

/** The player's real drawn height, so the reference silhouette is not a guess. */
export const PLAYER_REFERENCE_HEIGHT = 55.65;

export interface PreviewAssets {
  readonly meshUrl: string;
  /** Clip id -> the animation-only .glb's URL. */
  readonly clipUrls: Readonly<Record<string, string>>;
  /** Applied to the loaded mesh so it stands at gameplay scale. */
  readonly importScale: number;
}

export interface PreviewCamera {
  /** Degrees. The gameplay preset is a fixed isometric azimuth and elevation. */
  azimuth: number;
  elevation: number;
  distance: number;
}

/** The camera the game frames the world with, so a unit is judged as it is played. */
export const ISO_PRESET: PreviewCamera = { azimuth: 45, elevation: 35.264, distance: 190 };

export class UnitPreview {
  readonly element: HTMLElement;
  readonly controls: ViewControls;

  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
  private readonly retro: RetroPass;
  private readonly root = new THREE.Group();
  private readonly sun: THREE.DirectionalLight;

  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly clipDurations = new Map<string, number>();
  private model: THREE.Object3D | null = null;

  private cam: PreviewCamera = { ...ISO_PRESET };
  private turntable = false;
  private turntableAngle = 0;
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  private failure: string | null = null;

  constructor(width = 640, height = 420) {
    this.element = document.createElement('div');
    this.element.style.cssText = 'position:relative;';

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      `display:block;width:100%;height:${height}px;background:#0b0b12;image-rendering:pixelated;cursor:grab;`;
    this.element.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const size = internalRenderSize(width, height);
    this.retro = new RetroPass(size.width, size.height);

    // The same lighting shape the world uses: one directional key with shadows
    // and a soft ambient fill, so the palette quantizes the same bands.
    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.1);
    this.sun.position.set(120, 200, 90);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const shadowCam = this.sun.shadow.camera;
    shadowCam.left = -120;
    shadowCam.right = 120;
    shadowCam.top = 120;
    shadowCam.bottom = -120;
    shadowCam.near = 1;
    shadowCam.far = 600;
    this.scene.add(this.sun, new THREE.AmbientLight(0x8899bb, 1.1));
    this.scene.background = new THREE.Color(0x1a1a24);
    this.scene.add(this.root);

    this.buildGround();
    this.controls = createViewControls({ lighting: true });
    this.controls.element.style.position = 'absolute';
    this.controls.element.style.top = '8px';
    this.controls.element.style.right = '8px';
    this.element.appendChild(this.controls.element);

    this.attachOrbit();
  }

  /**
   * A ground plane at gameplay scale, and a silhouette the height a player is
   * actually drawn at.
   *
   * The silhouette is the point. A unit that is subtly the wrong size looks
   * fine on its own and wrong the moment it stands next to something -- and
   * "next to something" is the only state it will ever be seen in.
   */
  private buildGround(): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600),
      new THREE.MeshLambertMaterial({ color: PALETTE.grassDark, flatShading: true }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(600, 12, 0x2f4a2a, 0x2a3a26);
    grid.position.y = 0.3;
    this.scene.add(grid);

    const reference = new THREE.Mesh(
      new THREE.BoxGeometry(16, PLAYER_REFERENCE_HEIGHT, 16),
      new THREE.MeshBasicMaterial({ color: 0x6fa8dc, transparent: true, opacity: 0.16 }),
    );
    reference.position.set(0, PLAYER_REFERENCE_HEIGHT / 2, -60);
    this.scene.add(reference);
  }

  private attachOrbit(): void {
    this.canvas.addEventListener('pointerdown', (event) => {
      this.dragging = true;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.canvas.setPointerCapture(event.pointerId);
      this.canvas.style.cursor = 'grabbing';
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.dragging) return;
      this.cam.azimuth += (event.clientX - this.lastPointer.x) * 0.4;
      this.cam.elevation = Math.max(
        4,
        Math.min(86, this.cam.elevation - (event.clientY - this.lastPointer.y) * 0.3),
      );
      this.lastPointer = { x: event.clientX, y: event.clientY };
    });
    for (const event of ['pointerup', 'pointercancel'] as const) {
      this.canvas.addEventListener(event, () => {
        this.dragging = false;
        this.canvas.style.cursor = 'grab';
      });
    }
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.cam.distance = Math.max(60, Math.min(600, this.cam.distance * (1 + Math.sign(event.deltaY) * 0.12)));
      },
      { passive: false },
    );
  }

  setTurntable(on: boolean): void {
    this.turntable = on;
  }

  resetCamera(): void {
    this.cam = { ...ISO_PRESET };
    this.turntableAngle = 0;
  }

  get error(): string | null {
    return this.failure;
  }

  /**
   * Loads the mesh and every clip.
   *
   * Clips arrive as separate animation-only files bound by bone name -- one clip
   * set serving N units is the whole architecture -- so each is parsed and its
   * tracks retargeted onto this model's own skeleton by name, which is exactly
   * what three's mixer does when the track paths match.
   */
  async load(assets: PreviewAssets): Promise<void> {
    const loader = new GLTFLoader();
    try {
      const gltf = await loader.loadAsync(assets.meshUrl);
      const model = gltf.scene;
      model.scale.setScalar(assets.importScale);
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.castShadow = true;
        object.receiveShadow = true;
        // The project's look, applied to the imported material rather than
        // alongside it: flat shading and no specular, same as every other rig.
        const source = object.material as THREE.Material & { color?: THREE.Color };
        object.material = new THREE.MeshLambertMaterial({
          color: source.color?.clone() ?? new THREE.Color(0xc9b79a),
          flatShading: true,
        });
      });

      this.root.clear();
      this.root.add(model);
      this.model = model;
      this.mixer = new THREE.AnimationMixer(model);
      this.actions.clear();
      this.clipDurations.clear();

      for (const [id, url] of Object.entries(assets.clipUrls)) {
        const clipGltf = await loader.loadAsync(url);
        const clip = clipGltf.animations[0];
        if (!clip) continue;
        // Root translation is stripped rather than tolerated: the server owns
        // position, and a clip that moved the body would fight it every frame.
        // Asserted loudly in spec 111; here it is simply removed.
        clip.tracks = clip.tracks.filter((track) => !/\.position$/.test(track.name));
        const action = this.mixer.clipAction(clip);
        action.play();
        // Paused with a weight of zero: the machine decides what plays, and
        // three is only asked to evaluate a pose at a time we hand it.
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
   * Applies the machine's poses.
   *
   * `mixer.update(0)` -- a zero delta. Every action's `time` is written from the
   * machine's tick, so the mixer never advances a clock of its own and the pose
   * is a pure function of an integer. That is what makes an event land on the
   * same frame at 30fps as at 144.
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

  /** How many triangles and bones the loaded model actually has. */
  stats(): { readonly triangles: number; readonly bones: number; readonly vertices: number } {
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
    return { triangles: Math.round(triangles), bones, vertices };
  }

  render(dtSeconds: number): void {
    const box = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.round(box.width));
    const cssHeight = Math.max(1, Math.round(box.height));
    const hike = this.controls.hike();
    // Full-res inspection is exactly the low-resolution switch turned off; the
    // preview has no second idea of what resolution means.
    const size = hike.lowRes
      ? { width: hike.virtualWidth, height: hike.virtualHeight }
      : internalRenderSize(cssWidth, cssHeight);
    if (this.canvas.width !== size.width || this.canvas.height !== size.height) {
      this.renderer.setSize(size.width, size.height, false);
      this.retro.setSize(size.width, size.height);
    }

    this.controls.advanceClock(dtSeconds);
    if (this.turntable) this.turntableAngle += dtSeconds * 40;

    const aspect = size.width / size.height;
    const halfHeight = this.cam.distance / 2;
    const halfWidth = halfHeight * aspect;
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.near = 1;
    this.camera.far = 4000;
    this.camera.updateProjectionMatrix();

    const azimuth = ((this.cam.azimuth + this.turntableAngle) * Math.PI) / 180;
    const elevation = (this.cam.elevation * Math.PI) / 180;
    const radius = 600;
    this.camera.position.set(
      Math.cos(azimuth) * Math.cos(elevation) * radius,
      Math.sin(elevation) * radius,
      Math.sin(azimuth) * Math.cos(elevation) * radius,
    );
    const focus = new THREE.Vector3(0, PLAYER_REFERENCE_HEIGHT * 0.55, 0);
    this.camera.lookAt(focus);
    this.camera.updateMatrixWorld();

    this.retro.set(this.controls.retro());
    this.retro.setGrade(this.controls.grade());
    this.retro.setPalette(hike.palette);
    this.retro.setInk(null, this.camera.near, this.camera.far, 0, new THREE.Color(0x1a1a24), null);
    this.retro.render(this.renderer, this.scene, this.camera);
  }

  dispose(): void {
    this.retro.dispose();
    this.renderer.dispose();
    this.root.clear();
  }
}
