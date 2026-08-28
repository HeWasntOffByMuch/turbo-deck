import {
  isFixtureKind,
  PLACED_KINDS,
  type MapMarker,
  type MapMarkerKind,
  type PlacedKind,
  type PropKind,
} from '../../../terrain/index.js';
import { ALL_MONSTERS } from '../../../server/data/monsters.js';
import { DEFAULT_BRUSH, TERRAIN_TOOLS, type TerrainTool } from './brush.js';
import { DEFAULT_PAINT_MATERIAL, PAINT_MATERIALS, type PaintMaterial } from './paint.js';
import { DEFAULT_FENCE, FENCE_STYLES, fenceStep, type FenceStyle } from './fence.js';
import { DEFAULT_STRUCTURE, structureFootprint } from './structure.js';
import { MARKER_KINDS, type MarkerPatch } from './markers.js';
import { TERRAIN_COLORS } from '../palette.js';
import { DEFAULT_SCATTER } from './scatter.js';

/**
 * What the editor's tools are, and what the panel shows for each (spec 050/051,
 * reshaped in 058).
 *
 * Split out of `panel.ts` so it imports no `lil-gui` and touches no DOM: what
 * the panel *decides* -- which mode is armed, which settings belong to it, what
 * colour and size the cursor takes -- is then testable in Node, and only the
 * widget-building half stays untested. That split is the same one the rest of
 * the editor is built on, one step smaller.
 */

/** What left-drag does. */
export type EditorMode =
  | 'terrain'
  | 'paint'
  | 'scatter'
  | 'fence'
  | 'structure'
  | 'marker'
  | 'select'
  | 'erase'
  | 'part'
  | 'rock';

export const EDITOR_MODES: readonly EditorMode[] = [
  'terrain',
  // Beside the terrain brush rather than at the end: the two share a footprint
  // and are the two halves of the same question -- what shape the ground is,
  // and what it is made of.
  'paint',
  'scatter',
  'fence',
  // Between the fence and the marker: the three tools that put a *thing* down
  // rather than reshaping ground, in order of how much of one each press makes
  // -- a run of tiles, one building, one point.
  'structure',
  'marker',
  // Beside the marker tool for the same reason paint is beside terrain: placing
  // one and correcting one are the two halves of the same question, and until
  // spec 222 only the first half existed.
  'select',
  'erase',
  'part',
  'rock',
];

/** What the part mode's drag does (spec 084). */
export type PartTool = 'add' | 'remove';

export const PART_TOOLS: readonly PartTool[] = ['add', 'remove'];

/** What the rock mode's drag does (spec 123). */
export type RockTool = 'add' | 'remove' | 'stair' | 'detail';

export const ROCK_TOOLS: readonly RockTool[] = ['add', 'remove', 'stair', 'detail'];

/**
 * The `rockLayer` value meaning "start a new tier".
 *
 * A formation is a stack of tiers and each tier is its own layer, so the choice
 * a drag needs is "extend the one I am working on" or "begin the next one up".
 * Empty rather than a sentinel id, so the panel's dropdown can show it as the
 * first entry without inventing a layer that does not exist.
 */
export const NEW_ROCK_TIER = '';

/** Ring colour per mode and tool, so the cursor says what is about to happen. */
export const MODE_COLORS: Record<EditorMode, number> = {
  terrain: 0xffe27a,
  // Overridden per material by `cursorColor`; this is only what the mode button
  // falls back to before one is chosen.
  paint: 0xc8823f,
  scatter: 0x8fe0b4,
  fence: 0xd8a878,
  // The straw the roofs are made of, so the ring says what is about to land.
  structure: 0xe0c070,
  marker: 0xd0d0e8,
  // Cyan: the one tool here that changes nothing by itself, so it wants a colour
  // no other ring on the ground is wearing.
  select: 0x6fd8e0,
  erase: 0xe08f8f,
  part: 0x9fb8e8,
  rock: 0x9aa4b0,
};
export const PART_TOOL_COLORS: Record<PartTool, number> = {
  add: 0x9fb8e8,
  remove: 0xe08f8f,
};
/** Grey for building a tier, red for taking one back -- the eraser's own red. */
export const ROCK_TOOL_COLORS: Record<RockTool, number> = {
  add: 0x9aa4b0,
  remove: 0xe08f8f,
  // The tread band's own warm dirt, so the cursor says which of the two the
  // drag is about to leave behind.
  stair: 0xc8a06a,
  // Moss green: the pass that puts grass and bushes on a tier.
  detail: 0x8fc07a,
};
/**
 * The colour for each paintable material: the ground's own, so the cursor ring
 * and the armed swatch both say what is about to be laid down. The same choice
 * `ROCK_TOOL_COLORS.stair` already makes, which is the warm dirt of the tread it
 * lays. Only the *armed* button is filled, as in every other strip in the panel
 * -- which one is on has to be readable at a glance rather than by comparison.
 *
 * The first of the material's two tones -- a cell takes one of the pair from a
 * noise field, and a swatch has to pick one.
 */
export const PAINT_COLORS: Record<PaintMaterial, number> = Object.fromEntries(
  PAINT_MATERIALS.map((material) => [material, TERRAIN_COLORS[material][0]]),
) as Record<PaintMaterial, number>;

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
  /** What the material brush is loaded with (spec 179). Shares radius and falloff. */
  paintMaterial: PaintMaterial;
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
  // Structures (spec 224)
  structure: PlacedKind;
  structureScale: number;
  /**
   * What a light fixture is placed burning at (spec 248).
   *
   * Nullable rather than optional, because this is a mutable settings object a
   * lil-gui row is bound to and a row cannot bind to a key that is not there.
   * Null means *the kind's own row*, which is what `fixtureOverride` turns back
   * into "write no override at all".
   */
  fixtureBrightness: number | null;
  fixtureRadius: number | null;
  /** Where the front faces, in degrees. See `structure.ts`. */
  structureYaw: number;
  // Markers
  markerKind: MapMarkerKind;
  /** Which monster a `spawner` marker spawns (spec 076). Ignored by other kinds. */
  spawnerMonster: string;
  showArena: boolean;
  // Select (spec 222). Deliberately its own set rather than reusing the marker
  // tool's above: what I am about to *place* and what I have *selected* are two
  // questions, and selecting a campfire must not silently re-arm the placement
  // dropdown to place campfires.
  /** The id of the selected marker, or `''` for nothing. Never a reference. */
  selectedMarkerId: string;
  selKind: MapMarkerKind;
  /** A spawner's monster, chosen from the roster rather than typed. */
  selMonster: string;
  /** Every other kind's free text -- a `trigger` named `boss-door` is worth reading. */
  selLabel: string;
  /** Seconds before this spawner refills. {@link SPAWNER_UNSET} = the server's own. */
  selRespawnSeconds: number;
  /** How far its body may be dragged. {@link SPAWNER_UNSET} = the sim's own. */
  selLeashRadius: number;
  // Nav
  showNav: boolean;
  // Parts (spec 084)
  partTool: PartTool;
  /** Which of `maps/recipes/` the add tool bakes. */
  recipe: string;
  partSeed: number;
  /** Left blank to be named after the recipe, as `grow-map.ts` does. */
  partId: string;
  /** Which existing part the "remove named" button deletes. */
  removePartId: string;
  // Rock (spec 123)
  rockTool: RockTool;
  /**
   * How far this tier stands above whatever is already under it.
   *
   * Relative rather than an absolute world Y, because that is what makes a
   * stack build itself: the top is taken from the *highest* ground the
   * footprint covers, and `heightAt` already counts tiers already drawn. So
   * dragging a smaller rectangle on top of a tier raises the next one by this
   * much again, without anybody doing arithmetic.
   */
  rockHeight: number;
  /** Which tier a drag extends. `NEW_ROCK_TIER` starts the next one up. */
  rockLayer: string;
  /**
   * How hard the detail pass chews a formation's outline (spec 125).
   *
   * 0 leaves the rectangle exactly as it was drawn.
   */
  rockErosion: number;
  /**
   * The seed the detail pass runs from.
   *
   * A spinner rather than a button that re-rolls internally, so what a
   * formation looks like is a fact about `(formation, seed)` rather than about
   * how many times somebody has clicked.
   */
  rockDetailSeed: number;
}

export function createEditorSettings(): EditorSettings {
  return {
    mode: 'terrain',
    radius: DEFAULT_BRUSH.radius,
    tool: DEFAULT_BRUSH.tool,
    strength: DEFAULT_BRUSH.strength,
    falloff: DEFAULT_BRUSH.falloff,
    paintMaterial: DEFAULT_PAINT_MATERIAL,
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
    structure: DEFAULT_STRUCTURE.structure,
    structureScale: DEFAULT_STRUCTURE.structureScale,
    structureYaw: DEFAULT_STRUCTURE.structureYaw,
    fixtureBrightness: DEFAULT_STRUCTURE.fixtureBrightness ?? null,
    fixtureRadius: DEFAULT_STRUCTURE.fixtureRadius ?? null,
    // The one kind with a reader, so the first marker somebody places does
    // something (spec 178). It used to be `spawn`, which is written to the map
    // and read by nothing.
    markerKind: 'spawner',
    spawnerMonster: SPAWNER_MONSTER_CHOICES[0]?.value ?? '',
    showArena: true,
    selectedMarkerId: '',
    selKind: 'spawner',
    selMonster: SPAWNER_MONSTER_CHOICES[0]?.value ?? '',
    selLabel: '',
    selRespawnSeconds: SPAWNER_UNSET,
    selLeashRadius: SPAWNER_UNSET,
    showNav: false,
    partTool: 'add',
    recipe: '',
    partSeed: 1,
    partId: '',
    removePartId: '',
    rockTool: 'add',
    // Comfortably past MAX_STEP_HEIGHT (24), so a tier drawn at the default is
    // a cliff rather than a slope somebody strolls up, and a little over one
    // body height so it reads as a storey.
    rockHeight: 70,
    rockLayer: NEW_ROCK_TIER,
    rockErosion: 0.5,
    rockDetailSeed: 1,
  };
}

/** The colour the cursor takes for the armed tool. */
export function cursorColor(settings: EditorSettings): number {
  if (settings.mode === 'terrain') return TOOL_COLORS[settings.tool];
  if (settings.mode === 'paint') return PAINT_COLORS[settings.paintMaterial];
  if (settings.mode === 'part') return PART_TOOL_COLORS[settings.partTool];
  if (settings.mode === 'rock') return ROCK_TOOL_COLORS[settings.rockTool];
  return MODE_COLORS[settings.mode];
}

/** The ring a marker drops under, since it has no radius of its own to show. */
export const MARKER_CURSOR_RADIUS = 30;

/**
 * How far a *ground* click reaches for a marker to select (spec 222).
 *
 * The select tool aims at the billboards first, which is exact and is what a
 * person is actually pointing at. This is the fallback for a click that hit no
 * billboard, and it is generous on purpose: a marker's disc floats
 * `STEM_HEIGHT` above the point it marks, so somebody aiming a little low hits
 * ground that is some way from the marker, and how far depends on the camera's
 * pitch. Wider than the billboard is, so the two answers overlap rather than
 * leaving a band where neither fires.
 */
export const SELECT_PICK_RADIUS = 70;

/**
 * The value of a spawner's number meaning "the server decides" (spec 222).
 *
 * Zero rather than a separate "override this?" toggle, because both numbers are
 * refused at zero by `spawnPointsFrom` -- an instant respawn and a leash of
 * nothing are not settings anybody could have meant -- so the value is free to
 * mean the one thing left. One control per number rather than two, and a slider
 * that starts where "unset" is.
 */
export const SPAWNER_UNSET = 0;

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
  // The building's own footprint, so the ring is the ground it will block --
  // and the same circle the collider is, since both come from
  // `footprintRadius`. A brush radius would mean nothing to a tool that places
  // one thing of a fixed size.
  if (settings.mode === 'structure') return structureFootprint(settings);
  // The select tool's ring says how far a click on the *ground* reaches for a
  // marker, which is what the pick falls back to when it missed every billboard
  // -- so it is a real footprint rather than a "here", and it is its own number.
  if (settings.mode === 'select') return SELECT_PICK_RADIUS;
  if (settings.mode === 'marker') return MARKER_CURSOR_RADIUS;
  // A part is a rectangle drawn by its own outline, so the ring says only
  // "here", not how big the thing about to land is. A tier is dragged out the
  // same way.
  if (settings.mode === 'part' || settings.mode === 'rock') return MARKER_CURSOR_RADIUS;
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
  /** Shared by the two brushes that work under a weighted footprint. */
  readonly falloff: boolean;
  readonly terrain: boolean;
  readonly paint: boolean;
  readonly scatter: boolean;
  readonly fence: boolean;
  readonly structure: boolean;
  readonly marker: boolean;
  readonly select: boolean;
  readonly part: boolean;
  readonly rock: boolean;
}

export function visibleGroups(mode: EditorMode): ToolVisibility {
  return {
    // The fence lays a fixed tile and a marker is a point: neither has a
    // footprint for the radius to set.
    radius: mode === 'terrain' || mode === 'paint' || mode === 'scatter' || mode === 'erase',
    // The eraser takes everything under its circle whole, so a weight has
    // nothing to weight; the scatter has a density instead.
    falloff: mode === 'terrain' || mode === 'paint',
    terrain: mode === 'terrain',
    paint: mode === 'paint',
    scatter: mode === 'scatter',
    fence: mode === 'fence',
    structure: mode === 'structure',
    marker: mode === 'marker',
    select: mode === 'select',
    part: mode === 'part',
    rock: mode === 'rock',
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
export const PART_TOOL_CHOICES = choices(PART_TOOLS);
export const ROCK_TOOL_CHOICES = choices(ROCK_TOOLS);
export const TERRAIN_TOOL_CHOICES = choices(TERRAIN_TOOLS);
export const PAINT_MATERIAL_CHOICES = choices(PAINT_MATERIALS);
/**
 * The marker kinds, labelled by what they *do* (spec 178).
 *
 * `spawner` draws as MONSTER, and that is the whole fix for the one mistake
 * this strip reliably produces: `spawn` and `spawner` differ by two letters, sit
 * in the same five-button grid, and only one of them has a reader anywhere in
 * the game. Somebody choosing a monster from the dropdown below and clicking
 * SPAWN has made a marker nothing will ever look at, and the map they save is
 * indistinguishable from a working one until the arena turns out to be empty.
 *
 * The stored id does not move -- it is a byte on the wire (`MapMarkerKindValue`)
 * and a string in every saved map -- so this is the same split `FENCE_STYLE_CHOICES`
 * already makes between what a thing is called and what a button says.
 */
export const MARKER_CHOICES = choices(MARKER_KINDS, { spawner: 'monster' });

/**
 * What placing this kind of marker actually does, in one line.
 *
 * Four of the five kinds are sockets with nothing plugged into them: they are
 * written to the map, replicated to clients, and read by nothing. Saying so is
 * the same rule the character sheet follows for a stat that changes nothing yet
 * -- a control that describes an effect it does not have is worse than one that
 * admits it has none.
 */
export function markerKindEffect(kind: MapMarkerKind): string {
  // Both short enough to fit the panel's own row: this text is drawn in a
  // fixed-width lil-gui field, and "saved in the map; nothing re..." cut the
  // half that was worth reading.
  return kind === 'spawner' ? 'spawns the monster below' : 'nothing reads it yet';
}

/**
 * What a spawner marker may name, straight from the MONSTERS table (spec 076).
 *
 * A dropdown rather than a text field because the server refuses to boot on a
 * spawner whose monster it does not know, and a typo an hour into a map edit
 * should not be something you find out about at the next server start.
 */
export const SPAWNER_MONSTER_CHOICES = choices(ALL_MONSTERS.map((monster) => monster.id));
/**
 * Labelled by what they look like rather than by their stored id: 'wood' is
 * written into saved maps and cannot be renamed, but a button that says WOOD
 * next to one that says BOARDS tells you nothing (spec 059).
 */
export const FENCE_STYLE_CHOICES = choices(FENCE_STYLES, { wood: 'picket' });
/**
 * What the scatter may plant. Not every `PropKind`: the fence kinds are laid a
 * tile at a time along a path and would be nonsense sprinkled over an area.
 */
export const SPECIES_CHOICES = choices(['tree', 'bush'] as const satisfies readonly PropKind[]);
/**
 * What the structure tool may put down (spec 224).
 *
 * Its own strip rather than two more buttons on the scatter's, for the reason
 * the fence has its own tool: a building is placed, not painted, and a density
 * brush loaded with houses would sprinkle them at random over the ground with
 * no way to say where any one of them goes.
 */
export const STRUCTURE_CHOICES = choices(PLACED_KINDS);

/**
 * Which of those emit light, so the panel knows when its two extra rows mean
 * anything (spec 248).
 *
 * A **set** rather than a check at each call site, for the reason `tools.ts`
 * holds every other one of these: what the panel shows and what the tool reads
 * have to be the same answer, and a second `isFixtureKind` call in `panel.ts`
 * is a second answer waiting to disagree.
 */
export function armedKindEmits(settings: EditorSettings): boolean {
  return isFixtureKind(settings.structure);
}

/** The settings fields the select tool owns, as one object (spec 222). */
export type MarkerSelection = Pick<
  EditorSettings,
  'selectedMarkerId' | 'selKind' | 'selMonster' | 'selLabel' | 'selRespawnSeconds' | 'selLeashRadius'
>;

/**
 * What selecting this marker loads into the panel (spec 222).
 *
 * Pure, so "the panel shows what the marker says" is a fact a test can assert
 * rather than something to check by clicking. The one judgement in it: a
 * marker's label goes into **one of two fields** depending on its kind, because
 * a spawner's label is a monster id chosen from the roster and every other
 * kind's is free text -- one field would mean a dropdown that can hold
 * `boss-door` or a text box that can hold a typo the server refuses to boot on.
 *
 * The field that is not this kind's is deliberately **left as it was** rather
 * than blanked: selecting a campfire and then a spawner should put the monster
 * dropdown back where the reader last had it, not on the first row of the table.
 */
export function selectionFrom(marker: MapMarker, previous: MarkerSelection): MarkerSelection {
  const label = marker.label ?? '';
  return {
    selectedMarkerId: marker.id,
    selKind: marker.kind,
    selMonster: marker.kind === 'spawner' && label !== '' ? label : previous.selMonster,
    selLabel: marker.kind === 'spawner' ? previous.selLabel : label,
    selRespawnSeconds: marker.spawner?.respawnSeconds ?? SPAWNER_UNSET,
    selLeashRadius: marker.spawner?.leashRadius ?? SPAWNER_UNSET,
  };
}

/** Nothing selected: what the panel holds when a click landed on empty ground. */
export function clearSelection(previous: MarkerSelection): MarkerSelection {
  return { ...previous, selectedMarkerId: '' };
}

/**
 * What the panel's current values mean as an edit (spec 222).
 *
 * The inverse of {@link selectionFrom}, and the two are inverses on purpose:
 * selecting a marker and committing without touching anything must be a no-op,
 * which is what `tools.test.ts` asserts over every kind. Anything the round trip
 * does not preserve is a field the panel is quietly rewriting.
 *
 * `SPAWNER_UNSET` becomes an **absent** member rather than a zero, since zero is
 * a number `spawnPointsFrom` refuses -- so "the server decides" and "wait no
 * time at all" cannot be confused in the document even though they share a
 * value on the slider.
 */
export function patchFromSelection(selection: MarkerSelection): MarkerPatch {
  const spawner =
    selection.selKind !== 'spawner'
      ? {}
      : {
          ...(selection.selRespawnSeconds > SPAWNER_UNSET
            ? { respawnSeconds: selection.selRespawnSeconds }
            : {}),
          ...(selection.selLeashRadius > SPAWNER_UNSET ? { leashRadius: selection.selLeashRadius } : {}),
        };
  return {
    kind: selection.selKind,
    label: selection.selKind === 'spawner' ? selection.selMonster : selection.selLabel,
    // Always handed over, even when empty: `patchMarker` drops a spawner block
    // on a kind that cannot read it, and an *absent* patch member means "leave
    // what is there" -- so clearing the last override has to be said out loud
    // rather than by omission.
    spawner,
  };
}
