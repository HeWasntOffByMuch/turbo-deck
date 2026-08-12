import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HOVER_PLAYER_ID, pickHoveredUnit, rayBodyDistance, type HoverTarget } from './hover.js';
import { box, makeHeadingArrow } from './meshes.js';
import { PlayerRig } from './rigs.js';
import { cameraFrustum, cursorToNdc } from './view-frame.js';
import { DEFAULT_CAMERA_OFFSET, DEFAULT_VIEW_HALF_WIDTH } from './view-settings.js';
import { PLAYER_RADIUS } from '../../sim/constants.js';
import type { Vec2 } from '../../sim/types.js';

/**
 * Hover picking (spec 041, narrowed by spec 095) is a raycast against the unit
 * models and the volume they stand in, so these run headlessly: three.js
 * raycasting needs no WebGL. The camera mirrors the scene's -- same iso offset,
 * same zoom -- so "point at the body" means the same thing here as on screen.
 */

const ASPECT = 1.76;

/** How tall a player's body stands, for the volume half of the pick. */
const PLAYER_HEIGHT = 58;

/** A camera framing `target` exactly as `IsoScene` does. */
function isoCamera(target: THREE.Vector3): THREE.OrthographicCamera {
  const frustum = cameraFrustum(DEFAULT_VIEW_HALF_WIDTH, ASPECT);
  const camera = new THREE.OrthographicCamera(
    -frustum.halfWidth,
    frustum.halfWidth,
    frustum.halfHeight,
    -frustum.halfHeight,
    1,
    4000,
  );
  camera.position.copy(target).add(new THREE.Vector3(DEFAULT_CAMERA_OFFSET.x, DEFAULT_CAMERA_OFFSET.y, DEFAULT_CAMERA_OFFSET.z));
  camera.lookAt(target);
  camera.updateMatrixWorld();
  return camera;
}

/** Aim a raycaster at where `world` lands on screen, via the canvas-pixel path the scene uses. */
function aimAt(camera: THREE.OrthographicCamera, world: THREE.Vector3, cssW = 1408, cssH = 800): THREE.Raycaster {
  const projected = world.clone().project(camera);
  // Screen point -> canvas CSS pixels -> back through the scene's NDC mapping.
  const cssX = ((projected.x + 1) / 2) * cssW;
  const cssY = ((1 - projected.y) / 2) * cssH;
  const ndc = cursorToNdc(cssX, cssY, cssW, cssH);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
  return raycaster;
}

describe('hover picking (spec 041)', () => {
  const stand = new THREE.Vector3(600, 0, 450);

  /** The ground point under a unit standing at `position`, for the footprint test. */
  const groundOf = (position: THREE.Vector3): Vec2 => ({ x: position.x, y: position.z });

  function playerAt(position: THREE.Vector3, id = HOVER_PLAYER_ID): { rig: PlayerRig; target: HoverTarget } {
    const rig = new PlayerRig();
    rig.group.position.copy(position);
    rig.group.updateMatrixWorld(true);
    return {
      rig,
      target: {
        id,
        object: rig.group,
        position: groundOf(position),
        radius: PLAYER_RADIUS,
        base: position.y,
        height: PLAYER_HEIGHT,
      },
    };
  }

  it('hovers the unit when the cursor is on its BODY, not only on its feet', () => {
    // The regression this replaced: units are drawn above the ground point they
    // stand on, so a footprint test alone only lit up on the feet.
    const camera = isoCamera(stand);
    const { target } = playerAt(stand);
    const body = stand.clone().add(new THREE.Vector3(0, 20, 0));
    // No ground hit is offered, so this can only pass via the body tests.
    expect(pickHoveredUnit(aimAt(camera, body), [target], null)).toBe(HOVER_PLAYER_ID);
  });

  it('also hovers the unit from the ground it stands on, so the target is not pixel-exact', () => {
    const camera = isoCamera(stand);
    const { target } = playerAt(stand);
    const nearFeet = { x: stand.x + PLAYER_RADIUS - 2, y: stand.z };
    // The ray misses the model here; the footprint is what picks it up.
    expect(pickHoveredUnit(aimAt(camera, stand.clone().add(new THREE.Vector3(400, 0, 400))), [target], nearFeet)).toBe(
      HOVER_PLAYER_ID,
    );
  });

  it('picks nothing when the cursor is on empty ground', () => {
    const camera = isoCamera(stand);
    const { target } = playerAt(stand);
    const away = stand.clone().add(new THREE.Vector3(300, 0, 300));
    expect(pickHoveredUnit(aimAt(camera, away), [target], groundOf(away))).toBeNull();
    expect(pickHoveredUnit(aimAt(camera, away), [], groundOf(away))).toBeNull();
  });

  it('picks the frontmost unit, so two overlapping models never both light up', () => {
    // Two units on the camera's line of sight: the one nearer the camera wins.
    const camera = isoCamera(stand);
    const near = playerAt(stand);
    const offset = new THREE.Vector3(DEFAULT_CAMERA_OFFSET.x, 0, DEFAULT_CAMERA_OFFSET.z).normalize().multiplyScalar(-160);
    const far = playerAt(stand.clone().add(offset), 7);

    const body = stand.clone().add(new THREE.Vector3(0, 20, 0));
    expect(pickHoveredUnit(aimAt(camera, body), [near.target, far.target], null)).toBe(HOVER_PLAYER_ID);
    expect(pickHoveredUnit(aimAt(camera, body), [far.target, near.target], null)).toBe(HOVER_PLAYER_ID);
  });

  it('lets a body hit beat a footprint hit, so you pick the unit you can see', () => {
    const camera = isoCamera(stand);
    const front = playerAt(stand, 3);
    const behind = playerAt(stand.clone().add(new THREE.Vector3(-140, 0, -140)), 4);
    const body = stand.clone().add(new THREE.Vector3(0, 20, 0));
    // Cursor on unit 3's body while its ground point sits inside unit 4's footprint.
    expect(pickHoveredUnit(aimAt(camera, body), [front.target, behind.target], behind.target.position)).toBe(3);
  });

  it("ignores a rig's flat ground decals, so its heading arrow is not part of the shape", () => {
    const group = new THREE.Group();
    group.add(makeHeadingArrow());
    group.updateMatrixWorld(true);
    const straightDown = new THREE.Raycaster(new THREE.Vector3(20, 100, 0), new THREE.Vector3(0, -1, 0));
    const flat: HoverTarget = { id: 1, object: group, position: { x: 0, y: 0 }, radius: 0, base: 0, height: 0 };
    expect(pickHoveredUnit(straightDown, [flat], null)).toBeNull();
  });
});

/**
 * A unit is its body and the ground under it (spec 095). Hand-built targets
 * rather than real rigs: what is under test is which claim wins and how far each
 * reaches, and a cylinder plus an empty group says that without a camera in the
 * way. The model raycast is exercised above.
 */
describe('a unit is its body and the ground under it (spec 095)', () => {
  /** A target whose meshes the ray can never hit, so only the volume answers. */
  function ghost(id: number, ground: Vec2, radius = 20, height = 50, base = 0): HoverTarget {
    return { id, object: new THREE.Object3D(), position: ground, radius, base, height };
  }

  /** A ray pointing away from everything, so only the ground cursor can answer. */
  const NO_RAY = new THREE.Raycaster(new THREE.Vector3(0, 1e6, 0), new THREE.Vector3(0, 1, 0));

  /** A ray straight down through `x, z`, the simplest way to cross a volume. */
  function down(x: number, z: number): THREE.Raycaster {
    return new THREE.Raycaster(new THREE.Vector3(x, 400, z), new THREE.Vector3(0, -1, 0));
  }

  const unit = ghost(1, { x: 0, y: 0 });

  it('reports where a ray enters a body from above', () => {
    // 400 units up, a 50-unit body: the ray meets the top of the head at 350.
    expect(rayBodyDistance(down(0, 0).ray, unit)).toBeCloseTo(350, 6);
  });

  it('reports where a ray enters a body from the side', () => {
    const side = new THREE.Raycaster(new THREE.Vector3(0, 25, 100), new THREE.Vector3(0, 0, -1));
    expect(rayBodyDistance(side.ray, unit)).toBeCloseTo(80, 6);
  });

  it('misses a body it passes beside, and one it passes over', () => {
    expect(rayBodyDistance(down(unit.radius + 1, 0).ray, unit)).toBeNull();
    const overhead = new THREE.Raycaster(new THREE.Vector3(0, 60, 100), new THREE.Vector3(0, 0, -1));
    expect(rayBodyDistance(overhead.ray, unit)).toBeNull();
  });

  it('misses a body that is behind the ray rather than in front of it', () => {
    const backwards = new THREE.Raycaster(new THREE.Vector3(0, 400, 0), new THREE.Vector3(0, 1, 0));
    expect(rayBodyDistance(backwards.ray, unit)).toBeNull();
  });

  it('stands the volume on the ground the unit is on, not on y=0', () => {
    const uphill = ghost(1, { x: 0, y: 0 }, 20, 50, 120);
    // Its head is at 170, so the ray from 400 up meets it at 230.
    expect(rayBodyDistance(down(0, 0).ray, uphill)).toBeCloseTo(230, 6);
    // And the ground it used to stand on is now empty air below its feet.
    const belowFeet = new THREE.Raycaster(new THREE.Vector3(0, 25, 100), new THREE.Vector3(0, 0, -1));
    expect(rayBodyDistance(belowFeet.ray, uphill)).toBeNull();
  });

  it('picks a unit through a gap in its own meshes, because the gap is inside it', () => {
    // Two legs a stride apart, and a ray straight down between them: the meshes
    // are missed and the body is not.
    const legs = new THREE.Group();
    const left = box(6, 40, 6, 0x445566);
    left.position.set(-12, 20, 0);
    const right = box(6, 40, 6, 0x445566);
    right.position.set(12, 20, 0);
    legs.add(left, right);
    legs.updateMatrixWorld(true);

    const spider: HoverTarget = { id: 4, object: legs, position: { x: 0, y: 0 }, radius: 20, base: 0, height: 50 };
    expect(pickHoveredUnit(down(0, 0), [spider], null)).toBe(4);
  });

  it('picks a part that sticks out past the volume, so the meshes still count', () => {
    const rig = new THREE.Group();
    const arm = box(10, 10, 10, 0x445566);
    arm.position.set(40, 20, 0);
    rig.add(arm);
    rig.updateMatrixWorld(true);

    const wide: HoverTarget = { id: 5, object: rig, position: { x: 0, y: 0 }, radius: 20, base: 0, height: 50 };
    expect(pickHoveredUnit(down(40, 0), [wide], null)).toBe(5);
  });

  it('picks the nearer of two bodies the ray crosses', () => {
    const near = ghost(1, { x: 0, y: 0 }, 20, 50, 200);
    const far = ghost(2, { x: 0, y: 0 }, 20, 50, 0);
    expect(pickHoveredUnit(down(0, 0), [near, far], null)).toBe(1);
    expect(pickHoveredUnit(down(0, 0), [far, near], null)).toBe(1);
  });

  it('gives a unit the ground it stands on and not a step more', () => {
    expect(pickHoveredUnit(NO_RAY, [unit], { x: unit.radius - 1, y: 0 })).toBe(1);
    expect(pickHoveredUnit(NO_RAY, [unit], { x: unit.radius + 1, y: 0 })).toBeNull();
  });

  it('takes the nearer footprint when two overlap', () => {
    const left = ghost(1, { x: -10, y: 0 });
    const right = ghost(2, { x: 10, y: 0 });
    expect(pickHoveredUnit(NO_RAY, [left, right], { x: -4, y: 0 })).toBe(1);
    expect(pickHoveredUnit(NO_RAY, [left, right], { x: 4, y: 0 })).toBe(2);
  });

  it('leaves the gap between two units clickable, so the player can squeeze through', () => {
    // The whole point of the narrowing: 40 units of bare ground between two
    // bodies, and a click in the middle of it is a move order, not an attack.
    const left = ghost(1, { x: -40, y: 0 });
    const right = ghost(2, { x: 40, y: 0 });
    const between = new THREE.Raycaster(new THREE.Vector3(0, 400, 0), new THREE.Vector3(0, -1, 0));
    expect(pickHoveredUnit(between, [left, right], { x: 0, y: 0 })).toBeNull();
    // And a step either way is still on a body, so nothing has become unclickable.
    expect(pickHoveredUnit(between, [left, right], { x: -25, y: 0 })).toBe(1);
    expect(pickHoveredUnit(between, [left, right], { x: 25, y: 0 })).toBe(2);
  });

  it('answers nothing for ground that is nowhere near anybody', () => {
    expect(pickHoveredUnit(NO_RAY, [unit], { x: 600, y: 600 })).toBeNull();
    expect(pickHoveredUnit(NO_RAY, [unit], null)).toBeNull();
    expect(pickHoveredUnit(NO_RAY, [], { x: 0, y: 0 })).toBeNull();
  });

  it('has no volume for a unit with no radius or no height', () => {
    expect(rayBodyDistance(down(0, 0).ray, ghost(1, { x: 0, y: 0 }, 0, 50))).toBeNull();
    expect(rayBodyDistance(down(0, 0).ray, ghost(1, { x: 0, y: 0 }, 20, 0))).toBeNull();
  });
});
