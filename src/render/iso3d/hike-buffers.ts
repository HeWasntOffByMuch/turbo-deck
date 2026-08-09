import * as THREE from 'three';
import { glslOctahedralChunk } from './shading.js';

/**
 * The depth and view-space-normal buffers the outline pass reads (spec 096).
 *
 * ## Why a second geometry pass rather than MRT
 *
 * MRT is available -- WebGL2 here reports six draw buffers -- and it would save
 * this pass. It was not taken, for one reason: writing a second output from
 * three.js's *built-in* materials means injecting a `layout(location = 1) out`
 * declaration into a GLSL1 shader that three then converts to GLSL3 itself, and
 * that is a patch against an internal conversion step rather than against a
 * documented seam. The whole world is Lambert, so it would have to work on the
 * built-ins or not at all.
 *
 * The pass it saves is small. At 480x270 the buffer is 129,600 pixels and the
 * scene is a few thousand triangles; the cost is a second vertex pass over
 * geometry that is already resident, with no lighting, no shadow lookups and no
 * texture reads. If that ever shows up in a profile, MRT is the answer and the
 * shape of this file barely changes -- `capture` is the only caller.
 *
 * ## Why the normals come from derivatives
 *
 * Almost everything in this world is `flatShading` (spec 031), which means the
 * *drawn* normal is not the interpolated vertex normal at all -- three.js derives
 * it per fragment from the derivatives of the view position. A normal buffer
 * built from `vNormal` would therefore disagree with the shading and, worse,
 * disagree with where the facet boundaries are, so the outline pass would find
 * edges that are not in the picture. So the flat variant mirrors three's own
 * `normal_fragment_begin` term for term.
 *
 * ## What is excluded, and why nothing had to be converted
 *
 * The audit for this arc found the world entirely opaque: the trees are solid
 * meshes rather than alpha cards, and the water is `transparent: false`. So there
 * is no alpha-blended geometry to punch holes in the buffers and nothing to move
 * to alpha-test. The only translucent things are flat unlit ground decals -- the
 * target ring, the aim shapes, telegraphs, the move marker, poofs, the unwalkable
 * overlay -- which already never write depth, and which are skipped here so they
 * cannot contribute a normal either. A ring is not a surface and must not be
 * outlined like one.
 */

/** What one buffer can be drawn as, for the debug view. */
export type BufferView = 'depth' | 'normals';

const NORMAL_VERTEX = /* glsl */ `
#include <common>

varying vec3 vViewPosition;
varying vec3 vNormalW;

void main() {
  // three's own chunks, so instancing and the wind sway's splices land exactly
  // where they do in the material this is standing in for.
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  vNormalW = transformedNormal;

  #include <begin_vertex>
  #include <project_vertex>
  vViewPosition = -mvPosition.xyz;
}
`;

const NORMAL_FRAGMENT = /* glsl */ `
precision highp float;

varying vec3 vViewPosition;
varying vec3 vNormalW;

${glslOctahedralChunk()}

void main() {
  #ifdef FLAT_SHADED
    // The same expression three.js uses under FLAT_SHADED, so the buffer agrees
    // with the shading rather than with the vertex data the shading ignored.
    vec3 fdx = dFdx(vViewPosition);
    vec3 fdy = dFdy(vViewPosition);
    vec3 n = normalize(cross(fdx, fdy));
  #else
    vec3 n = normalize(vNormalW);
    #ifdef DOUBLE_SIDED
      n *= gl_FrontFacing ? 1.0 : -1.0;
    #endif
  #endif

  // Two channels for the normal, two spare: the depth comes from a real depth
  // texture, so nothing needs packing in here.
  gl_FragColor = vec4(encodeOctahedral(n), 0.0, 1.0);
}
`;

/**
 * A material that writes an octahedral view-space normal instead of a colour.
 *
 * `flatShading` and `side` are copied from the material being stood in for,
 * because both change what the normal *is*: flat shading takes it from
 * derivatives, and a double-sided surface flips it for back faces. The prop
 * batches need their own patched copies of this, which is why `sway.ts` asks for
 * one -- a batch whose position is bent by the wind and whose normal buffer is
 * not would draw its outline where the tree used to be.
 */
export function makeNormalMaterial(flatShading: boolean, side: THREE.Side): THREE.ShaderMaterial {
  // FLAT_SHADED as an explicit define rather than by setting `flatShading`: that
  // property is not part of `ShaderMaterial`, and three.js only reads it to decide
  // whether to emit this define -- so declaring the define says the same thing
  // without leaning on an undeclared property. `DOUBLE_SIDED` needs no such help;
  // three derives it from `side` for every material.
  return new THREE.ShaderMaterial({
    vertexShader: NORMAL_VERTEX,
    fragmentShader: NORMAL_FRAGMENT,
    side,
    defines: flatShading ? { FLAT_SHADED: '' } : {},
  });
}

/** Where a mesh's normal material is kept, so the pass can find it. */
const NORMAL_MATERIAL_KEY = 'hikeNormalMaterial';

/**
 * Give a mesh the material the normal pass should draw it with.
 *
 * Used by `sway.ts` for the prop batches, whose normal material has to carry the
 * same wind patch their visible one does.
 */
export function setNormalMaterial(mesh: THREE.Mesh, material: THREE.ShaderMaterial): void {
  mesh.userData[NORMAL_MATERIAL_KEY] = material;
}

const BLIT_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * The debug blit.
 *
 * This is not a nicety -- it is the only way to see a depth texture at all. A
 * depth attachment cannot be read back with `readPixels`, so the only way to know
 * the depth path works is to sample it in a shader and write the result somewhere
 * readable. Which makes this both the debug view and the verification mechanism,
 * and is why it exists before anything consumes the buffers.
 */
const BLIT_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uNormals;
uniform highp sampler2D uDepth;
uniform int uMode;
varying vec2 vUv;

${glslOctahedralChunk()}

void main() {
  if (uMode == 0) {
    // Orthographic, so the depth buffer is already linear from near to far and
    // there is no reconstruction to do -- one of the few places the projection
    // makes life simpler rather than harder. highp because mediump would band a
    // gradient this shallow into visible steps on a mobile GPU.
    float depth = texture2D(uDepth, vUv).r;
    gl_FragColor = vec4(vec3(depth), 1.0);
  } else {
    vec3 n = decodeOctahedral(texture2D(uNormals, vUv).rg);
    gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
  }
}
`;

export class HikeBuffers {
  /** Octahedral normals in RG. Depth is the attached depth texture. */
  private target: THREE.WebGLRenderTarget;
  private readonly blitScene = new THREE.Scene();
  private readonly blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly blitMaterial: THREE.ShaderMaterial;
  private readonly blitUniforms: {
    uNormals: { value: THREE.Texture | null };
    uDepth: { value: THREE.Texture | null };
    uMode: { value: number };
  };

  /** The two stand-in materials everything that is not a prop batch shares. */
  private readonly sharedNormal = new Map<string, THREE.ShaderMaterial>();

  /** Scratch for the swap, so a per-frame capture allocates nothing. */
  private readonly swapped: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = [];
  private readonly hidden: THREE.Object3D[] = [];

  constructor(
    private width: number,
    private height: number,
  ) {
    this.target = this.makeTarget();
    this.blitUniforms = {
      uNormals: { value: this.target.texture },
      uDepth: { value: this.target.depthTexture },
      uMode: { value: 0 },
    };
    this.blitMaterial = new THREE.ShaderMaterial({
      uniforms: this.blitUniforms,
      vertexShader: BLIT_VERTEX,
      fragmentShader: BLIT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.blitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMaterial));
  }

  /**
   * The buffers, at the virtual resolution and nowhere near the canvas's.
   *
   * Nearest filtering throughout: these are measurements, not pictures, and a
   * linearly-filtered normal halfway between two facets is a direction neither
   * surface has.
   */
  private makeTarget(): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(Math.max(1, this.width), Math.max(1, this.height), {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    // A real depth texture rather than a packed one: 24 bits of hardware depth,
    // which over the 12,000-unit view range is about 0.0007 world units per step
    // -- four orders of magnitude finer than the edge threshold will ever be, so
    // there is nothing to gain by tightening the clip planes and a clipped world
    // to lose by getting it wrong.
    target.depthTexture = new THREE.DepthTexture(
      Math.max(1, this.width),
      Math.max(1, this.height),
      THREE.UnsignedIntType,
    );
    target.depthTexture.format = THREE.DepthFormat;
    return target;
  }

  get normalTexture(): THREE.Texture {
    return this.target.texture;
  }

  get depthTexture(): THREE.Texture | null {
    return this.target.depthTexture;
  }

  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    // Resized rather than rebuilt, so the blit's uniforms keep pointing at the
    // same texture objects.
    this.target.setSize(Math.max(1, width), Math.max(1, height));
    if (this.target.depthTexture) this.target.depthTexture.needsUpdate = true;
  }

  /**
   * Throw the render target away and build another.
   *
   * For a restored WebGL context, where every GPU-side object belonging to the
   * old one is gone and three.js's handles to them are stale. The uniforms have
   * to be re-pointed because this really is a different texture.
   */
  recreate(): void {
    this.target.dispose();
    this.target.depthTexture?.dispose();
    this.target = this.makeTarget();
    this.blitUniforms.uNormals.value = this.target.texture;
    this.blitUniforms.uDepth.value = this.target.depthTexture;
    for (const material of this.sharedNormal.values()) material.needsUpdate = true;
    this.blitMaterial.needsUpdate = true;
  }

  /**
   * Draw depth and normals for everything in `scene` that is a surface.
   *
   * The scene is walked and every lit mesh has its material swapped for the
   * normal-writing stand-in; everything else is hidden for the duration. Both are
   * undone before returning, so a caller that forgets nothing still gets its
   * scene back.
   */
  capture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    this.swapped.length = 0;
    this.hidden.length = 0;

    scene.traverse((node) => {
      if (!(node instanceof THREE.Mesh) || !node.visible) return;
      // An outline shell is a back-faces-only copy of a body (spec 041). It would
      // write a normal pointing away from the camera over the very silhouette it
      // is tracing.
      if (node.userData['isOutline'] === true) {
        this.hidden.push(node);
        node.visible = false;
        return;
      }
      const stand = this.normalMaterialFor(node);
      if (!stand) {
        this.hidden.push(node);
        node.visible = false;
        return;
      }
      this.swapped.push({ mesh: node, material: node.material });
      node.material = stand;
    });

    const previousTarget = renderer.getRenderTarget();
    // Saved and put back: the clear colour is renderer-wide state, and leaving it
    // black means every later pass that clears -- the frame itself included --
    // clears to black instead of to whatever it wanted.
    const previousClear = new THREE.Color();
    renderer.getClearColor(previousClear);
    const previousClearAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(this.target);
    // Normals encode to (0.5, 0.5) at the centre of the square, which decodes to
    // +z -- straight at the camera. Clearing to black instead means the
    // background decodes to a direction no surface has, which is exactly what a
    // "there is nothing here" marker should be, and the depth texture reading 1.0
    // is what actually identifies it.
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClear, previousClearAlpha);

    for (const { mesh, material } of this.swapped) mesh.material = material;
    for (const node of this.hidden) node.visible = true;
    this.swapped.length = 0;
    this.hidden.length = 0;
  }

  /**
   * The stand-in for one mesh, or null if it should not be in the buffers at all.
   *
   * A mesh that carries its own -- the wind-swayed prop batches -- gets that,
   * because only it knows this batch's bend. Everything else shares one per
   * (flatShading, side) pair, which is two or three programs for the whole world.
   */
  private normalMaterialFor(mesh: THREE.Mesh): THREE.ShaderMaterial | null {
    const own = mesh.userData[NORMAL_MATERIAL_KEY] as THREE.ShaderMaterial | undefined;
    if (own) return own;

    const material = mesh.material;
    if (Array.isArray(material)) return null;
    // A surface is anything that writes depth and is not blended.
    //
    // This used to test for `MeshLambertMaterial`, on the reasoning that lit
    // geometry is the world and unlit geometry is decoration. That was true when
    // it was written and stopped being true the moment projectiles arrived: an
    // arrow in flight is `MeshBasicMaterial` because it is meant to read bright,
    // not because it is not a surface, and it was silently flying without an
    // outline. Depth is the property that actually means "this occludes things",
    // which is the same question the outline pass is asking.
    if (material.transparent === true || material.depthWrite === false) return null;
    // Except for the handful of things that are drawn in the world but are not
    // *of* it -- a facing arrow under a unit's feet is a readout, and giving it a
    // silhouette would trace the indicator rather than the thing it points from.
    if (mesh.userData['isOverlay'] === true) return null;

    const flat = material instanceof THREE.MeshLambertMaterial && material.flatShading === true;
    const side = material.side;
    const key = `${flat ? 'flat' : 'smooth'}:${String(side)}`;
    let stand = this.sharedNormal.get(key);
    if (!stand) {
      stand = makeNormalMaterial(flat, side);
      this.sharedNormal.set(key, stand);
    }
    return stand;
  }

  /** Draw one buffer over the whole canvas, for the debug view. */
  blit(renderer: THREE.WebGLRenderer, view: BufferView): void {
    this.blitUniforms.uMode.value = view === 'depth' ? 0 : 1;
    renderer.setRenderTarget(null);
    renderer.render(this.blitScene, this.blitCamera);
  }

  dispose(): void {
    this.target.dispose();
    this.target.depthTexture?.dispose();
    for (const material of this.sharedNormal.values()) material.dispose();
    this.sharedNormal.clear();
    this.blitMaterial.dispose();
  }
}
