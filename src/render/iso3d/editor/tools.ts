import type { MapMarkerKind, PropKind } from '../../../terrain/index.js';
import { DEFAULT_BRUSH, TERRAIN_TOOLS, type TerrainTool } from './brush.js';
import { DEFAULT_FENCE, FENCE_STYLES, fenceStep, type FenceStyle } from './fence.js';
import { MARKER_KINDS } from './markers.js';
import { DEFAULT_WALK_SLOPE } from './nav.js';
import { DEFAULT_SCATTER } from './scatter.js';

/**
 * What the editor's tools are, and what the panel shows for each (spec 050/051,
 * reshaped in 056).
 *
 * Split out of `panel.ts` so it imports no `lil-gui` and touches no DOM: what
 * the panel *decides* -- which mode is armed, which settings belong to it, what
 * colour and size the cursor takes -- is then testable in Node, and only the
 * widget-building half stays untested. That split is the same one the rest of
 * the editor is built on, one step smaller.
 */

/** What left-drag does. */
export type EditorMode = 'terrain' | 'scatter' | 'fence' | 'marker' | 'erase';

export const EDITOR_MODES: readonly EditorMode[] = ['terrain', 'scatter', 'fence', 'marker', 'erase'];

/** Ring colour per mode and tool, so the cursor says what is about to happen. */
export const MODE_COLORS: Record<EditorMode, number> = {
  terrain: 0xffe27a,
  scatter: 0x8fe0b4,
  fence: 0xd8a878,
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
  /** Shared by the modes that work under a circle -- one cursor, one footprint. */
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
  // Fence
  style: FenceStyle;
  fenceScale: number;
  variedColor: boolean;
  // Markers
  markerKind: MapMarkerKind;
  showArena: boolean;
  // Nav
  showNav: boolean;
  walkSlope: number;
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
    style: DEFAULT_FENCE.style,
    fenceScale: DEFAULT_FENCE.fenceScale,
    variedColor: DEFAULT_FENCE.variedColor,
    markerKind: 'spawn',
    showArena: true,
    showNav: false,
    walkSlope: DEFAULT_WALK_SLOPE,
  };
}

/** The colour the cursor takes for the armed tool. */
export function cursorColor(settings: EditorSettings): number {
  return settings.mode === 'terrain' ? TOOL_COLORS[settings.tool] : MODE_COLORS[settings.mode];
}

/** The ring a marker drops under, since it has no radius of its own to show. */
export const MARKER_CURSOR_RADIUS = 30;

/**
 * How wide the ring on the ground is drawn.
 *
 * Not always `settings.radius`, because not every tool works under a circle. A
 * fence is laid a tile at a time, so its ring is half a tile: what the ring is
 * for is showing the footprint of the thing about to land, and a fence's
 * footprint has nothing to do with the brush width.
 */
export function cursorRadius(settings: EditorSettings): number {
  if (settings.mode === 'fence') return fenceStep(settings) / 2;
  if (settings.mode === 'marker') return MARKER_CURSOR_RADIUS;
  return settings.radius;
}

/**
 * Which of the panel's groups the armed mode wants shown.
 *
 * The panel used to show all of them at once -- terrain strength while the
 * scatter was armed, scatter spacing while the eraser was. Nothing in a mode's
 * settings is any use while another mode is armed, and a panel that shows them
 * anyway makes the reader do the filtering.
 */
export interface ToolVisibility {
  readonly radius: boolean;
  readonly terrain: boolean;
  readonly scatter: boolean;
  readonly fence: boolean;
  readonly marker: boolean;
}

export function visibleGroups(mode: EditorMode): ToolVisibility {
  return {
    // The fence lays a fixed tile and a marker is a point: neither has a
    // footprint for the radius to set.
    radius: mode === 'terrain' || mode === 'scatter' || mode === 'erase',
    terrain: mode === 'terrain',
    scatter: mode === 'scatter',
    fence: mode === 'fence',
    marker: mode === 'marker',
  };
}

/** A button in one of the panel's strips: the value it arms and its label. */
export interface ToolChoice<T extends string> {
  readonly value: T;
  readonly label: string;
}

const choices = <T extends string>(
  values: readonly T[],
  labels: Partial<Record<T, string>> = {},
): readonly ToolChoice<T>[] => values.map((value) => ({ value, label: labels[value] ?? value.replace(/-/g, ' ') }));

export const MODE_CHOICES = choices(EDITOR_MODES);
export const TERRAIN_TOOL_CHOICES = choices(TERRAIN_TOOLS);
export const MARKER_CHOICES = choices(MARKER_KINDS);
/**
 * Labelled by what they look like rather than by their stored id: 'wood' is
 * written into saved maps and cannot be renamed, but a button that says WOOD
 * next to one that says BOARDS tells you nothing (spec 057).
 */
export const FENCE_STYLE_CHOICES = choices(FENCE_STYLES, { wood: 'picket' });
/**
 * What the scatter may plant. Not every `PropKind`: the fence kinds are laid a
 * tile at a time along a path and would be nonsense sprinkled over an area.
 */
export const SPECIES_CHOICES = choices(['tree', 'bush'] as const satisfies readonly PropKind[]);
