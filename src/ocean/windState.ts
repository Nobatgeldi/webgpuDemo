/**
 * Wind that approaches the requested value at a limited rate, so that the sea
 * state changes smoothly instead of jumping when a slider moves.
 */

/** Maximum change of the wind speed (m/s per second). */
export const WIND_SPEED_RATE_MS_PER_S = 1;
/** Maximum change of the wind direction (rad per second). */
export const WIND_DIRECTION_RATE_RAD_PER_S = (10 * Math.PI) / 180;

const TWO_PI = 2 * Math.PI;

export class WindState {
  private currentSpeed: number;
  private currentDirection: number;
  private targetSpeed: number;
  private targetDirection: number;

  /**
   * @param speedMs 10 m wind speed.
   * @param fromDirectionRad Meteorological direction the wind blows FROM, clockwise from north.
   */
  constructor(speedMs: number, fromDirectionRad: number) {
    this.currentSpeed = this.targetSpeed = Math.max(0, speedMs);
    this.currentDirection = this.targetDirection = normaliseAngle(fromDirectionRad);
  }

  get speedMs(): number {
    return this.currentSpeed;
  }

  get fromDirectionRad(): number {
    return this.currentDirection;
  }

  get targetSpeedMs(): number {
    return this.targetSpeed;
  }

  get transitioning(): boolean {
    return this.currentSpeed !== this.targetSpeed || this.currentDirection !== this.targetDirection;
  }

  setTarget(speedMs: number, fromDirectionRad: number): void {
    this.targetSpeed = Math.max(0, speedMs);
    this.targetDirection = normaliseAngle(fromDirectionRad);
  }

  /** Jumps to the target immediately (initial conditions, URL parameters). */
  snapToTarget(): void {
    this.currentSpeed = this.targetSpeed;
    this.currentDirection = this.targetDirection;
  }

  /** Advances by `dt` seconds; returns true if the wind changed. */
  step(dt: number): boolean {
    if (!this.transitioning) {
      return false;
    }
    const maxSpeedStep = WIND_SPEED_RATE_MS_PER_S * dt;
    const speedDelta = this.targetSpeed - this.currentSpeed;
    this.currentSpeed =
      Math.abs(speedDelta) <= maxSpeedStep
        ? this.targetSpeed
        : this.currentSpeed + Math.sign(speedDelta) * maxSpeedStep;

    const maxAngleStep = WIND_DIRECTION_RATE_RAD_PER_S * dt;
    const angleDelta = shortestAngle(this.currentDirection, this.targetDirection);
    this.currentDirection =
      Math.abs(angleDelta) <= maxAngleStep
        ? this.targetDirection
        : normaliseAngle(this.currentDirection + Math.sign(angleDelta) * maxAngleStep);
    return true;
  }
}

/** Unit vector (x, z) of the direction the wind blows TOWARDS (wave propagation). */
export function propagationVector(fromDirectionRad: number): [number, number] {
  const towards = fromDirectionRad + Math.PI;
  // Compass convention: north = -Z, east = +X.
  return [Math.sin(towards), -Math.cos(towards)];
}

function normaliseAngle(angle: number): number {
  const wrapped = angle % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return delta;
}
