# 030 — Dash invulnerability (i-frames)

## Problem

A dash repositions the unit but offers no defensive payoff: a slam that was
already committed still lands even if you dash out of (or through) it. Give the
dash the MOBA/action-game staple — **invulnerability frames** — so a well-timed
dash is a dodge, not just a move.

## Shape

The dash already has an active window: the unit is dashing while
`tick < player.dashExpiresAtTick` (spec 028/018). Reuse that exact window as the
i-frame window — no new state, no separate timer.

While a dash is active, an enemy slam that would connect is **negated entirely**:
the unit takes no health damage and spends no shield (a Rocky Raise shield is not
consumed to block a hit the dash already dodged). The negated slam emits the
existing `enemyAttackAvoided` event, the same signal a perfect parry/dodge uses,
so the renderer/audio show a dodge. The enemy still transitions to recovery as if
its slam resolved.

Scope: i-frames apply to enemy slam damage (the primary combat threat). A dash
started on the same tick as an incoming slam is covered, because the check reads
the post-cast `player.dashExpiresAtTick`.

## Invariants tested

- A unit dashing when a slam resolves takes zero damage from it and emits
  `enemyAttackAvoided`; the same slam against a non-dashing unit deals damage.
- A dash does not consume a Rocky Raise shield to block a slam it dodged.
- Once the dash window ends (`tick >= dashExpiresAtTick`), the unit is vulnerable
  again — a slam that lands the tick after the dash ends deals full damage.
- The whole thing replays deterministically from `(seed, inputs)`.

## Out of scope

- Invulnerability against self-inflicted / damage-over-time sources (e.g. a
  burning patch you stand in) — i-frames only negate enemy slams.
- A separate i-frame duration different from the dash's movement window.
- Granting i-frames to any non-dash movement or ability.
