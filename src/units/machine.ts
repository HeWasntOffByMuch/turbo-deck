/**
 * The unit state machine (spec 110, consumed unchanged by spec 111).
 *
 * **One machine, two callers.** The brief's rule is that the Studio tab and the
 * game read the same files through the same parser; this is the other half of
 * it. There is no authoring-side simulation of the state machine and no
 * runtime-side reimplementation -- the tab drives this and so does the game, so
 * "what you tuned is what ships" is a fact about the module graph rather than a
 * promise somebody keeps.
 *
 * ## Time
 *
 * It advances in **whole 60Hz ticks**, never on a frame delta, and it counts
 * them as integers. Every derived quantity -- which frame of the clip is
 * showing, which events have fired -- comes from that integer, so the answer
 * cannot drift with float accumulation and cannot depend on how the caller
 * chunked its steps. {@link UnitMachine.step} of 6 is exactly six steps of 1.
 *
 * ## Events fire on a frame index, exactly once
 *
 * Each event is resolved to an integer tick within the clip's cycle, and fires
 * on the tick the playhead *is* that index. Because the machine walks its ticks
 * one at a time, an overshooting step cannot skip one and cannot fire one twice
 * -- which is the property the whole design exists for, since an event is a hit
 * landing and a hit that lands twice is a bug somebody feels before they see.
 *
 * ## What it does not do
 *
 * It does not touch three.js, a mixer, or a clock. It says which clips to sample
 * and at what weight; the renderer does the sampling. That is what makes every
 * rule below testable in Node.
 */

import { parseCondition, type Condition } from './condition.js';
import { actionTotalMs, phaseWindows, timeScaleFor } from './timing.js';
import type { ActionTiming, BlendTree, Clip, ClipLib, State, UnitDef } from './types.js';

export const DEFAULT_TICK_MS = 1000 / 60;

export interface FiredEvent {
  readonly name: string;
  readonly clipId: string;
  readonly stateId: string;
  /** The machine tick it fired on. */
  readonly tick: number;
}

/** One clip the renderer should sample, and how much of it to use. */
export interface PoseSample {
  readonly clipId: string;
  /** 0..1 through the clip. */
  readonly normalizedTime: number;
  /** 0..1. Every sample returned together sums to 1. */
  readonly weight: number;
}

export type ParameterValue = number | boolean;

export interface MachineOptions {
  readonly unit: UnitDef;
  readonly clipLib: ClipLib;
  readonly tickMs?: number;
  /** Defaults to the first state. */
  readonly entryStateId?: string;
}

/**
 * The two clips either side of a blend parameter, and their weights.
 *
 * Clamped rather than extrapolated outside the threshold range: a speed above
 * the fastest threshold is a run, not a run-and-a-half, and extrapolating a
 * pose past its authored extreme is how a leg ends up through a hip.
 */
export function blendWeights(tree: BlendTree, value: number): readonly PoseSample[] {
  const thresholds = tree.thresholds;
  const first = thresholds[0];
  const last = thresholds[thresholds.length - 1];
  if (!first || !last) return [];
  if (value <= first.value) return [{ clipId: first.clipRef, normalizedTime: 0, weight: 1 }];
  if (value >= last.value) return [{ clipId: last.clipRef, normalizedTime: 0, weight: 1 }];

  for (let i = 1; i < thresholds.length; i += 1) {
    const lower = thresholds[i - 1];
    const upper = thresholds[i];
    if (!lower || !upper || value > upper.value) continue;
    const span = upper.value - lower.value;
    const t = span <= 0 ? 0 : (value - lower.value) / span;
    return [
      { clipId: lower.clipRef, normalizedTime: 0, weight: 1 - t },
      { clipId: upper.clipRef, normalizedTime: 0, weight: t },
    ];
  }
  return [{ clipId: last.clipRef, normalizedTime: 0, weight: 1 }];
}

/** A state being played: which clips, where in them, and at what rate. */
interface Layer {
  readonly stateId: string;
  /** Integer playhead within the clip cycle. */
  clipTick: number;
  /** Playback rate; 1 is the clip's authored speed. */
  rate: number;
  /** Set once a non-looping clip has reached its end. */
  finished: boolean;
}

export interface MachineSnapshot {
  readonly stateId: string;
  readonly previousStateId: string | null;
  /** 0..1 through the current transition; 1 when nothing is blending. */
  readonly blend: number;
  readonly tick: number;
  readonly ticksInState: number;
  /** 0..1 through the current state's clip. */
  readonly normalizedTime: number;
  readonly activeActionId: string | null;
  /** Which phase an action is in, or null when none is running. */
  readonly actionPhase: 'windup' | 'active' | 'recovery' | null;
}

export class UnitMachine {
  private readonly unit: UnitDef;
  private readonly tickMs: number;
  private readonly clips = new Map<string, Clip>();
  private readonly states = new Map<string, State>();
  private readonly trees = new Map<string, BlendTree>();
  private readonly actions = new Map<string, ActionTiming>();
  private readonly conditions = new Map<string, Condition>();

  private readonly parameters = new Map<string, ParameterValue>();
  /** Triggers are consumed by the transition that reads them. */
  private readonly pendingTriggers = new Set<string>();

  private current: Layer;
  private outgoing: Layer | null = null;
  private fadeTicks = 0;
  private fadeElapsed = 0;
  /** Where a one-shot returns to when it finishes. */
  private returnTo: string | null = null;
  private activeAction: ActionTiming | null = null;
  private actionStartTick = 0;
  private tickCount = 0;
  /**
   * A multiplier on the playback rate of one-shot states (spec 144).
   *
   * Attack speed shortens the gameplay wind-up, so the clip that draws it has to
   * shorten by the same factor or the two come apart -- a body that commits in
   * 0.2s while its swing animation takes 0.4s is drawn still winding up after
   * the arrow has left. `startAction` already rescales a clip to fit gameplay
   * timing; this is the same rule reaching the trigger-driven path, which enters
   * a state directly and never consults an action's timing at all.
   *
   * One-shots only, and deliberately: the same factor applied to a locomotion
   * loop would make a hasted body's legs run faster than it travels.
   */
  private actionRateScale = 1;

  constructor(options: MachineOptions) {
    this.unit = options.unit;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    for (const clip of options.clipLib.clips) this.clips.set(clip.id, clip);
    for (const state of options.unit.stateMachine.states) this.states.set(state.id, state);
    for (const tree of options.unit.stateMachine.blendTrees) this.trees.set(tree.id, tree);
    for (const action of options.unit.stateMachine.actionTimings) this.actions.set(action.actionId, action);
    for (const parameter of options.unit.stateMachine.parameters) {
      this.parameters.set(parameter.name, parameter.type === 'float' || parameter.type === 'int' ? 0 : false);
    }
    // Parsed once. The grammar is checked by the validator, so anything that
    // reaches here parses; caching it keeps the per-tick path free of regex.
    for (const transition of options.unit.stateMachine.transitions) {
      if (!this.conditions.has(transition.condition)) {
        this.conditions.set(transition.condition, parseCondition(transition.condition));
      }
    }

    const entry = options.entryStateId ?? options.unit.stateMachine.states[0]?.id;
    if (entry === undefined) throw new Error('a unit needs at least one state');
    this.current = { stateId: entry, clipTick: -1, rate: this.states.get(entry)?.timeScale ?? 1, finished: false };
  }

  // --- reading --------------------------------------------------------------

  get stateId(): string {
    return this.current.stateId;
  }

  get tick(): number {
    return this.tickCount;
  }

  snapshot(): MachineSnapshot {
    return {
      stateId: this.current.stateId,
      previousStateId: this.outgoing?.stateId ?? null,
      blend: this.fadeTicks === 0 ? 1 : Math.min(1, this.fadeElapsed / this.fadeTicks),
      tick: this.tickCount,
      ticksInState: Math.max(0, this.current.clipTick),
      normalizedTime: this.normalizedTimeOf(this.current),
      activeActionId: this.activeAction?.actionId ?? null,
      actionPhase: this.phaseOf(),
    };
  }

  /**
   * What to sample this frame, weighted.
   *
   * Returns the outgoing state too while a transition is blending, so a
   * crossfade is a fact the renderer is handed rather than one it has to
   * reconstruct from two consecutive snapshots.
   */
  poses(): readonly PoseSample[] {
    const incoming = this.samplesFor(this.current);
    if (this.outgoing === null || this.fadeTicks === 0) return incoming;

    const t = Math.min(1, this.fadeElapsed / this.fadeTicks);
    const outgoing = this.samplesFor(this.outgoing);
    return [
      ...outgoing.map((sample) => ({ ...sample, weight: sample.weight * (1 - t) })),
      ...incoming.map((sample) => ({ ...sample, weight: sample.weight * t })),
    ].filter((sample) => sample.weight > 0.0001);
  }

  // --- driving --------------------------------------------------------------

  setParameter(name: string, value: ParameterValue): void {
    if (!this.parameters.has(name)) return;
    this.parameters.set(name, value);
  }

  getParameter(name: string): ParameterValue | undefined {
    return this.parameters.get(name);
  }

  /** Raises a trigger, consumed by the first transition that reads it. */
  trigger(name: string): void {
    this.pendingTriggers.add(name);
  }

  /**
   * How fast one-shot states play, 1 being the clip's authored speed.
   *
   * Applied when a state is *entered*, not continuously, so a rate change
   * halfway through a swing does not jerk the pose -- which is the same
   * snapshot rule the sim applies to the timing this is derived from.
   */
  setActionRate(scale: number): void {
    this.actionRateScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  /**
   * Fires an action from the timing table.
   *
   * The clip is rescaled to the action, never the other way round: the rate
   * comes from {@link timeScaleFor}, so the wind-up is exactly as long as the
   * timing says and the animation is what bends.
   */
  startAction(actionId: string): boolean {
    const action = this.actions.get(actionId);
    if (!action) return false;
    const state = [...this.states.values()].find((candidate) => candidate.clipRef === action.clipRef);
    if (!state) return false;
    const clip = this.clips.get(action.clipRef);
    if (!clip) return false;

    this.activeAction = action;
    this.actionStartTick = this.tickCount;
    this.enter(state.id, state.blendInMs, timeScaleFor(action, clip.durationMs));
    return true;
  }

  /**
   * Advances by whole ticks.
   *
   * One at a time, deliberately. A closed-form jump would have to reason about
   * how many laps an event crossed and in what order, and the arithmetic that
   * gets that wrong is invisible until a hit lands twice at 30fps. Steps here
   * are single digits -- the render loop's catch-up is capped at ten -- so the
   * loop costs nothing and is obviously correct.
   */
  step(ticks = 1): readonly FiredEvent[] {
    const fired: FiredEvent[] = [];
    for (let i = 0; i < Math.max(0, Math.floor(ticks)); i += 1) fired.push(...this.stepOnce());
    return fired;
  }

  private stepOnce(): readonly FiredEvent[] {
    this.tickCount += 1;

    if (this.outgoing !== null) {
      this.fadeElapsed += 1;
      this.advance(this.outgoing);
      if (this.fadeElapsed >= this.fadeTicks) {
        this.outgoing = null;
        this.fadeTicks = 0;
        this.fadeElapsed = 0;
      }
    }

    this.advance(this.current);
    // Only the incoming state fires. A crossfade that fired both would put two
    // footsteps under one stride every time the gait changed.
    const fired = this.eventsAt(this.current);
    this.evaluateTransitions();
    return fired;
  }

  // --- internals ------------------------------------------------------------

  private stateOf(layer: Layer): State | undefined {
    return this.states.get(layer.stateId);
  }

  /** The clips a state resolves to, before its playhead is applied. */
  private clipsOf(layer: Layer): readonly PoseSample[] {
    const state = this.stateOf(layer);
    if (!state) return [];
    const tree = this.trees.get(state.clipRef);
    if (!tree) return [{ clipId: state.clipRef, normalizedTime: 0, weight: 1 }];
    const value = this.parameters.get(tree.parameter);
    return blendWeights(tree, typeof value === 'number' ? value : 0);
  }

  /**
   * The blend's effective length.
   *
   * A weighted mean of the clips being blended, which is what keeps a walk-to-run
   * blend from sliding: both clips play at a shared cycle length, so the feet of
   * each agree about where in the stride they are.
   */
  private durationOf(layer: Layer): number {
    const samples = this.clipsOf(layer);
    let total = 0;
    let weight = 0;
    for (const sample of samples) {
      const clip = this.clips.get(sample.clipId);
      if (!clip) continue;
      total += clip.durationMs * sample.weight;
      weight += sample.weight;
    }
    return weight <= 0 ? this.tickMs : total / weight;
  }

  /** How many ticks one pass of this state takes at its current rate. */
  private cycleTicks(layer: Layer): number {
    const rate = layer.rate <= 0 ? 1 : layer.rate;
    return Math.max(1, Math.round(this.durationOf(layer) / (this.tickMs * rate)));
  }

  /**
   * Where the playhead is, 0..1.
   *
   * A looping clip divides by the cycle, so its last frame sits just short of 1
   * and the wrap to 0 is the next frame rather than a repeat of the same pose.
   * A one-shot divides by the last index, so it genuinely reaches 1 -- a death
   * animation that stopped at 0.97 would hold a pose nobody authored.
   */
  private normalizedTimeOf(layer: Layer): number {
    const cycle = this.cycleTicks(layer);
    const at = Math.max(0, layer.clipTick);
    if (this.stateOf(layer)?.loop === true) return Math.min(1, at / cycle);
    return cycle <= 1 ? 1 : Math.min(1, at / (cycle - 1));
  }

  /** The integer frame an event sits on, in the same space as `clipTick`. */
  private eventIndex(layer: Layer, normalizedTime: number, cycle: number): number {
    if (this.stateOf(layer)?.loop === true) {
      // Modulo rather than clamp: an event authored at exactly 1.0 on a loop is
      // the same instant as one at 0, and firing it on a frame that does not
      // exist would mean it never fired at all.
      return ((Math.round(normalizedTime * cycle) % cycle) + cycle) % cycle;
    }
    return Math.min(cycle - 1, Math.max(0, Math.round(normalizedTime * (cycle - 1))));
  }

  private samplesFor(layer: Layer): readonly PoseSample[] {
    const normalizedTime = this.normalizedTimeOf(layer);
    return this.clipsOf(layer).map((sample) => ({ ...sample, normalizedTime }));
  }

  /**
   * Steps a layer's playhead by one frame. Returns true when it wrapped a loop.
   *
   * The playhead starts at -1, not 0, so the very first tick lands *on* frame
   * zero. Starting at 0 would step straight to 1 and an event authored at time
   * zero -- the frame a swing commits on -- would never fire at all.
   */
  private advance(layer: Layer): boolean {
    const cycle = this.cycleTicks(layer);
    layer.clipTick += 1;
    if (layer.clipTick <= cycle - 1) return false;

    if (this.stateOf(layer)?.loop === true) {
      layer.clipTick = 0;
      return true;
    }
    // Pinned on the last frame rather than past it, so the final pose holds.
    // `finished` is what stops its events re-firing on every tick after.
    layer.clipTick = cycle - 1;
    layer.finished = true;
    return false;
  }

  /** The dominant clip: the one whose events a blended state reports. */
  private dominantClip(layer: Layer): Clip | null {
    let best: PoseSample | null = null;
    for (const sample of this.clipsOf(layer)) {
      if (best === null || sample.weight > best.weight) best = sample;
    }
    return best === null ? null : (this.clips.get(best.clipId) ?? null);
  }

  /**
   * Events whose frame index is the playhead's, right now.
   *
   * Integer equality rather than a time comparison, which is what makes
   * exactly-once true: the playhead visits every index in turn, so an event on
   * index n fires on the tick the playhead is n and on no other.
   */
  private eventsAt(layer: Layer): readonly FiredEvent[] {
    // A one-shot that has run out sits on its last frame forever. Without this
    // the event on that frame would fire again on every tick that followed.
    if (layer.finished) return [];
    const clip = this.dominantClip(layer);
    if (!clip) return [];

    const cycle = this.cycleTicks(layer);
    const fired: FiredEvent[] = [];
    for (const event of clip.events) {
      if (this.eventIndex(layer, event.normalizedTime, cycle) === layer.clipTick) {
        fired.push({ name: event.name, clipId: clip.id, stateId: layer.stateId, tick: this.tickCount });
      }
    }
    // Ascending in clip time, so a step that lands two markers on one frame
    // reports them in the order they were authored rather than in map order.
    return fired;
  }

  private phaseOf(): 'windup' | 'active' | 'recovery' | null {
    const action = this.activeAction;
    if (action === null) return null;
    const total = actionTotalMs(action);
    if (total <= 0) return null;
    const elapsed = (this.tickCount - this.actionStartTick) * this.tickMs;
    if (elapsed >= total) return null;
    const t = elapsed / total;
    const windows = phaseWindows(action);
    if (t < windows.windup[1]) return 'windup';
    if (t < windows.active[1]) return 'active';
    return 'recovery';
  }

  /** True once the current state has run its course. */
  private get finished(): boolean {
    const state = this.stateOf(this.current);
    if (state?.loop === true) return false;
    return this.current.finished;
  }

  private conditionMet(condition: Condition, consume: boolean): boolean {
    switch (condition.kind) {
      case 'exit':
        return this.finished;
      case 'flag': {
        const declared = this.parameters.get(condition.parameter);
        const raised = this.pendingTriggers.has(condition.parameter) || declared === true;
        const value = condition.negated ? !raised : raised;
        if (value && consume) this.pendingTriggers.delete(condition.parameter);
        return value;
      }
      case 'compare': {
        const raw = this.parameters.get(condition.parameter);
        const value = typeof raw === 'number' ? raw : 0;
        switch (condition.op) {
          case '>':
            return value > condition.value;
          case '<':
            return value < condition.value;
          case '>=':
            return value >= condition.value;
          case '<=':
            return value <= condition.value;
          case '==':
            return value === condition.value;
          case '!=':
            return value !== condition.value;
        }
        return false;
      }
      case 'invalid':
        return false;
    }
  }

  private evaluateTransitions(): void {
    const state = this.stateOf(this.current);
    if (!state) return;

    // A terminal state has no exit. Stated once, here, rather than relied on
    // being absent from the transition table -- the validator forbids authoring
    // one, and this is what makes it true even if a document slips through.
    if (state.category === 'terminal') return;

    // A locking state refuses everything until recovery ends. That refusal is
    // the whole reason the category exists: committing to a blow means you are
    // committed, and a transition that could interrupt it would give the wind-up
    // back for free.
    if (state.category === 'locking' && !this.finished) return;

    for (const transition of this.unit.stateMachine.transitions) {
      if (transition.from !== '*' && transition.from !== this.current.stateId) continue;
      if (transition.to === this.current.stateId) continue;
      const condition = this.conditions.get(transition.condition);
      if (!condition || !this.conditionMet(condition, true)) continue;
      this.enter(transition.to, transition.durationMs);
      return;
    }

    // A one-shot that has run out and matched nothing returns where it came
    // from, which is what "overrides and returns" means.
    if (state.category === 'oneshot' && this.finished && this.returnTo !== null) {
      const back = this.returnTo;
      this.returnTo = null;
      this.enter(back, state.blendInMs);
    }
  }

  private enter(stateId: string, blendMs: number, rate?: number): void {
    const next = this.states.get(stateId);
    if (!next || stateId === this.current.stateId) return;

    const leaving = this.stateOf(this.current);
    // Only a loop state is worth coming back to. Returning into a one-shot or a
    // locking state would replay the blow that was just thrown.
    if (next.category === 'oneshot' && leaving?.category === 'loop') {
      this.returnTo = this.current.stateId;
    }

    this.outgoing = this.current;
    this.fadeTicks = Math.max(0, Math.round(blendMs / this.tickMs));
    this.fadeElapsed = 0;
    if (this.fadeTicks === 0) this.outgoing = null;

    this.current = {
      stateId,
      clipTick: -1,
      rate: (rate ?? next.timeScale) * (next.category === 'oneshot' ? this.actionRateScale : 1),
      finished: false,
    };
    if (next.clipRef !== this.activeAction?.clipRef) this.activeAction = null;
  }
}
