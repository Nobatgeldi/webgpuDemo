import type { Input } from '../input/input';
import type { Camera } from '../render/camera';

const DEG_TO_RAD = Math.PI / 180;

/** Tunables of the orbit controller. */
export const ORBIT_CAMERA_CONFIG = {
  /** Zoom range (m), as required for the ship camera. */
  minDistanceM: 30,
  maxDistanceM: 400,
  initialDistanceM: 120,
  /** Pitch range: above the horizon so the camera stays above sea level. */
  minPitchRad: 3 * DEG_TO_RAD,
  maxPitchRad: 85 * DEG_TO_RAD,
  initialPitchRad: 18 * DEG_TO_RAD,
  /** Initial heading of the camera around the target, clockwise from north. */
  initialYawRad: 200 * DEG_TO_RAD,
  /** Rotation per dragged CSS pixel. */
  radiansPerPixel: 0.005,
  /** Distance multiplier per wheel notch. */
  zoomFactorPerNotch: 1.12,
  /** Time constant (s) of the exponential smoothing towards the requested pose. */
  smoothingTimeConstantS: 0.08,
} as const;

/**
 * Simple orbit camera around a world-space target: mouse drag rotates, wheel
 * zooms. Used for phase 0; the ship follow camera replaces it as default in phase 4.
 */
export class OrbitCameraController {
  /** Orbit centre in world space (double precision). */
  readonly target = new Float64Array([0, 0, 0]);

  private yawGoal: number = ORBIT_CAMERA_CONFIG.initialYawRad;
  private pitchGoal: number = ORBIT_CAMERA_CONFIG.initialPitchRad;
  private distanceGoal: number = ORBIT_CAMERA_CONFIG.initialDistanceM;
  private yaw = this.yawGoal;
  private pitch = this.pitchGoal;
  private distance = this.distanceGoal;

  handleInput(input: Input): void {
    const c = ORBIT_CAMERA_CONFIG;
    this.yawGoal -= input.dragDeltaX * c.radiansPerPixel;
    this.pitchGoal = clamp(
      this.pitchGoal + input.dragDeltaY * c.radiansPerPixel,
      c.minPitchRad,
      c.maxPitchRad,
    );
    if (input.wheelNotches !== 0) {
      this.distanceGoal = clamp(
        this.distanceGoal * Math.pow(c.zoomFactorPerNotch, input.wheelNotches),
        c.minDistanceM,
        c.maxDistanceM,
      );
    }
  }

  /**
   * Advances smoothing by `dt` seconds (wall time) and writes the pose into
   * `camera`, keeping the camera at least `minAltitudeM` above sea level.
   */
  update(camera: Camera, dt: number, minAltitudeM: number): void {
    const blend = 1 - Math.exp(-dt / ORBIT_CAMERA_CONFIG.smoothingTimeConstantS);
    this.yaw += (this.yawGoal - this.yaw) * blend;
    this.pitch += (this.pitchGoal - this.pitch) * blend;
    // Zoom smoothing in log space feels uniform across the whole range.
    this.distance *= Math.pow(this.distanceGoal / this.distance, blend);

    const cosPitch = Math.cos(this.pitch);
    // Offset from the target towards the camera; yaw is clockwise from north (-Z).
    const offsetX = this.distance * cosPitch * Math.sin(this.yaw);
    const offsetY = this.distance * Math.sin(this.pitch);
    const offsetZ = -this.distance * cosPitch * Math.cos(this.yaw);

    camera.position[0] = (this.target[0] as number) + offsetX;
    camera.position[1] = Math.max((this.target[1] as number) + offsetY, minAltitudeM);
    camera.position[2] = (this.target[2] as number) + offsetZ;
    camera.lookAt(this.target);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
