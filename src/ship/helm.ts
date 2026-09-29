/**
 * Bridge controls: the throttle lever and the helm (ordered rudder angle).
 * Keys move the lever/helm at a limited rate and they stay where they are
 * released; the propulsion then follows with its own dynamics (shaft speed
 * lag, steering gear rate).
 */
import type { PropulsionConfig, RudderConfig } from './shipConfig';

/** Throttle lever travel per second while a key is held (full ahead from stop in 2.5 s). */
export const THROTTLE_LEVER_RATE_PER_S = 0.4;
/** Helm (rudder order) change per second while a key is held (rad/s). */
export const RUDDER_ORDER_RATE_RAD_PER_S = (20 * Math.PI) / 180;

export interface HelmInput {
  readonly throttleUp: boolean;
  readonly throttleDown: boolean;
  /** Turn to port / starboard. */
  readonly port: boolean;
  readonly starboard: boolean;
  /** Centre the rudder. */
  readonly centre: boolean;
}

export class Helm {
  throttle = 0;
  rudderOrderRad = 0;
  /** Set when the lever stopped at the zero detent; cleared when the throttle keys are released. */
  private atStopDetent = false;

  constructor(
    private readonly propulsion: PropulsionConfig,
    private readonly rudder: RudderConfig,
  ) {}

  update(input: HelmInput, dt: number): void {
    const lever = (input.throttleUp ? 1 : 0) - (input.throttleDown ? 1 : 0);
    if (lever === 0) {
      this.atStopDetent = false;
    } else if (!this.atStopDetent) {
      const previous = this.throttle;
      const moved = Math.min(
        this.propulsion.maxThrottle,
        Math.max(this.propulsion.minThrottle, previous + lever * THROTTLE_LEVER_RATE_PER_S * dt),
      );
      // A detent at stop: moving through zero stops there until the key is released.
      if (previous !== 0 && Math.sign(moved) !== Math.sign(previous)) {
        this.throttle = 0;
        this.atStopDetent = true;
      } else {
        this.throttle = moved;
      }
    }
    if (input.centre) {
      this.rudderOrderRad = 0;
    } else {
      const helm = (input.starboard ? 1 : 0) - (input.port ? 1 : 0);
      this.rudderOrderRad = Math.min(
        this.rudder.maxAngleRad,
        Math.max(-this.rudder.maxAngleRad, this.rudderOrderRad + helm * RUDDER_ORDER_RATE_RAD_PER_S * dt),
      );
    }
  }
}
