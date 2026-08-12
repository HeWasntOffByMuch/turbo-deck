/**
 * The tuning panels (spec 110): clip player, state graph, parameters, timings.
 *
 * The screen the roster is actually tuned on, so it is built around the loop a
 * person works in -- watch it, nudge a number, watch it again -- rather than
 * around the data model. The machine runs live, the graph highlights the state
 * it is in, and every edit is a write to the JSON on disk through the server.
 *
 * Nothing here decides anything. The timeline's arithmetic is `timeline.ts`, the
 * bar's is `timing-bar.ts`, the graph's is `graph-layout.ts` and the behaviour is
 * `units/machine.ts` -- all pure and tested. This file is the DOM.
 */

import { UnitMachine, type MachineSnapshot } from '../../../units/machine.js';
import { actionTotalMs } from '../../../units/timing.js';
import type { ActionTiming, Clip, ClipLib, UnitDef } from '../../../units/types.js';
import { CATEGORY_COLORS, edgeAt, layoutGraph, type Graph } from './graph-layout.js';
import { PLAYER_REFERENCE_HEIGHT, UnitPreview, type PreviewAssets } from './preview.js';
import {
  applyMarkerDrag,
  dragMarkerTo,
  frameCount,
  markerAt,
  rulerTicks,
  stepFrame,
  timeToFrame,
  timeToX,
} from './timeline.js';
import { PHASE_COLORS, phaseAt, phaseSpans, timingVerdict } from './timing-bar.js';

const MONO = "'Courier New',ui-monospace,monospace";
const BODY = `font-family:${MONO};font-size:12px;color:#c8c8d8;line-height:1.5;`;
const MUTED = `font-family:${MONO};font-size:11px;color:#8a8aa0;line-height:1.45;`;
const INPUT = `font-family:${MONO};font-size:11px;background:#0d0d14;color:#e8e8f4;border:1px solid #4a4a5e;padding:3px 5px;`;
const TICK_MS = 1000 / 60;
const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  if (text) node.textContent = text;
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function button(label: string, width = 0): HTMLButtonElement {
  const node = el('button');
  node.textContent = label;
  node.style.cssText =
    `font-family:${MONO};font-size:11px;padding:4px 9px;cursor:pointer;background:#2a2a38;color:#c8c8d8;` +
    `border:1px solid #4a4a5e;${width ? `min-width:${width}px;` : ''}`;
  return node;
}

export interface PreviewSource {
  /**
   * Repo-relative under `assets/units/`, for writing back. Null for a unit that
   * has not been exported yet: it exists as a job's files and nothing else, so
   * there is no document on disk for an edit to be saved into.
   */
  readonly unitPath: string | null;
  readonly clipLibPath: string | null;
  readonly unit: UnitDef;
  readonly clipLib: ClipLib;
  readonly assets: PreviewAssets;
  /**
   * Rebuilds the documents once the clips have been loaded and measured.
   *
   * For a freshly generated unit, whose real clip lengths are not known until
   * three has decoded the files. The provisional `unit`/`clipLib` above are what
   * is shown for the moment between mounting and loading; this replaces them
   * with documents built on measured durations.
   *
   * Here rather than inside the panel because deriving a unitdef is not the
   * panel's job -- `units/scaffold.ts` does that and is tested in Node. The
   * panel only knows when the numbers became available.
   */
  readonly deriveOnLoad?: (
    durationsMs: Readonly<Record<string, number>>,
    importScale: number,
  ) => {
    readonly unit: UnitDef;
    readonly clipLib: ClipLib;
  };
  /**
   * Stand the loaded model at this height and record the scale it took.
   *
   * Set for a generated unit, whose rig arrives at whatever size its generator
   * chose. Absent for one whose `import.scale` was already measured.
   */
  readonly fitToHeight?: number;
}

export interface PreviewHandle {
  readonly element: HTMLElement;
  start(): void;
  stop(): void;
  dispose(): void;
  /**
   * The documents as they stand, including every edit made on screen.
   *
   * What Export writes for a unit that has no files on disk yet. Without this
   * the tuning and the export were two unconnected halves: you could retune a
   * wind-up all afternoon and then export the scaffold it started from.
   */
  documents(): { readonly unit: UnitDef; readonly clipLib: ClipLib };
}

/** Writes a document back through the server; resolves to a message for the UI. */
export type SaveDocument = (path: string, doc: unknown) => Promise<string>;

interface Side {
  readonly preview: UnitPreview;
  machine: UnitMachine;
  readonly label: HTMLElement;
}

export function mountPreview(source: PreviewSource, save: SaveDocument | null): PreviewHandle {
  const root = el('div');

  // Working copies. Edits mutate these, the machine is rebuilt from them, and
  // saving writes exactly what is on screen -- so there is never a version of
  // the truth that exists only in a widget.
  let unit: UnitDef = structuredClone(source.unit) as UnitDef;
  let clipLib: ClipLib = structuredClone(source.clipLib) as ClipLib;

  let playing = true;
  let speed = 1;
  let loopClip = true;
  /**
   * What the viewport is showing: the selected clip, or the machine.
   *
   * There used to be no such choice, and that was the defect. The dropdown, the
   * Play button, the frame steppers, the Loop toggle and the timeline all look
   * like a clip player, and none of them played a clip -- the viewport showed
   * whatever state the machine happened to be in, which for a unit sitting at
   * speed zero is the idle, forever. Selecting `walk` moved the ruler and
   * nothing else, `Loop` was read by nothing at all, and the only way to see a
   * clip that was not currently playing was to drag the scrubber across it by
   * hand. "The play button doesn't work most of the time" is an accurate
   * description of that.
   *
   * Clip is the default because these controls are a clip player. The machine
   * is one button away, and the graph and the parameters keep driving it either
   * way.
   */
  let showing: 'clip' | 'machine' = 'clip';
  /** Integer playhead within the selected clip, in ticks. Clip mode only. */
  let clipFrame = 0;
  let selectedClipId = clipLib.clips[0]?.id ?? '';
  let selectedTransition: number | null = null;
  let scrub: number | null = null;
  let abOpen = false;
  let raf = 0;
  let last = 0;
  let accumulator = 0;
  let status = '';

  // --- the two viewports ----------------------------------------------------
  const viewports = el('div', 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start;');
  const makeSide = (name: string): Side => {
    const wrap = el('div', 'flex:1 1 380px;min-width:340px;');
    const label = el('div', `${MUTED}margin-bottom:4px;`, name);
    const preview = new UnitPreview(640, 380);
    wrap.append(label, preview.element);
    viewports.appendChild(wrap);
    return { preview, machine: new UnitMachine({ unit, clipLib, tickMs: TICK_MS }), label };
  };

  const primary = makeSide('A');
  let secondary: Side | null = null;

  // --- clip player ----------------------------------------------------------
  const player = el('div', 'margin-top:12px;');
  const playerRow = el('div', 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;');
  const clipSelect = el('select', INPUT) as HTMLSelectElement;
  const playBtn = button('Pause', 56);
  const stepBack = button('◀ frame');
  const stepFwd = button('frame ▶');
  const loopBtn = button('Loop: on', 80);
  const speedSelect = el('select', INPUT) as HTMLSelectElement;
  for (const rate of [0.1, 0.25, 0.5, 1, 2]) {
    const option = el('option');
    option.value = String(rate);
    option.textContent = `${rate}x`;
    if (rate === 1) option.selected = true;
    speedSelect.appendChild(option);
  }
  const turntableBtn = button('Turntable', 84);
  const resetCam = button('Iso preset');
  const abBtn = button('A/B: off', 74);
  const sourceBtn = button('Showing: clip', 116);
  const frameLabel = el('span', MUTED);
  playerRow.append(
    clipSelect,
    playBtn,
    stepBack,
    stepFwd,
    loopBtn,
    speedSelect,
    sourceBtn,
    turntableBtn,
    resetCam,
    abBtn,
    frameLabel,
  );

  const timelineBox = el('div', 'position:relative;height:52px;margin-top:8px;cursor:pointer;user-select:none;');
  const timelineSvg = svg('svg', { width: '100%', height: 52 });
  timelineSvg.style.cssText = 'display:block;width:100%;height:52px;overflow:visible;';
  timelineBox.appendChild(timelineSvg);
  player.append(playerRow, timelineBox);

  // --- parameters, graph, timings -------------------------------------------
  const columns = el('div', 'display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;align-items:flex-start;');
  const paramBox = el('div', 'flex:0 0 210px;');
  const graphBox = el('div', 'flex:1 1 380px;min-width:320px;overflow-x:auto;');
  const timingBox = el('div', 'flex:1 1 300px;min-width:280px;');
  columns.append(paramBox, graphBox, timingBox);

  const statusLine = el('div', `${MUTED}margin-top:10px;min-height:16px;`);
  root.append(viewports, player, columns, statusLine);

  // --- helpers --------------------------------------------------------------

  const clipById = (id: string): Clip | undefined => clipLib.clips.find((clip) => clip.id === id);

  function rebuildMachines(): void {
    primary.machine = new UnitMachine({ unit, clipLib, tickMs: TICK_MS });
    if (secondary) secondary.machine = new UnitMachine({ unit, clipLib, tickMs: TICK_MS });
  }

  async function persist(path: string | null, doc: unknown, what: string): Promise<void> {
    if (path === null) {
      // A generated unit that has not been exported has no document on disk for
      // an edit to land in. Saying so beats a write that silently goes nowhere.
      status = `${what} changed here only -- this unit has no files in assets/units/ yet. Export it first, and edits will save.`;
      renderStatus();
      return;
    }
    if (!save) {
      status = `${what} changed in this session only -- connect to the authoring server to write it to disk.`;
      renderStatus();
      return;
    }
    status = `saving ${what}…`;
    renderStatus();
    status = await save(path, doc);
    renderStatus();
  }

  function renderStatus(): void {
    // The status line carries validation failures, which are the thing most
    // worth selecting and copying out of this panel.
    if (statusLine.textContent !== status) statusLine.textContent = status;
    statusLine.style.color = /error|invalid|refus|not/i.test(status) ? '#e5c07b' : '#8a8aa0';
  }

  // --- timeline -------------------------------------------------------------

  /**
   * The timeline's furniture: ruler, markers, labels.
   *
   * Rebuilt only when the clip or its markers change. It used to be rebuilt on
   * every animation frame, which is sixty DOM teardowns a second -- nothing in
   * this panel could be selected, and an event name could not be read, let alone
   * copied. The playhead is the only thing that moves per frame and it is one
   * attribute; {@link movePlayhead} writes it.
   */
  let playhead: SVGLineElement | null = null;

  function renderTimeline(): void {
    const clip = clipById(selectedClipId);
    const width = timelineBox.clientWidth || 600;
    const key = clip
      ? `${clip.id}:${clip.durationMs}:${width}:${clip.events.map((e) => `${e.name}@${e.normalizedTime}`).join(',')}`
      : 'none';
    if (timelineSvg.dataset['key'] === key) {
      movePlayhead();
      return;
    }
    timelineSvg.dataset['key'] = key;
    timelineSvg.replaceChildren();
    playhead = null;
    if (!clip) return;

    timelineSvg.appendChild(svg('rect', { x: 0, y: 14, width, height: 12, fill: '#22222e' }));
    for (const tick of rulerTicks(clip.durationMs)) {
      const x = timeToX(tick.time, width);
      timelineSvg.appendChild(svg('line', { x1: x, y1: 10, x2: x, y2: 30, stroke: '#3a3a4e' }));
      const label = svg('text', { x: x + 2, y: 9, fill: '#6a6a80', 'font-size': 9, 'font-family': MONO });
      label.textContent = tick.label;
      timelineSvg.appendChild(label);
    }

    // Event markers. Drawn last so they sit over the ruler, and given a fat
    // invisible hit area -- a 3px diamond is not a grab target.
    clip.events.forEach((event, index) => {
      const x = timeToX(event.normalizedTime, width);
      timelineSvg.appendChild(
        svg('polygon', { points: `${x},8 ${x + 6},20 ${x},32 ${x - 6},20`, fill: '#e5c07b', stroke: '#1a1a24' }),
      );
      const text = svg('text', { x, y: 46, fill: '#a8a8c0', 'font-size': 9, 'font-family': MONO, 'text-anchor': 'middle' });
      text.textContent = event.name;
      timelineSvg.appendChild(text);
      void index;
    });

    playhead = svg('line', { x1: 0, y1: 4, x2: 0, y2: 36, stroke: '#7bc47f', 'stroke-width': 2 });
    timelineSvg.appendChild(playhead);
    movePlayhead();
  }

  /** The one thing that changes every frame: two attributes and a label. */
  function movePlayhead(): void {
    const clip = clipById(selectedClipId);
    if (!clip || !playhead) return;
    const width = timelineBox.clientWidth || 600;
    const frames = frameCount(clip.durationMs);
    const snapshot = primary.machine.snapshot();
    const at =
      scrub ??
      (showing === 'clip'
        ? clipNormalized()
        : isClipShowing(snapshot, clip.id)
          ? snapshot.normalizedTime
          : 0);
    const x = timeToX(at, width);
    playhead.setAttribute('x1', String(x));
    playhead.setAttribute('x2', String(x));
    const label = `frame ${timeToFrame(at, frames)} / ${frames - 1} · ${clip.durationMs}ms · ${frames} ticks`;
    if (frameLabel.textContent !== label) frameLabel.textContent = label;
  }

  function isClipShowing(snapshot: MachineSnapshot, clipId: string): boolean {
    void snapshot;
    return primary.machine.poses().some((pose) => pose.clipId === clipId);
  }

  timelineBox.addEventListener('pointerdown', (event) => {
    const clip = clipById(selectedClipId);
    if (!clip) return;
    const width = timelineBox.clientWidth || 600;
    const x = event.clientX - timelineBox.getBoundingClientRect().left;
    const frames = frameCount(clip.durationMs);
    const hit = markerAt(clip.events, x, width);

    if (hit !== null) {
      // Dragging a marker: the clip's events are rewritten live and written back
      // on release, so what is on screen is what lands in cliplib.json.
      const move = (moveEvent: PointerEvent): void => {
        const mx = moveEvent.clientX - timelineBox.getBoundingClientRect().left;
        const time = dragMarkerTo(mx, width, frames);
        const events = applyMarkerDrag(clip.events, hit, time, frames);
        clipLib = {
          ...clipLib,
          clips: clipLib.clips.map((candidate) => (candidate.id === clip.id ? { ...candidate, events } : candidate)),
        };
        renderTimeline();
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        rebuildMachines();
        void persist(source.clipLibPath, clipLib, `${clip.id} event markers`);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }

    scrub = dragMarkerTo(x, width, frames);
    playing = false;
    playBtn.textContent = 'Play';
    renderTimeline();
  });

  // --- parameters -----------------------------------------------------------

  function renderParameters(): void {
    paramBox.replaceChildren();
    paramBox.appendChild(el('div', `${BODY}margin-bottom:6px;`, 'Parameters'));
    for (const parameter of unit.stateMachine.parameters) {
      const row = el('div', 'margin-bottom:8px;');
      const value = primary.machine.getParameter(parameter.name);
      row.appendChild(el('div', MUTED, `${parameter.name} · ${parameter.type}`));

      if (parameter.type === 'float' || parameter.type === 'int') {
        const slider = el('input', 'width:100%;') as HTMLInputElement;
        slider.type = 'range';
        slider.min = '0';
        slider.max = '200';
        slider.step = parameter.type === 'int' ? '1' : '0.5';
        slider.value = String(typeof value === 'number' ? value : 0);
        const readout = el('span', MUTED, slider.value);
        slider.addEventListener('input', () => {
          const next = Number(slider.value);
          readout.textContent = slider.value;
          primary.machine.setParameter(parameter.name, next);
          secondary?.machine.setParameter(parameter.name, next);
        });
        row.append(slider, readout);
      } else if (parameter.type === 'bool') {
        const box = el('input') as HTMLInputElement;
        box.type = 'checkbox';
        box.checked = value === true;
        box.addEventListener('change', () => {
          primary.machine.setParameter(parameter.name, box.checked);
          secondary?.machine.setParameter(parameter.name, box.checked);
        });
        row.appendChild(box);
      } else {
        const fire = button(`fire ${parameter.name}`);
        fire.addEventListener('click', () => {
          primary.machine.trigger(parameter.name);
          secondary?.machine.trigger(parameter.name);
        });
        row.appendChild(fire);
      }
      paramBox.appendChild(row);
    }
  }

  // --- the graph ------------------------------------------------------------

  let graph: Graph = layoutGraph(unit.stateMachine);

  /** The node rectangles, so the live highlight is an attribute and not a rebuild. */
  const nodeRects = new Map<string, SVGRectElement>();
  let highlighted: string | null = null;

  /**
   * Rebuilds the graph.
   *
   * Only when the machine's shape or the selection changes -- never for the live
   * state highlight, which is what moves every frame. This was rebuilt sixty
   * times a second, which made the condition labels impossible to select and put
   * a full layout pass in the frame budget for no reason.
   */
  function renderGraph(): void {
    graph = layoutGraph(unit.stateMachine);
    const key = `${JSON.stringify(unit.stateMachine.transitions)}:${JSON.stringify(
      unit.stateMachine.states.map((state) => [state.id, state.category]),
    )}:${selectedTransition ?? -1}`;
    if (graphBox.dataset['key'] === key) {
      highlightState();
      return;
    }
    graphBox.dataset['key'] = key;
    nodeRects.clear();
    highlighted = null;
    graphBox.replaceChildren();
    graphBox.appendChild(el('div', `${BODY}margin-bottom:6px;`, 'State machine'));

    const canvas = svg('svg', {
      width: graph.width,
      height: graph.height,
      viewBox: `0 ${graph.top} ${graph.width} ${graph.height}`,
    });
    canvas.style.cssText = 'display:block;background:#0d0d14;border:1px solid #2a2a38;';

    for (const edge of graph.edges) {
      const selected = selectedTransition === edge.index;
      canvas.appendChild(
        svg('path', {
          d: `M ${edge.x1} ${edge.y1} Q ${edge.midX} ${edge.midY} ${edge.x2} ${edge.y2}`,
          fill: 'none',
          stroke: selected ? '#e5c07b' : '#4a4a5e',
          'stroke-width': selected ? 2 : 1.2,
          'stroke-dasharray': edge.interruptible ? '0' : '4 3',
        }),
      );
      const label = svg('text', {
        x: edge.midX,
        y: edge.midY - 4,
        fill: selected ? '#e5c07b' : '#7a7a92',
        'font-size': 9,
        'font-family': MONO,
        'text-anchor': 'middle',
      });
      label.textContent = edge.condition;
      canvas.appendChild(label);
    }

    for (const node of graph.nodes) {
      const rect = svg('rect', {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rx: 3,
        fill: CATEGORY_COLORS[node.category],
        stroke: '#2a2a38',
        'stroke-width': 1,
      });
      nodeRects.set(node.id, rect);
      canvas.appendChild(rect);
      const name = svg('text', {
        x: node.x + node.width / 2,
        y: node.y + 16,
        fill: '#f0f0f8',
        'font-size': 11,
        'font-family': MONO,
        'text-anchor': 'middle',
      });
      name.textContent = node.label;
      canvas.appendChild(name);
      const category = svg('text', {
        x: node.x + node.width / 2,
        y: node.y + 29,
        fill: '#c8c8d8',
        'font-size': 9,
        'font-family': MONO,
        'text-anchor': 'middle',
      });
      category.textContent = node.category;
      canvas.appendChild(category);
    }

    canvas.addEventListener('click', (event) => {
      const box = canvas.getBoundingClientRect();
      const edge = edgeAt(graph, event.clientX - box.left, event.clientY - box.top + graph.top);
      selectedTransition = edge?.index ?? null;
      renderGraph();
      renderTransitionEditor();
    });
    graphBox.appendChild(canvas);
    graphBox.appendChild(transitionEditor);
    highlightState();
  }

  /** The live current state: two attributes on at most two rectangles. */
  function highlightState(): void {
    const active = primary.machine.stateId;
    if (active === highlighted) return;
    const previous = highlighted === null ? undefined : nodeRects.get(highlighted);
    if (previous) {
      previous.setAttribute('stroke', '#2a2a38');
      previous.setAttribute('stroke-width', '1');
    }
    const current = nodeRects.get(active);
    if (current) {
      current.setAttribute('stroke', '#7bc47f');
      current.setAttribute('stroke-width', '2.5');
    }
    highlighted = active;
  }

  const transitionEditor = el('div', 'margin-top:8px;');

  function renderTransitionEditor(): void {
    transitionEditor.replaceChildren();
    if (selectedTransition === null) {
      transitionEditor.appendChild(el('div', MUTED, 'Click a transition to edit its blend and interruptibility.'));
      return;
    }
    const transition = unit.stateMachine.transitions[selectedTransition];
    if (!transition) return;

    const row = el('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;');
    row.appendChild(el('span', BODY, `${transition.from} → ${transition.to}`));
    row.appendChild(el('span', MUTED, `when ${transition.condition}`));

    const blend = el('input', `${INPUT}width:70px;`) as HTMLInputElement;
    blend.type = 'number';
    blend.min = '0';
    blend.step = '10';
    blend.value = String(transition.durationMs);
    const commit = (): void => {
      const transitions = unit.stateMachine.transitions.map((candidate, index) =>
        index === selectedTransition
          ? { ...candidate, durationMs: Math.max(0, Number(blend.value) || 0), interruptible: interrupt.checked }
          : candidate,
      );
      unit = { ...unit, stateMachine: { ...unit.stateMachine, transitions } };
      rebuildMachines();
      renderGraph();
      void persist(source.unitPath, unit, 'transition');
    };
    blend.addEventListener('change', commit);

    const interrupt = el('input') as HTMLInputElement;
    interrupt.type = 'checkbox';
    interrupt.checked = transition.interruptible;
    interrupt.addEventListener('change', commit);

    row.append(el('span', MUTED, 'blend ms'), blend, el('span', MUTED, 'interruptible'), interrupt);
    transitionEditor.appendChild(row);
  }

  // --- action timings -------------------------------------------------------

  function renderTimings(): void {
    timingBox.replaceChildren();
    timingBox.appendChild(el('div', `${BODY}margin-bottom:6px;`, 'Action timings'));
    if (unit.stateMachine.actionTimings.length === 0) {
      timingBox.appendChild(el('div', MUTED, 'This unit declares no actions.'));
      return;
    }

    unit.stateMachine.actionTimings.forEach((timing, index) => {
      const clip = clipById(timing.clipRef);
      const card = el('div', 'border:1px solid #2a2a38;padding:8px;margin-bottom:8px;');
      card.appendChild(el('div', BODY, `${timing.actionId} · ${timing.clipRef}`));

      const barWidth = 264;
      const bar = svg('svg', { width: barWidth, height: 30 });
      bar.style.cssText = 'display:block;margin:6px 0;';
      for (const span of phaseSpans(timing, barWidth)) {
        bar.appendChild(svg('rect', { x: span.x, y: 0, width: span.width, height: 18, fill: PHASE_COLORS[span.phase] }));
        if (span.width > 34) {
          const label = svg('text', {
            x: span.x + span.width / 2,
            y: 13,
            fill: '#12121a',
            'font-size': 9,
            'font-family': MONO,
            'text-anchor': 'middle',
          });
          label.textContent = `${span.ms}`;
          bar.appendChild(label);
        }
      }
      // The clip's event markers, on the same normalised axis the action uses --
      // which is the whole reason events are stored normalised.
      for (const event of clip?.events ?? []) {
        const x = event.normalizedTime * barWidth;
        bar.appendChild(svg('line', { x1: x, y1: 0, x2: x, y2: 24, stroke: '#f0f0f8', 'stroke-width': 1 }));
        const dot = svg('text', { x, y: 30, fill: '#a8a8c0', 'font-size': 8, 'font-family': MONO, 'text-anchor': 'middle' });
        dot.textContent = phaseAt(timing, event.normalizedTime).slice(0, 1);
        bar.appendChild(dot);
      }
      card.appendChild(bar);

      const fields = el('div', 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;');
      const inputs: Record<'windupMs' | 'activeMs' | 'recoveryMs', HTMLInputElement> = {
        windupMs: el('input', `${INPUT}width:58px;`) as HTMLInputElement,
        activeMs: el('input', `${INPUT}width:58px;`) as HTMLInputElement,
        recoveryMs: el('input', `${INPUT}width:58px;`) as HTMLInputElement,
      };
      for (const [key, input] of Object.entries(inputs) as [keyof typeof inputs, HTMLInputElement][]) {
        input.type = 'number';
        input.min = '0';
        input.step = '10';
        input.value = String(timing[key]);
        fields.append(el('span', MUTED, key.replace('Ms', '')), input);
        input.addEventListener('change', () => {
          const next: ActionTiming = {
            ...timing,
            windupMs: Math.max(0, Number(inputs.windupMs.value) || 0),
            activeMs: Math.max(0, Number(inputs.activeMs.value) || 0),
            recoveryMs: Math.max(0, Number(inputs.recoveryMs.value) || 0),
          };
          const actionTimings = unit.stateMachine.actionTimings.map((candidate, i) => (i === index ? next : candidate));
          unit = { ...unit, stateMachine: { ...unit.stateMachine, actionTimings } };
          rebuildMachines();
          renderTimings();
          void persist(source.unitPath, unit, `${timing.actionId} timing`);
        });
      }
      card.appendChild(fields);

      const verdict = timingVerdict(timing, clip?.durationMs ?? 0, unit.maxTimeScale);
      card.appendChild(
        el(
          'div',
          `${MUTED}color:${verdict.overLimit ? '#e06c75' : '#7bc47f'};margin-top:4px;`,
          `${actionTotalMs(timing)}ms total · clip ${clip?.durationMs ?? 0}ms · ${verdict.note}`,
        ),
      );

      const fire = button(`Trigger ${timing.actionId}`);
      fire.addEventListener('click', () => {
        primary.machine.startAction(timing.actionId);
        secondary?.machine.startAction(timing.actionId);
        playing = true;
        playBtn.textContent = 'Pause';
        scrub = null;
      });
      card.appendChild(fire);
      timingBox.appendChild(card);
    });
  }

  // --- wiring ---------------------------------------------------------------

  function refreshClipList(): void {
    clipSelect.replaceChildren();
    for (const clip of clipLib.clips) {
      const option = el('option');
      option.value = clip.id;
      option.textContent = clip.id;
      if (clip.id === selectedClipId) option.selected = true;
      clipSelect.appendChild(option);
    }
  }

  clipSelect.addEventListener('change', () => {
    selectedClipId = clipSelect.value;
    // Back to the start of the newly chosen clip, and out of any scrub: picking
    // a clip is asking to watch it, not to land partway through it at whatever
    // frame the last one happened to be on.
    clipFrame = 0;
    scrub = null;
    renderTimeline();
  });

  sourceBtn.addEventListener('click', () => {
    showing = showing === 'clip' ? 'machine' : 'clip';
    sourceBtn.textContent = `Showing: ${showing}`;
    scrub = null;
    if (showing === 'clip') clipFrame = 0;
  });
  playBtn.addEventListener('click', () => {
    playing = !playing;
    if (playing && scrub !== null && showing === 'clip') {
      // Carry the scrubbed position into the playhead rather than throwing it
      // away: pressing play after dragging to an interesting frame should
      // continue from there, not jump back to wherever the clip was.
      clipFrame = timeToFrame(scrub, selectedFrames());
    }
    if (playing) scrub = null;
    playBtn.textContent = playing ? 'Pause' : 'Play';
  });
  const stepBy = (delta: number): void => {
    const clip = clipById(selectedClipId);
    if (!clip) return;
    playing = false;
    playBtn.textContent = 'Play';
    const frames = frameCount(clip.durationMs);
    // Stepped from where the playhead actually is. Reading the machine's
    // normalized time while showing a clip meant a frame step jumped to
    // wherever the machine happened to be in a different clip entirely.
    const from = scrub ?? (showing === 'clip' ? clipNormalized() : primary.machine.snapshot().normalizedTime);
    scrub = stepFrame(from, delta, frames);
    renderTimeline();
  };
  stepBack.addEventListener('click', () => stepBy(-1));
  stepFwd.addEventListener('click', () => stepBy(1));
  loopBtn.addEventListener('click', () => {
    loopClip = !loopClip;
    loopBtn.textContent = `Loop: ${loopClip ? 'on' : 'off'}`;
    // Turning looping back on from a clip that had run to its end restarts it,
    // rather than leaving the playhead pinned on the last frame with the button
    // saying it is looping.
    if (loopClip && clipFrame >= selectedFrames() - 1) clipFrame = 0;
  });
  speedSelect.addEventListener('change', () => {
    speed = Number(speedSelect.value) || 1;
  });
  turntableBtn.addEventListener('click', () => {
    const on = turntableBtn.textContent === 'Turntable';
    primary.preview.setTurntable(on);
    secondary?.preview.setTurntable(on);
    turntableBtn.textContent = on ? 'Stop spin' : 'Turntable';
  });
  resetCam.addEventListener('click', () => {
    primary.preview.resetCamera();
    secondary?.preview.resetCamera();
  });
  abBtn.addEventListener('click', () => {
    abOpen = !abOpen;
    abBtn.textContent = `A/B: ${abOpen ? 'on' : 'off'}`;
    if (abOpen && !secondary) {
      secondary = makeSide('B — same clock, its own camera');
      void secondary.preview.load(source.assets);
    } else if (!abOpen && secondary) {
      secondary.preview.element.parentElement?.remove();
      secondary.preview.dispose();
      secondary = null;
    }
  });

  /** Frames in the selected clip, or 1 when there is no clip to count. */
  function selectedFrames(): number {
    const clip = clipById(selectedClipId);
    return clip ? Math.max(1, frameCount(clip.durationMs)) : 1;
  }

  /**
   * Where the clip playhead is, 0..1.
   *
   * Divided the way the machine divides it, so the timeline reads the same in
   * both modes: a looping clip's last frame sits just short of 1 and wraps to a
   * new frame, and a one-shot genuinely reaches 1 rather than stopping a frame
   * early on a pose nobody authored.
   */
  function clipNormalized(): number {
    const frames = selectedFrames();
    const clip = clipById(selectedClipId);
    if (clip?.loop === true) return Math.min(1, clipFrame / frames);
    return frames <= 1 ? 1 : Math.min(1, clipFrame / (frames - 1));
  }

  /** Advances the clip playhead one tick, wrapping or holding at the end. */
  function advanceClip(): void {
    const frames = selectedFrames();
    const clip = clipById(selectedClipId);
    const looping = loopClip && clip?.loop !== false;
    clipFrame += 1;
    if (clipFrame <= frames - 1) return;
    // `loopClip` off holds the last frame rather than snapping to the first,
    // which is what makes stepping to the end of a one-shot and looking at it
    // possible at all.
    clipFrame = looping ? 0 : frames - 1;
  }

  // --- the frame ------------------------------------------------------------

  function frame(now: number): void {
    // The loop keeps going even if a frame throws. It used to not: one
    // exception anywhere in here and the last line -- the request for the next
    // frame -- never ran, so the panel froze mid-pose with every control still
    // responding. "The play button doesn't work" is what that looks like from
    // the outside, and nothing said otherwise.
    try {
      drawFrame(now);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (status !== `preview frame failed: ${message}`) {
        status = `preview frame failed: ${message}`;
        renderStatus();
        console.error('[studio] preview frame failed', cause);
      }
    }
    raf = requestAnimationFrame(frame);
  }

  function drawFrame(now: number): void {
    const elapsed = last === 0 ? TICK_MS : Math.min(200, now - last);
    last = now;

    if (playing) {
      // Whole ticks from an accumulator, exactly as the game's loop does it, so
      // the machine sees the same integer sequence here as it will there.
      accumulator += elapsed * speed;
      let stepped = 0;
      while (accumulator >= TICK_MS && stepped < 10) {
        accumulator -= TICK_MS;
        stepped += 1;
        primary.machine.step(1);
        secondary?.machine.step(1);
        if (showing === 'clip') advanceClip();
      }
    }

    if (scrub !== null) {
      // Scrubbing poses the clip directly rather than moving the machine: the
      // machine's tick is the game's clock, and dragging a scrubber must not
      // rewrite history the events were already fired against.
      const clip = clipById(selectedClipId);
      if (clip) {
        primary.preview.applyPoses([{ clipId: clip.id, normalizedTime: scrub, weight: 1 }]);
        secondary?.preview.applyPoses([{ clipId: clip.id, normalizedTime: scrub, weight: 1 }]);
      }
    } else if (showing === 'clip') {
      const clip = clipById(selectedClipId);
      if (clip) {
        const poses = [{ clipId: clip.id, normalizedTime: clipNormalized(), weight: 1 }];
        primary.preview.applyPoses(poses);
        secondary?.preview.applyPoses(poses);
      }
    } else {
      primary.preview.applyPoses(primary.machine.poses());
      if (secondary) secondary.preview.applyPoses(secondary.machine.poses());
    }

    primary.preview.render(elapsed / 1000);
    secondary?.preview.render(elapsed / 1000);

    const snapshot = primary.machine.snapshot();
    // Names what is on screen, not just what the machine is doing: in clip mode
    // those are different things, and a label that only ever said the machine's
    // state was part of why the viewport seemed not to respond.
    const label =
      showing === 'clip'
        ? `A — clip ${selectedClipId}${playing ? '' : ' (paused)'} · machine in ${snapshot.stateId}`
        : `A — ${snapshot.stateId}${snapshot.previousStateId ? ` ← ${snapshot.previousStateId} (${Math.round(snapshot.blend * 100)}%)` : ''}` +
          `${snapshot.actionPhase ? ` · ${snapshot.actionPhase}` : ''}`;
    if (primary.label.textContent !== label) primary.label.textContent = label;
    // Both of these are guarded: they move a playhead and a highlight, and only
    // rebuild when the clip or the machine's shape has actually changed.
    renderTimeline();
    renderGraph();
  }

  refreshClipList();
  renderParameters();
  renderGraph();
  renderTransitionEditor();
  renderTimings();
  renderTimeline();

  return {
    element: root,
    start(): void {
      void primary.preview.load(source.assets, source.unit.id).then(() => {
        // Measured, then derived. For a freshly generated unit the documents
        // shown until this moment were a placeholder: the clip lengths were not
        // knowable until three had decoded the files, and Export will not accept
        // a guessed one.
        const fitted = source.fitToHeight === undefined ? source.assets.importScale : primary.preview.fitToHeight(source.fitToHeight);
        if (source.deriveOnLoad) {
          // Guarded, because a throw in here used to leave the panel half
          // rebuilt and silent: the clip list had been refreshed and nothing
          // after it had, which looks like a preview that simply stopped. A
          // derivation that fails should say so where the failures go.
          try {
            const derived = source.deriveOnLoad(primary.preview.durationsMs(), fitted);
            unit = structuredClone(derived.unit) as UnitDef;
            clipLib = structuredClone(derived.clipLib) as ClipLib;
            selectedClipId = clipLib.clips[0]?.id ?? '';
            selectedTransition = null;
            rebuildMachines();
            refreshClipList();
            renderParameters();
            renderGraph();
            renderTransitionEditor();
            renderTimings();
            renderTimeline();
          } catch (cause) {
            status = `could not build a unit from these clips: ${cause instanceof Error ? cause.message : String(cause)}`;
            renderStatus();
            return;
          }
        }
        const stats = primary.preview.stats();
        // Root motion is reported here as well as in the console and in CI
        // (spec 111). Stripping it is right; stripping it *quietly* is how a
        // clip authored with a two-metre stride ships as one that moon-walks
        // and nobody finds out until they watch it. This is the screen the
        // person who could fix that is actually looking at.
        const stripped = primary.preview.rootMotion;
        // The import scale is in the line because it is a *measured* number for
        // a generated unit, and a unit that is subtly the wrong size looks fine
        // alone and wrong beside the silhouette -- which is what the silhouette
        // is for, and what this number makes checkable rather than eyeballed.
        status = primary.preview.error
          ? `could not load the model: ${primary.preview.error}`
          : `${stats.triangles} triangles, ${stats.bones} bones, ${stats.vertices} vertices · import scale ${fitted.toFixed(2)} · reference silhouette is ${PLAYER_REFERENCE_HEIGHT} world units`;
        // The root is named either way. A check that found nothing looks
        // identical to a check that ran against a bone the rig does not have,
        // and the second one ships a unit that walks away from where the server
        // put it -- so the bone it ran against is on screen rather than implied.
        const bone = primary.preview.rootBoneName;
        status = `${status} · root ${bone ?? 'not found'}`;
        if (stripped.length > 0) status = `${status} · ROOT MOTION STRIPPED — ${stripped.join(' ')}`;
        renderStatus();
      });
      last = 0;
      raf = requestAnimationFrame(frame);
    },
    stop(): void {
      cancelAnimationFrame(raf);
      raf = 0;
    },
    dispose(): void {
      cancelAnimationFrame(raf);
      primary.preview.dispose();
      secondary?.preview.dispose();
    },
    documents(): { unit: UnitDef; clipLib: ClipLib } {
      // Cloned on the way out for the same reason the working copies were cloned
      // on the way in: a caller holding a live reference into this panel would
      // see it change under them mid-export.
      return { unit: structuredClone(unit) as UnitDef, clipLib: structuredClone(clipLib) as ClipLib };
    },
  };
}
