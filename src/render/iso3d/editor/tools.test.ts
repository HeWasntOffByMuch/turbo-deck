import { describe, expect, it } from 'vitest';
import { TERRAIN_TOOLS } from './brush.js';
import { fenceStep, FENCE_STYLES } from './fence.js';
import { MARKER_KINDS } from './markers.js';
import { PAINT_MATERIALS } from './paint.js';
import {
  createEditorSettings,
  cursorColor,
  cursorRadius,
  EDITOR_MODES,
  FENCE_STYLE_CHOICES,
  MARKER_CHOICES,
  MARKER_CURSOR_RADIUS,
  markerKindEffect,
  MODE_CHOICES,
  MODE_COLORS,
  PAINT_COLORS,
  PAINT_MATERIAL_CHOICES,
  TERRAIN_TOOL_CHOICES,
  TOOL_COLORS,
  visibleGroups,
  type EditorMode,
  type EditorSettings,
} from './tools.js';

/**
 * Spec 058. The panel's *decisions* -- which tool is armed, whose settings that
 * puts on screen, what the ring on the ground says -- are here rather than in
 * `panel.ts`, which is why they can be tested at all: `panel.ts` is lil-gui and
 * a DOM, and this is a pure function of the settings object.
 */

const armed = (mode: EditorMode, over: Partial<EditorSettings> = {}): EditorSettings => ({
  ...createEditorSettings(),
  mode,
  ...over,
});

describe('which settings a mode shows', () => {
  it('shows exactly one tool group per mode, and covers every mode', () => {
    for (const mode of EDITOR_MODES) {
      const show = visibleGroups(mode);
      const groups = [show.terrain, show.paint, show.scatter, show.fence, show.marker, show.part, show.rock].filter(
        Boolean,
      ).length;
      // The eraser has no settings of its own beyond the shared radius; every
      // other mode has exactly one group, and none has two.
      expect(groups).toBe(mode === 'erase' ? 0 : 1);
    }
  });

  it('names the group after the mode, so nothing else can be on screen', () => {
    expect(visibleGroups('terrain')).toMatchObject({ terrain: true, paint: false, scatter: false, fence: false });
    expect(visibleGroups('paint')).toMatchObject({ terrain: false, paint: true, scatter: false, fence: false });
    expect(visibleGroups('scatter')).toMatchObject({ terrain: false, scatter: true, fence: false, marker: false });
    expect(visibleGroups('fence')).toMatchObject({ terrain: false, scatter: false, fence: true, marker: false });
    expect(visibleGroups('marker')).toMatchObject({ terrain: false, scatter: false, fence: false, marker: true });
  });

  it('shows the shared radius only for the tools that work under a circle', () => {
    // A fence lays a fixed tile and a marker is a point: a radius slider that
    // changes nothing is worse than no slider.
    expect(visibleGroups('terrain').radius).toBe(true);
    expect(visibleGroups('paint').radius).toBe(true);
    expect(visibleGroups('scatter').radius).toBe(true);
    expect(visibleGroups('erase').radius).toBe(true);
    expect(visibleGroups('fence').radius).toBe(false);
    expect(visibleGroups('marker').radius).toBe(false);
  });

  it('shows the falloff only for the two brushes that weight their footprint', () => {
    // The eraser takes everything under its circle whole and the scatter has a
    // density, so neither has anything for a weight to weight.
    expect(visibleGroups('terrain').falloff).toBe(true);
    expect(visibleGroups('paint').falloff).toBe(true);
    for (const mode of EDITOR_MODES) {
      if (mode === 'terrain' || mode === 'paint') continue;
      expect(visibleGroups(mode).falloff).toBe(false);
    }
  });
});

describe('what the cursor says', () => {
  it('takes the armed terrain tool\'s colour, not the mode\'s', () => {
    // Four terrain tools that do very different things to the ground share one
    // mode, so the mode's colour would be the same ring for raise and lower.
    for (const tool of TERRAIN_TOOLS) {
      expect(cursorColor(armed('terrain', { tool }))).toBe(TOOL_COLORS[tool]);
    }
    expect(new Set(TERRAIN_TOOLS.map((tool) => TOOL_COLORS[tool])).size).toBe(TERRAIN_TOOLS.length);
  });

  it('takes the loaded material\'s colour in paint mode (spec 179)', () => {
    // Five materials that lay down five different grounds share one mode, so a
    // single mode colour would be one ring for snow and for dirt. The swatch is
    // the ground's own colour, which is what makes the palette a palette.
    for (const material of PAINT_MATERIALS) {
      expect(cursorColor(armed('paint', { paintMaterial: material }))).toBe(PAINT_COLORS[material]);
    }
    expect(new Set(PAINT_MATERIALS.map((m) => PAINT_COLORS[m])).size).toBe(PAINT_MATERIALS.length);
  });

  it('takes the mode\'s colour otherwise, and no two modes share one', () => {
    for (const mode of EDITOR_MODES) {
      if (mode === 'terrain' || mode === 'paint') continue;
      expect(cursorColor(armed(mode))).toBe(MODE_COLORS[mode]);
    }
    // `terrain` and `paint` keep an entry each even though `cursorColor` never
    // reaches for them: the ring is decided per sub-tool, and the Record is what
    // makes a mode added without a colour a type error rather than a black ring.
    expect(new Set(EDITOR_MODES.map((m) => MODE_COLORS[m])).size).toBe(EDITOR_MODES.length);
  });

  it('draws the ring at the brush radius for the tools that have one', () => {
    for (const mode of ['terrain', 'paint', 'scatter', 'erase'] as const) {
      expect(cursorRadius(armed(mode, { radius: 175 }))).toBe(175);
    }
  });

  it('draws a fence\'s ring at half a tile, so it shows what is about to land', () => {
    const settings = armed('fence', { radius: 400, fenceScale: 1.5 });
    expect(cursorRadius(settings)).toBeCloseTo(fenceStep(settings) / 2, 6);
    // ...and it follows the size, rather than being a constant that drifts.
    expect(cursorRadius(armed('fence', { fenceScale: 2 }))).toBeGreaterThan(
      cursorRadius(armed('fence', { fenceScale: 1 })),
    );
  });

  it('draws a marker\'s ring at a fixed size, since a marker has no footprint', () => {
    expect(cursorRadius(armed('marker', { radius: 500 }))).toBe(MARKER_CURSOR_RADIUS);
  });
});

describe('the button strips', () => {
  it('offers every mode and every terrain tool, in order', () => {
    expect(MODE_CHOICES.map((c) => c.value)).toEqual([...EDITOR_MODES]);
    expect(TERRAIN_TOOL_CHOICES.map((c) => c.value)).toEqual([...TERRAIN_TOOLS]);
    expect(PAINT_MATERIAL_CHOICES.map((c) => c.value)).toEqual([...PAINT_MATERIALS]);
    expect(MARKER_CHOICES.map((c) => c.value)).toEqual([...MARKER_KINDS]);
    expect(FENCE_STYLE_CHOICES.map((c) => c.value)).toEqual([...FENCE_STYLES]);
  });

  it('labels every button, distinctly within its strip', () => {
    for (const strip of [
      MODE_CHOICES,
      TERRAIN_TOOL_CHOICES,
      PAINT_MATERIAL_CHOICES,
      MARKER_CHOICES,
      FENCE_STYLE_CHOICES,
    ]) {
      for (const choice of strip) expect(choice.label.length).toBeGreaterThan(0);
      // Two buttons reading the same is worse than one reading badly.
      expect(new Set(strip.map((c) => c.label)).size).toBe(strip.length);
    }
  });

  it('labels the fence styles by what they look like, not by their stored ids', () => {
    // 'wood' is in saved maps and cannot be renamed, but WOOD beside BOARDS
    // says nothing about which is which.
    const label = (value: string): string | undefined =>
      FENCE_STYLE_CHOICES.find((c) => c.value === value)?.label;
    expect(label('wood')).toBe('picket');
    expect(FENCE_STYLE_CHOICES.map((c) => c.label)).toEqual(['picket', 'boards', 'brick', 'rubble']);
  });
});

describe('the settings object', () => {
  it('opens on the terrain brush with every tool\'s defaults filled in', () => {
    const s = createEditorSettings();
    expect(s.mode).toBe('terrain');
    // Each tool reads its own slice, so a missing default is a tool that starts
    // broken rather than a type error.
    for (const key of ['radius', 'strength', 'falloff', 'density', 'fenceScale', 'walkSlope'] as const) {
      expect(Number.isFinite(s[key])).toBe(true);
    }
    expect(FENCE_STYLES).toContain(s.style);
    expect(MARKER_KINDS).toContain(s.markerKind);
  });
});

describe('telling the marker kinds apart (spec 178)', () => {
  it('arms the one kind anything reads', () => {
    // `spawn` was the default and is read by nothing, so the first marker
    // somebody placed did nothing at all.
    expect(createEditorSettings().markerKind).toBe('spawner');
  });

  it('does not put two near-identical words in the same strip', () => {
    // `spawn` and `spawner` differ by two letters, sit in one five-button grid,
    // and only one of them does anything. What the button says has to separate
    // them; what the map stores may not move -- it is a byte on the wire.
    const labels = MARKER_CHOICES.map((c) => c.label);
    const spawner = MARKER_CHOICES.find((c) => c.value === 'spawner');
    expect(spawner?.label).toBe('monster');
    for (const a of labels) {
      for (const b of labels) {
        if (a === b) continue;
        expect(a.startsWith(b)).toBe(false);
      }
    }
  });

  it('keeps every stored kind, whatever the buttons say', () => {
    expect(MARKER_CHOICES.map((c) => c.value)).toEqual([...MARKER_KINDS]);
  });

  it('says which kinds are sockets with nothing plugged in', () => {
    expect(markerKindEffect('spawner')).toMatch(/spawns the monster/);
    for (const kind of MARKER_KINDS) {
      if (kind === 'spawner') continue;
      // Not a description of an effect it does not have: four of the five are
      // written to the map and read by nobody, and the panel says so.
      expect(markerKindEffect(kind)).toMatch(/nothing reads it yet/);
    }
  });
});
