// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// CLAUDE.md states the sim/render split and the determinism rules as project
// law, but until now only `Math.random` had a rule behind it and the rest was
// "on you". Everything below puts the remaining rules where CI already looks:
// a violation fails `npm run lint` instead of waiting for a reviewer to spot it.

/**
 * The deterministic core. Nothing outside `src/render/` may reach for a
 * rendering library, the DOM, the wall clock, or ambient randomness — given a
 * seed and a sequence of timed inputs it has to produce bit-identical state.
 */
const DETERMINISTIC_CORE = [
  'src/shared/**/*.ts',
  'src/cards/**/*.ts',
  'src/sim/**/*.ts',
  'src/game/**/*.ts',
  'src/terrain/**/*.ts',
  'src/balance/**/*.ts',
  // The server's own sim (spec 056) carries the identical guarantee -- same
  // seed and inputs, same state -- and its purity is what lets single-player
  // run it inside a browser tab (spec 057). Only the halves that genuinely are
  // pure: net/, admin/, state/, loop.ts and server.ts read clocks and sockets
  // for a living, which is exactly why the boundary is drawn here.
  'src/server/sim/**/*.ts',
  'src/server/world/**/*.ts',
  'src/server/player/**/*.ts',
  'src/server/data/**/*.ts',
  // The unit authoring format and its validator (spec 107). Not a simulation,
  // but held to the same bar for the same reason the server's data tables are:
  // the Studio tab, the export path, the CI runner and the game's runtime all
  // read these documents through this one parser, and a parser that behaved
  // differently in a browser than in Node would make "the tool and the game read
  // the same files" false in exactly the way nobody would think to check.
  'src/units/**/*.ts',
  // The studio's decision-making half (spec 108). Named file by file rather
  // than by directory because the rest of `src/server/studio/` is the opposite
  // of pure -- it is fetch, fs, timers and an API key.
  //
  // These are the modules that decide whether to spend money, and holding them
  // to the core's rules is what makes that decision testable: no clock of their
  // own, no ambient randomness, every timestamp an argument. `ledger.ts` even
  // computes its UTC day boundary by hand rather than reach for `Date`.
  'src/server/studio/cache.ts',
  'src/server/studio/confirm.ts',
  'src/server/studio/jobs.ts',
  'src/server/studio/ledger.ts',
  'src/server/studio/pacing.ts',
  'src/server/studio/pricing.ts',
  'src/server/studio/types.ts',
];

/**
 * Subtrees that sit under `src/render/` for organisational reasons but carry the
 * same guarantee, because the whole point of them is that they run and are
 * tested headlessly: the cloth solver (spec 046), the critter data (spec 055),
 * the pure half of the map editor (specs 049-052), the pure half of the world
 * view (spec 063) -- interpolation, input intent, cast bars and which rig draws
 * what are all answerable in Node, and only `scene.ts`, `hud.ts` and `view.ts`
 * need a canvas -- and the sandbox mover (spec 066), which walks the tuning
 * viewports' unit around and must replay identically to be worth testing.
 */
const PURE_RENDER = [
  'src/render/cloth/**/*.ts',
  'src/render/critters/**/*.ts',
  'src/render/iso3d/sandbox-mover.ts',
  'src/render/iso3d/sandbox-mover.test.ts',
  // The weather's numbers and its shore distance transform (spec 073). The
  // shaders need a canvas; what the wind *is* and where the shore *is* are
  // arithmetic, and arithmetic that decides how the world looks should be
  // checkable in Node.
  'src/render/iso3d/wind.ts',
  'src/render/iso3d/wind.test.ts',
  'src/render/iso3d/shore-sdf.ts',
  'src/render/iso3d/shore-sdf.test.ts',
  // The lobed tree's silhouette (spec 077): the disc cluster its canopy outline
  // is walked from, and the trunk's taper, are both arithmetic -- and the
  // outline is the whole point of the species, so it is checked in Node rather
  // than by eye.
  'src/render/iso3d/lobe.ts',
  'src/render/iso3d/lobe.test.ts',
  // The hike look's settings and the sRGB transfer under them (spec 097). The
  // settings are plain data and the transfer is arithmetic the passes'
  // shaders transcribe -- and a shader expression nobody can execute is where
  // a typo lives forever, so the reference is held somewhere it can be run.
  // `color-space.test.ts` is deliberately *not* here: it imports three because
  // three's own behaviour is what it guards.
  'src/render/iso3d/hike.ts',
  'src/render/iso3d/hike.test.ts',
  // Welding normals across a crease angle, and turning one to follow the wind
  // (spec 097, step 2). Both are arithmetic, and the second is the reference the
  // sway shader's GLSL is a transcription of -- so it has to be somewhere that
  // can actually be run against it.
  'src/render/iso3d/shading.ts',
  'src/render/iso3d/shading.test.ts',
  // The window framing maths (specs 041, 089): what size buffer a CSS box wants,
  // the camera's orthographic box at that aspect, cursor-to-NDC, and the integer
  // upscale and pixel snap the virtual resolution is shown through. All
  // arithmetic, and the upscale factor is the one number in the renderer that is
  // wrong in a way nobody sees -- it just quietly resamples.
  'src/render/iso3d/view-frame.ts',
  'src/render/iso3d/view-frame.test.ts',
  // Finding outlines in the depth and normal buffers (spec 101). The plane
  // reconstruction is the expression this arc most depends on being right and
  // least able to check by eye -- a wrong sign draws lines down every hillside,
  // which looks like a threshold that needs tuning rather than like a bug.
  'src/render/iso3d/edges.ts',
  'src/render/iso3d/edges.test.ts',
  // What distance does to a fill (spec 103). The order the three terms are
  // applied in is the effect, and the order is the sort of thing that reads as
  // correct whichever way round it is written -- so it is asserted rather than
  // remembered.
  'src/render/iso3d/ink.ts',
  'src/render/iso3d/ink.test.ts',
  // How much a cell of ground folds (spec 104). The sign is the whole measure --
  // backwards it shades the ridges instead of the hollows, which still looks like
  // curvature shading and simply reads as light from somewhere impossible -- so it
  // is asserted against a real paraboloid in Node rather than judged by eye.
  'src/render/iso3d/curvature.ts',
  'src/render/iso3d/curvature.test.ts',
  // The soft shadow's sampling kernel (spec 105). Every Poisson disc in every
  // shader is a pasted table of magic vec2s that nobody can tell a good one from
  // a bad one by looking at -- so this one is grown from the seeded PRNG and its
  // minimum separation is asserted, which only works if it runs in Node.
  'src/render/iso3d/poisson.ts',
  'src/render/iso3d/poisson.test.ts',
  // The renderer's one texture and the maths its projection uses (spec 106). The
  // tile is generated rather than fetched, so what it *is* -- that it tiles, that
  // it spans its range, that it is the same tile every time -- is arithmetic, and
  // a tile that only nearly wraps draws a grid across every cliff in the world.
  'src/render/iso3d/detail-texture.ts',
  'src/render/iso3d/detail-texture.test.ts',
  'src/render/iso3d/surface-detail.ts',
  'src/render/iso3d/surface-detail.test.ts',
  'src/render/iso3d/world/appearance.ts',
  'src/render/iso3d/world/cast.ts',
  'src/render/iso3d/world/intent.ts',
  'src/render/iso3d/world/interpolate.ts',
  'src/render/iso3d/world/pixel-font.ts',
  'src/render/iso3d/world/spawner-overlay.ts',
  // Touch gesture recognition (spec 093). A tap is a fact about a sequence of
  // timed samples -- the timestamps are passed in on the sample rather than read
  // from a clock here, which is exactly what lets the rules be replayed in Node
  // instead of checked by hand on a phone.
  'src/render/iso3d/world/touch.ts',
  // The HUD's metrics and its weapon icons (spec 094). The HUD is DOM and can
  // only be checked by photographing it; whether eight buttons still fit across
  // a phone is a sum, and an icon is a string.
  'src/render/iso3d/world/hud-layout.ts',
  'src/render/iso3d/world/icons.ts',
  'src/render/iso3d/world/*.test.ts',
  // The Studio tab's decision-making half (spec 109). image-check.ts measures a
  // reference image and plan.ts derives whether a generation establishes a rig
  // family -- the shared-skeleton rule, which is money, and so is a function of
  // the library rather than a checkbox somebody has to remember to tick.
  'src/render/iso3d/studio/image-check.ts',
  'src/render/iso3d/studio/image-check.test.ts',
  'src/render/iso3d/studio/plan.ts',
  'src/render/iso3d/studio/plan.test.ts',
  'src/render/iso3d/editor/brush.ts',
  'src/render/iso3d/editor/camera.ts',
  'src/render/iso3d/editor/history.ts',
  'src/render/iso3d/editor/markers.ts',
  'src/render/iso3d/editor/scatter.ts',
  'src/render/iso3d/editor/*.test.ts',
];

const NO_AMBIENT_RANDOMNESS = [
  /** @type {const} */ ({
    object: 'Math',
    property: 'random',
    message:
      'Pure code must use the seeded PRNG (src/shared/prng.ts) passed in explicitly, not Math.random.',
  }),
];

const NO_WALL_CLOCK_OR_DOM = [
  { name: 'Date', message: 'Pure code must not read wall-clock time; it is a function of its inputs.' },
  { name: 'performance', message: 'Pure code must not read wall-clock time; the sim advances on a fixed 60Hz tick.' },
  { name: 'window', message: 'Pure code has no DOM. Take what you need as an argument and let src/render/ supply it.' },
  { name: 'document', message: 'Pure code has no DOM. Take what you need as an argument and let src/render/ supply it.' },
  { name: 'navigator', message: 'Pure code has no DOM. Take what you need as an argument and let src/render/ supply it.' },
  { name: 'localStorage', message: 'Pure code has no DOM. Persistence belongs in src/render/, which passes the loaded data in.' },
  { name: 'sessionStorage', message: 'Pure code has no DOM. Persistence belongs in src/render/, which passes the loaded data in.' },
  { name: 'requestAnimationFrame', message: 'Pure code never drives its own clock; the render loop decides how many ticks to advance.' },
  { name: 'cancelAnimationFrame', message: 'Pure code never drives its own clock; the render loop decides how many ticks to advance.' },
];

const NO_RENDERING_LIBRARIES = {
  paths: [
    { name: 'three', message: 'This module must run headlessly in Node. three.js belongs in src/render/.' },
    { name: 'pixi.js', message: 'This module must run headlessly in Node. PixiJS belongs in src/render/.' },
    { name: 'lil-gui', message: 'This module must run headlessly in Node. lil-gui belongs in src/render/.' },
  ],
  patterns: [
    {
      group: ['three/*', 'three/**'],
      message: 'This module must run headlessly in Node. three.js belongs in src/render/.',
    },
  ],
};

export default tseslint.config(
  {
    // tools/ holds vendored third-party code (the pixeldudesmaker generator and
    // its libs), captured as-is — not ours to lint against the strict config.
    ignores: ['dist/**', 'node_modules/**', 'tools/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Terrain (spec 043) is world data, not rendering: it carries the same
    // determinism guarantee as the sim, so it gets the same guard rails.
    files: DETERMINISTIC_CORE,
    rules: {
      'no-restricted-properties': ['error', ...NO_AMBIENT_RANDOMNESS],
      'no-restricted-globals': ['error', ...NO_WALL_CLOCK_OR_DOM],
      'no-restricted-imports': [
        'error',
        {
          ...NO_RENDERING_LIBRARIES,
          patterns: [
            ...NO_RENDERING_LIBRARIES.patterns,
            {
              // The dependency arrow points one way: src/render/ reads sim state,
              // never the reverse. An import back into the renderer is the sim
              // acquiring a rendering dependency by the back door.
              group: ['**/render', '**/render/**'],
              message: 'The sim never imports the renderer. src/render/ reads sim state, not the other way round.',
            },
          ],
        },
      ],
    },
  },
  {
    // src/shared/ is the bottom of the stack: PRNG, spatial hash, world extent.
    // It is imported by sim, cards and terrain, so it may not import them back.
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...NO_RENDERING_LIBRARIES,
          patterns: [
            ...NO_RENDERING_LIBRARIES.patterns,
            {
              group: ['..', '../*', '../**'],
              message: 'src/shared/ is dependency-free — it is imported by sim, cards and terrain, and imports none of them.',
            },
          ],
        },
      ],
    },
  },
  {
    files: PURE_RENDER,
    rules: {
      'no-restricted-properties': ['error', ...NO_AMBIENT_RANDOMNESS],
      'no-restricted-globals': ['error', ...NO_WALL_CLOCK_OR_DOM],
      'no-restricted-imports': ['error', NO_RENDERING_LIBRARIES],
    },
  },
);
