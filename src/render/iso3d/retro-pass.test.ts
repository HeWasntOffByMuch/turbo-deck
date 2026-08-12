import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { RetroPass } from './retro-pass.js';
import { RETRO_DEFAULTS } from './retro.js';

/**
 * The mask pass (spec 138) borrows three things from the caller's scene -- the
 * background, the override material and the visibility of every top-level child
 * -- and has to give all three back before the frame is finished with. A
 * forgotten restore is not a subtle artifact: it is a world that stopped being
 * drawn, or a sky that masks the whole frame.
 *
 * None of that needs a GPU to check. `RetroPass` allocates its render targets
 * and materials without touching GL, and what the pass does to the scene is
 * observable from the scene itself -- so this stands a fake renderer up and
 * records what was visible at the instant each `render` was called.
 */

interface Draw {
  readonly target: THREE.WebGLRenderTarget | null;
  /** Names of the scene children that were visible for this draw. */
  readonly visible: readonly string[];
  readonly override: string | null;
  readonly background: unknown;
  readonly clearColor: number;
}

/**
 * The handful of renderer methods the pass actually calls.
 *
 * Cast to a `WebGLRenderer` at the call, which is the honest shape of this: the
 * pass takes a renderer and we are checking what it does to everything *else*.
 */
class FakeRenderer {
  autoClear = true;
  readonly draws: Draw[] = [];
  readonly clears: (THREE.WebGLRenderTarget | null)[] = [];
  private target: THREE.WebGLRenderTarget | null = null;
  private clear = new THREE.Color(0x8fd6c8);
  private clearAlpha = 1;

  setRenderTarget(target: THREE.WebGLRenderTarget | null): void {
    this.target = target;
  }

  getClearColor(out: THREE.Color): THREE.Color {
    return out.copy(this.clear);
  }

  getClearAlpha(): number {
    return this.clearAlpha;
  }

  setClearColor(color: THREE.Color, alpha: number): void {
    this.clear = color.clone();
    this.clearAlpha = alpha;
  }

  clearColor(): void {
    this.clears.push(this.target);
  }

  render(scene: THREE.Scene, _camera: THREE.Camera): void {
    this.draws.push({
      target: this.target,
      visible: scene.children.filter((c) => c.visible).map((c) => c.name),
      override: scene.overrideMaterial?.uuid ?? null,
      background: scene.background,
      clearColor: this.clear.getHex(),
    });
  }

  /** What the pass must have put back: the sky it was handed. */
  get clearHex(): number {
    return this.clear.getHex();
  }
}

function meshNamed(name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
  mesh.name = name;
  return mesh;
}

/** A scene with a sky, three bodies and a prop -- one of the bodies exempt. */
function setup(): {
  pass: RetroPass;
  renderer: FakeRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  player: THREE.Mesh;
} {
  const pass = new RetroPass(64, 32);
  const renderer = new FakeRenderer();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fd6c8);
  const player = meshNamed('player');
  scene.add(meshNamed('terrain'), player, meshNamed('monster'), meshNamed('props'));
  return { pass, renderer, scene, camera: new THREE.OrthographicCamera(), player };
}

function render(pass: RetroPass, renderer: FakeRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
  pass.render(renderer as unknown as THREE.WebGLRenderer, scene, camera);
}

describe('RetroPass without an exemption', () => {
  it('draws the scene once and the quad once, as it did before spec 138', () => {
    const { pass, renderer, scene, camera } = setup();
    render(pass, renderer, scene, camera);

    // Scene into the buffer, quad to the canvas. No mask, no third draw.
    expect(renderer.draws).toHaveLength(2);
    expect(renderer.draws[0]?.visible).toEqual(['terrain', 'player', 'monster', 'props']);
    expect(renderer.draws[1]?.target).toBeNull();
    expect(renderer.clears).toHaveLength(0);
  });

  it('costs nothing extra when the exempt list is emptied again', () => {
    const { pass, renderer, scene, camera, player } = setup();
    pass.setExempt([player]);
    render(pass, renderer, scene, camera);
    expect(renderer.draws).toHaveLength(3);

    pass.setExempt([]);
    render(pass, renderer, scene, camera);
    expect(renderer.draws).toHaveLength(5);
  });

  it('skips the mask with the filter off and no palette, because there is nothing to escape', () => {
    const pass = new RetroPass(64, 32, { ...RETRO_DEFAULTS, enabled: false });
    const { renderer, scene, camera, player } = setup();
    pass.setExempt([player]);
    // A grade is what keeps the quad running at all with the filter off.
    pass.setGrade({ saturation: 0, tint: 0xffffff, tintStrength: 0, gain: 1 });
    render(pass, renderer, scene, camera);

    expect(renderer.draws).toHaveLength(2);
  });

  it('honours the setting being switched off', () => {
    const { pass, renderer, scene, camera, player } = setup();
    pass.set({ ...RETRO_DEFAULTS, excludePlayer: false });
    pass.setExempt([player]);
    render(pass, renderer, scene, camera);

    expect(renderer.draws).toHaveLength(2);
  });
});

describe('RetroPass mask pass (spec 138)', () => {
  it('draws only the exempt roots, after the scene and before the quad', () => {
    const { pass, renderer, scene, camera, player } = setup();
    pass.setExempt([player]);
    render(pass, renderer, scene, camera);

    expect(renderer.draws).toHaveLength(3);
    const [world, mask, quad] = renderer.draws;
    expect(world?.visible).toEqual(['terrain', 'player', 'monster', 'props']);
    expect(mask?.visible).toEqual(['player']);
    expect(quad?.target).toBeNull();
    // The scene buffer and the mask buffer are different targets, and neither
    // of them is the canvas.
    expect(mask?.target).not.toBe(world?.target);
    expect(mask?.target).not.toBeNull();
  });

  it('clears the mask buffer to black, and only the mask buffer', () => {
    const { pass, renderer, scene, camera, player } = setup();
    pass.setExempt([player]);
    render(pass, renderer, scene, camera);

    // Colour only. Clearing depth here would throw away the world's depth,
    // which is the one thing making the mask occlude correctly.
    expect(renderer.clears).toHaveLength(1);
    expect(renderer.clears[0]).toBe(renderer.draws[1]?.target);
    expect(renderer.draws[1]?.clearColor).toBe(0x000000);
  });

  it('draws the mask with no sky behind it', () => {
    const { pass, renderer, scene, camera, player } = setup();
    pass.setExempt([player]);
    render(pass, renderer, scene, camera);

    // A background would fill the mask, and every pixel of the frame would come
    // out exempt -- the retro filter silently switched off.
    expect(renderer.draws[0]?.background).not.toBeNull();
    expect(renderer.draws[1]?.background).toBeNull();
  });

  it('draws the mask through one override material and the world through none', () => {
    const { pass, renderer, scene, camera, player } = setup();
    pass.setExempt([player]);
    render(pass, renderer, scene, camera);

    expect(renderer.draws[0]?.override).toBeNull();
    expect(renderer.draws[1]?.override).toEqual(expect.any(String));
  });

  it('gives the scene and the renderer back exactly as it found them', () => {
    const { pass, renderer, scene, camera, player } = setup();
    const background = scene.background;
    pass.setExempt([player]);
    render(pass, renderer, scene, camera);

    expect(scene.background).toBe(background);
    expect(scene.overrideMaterial).toBeNull();
    expect(scene.children.map((c) => c.visible)).toEqual([true, true, true, true]);
    expect(renderer.autoClear).toBe(true);
    expect(renderer.clearHex).toBe(0x8fd6c8);
  });

  it('leaves an already-hidden child hidden', () => {
    // The restore is a list of what this pass hid, not a blanket `visible = true`
    // -- something else in the renderer is allowed to have hidden a body.
    const { pass, renderer, scene, camera, player } = setup();
    const monster = scene.getObjectByName('monster');
    if (monster) monster.visible = false;
    pass.setExempt([player]);
    render(pass, renderer, scene, camera);

    expect(renderer.draws[1]?.visible).toEqual(['player']);
    expect(monster?.visible).toBe(false);
  });

  it('exempts several bodies at once', () => {
    const { pass, renderer, scene, camera, player } = setup();
    const monster = scene.getObjectByName('monster');
    pass.setExempt(monster ? [player, monster] : [player]);
    render(pass, renderer, scene, camera);

    expect(renderer.draws[1]?.visible).toEqual(['player', 'monster']);
  });

  it('does not exempt a root that is not a direct child of the scene', () => {
    // The documented failure direction: nested roots are hidden with their
    // ancestor and simply are not exempt, rather than unhiding their siblings.
    const { pass, renderer, scene, camera } = setup();
    const nested = meshNamed('nested');
    scene.getObjectByName('props')?.add(nested);
    pass.setExempt([nested]);
    render(pass, renderer, scene, camera);

    expect(renderer.draws[1]?.visible).toEqual([]);
  });
});

describe('RetroPass buffers (spec 138)', () => {
  it('keeps the mask the same size as the scene buffer through a resize', () => {
    const pass = new RetroPass(64, 32, { ...RETRO_DEFAULTS, pixelSize: 3 });
    const targets = () => {
      const p = pass as unknown as {
        target: THREE.WebGLRenderTarget;
        maskTarget: THREE.WebGLRenderTarget;
      };
      return [p.target, p.maskTarget] as const;
    };

    for (const [w, h] of [[64, 32], [800, 601], [1, 1]] as const) {
      pass.setSize(w, h);
      const [scene, mask] = targets();
      // The mask is sampled with the scene buffer's own uv and shares its depth
      // attachment; both stop being true the moment the two disagree.
      expect([mask.width, mask.height]).toEqual([scene.width, scene.height]);
      expect(scene.width).toBe(Math.max(1, Math.ceil(w / 3)));
    }
  });

  it('shares one depth texture between the two buffers', () => {
    // The whole reason the mask is one small draw and not a second frame: the
    // depth of the world is already in the attachment it tests against.
    const pass = new RetroPass(64, 32);
    const p = pass as unknown as {
      target: THREE.WebGLRenderTarget;
      maskTarget: THREE.WebGLRenderTarget;
    };
    expect(p.target.depthTexture).toBeInstanceOf(THREE.DepthTexture);
    expect(p.maskTarget.depthTexture).toBe(p.target.depthTexture);
  });

  it('lets the borrower go of the shared depth before disposing it', () => {
    // three frees a render target's depth texture along with the target, and it
    // decides whether to by checking the field -- so two targets still holding
    // the same one at dispose is what a double free would look like. The actual
    // freeing happens inside the renderer and needs a GL context; what can be
    // checked here is the condition it branches on.
    const pass = new RetroPass(64, 32);
    const p = pass as unknown as {
      target: THREE.WebGLRenderTarget;
      maskTarget: THREE.WebGLRenderTarget;
    };
    const depth = p.target.depthTexture;

    pass.dispose();
    expect(p.maskTarget.depthTexture).toBeFalsy();
    expect(p.target.depthTexture).toBe(depth);
  });
});
