import * as THREE from 'three';
import { LINK_BEND } from '../cloth/geometry.js';
import type { RobeRig } from './robe.js';

/**
 * Debug rendering for the robe's cloth (spec 046).
 *
 * The cloth solver is invisible by construction -- what you see is a shaded
 * surface, and every reason it moved the way it did (which particles are pinned,
 * which links are straining, where the body capsules actually are, where the
 * spring is pulling) is hidden inside typed arrays. This draws all of it.
 *
 * Kept strictly modular and off by default: it is one group parented to the
 * rig's, every layer is an independently toggleable child group, and nothing in
 * the rig or the solver knows it exists. Deleting this file would not change a
 * single simulated position. Building the layers costs a fixed set of buffers up
 * front; when a layer is hidden its update is skipped entirely, so leaving the
 * overlay attached with everything off costs a handful of visibility checks.
 */

/** Which overlay layers are drawn. */
export interface ClothLayers {
  /** The figure's bone chain and joints, under the robe. */
  skeleton: boolean;
  /** Every cloth particle: cyan where pinned to a bone, pale where simulated. */
  particles: boolean;
  /** Structural and shear links, coloured green -> red by how far they are strained. */
  links: boolean;
  /** The second-order bend links, drawn separately because they clutter. */
  bend: boolean;
  /** The body capsules the cloth is pushed out of. */
  colliders: boolean;
  /** The skinned reference pose the pose-retention spring pulls toward. */
  reference: boolean;
  /** An arrow showing the current wind direction and strength. */
  wind: boolean;
}

export function defaultClothLayers(): ClothLayers {
  return {
    skeleton: false,
    particles: true,
    links: true,
    bend: false,
    colliders: true,
    reference: false,
    wind: true,
  };
}

const COL_PINNED = new THREE.Color(0x00e5ff);
const COL_FREE = new THREE.Color(0xf2efe4);
const COL_REFERENCE = 0xffa000;
const COL_COLLIDER = 0x66ff99;
const COL_BEND = 0x5a5f8a;
const COL_SKELETON = 0xffe08a;
const COL_WIND = 0x9ad6ff;
/** Link strain colour ramp: relaxed -> taut -> at the stretch cap. */
const STRAIN_LOW = new THREE.Color(0x36c46b);
const STRAIN_MID = new THREE.Color(0xffd24a);
const STRAIN_HIGH = new THREE.Color(0xff4a3d);

/** An always-on-top material for overlay geometry, so nothing occludes it. */
function overlayLineMaterial(vertexColors: boolean, color = 0xffffff): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color, vertexColors, depthTest: false, transparent: true, opacity: 0.9 });
}

/** One collider's wireframe, rebuilt only when its dimensions actually change. */
interface CapsuleVis {
  readonly holder: THREE.Group;
  mesh: THREE.LineSegments | null;
  radius: number;
  length: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _rot = new THREE.Matrix3();
const _up = new THREE.Vector3(0, 1, 0);
const _scratch = new THREE.Color();

export class ClothDebugOverlay {
  private readonly root = new THREE.Group();
  private readonly skeletonGroup = new THREE.Group();
  private readonly particleGroup = new THREE.Group();
  private readonly linkGroup = new THREE.Group();
  private readonly bendGroup = new THREE.Group();
  private readonly colliderGroup = new THREE.Group();
  private readonly referenceGroup = new THREE.Group();
  private readonly windGroup = new THREE.Group();

  private readonly particles: THREE.Points[] = [];
  private readonly links: THREE.LineSegments[] = [];
  private readonly bends: THREE.LineSegments[] = [];
  private readonly references: THREE.Points[] = [];
  private readonly capsules: CapsuleVis[] = [];
  private readonly skeletonLine: THREE.LineSegments;
  private readonly windArrow: THREE.ArrowHelper;
  private layers: ClothLayers = defaultClothLayers();

  constructor(private readonly rig: RobeRig) {
    this.root.add(
      this.skeletonGroup,
      this.particleGroup,
      this.linkGroup,
      this.bendGroup,
      this.colliderGroup,
      this.referenceGroup,
      this.windGroup,
    );
    this.root.renderOrder = 1000;
    rig.group.add(this.root);

    for (const piece of rig.clothPieces) {
      const { geo } = piece;
      this.particles.push(this.makePoints(geo.count, this.particleGroup, 4.5, true));
      this.references.push(this.makePoints(geo.count, this.referenceGroup, 3, false, COL_REFERENCE));

      // Structural/shear and bend links go into separate buffers so each can be
      // toggled (and skipped) without touching the other.
      let structural = 0;
      let bend = 0;
      for (let k = 0; k < geo.linkCount; k++) {
        if ((geo.linkKind[k] as number) === LINK_BEND) bend++;
        else structural++;
      }
      this.links.push(this.makeSegments(structural, this.linkGroup, true));
      this.bends.push(this.makeSegments(bend, this.bendGroup, false, COL_BEND));
    }

    // The bone chain: one segment per parent->child bone pair.
    this.skeletonLine = this.makeSegments(rig.humanoid.bones.length, this.skeletonGroup, false, COL_SKELETON);

    for (let i = 0; i < rig.humanoid.colliders.count; i++) {
      const holder = new THREE.Group();
      this.colliderGroup.add(holder);
      this.capsules.push({ holder, mesh: null, radius: -1, length: -1 });
    }

    this.windArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), 40, COL_WIND, 12, 7);
    this.windGroup.add(this.windArrow);

    this.setLayers(this.layers);
  }

  setLayers(layers: ClothLayers): void {
    this.layers = layers;
    this.skeletonGroup.visible = layers.skeleton;
    this.particleGroup.visible = layers.particles;
    this.linkGroup.visible = layers.links;
    this.bendGroup.visible = layers.bend;
    this.colliderGroup.visible = layers.colliders;
    this.referenceGroup.visible = layers.reference;
    this.windGroup.visible = layers.wind;
  }

  /** Detach and free every buffer. Called when the overlay's rig goes away. */
  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const any = o as Partial<THREE.Mesh>;
      any.geometry?.dispose();
      const mat = any.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat?.dispose();
    });
  }

  /**
   * Refresh every visible layer from the rig's current state. Hidden layers cost
   * one boolean each -- the point of the split is that leaving the overlay
   * attached while tuning does not pay for what is not on screen.
   */
  update(): void {
    // World -> rig-group frame, for the layers that read world-space data
    // (colliders, reference pose, wind). The cloth particles are already local.
    _inv.copy(this.rig.group.matrixWorld).invert();
    _rot.setFromMatrix4(_inv);

    if (this.layers.particles) this.updateParticles();
    if (this.layers.links || this.layers.bend) this.updateLinks();
    if (this.layers.reference) this.updateReference();
    if (this.layers.colliders) this.updateColliders();
    if (this.layers.skeleton) this.updateSkeleton();
    if (this.layers.wind) this.updateWind();
  }

  // --- layers -------------------------------------------------------------

  private updateParticles(): void {
    this.rig.clothPieces.forEach((piece, i) => {
      const points = this.particles[i];
      if (!points) return;
      const attr = points.geometry.getAttribute('position') as THREE.BufferAttribute;
      const colors = points.geometry.getAttribute('color') as THREE.BufferAttribute;
      const dst = attr.array as Float32Array;
      const cdst = colors.array as Float32Array;
      dst.set(piece.local);
      for (let p = 0; p < piece.geo.count; p++) {
        const c = piece.geo.pinned[p] ? COL_PINNED : COL_FREE;
        cdst[p * 3] = c.r;
        cdst[p * 3 + 1] = c.g;
        cdst[p * 3 + 2] = c.b;
      }
      attr.needsUpdate = true;
      colors.needsUpdate = true;
    });
  }

  private updateLinks(): void {
    const maxStretch = Math.max(1.0001, this.rig.tuning.maxStretch);
    const scale = this.rig.tuning.bodyScale;
    this.rig.clothPieces.forEach((piece, i) => {
      const { geo, local } = piece;
      const structural = this.links[i];
      const bend = this.bends[i];
      const sAttr = structural?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      const sCol = structural?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      const bAttr = bend?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      let sv = 0;
      let bv = 0;

      for (let k = 0; k < geo.linkCount; k++) {
        const a = (geo.link[k * 2] as number) * 3;
        const b = (geo.link[k * 2 + 1] as number) * 3;
        const isBend = (geo.linkKind[k] as number) === LINK_BEND;
        const target = isBend ? bAttr : sAttr;
        if (!target) continue;
        const dst = target.array as Float32Array;
        const base = (isBend ? bv : sv) * 6;
        dst[base] = local[a] as number;
        dst[base + 1] = local[a + 1] as number;
        dst[base + 2] = local[a + 2] as number;
        dst[base + 3] = local[b] as number;
        dst[base + 4] = local[b + 1] as number;
        dst[base + 5] = local[b + 2] as number;

        if (isBend) {
          bv++;
          continue;
        }
        if (sCol) {
          // Strain from relaxed (green) through taut (yellow) to the cap (red),
          // so an overstretched region is visible at a glance rather than
          // needing the numeric readout.
          const rest = (geo.linkRest[k] as number) * scale;
          const len = Math.hypot(
            (local[b] as number) - (local[a] as number),
            (local[b + 1] as number) - (local[a + 1] as number),
            (local[b + 2] as number) - (local[a + 2] as number),
          );
          strainColor(rest > 1e-6 ? len / rest : 1, maxStretch, _scratch);
          const c = sv * 6;
          const cdst = sCol.array as Float32Array;
          cdst[c] = _scratch.r;
          cdst[c + 1] = _scratch.g;
          cdst[c + 2] = _scratch.b;
          cdst[c + 3] = _scratch.r;
          cdst[c + 4] = _scratch.g;
          cdst[c + 5] = _scratch.b;
        }
        sv++;
      }
      if (sAttr) sAttr.needsUpdate = true;
      if (sCol) sCol.needsUpdate = true;
      if (bAttr) bAttr.needsUpdate = true;
    });
  }

  private updateReference(): void {
    this.rig.clothPieces.forEach((piece, i) => {
      const points = this.references[i];
      if (!points) return;
      const attr = points.geometry.getAttribute('position') as THREE.BufferAttribute;
      const dst = attr.array as Float32Array;
      const src = piece.ref;
      for (let k = 0; k < src.length; k += 3) {
        _a.set(src[k] as number, src[k + 1] as number, src[k + 2] as number).applyMatrix4(_inv);
        dst[k] = _a.x;
        dst[k + 1] = _a.y;
        dst[k + 2] = _a.z;
      }
      attr.needsUpdate = true;
    });
  }

  private updateColliders(): void {
    const caps = this.rig.humanoid.colliders;
    for (let i = 0; i < this.capsules.length; i++) {
      const vis = this.capsules[i];
      if (!vis) continue;
      const i3 = i * 3;
      _a.set(caps.a[i3] as number, caps.a[i3 + 1] as number, caps.a[i3 + 2] as number).applyMatrix4(_inv);
      _b.set(caps.b[i3] as number, caps.b[i3 + 1] as number, caps.b[i3 + 2] as number).applyMatrix4(_inv);
      const radius = caps.radius[i] as number;
      const length = _a.distanceTo(_b);

      // Rebuild only when the shape actually changed -- i.e. when the body-scale
      // slider moved -- not every frame.
      if (!vis.mesh || Math.abs(radius - vis.radius) > 1e-3 || Math.abs(length - vis.length) > 1e-3) {
        vis.mesh?.geometry.dispose();
        vis.mesh?.removeFromParent();
        const geo = new THREE.WireframeGeometry(new THREE.CapsuleGeometry(Math.max(0.01, radius), length, 3, 8));
        vis.mesh = new THREE.LineSegments(geo, overlayLineMaterial(false, COL_COLLIDER));
        vis.mesh.renderOrder = 1000;
        vis.mesh.frustumCulled = false;
        vis.holder.add(vis.mesh);
        vis.radius = radius;
        vis.length = length;
      }

      _mid.copy(_a).add(_b).multiplyScalar(0.5);
      vis.holder.position.copy(_mid);
      if (length > 1e-6) {
        _dir.copy(_b).sub(_a).multiplyScalar(1 / length);
        vis.holder.quaternion.setFromUnitVectors(_up, _dir);
      }
    }
  }

  private updateSkeleton(): void {
    const bones = this.rig.humanoid.bones;
    const attr = this.skeletonLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    const dst = attr.array as Float32Array;
    let v = 0;
    for (const bone of bones) {
      const parent = bone.parent;
      if (!parent) continue;
      _a.setFromMatrixPosition(parent.matrixWorld).applyMatrix4(_inv);
      _b.setFromMatrixPosition(bone.matrixWorld).applyMatrix4(_inv);
      const base = v * 6;
      if (base + 5 >= dst.length) break;
      dst[base] = _a.x;
      dst[base + 1] = _a.y;
      dst[base + 2] = _a.z;
      dst[base + 3] = _b.x;
      dst[base + 4] = _b.y;
      dst[base + 5] = _b.z;
      v++;
    }
    // Collapse any unused segments onto a point rather than leaving stale lines.
    for (let k = v * 6; k < dst.length; k++) dst[k] = 0;
    attr.needsUpdate = true;
  }

  private updateWind(): void {
    const { wind } = this.rig;
    const speed = wind.strength;
    if (speed < 1e-3) {
      this.windArrow.visible = false;
      return;
    }
    this.windArrow.visible = true;
    _dir.set(wind.vx, wind.vy, wind.vz).multiplyScalar(1 / speed).applyMatrix3(_rot).normalize();
    this.windArrow.setDirection(_dir);
    // Length reads as strength: 1 world unit of arrow per 2 units/s of wind,
    // clamped so a gale does not fill the viewport.
    this.windArrow.setLength(Math.min(140, 12 + speed * 0.5), 12, 7);
    this.windArrow.position.set(0, 95 * this.rig.tuning.bodyScale, 0);
  }

  // --- buffer construction ------------------------------------------------

  private makePoints(
    count: number,
    parent: THREE.Group,
    size: number,
    vertexColors: boolean,
    color = 0xffffff,
  ): THREE.Points {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    if (vertexColors) geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors, color, depthTest: false }),
    );
    points.frustumCulled = false;
    points.renderOrder = 1001;
    parent.add(points);
    return points;
  }

  private makeSegments(
    segments: number,
    parent: THREE.Group,
    vertexColors: boolean,
    color = 0xffffff,
  ): THREE.LineSegments {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segments * 6), 3));
    if (vertexColors) geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(segments * 6), 3));
    const line = new THREE.LineSegments(geo, overlayLineMaterial(vertexColors, color));
    line.frustumCulled = false;
    line.renderOrder = 999;
    parent.add(line);
    return line;
  }
}

/** Map a link's length/rest ratio onto the green -> yellow -> red strain ramp. */
function strainColor(ratio: number, maxStretch: number, out: THREE.Color): void {
  // 1.0 is relaxed, `maxStretch` is the hard cap; compressed links read as relaxed.
  const t = Math.max(0, Math.min(1, (ratio - 1) / (maxStretch - 1)));
  if (t < 0.5) out.copy(STRAIN_LOW).lerp(STRAIN_MID, t * 2);
  else out.copy(STRAIN_MID).lerp(STRAIN_HIGH, (t - 0.5) * 2);
}
