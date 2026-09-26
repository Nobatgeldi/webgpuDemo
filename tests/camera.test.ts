import { describe, expect, it } from 'vitest';
import { vec4 } from 'wgpu-matrix';
import { Camera } from '../src/render/camera';
import { CAMERA_FAR_M } from '../src/render/renderConfig';

/** Projects a camera-relative point and returns NDC depth. */
function depthOf(camera: Camera, relative: [number, number, number]): number {
  const clip = vec4.transformMat4([...relative, 1], camera.viewProjection);
  return (clip[2] as number) / (clip[3] as number);
}

function makeCamera(): Camera {
  const camera = new Camera();
  camera.position.set([0, 0, 0]);
  camera.forward.set([0, 0, -1]);
  camera.aspect = 16 / 9;
  camera.updateMatrices();
  return camera;
}

describe('Camera (reversed Z)', () => {
  it('reaches beyond 30 km', () => {
    expect(CAMERA_FAR_M).toBeGreaterThanOrEqual(30_000);
  });

  it('maps the near plane to depth 1 and the far plane to depth 0', () => {
    const camera = makeCamera();
    expect(depthOf(camera, [0, 0, -camera.near])).toBeCloseTo(1, 5);
    expect(depthOf(camera, [0, 0, -camera.far])).toBeCloseTo(0, 5);
  });

  it('decreases depth monotonically with distance', () => {
    const camera = makeCamera();
    let previous = Number.POSITIVE_INFINITY;
    for (const distance of [0.2, 1, 10, 100, 1000, 10_000, 50_000]) {
      const depth = depthOf(camera, [0, 0, -distance]);
      expect(depth).toBeLessThan(previous);
      expect(depth).toBeGreaterThan(0);
      previous = depth;
    }
  });

  it('keeps the view matrix translation-free (camera-relative rendering)', () => {
    const camera = new Camera();
    camera.position.set([1e7, 30, -2e6]);
    camera.lookAt([1e7 + 100, 0, -2e6 + 50]);
    camera.updateMatrices();
    expect(camera.view[12]).toBeCloseTo(0, 9);
    expect(camera.view[13]).toBeCloseTo(0, 9);
    expect(camera.view[14]).toBeCloseTo(0, 9);
  });

  it('projects the view direction to the screen centre', () => {
    const camera = new Camera();
    camera.position.set([500, 20, 500]);
    camera.lookAt([600, 0, 400]);
    camera.aspect = 1.5;
    camera.updateMatrices();
    const f = camera.forward;
    const clip = vec4.transformMat4([f[0] as number, f[1] as number, f[2] as number, 1], camera.viewProjection);
    expect((clip[0] as number) / (clip[3] as number)).toBeCloseTo(0, 5);
    expect((clip[1] as number) / (clip[3] as number)).toBeCloseTo(0, 5);
  });

  it('stays well defined when looking straight down', () => {
    const camera = new Camera();
    camera.position.set([0, 100, 0]);
    camera.lookAt([0, 0, 0]);
    camera.updateMatrices();
    for (const value of camera.viewProjection) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});
