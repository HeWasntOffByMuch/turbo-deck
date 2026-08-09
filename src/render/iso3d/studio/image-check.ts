/**
 * What a reference image can be told about itself (spec 109).
 *
 * The brief asks for a warning on "complex poses, heavy occlusion, low contrast
 * against background". Two of those three cannot be measured from pixels without
 * a model, and a checker that claimed to detect them would be actively harmful:
 * a green tick that means nothing is exactly how a bad reference image gets
 * generated a second time, at full price.
 *
 * So this measures what pixels can actually answer, and the panel shows the rest
 * as a checklist worded for a person. The division is the honest one, and it is
 * why {@link MANUAL_CHECKS} lives here beside the automatic ones rather than
 * being buried in the view -- they are two halves of the same advice.
 *
 * Pure: takes width, height and RGBA bytes, returns findings. No DOM, no canvas,
 * so the whole thing is tested against synthetic images built in Node.
 */

export type Severity = 'blocker' | 'warning' | 'note';

export interface ImageFinding {
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
}

export interface ImageStats {
  readonly width: number;
  readonly height: number;
  /** Mean RGB of a frame of pixels around the edge. */
  readonly borderMean: readonly [number, number, number];
  /** Mean RGB of the middle of the picture. */
  readonly interiorMean: readonly [number, number, number];
  /** 0..1. How much the border varies -- a busy background scores high. */
  readonly borderVariance: number;
  /**
   * 0..1. How far the subject sits from the background's colour.
   *
   * Measured over the interior pixels that actually *are* subject -- the ones
   * that differ from the background at all -- rather than as the distance
   * between two means. A figure occupying a third of the frame would drag an
   * interior mean most of the way back to the backdrop, and a perfectly crisp
   * white subject on black would score under a half and read as low contrast.
   */
  readonly subjectContrast: number;
  /** Fraction of edge pixels that differ from the border's mean. */
  readonly edgeTouch: number;
  readonly hasAlpha: boolean;
}

/** How thick the border frame is, as a fraction of the shorter side. */
const BORDER_FRACTION = 0.06;

/**
 * Below this, the generator has nothing to work from. A face limit in the
 * thousands cannot be met by detail that is not in the picture.
 */
export const MIN_DIMENSION = 512;
/** Past this the subject is a sliver, and the mesh comes back stretched. */
export const MAX_ASPECT = 2;
/** Under this the subject does not separate from what is behind it. */
export const MIN_SUBJECT_CONTRAST = 0.12;
/** Over this the background has as much going on as the subject. */
export const MAX_BORDER_VARIANCE = 0.16;
/** Over this fraction of edge pixels differing, the subject is cropped. */
export const MAX_EDGE_TOUCH = 0.12;
/**
 * How far an interior pixel must sit from the backdrop to count as subject.
 *
 * Low, because it only has to exclude sensor noise and compression ringing --
 * anything a person would call part of the figure clears it easily, and setting
 * it high would quietly exclude the shadowed side of the subject.
 */
const SUBJECT_FLOOR = 0.05;

function rgbAt(rgba: Uint8ClampedArray | Uint8Array, index: number): [number, number, number] {
  return [rgba[index] ?? 0, rgba[index + 1] ?? 0, rgba[index + 2] ?? 0];
}

/** Euclidean distance between two colours, normalised so 1 is black to white. */
function colorDistance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db) / (255 * Math.sqrt(3));
}

/**
 * Measures an image.
 *
 * The border/interior split is the whole trick: a reference image is a subject
 * on a background, the background is what touches the frame, and the subject is
 * what is in the middle. It is crude and it is right often enough to be worth
 * saying -- and when it is wrong, it is wrong in the direction of warning about
 * an image that was fine, which costs a glance rather than a generation.
 */
export function measureImage(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array): ImageStats {
  const border = Math.max(1, Math.floor(Math.min(width, height) * BORDER_FRACTION));

  let borderR = 0;
  let borderG = 0;
  let borderB = 0;
  let borderCount = 0;
  let interiorR = 0;
  let interiorG = 0;
  let interiorB = 0;
  let interiorCount = 0;
  let hasAlpha = false;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const [r, g, b] = rgbAt(rgba, index);
      if ((rgba[index + 3] ?? 255) < 250) hasAlpha = true;

      const onBorder = x < border || y < border || x >= width - border || y >= height - border;
      if (onBorder) {
        borderR += r;
        borderG += g;
        borderB += b;
        borderCount += 1;
      } else {
        interiorR += r;
        interiorG += g;
        interiorB += b;
        interiorCount += 1;
      }
    }
  }

  const borderMean: [number, number, number] =
    borderCount === 0 ? [0, 0, 0] : [borderR / borderCount, borderG / borderCount, borderB / borderCount];
  const interiorMean: [number, number, number] =
    interiorCount === 0 ? [0, 0, 0] : [interiorR / interiorCount, interiorG / interiorCount, interiorB / interiorCount];

  // Second pass, for the three measures that need the border's mean.
  let variance = 0;
  let differing = 0;
  let edgePixels = 0;
  let subjectDistance = 0;
  let subjectPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const distance = colorDistance(rgbAt(rgba, index), borderMean);
      const onBorder = x < border || y < border || x >= width - border || y >= height - border;
      if (onBorder) {
        variance += distance;
        edgePixels += 1;
        // "Differs enough to be the subject rather than noise in the backdrop."
        if (distance > 0.2) differing += 1;
        continue;
      }
      // Interior. Anything meaningfully unlike the backdrop is the subject.
      if (distance > SUBJECT_FLOOR) {
        subjectDistance += distance;
        subjectPixels += 1;
      }
    }
  }

  return {
    width,
    height,
    borderMean,
    interiorMean,
    borderVariance: edgePixels === 0 ? 0 : variance / edgePixels,
    // Zero when nothing in the interior stands out at all, which is exactly the
    // "subject does not separate from its background" case worth blocking.
    subjectContrast: subjectPixels === 0 ? 0 : subjectDistance / subjectPixels,
    edgeTouch: edgePixels === 0 ? 0 : differing / edgePixels,
    hasAlpha,
  };
}

const ORDER: Readonly<Record<Severity, number>> = { blocker: 0, warning: 1, note: 2 };

/**
 * Turns measurements into advice, worst first.
 *
 * Sorted by severity because the panel shows these in a list and the thing that
 * will waste money should not be the fourth line.
 */
export function checkImage(stats: ImageStats): readonly ImageFinding[] {
  const findings: ImageFinding[] = [];

  if (stats.width < MIN_DIMENSION || stats.height < MIN_DIMENSION) {
    findings.push({
      severity: 'blocker',
      code: 'image.small',
      message: `${stats.width}x${stats.height} is below ${MIN_DIMENSION}px on a side. The generator cannot invent detail that is not in the picture.`,
    });
  }

  const aspect = Math.max(stats.width / stats.height, stats.height / stats.width);
  if (aspect > MAX_ASPECT) {
    findings.push({
      severity: 'warning',
      code: 'image.aspect',
      message: `aspect ratio is ${aspect.toFixed(2)}:1. Past ${MAX_ASPECT}:1 the subject comes back stretched; crop closer to square.`,
    });
  }

  if (stats.subjectContrast < MIN_SUBJECT_CONTRAST) {
    findings.push({
      severity: 'blocker',
      code: 'image.contrast',
      message: `the subject barely separates from its background (contrast ${stats.subjectContrast.toFixed(3)}, want ${MIN_SUBJECT_CONTRAST}). Put it on a plain backdrop that is not its own colour.`,
    });
  }

  if (stats.borderVariance > MAX_BORDER_VARIANCE) {
    findings.push({
      severity: 'warning',
      code: 'image.busy',
      message: `the background is busy (variance ${stats.borderVariance.toFixed(3)}). A cluttered backdrop is what occlusion looks like to the generator -- it will model some of it.`,
    });
  }

  if (stats.edgeTouch > MAX_EDGE_TOUCH) {
    findings.push({
      severity: 'warning',
      code: 'image.cropped',
      message: `the subject reaches the frame on ${(stats.edgeTouch * 100).toFixed(0)}% of the edge. A limb cut off by the crop comes back cut off.`,
    });
  }

  if (!stats.hasAlpha) {
    findings.push({
      severity: 'note',
      code: 'image.opaque',
      message: 'no transparency. A cut-out subject on an alpha background generates more cleanly than one on a painted backdrop.',
    });
  }

  return findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

/**
 * The half no measurement can make.
 *
 * Shown as a checklist rather than as a result, so nothing here ever reads as
 * "checked and fine". These are the failure modes that actually cost the most
 * and they need eyes.
 */
export const MANUAL_CHECKS: readonly string[] = [
  'One figure, not a group or a scene.',
  'An A-pose or T-pose. A dynamic pose bakes the pose into the mesh, and the rig then has to fight it.',
  'Arms and legs clear of the body. Anything touching the torso tends to fuse to it.',
  'Nothing in front of the figure. An occluded limb is invented rather than modelled.',
  'Shot square on, not from above or below.',
];

/** The worst severity present, or null for a clean image. */
export function worstSeverity(findings: readonly ImageFinding[]): Severity | null {
  let worst: Severity | null = null;
  for (const finding of findings) {
    if (worst === null || ORDER[finding.severity] < ORDER[worst]) worst = finding.severity;
  }
  return worst;
}
