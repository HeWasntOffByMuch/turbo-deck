import GUI from 'lil-gui';
import type { MapMarkerKind, PropKind } from '../../../terrain/index.js';
import { DEFAULT_BRUSH, TERRAIN_TOOLS, type TerrainTool } from './brush.js';
import { MARKER_KINDS } from './markers.js';
import { DEFAULT_SCATTER } from './scatter.js';

/**
 * The editor's control panel (spec 050/051).
 *
 * `lil-gui` for every knob, per the brief: no custom UI framework, no dockable
 * panels. It binds straight to one mutable settings object, so the frame loop
 * reads live values without anything having to be pushed back and forth.
 */

/** What left-drag does. The radius and the cursor are shared by all three. */
export type EditorMode = 'terrain' | 'scatter' | 'marker' | 'erase';

export const EDITOR_MODES: readonly EditorMode[] = ['terrain', 'scatter', 'marker', 'erase'];

/** Ring colour per mode and tool, so the cursor says what is about to happen. */
export const MODE_COLORS: Record<EditorMode, number> = {
  terrain: 0xffe27a,
  scatter: 0x8fe0b4,
  marker: 0xd0d0e8,
  erase: 0xe08f8f,
};
export const TOOL_COLORS: Record<TerrainTool, number> = {
  raise: 0x8fe08f,
  lower: 0xe08f8f,
  smooth: 0x8fc8e0,
  flatten: 0xffe27a,
};

/**
 * Everything the tools read, in one flat object.
 *
 * Flat because lil-gui binds to properties: a nested shape would need a
 * controller per level and a copy back into the tool structs every frame. The
 * tool modules take their own narrow slices of this.
 */
export interface EditorSettings {
  mode: EditorMode;
  /** Shared by every mode -- one cursor, one footprint. */
  radius: number;
  // Terrain brush
  tool: TerrainTool;
  strength: number;
  falloff: number;
  // Scatter
  species: PropKind;
  density: number;
  maxSlope: number;
  scaleMin: number;
  scaleMax: number;
  spacing: number;
  alignToNormal: boolean;
  // Markers
  markerKind: MapMarkerKind;
  showArena: boolean;
}

export function createEditorSettings(): EditorSettings {
  return {
    mode: 'terrain',
    radius: DEFAULT_BRUSH.radius,
    tool: DEFAULT_BRUSH.tool,
    strength: DEFAULT_BRUSH.strength,
    falloff: DEFAULT_BRUSH.falloff,
    species: DEFAULT_SCATTER.species,
    density: DEFAULT_SCATTER.density,
    maxSlope: DEFAULT_SCATTER.maxSlope,
    scaleMin: DEFAULT_SCATTER.scaleMin,
    scaleMax: DEFAULT_SCATTER.scaleMax,
    spacing: DEFAULT_SCATTER.spacing,
    alignToNormal: DEFAULT_SCATTER.alignToNormal,
    markerKind: 'spawn',
    showArena: true,
  };
}

/** The colour the cursor takes for the armed tool. */
export function cursorColor(settings: EditorSettings): number {
  return settings.mode === 'terrain' ? TOOL_COLORS[settings.tool] : MODE_COLORS[settings.mode];
}

export interface EditorPanelOptions {
  /** Bound live: the loop reads this object every frame. */
  readonly settings: EditorSettings;
  readonly onUndo: () => void;
  /** Called whenever the armed tool changes, so the cursor can retint. */
  readonly onArmChange: () => void;
}

export interface EditorPanel {
  readonly element: HTMLElement;
  refresh(): void;
  destroy(): void;
}

export function buildEditorPanel(opts: EditorPanelOptions): EditorPanel {
  const s = opts.settings;
  const gui = new GUI({ title: 'Map editor', width: 260 });
  // Mounted by the caller into the editor's own overlay layer rather than
  // lil-gui's default fixed corner, which would float over every other tab.
  gui.domElement.style.position = 'static';

  gui.add(s, 'mode', [...EDITOR_MODES]).name('Mode').onChange(opts.onArmChange);
  // Shared, so switching mode keeps the footprint you were working at.
  gui.add(s, 'radius', 20, 600, 5).name('Radius');

  const terrain = gui.addFolder('Terrain brush');
  terrain.add(s, 'tool', [...TERRAIN_TOOLS]).name('Tool').onChange(opts.onArmChange);
  terrain.add(s, 'strength', 5, 400, 5).name('Strength /s');
  // 0 is a cookie-cutter edge and 1 a soft dome; the default sits nearer the
  // soft end, which is what stops a stroke leaving a visible rim.
  terrain.add(s, 'falloff', 0, 1, 0.05).name('Falloff');

  const scatter = gui.addFolder('Scatter');
  scatter.add(s, 'species', ['tree', 'bush']).name('Species');
  scatter.add(s, 'density', 0.5, 60, 0.5).name('Per second');
  scatter.add(s, 'maxSlope', 0, 2, 0.05).name('Max slope');
  scatter.add(s, 'spacing', 0, 120, 5).name('Spacing');
  scatter.add(s, 'scaleMin', 0.2, 3, 0.05).name('Scale min');
  scatter.add(s, 'scaleMax', 0.2, 3, 0.05).name('Scale max');
  scatter.add(s, 'alignToNormal').name('Lie on slope');

  const markers = gui.addFolder('Markers');
  markers.add(s, 'markerKind', [...MARKER_KINDS]).name('Kind').onChange(opts.onArmChange);
  markers.add(s, 'showArena').name('Show arena bounds').onChange(opts.onArmChange);

  const edit = gui.addFolder('Edit');
  edit.add({ undo: opts.onUndo }, 'undo').name('Undo (Ctrl+Z)');

  return {
    element: gui.domElement,
    refresh(): void {
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
    },
    destroy(): void {
      gui.destroy();
    },
  };
}
