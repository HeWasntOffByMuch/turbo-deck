import GUI from 'lil-gui';
import { fenceStep } from './fence.js';
import {
  FENCE_STYLE_CHOICES,
  MARKER_CHOICES,
  MODE_CHOICES,
  MODE_COLORS,
  NEW_ROCK_TIER,
  PART_TOOL_CHOICES,
  PART_TOOL_COLORS,
  ROCK_TOOL_CHOICES,
  ROCK_TOOL_COLORS,
  SPAWNER_MONSTER_CHOICES,
  SPECIES_CHOICES,
  TERRAIN_TOOL_CHOICES,
  TOOL_COLORS,
  visibleGroups,
  type EditorMode,
  type EditorSettings,
  type ToolChoice,
} from './tools.js';

/**
 * The editor's control panel (spec 050/051, reshaped in 058).
 *
 * `lil-gui` for every knob, per the brief: no custom UI framework, no dockable
 * panels. It binds straight to one mutable settings object, so the frame loop
 * reads live values without anything having to be pushed back and forth.
 *
 * Two things it now does that a bare `lil-gui` does not, both for the same
 * reason -- the panel should answer "what will the left button do?" without
 * being read:
 *
 * - **Button strips.** Arming a tool used to mean opening a dropdown, which
 *   hides the choice you are making from the choice you have made. A row of
 *   rectangular buttons shows every tool at once with the armed one filled, and
 *   filled in *that tool's cursor colour*, so the panel and the ring on the
 *   ground are visibly the same statement.
 * - **One tool's settings at a time.** See `visibleGroups`.
 *
 * The strips are raw DOM rather than a lil-gui widget because lil-gui has no
 * such widget; they are mounted inside its own contents container so they
 * inherit its width, spacing and dark theme rather than floating over it.
 */

/** What every button in a strip looks like before it is armed. */
const BUTTON_CSS =
  'appearance:none;border:1px solid #3c3c46;border-radius:2px;background:#1f1f26;color:#c8c8d2;' +
  "font-family:'Courier New',ui-monospace,monospace;font-size:10px;letter-spacing:.08em;" +
  'text-transform:uppercase;padding:6px 2px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;';

const STRIP_CSS = 'display:grid;gap:4px;padding:6px 8px 8px;';

/** `#rrggbb` for a lil-gui-style hex number. */
const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

interface Strip {
  readonly element: HTMLElement;
  refresh(): void;
}

/**
 * A row of rectangular buttons over a fixed set of choices.
 *
 * `armedColor` is a function rather than a colour because the terrain strip's
 * fill is per-*button* (each tool has its own cursor colour) while the mode
 * strip's is per-mode -- one shape covers both.
 */
function buttonStrip<T extends string>(
  choices: readonly ToolChoice<T>[],
  columns: number,
  read: () => T,
  arm: (value: T) => void,
  armedColor: (value: T) => number,
): Strip {
  const element = document.createElement('div');
  element.style.cssText = `${STRIP_CSS}grid-template-columns:repeat(${columns},1fr);`;
  const buttons = choices.map((choice) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = choice.label;
    button.title = choice.label;
    button.style.cssText = BUTTON_CSS;
    button.addEventListener('click', () => {
      arm(choice.value);
      // Every strip in the panel refreshes, not just this one: arming a mode
      // changes which strips are on screen at all.
      element.dispatchEvent(new CustomEvent('editor-armed', { bubbles: true }));
    });
    element.appendChild(button);
    return { choice, button };
  });

  const refresh = (): void => {
    const armed = read();
    for (const { choice, button } of buttons) {
      const on = choice.value === armed;
      // The armed button is filled in its own tool's colour; the rest stay flat,
      // so which one is on is readable at a glance rather than by comparison.
      button.style.background = on ? hex(armedColor(choice.value)) : '#1f1f26';
      button.style.color = on ? '#12121a' : '#c8c8d2';
      button.style.borderColor = on ? hex(armedColor(choice.value)) : '#3c3c46';
      button.style.fontWeight = on ? '700' : '400';
    }
  };
  refresh();
  return { element, refresh };
}

/**
 * Where lil-gui puts a GUI's or a folder's contents.
 *
 * By class rather than by index: `domElement` holds a title and this, and
 * appending a strip to `domElement` itself drops it *under* the controllers
 * instead of above them -- which is how the tool picker ended up at the bottom
 * of the panel the first time.
 */
function contents(gui: GUI): HTMLElement {
  return (gui.domElement.querySelector('.lil-children') as HTMLElement | null) ?? gui.domElement;
}

export interface EditorPanelOptions {
  /** Bound live: the loop reads this object every frame. */
  readonly settings: EditorSettings;
  readonly onUndo: () => void;
  /** Called whenever the armed tool changes, so the cursor can retint. */
  readonly onArmChange: () => void;
  /** The nav overlay was toggled. */
  readonly onNavChange: () => void;
  /** The walk limit moved, so the whole layer needs re-baking. */
  readonly onNavRebake: () => void;
  readonly onSave: () => void;
  readonly onLoad: () => void;
  readonly onDiscardAutosave: () => void;
  /** The recipes a part may be grown from, by name (spec 084). */
  readonly recipeNames: readonly string[];
  /** Remove the part named in the dropdown, for when clicking one is awkward. */
  readonly onRemoveNamedPart: () => void;
  /** The parts currently in the map, re-read whenever the panel refreshes. */
  readonly partIds: () => readonly string[];
  /** The tier layers currently in the map, newest last (spec 123). */
  readonly rockLayerIds: () => readonly string[];
}

export interface EditorPanel {
  readonly element: HTMLElement;
  refresh(): void;
  /** Re-read the parts list, after one has been added or removed (spec 084). */
  refreshParts(): void;
  destroy(): void;
}

export function buildEditorPanel(opts: EditorPanelOptions): EditorPanel {
  const s = opts.settings;
  const gui = new GUI({ title: 'Map editor', width: 260 });
  // Mounted by the caller into the editor's own overlay layer rather than
  // lil-gui's default fixed corner, which would float over every other tab.
  gui.domElement.style.position = 'static';

  const strips: Strip[] = [];
  /** Re-read everything the armed tool decides: the strips and what is on show. */
  const armed = (): void => {
    for (const each of strips) each.refresh();
    applyVisibility(s.mode);
    opts.onArmChange();
  };
  gui.domElement.addEventListener('editor-armed', armed);

  const strip = <T extends string>(
    into: GUI,
    choices: readonly ToolChoice<T>[],
    columns: number,
    read: () => T,
    arm: (value: T) => void,
    color: (value: T) => number,
  ): void => {
    const built = buttonStrip(choices, columns, read, arm, color);
    contents(into).appendChild(built.element);
    strips.push(built);
  };

  // The tool picker, first thing in the panel: what the left button does.
  strip(
    gui,
    MODE_CHOICES,
    3,
    () => s.mode,
    (mode: EditorMode) => {
      s.mode = mode;
    },
    (mode) => (mode === 'terrain' ? TOOL_COLORS[s.tool] : MODE_COLORS[mode]),
  );

  // Shared by the modes that work under a circle, so switching between them
  // keeps the footprint you were working at.
  const radius = gui.add(s, 'radius', 20, 600, 5).name('Radius');

  const terrain = gui.addFolder('Terrain brush');
  strip(
    terrain,
    TERRAIN_TOOL_CHOICES,
    2,
    () => s.tool,
    (tool) => {
      s.tool = tool;
    },
    (tool) => TOOL_COLORS[tool],
  );
  terrain.add(s, 'strength', 5, 400, 5).name('Strength /s');
  // 0 is a cookie-cutter edge and 1 a soft dome; the default sits nearer the
  // soft end, which is what stops a stroke leaving a visible rim.
  terrain.add(s, 'falloff', 0, 1, 0.05).name('Falloff');

  const scatter = gui.addFolder('Scatter');
  strip(
    scatter,
    SPECIES_CHOICES,
    2,
    () => s.species,
    (species) => {
      s.species = species;
    },
    () => MODE_COLORS.scatter,
  );
  scatter.add(s, 'density', 0.5, 60, 0.5).name('Per second');
  scatter.add(s, 'maxSlope', 0, 2, 0.05).name('Max slope');
  scatter.add(s, 'spacing', 0, 120, 5).name('Spacing');
  scatter.add(s, 'scaleMin', 0.2, 3, 0.05).name('Scale min');
  scatter.add(s, 'scaleMax', 0.2, 3, 0.05).name('Scale max');
  scatter.add(s, 'alignToNormal').name('Lie on slope');

  const fence = gui.addFolder('Fence');
  strip(
    fence,
    FENCE_STYLE_CHOICES,
    2,
    () => s.style,
    (style) => {
      s.style = style;
    },
    () => MODE_COLORS.fence,
  );
  // Drives the tile's length as well as its height, so a run still meets end to
  // end; the readout is there because "1.4" means nothing on its own.
  const size = fence.add(s, 'fenceScale', 0.5, 2.5, 0.1).name('Size');
  const readout = { tile: '' };
  const tile = fence.add(readout, 'tile').name('Tile length').disable();
  const showTileLength = (): void => {
    readout.tile = `${Math.round(fenceStep(s))} units`;
    tile.updateDisplay();
  };
  showTileLength();
  size.onChange(showTileLength);
  // Set per tile as it is laid, so it changes what you paint next rather than
  // what is already on the ground.
  fence.add(s, 'variedColor').name('Colour variety');

  const markers = gui.addFolder('Markers');
  strip(
    markers,
    MARKER_CHOICES,
    2,
    () => s.markerKind,
    (kind) => {
      s.markerKind = kind;
    },
    () => MODE_COLORS.marker,
  );
  // Always shown rather than revealed with the `spawner` kind: the strip above
  // is two columns of buttons, and a control that appears and disappears under
  // them moves everything below it every time you change your mind.
  markers.add(s, 'spawnerMonster', SPAWNER_MONSTER_CHOICES.map((c) => c.value)).name('Spawner monster');

  const parts = gui.addFolder('Parts');
  strip(
    parts,
    PART_TOOL_CHOICES,
    2,
    () => s.partTool,
    (tool) => {
      s.partTool = tool;
    },
    (tool) => PART_TOOL_COLORS[tool],
  );
  // A dropdown rather than a text field: a recipe is a committed file (spec
  // 081), so the set is known, and a typo should not be something you discover
  // when the bake throws.
  parts
    .add(s, 'recipe', opts.recipeNames.length > 0 ? opts.recipeNames : [''])
    .name('Recipe')
    .onChange(opts.onArmChange);
  parts.add(s, 'partSeed', 0, 9999, 1).name('Seed');
  parts.add(s, 'partId').name('Id (blank = recipe)');
  // Removing by name as well as by click, because a part can be entirely
  // off-screen once the world is a few thousand units across.
  //
  // Both controllers are rebuilt together, and only when the list actually
  // changes. `options()` does not update a dropdown -- it destroys the
  // controller and appends a replacement (lil-gui's own docs call this out), so
  // the handle goes stale after one call and the panel reorders itself. These
  // two are the last controls in the folder, so re-appending them in order
  // leaves the layout exactly where it was.
  let removeName = parts.add(s, 'removePartId', ['']).name('Remove named');
  let removeButton = parts.add({ remove: opts.onRemoveNamedPart }, 'remove').name('Remove that part');
  let shownIds = '';

  /** Re-read the parts list into the dropdown; the map gains and loses them. */
  const refreshPartIds = (): void => {
    const ids = opts.partIds();
    const signature = ids.join('\u0000');
    if (signature === shownIds) return;
    shownIds = signature;

    const options = ids.length > 0 ? [...ids] : [''];
    if (!options.includes(s.removePartId)) s.removePartId = options[0] ?? '';
    removeName.destroy();
    removeButton.destroy();
    removeName = parts.add(s, 'removePartId', options).name('Remove named');
    removeButton = parts.add({ remove: opts.onRemoveNamedPart }, 'remove').name('Remove that part');
  };

  const view = gui.addFolder('View');
  view.add(s, 'showArena').name('Arena bounds').onChange(opts.onArmChange);
  // Off by default: a diagnostic, not a view mode.
  view.add(s, 'showNav').name('Walkability').onChange(opts.onNavChange);
  view.add(s, 'walkSlope', 0.05, 1.5, 0.05).name('Walk slope').onChange(opts.onNavRebake);

  const edit = gui.addFolder('Edit');
  edit.add({ undo: opts.onUndo }, 'undo').name('Undo (Ctrl+Z)');

  const file = gui.addFolder('File');
  file.add({ save: opts.onSave }, 'save').name('Save to file');
  file.add({ load: opts.onLoad }, 'load').name('Load file (or drop one)');
  file.add({ discard: opts.onDiscardAutosave }, 'discard').name('Discard autosave');

  const rock = gui.addFolder('Rock');
  strip(
    rock,
    ROCK_TOOL_CHOICES,
    2,
    () => s.rockTool,
    (tool) => {
      s.rockTool = tool;
    },
    (tool) => ROCK_TOOL_COLORS[tool],
  );
  // Relative, and labelled as such: the number is how far this tier stands over
  // whatever the drag lands on, so the same value builds the second storey of a
  // stack as built the first.
  rock.add(s, 'rockHeight', 30, 260, 5).name('Height above');

  // The tier a drag extends, or a new one. Rebuilt rather than updated for the
  // same reason the parts dropdown is: `options()` destroys the controller and
  // appends a replacement, so the handle goes stale after one call. This is the
  // last control in its folder, so re-appending leaves the layout put.
  let tierName = rock.add(s, 'rockLayer', [NEW_ROCK_TIER]).name('Tier');
  let shownTiers = '';
  const refreshRockLayers = (): void => {
    const ids = opts.rockLayerIds();
    const joined = ids.join('\u0000');
    if (joined === shownTiers) return;
    shownTiers = joined;
    const options = [NEW_ROCK_TIER, ...ids];
    if (!options.includes(s.rockLayer)) s.rockLayer = NEW_ROCK_TIER;
    tierName.destroy();
    tierName = rock.add(s, 'rockLayer', options).name('Tier');
  };
  refreshRockLayers();

  /** Show only what the armed mode uses. */
  function applyVisibility(mode: EditorMode): void {
    const show = visibleGroups(mode);
    radius.show(show.radius);
    terrain.show(show.terrain);
    scatter.show(show.scatter);
    fence.show(show.fence);
    markers.show(show.marker);
    parts.show(show.part);
    rock.show(show.rock);
    // A folder that is hidden and closed comes back closed, which reads as an
    // empty panel the first time a tool is armed.
    for (const [folder, on] of [
      [terrain, show.terrain],
      [scatter, show.scatter],
      [fence, show.fence],
      [markers, show.marker],
      [parts, show.part],
      [rock, show.rock],
    ] as const) {
      if (on) folder.open();
    }
  }
  applyVisibility(s.mode);

  return {
    element: gui.domElement,
    refreshParts: (): void => {
      refreshPartIds();
      refreshRockLayers();
    },
    refresh(): void {
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      for (const each of strips) each.refresh();
      showTileLength();
      refreshPartIds();
      refreshRockLayers();
      applyVisibility(s.mode);
    },
    destroy(): void {
      gui.domElement.removeEventListener('editor-armed', armed);
      gui.destroy();
    },
  };
}
