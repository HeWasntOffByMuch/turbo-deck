# 011 — Deterministic sprite baker (pixeldudesmaker)

## Problem

Spec 010 draws actors as pixel "dudes" but from hand-written placeholder pixel
rows, with one fixed palette for the player and one for the enemy. We now have
the real pixeldudesmaker generator vendored under `tools/pixeldudesmaker/`
(commit that landed its atlases + `conf.json`). This spec turns that generator's
data into a **headless, deterministic sprite baker**: the game bakes a distinct
dude per identity string — one per enemy type, one per player name — at load,
with no hand-export step and no browser. Same identity → byte-identical sprite,
every run.

Singleplayer for now: exactly one player identity and one enemy identity are in
play, but the baker is keyed by an arbitrary string so more enemy types drop in
for free.

## How the generator works (recovered from `app.js`)

- Sprites are `w×h = 16×24`. `base.png` is a grid: columns are animation frames
  (`idle` = cols 2–5, `run` = cols 7–10, static = col 0), rows are body
  variants (3). `heads.png` / `faces.png` are horizontal strips of variants
  (36 heads, 14 faces), each blitted with a per-frame vertical "bob" offset from
  `conf.parts`.
- A dude = base ⊕ head ⊕ face composited into 16×24 (later layers' opaque
  pixels win), then **recoloured**: every pixel whose colour matches a
  `conf.fromColors` key (±1 per channel) is replaced by the chosen palette
  colour for that channel — `outline, eyes, skin(+skin2), hair(+hair2),
  item(+item2), suit(+suit2)`, where each `*2` channel is the base colour times
  a shadow factor (0.5). Pixels matching no key (a few painted details) are kept
  as-is.
- The tool randomises base/head/face index and one palette colour per channel
  (eyes re-rolled if equal to body). We keep that selection but drive it from a
  seeded PRNG instead of `Math.random`.

## Shape

**Build step (not shipped at runtime):**

`scripts/bake-dude-atlas.ts` (run via tsx, `npm run bake:sprites`) reads
`tools/pixeldudesmaker/data/{base,heads,faces}.png` + `conf.json` (decoded with
the `pngjs` devDependency) and writes the generated module below. It classifies
every distinct source colour once into a channel id (or "literal"), so the
runtime never needs a PNG decoder or the ±1 colour match.

`src/render/dude-atlas.ts` — GENERATED, committed. Pure data, no imports:
sprite size; base/head/face counts; the animation column map and per-part bob
offsets; the source-colour table (channel id + literal rgb); each atlas as
base64-packed per-pixel indices into that table; the default outline colour, the
island-joy palette, and the shadow factors.

**Runtime (pure, no DOM / no Pixi — unit-testable in Node):**

`src/render/dude-baker.ts`
- `seedFromName(name: string): number` — stable 32-bit FNV-1a hash.
- `bakeDude(seed: number): { width; height; idle: Uint8ClampedArray;
  windup: Uint8ClampedArray }` — `Rng.fromSeed(seed)` picks base/head/face and
  one palette colour per channel (eyes re-rolled ≠ body, ≤10 tries), then
  composites and resolves each pose to RGBA. `idle` uses the idle pose; `windup`
  uses a distinct lunge pose from the run cycle so the existing wind-up swap
  reads as anticipation.

**Renderer (thin, browser):**

`src/render/sprites.ts` — `buildDudeTextures(identity: { playerName; enemyType })`
bakes each dude via `bakeDude(seedFromName(...))` and wraps the RGBA into a
nearest-neighbour Pixi `Texture` (through an `ImageData`/canvas), returning the
same `{ player, enemy }` of `{ idle, windup }` the scene already consumes.
`SPRITE_NATIVE_HEIGHT` stays exported (24). The hand-written placeholder art is
removed.

`src/render/scene.ts` / `main.ts` — `Scene.create(container, identity)` threads
the identity from the composition root (main) through to `buildDudeTextures`,
and the actor labels show the player name / enemy type. No game rules move into
the renderer; identity is cosmetic and owned by the composition root.

## Invariants tested (`dude-baker.test.ts`, pure Node)

- **Determinism:** `bakeDude(seedFromName(x))` is byte-identical across repeated
  calls, and `seedFromName` is stable for a given string.
- **Per-identity distinctness:** different identity strings (`"Rook"` vs
  `"Brawler"`) produce different pixels; the same string reproduces the same
  sprite.
- **Well-formed output:** both poses are `16×24×4` bytes, contain opaque pixels,
  and every opaque pixel is fully opaque (alpha 255).
- **idle ≠ windup** for a given seed (the poses actually differ).

## Out of scope

- Multiplayer / more than one player identity; per-enemy identity beyond the
  single current type (the baker already supports it, nothing wires a second in).
- Multi-frame animation playback — one idle and one wind-up frame per dude, as
  the scene consumes today.
- Editing the vendored generator or re-deriving the palette; we use its shipped
  atlases, `conf.json` palette, and shadow factors as-is.
