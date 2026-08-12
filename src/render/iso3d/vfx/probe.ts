/**
 * Dev-only: prove the particles are actually inside the low-resolution buffer,
 * and show what the glow approaches look like once quantized (spec 118).
 *
 * Not part of the app. Driven by `npx tsx scripts/probe-vfx.ts`, which serves
 * `src/render/vfx-probe.html` -- dev-server only, since `vite build` bundles
 * `index.html` and nothing else.
 *
 * ## Why no unit test can answer this
 *
 * The claim is about *pixels on a canvas after an upscale*. The whole risk is
 * that the particles reach the screen by some path other than the one the world
 * goes through -- rendered at native resolution and composited on top, which is
 * precisely what a headless test cannot see, because in Node there is no canvas,
 * no upscale, and no palette quantizer to be bypassed.
 *
 * So the page renders the real `RetroPass` at a real virtual resolution with a
 * real palette, and the script reads the pixels back. Two independent things
 * have to hold, and a natively-composited particle fails both:
 *
 *  - **On the palette.** With a palette set, every pixel `RetroPass` emits is a
 *    palette entry, because the final quad snaps the whole image to one. A
 *    particle drawn after that pass keeps its own colour.
 *  - **On the pixel grid.** The canvas backing store is the virtual buffer and
 *    CSS blows it up by a whole number, so every colour run is an exact multiple
 *    of the scale. A particle drawn at native resolution has edges inside the
 *    blocks.
 */

import * as THREE from 'three';
import { RetroPass } from '../retro-pass.js';
import { RETRO_DEFAULTS } from '../retro.js';
import { VfxLayer } from './layer.js';
import { compileRegistry } from './compile.js';
import { EFFECTS } from './registry.js';
import type { EffectDefinition } from './types.js';
import {
  PROBE_BACKGROUND,
  PROBE_GROUND,
  PROBE_PALETTE,
  PROBE_SCALE as SCALE,
  PROBE_VIRTUAL_H as VIRTUAL_H,
  PROBE_VIRTUAL_W as VIRTUAL_W,
} from './probe-config.js';

/** The glow approaches being compared. */
export type GlowMode = 'dither' | 'smooth' | 'layered';

/**
 * Play any effect in the shipped registry and hold it for a fixed tick count.
 *
 * The contact sheet for the library (spec 121). Same rig as the glow comparison,
 * so what it photographs is the game's own pass at the game's own resolution --
 * and the only way to see what forty authored effects actually look like without
 * fighting one of each.
 */
export function runLibraryShot(probe: { shot: (id: string, ticks: number) => ProbeReport }, id: string, ticks: number): ProbeReport {
  return probe.shot(id, ticks);
}

/**
 * The spark, with its flash rebuilt three ways.
 *
 * Same particle counts, same lifetimes, same ramp -- the *only* difference is
 * how the halo's edge falls off, which is the thing being decided.
 */
function sparkWithGlow(mode: GlowMode): readonly EffectDefinition[] {
  const source = EFFECTS.find((effect) => effect.id === 'hit_metal_spark');
  if (!source) throw new Error('hit_metal_spark missing from the registry');
  const [flash, ...rest] = source.emitters;
  if (!flash) throw new Error('hit_metal_spark has no emitters');

  if (mode === 'smooth') {
    // A smooth radial ramp: what a bloom pass produces, and what every particle
    // system reaches for by default.
    return [{ ...source, emitters: [{ ...flash, sprite: { sheet: 'glow_smooth', frames: 1, fps: 0 } }, ...rest] }];
  }
  if (mode === 'layered') {
    // The dithered halo plus a second, wider, dimmer one -- glow built out of
    // sprites rather than out of a pass.
    const wide = {
      ...flash,
      id: 'halo',
      sprite: { sheet: 'glow', frames: 1, fps: 0 },
      size: { keys: [[0, 34] as const, [1, 46] as const] },
      alpha: { keys: [[0, 0.35] as const, [1, 0] as const] },
    };
    return [{ ...source, emitters: [wide, { ...flash, sprite: { sheet: 'glow', frames: 1, fps: 0 } }, ...rest] }];
  }
  return [{ ...source, emitters: [{ ...flash, sprite: { sheet: 'glow', frames: 1, fps: 0 } }, ...rest] }];
}

export interface ProbeReport {
  readonly mode: GlowMode;
  /** Live particles the sim is holding when the frame was drawn. */
  readonly particles: number;
  /** Draw calls the whole effect took. */
  readonly drawCalls: number;
}

/** One stain's footprint on the canvas, in device pixels, for a pixel check. */
export interface StainBox {
  readonly label: string;
  readonly shadowed: boolean;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export interface BloodReport extends ProbeReport {
  /** Where each stain landed on screen, so the script measures the right pixels. */
  readonly stains: readonly StainBox[];
}

declare global {
  interface Window {
    vfxProbe?: {
      run: (mode: GlowMode) => ProbeReport;
      shot: (id: string, ticks: number, halfHeight?: number) => ProbeReport;
      blood: (ticks: number, effect?: string) => BloodReport;
      readonly reports: ProbeReport[];
    };
  }
}

class Probe {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.OrthographicCamera;
  private readonly retro = new RetroPass(VIRTUAL_W * SCALE, VIRTUAL_H * SCALE, {
    ...RETRO_DEFAULTS,
    enabled: true,
    pixelSize: 1,
  });

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    // The blood scene needs a real shadow map, and the game's kind: hard,
    // unfiltered, one comparison per pixel (spec 045). Every other mode here
    // sets `castShadow` on nothing, so this costs them nothing.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap;
    // The backing store IS the virtual buffer, and CSS does the integer upscale
    // with `image-rendering: pixelated`. Exactly what `WorldScene.resizeToVirtual`
    // does, and the reason there is no blit shader anywhere in this renderer.
    this.renderer.setSize(VIRTUAL_W, VIRTUAL_H, false);
    canvas.style.width = `${VIRTUAL_W * SCALE}px`;
    canvas.style.height = `${VIRTUAL_H * SCALE}px`;
    canvas.style.imageRendering = 'pixelated';
    this.retro.setSize(VIRTUAL_W, VIRTUAL_H);
    this.retro.setPalette(PROBE_PALETTE);

    const aspect = VIRTUAL_W / VIRTUAL_H;
    const halfHeight = 90;
    this.camera = new THREE.OrthographicCamera(-halfHeight * aspect, halfHeight * aspect, halfHeight, -halfHeight, 1, 4000);
    this.camera.position.set(0, 300, 600);
    this.camera.lookAt(0, 30, 0);
  }

  /**
   * Play one shipped effect and photograph it after `ticks`.
   *
   * The registry rather than a rebuilt one: the point is to see what the game
   * will actually draw, so a doctored copy would be worth nothing.
   */
  shot(id: string, ticks: number, halfHeight?: number): ProbeReport {
    // The game's own quantization, not the probe's six-colour palette.
    //
    // That palette exists so "is this pixel on the palette" is a sharp question
    // for the low-resolution verification. Photographing the *library* through it
    // is actively misleading: it snapped all seven damage-type flashes -- white,
    // orange, green, cyan, yellow, violet -- onto the same handful of colours, so
    // a sheet meant to show that each damage type reads differently showed seven
    // identical green dots.
    this.retro.setPalette(null);
    // Framed to the effect when asked. The default box fits a hit or a puff; an
    // aura is a hundred-odd units across and would be photographed from inside
    // itself. (`frame` restores the box afterwards, so shots stay comparable.)
    const restore = halfHeight === undefined ? undefined : this.frame(halfHeight);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PROBE_BACKGROUND);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), new THREE.MeshBasicMaterial({ color: PROBE_GROUND }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const layer = new VfxLayer({
      hooks: { ground: () => 0, attach: (_e, _s, out, at) => { out[at] = 0; out[at + 1] = 20; out[at + 2] = 0; return true; } },
      limits: { maxParticles: 2500, maxInstances: 32, pressureFloor: 0.25 },
      lights: false,
    });
    scene.add(layer.root);
    // The camera's own forward axis, so the transparency sort (spec 123) orders
    // solids for *this* view rather than for the game's isometric one.
    layer.setViewDirection(-this.camera.position.x, 30 - this.camera.position.y, -this.camera.position.z);
    layer.play(id, { x: 0, y: 24, z: 0, seed: 20260810, attach: { kind: 'entity', entityId: 1 } });
    layer.update(ticks);

    this.retro.render(this.renderer, scene, this.camera);
    const report: ProbeReport = { mode: 'dither', particles: layer.readout().particles, drawCalls: layer.readout().drawCalls };

    scene.remove(layer.root);
    layer.dispose();
    ground.geometry.dispose();
    (ground.material as THREE.Material).dispose();
    restore?.();
    return report;
  }

  /**
   * The blood scene: a lit ground, something standing on it that throws a
   * shadow, stains on both sides of the shadow's edge, and the spray in the air
   * over them (spec 139).
   *
   * Both of this spec's claims are claims about pixels and neither can be made
   * anywhere else. "A stain takes the shadow it is lying in" is a statement
   * about a fragment shader that a headless test has no way to run; and the
   * ribbon's whole point is a *shape*, which only exists once a GPU has drawn
   * one. The two share a scene deliberately -- one screenshot showing a bent
   * streak over a stain that is correctly dark is the whole spec in a picture.
   *
   * The pairs matter more than the absolute numbers: each stain in the shadow
   * has a twin outside it with the same seed and the same size, so what the
   * script compares is one splat against itself under two lights.
   */
  blood(ticks: number, effect = 'death_blood'): BloodReport {
    this.retro.setPalette(null);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PROBE_BACKGROUND);

    // Grey rather than the usual dirt: blood has to be separable from the ground
    // *by hue* for the script to measure only the stain's own pixels.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1600, 1600),
      new THREE.MeshLambertMaterial({ color: 0x6f6f78 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // The occluder. Tall and thin, standing across the sun, so its shadow is a
    // clean band with stains on both sides of one edge.
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(16, 90, 260),
      new THREE.MeshLambertMaterial({ color: 0x4a4552, flatShading: true }),
    );
    wall.position.set(30, 45, 0);
    wall.castShadow = true;
    scene.add(wall);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
    sun.position.set(260, 240, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const box = sun.shadow.camera;
    box.left = -400;
    box.right = 400;
    box.top = 400;
    box.bottom = -400;
    box.near = 1;
    box.far = 1200;
    box.updateProjectionMatrix();
    scene.add(sun, sun.target);

    const layer = new VfxLayer({
      hooks: { ground: () => 0, attach: (_e, _s, out, at) => { out[at] = 0; out[at + 1] = 20; out[at + 2] = 0; return true; } },
      limits: { maxParticles: 2500, maxInstances: 32, pressureFloor: 0.25 },
      lights: false,
    });
    scene.add(layer.root);
    layer.setViewDirection(-this.camera.position.x, 30 - this.camera.position.y, -this.camera.position.z);

    // Twinned stains: same seed and size, one each side of the shadow's edge.
    // The wall stands at x = 30 and the sun is over +X, so everything at
    // negative x is in the shade of it.
    const SIZE = 44;
    const stains: StainBox[] = [];
    const spots = [
      { label: 'near', z: -70 },
      { label: 'middle', z: 10 },
      { label: 'far', z: 90 },
    ] as const;
    spots.forEach((spot, index) => {
      for (const shadowed of [true, false]) {
        const x = shadowed ? -60 : 120;
        layer.decals.add({
          x,
          y: 0,
          z: spot.z,
          size: SIZE,
          rotation: index * 0.7,
          nx: 0,
          ny: 1,
          nz: 0,
          // The same splat on both sides: the comparison is one shape under two
          // lights, not two shapes.
          seed: 3 + index * 4,
          fluid: 'blood',
        });
        stains.push({ label: `${spot.label}-${shadowed ? 'shadow' : 'sun'}`, shadowed, ...this.project(x, 0, spot.z, SIZE) });
      }
    });

    layer.play(effect, { x: 40, y: 34, z: -140, seed: 20260810 });
    layer.update(ticks);

    this.retro.render(this.renderer, scene, this.camera);
    const readout = layer.readout();
    const report: BloodReport = { mode: 'dither', particles: readout.particles, drawCalls: readout.drawCalls, stains };

    scene.remove(layer.root);
    layer.dispose();
    ground.geometry.dispose();
    (ground.material as THREE.Material).dispose();
    wall.geometry.dispose();
    (wall.material as THREE.Material).dispose();
    return report;
  }

  /** A world point as a canvas pixel, with a radius to sample inside. */
  private project(x: number, y: number, z: number, size: number): { x: number; y: number; radius: number } {
    this.camera.updateMatrixWorld();
    const centre = new THREE.Vector3(x, y, z).project(this.camera);
    const edge = new THREE.Vector3(x + size * 0.3, y, z).project(this.camera);
    const toPixels = (ndc: THREE.Vector3): { x: number; y: number } => ({
      x: (ndc.x * 0.5 + 0.5) * VIRTUAL_W * SCALE,
      y: (1 - (ndc.y * 0.5 + 0.5)) * VIRTUAL_H * SCALE,
    });
    const middle = toPixels(centre);
    const rim = toPixels(edge);
    return { x: middle.x, y: middle.y, radius: Math.abs(rim.x - middle.x) };
  }

  /** Re-frame the orthographic box, and hand back the undo. */
  private frame(halfHeight: number): () => void {
    const previous = { top: this.camera.top, bottom: this.camera.bottom, left: this.camera.left, right: this.camera.right };
    const aspect = VIRTUAL_W / VIRTUAL_H;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.left = -halfHeight * aspect;
    this.camera.right = halfHeight * aspect;
    this.camera.updateProjectionMatrix();
    return () => {
      Object.assign(this.camera, previous);
      this.camera.updateProjectionMatrix();
    };
  }

  run(mode: GlowMode): ProbeReport {
    // Back to the tiny palette: this is the verification, and it needs it.
    this.retro.setPalette(PROBE_PALETTE);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PROBE_BACKGROUND);

    // A dull ground so there is something for the effect to be measured against.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1200, 1200),
      new THREE.MeshBasicMaterial({ color: PROBE_GROUND }),
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const layer = new VfxLayer({
      registry: compileRegistry(sparkWithGlow(mode)),
      hooks: { ground: () => 0 },
      limits: { maxParticles: 600, maxInstances: 16, pressureFloor: 0.25 },
      lights: false,
    });
    scene.add(layer.root);

    // A fixed seed and a fixed tick count: the frame being photographed is a
    // pure function of both, so two runs of this probe compare like for like.
    layer.play('hit_metal_spark', { x: 0, y: 40, z: 0, seed: 20260810 });
    layer.update(3);

    this.retro.render(this.renderer, scene, this.camera);

    // Deliberately no pixel readback here. The first version called
    // `readRenderTargetPixels(null, ...)` to read the default framebuffer, which
    // three refuses -- it wants a real render target -- so every measurement came
    // back as zeros and the probe cheerfully reported that nothing was on the
    // palette. Worse, that was a *believable* failure, because "off palette" is
    // exactly what a genuinely broken pipeline would report.
    //
    // The pixels are read from the screenshot instead, in `scripts/probe-vfx.ts`.
    // That is not a workaround, it is the better claim: the composited page is
    // what a player sees, and it is the only place the CSS upscale exists at all.
    const report: ProbeReport = { mode, particles: layer.readout().particles, drawCalls: layer.readout().drawCalls };

    scene.remove(layer.root);
    layer.dispose();
    ground.geometry.dispose();
    (ground.material as THREE.Material).dispose();
    return report;
  }
}

function main(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('missing #app');

  const canvas = document.createElement('canvas');
  canvas.id = 'probe-canvas';
  app.append(canvas);

  const probe = new Probe(canvas);
  const reports: ProbeReport[] = [];
  window.vfxProbe = {
    run: (mode: GlowMode) => {
      const report = probe.run(mode);
      reports.push(report);
      return report;
    },
    // `halfHeight` forwarded, which it was not: `preview-bursts.ts` measures a
    // frame for every burst and passed it into a wrapper that took two
    // arguments, so every tile was photographed in the default box and the
    // framing silently did nothing.
    shot: (id: string, ticks: number, halfHeight?: number) => {
      const report = probe.shot(id, ticks, halfHeight);
      reports.push(report);
      return report;
    },
    blood: (ticks: number, effect?: string) => {
      const report = probe.blood(ticks, effect);
      reports.push(report);
      return report;
    },
    reports,
  };
  // A first frame so the page is never blank if a human opens it directly.
  probe.run('dither');
}

main();
