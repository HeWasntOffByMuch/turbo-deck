# 001 — Agentic development workflow

## Problem

Before any game logic exists, the repo needs a pipeline that makes every
future change spec-first and machine-verified, so an agent (or a human) can
trust green CI as proof a change didn't break determinism or introduce
regressions.

## Shape

- npm project, TypeScript strict mode, ESM throughout.
- Scripts: `test` (Vitest), `typecheck` (`tsc --noEmit`), `lint` (ESLint
  flat config, typescript-eslint strict+stylistic), `build` (Vite), `dev`
  (Vite dev server), `balance` (tsx script, added when the harness exists).
- `CLAUDE.md` at the root is the single source of truth for the sim/render
  split and determinism rules — every later spec can point back to it
  instead of restating the rule.
- `specs/` holds one markdown file per system, written and committed before
  its implementation, using `000-template.md` as the shape.
- `.github/workflows/ci.yml` runs `npm ci`, then typecheck + lint + test on
  every push and pull request.
- ESLint bans `Math.random`/`Date` inside `src/sim/` and `src/cards/` as a
  mechanical guard for the determinism rule (it can't catch everything, but
  it catches the obvious slip).

## Invariants tested

- `npm run typecheck`, `npm run lint`, and `npm test` all exit 0 on a clean
  checkout.
- CI reproduces the same three checks and is green on the initial push.
- A trivial sanity test (`src/shared/sanity.test.ts`) exists purely to prove
  the Vitest → tsconfig → CI wiring works end to end before any real game
  code is written; it's fine to delete once real sim/card tests exist.

## Out of scope

- Any game logic (cards, sim, rendering). This spec is only the scaffold.
- Deployment/hosting of the built renderer.
