/**
 * The geometric vocabulary of a spell: what the sim knows how to execute. It is
 * deliberately card-agnostic ("cone", "aura", "dash" -- never "Fire Blast"), so
 * game rules stay in the cards layer while the sim only runs geometry. Shared by
 * `src/cards` (which produces specs from played cards) and `src/sim` (which
 * executes them), so it lives in the dependency-free shared layer.
 *
 * `origin` on a point AOE picks whether it lands on the player or at the aimed
 * target; cones, rects and dashes fire from the player along the aim direction;
 * shields and auras attach to the player.
 */
export type SpellSpec =
  | { readonly kind: 'cone'; readonly range: number; readonly arcCosSq: number; readonly damage: number }
  | { readonly kind: 'rect'; readonly length: number; readonly halfWidth: number; readonly damage: number }
  | {
      readonly kind: 'aura';
      readonly radius: number;
      readonly pulseDamage: number;
      readonly pulseIntervalTicks: number;
      readonly durationTicks: number;
    }
  | {
      readonly kind: 'pointAoe';
      readonly origin: 'player' | 'target';
      readonly radius: number;
      readonly damage: number;
      readonly stunTicks: number;
      /** Telegraph delay before the first blast impacts. */
      readonly delayTicks: number;
      /** How many blasts (the blaze-aura fusion fires several). */
      readonly count: number;
      /** Ticks between successive blasts when `count > 1`. */
      readonly spreadTicks: number;
    }
  | { readonly kind: 'dash'; readonly distance: number; readonly durationTicks: number; readonly damage: number }
  | { readonly kind: 'shield'; readonly amount: number; readonly durationTicks: number };
