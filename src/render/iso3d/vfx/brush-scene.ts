/**
 * Dev-only: the painted effects, in a scene, in motion (spec 159).
 *
 * Not part of the app. Served from `src/render/brush-scene.html` by the dev
 * server, so it never reaches a build -- `vite build` bundles `index.html` and
 * nothing else -- and driven either by hand or by
 * `npx tsx scripts/preview-brush-vfx.ts`.
 *
 * ## Why the old rig could not answer the question
 *
 * `vfx/probe.ts` renders into a 240x150 buffer and lets CSS blow it up four
 * times with `image-rendering: pixelated`, because its job is to prove that
 * particles are inside the low-resolution buffer -- "is this pixel a palette
 * entry" has to be a sharp question for that, and a sharp question needs a tiny
 * palette and no antialiasing. Judging *art* through it is a category error: it
 * reports jagged silhouettes and stair-stepped edges about anything at all,
 * because that is the property it exists to demonstrate.
 *
 * So this is a second rig with the opposite settings -- full resolution, MSAA,
 * no retro pass, no palette -- and one job: showing what the shapes actually
 * are. Between them the two say something neither can alone. If a mark looks
 * blocky *here*, the mark is blocky.
 *
 * ## What is in it
 *
 * A lit ground, a low-poly stand of rocks and trees for scale, a target dummy to
 * hit, an orbiting camera, a directional light with a shadow map, and a clock
 * that can be slowed or stopped. Everything runs through the real `VfxLayer`
 * over the real `REGISTRY`, so what is on screen is what the game plays.
 */

import * as THREE from 'three';
import { VfxLayer } from './layer.js';
import { BRUSH_EXPLOSION_RADIUS } from './brush.js';

/** Where the dummy stands, and where a blow lands on it. */
const DUMMY = { x: 0, y: 0, z: 0 } as const;
const CHEST = 26;

export interface SceneShot {
  /** Radians about Y. */
  readonly azimuth?: number;
  /** Radians above the ground. */
  readonly elevation?: number;
  /** Half the orthographic box, world units. */
  readonly halfHeight?: number;
}

export interface BloodTrigger {
  readonly seed: number;
  /** Radians about Y: which way the attacker was standing. */
  readonly from?: number;
  readonly intensity?: number;
}

export interface ExplosionTrigger {
  readonly seed: number;
  readonly radius?: number;
  readonly intensity?: number;
  /** Ground offset from the dummy, world units. */
  readonly x?: number;
  readonly z?: number;
}

export interface SceneReport {
  readonly particles: number;
  readonly drawCalls: number;
  readonly ticks: number;
}

declare global {
  interface Window {
    brushScene?: {
      /** Fire a hit on the dummy, from a bearing. Returns the effect handle. */
      blood: (input: BloodTrigger) => number;
      /** Fire an explosion on the ground. */
      explosion: (input: ExplosionTrigger) => number;
      /** Clear everything in flight and reset the clock. */
      clear: () => void;
      /** Park the camera. */
      look: (shot: SceneShot) => void;
      /** 1 is real time, 0.2 is slow motion, 0 is frozen. */
      setTimeScale: (scale: number) => void;
      setPaused: (paused: boolean) => void;
      /** Advance exactly `ticks` 60Hz steps and draw. For scrubbing. */
      step: (ticks: number) => SceneReport;
      /** Draw one frame without advancing, so a screenshot is repeatable. */
      draw: () => SceneReport;
      /** Show or hide the on-page controls, so a capture is of the scene alone. */
      setChrome: (visible: boolean) => void;
      readonly report: () => SceneReport;
    };
  }
}

/** A flat-shaded low-poly prop, so the effects have something to be judged beside. */
function prop(geometry: THREE.BufferGeometry, color: number, x: number, z: number, y = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color, flatShading: true }));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

class BrushScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.OrthographicCamera;
  private readonly scene = new THREE.Scene();
  private readonly layer: VfxLayer;
  private readonly disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  private azimuth = 0.95;
  private elevation = 0.52;
  private halfHeight = 150;
  /**
   * How far the camera stands off, world units.
   *
   * Smaller than the ring the props stand on, and that is the whole point --
   * see the note where they are placed.
   */
  private static readonly ORBIT = 430;
  private paused = false;
  private timeScale = 1;
  /** Fractional ticks carried between frames, so slow motion is smooth. */
  private owed = 0;
  private ticks = 0;
  private last = 0;

  constructor(canvas: HTMLCanvasElement) {
    // The opposite of `probe.ts` in every setting that matters: real pixels,
    // multisampling, and no quantizer. This rig is for looking at shapes.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color(0x8fb8c8);
    this.scene.fog = new THREE.Fog(0x8fb8c8, 1400, 3200);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);

    // --- the world ---------------------------------------------------------
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 3000, 24, 24),
      new THREE.MeshLambertMaterial({ color: 0x7fa348, flatShading: true }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.disposables.push(ground.geometry, ground.material as THREE.Material);

    // A handful of low-poly props, all of them OUTSIDE the camera's orbit.
    //
    // That is a constraint rather than a layout choice. The camera is
    // orthographic, so anything between it and the subject fills the frame
    // whatever the zoom -- and with the props inside the orbit, six of the
    // contact sheet's camera bearings photographed the back of a rock and
    // reported that the effect had disappeared. Standing them beyond CAMERA_ORBIT
    // puts every near-side prop behind the camera, where the near plane removes
    // it, and leaves the far-side ones in the background doing their job.
    const rock = new THREE.IcosahedronGeometry(22, 0);
    const trunk = new THREE.CylinderGeometry(5, 7, 40, 6);
    const canopy = new THREE.ConeGeometry(30, 60, 7);
    this.disposables.push(rock, trunk, canopy);
    const stand: [number, number][] = [
      [-560, -380],
      [640, -190],
      [-330, 610],
      [700, 520],
      [-680, 240],
      [180, -700],
    ];
    stand.forEach(([x, z], i) => {
      if (i % 2 === 0) {
        this.add(prop(rock, 0x8b8478, x, z, 12));
      } else {
        this.add(prop(trunk, 0x6b4a2f, x, z, 20));
        this.add(prop(canopy, 0x4f7d3a, x, z, 66));
      }
    });
    this.add(prop(rock, 0x8b8478, 300, -640, 8));

    // --- the dummy ---------------------------------------------------------
    // A post with a head and two arms: low-poly, obviously a target, and roughly
    // the height of a player so a hit on it is judged at the size it is played.
    const post = new THREE.CylinderGeometry(9, 11, 52, 8);
    const head = new THREE.BoxGeometry(20, 18, 16);
    const arms = new THREE.BoxGeometry(70, 8, 8);
    this.disposables.push(post, head, arms);
    this.add(prop(post, 0x9a7a52, DUMMY.x, DUMMY.z, 26));
    this.add(prop(head, 0xc4a878, DUMMY.x, DUMMY.z, 62));
    this.add(prop(arms, 0x8a6a45, DUMMY.x, DUMMY.z, 44));

    // --- light -------------------------------------------------------------
    this.scene.add(new THREE.AmbientLight(0xbcd4e8, 1.1));
    const sun = new THREE.DirectionalLight(0xfff2dc, 2.1);
    sun.position.set(520, 760, 380);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const box = sun.shadow.camera;
    box.left = -800;
    box.right = 800;
    box.top = 800;
    box.bottom = -800;
    box.near = 1;
    box.far = 2200;
    box.updateProjectionMatrix();
    this.scene.add(sun, sun.target);

    // --- the effects -------------------------------------------------------
    this.layer = new VfxLayer({
      hooks: { ground: () => 0 },
      limits: { maxParticles: 3000, maxInstances: 32, pressureFloor: 0.25 },
      lights: true,
    });
    this.scene.add(this.layer.root);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.bindOrbit(canvas);
    this.look({});
  }

  private add(mesh: THREE.Mesh): void {
    this.scene.add(mesh);
  }

  /** Drag to orbit, wheel to zoom. The camera has to move to judge depth. */
  private bindOrbit(canvas: HTMLCanvasElement): void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    canvas.addEventListener('pointerdown', (event) => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointerup', (event) => {
      dragging = false;
      canvas.releasePointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      this.azimuth += (event.clientX - lastX) * 0.008;
      this.elevation = Math.min(1.45, Math.max(0.06, this.elevation - (event.clientY - lastY) * 0.006));
      lastX = event.clientX;
      lastY = event.clientY;
      this.look({});
    });
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.halfHeight = Math.min(600, Math.max(40, this.halfHeight * (event.deltaY > 0 ? 1.12 : 0.89)));
        this.look({});
      },
      { passive: false },
    );
  }

  look(shot: SceneShot): void {
    if (shot.azimuth !== undefined) this.azimuth = shot.azimuth;
    if (shot.elevation !== undefined) this.elevation = shot.elevation;
    if (shot.halfHeight !== undefined) this.halfHeight = shot.halfHeight;
    const distance = BrushScene.ORBIT;
    const y = Math.sin(this.elevation) * distance;
    const flat = Math.cos(this.elevation) * distance;
    const at = this.halfHeight * 0.2 + 20;
    this.camera.position.set(Math.cos(this.azimuth) * flat, y, Math.sin(this.azimuth) * flat);
    this.camera.lookAt(0, at, 0);
    this.camera.updateMatrixWorld();
    this.applyFrame();
    // The camera's own forward axis, so the transparency sort orders the marks
    // for *this* view rather than for a fixed isometric one. Getting this wrong
    // is invisible from one seat and is exactly what a movable camera is for.
    this.layer.setViewDirection(-this.camera.position.x, at - this.camera.position.y, -this.camera.position.z);
    this.layer.setViewpoint(0, at, 0);
  }

  private applyFrame(): void {
    const aspect = this.renderer.domElement.width / Math.max(1, this.renderer.domElement.height);
    this.camera.top = this.halfHeight;
    this.camera.bottom = -this.halfHeight;
    this.camera.left = -this.halfHeight * aspect;
    this.camera.right = this.halfHeight * aspect;
    this.camera.updateProjectionMatrix();
  }

  private resize(): void {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    this.renderer.setSize(width, height, false);
    this.applyFrame();
  }

  blood(input: BloodTrigger): number {
    // The attacker's bearing, as a unit direction in the ground plane; the blow
    // travels from there into the dummy, so the paint carries on outward.
    const from = input.from ?? 0;
    const incoming = { x: -Math.cos(from), y: 0, z: -Math.sin(from) };
    // The surface it landed on faces the attacker.
    const normal = { x: Math.cos(from), y: 0.25, z: Math.sin(from) };
    return this.layer.spawnBloodHit({
      x: DUMMY.x + Math.cos(from) * 11,
      y: CHEST,
      z: DUMMY.z + Math.sin(from) * 11,
      normal,
      incoming,
      ...(input.intensity === undefined ? {} : { intensity: input.intensity }),
      seed: input.seed,
    });
  }

  explosion(input: ExplosionTrigger): number {
    return this.layer.spawnBrushExplosion({
      x: input.x ?? 0,
      y: 0,
      z: input.z ?? 0,
      radius: input.radius ?? BRUSH_EXPLOSION_RADIUS,
      ...(input.intensity === undefined ? {} : { intensity: input.intensity }),
      seed: input.seed,
    });
  }

  clear(): void {
    this.layer.system.clear();
    // And then a zero-tick update, which is not a no-op: `system.clear` empties
    // the *pool*, and the instanced attributes keep whatever was last uploaded
    // until `VfxLayer.sync` runs. Without this the next frame drawn still shows
    // the previous effect -- which is invisible when a person is clicking
    // buttons (the loop redraws a moment later) and lethal to a script, where
    // it silently put the last effect into the "empty scene" baseline and
    // reported that six camera bearings were byte-identical.
    this.layer.update(0);
    this.ticks = 0;
    this.owed = 0;
  }

  setTimeScale(scale: number): void {
    this.timeScale = Math.max(0, Math.min(4, scale));
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Advance exactly this many ticks. Deterministic, so a script can scrub. */
  step(ticks: number): SceneReport {
    const whole = Math.max(0, Math.round(ticks));
    if (whole > 0) {
      this.layer.update(whole);
      this.ticks += whole;
    }
    return this.draw();
  }

  draw(): SceneReport {
    this.renderer.render(this.scene, this.camera);
    const readout = this.layer.readout();
    return { particles: readout.particles, drawCalls: readout.drawCalls, ticks: this.ticks };
  }

  report(): SceneReport {
    const readout = this.layer.readout();
    return { particles: readout.particles, drawCalls: readout.drawCalls, ticks: this.ticks };
  }

  /**
   * The real-time loop.
   *
   * Real elapsed time turned into whole 60Hz steps, with the remainder carried,
   * which is the same rule the game's own loop follows -- and the reason slow
   * motion works at all: at 0.15x a tick arrives every seventh frame and the
   * effects run correctly, where scaling a delta would run the sim at a
   * different rate and change what the effect *is*.
   */
  frame(now: number): void {
    const elapsed = this.last === 0 ? 0 : Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    if (!this.paused) {
      this.owed += elapsed * 60 * this.timeScale;
      const whole = Math.floor(this.owed);
      if (whole > 0) {
        this.owed -= whole;
        this.layer.update(whole);
        this.ticks += whole;
      }
    }
    this.draw();
  }
}

// --- the page ----------------------------------------------------------------

function button(label: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.style.cssText =
    'font:12px/1.4 ui-monospace,monospace;padding:5px 9px;cursor:pointer;border:1px solid #2c3a44;' +
    'border-radius:3px;background:#14212a;color:#dbe7ee;';
  node.addEventListener('click', onClick);
  return node;
}

function main(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('missing #app');

  const canvas = document.createElement('canvas');
  canvas.id = 'brush-canvas';
  canvas.style.cssText = 'display:block;width:100vw;height:100vh;touch-action:none;';
  app.append(canvas);

  const scene = new BrushScene(canvas);

  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;left:10px;top:10px;display:flex;flex-wrap:wrap;gap:5px;max-width:min(720px,92vw);' +
    'background:rgba(8,16,22,.82);border:1px solid #24323c;border-radius:5px;padding:8px;' +
    'font:12px/1.4 ui-monospace,monospace;color:#9fb4c2;align-items:center;';
  app.append(bar);

  // A rolling seed, so pressing the same button twice is two different
  // paintings by the same artist -- which is the property that is impossible to
  // judge from a fixed-seed preview.
  let seed = 20260810;
  const roll = (): number => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) ^ 0x9e3779b1) | 0;
    return seed;
  };
  let bearing = 0;

  const label = document.createElement('span');
  const paint = (): void => {
    const report = scene.report();
    label.textContent = `seed ${seed}  ·  ${report.particles} marks  ·  ${report.drawCalls} draws  ·  tick ${report.ticks}`;
  };

  bar.append(
    button('Blood (next bearing)', () => {
      bearing += Math.PI * 0.37;
      scene.blood({ seed: roll(), from: bearing });
      paint();
    }),
    button('Blood x4 around', () => {
      for (let i = 0; i < 4; i++) scene.blood({ seed: roll(), from: (i / 4) * Math.PI * 2 });
      paint();
    }),
    button('Blood heavy', () => {
      bearing += Math.PI * 0.37;
      scene.blood({ seed: roll(), from: bearing, intensity: 1.6 });
      paint();
    }),
    button('Boom small', () => {
      scene.explosion({ seed: roll(), radius: 34, x: -150, z: 90 });
      paint();
    }),
    button('Boom', () => {
      scene.explosion({ seed: roll(), radius: 60, x: 0, z: 120 });
      paint();
    }),
    button('Boom large', () => {
      scene.explosion({ seed: roll(), radius: 110, x: 170, z: 40 });
      paint();
    }),
    button('20 seeds', () => {
      // Twenty in a row, spread over the ground, so the *family* can be judged
      // rather than one member of it.
      for (let i = 0; i < 20; i++) {
        const angle = (i / 20) * Math.PI * 2;
        scene.explosion({ seed: roll(), radius: 40, x: Math.cos(angle) * 260, z: Math.sin(angle) * 260 });
      }
      paint();
    }),
    button('Clear', () => {
      scene.clear();
      paint();
    }),
  );

  const speedRow = document.createElement('span');
  speedRow.style.cssText = 'display:flex;gap:5px;align-items:center;';
  speedRow.append('speed');
  for (const speed of [1, 0.35, 0.12, 0.04]) {
    speedRow.append(
      button(`${speed}x`, () => {
        scene.setTimeScale(speed);
      }),
    );
  }
  let paused = false;
  const pause = button('Pause', () => {
    paused = !paused;
    scene.setPaused(paused);
    pause.textContent = paused ? 'Play' : 'Pause';
  });
  speedRow.append(pause, button('Step +1', () => {
    scene.step(1);
    paint();
  }));
  bar.append(speedRow, label);

  const hint = document.createElement('div');
  hint.style.cssText =
    'position:fixed;left:10px;bottom:10px;font:12px/1.5 ui-monospace,monospace;color:#8ea3b0;' +
    'background:rgba(8,16,22,.72);border:1px solid #24323c;border-radius:4px;padding:6px 9px;';
  hint.textContent = 'drag to orbit · wheel to zoom · every trigger draws a new seed';
  app.append(hint);

  const setChrome = (visible: boolean): void => {
    bar.style.display = visible ? 'flex' : 'none';
    hint.style.display = visible ? 'block' : 'none';
  };

  window.brushScene = {
    setChrome,
    blood: (input) => scene.blood(input),
    explosion: (input) => scene.explosion(input),
    clear: () => scene.clear(),
    look: (shot) => scene.look(shot),
    setTimeScale: (value) => scene.setTimeScale(value),
    setPaused: (value) => scene.setPaused(value),
    step: (ticks) => scene.step(ticks),
    draw: () => scene.draw(),
    report: () => scene.report(),
  };

  const loop = (now: number): void => {
    scene.frame(now);
    paint();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main();
