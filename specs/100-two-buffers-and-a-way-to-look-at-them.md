# 096 — Two buffers, and a way to look at them

## Problem

The outline pass (step 5) finds edges by comparing neighbouring depths and
neighbouring normals. Neither exists yet. This is the step that produces them,
and it deliberately produces *nothing visible* — which is the whole difficulty:
a depth texture that was never bound and a normal buffer written with an inverted
transform both render exactly as well as correct ones, right up until the pass
that reads them draws lines in the wrong places and the fault looks like a
threshold problem.

So the deliverable is the buffers **plus the means to see them**, and the second
half is not a convenience. A depth attachment cannot be read back with
`readPixels` at all. The only way to find out what is in one is to sample it in a
shader and write the result somewhere readable — which is a debug view, so the
debug view is built first and everything else is checked through it.

## Shape

`src/render/iso3d/hike-buffers.ts` — the three.js half.

```ts
export type BufferView = 'depth' | 'normals';
export function makeNormalMaterial(flatShading: boolean, side: THREE.Side): THREE.ShaderMaterial;
export function setNormalMaterial(mesh: THREE.Mesh, material: THREE.ShaderMaterial): void;

export class HikeBuffers {
  capture(renderer, scene, camera): void;   // depth + octahedral normals
  blit(renderer, view): void;               // one buffer, full screen
  setSize(w, h): void;
  recreate(): void;                         // after a lost context
}
```

`shading.ts` gains `encodeOctahedral` / `decodeOctahedral` / `glslOctahedralChunk`
— pure, tested, and the GLSL mirrors the TypeScript term for term as usual.

### A second geometry pass, not MRT

MRT is available — WebGL2 here reports six draw buffers — and it would save this
pass. It was not taken for one reason: writing a second output from three.js's
**built-in** materials means injecting a `layout(location = 1) out` declaration
into a GLSL1 shader that three then converts to GLSL3 itself. That is a patch
against an internal conversion step rather than against a documented seam, and
since the entire world is Lambert it would have to work on the built-ins or not
at all.

What it saves is small: at 480×270 the buffer is 129,600 pixels, and the extra
pass has no lighting, no shadow lookups and no texture reads over geometry that
is already resident. If it ever shows up in a profile, MRT is the answer and
`capture` is the only caller that would change.

### The normals come from derivatives

Almost everything here is `flatShading` (spec 018), so the *drawn* normal is not
the interpolated vertex normal — three.js derives it per fragment from the
derivatives of the view position. A normal buffer built from `vNormal` would
disagree with the shading and, worse, put the facet boundaries somewhere else, so
the outline pass would find edges that are not in the picture. The flat variant
therefore mirrors three's `normal_fragment_begin` term for term.

`FLAT_SHADED` is set as an explicit `define` rather than by assigning
`flatShading`: that property is not part of `ShaderMaterial`, and three only
reads it to decide whether to emit the define. `DOUBLE_SIDED` needs no help —
three derives it from `side`, which the terrain's walls rely on.

### Four copies of the wind patch, not three

The prop batches already carry patched depth and distance materials so the shadow
passes bend with the trees. This adds a fourth for the normal pass, via
`applySway`, for exactly the same reason: a batch whose visible geometry leans
while its buffers stand upright would have its outline drawn where the tree used
to be. This copy always takes the normal splice, whatever the visible material
was given — the buffer's entire content is normals, so a bent position with an
unbent normal is the one combination that is never right.

### What is excluded, and why nothing had to be converted

The audit found the world entirely opaque: the trees are solid meshes rather than
alpha cards and the water is `transparent: false`. So there is no alpha-blended
geometry punching holes in the buffers, and **nothing to move to alpha-test**.

The only translucent things are flat unlit ground decals — the target ring, aim
shapes, telegraphs, the move marker, poofs, the unwalkable overlay — which never
wrote depth and are skipped here so they cannot contribute a normal either. A ring
is not a surface. The hover outline shells (spec 041) are skipped too: a
back-faces-only copy would write a normal pointing away from the camera over the
very silhouette it traces.

### The clip planes are left alone

Step 4 was expected to tighten them. Measured, there is nothing to gain: a 24-bit
depth texture over the existing 1–12,000 range resolves about 0.0007 world units,
four orders of magnitude finer than an edge threshold will ever be. Tightening
would buy no precision and risks clipping the world, so it is not done, and this
paragraph exists so the next person does not spend an afternoon on it either.

### Context loss

Handled here, for the first time — it has been unhandled since spec 038 put a
render target on screen, and survivable only because nothing read one back.
`preventDefault` on `webglcontextlost` is what makes `webglcontextrestored` fire
at all; without it the browser never offers a new context and the canvas stays
blank permanently. On restore the buffers are rebuilt and the frame is
re-measured from scratch, because the sizes three.js believes it set belong to a
swap chain that no longer exists.

## Invariants tested

**Octahedral encoding** (`shading.test.ts`, pure)

- **Round-trips both hemispheres** to within a millionth of a radian. Storing xy
  and recovering z loses the sign of z, and this world is seen from above at an
  angle where back-facing normals are a large part of the buffer.
- **Stays inside the unit square**, so nothing clips on the way into a byte.
- **Survives 8-bit quantization to under a degree** — the claim that decides
  whether two channels is enough. Much worse and the normal threshold starts
  finding edges in flat ground.
- **Always decodes to a unit vector**, including for inputs no encode produces.
- **A zero normal gives something rather than a NaN.**
- The GLSL still contains the fold and the unfold, including the `.yx` swap that
  is the easiest line to write subtly differently.

**The buffers on a GPU** (`scripts/probe-shading.ts`, read back through the blit)

- The depth buffer **is not a constant** — a texture that never bound reads flat,
  and that is the failure this whole step is arranged to catch.
- It **has a range**, with surfaces in front of the far plane and background at
  it.
- The normal buffer's surfaces are **96% facing the camera**; a number near zero
  would mean the encode, the decode or the view-space transform is inverted.
- The background reads as the **cleared marker** — black in the buffer, which the
  blit decodes to a direction pointing away from the camera, which no visible
  surface has.
- **A translucent ground decal changes nothing**: removing it from the scene
  leaves the frame byte-identical. Stated as removal rather than as looking for
  its shape, because a check for a shape can pass by accident and this cannot.
  The decal is placed over the floor and lifted well clear of it, since one lying
  on the ground would differ by less than a quantization step and the check would
  pass whatever happened.

Both buffers are also written into the contact sheet at
`.claude/screenshots/shading-probe.png`, so the gradient and the per-facet
normals can be seen rather than inferred.

## Out of scope

- **Anything that reads the buffers.** Edge detection is step 5. Turning
  `buffers` on costs a pass and draws nothing; the debug view is the only way to
  observe it, which is the point.
- **The far plane and the sky as an outline question.** The buffers mark
  background unambiguously — far-plane depth, and a normal facing away. What step
  5 does with that is step 5's decision.
- **Tightening the clip planes**, measured above as worthless here.
- **MRT**, for the reason above; `capture` is the seam if that changes.
- **The map editor**, which has no outline pass to feed.
