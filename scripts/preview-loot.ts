// Dev-only: photograph the reveal (spec 158) as a contact sheet, so "what is
// the reveal actually doing" is a picture rather than a paragraph.
// Not part of the app. `tsx scripts/preview-loot.ts`
//
// One row per rarity tier, one column per sampled tick, every cell drawn
// through the **real** `DropPresenter` and the **real** `DropRig`. So what is
// on screen is the chain the game runs -- the rarity table, the reveal clock,
// the flare curve, the heartbeat and the colour blend -- and not a second model
// of it that could agree with nothing.
//
// Three things it is here to make obvious, all of which a paragraph failed to:
//
//   * **The throw.** The origin is drawn as a cross and the landing as a ring,
//     and the object travels from one to the other across the first columns. A
//     drop that appeared at its landing spot would sit on the ring in column 0.
//   * **The withheld colour.** Every tier is the same grey until its reveal
//     column. If a row is coloured before then, the reveal has stopped being a
//     reveal -- which is exactly the bug this spec was corrected for.
//   * **The contrast.** The common row never brightens and never beats. If it
//     starts competing with the rows under it, the ladder is broken.
//
// Rasterised in software rather than photographed in a browser, for the reason
// `preview-monsters.ts` gives: this environment paints a real page at a few
// frames a second, and what is being looked at here is a *sequence*.
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import { RARITY_IDS, type RarityId } from '../src/server/data/items.js';
import { rarityRow } from '../src/server/data/loot.js';
import { anticipationTickFor, revealPhaseAt } from '../src/server/sim/loot.js';
import type { DropView } from '../src/server/client/game-client.js';
import { DropRig } from '../src/render/iso3d/drop-rig.js';
import { DropPresenter, popAt, POP_TICKS } from '../src/render/iso3d/world/loot-drop.js';
import { glyphRects } from '../src/render/iso3d/world/pixel-font.js';

const CELL = 190;
const GAP = 4;
const LABEL_H = 12;
const BG: readonly [number, number, number] = [86, 118, 62]; // the arena's grass
const SHEET_BG: readonly [number, number, number] = [26, 27, 32];
const INK: readonly [number, number, number] = [232, 236, 242];

/** The scene's isometric view direction, and a light roughly where its sun is. */
const VIEW_DIR = new THREE.Vector3(-1, -0.82, -1).normalize();
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.38).normalize();
const AMBIENT = 0.62;
/** Half the world-space window every cell shares, so the travel is comparable. */
const HALF_EXTENT = 46;

/** Where the body fell, and where the seeded scatter put the item. */
const ORIGIN = { x: -18, y: 0, z: 0 };
const LANDING = { x: 14, y: 8, z: 0 };

/**
 * The ticks every row is sampled at.
 *
 * Absolute rather than per-tier, so the columns line up and the *difference*
 * between the tiers is what the eye lands on: the first three columns are the
 * half-second of quiet and are identical in every row, the rare row resolves at
 * t66, and the exceptional row is still withholding two columns after that.
 */
const TICKS = [0, 15, 30, 48, 66, 84, 114, 138, 200];

interface Tri {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly c: THREE.Vector3;
  readonly color: THREE.Color;
  /** 1 for an opaque surface, less for anything the material fades. */
  readonly alpha: number;
  /** True for a surface that *adds* light rather than covering what is behind. */
  readonly additive: boolean;
}

/** Every triangle under `root`, in world space, with what it is made of. */
function collectTriangles(root: THREE.Object3D): Tri[] {
  const tris: Tri[] = [];
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || mesh.visible === false) return;
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
      | (THREE.Material & { color?: THREE.Color; opacity: number; transparent: boolean })
      | undefined;
    if (!material?.color) return;
    const alpha = material.transparent ? material.opacity : 1;
    // Faded out entirely. Skipped rather than drawn at zero, because "how
    // transparent" and "is it transparent at all" are two questions and
    // conflating them is what made a fully popped drop rasterise as a solid
    // blue sphere -- the preview lying about the one frame it existed to show.
    if (alpha <= 0.002) return;
    const additive = material.blending === THREE.AdditiveBlending;
    const pos = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const corners = [0, 1, 2].map((k) => {
        const vi = index ? index.getX(i + k) : i + k;
        return new THREE.Vector3(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(mesh.matrixWorld);
      });
      tris.push({
        a: corners[0] as THREE.Vector3,
        b: corners[1] as THREE.Vector3,
        c: corners[2] as THREE.Vector3,
        color: material.color,
        alpha,
        additive,
      });
    }
  });
  return tris;
}

/** A flat marker on the ground: a ring, or a cross when `arms` is set. */
function groundMark(at: { x: number; y: number }, radius: number, hex: number, arms = false): Tri[] {
  const color = new THREE.Color(hex);
  const tris: Tri[] = [];
  const p = (dx: number, dz: number): THREE.Vector3 =>
    new THREE.Vector3(at.x + dx, 0.35, at.y + dz);
  if (arms) {
    const t = radius * 0.18;
    for (const [ax, az] of [
      [radius, t],
      [t, radius],
    ] as const) {
      tris.push(
        { a: p(-ax, -az), b: p(ax, -az), c: p(ax, az), color, alpha: 1, additive: false },
        { a: p(-ax, -az), b: p(ax, az), c: p(-ax, az), color, alpha: 1, additive: false },
      );
    }
    return tris;
  }
  const segments = 40;
  const inner = radius - 1.1;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const ring = (angle: number, r: number): THREE.Vector3 =>
      p(Math.cos(angle) * r, Math.sin(angle) * r);
    // Wound so the normal points up -- the rasteriser culls back faces exactly
    // as the renderer does, and a ring wound the other way is drawn and culled.
    tris.push(
      { a: ring(a0, inner), b: ring(a1, radius), c: ring(a0, radius), color, alpha: 1, additive: false },
      { a: ring(a0, inner), b: ring(a1, inner), c: ring(a1, radius), color, alpha: 1, additive: false },
    );
  }
  return tris;
}

/** Linear-sRGB to sRGB, the transfer WebGL applies on the way to the screen. */
function encode(linear: number): number {
  const c = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

/**
 * Orthographic, z-buffered, flat-shaded, back-face culled -- and additive for
 * anything transparent.
 *
 * The additive pass is what makes the picture worth taking at all: the halo is
 * the thing that swells, and drawing it opaque would replace the object with a
 * grey sphere at exactly the moment the reveal is doing something.
 */
function render(tris: readonly Tri[], size: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = BG[0];
    out[i * 4 + 1] = BG[1];
    out[i * 4 + 2] = BG[2];
    out[i * 4 + 3] = 255;
  }

  const forward = VIEW_DIR;
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const project = (p: THREE.Vector3): [number, number, number] => [
    p.dot(right),
    p.dot(up),
    p.dot(forward),
  ];
  const midV = new THREE.Vector3(0, 14, 0).dot(up);
  const depth = new Float64Array(size * size).fill(Infinity);
  const normal = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();

  // Solids first so the blended passes have something to sit on top of, and so
  // the depth buffer is complete before anything reads it without writing.
  const blended = (t: Tri): number => (t.additive || t.alpha < 1 ? 1 : 0);
  const ordered = [...tris].sort((a, b) => blended(a) - blended(b));

  for (const t of ordered) {
    const [ax, ay, az] = project(t.a);
    const [bx, by, bz] = project(t.b);
    const [cx, cy, cz] = project(t.c);

    e1.subVectors(t.b, t.a);
    e2.subVectors(t.c, t.a);
    normal.crossVectors(e1, e2).normalize();
    // Glow shells are closed spheres: culling their back faces is what stops the
    // far side doubling the brightness of the near one.
    if (normal.dot(forward) > 0) continue;
    const lambert = t.additive ? 1 : AMBIENT + (1 - AMBIENT) * Math.max(0, normal.dot(LIGHT));
    const rgb = [t.color.r * lambert, t.color.g * lambert, t.color.b * lambert] as const;

    const px = (u: number): number => (u / (2 * HALF_EXTENT) + 0.5) * size;
    const py = (v: number): number => (0.5 - (v - midV) / (2 * HALF_EXTENT)) * size;
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
        const cxp = x + 0.5;
        const cyp = y + 0.5;
        const w0 = ((p1[0] - p0[0]) * (cyp - p0[1]) - (cxp - p0[0]) * (p1[1] - p0[1])) / area;
        const w1 = ((cxp - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (cyp - p0[1])) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w2 * az + w1 * bz + w0 * cz;
        const i = y * size + x;
        if (t.additive) {
          // Depth-*tested* without writing: a glow behind the object does not
          // paint over it, and two shells do not stack.
          if (z > (depth[i] ?? Infinity)) continue;
          for (let k = 0; k < 3; k++) {
            const was = out[i * 4 + k] ?? 0;
            out[i * 4 + k] = Math.min(255, was + encode((rgb[k] ?? 0) * t.alpha));
          }
          continue;
        }
        if (t.alpha < 1) {
          // A fading solid: lit like one, then mixed over whatever is behind it
          // rather than added to it. Depth-tested and not written, so the faces
          // behind it in the same mesh do not punch through.
          if (z > (depth[i] ?? Infinity)) continue;
          for (let k = 0; k < 3; k++) {
            const was = out[i * 4 + k] ?? 0;
            out[i * 4 + k] = was + (encode(rgb[k] ?? 0) - was) * t.alpha;
          }
          continue;
        }
        if (z >= (depth[i] ?? Infinity)) continue;
        depth[i] = z;
        out[i * 4] = encode(rgb[0]);
        out[i * 4 + 1] = encode(rgb[1]);
        out[i * 4 + 2] = encode(rgb[2]);
      }
    }
  }
  return out;
}

/** A drop exactly as the client builds one off the wire. */
function viewOf(rarity: RarityId): DropView {
  const row = rarityRow(rarity);
  const revealTick = row.revealTicks;
  const known = row.revealTicks === 0;
  return {
    entityId: 1,
    rarity,
    spawnTick: 0,
    anticipationTick: anticipationTickFor(rarity, 0, revealTick),
    revealTick,
    origin: ORIGIN,
    phase: revealPhaseAt({ anticipationTick: 0, revealTick }, 0),
    defId: known ? 'potion.minor' : null,
    name: known ? 'Minor Salve' : null,
    count: known ? 1 : 0,
  };
}

function stamp(png: PNG, text: string, atX: number, atY: number, scale = 1): void {
  for (const rect of glyphRects(text.toUpperCase())) {
    for (let dy = 0; dy < rect.h * scale; dy++) {
      for (let dx = 0; dx < rect.w * scale; dx++) {
        const x = atX + rect.x * scale + dx;
        const y = atY + rect.y * scale + dy;
        if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
        const i = (y * png.width + x) * 4;
        png.data[i] = INK[0];
        png.data[i + 1] = INK[1];
        png.data[i + 2] = INK[2];
        png.data[i + 3] = 255;
      }
    }
  }
}

/**
 * The pop, on its own sheet.
 *
 * Its own image rather than a fourth row on the one above, because the axis is
 * different: that sheet's columns are ticks since the drop landed and these are
 * ticks since it was taken. Sharing the header would have labelled six cells
 * with numbers that mean something else.
 */
function popSheet(): void {
  const cols = 7;
  const width = GAP + cols * (CELL + GAP);
  const height = GAP + LABEL_H * 2 + CELL + GAP;
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = SHEET_BG[0];
    png.data[i * 4 + 1] = SHEET_BG[1];
    png.data[i * 4 + 2] = SHEET_BG[2];
    png.data[i * 4 + 3] = 255;
  }
  stamp(png, 'picked up - it grows and goes and never shrinks', GAP + 2, GAP, 1);

  for (let c = 0; c < cols; c++) {
    const through = c / (cols - 1);
    const tick = Math.round(through * POP_TICKS);
    stamp(png, `T+${tick}`, GAP + c * (CELL + GAP) + 4, GAP + LABEL_H, 1);

    const rig = new DropRig('rare');
    // Revealed and at rest, which is what a drop being taken looks like.
    rig.setTierMix(1);
    rig.setPop(popAt(through));
    rig.update(0, rarityRow('rare').restFlare, 1);
    rig.group.position.set(LANDING.x, LANDING.z, LANDING.y);
    const pixels = render([...groundMark(LANDING, 7, 0x1e1e1e), ...collectTriangles(rig.group)], CELL);
    rig.dispose();

    const left = GAP + c * (CELL + GAP);
    const top = GAP + LABEL_H * 2;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const src = (y * CELL + x) * 4;
        const dst = ((top + y) * width + left + x) * 4;
        png.data[dst] = pixels[src] ?? 0;
        png.data[dst + 1] = pixels[src + 1] ?? 0;
        png.data[dst + 2] = pixels[src + 2] ?? 0;
        png.data[dst + 3] = 255;
      }
    }
  }

  const out = '.claude/screenshots/loot-pickup.png';
  writeFileSync(out, PNG.sync.write(png));
  console.log(`wrote ${out} (${width}x${height})`);
}

function main(): void {
  const rows = RARITY_IDS.length;
  const cols = TICKS.length;
  const width = GAP + cols * (CELL + GAP);
  const height = GAP + LABEL_H + rows * (CELL + GAP + LABEL_H);
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = SHEET_BG[0];
    png.data[i * 4 + 1] = SHEET_BG[1];
    png.data[i * 4 + 2] = SHEET_BG[2];
    png.data[i * 4 + 3] = 255;
  }

  for (let c = 0; c < cols; c++) {
    stamp(png, `T${TICKS[c]}`, GAP + c * (CELL + GAP) + 4, GAP, 1);
  }

  RARITY_IDS.forEach((rarity, r) => {
    const drop = viewOf(rarity);
    const row = rarityRow(rarity);
    const top = GAP + LABEL_H + r * (CELL + GAP + LABEL_H);
    stamp(png, `${rarity} reveal at ${row.revealTicks}`, GAP + 2, top, 1);

    TICKS.forEach((tick, c) => {
      // A fresh rig and a fresh presenter per cell: each is a photograph of the
      // state at that tick rather than of a rig that has been through the
      // others, so a cell cannot inherit anything from the one beside it.
      const rig = new DropRig(rarity);
      const presenter = new DropPresenter();
      const shown = presenter.read(drop, LANDING, tick);
      rig.setTierMix(shown.tierMix);
      // `dt` of zero: the idle spin and bob are frame-rate toys and would make
      // the sheet different every run. The beat is an argument, so it survives.
      rig.update(0, shown.flare, shown.beat);
      rig.group.position.set(shown.position.x, shown.position.z, shown.position.y);

      const tris = [
        ...groundMark(ORIGIN, 5, 0x2a2a2a, true),
        ...groundMark(LANDING, 7, 0x1e1e1e),
        ...collectTriangles(rig.group),
      ];
      const pixels = render(tris, CELL);
      rig.dispose();

      const left = GAP + c * (CELL + GAP);
      const cellTop = top + LABEL_H;
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          const src = (y * CELL + x) * 4;
          const dst = ((cellTop + y) * width + left + x) * 4;
          png.data[dst] = pixels[src] ?? 0;
          png.data[dst + 1] = pixels[src + 1] ?? 0;
          png.data[dst + 2] = pixels[src + 2] ?? 0;
          png.data[dst + 3] = 255;
        }
      }
    });
  });

  mkdirSync('.claude/screenshots', { recursive: true });
  const out = '.claude/screenshots/loot-reveal.png';
  writeFileSync(out, PNG.sync.write(png));
  console.log(`wrote ${out} (${width}x${height})`);
  popSheet();

  // The numbers behind the picture, so a change that is too subtle to see is
  // still reviewable as a diff.
  for (const rarity of RARITY_IDS) {
    const drop = viewOf(rarity);
    const presenter = new DropPresenter();
    const line = TICKS.map((tick) => {
      const shown = presenter.read(drop, LANDING, tick);
      return `t${tick}: flare ${shown.flare.toFixed(2)} mix ${shown.tierMix.toFixed(2)} beat ${shown.beat.toFixed(3)}`;
    });
    console.log(`\n${rarity}\n  ${line.join('\n  ')}`);
  }
}

main();
