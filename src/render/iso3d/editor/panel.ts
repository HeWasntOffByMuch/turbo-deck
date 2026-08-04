import GUI from 'lil-gui';
import { DEFAULT_BRUSH, TERRAIN_TOOLS, type BrushSettings, type TerrainTool } from './brush.js';

/**
 * The editor's control panel (spec 050).
 *
 * `lil-gui` for every knob, per the brief: no custom UI framework, no dockable
 * panels. It binds straight to a mutable settings object, so the frame loop reads
 * live values without anything having to be pushed back and forth.
 *
 * This is the surface the later steps hang their tools off, which is why the
 * folders are named for what they do rather than for the brush that happens to
 * be the only occupant today.
 */

/** Ring colour per tool, so the cursor says which way the ground will move. */
export const TOOL_COLORS: Record<TerrainTool, number> = {
  raise: 0x8fe08f,
  lower: 0xe08f8f,
  smooth: 0x8fc8e0,
  flatten: 0xffe27a,
};

export interface EditorPanelOptions {
  /** Bound live: the loop reads this object every frame. */
  readonly brush: BrushSettings & { tool: TerrainTool; radius: number; strength: number; falloff: number };
  readonly onUndo: () => void;
  /** Called when the tool changes, so the cursor can retint. */
  readonly onToolChange: (tool: TerrainTool) => void;
}

export interface EditorPanel {
  readonly element: HTMLElement;
  /** Push the current values back into the controls. */
  refresh(): void;
  destroy(): void;
}

export function buildEditorPanel(opts: EditorPanelOptions): EditorPanel {
  const gui = new GUI({ title: 'Map editor', width: 260 });
  // Mounted by the caller into the editor's own overlay layer rather than
  // lil-gui's default fixed corner, which would float over every other tab.
  gui.domElement.style.position = 'static';

  const terrain = gui.addFolder('Terrain brush');
  terrain
    .add(opts.brush, 'tool', [...TERRAIN_TOOLS])
    .name('Tool')
    .onChange((tool: TerrainTool) => opts.onToolChange(tool));
  terrain.add(opts.brush, 'radius', 20, 600, 5).name('Radius');
  terrain.add(opts.brush, 'strength', 5, 400, 5).name('Strength /s');
  // 0 is a cookie-cutter edge and 1 is a soft dome; the default sits nearer the
  // soft end, which is what stops a stroke leaving a visible rim.
  terrain.add(opts.brush, 'falloff', 0, 1, 0.05).name('Falloff');

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

/** A fresh, mutable copy of the brush defaults for the panel to bind to. */
export function createBrushSettings(): BrushSettings & {
  tool: TerrainTool;
  radius: number;
  strength: number;
  falloff: number;
} {
  return { ...DEFAULT_BRUSH };
}
