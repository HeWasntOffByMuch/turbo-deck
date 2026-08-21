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
  // The grid the prop field batches by (spec 195), out of `props.ts` in spec 211
  // so the editor's pure half can ask where a region is without importing three.
  'src/render/iso3d/prop-regions.ts',
  'src/render/iso3d/world/appearance.ts',
  // What a monster's rig is built with (spec 152) -- the drawn half of an enemy,
  // beside the file that says which rig draws it. Pure for the reason the rest
  // of this directory's decision-making is: a look is a row of numbers, and a
  // row of numbers is checkable in Node against the table it must not duplicate.
  'src/render/iso3d/world/monster-look.ts',
  'src/render/iso3d/world/cast.ts',
  'src/render/iso3d/world/intent.ts',
  'src/render/iso3d/world/control-actions.ts',
  'src/render/iso3d/world/interpolate.ts',
  'src/render/iso3d/world/pixel-font.ts',
  'src/render/iso3d/world/spawner-overlay.ts',
  // The white chunk a blow leaves on a floating bar (spec 145). A throttle is a
  // fact about a sequence of timed reads, and the time is an argument -- which
  // is what lets "a burst is one chunk" be replayed in Node rather than counted
  // by eye in a fight nobody can repeat.
  'src/render/iso3d/world/health-bar.ts',
  // A shape laid on the ground rather than over it (spec 153). Where the
  // vertices of an indicator go is arithmetic over a heightfield, and the
  // heightfield is an argument -- which is what lets "every vertex sits the
  // lift above the ground under it" be asserted against a hillside in Node,
  // rather than judged by walking a cursor up one in a browser.
  'src/render/iso3d/world/ground-decal.ts',
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
  // The inventory's view-model (spec 127). The one file that reads both the
  // replicated containers and the item table, out to the plain rows `src/ui/`
  // is allowed to hold -- a mapping, and so checked in Node.
  'src/render/iso3d/world/inventory-model.ts',
  // The HUD's and the character sheet's view-models (spec 128). Same job, and
  // the place `validateSkillSpend` is asked so a greyed-out button and a
  // refused request cannot disagree.
  'src/render/iso3d/world/character-model.ts',
  // The shop's view-model (spec 130), which asks the server's own buy/sell
  // whether a button is live.
  'src/render/iso3d/world/shop-model.ts',
  // Who hears an input once the interface has been offered it (spec 131). The
  // ordering that decides whether the game hears you is arithmetic over two
  // booleans, and it belongs somewhere it can be replayed rather than clicked.
  // The trade screen's view-model (spec 134), and the one piece of arithmetic
  // the mount needed: the wire carries a side's offer as *items* because the
  // other player cannot see into your bag, so the slots to light in your own
  // are matched back -- consumingly, or two stacks of the same thing light one
  // slot twice.
  'src/render/iso3d/world/trade-model.ts',
  'src/render/iso3d/world/ui-routing.ts',
  // The mini HUD's view-model (spec 190). The one file that reads a replicated
  // body and the status table out to the plain rows `src/ui/` is allowed to
  // hold -- and, more to the point, the file that makes the corner panel and
  // the mark over the same body two readings of one list rather than two.
  'src/render/iso3d/world/selection.ts',
  // The action bar's view-model (spec 190). The bar moved onto the interface
  // canvas, so what a slot draws -- its wedge, its badge, why it is lit -- is a
  // mapping from replicated facts to plain rows, and a mapping is checked in
  // Node rather than photographed.
  'src/render/iso3d/world/action-bar-model.ts',
  // The interface's tree, its windows and what they are handed (spec 131). The
  // whole mount except the canvas, kept pure for one specific reason: mounting
  // an interface over the sim gets the same assertion animation got -- the same
  // fight twice, once with the screens driven and once without, identical
  // authoritative state -- and that is impossible if running it needs a canvas.
  'src/render/iso3d/world/ui-screens.ts',
  'src/render/iso3d/world/*.test.ts',
  // The Studio tab's decision-making half (spec 109). image-check.ts measures a
  // reference image and plan.ts derives whether a generation establishes a rig
  // family -- the shared-skeleton rule, which is money, and so is a function of
  // the library rather than a checkbox somebody has to remember to tick.
  // The game's unit runtime (spec 111): the catalogue, the driver that turns
  // replicated facts into machine commands, and the distance LOD. Pure by
  // construction and linted as such -- the driver in particular is where the
  // "animation is presentation only" rule lives, and a `Date` or a
  // `Math.random` in it would be exactly the kind of hidden input that makes
  // two clients disagree about what they are watching.
  'src/render/iso3d/world/unit-catalog.ts',
  'src/render/iso3d/world/unit-driver.ts',
  'src/render/iso3d/world/unit-lod.ts',
  'src/render/iso3d/world/vfx-wire.ts',
  'src/render/iso3d/world/auras.ts',
  'src/render/iso3d/studio/image-check.ts',
  'src/render/iso3d/studio/image-check.test.ts',
  'src/render/iso3d/studio/plan.ts',
  'src/render/iso3d/studio/plan.test.ts',
  // The tuning panels' arithmetic (spec 110). The scrubber, the stacked timing
  // bar and the state graph's layout are all answerable in Node, and all three
  // are the sort of code that looks obviously right and is off by one -- a
  // marker that drifts a frame per drag, a bar with a gap in it, a graph that
  // draws four arrows where the author wrote one.
  'src/render/iso3d/studio/timeline.ts',
  'src/render/iso3d/studio/timing-bar.ts',
  'src/render/iso3d/studio/graph-layout.ts',
  // The VFX tab's arithmetic (spec 122): the field table the parameter panel is
  // generated from, the keyframe editing, and the JSON round trip that makes
  // tuning into authoring. All three are answerable in Node, and all three are
  // the sort of code that looks obviously right and is off by one -- a key that
  // drags past its neighbour and corrupts the order, an export that is quietly
  // lossy, a field nobody can edit because its row was never generated.
  'src/render/iso3d/studio/vfx-fields.ts',
  'src/render/iso3d/studio/curve-edit.ts',
  'src/render/iso3d/studio/vfx-json.ts',
  // How big a box the preview needs, measured by replaying the effect headlessly
  // (spec 122). Arithmetic over a deterministic sim, so it is checked in Node.
  'src/render/iso3d/studio/vfx-frame.ts',
  'src/render/iso3d/studio/vfx-panels.test.ts',
  'src/render/iso3d/studio/panels.test.ts',
  // The VFX core (spec 118). Every decision an effect makes is arithmetic --
  // emission, integration, collision, curves, the budget -- and the promise the
  // whole system rests on is that the same seed draws the same thing, which is
  // only assertable where it can be replayed. The three.js half is the batches
  // and the layer, and neither of those decides anything.
  //
  // `rng.ts` is the pointed one. It is a *mutable* generator, which the sim's own
  // PRNG deliberately is not, because a particle loop cannot allocate per draw.
  // It is linted as pure so that nothing else about it drifts, and it must never
  // be imported by anything the deterministic core can reach.
  'src/render/iso3d/vfx/rng.ts',
  'src/render/iso3d/vfx/noise.ts',
  'src/render/iso3d/vfx/curve.ts',
  'src/render/iso3d/vfx/palette.ts',
  'src/render/iso3d/vfx/shapes.ts',
  // The solids particles are made of (spec 123). Geometry as arrays, generated
  // rather than fetched -- so the silhouette a flame is read by is a thing a
  // test in Node can hold to account.
  'src/render/iso3d/vfx/meshes.ts',
  'src/render/iso3d/vfx/types.ts',
  'src/render/iso3d/vfx/compile.ts',
  'src/render/iso3d/vfx/pool.ts',
  'src/render/iso3d/vfx/system.ts',
  'src/render/iso3d/vfx/registry.ts',
  'src/render/iso3d/vfx/stress.ts',
  'src/render/iso3d/vfx/splat.ts',
  'src/render/iso3d/vfx/decals.ts',
  'src/render/iso3d/vfx/library.ts',
  'src/render/iso3d/vfx/probe-config.ts',
  'src/render/iso3d/vfx/*.test.ts',
  'src/render/iso3d/editor/brush.ts',
  'src/render/iso3d/editor/camera.ts',
  // Which prop regions the editor still owes and in what order (spec 211). The
  // field is built deferred and drained a few regions a frame, so this is the
  // arithmetic that decides what a person sees next -- checkable in Node rather
  // than by opening the tab and watching the trees arrive.
  'src/render/iso3d/editor/prop-residency.ts',
  'src/render/iso3d/editor/history.ts',
  'src/render/iso3d/editor/markers.ts',
  'src/render/iso3d/editor/paint.ts',
  'src/render/iso3d/editor/scatter.ts',
  'src/render/iso3d/editor/*.test.ts',
];

/**
 * The GUI framework (spec 123). Everything under src/ui/ except the backends.
 *
 * Stated as "all of it, minus one directory" rather than as an allowlist of
 * files, deliberately: PURE_RENDER above is an explicit list, which means a new
 * pure file nobody remembers to add gets no rules at all. Here a new file is
 * covered the moment it exists, and the only way to opt out is to put it in
 * src/ui/render/, which is a visible decision rather than an omission.
 */
const UI_PURE = ['src/ui/**/*.ts'];
const UI_IMPURE = ['src/ui/render/canvas2d.ts'];
/** The one bridge to the game's renderer: the 5x7 glyph table. See below. */
const UI_FONT_BRIDGE = ['src/ui/text/font.ts', 'src/ui/text/font.test.ts'];

/** Widgets and screens: no colour may be spelled out, only named. */
const UI_STYLED = ['src/ui/widgets/**/*.ts', 'src/ui/screens/**/*.ts', 'src/ui/gallery/**/*.ts'];

/** Bitmap fonts only: nothing under src/ui/ asks the platform to draw or measure text. */
const NO_PLATFORM_TEXT = [
  /** @type {const} */ ({ object: 'ctx', property: 'fillText', message: 'Bitmap fonts only. Text is drawn from the atlas (src/ui/core/paint.ts).' }),
  /** @type {const} */ ({ object: 'context', property: 'fillText', message: 'Bitmap fonts only. Text is drawn from the atlas (src/ui/core/paint.ts).' }),
  /** @type {const} */ ({ object: 'ctx', property: 'measureText', message: 'Text is measured from the glyph table (src/ui/text/font.ts), never by the platform.' }),
  /** @type {const} */ ({ object: 'context', property: 'measureText', message: 'Text is measured from the glyph table (src/ui/text/font.ts), never by the platform.' }),
];

/**
 * A widget may read the content tables -- the HUD already does -- but nothing
 * under src/ui/ may reach the simulation. A widget that cannot reach the sim
 * cannot change an outcome, which is the CLAUDE.md rule a linter could not see
 * until this directory existed.
 */
const NO_SIM = {
  group: ['**/server/sim/**', '**/server/world/**', '**/server/player/**', '**/server/state/**'],
  message:
    'A widget reads a view-model and emits an intent. It never touches the sim: that is what keeps the UI unable to change an outcome.',
};

/**
 * The game's renderer, by its subtrees -- deliberately not `**\/render/**`,
 * which would also match src/ui/render/, this framework's own backends.
 */
const NO_GAME_RENDERER = {
  group: ['**/render/iso3d/**', '**/render/cloth/**', '**/render/critters/**'],
  message:
    "src/ui/ is engine-independent. Only src/ui/text/font.ts may read the game's renderer, and only for the 5x7 glyph table.",
};

/** The import rule for a src/ui/ block, stated in full so nothing is lost. */
const uiImports = (/** @type {object[]} */ extraPatterns) => ({
  ...NO_RENDERING_LIBRARIES,
  patterns: [...NO_RENDERING_LIBRARIES.patterns, NO_SIM, ...extraPatterns],
});

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
    // `.claude/scratch/` is gitignored working files -- benches and one-off
    // comparisons an agent wrote to answer a question. They are outside the
    // tsconfig by design, so the type-aware rules cannot parse them at all.
    ignores: ['dist/**', 'node_modules/**', 'tools/**', '.claude/scratch/**'],
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
    // The client session (spec 202). Transport-agnostic and drawn by the
    // renderer, never the reverse -- so it may not reach back into it.
    //
    // The rule it exists to hold is narrow and load-bearing:
    // `MAP_CHUNK_REQUEST_RADIUS` bounds *where* a client may read, and it is
    // checked server-side against the server's own position for that player
    // precisely so a client cannot widen its own read window by lying (spec
    // 072). A request window derived from something the camera knows -- the
    // zoom above all, which since spec 202 is a player setting that can be
    // pushed past the supported band -- would be that same hole reopened from
    // the inside. There is nothing in `src/render/` this half needs, so the
    // cheapest way to keep it that way is to make it impossible.
    //
    // Tests are exempt: `loot-wire.test.ts` and `status-wire.test.ts` compare a
    // wire value against what the renderer makes of it, which is the one thing
    // that genuinely wants both sides, and is the same licence
    // `interest.test.ts` takes from the other direction.
    files: ['src/server/client/**/*.ts'],
    ignores: ['src/server/client/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...NO_RENDERING_LIBRARIES,
          patterns: [
            ...NO_RENDERING_LIBRARIES.patterns,
            {
              group: ['**/render', '**/render/**'],
              message:
                'The client session never imports the renderer. A request window derived from what the camera knows is the read-window guard reopened from the inside (spec 202).',
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
  {
    // Nothing in the Play tab branches on a raw key or a raw button (specs 125,
    // 189).
    //
    // `world/view.ts` is the one adapter: it asks the InputMap what actions a
    // KeyboardEvent or a MouseEvent fires and acts on those, so every control
    // there is rebindable. Anything else in this directory reading `.key` or
    // `.button`, or comparing a `.code`, is a decision the player cannot reach,
    // which is the thing these two phases removed.
    //
    // `button` is prophylactic exactly as `key` is -- view.ts is the only file
    // here that ever read one, and it is in `ignores`. What the rule buys is that
    // the next file to want the mouse has to go through the map, rather than
    // rediscovering `if (event.button === 2)` and putting the primary verbs back
    // out of the player's reach.
    //
    // The editor and the sandboxes are deliberately not covered: they are dev
    // surfaces, not player-facing input (docs/ui/00-architecture.md, decision 6).
    files: ['src/render/iso3d/world/**/*.ts'],
    ignores: ['src/render/iso3d/world/view.ts', 'src/render/iso3d/world/**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'event',
          property: 'key',
          message:
            'Gameplay does not read raw keys. Ask the InputMap what actions fired (src/ui/input/), so the binding is one a player can change.',
        },
        {
          object: 'event',
          property: 'button',
          message:
            'Gameplay does not read raw mouse buttons. Ask the InputMap what actions fired (src/ui/input/), so the binding is one a player can change.',
        },
      ],
    },
  },
  {
    // --- the GUI framework (spec 123) ---------------------------------------
    //
    // Its pure half: layout, hit-testing, focus, event routing, the widget tree,
    // the theme and both fonts. It must run headlessly, and -- the rule the whole
    // test strategy rests on -- it must never read a clock. Time arrives as an
    // argument to UiRoot.update.
    //
    // Each block below restates its rules IN FULL rather than adding to an
    // earlier one. Flat config merges by last-wins per rule name, so a later
    // block that sets `no-restricted-properties` for one thing silently drops
    // every other restriction on that rule -- which is how Math.random and a
    // three.js import went unchecked here for an afternoon.
    files: UI_PURE,
    ignores: [...UI_IMPURE, ...UI_FONT_BRIDGE],
    rules: {
      'no-restricted-properties': ['error', ...NO_AMBIENT_RANDOMNESS, ...NO_PLATFORM_TEXT],
      'no-restricted-globals': ['error', ...NO_WALL_CLOCK_OR_DOM],
      'no-restricted-imports': ['error', uiImports([NO_GAME_RENDERER])],
    },
  },
  {
    // src/ui/text/font.ts and its test: the one place allowed to read the game's
    // renderer, and for exactly one thing -- the 5x7 glyph table, so that face
    // has a single source of truth and the Play tab is not touched. The file it
    // imports is pure and has no three.js in it.
    files: UI_FONT_BRIDGE,
    rules: {
      'no-restricted-properties': ['error', ...NO_AMBIENT_RANDOMNESS, ...NO_PLATFORM_TEXT],
      'no-restricted-globals': ['error', ...NO_WALL_CLOCK_OR_DOM],
      'no-restricted-imports': ['error', uiImports([])],
    },
  },
  {
    // The browser backend. It is allowed the DOM -- that is its whole job -- but
    // not the platform's text rasteriser: bitmap fonts only, drawn from the atlas.
    files: UI_IMPURE,
    rules: {
      'no-restricted-properties': ['error', ...NO_AMBIENT_RANDOMNESS, ...NO_PLATFORM_TEXT],
    },
  },
  {
    // "A code review that finds #4a3b2c in a widget fails." Made mechanical,
    // because this repo's whole disposition is that a rule a linter can check is
    // a rule that stays true.
    files: UI_STYLED,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]",
          message: 'No colour literals in a widget. Name a token in src/ui/theme/theme.json and read it from the theme.',
        },
        {
          selector: 'Literal[raw=/^0x[0-9a-fA-F]{6}$/]',
          message: 'No colour literals in a widget. Name a token in src/ui/theme/theme.json and read it from the theme.',
        },
      ],
    },
  },
);
