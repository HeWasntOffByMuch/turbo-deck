/**
 * The VFX tab (spec 122).
 *
 * A browser down the left, the preview in the middle, the parameters on the
 * right, and a readout over the viewport. The DOM half only: every decision
 * about what a field *is*, what a drag *means* and what the JSON *says* lives in
 * `vfx-fields.ts`, `curve-edit.ts` and `vfx-json.ts`, where a test can reach it.
 *
 * ## The preview is the game's own path
 *
 * The same `RetroPass`, the same `createViewControls` cog, the same virtual
 * resolution and the same `VfxLayer` the Play tab builds. `preview.ts` set that
 * bar for units and states the reason: a preview that flatters moves numbers in
 * the wrong direction and does it convincingly. The caveat it records applies
 * here too -- this is the same control-panel *type* as Play's, not a shared
 * instance, so a switch has to be thrown in both places.
 *
 * ## Edits rebuild the registry
 *
 * Changing a field recompiles a one-effect registry and replays it. That sounds
 * heavy and is not: compiling one definition is a handful of typed arrays, and
 * the alternative -- mutating a compiled emitter in place -- would change what
 * particles already in the air are doing, since they read their emitter every
 * tick. Replay-on-edit is also what makes the feedback honest: what you see is
 * a fresh play of exactly the definition the Export button will hand you.
 */

import * as THREE from 'three';
import { RetroPass } from '../retro-pass.js';
import { createViewControls, type ViewControls } from '../view-controls.js';
import { internalRenderSize } from '../view-frame.js';
import { CAMERA_FAR, CAMERA_NEAR } from '../view-settings.js';
import { VfxLayer } from '../vfx/layer.js';
import { compileRegistry } from '../vfx/compile.js';
import { EFFECTS } from '../vfx/registry.js';
import { VFX_PALETTE, type PaletteKey } from '../vfx/palette.js';
import type { EffectDefinition, Emitter } from '../vfx/types.js';
import type { Curve, Gradient } from '../vfx/curve.js';
import type { ViewHandle } from '../view-handle.js';
import {
  clampToSpec,
  fieldGroups,
  readField,
  writeField,
  type FieldSpec,
} from './vfx-fields.js';
import {
  addKey,
  addStop,
  autoRange,
  curveToPixels,
  moveKey,
  moveStop,
  pickKey,
  pickStop,
  pixelToCurve,
  removeKey,
  removeStop,
  setStopColor,
  type Box,
} from './curve-edit.js';
import { effectFromJson, effectToJson } from './vfx-json.js';
import { previewFrame, type PreviewFrame } from './vfx-frame.js';

const MONO = "'Courier New',ui-monospace,monospace";
const PANEL = 'background:#16161e;border:1px solid #2a2a3a;padding:10px;box-sizing:border-box;';

/** The intensities the toolbar cycles through. 1 is the authored effect. */
const PREVIEW_SCALES: readonly number[] = [0.6, 1, 1.6, 2.4];

/** Ground materials the preview can stand an effect on. */
const GROUNDS: readonly { readonly name: string; readonly color: number }[] = [
  { name: 'Grass', color: 0x86a740 },
  { name: 'Dirt', color: 0xb37034 },
  { name: 'Stone', color: 0xafa693 },
  { name: 'Snow', color: 0xe3e9e5 },
  { name: 'Night', color: 0x1a1a24 },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = css;
  if (text) node.textContent = text;
  return node;
}

/** Deep-ish clone of a definition, so edits never touch the shipped table. */
function cloneEffect(effect: EffectDefinition): EffectDefinition {
  return JSON.parse(JSON.stringify(effect)) as EffectDefinition;
}

export function mountVfxStudio(container: HTMLElement): ViewHandle {
  /**
   * The root, and an inner element that does the actual layout.
   *
   * The split is not decoration. `main.ts` writes `element.style.display =
   * 'block'` on a tab's root every time that tab is activated -- that is how the
   * shell shows and hides them -- so a root that lays itself out with
   * `display:flex` has its flex clobbered on the first click. The three columns
   * become block-level, stack vertically, and the preview lands below the fold
   * behind a full-width list of effect names.
   *
   * So the root owns only the box (height, padding from the shell, no scroll)
   * and `layout` owns the columns, where nothing outside this file writes to it.
   * `box-sizing:border-box` because the shell adds 44px of top padding to clear
   * the floating tab bar and 16px at the bottom, and those have to come out of
   * the height rather than be added to it.
   */
  const root = el(
    'div',
    `font-family:${MONO};color:#c8c8d8;font-size:12px;box-sizing:border-box;height:100vh;overflow:hidden;`,
  );
  // Named so a probe can find *this* tab's elements. Every tab that has been
  // opened stays in the DOM behind `display:none`, so a bare
  // `document.querySelector('canvas')` finds the Play tab's hidden one and
  // measures a zero-sized rectangle -- which is exactly what the first version of
  // the layout check did, and it reported a failure that was entirely its own.
  root.id = 'vfx-studio';
  const layout = el('div', 'display:flex;gap:10px;height:100%;min-height:0;');
  layout.dataset['vfxLayout'] = 'true';

  // --- state ---------------------------------------------------------------
  let edited: EffectDefinition = cloneEffect(EFFECTS[0] as EffectDefinition);
  let emitterIndex = 0;
  let attachToSocket = false;
  let groundIndex = 1;
  let handle = 0;
  let looping = true;
  /**
   * The seed and the scale the preview plays at (spec 158).
   *
   * Both were constants -- seed 20260810 and no scale at all -- which is right
   * for tuning a curve and useless for judging a *procedural* effect: the whole
   * claim of the painted vocabulary is that two spawns do not look alike, and a
   * fixed seed is precisely the setting under which that claim cannot be seen.
   * `vary` is the switch, and it is off by default because a moving picture is
   * the wrong thing to drag a curve handle against.
   */
  let seed = 20260810;
  let vary = false;
  let scaleIndex = 1;
  /** The box the current effect needs, measured off a headless replay of it. */
  let fit: PreviewFrame = { span: 220, centreY: 26 };

  // --- the viewport --------------------------------------------------------
  const canvas = el('canvas', 'display:block;width:100%;image-rendering:pixelated;background:#101018;');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(1);
  const retro = new RetroPass(1, 1);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fd6c8);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(3000, 3000),
    new THREE.MeshLambertMaterial({ color: GROUNDS[groundIndex]?.color ?? 0xb37034, flatShading: true }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(120, 260, 160);
  scene.add(sun);

  /**
   * The dummies: bodies at the player's real drawn height, so an effect is
   * judged against something the right size. A unit that is subtly the wrong
   * scale looks fine alone and wrong beside anything.
   *
   * Several of them, and none at the origin. One dummy standing exactly where
   * the effect plays swallows it -- a capsule is twenty units across and forty
   * tall, so a hit flash spawned at the middle of it is simply inside a solid
   * and the report is "sometimes I cannot see the effect". The first one is the
   * attach target; the rest are there to stand next to.
   */
  const DUMMIES = [
    { x: -34, z: 0, height: 34 },
    { x: 32, z: 22, height: 30 },
    { x: 6, z: -40, height: 40 },
  ] as const;

  const dummy = new THREE.Group();
  DUMMIES.forEach((spot, index) => {
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(10, spot.height, 4, 8),
      // The attach target reads as the one being acted on; the others are scale.
      new THREE.MeshLambertMaterial({ color: index === 0 ? 0x615a8c : 0x4a4560, flatShading: true }),
    );
    body.position.set(spot.x, spot.height * 0.5 + 11, spot.z);
    dummy.add(body);
  });
  scene.add(dummy);

  /** Where an attached effect rides: the first dummy's chest. */
  const ATTACH = DUMMIES[0];

  // The Play tab's own near and far, not a hand-picked pair.
  //
  // This was `(1, 6000)` and the camera orbits at a distance of 6000, which put
  // the *origin itself* exactly on the far plane: everything past the middle of
  // the scene was clipped away, so half the ground was missing behind a hard
  // horizon and an effect that drifted away from the camera simply vanished.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, CAMERA_NEAR, CAMERA_FAR);
  let cameraSpan = 220;

  const HOOKS = {
    ground: () => 0,
    attach: (_entity: number, _socket: string, out: Float32Array, at: number): boolean => {
      // The socket preview: a point that moves, because an attached effect judged
      // against a stationary body is judged against the easy case.
      out[at] = dummy.position.x + ATTACH.x;
      out[at + 1] = 34;
      out[at + 2] = dummy.position.z + ATTACH.z;
      return true;
    },
  };

  function makeLayer(): VfxLayer {
    return new VfxLayer({
      registry: compileRegistry([edited]),
      hooks: HOOKS,
      limits: { maxParticles: 3000, maxInstances: 64, pressureFloor: 0.25 },
    });
  }

  let layer = makeLayer();
  scene.add(layer.root);

  const controls: ViewControls = createViewControls();

  // --- rebuild -------------------------------------------------------------

  /**
   * Ask for a fresh layer on the next frame.
   *
   * A compiled emitter is frozen and the system holds its table by reference, so
   * an edit cannot be poked into a running system -- and it should not be, since
   * particles already in the air read their emitter every tick and would change
   * mid-flight. So the layer is rebuilt outright.
   *
   * Deferred to the next frame because a slider fires `input` on every pixel of
   * a drag, and rebuilding a layer per pixel would tear down and re-make GPU
   * buffers dozens of times a second. Once per frame is imperceptible and is
   * what "immediate visual feedback" actually needs.
   */
  let dirty = true;
  function replay(): void {
    dirty = true;
  }

  function rebuildNow(): void {
    dirty = false;
    scene.remove(layer.root);
    layer.dispose();
    layer = makeLayer();
    scene.add(layer.root);
    const spawnY = attachToSocket ? 34 : 30;
    // Measured once here rather than every frame: the sim is deterministic, so
    // the answer cannot change between frames, and a box recomputed per frame
    // would creep as the effect grew.
    // Measured at 1x and then scaled, because `play`'s scale multiplies every
    // length in the effect -- a frame measured without it crops the moment the
    // intensity button is touched, which is the failure this whole measurement
    // exists to prevent.
    const played = PREVIEW_SCALES[scaleIndex] ?? 1;
    const measured = previewFrame(edited, spawnY);
    fit = { span: measured.span * played, centreY: measured.centreY * played };
    if (vary) {
      // A new draw each replay, mixed rather than incremented: consecutive
      // integers seed `VfxRng` to visibly similar first draws, which is the
      // exact trap `rng.ts` documents.
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) ^ 0x9e3779b1) | 0;
      seedButton.textContent = `Seed: ${seed}`;
    }
    handle = layer.play(edited.id, {
      x: 0,
      y: attachToSocket ? 0 : 30,
      z: 0,
      seed,
      scale: PREVIEW_SCALES[scaleIndex] ?? 1,
      ...(attachToSocket ? { attach: { kind: 'entity' as const, entityId: 1 } } : {}),
    });
  }

  // --- the browser ---------------------------------------------------------
  const browser = el('div', `${PANEL}width:210px;overflow:auto;flex:none;`);
  browser.append(el('div', 'letter-spacing:.08em;color:#f0f0f8;margin-bottom:8px;', 'EFFECTS'));
  const rows = new Map<string, HTMLButtonElement>();
  for (const effect of EFFECTS) {
    const button = el('button', '');
    button.type = 'button';
    button.textContent = effect.id;
    button.style.cssText =
      `display:block;width:100%;text-align:left;font:inherit;font-size:11px;padding:3px 6px;margin-bottom:2px;` +
      'cursor:pointer;border:1px solid transparent;background:transparent;color:#9a9ab0;';
    button.addEventListener('click', () => {
      edited = cloneEffect(effect);
      emitterIndex = 0;
      select();
      buildPanel();
      replay();
    });
    rows.set(effect.id, button);
    browser.append(button);
  }
  function select(): void {
    for (const [id, button] of rows) {
      const on = id === edited.id;
      button.style.background = on ? '#3a3a4e' : 'transparent';
      button.style.color = on ? '#f0f0f8' : '#9a9ab0';
    }
  }

  // --- the middle ----------------------------------------------------------
  const middle = el('div', 'flex:1;display:flex;flex-direction:column;gap:8px;min-width:0;');
  const stage = el('div', 'position:relative;flex:1;min-height:0;');
  stage.append(canvas);
  const readout = el(
    'div',
    'position:absolute;left:8px;top:8px;background:rgba(12,12,18,.78);border:1px solid #2a2a3a;' +
      'padding:6px 8px;font-size:11px;line-height:1.5;color:#c8c8d8;white-space:pre;pointer-events:none;',
  );
  stage.append(readout);
  const cog = el('div', 'position:absolute;right:8px;top:8px;');
  cog.append(controls.element);
  stage.append(cog);
  middle.append(stage);

  const bar = el('div', `${PANEL}display:flex;gap:6px;align-items:center;flex-wrap:wrap;flex:none;`);
  const button = (label: string, onClick: () => void): HTMLButtonElement => {
    const node = el('button', '');
    node.type = 'button';
    node.textContent = label;
    node.style.cssText =
      'font:inherit;font-size:11px;padding:4px 10px;cursor:pointer;border:1px solid #4a4a5e;background:#252533;color:#e8e8f2;';
    node.addEventListener('click', onClick);
    return node;
  };
  bar.append(button('Replay', () => replay()));
  // Spec 158's three: a seed you can roll, a switch that rolls it on every
  // replay, and an intensity. Together they are how somebody looks at a
  // procedural effect rather than at one sample of it.
  const seedButton = button(`Seed: ${seed}`, () => {
    seed = (Math.random() * 0x7fffffff) | 0;
    seedButton.textContent = `Seed: ${seed}`;
    replay();
  });
  seedButton.title = 'Roll a new seed. The look is a pure function of it, so the same number is the same spatter.';
  bar.append(seedButton);
  const varyButton = button('Vary: off', () => {
    vary = !vary;
    varyButton.textContent = `Vary: ${vary ? 'on' : 'off'}`;
  });
  varyButton.title = 'Draw a fresh seed on every replay. With Loop on, this is the effect firing over and over with real variation.';
  bar.append(varyButton);
  const scaleButton = button(`Intensity: ${PREVIEW_SCALES[scaleIndex]?.toFixed(1) ?? '1.0'}x`, () => {
    scaleIndex = (scaleIndex + 1) % PREVIEW_SCALES.length;
    scaleButton.textContent = `Intensity: ${PREVIEW_SCALES[scaleIndex]?.toFixed(1) ?? '1.0'}x`;
    replay();
  });
  scaleButton.title = 'The scale the effect is played at, which is what a crit or a bigger blast is.';
  bar.append(scaleButton);
  const loopButton = button('Loop: on', () => {
    looping = !looping;
    loopButton.textContent = `Loop: ${looping ? 'on' : 'off'}`;
  });
  bar.append(loopButton);
  const attachButton = button('Attach: world', () => {
    attachToSocket = !attachToSocket;
    attachButton.textContent = `Attach: ${attachToSocket ? 'socket' : 'world'}`;
    replay();
  });
  bar.append(attachButton);
  const groundButton = button(`Ground: ${GROUNDS[groundIndex]?.name ?? ''}`, () => {
    groundIndex = (groundIndex + 1) % GROUNDS.length;
    const chosen = GROUNDS[groundIndex];
    if (chosen) {
      (ground.material as THREE.MeshLambertMaterial).color.setHex(chosen.color);
      groundButton.textContent = `Ground: ${chosen.name}`;
    }
  });
  bar.append(groundButton);
  bar.append(
    button('Export JSON', () => {
      const text = effectToJson(edited);
      void navigator.clipboard?.writeText(text).catch(() => undefined);
      jsonArea.value = text;
      status.textContent = 'copied to the clipboard, and shown below';
    }),
  );
  bar.append(
    button('Import JSON', () => {
      const parsed = effectFromJson(jsonArea.value);
      if ('error' in parsed) {
        status.textContent = parsed.error;
        status.style.color = '#e06c75';
        return;
      }
      edited = parsed.effect;
      emitterIndex = 0;
      status.textContent = 'loaded';
      status.style.color = '#8a8aa0';
      buildPanel();
      replay();
    }),
  );
  const status = el('div', 'color:#8a8aa0;font-size:11px;flex:1;');
  bar.append(status);
  middle.append(bar);

  const jsonArea = el('textarea', `${PANEL}height:120px;font-family:${MONO};font-size:11px;color:#c8c8d8;resize:vertical;flex:none;`) as HTMLTextAreaElement;
  jsonArea.spellcheck = false;
  middle.append(jsonArea);

  // --- the parameter panel -------------------------------------------------
  const params = el('div', `${PANEL}width:300px;overflow:auto;flex:none;`);

  function currentEmitter(): Emitter | undefined {
    return edited.emitters[emitterIndex];
  }

  function setEmitter(next: Emitter): void {
    const emitters = edited.emitters.map((emitter, index) => (index === emitterIndex ? next : emitter));
    edited = { ...edited, emitters };
    replay();
  }

  function numberRow(spec: FieldSpec, value: number, onChange: (next: number) => void): HTMLElement {
    const row = el('label', 'display:flex;flex-direction:column;gap:2px;margin-bottom:6px;cursor:pointer;');
    if (spec.tip) row.title = spec.tip;
    const head = el('div', 'display:flex;justify-content:space-between;color:#9a9ab0;font-size:11px;');
    head.append(el('span', '', spec.label));
    const shown = el('span', 'color:#e8e8f2;', String(Math.round(value * 1000) / 1000));
    head.append(shown);
    const slider = el('input', 'width:100%;') as HTMLInputElement;
    slider.type = 'range';
    slider.min = String(spec.min ?? 0);
    slider.max = String(spec.max ?? 1);
    slider.step = String(spec.step ?? 0.01);
    slider.value = String(value);
    slider.addEventListener('input', () => {
      const next = clampToSpec(spec, Number(slider.value));
      shown.textContent = String(Math.round(next * 1000) / 1000);
      onChange(next);
    });
    row.append(head, slider);
    return row;
  }

  /** A curve editor: a box you drag keys around in. */
  function curveRow(spec: FieldSpec, curve: Curve, onChange: (next: Curve) => void): HTMLElement {
    const row = el('div', 'margin-bottom:8px;');
    row.append(el('div', 'color:#9a9ab0;font-size:11px;margin-bottom:2px;', `${spec.label} (drag; double-click adds, right-click removes)`));
    const view = el('canvas', 'display:block;width:100%;height:70px;background:#101018;border:1px solid #2a2a3a;cursor:crosshair;') as HTMLCanvasElement;
    view.width = 276;
    view.height = 70;
    row.append(view);

    let live = curve;
    const range = spec.min !== undefined && spec.max !== undefined ? { min: spec.min, max: spec.max } : autoRange(curve);
    const box: Box = { x: 4, y: 4, width: view.width - 8, height: view.height - 8 };
    let dragging = -1;

    const paint = (): void => {
      const ctx = view.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, view.width, view.height);
      ctx.fillStyle = '#101018';
      ctx.fillRect(0, 0, view.width, view.height);
      const points = curveToPixels(live, box, range);
      ctx.strokeStyle = '#6fae4a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      points.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
      ctx.stroke();
      ctx.fillStyle = '#ffe08a';
      for (const point of points) ctx.fillRect(point.x - 2, point.y - 2, 5, 5);
    };

    const at = (event: MouseEvent): { px: number; py: number } => {
      const rect = view.getBoundingClientRect();
      return {
        px: ((event.clientX - rect.left) / rect.width) * view.width,
        py: ((event.clientY - rect.top) / rect.height) * view.height,
      };
    };

    view.addEventListener('mousedown', (event) => {
      const { px, py } = at(event);
      dragging = pickKey(live, box, range, px, py, 8);
    });
    view.addEventListener('mousemove', (event) => {
      if (dragging < 0) return;
      const { px, py } = at(event);
      const { t, value } = pixelToCurve(box, range, px, py);
      live = moveKey(live, dragging, t, value, range);
      // The dragged key may have re-sorted past a neighbour, so follow it.
      dragging = pickKey(live, box, range, px, py, 12);
      paint();
      onChange(live);
    });
    const stop = (): void => {
      dragging = -1;
    };
    view.addEventListener('mouseup', stop);
    view.addEventListener('mouseleave', stop);
    view.addEventListener('dblclick', (event) => {
      const { px, py } = at(event);
      const { t, value } = pixelToCurve(box, range, px, py);
      live = addKey(live, t, value).curve;
      paint();
      onChange(live);
    });
    view.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const { px, py } = at(event);
      const index = pickKey(live, box, range, px, py, 8);
      if (index < 0) return;
      live = removeKey(live, index);
      paint();
      onChange(live);
    });

    paint();
    return row;
  }

  /** A gradient editor: stops on a strip, each with a palette dropdown. */
  function gradientRow(spec: FieldSpec, gradient: Gradient, onChange: (next: Gradient) => void): HTMLElement {
    const row = el('div', 'margin-bottom:8px;');
    row.append(el('div', 'color:#9a9ab0;font-size:11px;margin-bottom:2px;', `${spec.label} (drag; double-click adds)`));
    const strip = el('canvas', 'display:block;width:100%;height:26px;border:1px solid #2a2a3a;cursor:crosshair;') as HTMLCanvasElement;
    strip.width = 276;
    strip.height = 26;
    row.append(strip);
    const list = el('div', 'display:flex;flex-direction:column;gap:2px;margin-top:3px;');
    row.append(list);

    let live = gradient;
    const box: Box = { x: 0, y: 0, width: strip.width, height: strip.height };
    let dragging = -1;

    const paint = (): void => {
      const ctx = strip.getContext('2d');
      if (!ctx) return;
      const fill = ctx.createLinearGradient(0, 0, strip.width, 0);
      for (const [t, key] of live.stops) {
        fill.addColorStop(Math.min(1, Math.max(0, t)), `#${VFX_PALETTE[key].toString(16).padStart(6, '0')}`);
      }
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, strip.width, strip.height);
      ctx.fillStyle = '#101018';
      for (const [t] of live.stops) ctx.fillRect(t * strip.width - 1, 0, 3, strip.height);

      list.replaceChildren();
      live.stops.forEach(([t, key], index) => {
        const entry = el('div', 'display:flex;gap:4px;align-items:center;font-size:11px;');
        entry.append(el('span', 'color:#8a8aa0;width:34px;', t.toFixed(2)));
        const pick = el('select', 'flex:1;font:inherit;font-size:11px;background:#252533;color:#e8e8f2;border:1px solid #4a4a5e;') as HTMLSelectElement;
        for (const name of Object.keys(VFX_PALETTE)) {
          const option = document.createElement('option');
          option.value = name;
          option.textContent = name;
          if (name === key) option.selected = true;
          pick.append(option);
        }
        pick.addEventListener('change', () => {
          live = setStopColor(live, index, pick.value as PaletteKey);
          paint();
          onChange(live);
        });
        entry.append(pick);
        const drop = el('button', 'font:inherit;font-size:11px;padding:0 6px;cursor:pointer;border:1px solid #4a4a5e;background:#252533;color:#e8e8f2;', '×');
        (drop as HTMLButtonElement).type = 'button';
        drop.addEventListener('click', () => {
          live = removeStop(live, index);
          paint();
          onChange(live);
        });
        entry.append(drop);
        list.append(entry);
      });
    };

    const px = (event: MouseEvent): number => {
      const rect = strip.getBoundingClientRect();
      return ((event.clientX - rect.left) / rect.width) * strip.width;
    };
    strip.addEventListener('mousedown', (event) => {
      dragging = pickStop(live, box, px(event), 8);
    });
    strip.addEventListener('mousemove', (event) => {
      if (dragging < 0) return;
      live = moveStop(live, dragging, px(event) / strip.width);
      dragging = pickStop(live, box, px(event), 12);
      paint();
      onChange(live);
    });
    strip.addEventListener('mouseup', () => (dragging = -1));
    strip.addEventListener('mouseleave', () => (dragging = -1));
    strip.addEventListener('dblclick', (event) => {
      const first = live.stops[0];
      live = addStop(live, px(event) / strip.width, first ? first[1] : 'sparkHot');
      paint();
      onChange(live);
    });

    paint();
    return row;
  }

  function buildPanel(): void {
    params.replaceChildren();
    params.append(el('div', 'letter-spacing:.08em;color:#f0f0f8;margin-bottom:8px;', edited.id.toUpperCase()));

    const tabs = el('div', 'display:flex;gap:3px;flex-wrap:wrap;margin-bottom:8px;');
    edited.emitters.forEach((emitter, index) => {
      const node = el('button', '');
      (node as HTMLButtonElement).type = 'button';
      node.textContent = emitter.id;
      node.style.cssText =
        'font:inherit;font-size:10px;padding:2px 6px;cursor:pointer;border:1px solid #4a4a5e;' +
        (index === emitterIndex ? 'background:#4a4a68;color:#f0f0f8;' : 'background:transparent;color:#9a9ab0;');
      node.addEventListener('click', () => {
        emitterIndex = index;
        buildPanel();
      });
      tabs.append(node);
    });
    params.append(tabs);

    const emitter = currentEmitter();
    if (!emitter) return;

    for (const group of fieldGroups()) {
      const rowsForGroup: HTMLElement[] = [];
      for (const spec of group.fields) {
        const value = readField(emitter, spec.path);
        if (spec.kind === 'curve') {
          if (!value) continue;
          rowsForGroup.push(
            curveRow(spec, value as Curve, (next) => setEmitter(writeField(currentEmitter() ?? emitter, spec.path, next))),
          );
        } else if (spec.kind === 'gradient') {
          if (!value) continue;
          rowsForGroup.push(
            gradientRow(spec, value as Gradient, (next) => setEmitter(writeField(currentEmitter() ?? emitter, spec.path, next))),
          );
        } else if (spec.kind === 'range') {
          const pair = (value as [number, number] | undefined) ?? [0, 0];
          rowsForGroup.push(
            numberRow({ ...spec, label: `${spec.label} min` }, pair[0], (next) =>
              setEmitter(writeField(currentEmitter() ?? emitter, spec.path, [next, pair[1]])),
            ),
            numberRow({ ...spec, label: `${spec.label} max` }, pair[1], (next) =>
              setEmitter(writeField(currentEmitter() ?? emitter, spec.path, [pair[0], next])),
            ),
          );
        } else if (spec.kind === 'enum') {
          const pick = el('select', 'width:100%;font:inherit;font-size:11px;background:#252533;color:#e8e8f2;border:1px solid #4a4a5e;margin-bottom:6px;') as HTMLSelectElement;
          for (const option of spec.options ?? []) {
            const node = document.createElement('option');
            node.value = option;
            node.textContent = option;
            if (option === value) node.selected = true;
            pick.append(node);
          }
          pick.addEventListener('change', () => setEmitter(writeField(currentEmitter() ?? emitter, spec.path, pick.value)));
          const wrap = el('label', 'display:flex;flex-direction:column;gap:2px;');
          wrap.append(el('div', 'color:#9a9ab0;font-size:11px;', spec.label), pick);
          rowsForGroup.push(wrap);
        } else if (spec.kind === 'boolean') {
          const wrap = el('label', 'display:flex;gap:6px;align-items:center;margin-bottom:6px;cursor:pointer;');
          const check = el('input', '') as HTMLInputElement;
          check.type = 'checkbox';
          check.checked = value !== false;
          check.addEventListener('change', () => setEmitter(writeField(currentEmitter() ?? emitter, spec.path, check.checked)));
          wrap.append(check, el('span', 'color:#9a9ab0;font-size:11px;', spec.label));
          rowsForGroup.push(wrap);
        } else if (typeof value === 'number') {
          rowsForGroup.push(numberRow(spec, value, (next) => setEmitter(writeField(currentEmitter() ?? emitter, spec.path, next))));
        }
      }
      if (rowsForGroup.length === 0) continue;
      params.append(el('div', 'color:#f0f0f8;font-size:11px;letter-spacing:.06em;margin:10px 0 4px;', group.title.toUpperCase()));
      for (const node of rowsForGroup) params.append(node);
    }
  }

  layout.append(browser, middle, params);
  root.append(layout);
  container.append(root);

  // --- the loop ------------------------------------------------------------
  let raf = 0;
  let last = 0;
  let accumulator = 0;
  let vfxCost = 0;

  function resize(): void {
    const width = stage.clientWidth || 640;
    const height = stage.clientHeight || 400;
    const size = internalRenderSize(width, height);
    renderer.setSize(size.width, size.height, false);
    retro.setSize(size.width, size.height);
    canvas.style.height = `${height}px`;
    const aspect = size.width / size.height;
    // Never tighter than the effect needs. The zoom slider still zooms *out*,
    // and a hundred-unit aura is no longer cropped the moment the camera is
    // raised -- which it was, because a ring seen from above is twice as tall on
    // screen as one seen edge-on and the box was a fixed multiple of the zoom.
    const span = Math.max(cameraSpan, fit.span);
    camera.left = -span * aspect * 0.5;
    camera.right = span * aspect * 0.5;
    camera.top = span * 0.5;
    camera.bottom = -span * 0.5;
    camera.updateProjectionMatrix();
  }

  function frame(now: number): void {
    const elapsed = last === 0 ? 16.7 : now - last;
    last = now;
    accumulator = Math.min(accumulator + elapsed, 200);
    let ticks = 0;
    while (accumulator >= 1000 / 60) {
      accumulator -= 1000 / 60;
      ticks += 1;
    }

    if (dirty) rebuildNow();

    // The game's own zoom slider, so the preview frames a unit the way Play does.
    cameraSpan = Math.max(40, controls.viewHalfWidth() * 2);
    resize();
    const offset = controls.cameraOffset();
    camera.position.set(offset.x, offset.y, offset.z);
    // Aimed at the effect's own middle, not at a fixed height: a tall effect
    // pointed at knee level is cropped at the top with empty ground below it.
    camera.lookAt(0, fit.centreY, 0);

    // Measured around the VFX work only, which is the number the readout claims.
    const started = performance.now();
    layer.setViewpoint(0, fit.centreY, 0);
    // Whichever way the turntable has left the camera pointing, so the solids
    // sort correctly from every angle rather than only the isometric one.
    layer.setViewDirection(-offset.x, fit.centreY - offset.y, -offset.z);
    layer.update(ticks);
    vfxCost = vfxCost * 0.9 + (performance.now() - started) * 0.1;

    if (looping && handle !== 0 && !layer.system.isLive(handle)) replay();

    retro.set(controls.retro());
    retro.setGrade(controls.grade());
    retro.setPalette(controls.hike().palette);
    retro.render(renderer, scene, camera);

    const stats = layer.readout();
    readout.textContent =
      `particles   ${stats.particles}\n` +
      `effects     ${stats.effects}\n` +
      `draw calls  ${stats.drawCalls}\n` +
      `decals      ${stats.decals} in ${stats.decalBuckets} chunk(s)\n` +
      `lights      ${stats.lights}\n` +
      `culled      ${stats.refusedDistance} distance, ${stats.refusedBudget} budget\n` +
      `throttled   ${stats.throttled}\n` +
      `vfx cost    ${vfxCost.toFixed(2)} ms/frame`;

    raf = requestAnimationFrame(frame);
  }

  select();
  buildPanel();
  replay();
  jsonArea.value = effectToJson(edited);

  return {
    element: root,
    start(): void {
      last = 0;
      raf = requestAnimationFrame(frame);
    },
    stop(): void {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
