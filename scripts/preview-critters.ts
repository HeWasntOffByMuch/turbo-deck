// Dev-only: render the critter rigs (spec 049) to a PNG contact sheet so a human
// -- or an agent with no screen -- can check the characters actually read.
// Not part of the app. `tsx scripts/preview-critters.ts`
//
// It builds the **real `CritterRig`**, walks it for a few seconds, and rasterises
// the three.js meshes it produced with a small z-buffered software renderer at
// the scene's isometric angle. So this checks the whole chain the game uses --
// species data, geometry construction, coat derivation, the shared walk cycle --
// and not a second model of it that could quietly drift from the first.
//
// Each species is drawn at 256 px across several player coats (to judge the
// shapes and the palette) and at 64 px upscaled (to judge what actually survives
// at unit size, which is the constraint the models are designed against).
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import { CRITTERS, CRITTER_IDS } from '../src/render/critters/index.js';
import { PLAYER_COATS, type CoatSwatch } from '../src/render/critters/palette.js';
import { CritterRig, defaultCritterTuning } from '../src/render/iso3d/critter.js';
import type { CritterSpecies } from '../src/render/critters/types.js';

const BIG = 256;
const SMALL = 64;
const SMALL_SCALE = 3;
const GAP = 8;
const BG: readonly [number, number, number] = [58, 60, 68];
const SHEET_BG: readonly [number, number, number] = [30, 31, 36];

/** The scene's isometric view direction, and a light roughly where its sun is. */
const VIEW_DIR = new THREE.Vector3(-1, -0.82, -1).normalize();
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.38).normalize();
// The scene lights with one directional light over a strong blue ambient, so
// even the faces turned away from the sun keep most of their colour.
const AMBIENT = 0.6;

/** How far the rig is walked before it is drawn, so the pose is mid-stride. */
const WARMUP_FRAMES = 96;
const WALK_SPEED_PER_FRAME = 1.1;

// --- Triangle collection --------------------------------------------------

interface Tri {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly c: THREE.Vector3;
  readonly color: THREE.Color;
}

/** Every triangle under `root`, in world space, with its material's colour. */
function collectTriangles(root: THREE.Object3D): Tri[] {
  const tris: Tri[] = [];
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const index = geo.getIndex();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const count = index ? index.count : pos.count;
    // A painted part draws through geometry groups, so which material a triangle
    // belongs to is a range lookup rather than a property of the mesh.
    const groups = geo.groups.length > 0 ? geo.groups : [{ start: 0, count, materialIndex: 0 }];
    const materialFor = (i: number): THREE.Color => {
      for (const g of groups) {
        if (i >= g.start && i < g.start + g.count) {
          const m = materials[Math.min(g.materialIndex ?? 0, materials.length - 1)];
          return (m as THREE.MeshLambertMaterial).color;
        }
      }
      return (materials[0] as THREE.MeshLambertMaterial).color;
    };
    for (let i = 0; i < count; i += 3) {
      const corners = [0, 1, 2].map((k) => {
        const vi = index ? index.getX(i + k) : i + k;
        return new THREE.Vector3(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(mesh.matrixWorld);
      });
      tris.push({
        a: corners[0] as THREE.Vector3,
        b: corners[1] as THREE.Vector3,
        c: corners[2] as THREE.Vector3,
        color: materialFor(i),
      });
    }
  });
  return tris;
}

// --- Rasteriser -----------------------------------------------------------

/** Linear-sRGB to sRGB, the transfer WebGL applies on the way to the screen. */
function encode(linear: number): number {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

/**
 * Orthographic, z-buffered, flat-shaded: the same three properties the game's
 * renderer has, which is all this needs to be a fair preview.
 */
function render(tris: readonly Tri[], size: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = BG[0];
    out[i * 4 + 1] = BG[1];
    out[i * 4 + 2] = BG[2];
    out[i * 4 + 3] = 255;
  }
  if (tris.length === 0) return out;

  // Camera basis: forward along the iso view, right/up spanning the image.
  const forward = VIEW_DIR;
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();

  // Frame the subject on its own projected extent, with a little air.
  const project = (p: THREE.Vector3): [number, number, number] => [
    p.dot(right),
    p.dot(up),
    p.dot(forward),
  ];
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const t of tris) {
    for (const p of [t.a, t.b, t.c]) {
      const [u, v] = project(p);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }
  const pad = 4;
  const halfV = (maxV - minV) / 2 + pad;
  const halfU = Math.max(halfV, (maxU - minU) / 2 + pad);
  const half = Math.max(halfU, halfV);
  const midU = (minU + maxU) / 2;
  const midV = (minV + maxV) / 2;

  const depth = new Float64Array(size * size).fill(Infinity);
  const normal = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();

  for (const t of tris) {
    const [ax, ay, az] = project(t.a);
    const [bx, by, bz] = project(t.b);
    const [cx, cy, cz] = project(t.c);

    // Flat shading: one lambert term per triangle, from its geometric normal.
    e1.subVectors(t.b, t.a);
    e2.subVectors(t.c, t.a);
    normal.crossVectors(e1, e2).normalize();
    // Cull back faces, exactly as `MeshLambertMaterial`'s default `FrontSide`
    // does. This preview used to flip every normal toward the camera instead,
    // which is a friendlier picture and a *worse* preview: it drew inside-out
    // geometry as though it were fine, and hid a torso whose front the real
    // renderer was culling away entirely.
    if (normal.dot(forward) > 0) continue;
    const lambert = AMBIENT + (1 - AMBIENT) * Math.max(0, normal.dot(LIGHT));
    // `THREE.Color` holds linear-sRGB, so light it in linear and encode once at
    // the end -- writing its channels straight out darkens and over-saturates
    // every coat, which is a very convincing way to misjudge a palette.
    const r = encode(t.color.r * lambert);
    const g = encode(t.color.g * lambert);
    const b = encode(t.color.b * lambert);

    // World units -> pixels. +v is up on screen, so the y axis flips.
    const px = (u: number): number => ((u - midU) / (2 * half) + 0.5) * size;
    const py = (v: number): number => (0.5 - (v - midV) / (2 * half)) * size;
    const p0 = [px(ax), py(ay)] as const;
    const p1 = [px(bx), py(by)] as const;
    const p2 = [px(cx), py(cy)] as const;

    const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
    const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));

    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    if (Math.abs(area) < 1e-9) continue;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const sx = x + 0.5;
        const sy = y + 0.5;
        // Barycentric coverage.
        const w0 = ((p1[0] - sx) * (p2[1] - sy) - (p2[0] - sx) * (p1[1] - sy)) / area;
        const w1 = ((p2[0] - sx) * (p0[1] - sy) - (p0[0] - sx) * (p2[1] - sy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        // Depth along the view direction; smaller is nearer the camera.
        const z = w0 * az + w1 * bz + w2 * cz;
        const d = y * size + x;
        if (z >= (depth[d] as number)) continue;
        depth[d] = z;
        out[d * 4] = r;
        out[d * 4 + 1] = g;
        out[d * 4 + 2] = b;
        out[d * 4 + 3] = 255;
      }
    }
  }
  return out;
}

// --- Sheet ----------------------------------------------------------------

/** Build a rig, walk it into a mid-stride pose, and hand back its triangles. */
function posedTriangles(species: CritterSpecies, coat: number): Tri[] {
  const rig = new CritterRig(species, { tuning: defaultCritterTuning(), coat });
  let x = 0;
  for (let i = 0; i < WARMUP_FRAMES; i++) {
    x += WALK_SPEED_PER_FRAME;
    rig.update(1 / 60, { x, y: 0 }, 0);
  }
  // Draw at the origin: the walk only ever moves the rig's *group*, which the
  // scene owns, so parking it back keeps every cell framed the same way.
  rig.group.position.set(0, 0, 0);
  return collectTriangles(rig.group);
}

const COAT_IDS = (process.env.COATS ?? 'rose,sage,blue,cream,plum').split(',');
const swatches = COAT_IDS.map((id) => PLAYER_COATS.find((c) => c.id === id)).filter(
  (c): c is CoatSwatch => c !== undefined,
);

const cellW = BIG + GAP;
const rowH = BIG + GAP;
const sheetW = swatches.length * cellW + SMALL * SMALL_SCALE + GAP;
const sheetH = CRITTER_IDS.length * rowH;
const img = new PNG({ width: sheetW, height: sheetH, colorType: 6 });
for (let i = 0; i < img.data.length; i += 4) {
  img.data[i] = SHEET_BG[0];
  img.data[i + 1] = SHEET_BG[1];
  img.data[i + 2] = SHEET_BG[2];
  img.data[i + 3] = 255;
}

function blit(rgba: Uint8ClampedArray, w: number, gx: number, gy: number, scale = 1): void {
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const X = gx + x * scale + sx;
          const Y = gy + y * scale + sy;
          if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue;
          const d = (Y * img.width + X) * 4;
          img.data[d] = rgba[s] as number;
          img.data[d + 1] = rgba[s + 1] as number;
          img.data[d + 2] = rgba[s + 2] as number;
          img.data[d + 3] = 255;
        }
      }
    }
  }
}

CRITTER_IDS.forEach((id, row) => {
  const species = CRITTERS[id];
  swatches.forEach((swatch, col) => {
    blit(render(posedTriangles(species, swatch.hex), BIG), BIG, col * cellW, row * rowH);
  });
  // The rightmost cell is the same rig at the size it actually ships at.
  const small = posedTriangles(species, species.defaultCoat);
  blit(render(small, SMALL), SMALL, swatches.length * cellW, row * rowH, SMALL_SCALE);
  process.stdout.write(`${species.name}: ${species.parts.length} declared parts, ${small.length} triangles\n`);
});

mkdirSync('.claude/screenshots', { recursive: true });
const path = '.claude/screenshots/critters.png';
writeFileSync(path, PNG.sync.write(img));
process.stdout.write(`wrote ${path} (${sheetW}x${sheetH})\n`);
