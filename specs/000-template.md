# NNN — Title

<!--
  NNN comes from `npm run spec:next`, never from reading `specs/`.

  `specs/` holds only what has merged, and this repo runs 184 branches at once,
  so the highest number in the working tree is a number several other sessions
  are also looking at. `spec:next` reads every ref, where a pushed branch has
  published its claim. That is how 105 of the 319 specs on main came to share a
  number with another one (spec 266).

  Then commit this file on its own and push it before you start building: until
  you push, your claim is invisible to everybody else.

  If you collide anyway, run `npm run spec:next` again and take that number.
  Never renumber to "one past the one I hit" — that is read off main, which is
  the view that caused the collision, so two sessions colliding on the same day
  pick the same replacement. It is why main has two spec 257s.
-->

## Problem

What gap this closes, in 2-4 sentences.

## Shape

The data/API shape this introduces (types, function signatures, events). Not
full implementation — just enough to review the design before writing it.

## Invariants tested

Bullet list of properties/behaviors that tests will assert. If it's not
listed here, it's not guaranteed.

## Out of scope

What this spec deliberately does not cover, to keep the change small.
