/**
 * The colour grade (spec 047): the optional filter that turns the finished
 * frame black and white, or pushes it toward a hue for an evening, a moonlit
 * night, and so on.
 *
 * Pure and free of three.js and the DOM, like `retro.ts` beside it. The
 * functions here are the reference model; the fragment shader in
 * `retro-pass.ts` computes the same expression, and the presets are plain data
 * so "and so on" is a table entry rather than a code path.
 *
 * The grade runs *before* quantization, which is the one placement decision
 * worth stating: a black-and-white frame graded first is then quantized into a
 * proper N-step grey ramp and dithered across it, where grading afterwards
 * would spend the palette on colours it is about to discard.
 */

/** Rec. 709 luma weights -- how bright each channel reads to the eye. */
const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;

/** A grade, as plain numbers the panel edits and the shader consumes. */
export interface GradeSettings {
  /** 1 keeps the original colour, 0 collapses it to greyscale. */
  readonly saturation: number;
  /** The hue everything is pushed toward, packed RGB. */
  readonly tint: number;
  /** How far toward the tint; 0 leaves the hue alone. */
  readonly tintStrength: number;
  /** Overall brightness multiplier applied last. */
  readonly gain: number;
}

/** A named grade the panel offers. */
export interface GradePreset {
  readonly id: string;
  readonly label: string;
  readonly settings: GradeSettings;
}

/** The identity grade: what "off" means. */
export const GRADE_NONE: GradeSettings = { saturation: 1, tint: 0xffffff, tintStrength: 0, gain: 1 };

/**
 * The offered grades.
 *
 * `mono` is the plain black-and-white ask. The rest are the "evenings, full
 * moons etc." ask, and each is a *partial* desaturation plus a hue rather than
 * a flat colour wash -- keeping a little of the original saturation is what
 * stops a tinted scene turning into a single-colour silhouette, so the palette
 * still reads underneath the mood.
 *
 * `fullmoon` is the one that gains *up*: a full moon is the night you can see
 * by, so it is brighter and paler than plain moonlight rather than merely a
 * different blue.
 */
export const GRADE_PRESETS: readonly GradePreset[] = [
  { id: 'none', label: 'Off', settings: GRADE_NONE },
  { id: 'mono', label: 'Black & white', settings: { saturation: 0, tint: 0xffffff, tintStrength: 0, gain: 1 } },
  { id: 'evening', label: 'Evening', settings: { saturation: 0.4, tint: 0xffb877, tintStrength: 0.55, gain: 0.97 } },
  { id: 'moonlight', label: 'Moonlight', settings: { saturation: 0.24, tint: 0x6f9fd8, tintStrength: 0.75, gain: 0.9 } },
  { id: 'fullmoon', label: 'Full moon', settings: { saturation: 0.16, tint: 0xa8c8f0, tintStrength: 0.7, gain: 1.12 } },
  { id: 'bloodmoon', label: 'Blood moon', settings: { saturation: 0.3, tint: 0xd85a4a, tintStrength: 0.68, gain: 0.95 } },
];

export const DEFAULT_GRADE_ID = 'none';
/** How strongly a chosen preset is applied by default. */
export const DEFAULT_GRADE_STRENGTH = 1;

/** Look up a preset by id, falling back to the identity. */
export function gradePreset(id: string): GradePreset {
  return GRADE_PRESETS.find((p) => p.id === id) ?? (GRADE_PRESETS[0] as GradePreset);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * A preset blended back toward the identity by `strength` (0 = off, 1 = full).
 * Blending the *settings* rather than the output means the panel's strength
 * slider costs the shader nothing -- it still applies exactly one grade.
 */
export function resolveGrade(preset: GradePreset, strength: number): GradeSettings {
  const s = Math.min(1, Math.max(0, strength));
  return {
    saturation: lerp(1, preset.settings.saturation, s),
    tint: preset.settings.tint,
    tintStrength: preset.settings.tintStrength * s,
    gain: lerp(1, preset.settings.gain, s),
  };
}

/** Whether a grade would leave the image untouched -- so the pass can skip it. */
export function gradeIsIdentity(g: GradeSettings): boolean {
  return g.saturation === 1 && g.tintStrength === 0 && g.gain === 1;
}

/** Luma of a 0..1 RGB triple. */
export function luma(r: number, g: number, b: number): number {
  return r * LUMA.r + g * LUMA.g + b * LUMA.b;
}

/** A packed RGB colour as a 0..1 triple. */
export function unpackColor(hex: number): readonly [number, number, number] {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

/**
 * Grade one colour. The reference model the fragment shader mirrors term for
 * term, and the thing the tests assert against.
 *
 * Three steps:
 *
 * 1. **Desaturate** toward the colour's own luma.
 * 2. **Tint**, toward `luma * (tint / luma(tint))`. Normalising the tint by its
 *    own luminance is the part that matters: without it a strong blue tint --
 *    whose luma is barely a quarter -- would also be a 75% dimmer, so every
 *    attempt to tune the hue would fight the brightness.
 * 3. **Gain**, so a preset can be brighter or darker than what it graded.
 *
 * Clamped at the end because the tint normalisation can push a saturated
 * channel above 1, and the quantization that follows expects 0..1.
 */
export function gradeColor(
  rgb: readonly [number, number, number],
  settings: GradeSettings,
): [number, number, number] {
  const [r, g, b] = rgb;
  const grey = luma(r, g, b);

  const desat: [number, number, number] = [
    lerp(grey, r, settings.saturation),
    lerp(grey, g, settings.saturation),
    lerp(grey, b, settings.saturation),
  ];

  const tint = unpackColor(settings.tint);
  const tintLuma = Math.max(1e-4, luma(tint[0], tint[1], tint[2]));
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const toned = grey * ((tint[i] as number) / tintLuma);
    const mixed = lerp(desat[i] as number, toned, settings.tintStrength);
    out[i] = Math.min(1, Math.max(0, mixed * settings.gain));
  }
  return out;
}
