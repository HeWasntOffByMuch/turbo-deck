/**
 * Every tunable of the hooded-robe character in one place (spec 037).
 *
 * This is deliberately a **flat record of plain numbers**: it is the single
 * object the sandbox's slider panel binds to, the single object the solver and
 * the wind field read, and the single object a future preset ("heavy wool",
 * "light silk") would be. Nothing here is read by the sim -- the whole character
 * is cosmetic -- and nothing here is a three.js type, so the solver stays
 * testable in Node.
 *
 * Units: distances are **world units**, and the figure is ~78 units tall, so
 * {@link UNITS_PER_METRE} converts to SI where a real-world number is useful.
 * Rates ending in "speed"/"stiffness" are per second unless stated otherwise.
 *
 * Booleans are encoded as 0/1 numbers so the panel can drive every field through
 * the same code path (`tuning[key] = Number(input.value)`).
 */

/**
 * World units per metre. The robed figure stands ~78 units tall, which reads as
 * a ~1.8 m human, so 1 m ~= 43 units. Used to express gravity and wind speeds in
 * numbers a person can reason about.
 */
export const UNITS_PER_METRE = 43;

/** Earth gravity in world units/s^2 (9.81 m/s^2). `gravityMultiplier` scales it. */
export const GRAVITY = 9.81 * UNITS_PER_METRE;

/** The full tuning surface of the robe: fabric, forces, collision, wind, figure. */
export interface RobeTuning {
  // --- Fabric -------------------------------------------------------------
  /**
   * Mass of one patch of fabric (arbitrary units; 1 is a mid-weight wool).
   * Gravity is mass-independent, so this does **not** change how fast the robe
   * falls -- it changes how much the *air* can move it. Heavier fabric is
   * pushed around less by wind, drag and the character's own motion, so it
   * hangs closer to the body and swings more slowly. Lighter fabric flutters.
   */
  fabricWeight: number;
  /**
   * Stretch stiffness (0..1) of the structural/shear distance constraints: how
   * hard the weave resists being pulled longer or shorter. 1 is inextensible
   * (crisp, canvas-like), lower values let the panel sag and stretch (knitwear).
   * Applied per solver iteration in an iteration-count-independent way, so
   * changing `iterations` does not change the apparent stiffness.
   */
  stiffness: number;
  /**
   * Bend stiffness (0..1) of the second-order (skip-one) constraints: how hard
   * the fabric resists *folding*. This is the knob that separates limp silk
   * (near 0, many small folds) from stiff felt (high, few broad folds). Keep it
   * well below `stiffness` -- real cloth stretches far less easily than it bends.
   *
   * **Do not lower this without re-checking a hard landing.** A hanging tube has
   * two failure modes that cost nothing in distance-constraint terms, so the
   * solver settles happily into either and never comes out:
   *  - *buckling*: the vertical chains fold into a wave that shortens the drop,
   *    leaving the robe permanently hitched up;
   *  - *hem inversion*: the bottom ring curls up inside the tube and stays there.
   *
   * Bend resistance is the only thing that prevents both, and it is cheap.
   * Measured across 0.14..0.65 against drops of 46/120/200 units: 0.14 buckled
   * on every landing, 0.28 still inverted the hem on a 200-unit fall, and 0.45
   * was clean at every height. The cost of 0.14 -> 0.45 is about 10% of the hem's
   * wind sway and 3% of its trail behind a run -- worth it for a default, and
   * the slider is right there for anyone who wants limper cloth and no falling.
   */
  bendStiffness: number;
  /**
   * Velocity damping (1/s), applied as `exp(-damping * dt)` so it is
   * frame-rate independent. This is internal friction in the weave: it is what
   * makes a swing oscillate a few times and die out instead of ringing forever.
   * Too low reads as rubbery, too high reads as underwater.
   */
  damping: number;
  /**
   * Maximum stretch as a multiple of the bind-pose distance from a particle to
   * its attachment ring (1 = cannot move away from the body at all, 1.15 is a
   * normal safety cap). Enforced as a hard positional clamp *after* the
   * constraint solve, so no amount of wind, speed or teleporting can balloon
   * the robe or leave it behind.
   */
  maxStretch: number;
  /**
   * Pose-retention spring (1/s) pulling every particle toward its skinned rest
   * position (where the fabric would hang if it were rigidly attached to the
   * bones). This is not physical -- it is the tailoring: it stops the robe
   * drifting into a shape it can never leave, and keeps the silhouette
   * recognisable while moving. Weighted per particle: strong near the
   * attachment rings, near zero at the hem, so only the free edges truly fly.
   */
  springStrength: number;
  /**
   * Extra settle rate (1/s) toward the rest pose, faded in **only while the
   * character is still**. Raising it makes the robe come to rest promptly after
   * movement stops; lowering it lets it keep swinging for longer. Separate from
   * `springStrength` so "how much the silhouette is held while running" and
   * "how quickly it settles when you stop" tune independently.
   */
  recoverySpeed: number;

  // --- Forces -------------------------------------------------------------
  /** Multiplier on {@link GRAVITY}. Below 1 reads as lighter/floatier fabric. */
  gravityMultiplier: number;
  /**
   * Isotropic air drag coefficient: force per unit of relative air velocity,
   * divided by `fabricWeight`. Resists motion in every direction and is the
   * main source of the trailing lag when the character accelerates.
   */
  airResistance: number;
  /**
   * Wind pressure coefficient on the *normal* component of the relative air
   * velocity. Because it is projected onto each particle's surface normal, a
   * panel broadside to the wind billows and an edge-on panel slices through --
   * the difference between fabric and a flag-shaped rag. Scaled by
   * `fabricWeight` like `airResistance`.
   */
  windInfluence: number;
  /**
   * Inertia multiplier: how strongly the free fabric feels the *pseudo-force*
   * of the character accelerating under it (`a_cloth -= a_body * this`). This is
   * the knob for whip on a hard direction change and for the robe getting left
   * behind on a sprint start. 1 is physically neutral; higher exaggerates.
   */
  inertiaMultiplier: number;
  /**
   * Movement influence: extra apparent headwind generated by the character's
   * own travel, as a fraction of body velocity. 0 is physically honest (the
   * cloth's own drag through still air already produces streaming); above 0
   * exaggerates how much a run pins the robe backward.
   */
  movementInfluence: number;
  /** Upward velocity (world units/s) kicked into the free fabric on a jump launch. */
  jumpImpulse: number;
  /** Upward velocity (world units/s) kicked in on landing, scaled by impact speed. */
  landImpulse: number;
  /**
   * Idle sway: amplitude (world units/s^2) of a slow, per-particle noise force
   * applied only while the character is standing still, so the robe is never
   * perfectly static. Paired with the figure's breathing.
   */
  idleSway: number;

  // --- Collision + solver -------------------------------------------------
  /**
   * Extra clearance (world units) added to every body capsule's radius when
   * pushing cloth out of it. A small positive margin keeps the fabric visibly
   * off the skin and hides the flat-shaded facets poking through.
   */
  collisionRadius: number;
  /**
   * Constraint iterations per substep. More makes the fabric behave closer to
   * its nominal `stiffness`; the apparent stiffness itself is held constant, so
   * this trades cost against how inextensible the weave really is.
   */
  iterations: number;
  /**
   * Physics substeps per rendered frame. The solver already clamps its internal
   * step, so this mainly buys accuracy under fast motion. 2 is plenty.
   */
  substeps: number;

  // --- Wind ---------------------------------------------------------------
  /** 1 to enable the wind field, 0 to ramp it smoothly to nothing. */
  windEnabled: number;
  /** Wind heading in degrees; 0 blows toward world +x, 90 toward world +z. */
  windDirection: number;
  /** Sustained wind speed in world units/s (~43 u/s == 1 m/s). */
  windStrength: number;
  /** Peak extra speed added by gusts, in world units/s. */
  gustStrength: number;
  /** Gust rate in Hz: how often the gust envelope swells and drops. */
  gustFrequency: number;
  /**
   * Turbulence (0..1): how much the wind wanders in direction, and how much the
   * per-particle wind varies across a panel. 0 is a wind tunnel; high is gusty
   * and messy.
   */
  windTurbulence: number;
  /**
   * Transition rate (1/s) for direction/strength changes and for
   * enabling/disabling. Low values make the wind rise and die slowly; this is
   * what keeps a slider drag from snapping the whole robe sideways.
   */
  windTransition: number;

  // --- Figure (cosmetic locomotion) ---------------------------------------
  /** Overall figure size; scales the skeleton, the cloth and every distance above. */
  bodyScale: number;
  /** Stride length multiplier: lower means quicker, shorter steps at a given speed. */
  strideScale: number;
  /** Arm-swing amplitude (radians at a full run). Drives the sleeves. */
  armSwing: number;
  /** Hop height in world units, for the sandbox's jump/land/fall testing. */
  jumpHeight: number;
}

/** The default robe tuning: a mid-weight wool robe in a light breeze. */
export function defaultRobeTuning(): RobeTuning {
  return {
    // Fabric
    fabricWeight: 1,
    stiffness: 0.92,
    bendStiffness: 0.45,
    damping: 1.4,
    maxStretch: 1.12,
    springStrength: 2.2,
    recoverySpeed: 2.6,
    // Forces
    gravityMultiplier: 1,
    airResistance: 1.1,
    windInfluence: 2.9,
    inertiaMultiplier: 1,
    movementInfluence: 0.35,
    jumpImpulse: 55,
    landImpulse: 40,
    idleSway: 26,
    // Collision + solver
    collisionRadius: 1.2,
    iterations: 4,
    substeps: 2,
    // Wind
    windEnabled: 1,
    windDirection: 35,
    windStrength: 70,
    gustStrength: 55,
    gustFrequency: 0.35,
    windTurbulence: 0.35,
    windTransition: 1.2,
    // Figure
    bodyScale: 1,
    strideScale: 1,
    armSwing: 0.55,
    jumpHeight: 46,
  };
}

/**
 * Safe [min, max] bounds for every field. Like the mech's, these are deliberately
 * generous: they exist to stop a NaN, an infinity or an absurd value from a stray
 * edit reaching the solver (where one bad number propagates through the
 * constraint graph and detonates the whole robe), not to second-guess the sliders.
 */
export const ROBE_BOUNDS: Record<keyof RobeTuning, readonly [number, number]> = {
  fabricWeight: [0.05, 20],
  stiffness: [0, 1],
  bendStiffness: [0, 1],
  damping: [0, 40],
  maxStretch: [1, 4],
  springStrength: [0, 60],
  recoverySpeed: [0, 60],
  gravityMultiplier: [0, 6],
  airResistance: [0, 30],
  windInfluence: [0, 40],
  inertiaMultiplier: [0, 8],
  movementInfluence: [0, 4],
  jumpImpulse: [0, 600],
  landImpulse: [0, 600],
  idleSway: [0, 400],
  collisionRadius: [0, 20],
  iterations: [1, 16],
  substeps: [1, 8],
  windEnabled: [0, 1],
  windDirection: [-720, 720],
  windStrength: [0, 800],
  gustStrength: [0, 800],
  gustFrequency: [0, 8],
  windTurbulence: [0, 1],
  windTransition: [0.05, 40],
  bodyScale: [0.3, 4],
  strideScale: [0.3, 3],
  armSwing: [0, 2],
  jumpHeight: [0, 400],
};

/** Clamp `v` into [lo, hi], substituting `fallback` for NaN/±∞. */
function sclamp(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Clamp every field to {@link ROBE_BOUNDS} in place, replacing any non-finite
 * value with the default. Called once at the top of every frame, before anything
 * reads the tuning, so the solver can trust every number it is handed.
 */
export function sanitizeRobeTuning(t: RobeTuning): void {
  const def = defaultRobeTuning();
  for (const key of Object.keys(ROBE_BOUNDS) as (keyof RobeTuning)[]) {
    const bound = ROBE_BOUNDS[key];
    t[key] = sclamp(t[key], bound[0], bound[1], def[key]);
  }
  // Counts must be whole numbers; the sliders step by 1 but a preset need not.
  t.iterations = Math.round(t.iterations);
  t.substeps = Math.round(t.substeps);
}
