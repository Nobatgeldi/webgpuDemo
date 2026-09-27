import { describe, expect, it } from 'vitest';
import { SHIP_CAMERA_CONFIG, ShipCamera, type ShipCameraTarget } from '../src/camera/shipCamera';
import { stepCriticalSpring, wrapAngle } from '../src/core/spring';
import type { Input } from '../src/input/input';
import { Camera } from '../src/render/camera';
import { quaternionFromAxisAngle } from '../src/ship/rigidBody';
import { Helm } from '../src/ship/helm';
import { PATROL_BOAT } from '../src/ship/shipConfig';

const DT = 1 / 60;
const DEG = Math.PI / 180;

describe('critically damped spring', () => {
  it('reaches the target without overshoot', () => {
    const state = { value: 0, velocity: 0 };
    let max = 0;
    for (let i = 0; i < 600; i++) {
      stepCriticalSpring(state, 1, 3, DT);
      max = Math.max(max, state.value);
    }
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
    expect(state.value).toBeCloseTo(1, 6);
  });

  it('is independent of the step size (exact integration)', () => {
    const a = { value: 0, velocity: 0 };
    const b = { value: 0, velocity: 0 };
    stepCriticalSpring(a, 1, 2, 0.5);
    for (let i = 0; i < 50; i++) stepCriticalSpring(b, 1, 2, 0.01);
    expect(a.value).toBeCloseTo(b.value, 9);
    expect(a.velocity).toBeCloseTo(b.velocity, 9);
  });

  it('wraps angles to (-pi, pi]', () => {
    expect(wrapAngle(3 * Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 12);
    expect(wrapAngle(-3 * Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('helm', () => {
  it('moves the throttle at a limited rate, holds it and stops at zero', () => {
    const helm = new Helm(PATROL_BOAT.propulsion, PATROL_BOAT.rudder);
    const up = { throttleUp: true, throttleDown: false, port: false, starboard: false, centre: false };
    const none = { ...up, throttleUp: false };
    const down = { ...none, throttleDown: true };
    for (let i = 0; i < 60; i++) helm.update(up, DT);
    expect(helm.throttle).toBeCloseTo(0.4, 6);
    for (let i = 0; i < 600; i++) helm.update(none, DT);
    expect(helm.throttle).toBeCloseTo(0.4, 6);
    for (let i = 0; i < 600; i++) helm.update(up, DT);
    expect(helm.throttle).toBe(1);
    // Pulling back stops at the zero detent before going astern.
    for (let i = 0; i < 600; i++) helm.update(down, DT);
    expect(helm.throttle).toBe(0);
    helm.update(none, DT);
    for (let i = 0; i < 600; i++) helm.update(down, DT);
    expect(helm.throttle).toBe(PATROL_BOAT.propulsion.minThrottle);
  });

  it('limits and centres the rudder order', () => {
    const helm = new Helm(PATROL_BOAT.propulsion, PATROL_BOAT.rudder);
    const starboard = { throttleUp: false, throttleDown: false, port: false, starboard: true, centre: false };
    for (let i = 0; i < 600; i++) helm.update(starboard, DT);
    expect(helm.rudderOrderRad).toBeCloseTo(PATROL_BOAT.rudder.maxAngleRad, 9);
    helm.update({ ...starboard, starboard: false, centre: true }, DT);
    expect(helm.rudderOrderRad).toBe(0);
  });
});

function makeTarget(headingRad: number, y = 1): ShipCameraTarget & { headingRad: number } {
  return {
    position: [0, y, 0],
    // Hull +X to heading psi: rotation about +Y by pi/2 - psi.
    orientation: quaternionFromAxisAngle(0, 1, 0, Math.PI / 2 - headingRad),
    centreOfGravity: [0, 1, 0],
    boundsMin: [-25, -2.5, -5],
    boundsMax: [25, 15, 5],
    bridgeEye: [6.4, 6.7, 0],
    headingRad,
  };
}

const noInput = { dragDeltaX: 0, dragDeltaY: 0, wheelNotches: 0 } as unknown as Input;

function horizontalYaw(camera: Camera, target: ShipCameraTarget): number {
  // Direction from the ship to the camera, clockwise from north.
  const dx = (camera.position[0] as number) - (target.position[0] as number);
  const dz = (camera.position[2] as number) - (target.position[2] as number);
  return Math.atan2(dx, -dz);
}

describe('ship camera', () => {
  it('follows the heading from behind and returns to the default angle after input', () => {
    const rig = new ShipCamera();
    const camera = new Camera();
    const target = makeTarget(0);
    const frame = { dt: DT, waterHeightM: 0, secondsSinceInput: 100, returnDelayS: 3 };
    for (let i = 0; i < 600; i++) rig.update(camera, target, frame);
    const expected = Math.PI + SHIP_CAMERA_CONFIG.defaultYawOffsetRad;
    expect(wrapAngle(horizontalYaw(camera, target) - expected)).toBeCloseTo(0, 3);

    // The ship turns 90 degrees: the camera swings behind it again.
    target.headingRad = 90 * DEG;
    (target as { orientation: ArrayLike<number> }).orientation = quaternionFromAxisAngle(0, 1, 0, 0);
    for (let i = 0; i < 900; i++) rig.update(camera, target, frame);
    expect(wrapAngle(horizontalYaw(camera, target) - (expected + 90 * DEG))).toBeCloseTo(0, 2);

    // User orbits by 90 degrees; it holds while input is recent, then returns.
    rig.handleInput({ ...noInput, dragDeltaX: -(90 * DEG) / SHIP_CAMERA_CONFIG.radiansPerPixel } as unknown as Input);
    for (let i = 0; i < 120; i++) rig.update(camera, target, { ...frame, secondsSinceInput: i * DT });
    expect(wrapAngle(horizontalYaw(camera, target) - (expected + 180 * DEG))).toBeCloseTo(0, 1);
    for (let i = 0; i < 900; i++) rig.update(camera, target, { ...frame, secondsSinceInput: 3 + i * DT });
    expect(wrapAngle(horizontalYaw(camera, target) - (expected + 90 * DEG))).toBeCloseTo(0, 2);
  });

  it('clamps zoom to 30-400 m', () => {
    const rig = new ShipCamera();
    const camera = new Camera();
    const target = makeTarget(0);
    rig.handleInput({ ...noInput, wheelNotches: 100 } as unknown as Input);
    for (let i = 0; i < 300; i++) rig.update(camera, target, { dt: DT, waterHeightM: 0, secondsSinceInput: 0, returnDelayS: 3 });
    expect(rig.distanceM).toBeCloseTo(SHIP_CAMERA_CONFIG.maxDistanceM, 3);
    rig.handleInput({ ...noInput, wheelNotches: -200 } as unknown as Input);
    for (let i = 0; i < 300; i++) rig.update(camera, target, { dt: DT, waterHeightM: 0, secondsSinceInput: 0, returnDelayS: 3 });
    expect(rig.distanceM).toBeCloseTo(SHIP_CAMERA_CONFIG.minDistanceM, 3);
  });

  it('stays above the water and outside the ship', () => {
    const rig = new ShipCamera();
    const camera = new Camera();
    const target = makeTarget(0);
    rig.setMode('orbit', target);
    // Zoom fully in and look along the waterline from the side.
    rig.handleInput({ ...noInput, wheelNotches: -200, dragDeltaY: 10000 } as unknown as Input);
    rig.handleInput({ ...noInput, dragDeltaY: -10000 } as unknown as Input);
    const waterHeightM = 4; // a crest under the camera
    for (let i = 0; i < 600; i++) rig.update(camera, target, { dt: DT, waterHeightM, secondsSinceInput: 0, returnDelayS: 3 });
    expect(camera.position[1] as number).toBeGreaterThanOrEqual(waterHeightM + SHIP_CAMERA_CONFIG.waterClearanceM - 1e-9);

    // Pitch the orbit straight down onto the ship at minimum distance: pushed above the mast.
    rig.handleInput({ ...noInput, dragDeltaY: 10000 } as unknown as Input);
    for (let i = 0; i < 600; i++) rig.update(camera, target, { dt: DT, waterHeightM: 0, secondsSinceInput: 0, returnDelayS: 3 });
    const hullY = (camera.position[1] as number) - (target.position[1] as number) + 1;
    const hullX = -(camera.position[2] as number); // heading north: hull +X = world -Z
    const hullZ = camera.position[0] as number;
    const inside =
      Math.abs(hullX) < 25 + SHIP_CAMERA_CONFIG.hullClearanceM - 1e-6 &&
      Math.abs(hullZ) < 5 + SHIP_CAMERA_CONFIG.hullClearanceM - 1e-6 &&
      hullY > -2.5 - SHIP_CAMERA_CONFIG.hullClearanceM + 1e-6 &&
      hullY < 15 + SHIP_CAMERA_CONFIG.hullClearanceM - 1e-6;
    expect(inside).toBe(false);
  });

  it('bridge view rides with the ship and looks over the bow', () => {
    const rig = new ShipCamera();
    const camera = new Camera();
    const target = makeTarget(90 * DEG);
    rig.setMode('bridge', target);
    rig.update(camera, target, { dt: DT, waterHeightM: 0, secondsSinceInput: 100, returnDelayS: 3 });
    // Heading east: bow along +X.
    expect(camera.forward[0] as number).toBeCloseTo(1, 6);
    expect(camera.position[0] as number).toBeCloseTo(6.4, 6);
    expect(camera.position[1] as number).toBeCloseTo(1 + 6.7 - 1, 6);
  });
});
