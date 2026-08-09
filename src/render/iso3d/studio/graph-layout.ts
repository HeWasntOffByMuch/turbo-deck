/**
 * Laying out the state machine as a graph (spec 110).
 *
 * Ranked breadth-first from the entry state, which is the layout that makes a
 * character's state machine readable: idle on the left, what it can become next
 * to it, and the terminal states at the end. A force-directed layout would move
 * every time it was opened, and a graph whose shape is not stable cannot be
 * learned.
 *
 * The `'*'` transitions get their own node. Drawing an any-state transition once
 * per source would put four edges into `swing` on a four-state machine and turn
 * the useful picture into a hairball -- and the thing being expressed is
 * genuinely "from anywhere", which is one arrow.
 *
 * Pure: positions and hit-testing only, no SVG and no DOM.
 */

import type { State, StateMachine, Transition } from '../../../units/types.js';

export const NODE_WIDTH = 116;
export const NODE_HEIGHT = 38;
export const COLUMN_GAP = 78;
export const ROW_GAP = 22;
/** How far a long or backward edge bows out of the row band, per column spanned. */
export const BOW_STEP = 26;

/** The synthetic source for `from: '*'`. Not a state, and never addressed as one. */
export const ANY_NODE = '✱ any';

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly category: State['category'] | 'any';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly condition: string;
  readonly durationMs: number;
  readonly interruptible: boolean;
  /** Index into `stateMachine.transitions`, so an edit knows what it is editing. */
  readonly index: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** Where the label sits and where a click is measured from. */
  readonly midX: number;
  readonly midY: number;
}

export interface Graph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly width: number;
  readonly height: number;
  /** The topmost coordinate anything occupies, which bowed edges push negative. */
  readonly top: number;
}

/**
 * Rank by shortest path from the entry state.
 *
 * Any-state transitions are excluded from the ranking: they reach everything, so
 * including them would flatten the whole machine into two columns and throw away
 * the structure the layout exists to show.
 */
function ranks(machine: StateMachine, entryId: string): Map<string, number> {
  const rank = new Map<string, number>([[entryId, 0]]);
  const queue = [entryId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    const depth = rank.get(current) ?? 0;
    for (const transition of machine.transitions) {
      if (transition.from !== current) continue;
      if (rank.has(transition.to)) continue;
      rank.set(transition.to, depth + 1);
      queue.push(transition.to);
    }
  }
  // Anything unreachable except by an any-state transition still has to appear;
  // a state you cannot see is a state you cannot fix.
  let orphanRank = Math.max(0, ...rank.values()) + 1;
  for (const state of machine.states) {
    if (!rank.has(state.id)) rank.set(state.id, orphanRank);
  }
  orphanRank += 1;
  return rank;
}

function anchorRight(node: GraphNode): { x: number; y: number } {
  return { x: node.x + node.width, y: node.y + node.height / 2 };
}

function anchorLeft(node: GraphNode): { x: number; y: number } {
  return { x: node.x, y: node.y + node.height / 2 };
}

export function layoutGraph(machine: StateMachine, entryId?: string): Graph {
  const entry = entryId ?? machine.states[0]?.id ?? '';
  const rank = ranks(machine, entry);
  const usesAny = machine.transitions.some((transition) => transition.from === '*');

  const columns = new Map<number, string[]>();
  for (const state of machine.states) {
    const depth = rank.get(state.id) ?? 0;
    const column = columns.get(depth) ?? [];
    column.push(state.id);
    columns.set(depth, column);
  }
  // The any-state node sits in its own column to the left of everything, since
  // that is where its arrows come from.
  const columnKeys = [...columns.keys()].sort((a, b) => a - b);
  const offset = usesAny ? 1 : 0;

  const nodes: GraphNode[] = [];
  if (usesAny) {
    nodes.push({
      id: ANY_NODE,
      label: 'any state',
      category: 'any',
      x: 0,
      y: 0,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  }

  const byId = new Map(machine.states.map((state) => [state.id, state]));
  for (const depth of columnKeys) {
    const column = columns.get(depth) ?? [];
    column.forEach((id, row) => {
      const state = byId.get(id);
      nodes.push({
        id,
        label: id,
        category: state?.category ?? 'loop',
        x: (depth + offset) * (NODE_WIDTH + COLUMN_GAP),
        y: row * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    });
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const columnOf = (node: GraphNode): number => Math.round(node.x / (NODE_WIDTH + COLUMN_GAP));

  const edges: GraphEdge[] = [];
  machine.transitions.forEach((transition: Transition, index) => {
    const fromNode = nodeById.get(transition.from === '*' ? ANY_NODE : transition.from);
    const toNode = nodeById.get(transition.to);
    if (!fromNode || !toNode) return;
    // Left-to-right when the target is further along, right-to-left when it is a
    // step back -- so a return edge visibly returns instead of crossing the node
    // it came from.
    const forward = toNode.x >= fromNode.x;
    const start = forward ? anchorRight(fromNode) : anchorLeft(fromNode);
    const end = forward ? anchorLeft(toNode) : anchorRight(toNode);

    /**
     * How far the edge bows out of the row band.
     *
     * An edge spanning more than one column passes straight over the ones
     * between, and its midpoint lands exactly where a short edge's already is --
     * the `any -> swing` arrow on a four-state machine sits on top of
     * `idle -> locomotion`, and clicking the label picks whichever was drawn
     * last. Bowing by span separates them on screen and, more importantly, for
     * the hit test. Backward edges bow the other way, so a return path is
     * visibly a return.
     */
    const span = Math.abs(columnOf(toNode) - columnOf(fromNode));
    const bow = span <= 1 && forward ? 0 : (forward ? -1 : 1) * (BOW_STEP + (span - 1) * BOW_STEP);

    edges.push({
      from: transition.from,
      to: transition.to,
      condition: transition.condition,
      durationMs: transition.durationMs,
      interruptible: transition.interruptible,
      index,
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      midX: (start.x + end.x) / 2,
      midY: (start.y + end.y) / 2 + bow,
    });
  });

  // Bowed edges reach above the top row and below the bottom one, so the bounds
  // have to include them or a label is drawn outside the box that scrolls.
  const lowestLabel = Math.min(0, ...edges.map((edge) => edge.midY));
  const highestLabel = Math.max(0, ...edges.map((edge) => edge.midY));
  const width = Math.max(NODE_WIDTH, ...nodes.map((node) => node.x + node.width)) + 8;
  const height =
    Math.max(NODE_HEIGHT, ...nodes.map((node) => node.y + node.height), highestLabel + 16) - lowestLabel + 8;
  return { nodes, edges, width, height, top: lowestLabel - 8 };
}

/** The edge whose label is nearest a point, or null when nothing is close. */
export function edgeAt(graph: Graph, x: number, y: number, radius = 26): GraphEdge | null {
  let best: GraphEdge | null = null;
  let bestDistance = radius;
  for (const edge of graph.edges) {
    const distance = Math.hypot(edge.midX - x, edge.midY - y);
    if (distance <= bestDistance) {
      best = edge;
      bestDistance = distance;
    }
  }
  return best;
}

/** Whether two laid-out nodes overlap. Used by the test, not by the view. */
export function nodesOverlap(a: GraphNode, b: GraphNode): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export const CATEGORY_COLORS: Readonly<Record<GraphNode['category'], string>> = {
  loop: '#4b6a8a',
  oneshot: '#6a5a8a',
  locking: '#8a5a4b',
  terminal: '#5a5a5a',
  any: '#2f2f40',
};
