/**
 * The gallery, in a real browser (spec 123).
 *
 * A dev-server page rather than a tab in the game's shell, for the same reason
 * `wind-probe.html` and `shading-probe.html` are: it is a measuring rig, and the
 * thing it measures is whether the browser backend agrees with the software one.
 * Shipping it inside the game would mean the game's bundle carries a QA surface.
 *
 * Everything here is glue. The tree, the layout, the theme and the draw list all
 * come from `src/ui/`, unchanged, which is the point -- if this page and the
 * goldens ever disagree, the difference is the backend and not the scene.
 */

import { replay } from '../ui/core/draw-list.js';
import { autoUiScale, uiFrame } from '../ui/core/frame.js';
import { UiRoot } from '../ui/core/root.js';
import { NO_MODIFIERS, type Modifiers, type UiEvent } from '../ui/core/events.js';
import { buildGallery } from '../ui/gallery/gallery.js';
import { buildWindowsScene } from '../ui/gallery/windows-scene.js';
import { ContextStack } from '../ui/core/events.js';
import { LayerStack } from '../ui/core/layers.js';
import { WindowManager } from '../ui/core/window-manager.js';
import { InputMap } from '../ui/input/input-map.js';
import { KeybindingsScreen } from '../ui/screens/keybindings.js';
import { InventoryScreen } from '../ui/screens/inventory.js';
import { HudScreen } from '../ui/screens/hud.js';
import { CharacterScreen } from '../ui/screens/character.js';
import { ShopScreen } from '../ui/screens/shop.js';
import { ItemSlot } from '../ui/widgets/item-slot.js';
import { Anchor } from '../ui/core/containers.js';
import { demoCharacter, demoContainers, demoHud, demoShop } from '../ui/gallery/render.js';
import { ScrollView } from '../ui/widgets/scroll-view.js';
import { Tooltip } from '../ui/widgets/tooltip.js';
import { UiWindow } from '../ui/widgets/window.js';
import { bakeAtlas } from '../ui/render/atlas.js';
import { Canvas2dSurface } from '../ui/render/canvas2d.js';
import { RasterSurface } from '../ui/render/raster.js';
import { THEME } from '../ui/theme/theme.js';

interface Probe {
  /** Milliseconds for one full update + paint + replay, averaged. */
  frameMs: number;
  drawCalls: number;
  viewport: { width: number; height: number };
  scale: number;
  /** Whether canvas2d's pixels match the software rasterizer's, byte for byte. */
  matchesRaster: boolean;
  firstMismatch: string | null;
}

function modifiersOf(event: MouseEvent | KeyboardEvent): Modifiers {
  return { shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey };
}

function main(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('missing #app');

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;left:0;top:0;';
  app.appendChild(canvas);

  const atlas = bakeAtlas(THEME);
  const dpr = globalThis.devicePixelRatio || 1;
  const scale = autoUiScale(app.clientWidth, app.clientHeight, dpr, {
    minViewport: THEME.input.minViewport,
    comfortViewport: THEME.input.comfortViewport,
    coarsePointer: globalThis.matchMedia?.('(pointer: coarse)').matches ?? false,
    maxTapUiPx: THEME.input.maxTapUiPx,
  });
  const frame = uiFrame(app.clientWidth, app.clientHeight, dpr, scale);
  const viewport = { width: frame.width, height: frame.height };

  // `?scene=windows` draws spec 124's six-window scene instead of the widget
  // gallery, so the cross-backend comparison covers both. Two pages would be two
  // copies of the glue below.
  const wanted = new URLSearchParams(globalThis.location.search).get('scene');
  const scene = wanted === 'windows' ? buildWindowsScene(THEME, viewport) : null;
  const keys = wanted === 'keys' ? buildKeysScene(viewport) : null;
  const bag = wanted === 'bag' ? buildBagScene(viewport) : null;
  const play = wanted === 'play' ? buildPlayScene(viewport) : null;
  const shop = wanted === 'shop' ? buildShopScene(viewport) : null;
  const gallery = scene ?? keys ?? bag ?? play ?? shop ? null : buildGallery(THEME);
  const content = scene?.root ?? keys?.root ?? bag?.root ?? play?.root ?? shop?.root ?? gallery?.root;
  if (!content) throw new Error('no scene');
  const manager = scene?.manager ?? keys?.manager ?? bag?.manager ?? play?.manager ?? shop?.manager;
  const layerStack = scene?.root ?? keys?.root ?? bag?.root ?? play?.root ?? shop?.root;

  const root = new UiRoot(content, {
    theme: THEME,
    atlas,
    viewport,
    ...(manager && layerStack ? { windows: manager, layers: layerStack } : {}),
  });
  const surface = new Canvas2dSurface(canvas, atlas, frame.width, frame.height, { scale: frame.scale });

  // Pointer positions arrive in CSS pixels and the UI thinks in UI pixels.
  // One conversion, in one place.
  const toUi = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = canvas.getBoundingClientRect();
    return {
      x: Math.floor(((clientX - box.left) * dpr) / frame.scale),
      y: Math.floor(((clientY - box.top) * dpr) / frame.scale),
    };
  };

  let now = 0;
  const send = (event: UiEvent): void => {
    root.handle(event);
  };

  canvas.addEventListener('mousemove', (event) => {
    const pos = toUi(event.clientX, event.clientY);
    send({ kind: 'pointer', phase: 'move', pos, button: -1, mods: modifiersOf(event), time: now });
    if (scene) {
      const under = root.content.hitTest(pos);
      scene.tooltip.point(under ? under.name : null, pos, now);
    }
    if (bag) bag.hover(pos, now);
  });
  canvas.addEventListener('mousedown', (event) => {
    const pos = toUi(event.clientX, event.clientY);
    const hit = root.content.hitTest(pos);
    root.focus.focus(hit);
    send({ kind: 'pointer', phase: 'down', pos, button: event.button, mods: modifiersOf(event), time: now });
  });
  globalThis.addEventListener('mouseup', (event) => {
    send({ kind: 'pointer', phase: 'up', pos: toUi(event.clientX, event.clientY), button: event.button, mods: modifiersOf(event), time: now });
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    send({ kind: 'wheel', pos: toUi(event.clientX, event.clientY), delta: -Math.sign(event.deltaY), mods: NO_MODIFIERS, time: now });
  }, { passive: false });
  globalThis.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      root.moveFocus(event.shiftKey ? -1 : 1);
      return;
    }
    send({ kind: 'key', phase: 'down', code: event.code, mods: modifiersOf(event), time: now });
    if (event.key.length === 1) send({ kind: 'text', text: event.key, time: now });
  });

  const samples: number[] = [];
  let drawCalls = 0;

  const draw = (timestamp: number): void => {
    now = timestamp;
    const started = performance.now();
    root.update(timestamp);
    scene?.tooltip.update(timestamp, THEME.input.tooltipDelayMs);
    bag?.tooltip.update(timestamp, THEME.input.tooltipDelayMs);
    // Driven every frame on purpose: this scene is here to prove that a screen
    // whose numbers change sixty times a second still costs no layout, and the
    // probe reports the milliseconds it takes.
    play?.tick(timestamp);
    const list = root.paint();
    const commands = list.finish();
    drawCalls = commands.length;
    replay(surface, commands);
    samples.push(performance.now() - started);
    if (samples.length > 120) samples.shift();
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);

  /**
   * The cross-backend check, run on demand from the preview script.
   *
   * `drawImage` at integer coordinates with smoothing off is a plain blit, and
   * so is the software rasterizer, so the two should agree byte for byte. This
   * is the assertion that would have caught spec 101's failure -- a pass whose
   * offscreen measurements were all correct while the screen was black.
   */
  globalThis.setTimeout(() => {
    // Cleared to *transparent*, not to the page's background colour. The
    // question this asks is "did canvas2d draw the same commands as raster", and
    // a canvas is transparent where nothing was drawn -- so clearing the
    // reference to ink would compare backgrounds instead, and fail on the first
    // empty pixel of any scene that does not cover the whole viewport. The
    // golden PNGs still bake on ink, because there the background is part of the
    // picture.
    const reference = new RasterSurface(atlas, frame.width, frame.height);
    reference.clear();
    replay(reference, root.paint().finish());

    const actual = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height);
    let mismatch: string | null = null;
    if (actual) {
      outer: for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          // Sample the centre of each upscaled block, so the comparison is about
          // the pixels and not about how the browser laid them out.
          const sx = x * frame.scale + Math.floor(frame.scale / 2);
          const sy = y * frame.scale + Math.floor(frame.scale / 2);
          const offset = (sy * canvas.width + sx) * 4;
          const expected = reference.pixelAt(x, y);
          const got = {
            r: actual.data[offset] ?? 0,
            g: actual.data[offset + 1] ?? 0,
            b: actual.data[offset + 2] ?? 0,
          };
          if (expected.a === 0) continue;
          if (got.r !== expected.r || got.g !== expected.g || got.b !== expected.b) {
            mismatch = `(${x}, ${y}) canvas rgb(${got.r},${got.g},${got.b}) vs raster rgb(${expected.r},${expected.g},${expected.b})`;
            break outer;
          }
        }
      }
    }

    const sorted = [...samples].sort((a, b) => a - b);
    (globalThis as { __uiProbe?: Probe }).__uiProbe = {
      frameMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
      drawCalls,
      viewport: { width: frame.width, height: frame.height },
      scale: frame.scale,
      matchesRaster: mismatch === null,
      firstMismatch: mismatch,
    };
  }, 1200);
}

/**
 * The keybinding window in a window (spec 125).
 *
 * A third scene rather than a seventh window in the six-window one, so the frame
 * budget that scene measures keeps meaning what it says.
 */
function buildKeysScene(viewport: { width: number; height: number }): {
  root: LayerStack;
  manager: WindowManager;
} {
  const map = new InputMap();
  const screen = new KeybindingsScreen({ theme: THEME, map, contexts: new ContextStack() });
  screen.buildAllTabs();
  const window = new UiWindow(screen, {
    title: 'Keybindings',
    at: { x: 8, y: 8 },
    size: { width: viewport.width - 16, height: viewport.height - 16 },
  });
  const manager = new WindowManager();
  const layers = new LayerStack();
  layers.place('windows', manager);
  manager.register(window, 'keybindings');
  manager.setViewport(viewport);
  return { root: layers, manager };
}

/**
 * The inventory (spec 127), which is the one scene where the browser is checking
 * something the goldens cannot: a real drag, driven by a real pointer, through
 * the router rather than by calling the controller.
 */
function buildBagScene(viewport: { width: number; height: number }): {
  root: LayerStack;
  manager: WindowManager;
  tooltip: Tooltip;
  hover: (at: { x: number; y: number }, now: number) => void;
} {
  const layers = new LayerStack();
  const manager = new WindowManager();
  layers.place('windows', manager);

  const screen = new InventoryScreen({ theme: THEME, hitTest: (at) => layers.hitTest(at) });
  screen.setContainers(demoContainers());
  layers.place('dragGhost', screen.ghost);

  const tooltip = new Tooltip();
  tooltip.viewport = viewport;
  layers.place('tooltip', tooltip);

  const window = new UiWindow(new ScrollView(screen, 'inventoryScroll'), {
    title: 'Inventory',
    at: { x: 8, y: 8 },
    size: { width: Math.min(viewport.width - 16, 260), height: Math.min(viewport.height - 16, 220) },
    resizable: true,
  });
  manager.register(window, 'inventory');
  manager.setViewport(viewport);

  const hover = (at: { x: number; y: number }, now: number): void => {
    const under = layers.hitTest(at);
    const cell = under instanceof ItemSlot ? under : null;
    tooltip.point(cell ? screen.tooltipFor(cell) : null, at, now);
  };
  return { root: layers, manager, tooltip, hover };
}

/**
 * The HUD and the character sheet (spec 128), animating.
 *
 * The only scene here that is *updated* every frame rather than merely redrawn,
 * which is the whole point: the frame cost reported for it is the cost of a
 * fight, and the cross-backend comparison covers a cooldown wedge and a bar
 * partway along -- neither of which the static scenes contain.
 */
function buildPlayScene(viewport: { width: number; height: number }): {
  root: LayerStack;
  manager: WindowManager;
  tick: (nowMs: number) => void;
} {
  const layers = new LayerStack();
  const manager = new WindowManager();
  layers.place('windows', manager);

  const hud = new HudScreen({ theme: THEME });
  const frame = new Anchor('hudFrame');
  frame.pointerTransparent = true;
  frame.place(hud, 'bottomLeft');
  layers.place('hud', frame);

  const sheet = new CharacterScreen({ theme: THEME });
  sheet.setCharacter(demoCharacter([]));
  manager.register(
    new UiWindow(new ScrollView(sheet, 'sheetScroll'), {
      title: 'Character',
      at: { x: Math.max(8, viewport.width - 210), y: 8 },
      size: { width: Math.min(200, viewport.width - 16), height: Math.min(220, viewport.height - 16) },
      resizable: true,
    }),
    'character',
  );
  manager.setViewport(viewport);

  const tick = (nowMs: number): void => {
    // A six-second loop: health drains, the pool refills, two cooldowns run at
    // different rates and a cast comes and goes.
    const phase = (nowMs % 6000) / 6000;
    hud.setView({
      ...demoHud({
        cooldowns: { 1: Math.max(0, 1 - phase * 1.4), 5: Math.max(0, 1 - phase * 3) },
        resource: 8 + 42 * phase,
      }),
      health: { current: 20 + 118 * (1 - phase), max: 138 },
      cast: phase < 0.5 ? { name: 'Iron Maul', progress: phase * 2 } : null,
    });
  };
  return { root: layers, manager, tick };
}

/**
 * The shop and its dialog (spec 130).
 *
 * The scene that puts something in the `modal` layer for the first time, so the
 * cross-backend comparison finally covers a layer that was declared in spec 124
 * and never drawn.
 */
function buildShopScene(viewport: { width: number; height: number }): {
  root: LayerStack;
  manager: WindowManager;
} {
  const layers = new LayerStack();
  const manager = new WindowManager();
  layers.place('windows', manager);

  const contexts = new ContextStack();
  const screen = new ShopScreen({ theme: THEME, contexts });
  screen.setShop(demoShop({ buyback: true }));
  layers.place('modal', screen.dialog);

  manager.register(
    new UiWindow(new ScrollView(screen, 'shopScroll'), {
      title: 'Shop',
      at: { x: 8, y: 8 },
      size: { width: Math.min(220, viewport.width - 16), height: Math.min(260, viewport.height - 16) },
      resizable: true,
    }),
    'shop',
  );
  manager.setViewport(viewport);
  // Open on the question, so the modal is what a photograph shows.
  screen.askToSell(0);
  return { root: layers, manager };
}

main();