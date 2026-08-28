/**
 * An attribute, as a progression track (spec 244).
 *
 * Six tracks, and the assembler that turns the two content tables into one
 * ordered thing a sheet can draw. It is here rather than in the client's read
 * model because the *shape* of a track is content -- which thresholds exist, what
 * sits on each -- and the read model's job is to say where one character stands
 * on it. Two callers, so the audit and the sheet cannot come to different answers
 * about what a track is.
 *
 * What a node is:
 *
 * ```
 *   STRENGTH   5 ──── 10 ──── 20 ──── 25 ──── 35 ──── 40 ──── 50
 *                      │       │       │       │       │       │
 *                      │    (auto)     │    (auto)     │    (auto)
 *                      ├ Crushing Blows ●●●            │
 *                      ├ Committed Swing ●●●───────────┘
 *                      │                 ├ Brutal Follow-Through ●●●
 *                      │                 ├ Heavy Handling ●●●
 *                      │                 └ Overkill ●●●
 *                      └ Unstoppable ● ───────────────────────────┘
 * ```
 *
 * A node carries an automatic milestone, some purchasable specializations, or --
 * as it happens, never both, since the two tables sit on different thresholds.
 * The type allows both anyway: a threshold is a place on a track, and which kinds
 * of thing hang off it is the tables' business rather than this type's.
 *
 * The thresholds are the tables' own and are not restated here. That matters more
 * than it looks: 10/25/40 and 20/35/50 were tuned against each other over several
 * specs, and a track built from a list of numbers in a third file would be a
 * second answer to where a mechanic sits.
 *
 * Pure data. No behaviour beyond assembly, and nothing about layout -- where a
 * node is *drawn* is the client's, and deliberately never crosses the wire.
 */

import { ATTRIBUTE_KEYS, type AttributeKey } from './attributes.js';
import { ALL_MILESTONES, type MilestoneDefinition } from './milestones.js';
import { SCALING } from './scaling.js';
import { ALL_SPECIALIZATIONS, type SpecializationDefinition } from './specializations.js';

/** One threshold on a track, and everything that happens at it. */
export interface TrackNode {
  readonly threshold: number;
  /** Fires on its own the moment the attribute reaches the threshold. */
  readonly milestone: MilestoneDefinition | null;
  /** Unlocked here; each tier costs a progression point. */
  readonly specializations: readonly SpecializationDefinition[];
}

export interface Track {
  readonly attribute: AttributeKey;
  /** Where the track starts: what every character has before spending anything. */
  readonly from: number;
  /** Where it ends: {@link SCALING.attributeHardCap}. */
  readonly to: number;
  readonly nodes: readonly TrackNode[];
}

function nodesFor(attribute: AttributeKey): readonly TrackNode[] {
  const thresholds = new Set<number>();
  for (const milestone of ALL_MILESTONES) {
    if (milestone.attribute === attribute) thresholds.add(milestone.threshold);
  }
  for (const specialization of ALL_SPECIALIZATIONS) {
    if (specialization.attribute === attribute) thresholds.add(specialization.requires);
  }

  return [...thresholds]
    .sort((a, b) => a - b)
    .map((threshold) => ({
      threshold,
      milestone:
        ALL_MILESTONES.find(
          (milestone) => milestone.attribute === attribute && milestone.threshold === threshold,
        ) ?? null,
      // Sorted by id so a node's specializations come back in the same order
      // every time. `ALL_SPECIALIZATIONS` order is authoring order, which is
      // stable but is a fact about the file rather than a contract.
      specializations: ALL_SPECIALIZATIONS.filter(
        (specialization) =>
          specialization.attribute === attribute && specialization.requires === threshold,
      )
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    }));
}

const TRACKS: ReadonlyMap<AttributeKey, Track> = new Map(
  ATTRIBUTE_KEYS.map((attribute) => [
    attribute,
    {
      attribute,
      from: SCALING.startingAttribute,
      to: SCALING.attributeHardCap,
      nodes: nodesFor(attribute),
    },
  ]),
);

export function trackFor(attribute: AttributeKey): Track {
  const track = TRACKS.get(attribute);
  // Every key in ATTRIBUTE_KEYS has an entry by construction; this is the
  // narrowing rather than a fallback anybody should reach.
  if (!track) throw new Error(`no track for attribute: ${attribute}`);
  return track;
}

export const ALL_TRACKS: readonly Track[] = ATTRIBUTE_KEYS.map((key) => trackFor(key));
