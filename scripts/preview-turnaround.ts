/**
 * Draw the reversal, frame by frame (spec 139).
 *
 *   npx tsx scripts/preview-turnaround.ts [unitDir]
 *
 * `probe-turn-swing.ts` beside this measures how far a pivot throws a body's
 * extremities. This is the picture of the same thing, because a number cannot
 * answer the only question worth asking about a turn -- whether it reads as a
 * manoeuvre or as a glitch -- and the swing is a shape, not a quantity.
 *
 * Rendered headlessly rather than photographed in a browser, and that is a
 * measurement rather than a preference. This software renderer paints the real
 * page at about a frame a second, so a screencast of a 333ms turn returns one
 * frame: the first version of this script drove the real Play tab, held W,
 * reversed, and captured the entire turn between two paints. Every caption it
 * produced said "the turn is over".
 *
 * So the turn is *stepped* instead of raced. Each cell is one 60Hz tick of the
 * real turn rule -- `turnToward`, at the rate `computeEffectiveStats` derives for
 * a fresh character -- applied to the real skinned pig in its real run pose,
 * yawed the way `scene.ts` yaws a body: `rotation.y = -facing` on a group whose
 * origin is where the server put it. Nothing here is a model of the game's turn;
 * it is the game's turn, drawn.
 *
 * Since spec 140 it draws two turns rather than one: the raw rule and the eased
 * drawn yaw, at the same timestamps. The strip is what the ease *is* -- the same
 * headings, reached on a different schedule -- and `turnaround-rate.png` beside it
 * is the point of the spec, because the complaint was never about a heading. It is
 * a plot of angular rate against time, where the raw rule is a rectangle and the
 * eased one is a trapezoid, and the whip-crack is the rectangle's left edge.
 *
 * Two rules make the pictures worth looking at:
 *
 *  - **The window is fixed in world space**, not framed to the subject. Framing
 *    each cell on its own extent is the obvious thing and it would hide the
 *    entire subject of the spec, which is that the body *moves* while turning.
 *  - **The collider is drawn.** A 16-unit circle on the ground, which is the
 *    footprint the server is actually resolving, and the pivot at its centre.
 *    "The snout is 28 units out" is a sentence; a snout well outside its own
 *    footprint is a picture.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { PNG } from 'pngjs';

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
const { turnToward } = await import('../src/server/sim/movement.js');
const { easeTurn, restingAt, turnAcceleration, lagBound } = await import(
  '../src/render/iso3d/turn-ease.js'
);
const { CHARACTERS } = await import('../src/sim/characters.js');
const { TURN_RATE_PER_AGILITY } = await import('../src/sim/constants.js');
const { REVERSAL_DEGREES, turnSeconds } = await import('../src/render/iso3d/turn-swing.js');
const { GLYPH_HEIGHT, glyphRects, textWidth } = await import(
  '../src/render/iso3d/world/pixel-font.js'
);

const PORT = 4403;
const DEFAULT_DIR = 'assets/units/pig_a_pose_full';
const outDir = join('.claude', 'screenshots');

const TICK_RATE = 60;
/** The dexterity a fresh character has, so the rate drawn is the one played. */
const FRESH_DEXTERITY = 5;
/** The clip the reversal is worst in, and the one a moving player is always in. */
const POSE = 'run';
/** The collider the server resolves the player's footprint against. */
const PLAYER_RADIUS = 16;

const CELL = 240;
const CELLS = 6;
const GAP = 6;
/**
 * Half the world-space window each cell shows, in units.
 *
 * Fixed, and wide enough for the whole swing: the pig stands 56 units tall and
 * its run pose reaches 28 from the pivot, so 46 frames the body and its arc with
 * a little air rather than cropping the snout at the moment it matters.
 */
const HALF_EXTENT = 46;

const BG: readonly [number, number, number] = [30, 31, 36];
const CELL_BG: readonly [number, number, number] = [58, 60, 68];
const COLLIDER: readonly [number, number, number] = [232, 186, 88];
const PIVOT: readonly [number, number, number] = [244, 244, 250];
const LABEL: readonly [number, number, number] = [232, 186, 88];
/**
 * How large a font pixel is drawn in the strip's caption.
 *
 * The HUD's glyph table has digits and nothing else (spec 065), which is all a
 * caption needs here: each cell is labelled with its offset in milliseconds, and
 * the units are in this file's header rather than in a font that cannot spell
 * them.
 */
const LABEL_SCALE = 2;

/** The scene's isometric view direction, and a light roughly where its sun is. */
const VIEW_DIR = new THREE.Vector3(-1, -0.82, -1).normalize();
const LIGHT = new THREE.Vector3(0.45, 0.8, 0.38).normalize();
const AMBIENT = 0.6;

interface Tri {
  readonly a: InstanceType<typeof THREE.Vector3>;
  readonly b: InstanceType<typeof THREE.Vector3>;
  readonly c: InstanceType<typeof THREE.Vector3>;
  readonly color: InstanceType<typeof THREE.Color>;
}

const forward = VIEW_DIR;
const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
const up = new THREE.Vector3().crossVectors(right, forward).normalize();

/** World space to the cell's pixel grid, through the fixed isometric window. */
function toPixels(point: InstanceType<typeof THREE.Vector3>): [number, number, number] {
  const u = point.dot(right);
  const v = point.dot(up);
  return [
    ((u / (2 * HALF_EXTENT)) + 0.5) * CELL,
    // The body stands on y=0 and grows upward, so the window is raised to hold
    // it rather than centred on the ground it stands on.
    (0.62 - (v - HALF_EXTENT * 0.28) / (2 * HALF_EXTENT)) * CELL,
    point.dot(forward),
  ];
}

function encode(linear: number): number {
  const c = Math.max(0, Math.min(1, linear));
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
}

async function main(): Promise<void> {
  const dir = process.argv[2] ?? DEFAULT_DIR;
  const named = `${dir.split('/').pop()}.unitdef.json`;
  if (!existsSync(join(dir, named))) throw new Error(`no ${named} in ${dir}`);
  const unitDoc = JSON.parse(readFileSync(join(dir, named), 'utf8')) as {
    meshRef: string;
    clipLibRef: string;
    import: { scale: number };
  };
  const clipDoc = JSON.parse(readFileSync(join(dir, unitDoc.clipLibRef), 'utf8')) as {
    clips: readonly { id: string; source: string }[];
  };

  const character = CHARACTERS[0];
  if (!character) throw new Error('no character archetypes to draw');
  const turnRate = character.turnRate + TURN_RATE_PER_AGILITY * FRESH_DEXTERITY;
  const reversalTicks = Math.ceil(turnSeconds(REVERSAL_DEGREES, turnRate) * TICK_RATE);

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
    if (!clipDoc.clips.some((clip) => clip.id === POSE)) {
      throw new Error(`this unit has no "${POSE}" clip, so there is no worst case to draw`);
    }

    // The scene yaws a *group* whose origin is the server's position, and the
    // unit hangs inside it. Reproduced rather than approximated, because the
    // whole question is what that pivot does to the body.
    const body = new THREE.Group();
    body.add(rig.object);

    console.log(
      `  ${character.name} at ${turnRate} deg/s: a ${REVERSAL_DEGREES}-degree reversal is ` +
        `${reversalTicks} ticks (${(turnSeconds(REVERSAL_DEGREES, turnRate) * 1000).toFixed(0)}ms), ` +
        `drawn every ${Math.max(1, Math.round(reversalTicks / (CELLS - 1)))} ticks`,
    );

    // Every tick of the real turn, stepped by the rule the sim steps it with,
    // and the eased drawn yaw stepped beside it off exactly that heading -- which
    // is what `scene.ts` hands the follower. Collected first so the strip, the
    // overlay and the rate plot all draw the same turn.
    const limits = { degreesPerSecond: turnRate, tickRate: TICK_RATE };
    const series: { tick: number; raw: number; eased: number; rawRate: number; easedRate: number }[] = [];
    {
      let raw = 0;
      let state = restingAt(0);
      // Past the reversal, because the whole subject is how the drawn body
      // *leaves* the turn: the raw rule is done at `reversalTicks` and the ease
      // is still arriving for a ramp after it.
      const rampTicks = Math.ceil(((turnRate * Math.PI) / 180 / turnAcceleration(limits)) * TICK_RATE);
      for (let tick = 0; tick <= reversalTicks + rampTicks + 2; tick += 1) {
        const before = raw;
        if (tick > 0) raw = turnToward(raw, Math.PI, turnRate, TICK_RATE);
        if (tick > 0) state = easeTurn(state, raw, limits, 1 / TICK_RATE);
        series.push({
          tick,
          raw,
          eased: state.facing,
          rawRate: Math.abs(raw - before) * TICK_RATE,
          easedRate: Math.abs(state.rate),
        });
      }
    }

    const poses: {
      readonly tick: number;
      readonly facing: number;
      readonly eased: number;
      readonly tris: Tri[];
      readonly easedTris: Tri[];
    }[] = [];
    let facing = 0;
    const wanted = Math.PI;
    for (let tick = 0; tick <= reversalTicks; tick += 1) {
      if (tick > 0) facing = turnToward(facing, wanted, turnRate, TICK_RATE);
      const step = Math.max(1, Math.round(reversalTicks / (CELLS - 1)));
      if (tick % step !== 0 && tick !== reversalTicks) continue;

      // The stride advances with the turn: a body frozen mid-pose while its
      // heading changes is a picture of a mannequin on a turntable, and the
      // reach being measured belongs to a gait in motion.
      rig.applyPoses([
        { clipId: POSE, normalizedTime: (tick / reversalTicks) * 0.5, weight: 1 },
      ]);
      body.rotation.y = -facing;
      body.updateMatrixWorld(true);
      const tris = collectTriangles(body);

      // The same pose and the same instant, yawed by what would actually have
      // been drawn.
      const eased = series[tick]?.eased ?? facing;
      body.rotation.y = -eased;
      body.updateMatrixWorld(true);
      poses.push({ tick, facing, eased, tris, easedTris: collectTriangles(body) });
    }

    // --- the strip ---------------------------------------------------------
    const cells = poses.slice(0, CELLS);
    const stripWidth = cells.length * CELL + (cells.length + 1) * GAP;
    const labelHeight = GLYPH_HEIGHT * LABEL_SCALE + GAP;
    // Two rows at the same timestamps: the rule above, what is drawn below. The
    // milliseconds are captioned once, between them, because they are shared --
    // that is the whole comparison.
    const stripHeight = 2 * CELL + labelHeight + 3 * GAP;
    const strip = sheet(stripWidth, stripHeight);
    cells.forEach((pose, index) => {
      const atX = GAP + index * (CELL + GAP);
      blit(strip, stripWidth, render(pose.tris, 1), atX, GAP);
      blit(strip, stripWidth, render(pose.easedTris, 1), atX, CELL + labelHeight + 2 * GAP);
      const caption = String(Math.round((pose.tick / TICK_RATE) * 1000));
      label(
        strip,
        stripWidth,
        caption,
        atX + Math.round((CELL - textWidth(caption) * LABEL_SCALE) / 2),
        CELL + 2 * GAP,
      );
      console.log(
        `  cell ${index}: tick ${String(pose.tick).padStart(2)} ` +
          `(${((pose.tick / TICK_RATE) * 1000).toFixed(0).padStart(3)}ms), ` +
          `${((pose.facing * 180) / Math.PI).toFixed(0).padStart(3)} degrees round, ` +
          `drawn at ${((pose.eased * 180) / Math.PI).toFixed(0).padStart(3)}`,
      );
    });
    write('turnaround-strip.png', strip, stripWidth, stripHeight);

    // --- the rate plot -----------------------------------------------------
    //
    // The picture of spec 140. Everything else here draws a heading, and a
    // heading is not what was wrong.
    const peakRaw = Math.max(...series.map((point) => point.rawRate));
    const peakEased = Math.max(...series.map((point) => point.easedRate));
    write(
      'turnaround-rate.png',
      ...plotRates(series, (turnRate * Math.PI) / 180),
    );
    console.log(
      `  peak rate: ${((peakRaw * 180) / Math.PI).toFixed(0)} deg/s raw, ` +
        `${((peakEased * 180) / Math.PI).toFixed(0)} eased ` +
        `(cap ${turnRate}); trails by at most ` +
        `${(
          (Math.max(...series.map((p) => Math.abs(p.raw - p.eased))) * 180) /
          Math.PI
        ).toFixed(1)} deg, bound ${((lagBound(limits) * 180) / Math.PI).toFixed(1)}`,
    );
    for (const degrees of [10, 20, 45, 90, 180]) {
      // What the ease does to a turn of each size, which is the claim that the
      // small turns are the ones it changes most.
      let raw = 0;
      let state = restingAt(0);
      let peak = 0;
      const to = (degrees * Math.PI) / 180;
      for (let tick = 0; tick < 400; tick += 1) {
        raw = turnToward(raw, to, turnRate, TICK_RATE);
        state = easeTurn(state, raw, limits, 1 / TICK_RATE);
        peak = Math.max(peak, Math.abs(state.rate));
      }
      console.log(
        `  a ${String(degrees).padStart(3)}-degree turn peaks at ` +
          `${((peak * 180) / Math.PI).toFixed(0).padStart(3)} deg/s ` +
          `(${((peak / ((turnRate * Math.PI) / 180)) * 100).toFixed(0)}% of the rate)`,
      );
    }

    // --- the envelope ------------------------------------------------------
    //
    // Every heading in one cell, dimmest first, so what the turn sweeps is a
    // single shape rather than something to be held in mind across six frames.
    const envelope = render(
      poses.flatMap((pose, index) =>
        pose.tris.map((tri) => ({
          ...tri,
          color: tri.color.clone().multiplyScalar(0.25 + 0.75 * (index / (poses.length - 1))),
        })),
      ),
      1,
    );
    write('turnaround-envelope.png', envelope, CELL, CELL);
  } finally {
    server.close();
  }

  console.log(`  wrote turnaround-strip.png and turnaround-envelope.png to ${outDir}`);
}

/**
 * Every skinned triangle of a posed body, in world space.
 *
 * Skinned on the CPU with the same linear blend the GPU does, because a snout is
 * geometry and no bone sits in it -- and because the whole point of the picture
 * is where the *surface* goes.
 */
/** The raw rule's colour in the rate plot, and the eased one's. */
const RAW_LINE: readonly [number, number, number] = [214, 96, 92];
const EASED_LINE: readonly [number, number, number] = [122, 196, 148];
const AXIS: readonly [number, number, number] = [96, 99, 110];

const PLOT_HEIGHT = 260;
const PLOT_PAD = 28;

/**
 * Angular rate against time, for both turns.
 *
 * Drawn as filled columns rather than as a line, because a line one pixel wide
 * through a step function is mostly vertical and reads as two disconnected
 * horizontals. Filled from the axis, the raw rule is a rectangle and the ease is
 * a trapezoid, which is exactly the difference the spec is about.
 *
 * The eased curve is drawn second and over the top: where they coincide -- the
 * flat middle of a long turn, which the ease deliberately does not touch -- the
 * green is what shows, and the red visible on either side of it is the whole
 * change.
 */
function plotRates(
  series: readonly { rawRate: number; easedRate: number }[],
  cap: number,
): [Uint8ClampedArray, number, number] {
  const width = series.length * 8 + 2 * PLOT_PAD;
  const height = PLOT_HEIGHT;
  const out = sheet(width, height);
  const floor = height - PLOT_PAD;
  const ceiling = PLOT_PAD;
  const top = cap * 1.12;

  const put = (x: number, y: number, colour: readonly [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = (y * width + x) * 4;
    out[at] = colour[0];
    out[at + 1] = colour[1];
    out[at + 2] = colour[2];
    out[at + 3] = 255;
  };

  // The axis, and the cap the sim itself imposes -- the line the ease may
  // approach and never cross.
  for (let x = PLOT_PAD - 4; x < width - PLOT_PAD + 4; x += 1) {
    put(x, floor, AXIS);
    if (x % 6 < 3) put(x, Math.round(floor - (cap / top) * (floor - ceiling)), AXIS);
  }

  const column = (index: number, rate: number, colour: readonly [number, number, number]): void => {
    const x0 = PLOT_PAD + index * 8;
    const y = Math.round(floor - (rate / top) * (floor - ceiling));
    for (let x = x0; x < x0 + 7; x += 1) {
      for (let py = Math.min(y, floor - 1); py < floor; py += 1) put(x, py, colour);
    }
  };

  series.forEach((point, index) => column(index, point.rawRate, RAW_LINE));
  series.forEach((point, index) => column(index, point.easedRate, EASED_LINE));

  // Milliseconds along the bottom, every 100, in the only glyphs there are.
  for (let tick = 0; tick < series.length; tick += 6) {
    const caption = String(Math.round((tick / TICK_RATE) * 1000));
    label(
      out,
      width,
      caption,
      PLOT_PAD + tick * 8 - Math.round((textWidth(caption) * LABEL_SCALE) / 2),
      floor + 6,
    );
  }
  // And the cap, at the line it belongs to.
  label(out, width, String(Math.round((cap * 180) / Math.PI)), 2, Math.round(floor - (cap / top) * (floor - ceiling)) - 4);
  return [out, width, height];
}

function collectTriangles(root: InstanceType<typeof THREE.Object3D>): Tri[] {
  const tris: Tri[] = [];
  root.traverse((node) => {
    if (!(node as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;
    const skin = node as InstanceType<typeof THREE.SkinnedMesh>;
    const geometry = skin.geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const material = skin.material;
    const color =
      material !== null && !Array.isArray(material) && 'color' in material
        ? ((material as { color: InstanceType<typeof THREE.Color> }).color).clone()
        : new THREE.Color(0.8, 0.8, 0.82);

    const world: InstanceType<typeof THREE.Vector3>[] = [];
    for (let i = 0; i < position.count; i += 1) {
      const vertex = new THREE.Vector3().fromBufferAttribute(position, i);
      skin.applyBoneTransform(i, vertex);
      skin.localToWorld(vertex);
      world.push(vertex);
    }

    const count = index ? index.count : position.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const a = world[index ? index.getX(i) : i];
      const b = world[index ? index.getX(i + 1) : i + 1];
      const c = world[index ? index.getX(i + 2) : i + 2];
      if (a && b && c) tris.push({ a, b, c, color });
    }
  });
  return tris;
}

/** A flat-shaded, z-buffered cell, with the collider and the pivot drawn on it. */
function render(tris: readonly Tri[], scale: number): Uint8ClampedArray {
  const size = CELL * scale;
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    out[i * 4] = CELL_BG[0];
    out[i * 4 + 1] = CELL_BG[1];
    out[i * 4 + 2] = CELL_BG[2];
    out[i * 4 + 3] = 255;
  }

  const depth = new Float64Array(size * size).fill(Infinity);
  const normal = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();

  // The footprint first, under the body: it is a reference on the ground and a
  // body standing in it should occlude it.
  drawCollider(out, size, depth);

  for (const tri of tris) {
    const [ax, ay, az] = toPixels(tri.a);
    const [bx, by, bz] = toPixels(tri.b);
    const [cx, cy, cz] = toPixels(tri.c);

    e1.subVectors(tri.b, tri.a);
    e2.subVectors(tri.c, tri.a);
    normal.crossVectors(e1, e2).normalize();
    // Back faces culled exactly as `FrontSide` does, so inside-out geometry
    // looks wrong here in the same way it looks wrong in the game.
    if (normal.dot(forward) > 0) continue;
    const lambert = AMBIENT + (1 - AMBIENT) * Math.max(0, normal.dot(LIGHT));
    const r = encode(tri.color.r * lambert);
    const g = encode(tri.color.g * lambert);
    const b = encode(tri.color.b * lambert);

    const p0 = [ax * scale, ay * scale] as const;
    const p1 = [bx * scale, by * scale] as const;
    const p2 = [cx * scale, cy * scale] as const;
    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    if (Math.abs(area) < 1e-9) continue;

    const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
    const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const sx = x + 0.5;
        const sy = y + 0.5;
        const w0 = ((p1[0] - sx) * (p2[1] - sy) - (p2[0] - sx) * (p1[1] - sy)) / area;
        const w1 = ((p2[0] - sx) * (p0[1] - sy) - (p0[0] - sx) * (p2[1] - sy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * az + w1 * bz + w2 * cz;
        const at = y * size + x;
        if (z >= (depth[at] as number)) continue;
        depth[at] = z;
        out[at * 4] = r;
        out[at * 4 + 1] = g;
        out[at * 4 + 2] = b;
      }
    }
  }
  return out;
}

/**
 * The player's footprint on the ground, and the pivot at its centre.
 *
 * Written into the depth buffer at its true depth rather than painted over the
 * top, so the body occludes the far half of the circle and the picture reads as
 * a body standing in a ring instead of a ring drawn on a body.
 */
function drawCollider(out: Uint8ClampedArray, size: number, depth: Float64Array): void {
  const plot = (
    point: InstanceType<typeof THREE.Vector3>,
    colour: readonly [number, number, number],
  ): void => {
    const [px, py, pz] = toPixels(point);
    const x = Math.round(px);
    const y = Math.round(py);
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const at = y * size + x;
    if (pz >= (depth[at] as number)) return;
    depth[at] = pz;
    out[at * 4] = colour[0];
    out[at * 4 + 1] = colour[1];
    out[at * 4 + 2] = colour[2];
  };

  const steps = 512;
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    plot(
      new THREE.Vector3(Math.cos(angle) * PLAYER_RADIUS, 0, Math.sin(angle) * PLAYER_RADIUS),
      COLLIDER,
    );
  }
  // A small cross on the pivot itself: the point the server owns, and the point
  // everything above rotates about.
  for (let i = -3; i <= 3; i += 1) {
    plot(new THREE.Vector3(i * 0.6, 0, 0), PIVOT);
    plot(new THREE.Vector3(0, 0, i * 0.6), PIVOT);
  }
}

function sheet(width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    out[i * 4] = BG[0];
    out[i * 4 + 1] = BG[1];
    out[i * 4 + 2] = BG[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

function blit(
  target: Uint8ClampedArray,
  targetWidth: number,
  cell: Uint8ClampedArray,
  atX: number,
  atY: number,
): void {
  for (let y = 0; y < CELL; y += 1) {
    for (let x = 0; x < CELL; x += 1) {
      const from = (y * CELL + x) * 4;
      const to = ((atY + y) * targetWidth + (atX + x)) * 4;
      target[to] = cell[from] as number;
      target[to + 1] = cell[from + 1] as number;
      target[to + 2] = cell[from + 2] as number;
      target[to + 3] = 255;
    }
  }
}

/** One caption, in the HUD's own glyphs, at `LABEL_SCALE` device pixels per font pixel. */
function label(
  target: Uint8ClampedArray,
  targetWidth: number,
  text: string,
  atX: number,
  atY: number,
): void {
  const height = target.length / 4 / targetWidth;
  for (const rect of glyphRects(text)) {
    for (let dy = 0; dy < LABEL_SCALE; dy += 1) {
      for (let dx = 0; dx < LABEL_SCALE; dx += 1) {
        const x = atX + rect.x * LABEL_SCALE + dx;
        const y = atY + rect.y * LABEL_SCALE + dy;
        if (x < 0 || y < 0 || x >= targetWidth || y >= height) continue;
        const at = (y * targetWidth + x) * 4;
        target[at] = LABEL[0];
        target[at + 1] = LABEL[1];
        target[at + 2] = LABEL[2];
        target[at + 3] = 255;
      }
    }
  }
}

function write(name: string, rgba: Uint8ClampedArray, width: number, height: number): void {
  mkdirSync(outDir, { recursive: true });
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  writeFileSync(join(outDir, name), PNG.sync.write(png));
}

await main();
