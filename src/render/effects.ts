import type { Graphics } from 'pixi.js';
import type { PassiveEffect } from '../cards/types.js';
import type { Vec2 } from '../sim/types.js';

// Card visual effects. This module is pure presentation: it derives shapes to
// draw from card data and unit positions and contains no game rules. It imports
// only *types* from the sim/cards, and `Graphics` type-only, so it stays free
// of any runtime sim/pixi dependency and is exercisable headlessly.

const TWO_PI = Math.PI * 2;

/** World point -> screen point; supplied by the scene's camera transform. */
export type Project = (v: Vec2) => { readonly x: number; readonly y: number };

export type SymbolKind = 'curse' | 'brokenArmor';

// --- Passive auras -------------------------------------------------------

export type AuraPrimitive = 'rotatingShapes' | 'glow' | 'underglow' | 'overheadSymbol';

export interface PassiveVfx {
  /** Which unit the passive decorates: the player, or every enemy it acts on. */
  readonly target: 'player' | 'enemies';
  readonly color: number;
  readonly primitives: readonly AuraPrimitive[];
  readonly sides?: number; // polygon sides for rotatingShapes
  readonly count?: number; // number of orbiting shapes
  readonly spin?: number; // orbit radians per render frame
  readonly symbol?: SymbolKind; // for overheadSymbol
}

/**
 * One aura recipe per passive kind. Offensive passives orbit rotating shapes;
 * sustain passives paint a floor underglow; the enemy-tempo curse marks the
 * enemies it slows with a floor aura and an overhead symbol.
 */
export const PASSIVE_VFX: Record<PassiveEffect['kind'], PassiveVfx> = {
  attackDamage: { target: 'player', color: 0xffb454, primitives: ['rotatingShapes'], sides: 3, count: 3, spin: 0.05 },
  nthStrikeDamage: { target: 'player', color: 0xff8c42, primitives: ['rotatingShapes', 'glow'], sides: 4, count: 2, spin: 0.09 },
  healthRegen: { target: 'player', color: 0x5ad65a, primitives: ['underglow', 'glow'] },
  manaRegen: { target: 'player', color: 0x4ea1ff, primitives: ['glow', 'rotatingShapes'], sides: 6, count: 2, spin: 0.03 },
  healOnHurt: { target: 'player', color: 0xd6425a, primitives: ['underglow'] },
  enemyTempo: { target: 'enemies', color: 0xb06cff, primitives: ['underglow', 'overheadSymbol'], symbol: 'curse' },
};

// --- Active-card effects -------------------------------------------------

export interface ActiveVfx {
  readonly kind: 'projectile' | 'aoe';
  readonly color: number;
  readonly glow: number;
  /** Cosmetic windup, in render frames, before an AOE bursts. 0 for projectiles. */
  readonly castTicks: number;
  /** World units: AOE blast radius, or a projectile orb's radius. */
  readonly radius: number;
  /** AOE cast forward along the aim direction rather than on the caster. */
  readonly forward?: boolean;
  /** Overhead mark stamped on the enemies the effect strikes. */
  readonly symbol?: SymbolKind;
}

/** One recipe per active card id. Projectiles fly; AOEs wind up then burst. */
export const ACTIVE_VFX: Record<string, ActiveVfx> = {
  fireball: { kind: 'projectile', color: 0xff6a2a, glow: 0xffd08a, castTicks: 0, radius: 9 },
  iceshard: { kind: 'projectile', color: 0x6ac6ff, glow: 0xe6f6ff, castTicks: 0, radius: 8 },
  emberlash: { kind: 'aoe', color: 0xff5a2a, glow: 0xffb060, castTicks: 16, radius: 46, forward: true },
  guardbreak: { kind: 'aoe', color: 0xccccdd, glow: 0xffffff, castTicks: 14, radius: 44, forward: true, symbol: 'brokenArmor' },
  mend: { kind: 'aoe', color: 0x5ad68a, glow: 0xdfffe8, castTicks: 28, radius: 52 },
  warcry: { kind: 'aoe', color: 0xffa53a, glow: 0xffe0a0, castTicks: 22, radius: 60 },
};

const PROJECTILE_SPEED = 12; // world units per render frame
const PROJECTILE_MAX_AGE = 90; // safety cap so a missed shot never lingers
const BURST_FRAMES = 16;
const SYMBOL_LIFE = 48;

// --- Pure drawing helpers ------------------------------------------------
// Each takes an already-cleared Graphics, a screen centre, and a colour/alpha.
// `angle`/`phase` are free-running render-frame values (no sim time).

function regularPolygon(cx: number, cy: number, r: number, sides: number, rot: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rot + (i * TWO_PI) / sides;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return pts;
}

export function drawRotatingShapes(
  gfx: Graphics,
  cx: number,
  cy: number,
  orbitRadius: number,
  shapeRadius: number,
  color: number,
  sides: number,
  count: number,
  angle: number,
  alpha: number,
): void {
  for (let i = 0; i < count; i++) {
    const a = angle + (i * TWO_PI) / count;
    const ox = cx + Math.cos(a) * orbitRadius;
    const oy = cy + Math.sin(a) * orbitRadius;
    const pts = regularPolygon(ox, oy, shapeRadius, sides, a * 1.5);
    gfx.poly(pts).fill({ color, alpha: alpha * 0.55 });
    gfx.poly(pts).stroke({ color, width: 1, alpha });
  }
}

export function drawGlow(gfx: Graphics, cx: number, cy: number, radius: number, color: number, alpha: number, phase: number): void {
  const pulse = 0.9 + 0.1 * Math.sin(phase * 0.08);
  gfx.circle(cx, cy, radius * 1.5 * pulse).fill({ color, alpha: alpha * 0.05 });
  gfx.circle(cx, cy, radius * 1.05 * pulse).fill({ color, alpha: alpha * 0.08 });
}

export function drawUnderglow(gfx: Graphics, cx: number, feetY: number, radius: number, color: number, alpha: number, phase: number): void {
  const pulse = 0.85 + 0.15 * Math.sin(phase * 0.1);
  gfx.ellipse(cx, feetY, radius * 1.25 * pulse, radius * 0.5 * pulse).fill({ color, alpha: alpha * 0.16 });
  gfx.ellipse(cx, feetY, radius * 0.8 * pulse, radius * 0.32 * pulse).fill({ color, alpha: alpha * 0.22 });
}

export function drawOverheadSymbol(gfx: Graphics, cx: number, cy: number, color: number, symbol: SymbolKind, alpha: number): void {
  if (symbol === 'curse') {
    // Small skull: rounded head, two dark sockets, a toothed jaw.
    gfx.circle(cx, cy, 6).fill({ color, alpha });
    gfx.rect(cx - 3.5, cy + 3.5, 7, 3.5).fill({ color, alpha });
    gfx.circle(cx - 2.3, cy - 0.5, 1.6).fill({ color: 0x1a1020, alpha });
    gfx.circle(cx + 2.3, cy - 0.5, 1.6).fill({ color: 0x1a1020, alpha });
    gfx.rect(cx - 0.5, cy + 3.5, 1, 3.5).fill({ color: 0x1a1020, alpha });
    return;
  }
  // brokenArmor: a shield outline split by a jagged crack.
  const shield = [cx - 6, cy - 5, cx + 6, cy - 5, cx + 6, cy + 1, cx, cy + 7, cx - 6, cy + 1];
  gfx.poly(shield).fill({ color, alpha: alpha * 0.28 });
  gfx.poly(shield).stroke({ color, width: 1.5, alpha });
  gfx
    .moveTo(cx, cy - 5)
    .lineTo(cx - 2, cy - 1)
    .lineTo(cx + 2, cy + 2)
    .lineTo(cx - 1, cy + 6)
    .stroke({ color: 0x201018, width: 1.5, alpha });
}

// --- Transient active effects --------------------------------------------
// All are anchored in world coordinates so they track the scrolling camera.

export interface ActiveEffect {
  /** Advance one render frame; returns false once the effect is finished. */
  update(): boolean;
  /** Ground-level drawing (under the sprites): AOE telegraphs, scorch rings. */
  drawFloor(gfx: Graphics, project: Project, scale: number): void;
  /** Above-sprite drawing: projectiles, burst flashes, overhead symbols. */
  drawTop(gfx: Graphics, project: Project, scale: number): void;
}

export class ProjectileEffect implements ActiveEffect {
  private readonly pos: { x: number; y: number };
  private age = 0;
  private arrived = false;
  private burst = BURST_FRAMES;

  constructor(
    start: Vec2,
    private readonly target: Vec2,
    private readonly vfx: ActiveVfx,
  ) {
    this.pos = { x: start.x, y: start.y };
  }

  update(): boolean {
    this.age++;
    if (!this.arrived) {
      const dx = this.target.x - this.pos.x;
      const dy = this.target.y - this.pos.y;
      const d = Math.hypot(dx, dy);
      if (d <= PROJECTILE_SPEED || this.age > PROJECTILE_MAX_AGE) {
        this.arrived = true;
        this.pos.x = this.target.x;
        this.pos.y = this.target.y;
      } else {
        this.pos.x += (dx / d) * PROJECTILE_SPEED;
        this.pos.y += (dy / d) * PROJECTILE_SPEED;
      }
      return true;
    }
    this.burst--;
    return this.burst > 0;
  }

  drawFloor(): void {
    /* projectiles draw above the sprites only */
  }

  drawTop(gfx: Graphics, project: Project, scale: number): void {
    const c = project(this.pos);
    const r = this.vfx.radius;
    if (!this.arrived) {
      gfx.circle(c.x, c.y, r * 1.7).fill({ color: this.vfx.glow, alpha: 0.18 });
      gfx.circle(c.x, c.y, r).fill({ color: this.vfx.color, alpha: 0.95 });
      gfx.circle(c.x, c.y, r * 0.45).fill({ color: this.vfx.glow, alpha: 0.9 });
    } else {
      const b = 1 - this.burst / BURST_FRAMES;
      gfx.circle(c.x, c.y, r * (1 + 2.4 * b) * scale * 0.5 + r).stroke({ color: this.vfx.glow, width: 3 * (1 - b), alpha: 0.8 * (1 - b) });
    }
  }
}

export class AoeEffect implements ActiveEffect {
  private age = 0;
  private readonly castFrames: number;

  constructor(
    private readonly center: Vec2,
    private readonly vfx: ActiveVfx,
  ) {
    this.castFrames = vfx.castTicks;
  }

  private get windup(): boolean {
    return this.age < this.castFrames;
  }

  update(): boolean {
    this.age++;
    return this.age < this.castFrames + BURST_FRAMES;
  }

  drawFloor(gfx: Graphics, project: Project, scale: number): void {
    const c = project(this.center);
    const R = this.vfx.radius * scale;
    if (this.windup) {
      const p = this.castFrames > 0 ? this.age / this.castFrames : 1;
      gfx.circle(c.x, c.y, R).stroke({ color: this.vfx.color, width: 2, alpha: 0.25 + 0.4 * p });
      gfx.circle(c.x, c.y, R * p).fill({ color: this.vfx.color, alpha: 0.1 + 0.12 * p });
      drawRotatingShapes(gfx, c.x, c.y, R * 0.55, Math.max(3, R * 0.12), this.vfx.glow, 3, 3, this.age * 0.14, 0.45 * p);
    } else {
      const b = (this.age - this.castFrames) / BURST_FRAMES;
      gfx.circle(c.x, c.y, R).fill({ color: this.vfx.color, alpha: 0.3 * (1 - b) });
    }
  }

  drawTop(gfx: Graphics, project: Project, scale: number): void {
    if (this.windup) return;
    const c = project(this.center);
    const R = this.vfx.radius * scale;
    const b = (this.age - this.castFrames) / BURST_FRAMES;
    gfx.circle(c.x, c.y, R * (0.4 + 0.9 * b)).stroke({ color: this.vfx.glow, width: 4 * (1 - b), alpha: 0.75 * (1 - b) });
  }
}

/** A mark (broken armour, curse) that pops over a struck enemy at impact. */
export class OverheadSymbolEffect implements ActiveEffect {
  private age = 0;

  constructor(
    private readonly at: Vec2,
    private readonly topOffset: number,
    private readonly symbol: SymbolKind,
    private readonly color: number,
    private readonly delay: number,
  ) {}

  update(): boolean {
    this.age++;
    return this.age < this.delay + SYMBOL_LIFE;
  }

  drawFloor(): void {
    /* overhead symbols draw above the sprites only */
  }

  drawTop(gfx: Graphics, project: Project): void {
    if (this.age < this.delay) return;
    const t = (this.age - this.delay) / SYMBOL_LIFE;
    const c = project(this.at);
    const alpha = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
    drawOverheadSymbol(gfx, c.x, c.y - this.topOffset - t * 14, this.color, this.symbol, Math.max(0, alpha));
  }
}
