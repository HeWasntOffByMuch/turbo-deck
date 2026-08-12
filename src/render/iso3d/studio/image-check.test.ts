import { describe, expect, it } from 'vitest';
import {
  checkImage,
  MANUAL_CHECKS,
  MAX_ASPECT,
  measureImage,
  MIN_DIMENSION,
  worstSeverity,
  type Severity,
} from './image-check.js';

/**
 * Paints a synthetic reference image: a solid background with a solid rectangle
 * of subject in the middle. Enough to drive every measurement, and small enough
 * to read in a failure message.
 */
function paint(options: {
  width?: number;
  height?: number;
  background?: readonly [number, number, number];
  subject?: readonly [number, number, number];
  /** Fraction of the frame the subject occupies, centred. 1 fills it edge to edge. */
  subjectScale?: number;
  alpha?: number;
  /** Adds per-pixel noise to the background, for the busy-backdrop case. */
  noise?: number;
}): { width: number; height: number; data: Uint8ClampedArray } {
  const width = options.width ?? 1024;
  const height = options.height ?? 1024;
  const background = options.background ?? [20, 20, 24];
  const subject = options.subject ?? [220, 200, 160];
  const scale = options.subjectScale ?? 0.6;
  const alpha = options.alpha ?? 255;
  const noise = options.noise ?? 0;

  const data = new Uint8ClampedArray(width * height * 4);
  const halfW = (width * scale) / 2;
  const halfH = (height * scale) / 2;
  // A fixed pattern rather than Math.random: the same image every run, so a
  // threshold that only just passes cannot pass intermittently.
  let seed = 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside =
        Math.abs(x - width / 2) < halfW && Math.abs(y - height / 2) < halfH;
      const base = inside ? subject : background;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const jitter = inside ? 0 : ((seed % 1000) / 1000 - 0.5) * 2 * noise;
      const index = (y * width + x) * 4;
      data[index] = base[0] + jitter;
      data[index + 1] = base[1] + jitter;
      data[index + 2] = base[2] + jitter;
      data[index + 3] = alpha;
    }
  }
  return { width, height, data };
}

function findingsFor(options: Parameters<typeof paint>[0]): readonly string[] {
  const image = paint(options);
  return checkImage(measureImage(image.width, image.height, image.data)).map((finding) => finding.code);
}

describe('a clean reference image', () => {
  it('draws only the transparency note', () => {
    // The one thing a good opaque photograph still gets told. Everything else
    // measurable is fine, so nothing else fires.
    expect(findingsFor({})).toEqual(['image.opaque']);
  });

  it('says nothing at all when it also has an alpha background', () => {
    expect(findingsFor({ alpha: 0 })).toEqual([]);
  });
});

describe('what pixels can answer', () => {
  it('blocks an image too small to generate from', () => {
    expect(findingsFor({ width: MIN_DIMENSION - 1, height: MIN_DIMENSION - 1 })).toContain('image.small');
  });

  it('accepts one exactly at the floor', () => {
    expect(findingsFor({ width: MIN_DIMENSION, height: MIN_DIMENSION })).not.toContain('image.small');
  });

  it('warns about an extreme aspect ratio, either way round', () => {
    const wide = findingsFor({ width: 2048, height: 512 });
    const tall = findingsFor({ width: 512, height: 2048 });
    expect(wide).toContain('image.aspect');
    expect(tall).toContain('image.aspect');
    expect(findingsFor({ width: 1024, height: Math.floor(1024 / MAX_ASPECT) })).not.toContain('image.aspect');
  });

  it('blocks a subject that does not separate from its background', () => {
    // The measurable third of the brief's three warnings.
    expect(findingsFor({ background: [120, 120, 120], subject: [124, 122, 121] })).toContain('image.contrast');
  });

  it('warns about a busy background, as the honest proxy for occlusion risk', () => {
    // Mid-grey rather than the dark default: a Uint8ClampedArray clips negative
    // jitter against a near-black backdrop, which would halve the very variance
    // this is measuring and make the test pass or fail for the wrong reason.
    const busy = { background: [128, 128, 128] as const, noise: 90 };
    expect(findingsFor(busy)).toContain('image.busy');
    expect(findingsFor({ ...busy, noise: 0 })).not.toContain('image.busy');
  });

  it('warns when the subject runs off the frame', () => {
    // 0.95 rather than 1: a subject filling the frame edge to edge *is* the
    // background as far as any border/interior split can tell, and claiming to
    // detect it would be the kind of false confidence this module avoids.
    expect(findingsFor({ subjectScale: 0.95 })).toContain('image.cropped');
    expect(findingsFor({ subjectScale: 0.6 })).not.toContain('image.cropped');
  });
});

describe('ordering', () => {
  it('puts what will waste money first', () => {
    const image = paint({ width: 200, height: 200, background: [120, 120, 120], subject: [123, 121, 120] });
    const findings = checkImage(measureImage(image.width, image.height, image.data));
    const severities = findings.map((finding) => finding.severity);
    const rank: Record<Severity, number> = { blocker: 0, warning: 1, note: 2 };
    for (let i = 1; i < severities.length; i += 1) {
      const previous = severities[i - 1];
      const current = severities[i];
      if (!previous || !current) continue;
      expect(rank[previous]).toBeLessThanOrEqual(rank[current]);
    }
    expect(severities[0]).toBe('blocker');
  });

  it('reports the worst severity present, and null for a clean image', () => {
    expect(worstSeverity([])).toBeNull();
    expect(
      worstSeverity([
        { severity: 'note', code: 'a', message: '' },
        { severity: 'blocker', code: 'b', message: '' },
        { severity: 'warning', code: 'c', message: '' },
      ]),
    ).toBe('blocker');
  });
});

describe('measureImage', () => {
  it('separates the border from the interior', () => {
    const image = paint({ background: [0, 0, 0], subject: [255, 255, 255] });
    const stats = measureImage(image.width, image.height, image.data);
    expect(stats.borderMean[0]).toBeLessThan(10);
    // The interior mean is the subject diluted by the backdrop around it, which
    // is why it is not what the contrast measure uses.
    expect(stats.interiorMean[0]).toBeGreaterThan(60);
    // The contrast measure looks at the subject pixels themselves, so white on
    // black scores near one however much of the frame the figure occupies.
    expect(stats.subjectContrast).toBeGreaterThan(0.95);
  });

  it('measures the subject, not the average of the interior', () => {
    // A small figure and a large one on the same backdrop score the same: the
    // two-means version scored the small one as low contrast and would have
    // blocked a perfectly good reference image.
    const small = paint({ background: [0, 0, 0], subject: [255, 255, 255], subjectScale: 0.25 });
    const large = paint({ background: [0, 0, 0], subject: [255, 255, 255], subjectScale: 0.7 });
    const a = measureImage(small.width, small.height, small.data).subjectContrast;
    const b = measureImage(large.width, large.height, large.data).subjectContrast;
    expect(Math.abs(a - b)).toBeLessThan(0.02);
    expect(a).toBeGreaterThan(0.95);
  });

  it('notices transparency', () => {
    expect(measureImage(...Object.values(paint({ alpha: 0 })) as [number, number, Uint8ClampedArray]).hasAlpha).toBe(
      true,
    );
    expect(measureImage(...Object.values(paint({})) as [number, number, Uint8ClampedArray]).hasAlpha).toBe(false);
  });

  it('survives a one-pixel image without dividing by zero', () => {
    const stats = measureImage(1, 1, new Uint8ClampedArray([10, 20, 30, 255]));
    expect(Number.isFinite(stats.subjectContrast)).toBe(true);
    expect(Number.isFinite(stats.borderVariance)).toBe(true);
  });
});

describe('the manual checklist', () => {
  it('covers the failure modes no measurement can reach', () => {
    // The brief asks for warnings on complex poses and heavy occlusion. Neither
    // is measurable from pixels, so neither is claimed -- they live here, worded
    // for a person, and this test is what stops one quietly becoming a "check".
    const text = MANUAL_CHECKS.join(' ').toLowerCase();
    expect(text).toContain('pose');
    expect(text).toContain('occluded');
    expect(MANUAL_CHECKS.length).toBeGreaterThanOrEqual(4);
  });
});
