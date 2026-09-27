/**
 * Ship camera rig with three modes:
 *  - follow: behind the ship, turning with its heading through a critically
 *    damped spring; the user can orbit and zoom, and the view drifts back to
 *    the default angle a few seconds after the last input. Heave is smoothed and
 *    only a fraction of the ship's roll/pitch tilts the horizon.
 *  - orbit: free orbit around the ship in world directions (no heading follow,
 *    no return).
 *  - bridge: at the bridge windows, moving rigidly with the hull; drag looks around.
 *
 * In every mode the camera stays at least a clearance above the water surface
 * below it and outside the ship's bounding box.
 */
import { stepCriticalSpring, wrapAngle, type SpringState } from '../core/spring';
import type { Input } from '../input/input';
import type { Camera } from '../render/camera';
import { rotate } from '../ship/rigidBody';

const DEG_TO_RAD = Math.PI / 180;

export type CameraMode = 'follow' | 'orbit' | 'bridge';

/** Order in which the camera key cycles through the modes. */
export const CAMERA_MODES: readonly CameraMode[] = ['follow', 'orbit', 'bridge'];

/** Mode names shown in the UI. */
export const CAMERA_MODE_LABELS: Readonly<Record<CameraMode, string>> = {
  follow: 'Takip',
  orbit: 'Serbest yörünge',
  bridge: 'Köprüüstü',
};

export const SHIP_CAMERA_CONFIG = {
  /** Zoom range and the initial distance from the ship's centre of gravity (m). */
  minDistanceM: 30,
  maxDistanceM: 400,
  initialDistanceM: 110,
  /** Elevation of the orbit above the horizon. */
  minPitchRad: 2 * DEG_TO_RAD,
  maxPitchRad: 85 * DEG_TO_RAD,
  defaultPitchRad: 14 * DEG_TO_RAD,
  /** Default view direction relative to straight astern (positive = from the starboard quarter). */
  defaultYawOffsetRad: 25 * DEG_TO_RAD,
  /** Rotation per dragged CSS pixel and distance factor per wheel notch. */
  radiansPerPixel: 0.005,
  zoomFactorPerNotch: 1.12,
  /** Spring frequency (rad/s) of direct user rotation and zoom: quick but not jumpy. */
  userResponseOmega: 18,
  /** Spring frequency (rad/s) with which the follow camera turns after the ship's heading. */
  headingFollowOmega: 1.6,
  /** Spring frequency (rad/s) of the drift back to the default angle. */
  returnOmega: 1.2,
  /** Spring frequency (rad/s) smoothing the height of the look-at point (hides heave). */
  targetHeightOmega: 2.5,
  /** Share of the ship's tilt (roll and pitch) passed to the follow camera's horizon. */
  attitudeTransfer: 0.15,
  /** Spring frequency (rad/s) of that horizon tilt. */
  attitudeOmega: 4,
  /** Minimum height above the water surface below the camera (m). */
  waterClearanceM: 1.5,
  /** Margin around the ship's bounding box kept free of the camera (m). */
  hullClearanceM: 2,
  /** Look-around limits on the bridge. */
  bridgeMaxYawRad: 160 * DEG_TO_RAD,
  bridgeMaxPitchRad: 60 * DEG_TO_RAD,
} as const;

/** Where the ship is this frame (render pose) and its dimensions. */
export interface ShipCameraTarget {
  /** World position of the centre of gravity. */
  readonly position: ArrayLike<number>;
  /** Hull-to-world rotation (unit quaternion w, x, y, z). */
  readonly orientation: ArrayLike<number>;
  /** Centre of gravity in the hull frame. */
  readonly centreOfGravity: ArrayLike<number>;
  /** Bounding box of hull and superstructure in the hull frame. */
  readonly boundsMin: ArrayLike<number>;
  readonly boundsMax: ArrayLike<number>;
  /** Bridge eye point in the hull frame. */
  readonly bridgeEye: ArrayLike<number>;
  /** Heading, clockwise from north (rad). */
  readonly headingRad: number;
}

export interface ShipCameraFrame {
  readonly dt: number;
  /** Water surface height below the camera (m). */
  readonly waterHeightM: number;
  /** Seconds since the last camera input by the user. */
  readonly secondsSinceInput: number;
  /** Delay after which the view returns to the default angle (s). */
  readonly returnDelayS: number;
}

function spring(value: number): SpringState {
  return { value, velocity: 0 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class ShipCamera {
  mode: CameraMode = 'follow';

  // Goals set by the user (follow: yaw relative to astern; orbit: absolute yaw clockwise from north).
  private yawGoal: number = SHIP_CAMERA_CONFIG.defaultYawOffsetRad;
  private pitchGoal: number = SHIP_CAMERA_CONFIG.defaultPitchRad;
  private distanceGoal: number = SHIP_CAMERA_CONFIG.initialDistanceM;
  private bridgeYawGoal = 0;
  private bridgePitchGoal = 0;

  private readonly yawOffset = spring(SHIP_CAMERA_CONFIG.defaultYawOffsetRad);
  private readonly pitch = spring(SHIP_CAMERA_CONFIG.defaultPitchRad);
  private readonly logDistance = spring(Math.log(SHIP_CAMERA_CONFIG.initialDistanceM));
  private readonly heading = spring(0);
  private readonly targetHeight = spring(0);
  private readonly tilt = [spring(0), spring(1), spring(0)];
  private readonly bridgeYaw = spring(0);
  private readonly bridgePitch = spring(0);
  private initialised = false;
  private readonly scratch = new Float64Array(3);
  private readonly look = new Float64Array(3);

  /** Switches to the next mode; the orbit mode keeps the current view direction. */
  cycleMode(target: ShipCameraTarget): void {
    const next = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length] as CameraMode;
    this.setMode(next, target);
  }

  setMode(mode: CameraMode, target: ShipCameraTarget): void {
    if (mode === this.mode) return;
    const astern = target.headingRad + Math.PI;
    if (mode === 'orbit' && this.mode === 'follow') {
      // Absolute yaw of the current view.
      this.yawOffset.value = wrapAngle(this.yawOffset.value + this.heading.value + Math.PI);
      this.yawGoal = wrapAngle(this.yawGoal + this.heading.value + Math.PI);
    } else if (mode === 'follow' && this.mode === 'orbit') {
      this.yawOffset.value = wrapAngle(this.yawOffset.value - astern);
      this.yawGoal = wrapAngle(this.yawGoal - astern);
      this.heading.value = target.headingRad;
      this.heading.velocity = 0;
    } else if (mode === 'follow' || mode === 'orbit') {
      // From the bridge: back to the default view.
      const absolute = mode === 'orbit' ? astern : 0;
      this.yawGoal = wrapAngle(SHIP_CAMERA_CONFIG.defaultYawOffsetRad + absolute);
      this.yawOffset.value = this.yawGoal;
      this.heading.value = target.headingRad;
    }
    if (mode === 'bridge') {
      this.bridgeYawGoal = 0;
      this.bridgePitchGoal = 0;
      this.bridgeYaw.value = 0;
      this.bridgePitch.value = 0;
    }
    this.yawOffset.velocity = 0;
    this.mode = mode;
  }

  handleInput(input: Input): void {
    const c = SHIP_CAMERA_CONFIG;
    const dx = input.dragDeltaX * c.radiansPerPixel;
    const dy = input.dragDeltaY * c.radiansPerPixel;
    if (this.mode === 'bridge') {
      this.bridgeYawGoal = clamp(this.bridgeYawGoal - dx, -c.bridgeMaxYawRad, c.bridgeMaxYawRad);
      this.bridgePitchGoal = clamp(this.bridgePitchGoal - dy, -c.bridgeMaxPitchRad, c.bridgeMaxPitchRad);
      return;
    }
    this.yawGoal -= dx;
    this.pitchGoal = clamp(this.pitchGoal + dy, c.minPitchRad, c.maxPitchRad);
    if (input.wheelNotches !== 0) {
      this.distanceGoal = clamp(
        this.distanceGoal * Math.pow(c.zoomFactorPerNotch, input.wheelNotches),
        c.minDistanceM,
        c.maxDistanceM,
      );
    }
  }

  /** Current distance from the ship (m). */
  get distanceM(): number {
    return Math.exp(this.logDistance.value);
  }

  update(camera: Camera, target: ShipCameraTarget, frame: ShipCameraFrame): void {
    const c = SHIP_CAMERA_CONFIG;
    const dt = frame.dt;
    const px = target.position[0] as number;
    const py = target.position[1] as number;
    const pz = target.position[2] as number;
    if (!this.initialised) {
      this.heading.value = target.headingRad;
      this.targetHeight.value = py;
      this.initialised = true;
    }

    const returning = frame.secondsSinceInput >= frame.returnDelayS;
    if (this.mode === 'bridge') {
      if (returning) {
        this.bridgeYawGoal = 0;
        this.bridgePitchGoal = 0;
      }
      const omega = returning ? c.returnOmega : c.userResponseOmega;
      stepCriticalSpring(this.bridgeYaw, this.bridgeYawGoal, omega, dt);
      stepCriticalSpring(this.bridgePitch, this.bridgePitchGoal, omega, dt);
      this.updateBridge(camera, target);
    } else {
      if (this.mode === 'follow' && returning) {
        // Drift back to the default angle; zoom stays as chosen.
        this.yawGoal = c.defaultYawOffsetRad;
        this.pitchGoal = c.defaultPitchRad;
      }
      const omega = this.mode === 'follow' && returning ? c.returnOmega : c.userResponseOmega;
      // Take the short way round.
      this.yawGoal = this.yawOffset.value + wrapAngle(this.yawGoal - this.yawOffset.value);
      stepCriticalSpring(this.yawOffset, this.yawGoal, omega, dt);
      stepCriticalSpring(this.pitch, this.pitchGoal, omega, dt);
      stepCriticalSpring(this.logDistance, Math.log(this.distanceGoal), c.userResponseOmega, dt);
      this.heading.value = target.headingRad + wrapAngle(this.heading.value - target.headingRad);
      stepCriticalSpring(this.heading, target.headingRad, c.headingFollowOmega, dt);
      stepCriticalSpring(this.targetHeight, py, c.targetHeightOmega, dt);

      const yaw = this.mode === 'follow' ? this.heading.value + Math.PI + this.yawOffset.value : this.yawOffset.value;
      const distance = this.distanceM;
      const cosPitch = Math.cos(this.pitch.value);
      const lookY = this.targetHeight.value;
      // Offset from the target towards the camera; yaw is clockwise from north (-Z).
      camera.position[0] = px + distance * cosPitch * Math.sin(yaw);
      camera.position[1] = lookY + distance * Math.sin(this.pitch.value);
      camera.position[2] = pz - distance * cosPitch * Math.cos(yaw);
      this.look[0] = px;
      this.look[1] = lookY;
      this.look[2] = pz;

      // Horizon: world up, tilted by a fraction of the ship's up vector in follow mode.
      const shipUp = rotate(target.orientation, [0, 1, 0], this.scratch, false);
      const k = this.mode === 'follow' ? c.attitudeTransfer : 0;
      for (let i = 0; i < 3; i++) {
        const goal = (i === 1 ? 1 - k : 0) + k * (shipUp[i] as number);
        stepCriticalSpring(this.tilt[i] as SpringState, goal, c.attitudeOmega, dt);
      }
      const t = this.tilt;
      const length = Math.hypot(t[0]!.value, t[1]!.value, t[2]!.value);
      camera.up[0] = t[0]!.value / length;
      camera.up[1] = t[1]!.value / length;
      camera.up[2] = t[2]!.value / length;

      this.keepOutOfHull(camera, target);
      camera.position[1] = Math.max(camera.position[1] as number, frame.waterHeightM + c.waterClearanceM);
      camera.lookAt(this.look);
    }
  }

  private updateBridge(camera: Camera, target: ShipCameraTarget): void {
    const eye = this.hullToWorld(target, target.bridgeEye, this.scratch);
    camera.position[0] = eye[0] as number;
    camera.position[1] = eye[1] as number;
    camera.position[2] = eye[2] as number;
    // Look direction in the hull frame (+X bow, +Y up, +Z starboard); positive yaw turns to port.
    const yaw = this.bridgeYaw.value;
    const pitch = this.bridgePitch.value;
    const dir = [Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.sin(yaw)];
    rotate(target.orientation, dir, this.look, false);
    camera.forward[0] = this.look[0] as number;
    camera.forward[1] = this.look[1] as number;
    camera.forward[2] = this.look[2] as number;
    rotate(target.orientation, [0, 1, 0], this.look, false);
    camera.up[0] = this.look[0] as number;
    camera.up[1] = this.look[1] as number;
    camera.up[2] = this.look[2] as number;
  }

  /** Pushes the camera out of the ship's bounding box (plus margin) along the shortest way. */
  private keepOutOfHull(camera: Camera, target: ShipCameraTarget): void {
    const margin = SHIP_CAMERA_CONFIG.hullClearanceM;
    const local = this.scratch;
    for (let i = 0; i < 3; i++) {
      local[i] = (camera.position[i] as number) - (target.position[i] as number);
    }
    rotate(target.orientation, local, local, true);
    let axis = -1;
    let push = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      // Hull-frame coordinate of the camera.
      const h = (local[i] as number) + (target.centreOfGravity[i] as number);
      const low = (target.boundsMin[i] as number) - margin;
      const high = (target.boundsMax[i] as number) + margin;
      if (h <= low || h >= high) return; // outside
      const toLow = low - h;
      const toHigh = high - h;
      const candidate = Math.abs(toLow) < Math.abs(toHigh) ? toLow : toHigh;
      if (Math.abs(candidate) < Math.abs(push)) {
        push = candidate;
        axis = i;
      }
    }
    local[axis] = (local[axis] as number) + push;
    rotate(target.orientation, local, local, false);
    for (let i = 0; i < 3; i++) {
      camera.position[i] = (target.position[i] as number) + (local[i] as number);
    }
  }

  private hullToWorld(target: ShipCameraTarget, hull: ArrayLike<number>, out: Float64Array): Float64Array {
    for (let i = 0; i < 3; i++) {
      out[i] = (hull[i] as number) - (target.centreOfGravity[i] as number);
    }
    rotate(target.orientation, out, out, false);
    for (let i = 0; i < 3; i++) {
      out[i] = (out[i] as number) + (target.position[i] as number);
    }
    return out;
  }
}
