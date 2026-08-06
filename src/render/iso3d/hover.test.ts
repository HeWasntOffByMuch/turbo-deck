import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  distanceToBox,
  FOOTPRINT_PAD,
  HOVER_PLAYER_ID,
  pickHoveredUnit,
  SNAP_PIXELS,
  type HoverTarget,
  type ScreenBox,
} from './hover.js';
import { attachOutline } from './outline.js';
import { box, makeHeadingArrow } from './meshes.js';
import { PlayerRig } from './rigs.js';
import { cameraFrustum, cursorToNdc } from './view-frame.js';
import { DEFAULT_CAMERA_OFFSET, DEFAULT_VIEW_HALF_WIDTH } from './view-settings.js';
import { PLAYER_RADIUS } from '../../sim/constants.js';
import type { Vec2 } from '../../sim/types.js';

/**
 * Hover picking (spec 041) is a raycast against the unit models, so these run
 * headlessly: three.js raycasting needs no WebGL. The camera mirrors the scene's
 * -- same iso offset, same zoom -- so "point at the body" means the same thing
 * here as on screen.
 */

const ASPECT = 1.76;

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
    return { rig, target: { id, object: rig.group, position: groundOf(position), radius: PLAYER_RADIUS } };
  }

  it('hovers the unit when the cursor is on its BODY, not only on its feet', () => {
    // The regression this replaced: units are drawn above the ground point they
    // stand on, so a footprint test alone only lit up on the feet.
    const camera = isoCamera(stand);
    const { target } = playerAt(stand);
    const body = stand.clone().add(new THREE.Vector3(0, 20, 0));
    // No ground hit is offered, so this can only pass via the model raycast.
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

  it('lets a model hit beat a footprint hit, so you pick the unit you can see', () => {
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
    expect(pickHoveredUnit(straightDown, [{ id: 1, object: group, position: { x: 0, y: 0 }, radius: 0 }], null)).toBeNull();
  });

  it('ignores the outline itself, so hovering never grows the shape that lit it', () => {
    const group = new THREE.Group();
    group.add(box(20, 20, 20, 0x445566));
    const outline = attachOutline(group);
    outline.setVisible(true);
    group.updateMatrixWorld(true);
    const target: HoverTarget = { id: 1, object: group, position: { x: 0, y: 0 }, radius: 0 };

    // Straight down through the shell but outside the model it traces.
    const shellOnly = new THREE.Raycaster(new THREE.Vector3(11, 100, 0), new THREE.Vector3(0, -1, 0));
    expect(pickHoveredUnit(shellOnly, [target], null)).toBeNull();
    const throughModel = new THREE.Raycaster(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, -1, 0));
    expect(pickHoveredUnit(throughModel, [target], null)).toBe(1);
  });
});

/**
 * Forgiving picking (spec 071). Hand-built targets rather than real rigs: what
 * is under test is which claim wins, and a box plus an empty group says that
 * without a camera in the way. The model raycast is exercised above.
 */
describe('forgiving picking (spec 071)', () => {
  /** A target the ray can never hit, so only the fallbacks can answer. */
  function ghost(id: number, ground: Vec2, screen: ScreenBox | null, radius = 20): HoverTarget {
    return { id, object: new THREE.Object3D(), position: ground, radius, screen };
  }

  const NO_RAY = new THREE.Raycaster(new THREE.Vector3(0, 1e6, 0), new THREE.Vector3(0, 1, 0));
  const BOX: ScreenBox = { minX: 100, minY: 100, maxX: 140, maxY: 200 };

  it('measures distance to the drawn box, and calls inside it zero', () => {
    expect(distanceToBox({ x: 120, y: 150 }, BOX)).toBe(0);
    expect(distanceToBox({ x: 120, y: 90 }, BOX)).toBe(10);
    expect(distanceToBox({ x: 150, y: 150 }, BOX)).toBe(10);
    expect(distanceToBox({ x: 143, y: 96 }, BOX)).toBeCloseTo(5, 6);
  });

  it('picks a unit the cursor is inside the outline of, even where the ray slips through', () => {
    // Between two legs, under an arm: visually the player is pointing straight
    // at it, and a raycast disagrees.
    const spider = ghost(1, { x: 9999, y: 9999 }, BOX);
    expect(pickHoveredUnit(NO_RAY, [spider], null, { x: 120, y: 150 })).toBe(1);
  });

  it('picks a unit the cursor is merely beside, up to the snap budget', () => {
    const unit = ghost(1, { x: 9999, y: 9999 }, BOX);
    const justOutside = { x: 140 + SNAP_PIXELS - 1, y: 150 };
    const wellOutside = { x: 140 + SNAP_PIXELS + 4, y: 150 };
    expect(pickHoveredUnit(NO_RAY, [unit], null, justOutside)).toBe(1);
    expect(pickHoveredUnit(NO_RAY, [unit], null, wellOutside)).toBeNull();
  });

  it('gives the ground around a body to that body, out to the apron', () => {
    const unit = ghost(1, { x: 0, y: 0 }, null, 20);
    // Past the 20-unit body, inside the apron.
    expect(pickHoveredUnit(NO_RAY, [unit], { x: 20 + FOOTPRINT_PAD - 2, y: 0 })).toBe(1);
    expect(pickHoveredUnit(NO_RAY, [unit], { x: 20 + FOOTPRINT_PAD + 8, y: 0 })).toBeNull();
  });

  it('prefers the outline it is inside to the footprint it is standing on', () => {
    // The classic isometric confusion: pointing at a body draws the ground ray
    // to the earth *behind* it, which is where somebody else is standing.
    const pointedAt = ghost(1, { x: 9999, y: 9999 }, BOX);
    const behind = ghost(2, { x: 0, y: 0 }, null);
    expect(pickHoveredUnit(NO_RAY, [pointedAt, behind], { x: 0, y: 0 }, { x: 120, y: 150 })).toBe(1);
  });

  it('prefers the footprint it is standing on to a unit it is only near', () => {
    const nearby = ghost(1, { x: 9999, y: 9999 }, BOX);
    const stoodOn = ghost(2, { x: 0, y: 0 }, null);
    // Ten pixels off the first one's box, and squarely on the second's ground.
    expect(pickHoveredUnit(NO_RAY, [nearby, stoodOn], { x: 0, y: 0 }, { x: 150, y: 150 })).toBe(2);
  });

  it('takes the silhouette whose middle the cursor is nearest, of two it is inside', () => {
    const left = ghost(1, { x: 9999, y: 9999 }, { minX: 100, minY: 100, maxX: 200, maxY: 200 });
    const right = ghost(2, { x: 9999, y: 9999 }, { minX: 150, minY: 100, maxX: 250, maxY: 200 });
    expect(pickHoveredUnit(NO_RAY, [left, right], null, { x: 155, y: 150 })).toBe(1);
    expect(pickHoveredUnit(NO_RAY, [left, right], null, { x: 195, y: 150 })).toBe(2);
  });

  it('takes the nearest of two units it is only near', () => {
    const near = ghost(1, { x: 9999, y: 9999 }, { minX: 100, minY: 140, maxX: 110, maxY: 160 });
    const far = ghost(2, { x: 9999, y: 9999 }, { minX: 84, minY: 140, maxX: 94, maxY: 160 });
    expect(pickHoveredUnit(NO_RAY, [far, near], null, { x: 118, y: 150 })).toBe(1);
  });

  it('still answers nothing for ground that is nowhere near anybody', () => {
    const unit = ghost(1, { x: 0, y: 0 }, BOX);
    expect(pickHoveredUnit(NO_RAY, [unit], { x: 600, y: 600 }, { x: 900, y: 700 })).toBeNull();
  });

  it('falls back to spec 041\'s pick when nothing has been projected', () => {
    // A caller that passes no cursor pixels gets the model-and-footprint answer,
    // unchanged -- which is what keeps this function usable from a test, and
    // from any view that has not projected its bodies.
    const unit = ghost(1, { x: 0, y: 0 }, null);
    expect(pickHoveredUnit(NO_RAY, [unit], { x: 10, y: 0 })).toBe(1);
    expect(pickHoveredUnit(NO_RAY, [unit], null)).toBeNull();
  });
});
