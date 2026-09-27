/**
 * Propeller and rudder.
 *
 * Propeller: the shaft speed follows the throttle with a first-order lag.
 * Thrust T = T0 (n|n| e - |n| Va / Vref) with n = rpm / maxRpm, e = 1 ahead
 * and the astern efficiency astern, Va the advance speed. T0 (bollard pull)
 * and Vref are calibrated so that full throttle balances the calm-water
 * resistance exactly at the design speed. Thrust scales with the immersed
 * fraction of the propeller disc (zero when the stern lifts out of the water).
 *
 * Rudder: a low-aspect-ratio foil in the propeller slipstream. The inflow is
 * the local water velocity plus the slipstream speed-up from momentum theory
 * (V^2 = Va^2 + f 8T / (rho pi D^2)); lift = 1/2 rho A V^2 C_L(alpha) with a
 * linear lift slope 2 pi AR / (AR + 2) up to the stall angle and a gradual
 * post-stall loss; induced and profile drag along the inflow.
 */
import { SEA_WATER_DENSITY_KG_M3 } from '../core/constants';
import { calmWaterResistance, type HydrodynamicCoefficients } from './hydrodynamics';
import type { RigidBody } from './rigidBody';
import { KNOTS_TO_MS, type PropulsionConfig, type RudderConfig } from './shipConfig';
import type { WaterHeightProvider } from './waterHeightProvider';

/** Extra drag coefficient of a fully stalled foil (flat plate towards 90 degrees). */
const POST_STALL_DRAG = 1.2;
const HALF_PI = Math.PI / 2;

/** Orders from the helm (bridge controls). */
export interface HelmOrders {
  /** Throttle lever: minThrottle (astern) ... 1 (full ahead). */
  readonly throttle: number;
  /** Ordered rudder angle, positive = trailing edge to starboard (turns to starboard) (rad). */
  readonly rudderOrderRad: number;
}

/** Lift coefficient of the rudder at an angle of attack (rad, any value). */
export function rudderLiftCoefficient(alpha: number, config: RudderConfig): number {
  // Wrap to (-pi, pi]; with the flow from behind the profile acts reversed.
  let a = Math.atan2(Math.sin(alpha), Math.cos(alpha));
  let sign = 1;
  if (Math.abs(a) > HALF_PI) {
    a = a > 0 ? Math.PI - a : -Math.PI - a;
    sign = -1;
  }
  const slope = (2 * Math.PI * config.aspectRatio) / (config.aspectRatio + 2);
  const magnitude = Math.abs(a);
  const peak = slope * config.stallAngleRad;
  let cl: number;
  if (magnitude <= config.stallAngleRad) {
    cl = slope * magnitude;
  } else {
    const t = (magnitude - config.stallAngleRad) / (HALF_PI - config.stallAngleRad);
    cl = peak * (1 - (1 - config.postStallLiftFraction) * t);
  }
  return sign * Math.sign(a) * cl;
}

export function rudderDragCoefficient(alpha: number, config: RudderConfig): number {
  const cl = rudderLiftCoefficient(alpha, config);
  const s = Math.abs(Math.sin(alpha));
  const stallSine = Math.sin(config.stallAngleRad);
  const postStall = s > stallSine ? POST_STALL_DRAG * (s * s - stallSine * stallSine) : 0;
  return config.profileDragCoefficient + (cl * cl) / (Math.PI * config.aspectRatio * config.spanEfficiency) + postStall;
}

export interface PropellerCalibration {
  /** Bollard-pull thrust at full ahead (N). */
  readonly bollardThrustN: number;
  /** Advance speed scale Vref of the thrust model (m/s). */
  readonly referenceSpeedMs: number;
  /** Design (top) speed and the resistance there. */
  readonly designSpeedMs: number;
  readonly designResistanceN: number;
}

export function calibratePropeller(
  propulsion: PropulsionConfig,
  maxSpeedKnots: number,
  coefficients: HydrodynamicCoefficients,
): PropellerCalibration {
  const designSpeedMs = maxSpeedKnots * KNOTS_TO_MS;
  const designResistanceN = calmWaterResistance(designSpeedMs, coefficients);
  const bollardThrustN = propulsion.bollardThrustRatio * designResistanceN;
  const advance = (1 - propulsion.wakeFraction) * designSpeedMs;
  // T0 (1 - Va / Vref) = R at full ahead and the design speed.
  const referenceSpeedMs = advance / (1 - 1 / propulsion.bollardThrustRatio);
  return { bollardThrustN, referenceSpeedMs, designSpeedMs, designResistanceN };
}

export interface PropulsionState {
  rpm: number;
  rudderAngleRad: number;
  thrustN: number;
  /** Immersed fraction of the propeller disc. */
  propellerImmersion: number;
  /** Rudder angle of attack and lateral force (N, positive to starboard). */
  rudderAngleOfAttackRad: number;
  rudderSideForceN: number;
}

export class Propulsion {
  readonly state: PropulsionState = {
    rpm: 0,
    rudderAngleRad: 0,
    thrustN: 0,
    propellerImmersion: 1,
    rudderAngleOfAttackRad: 0,
    rudderSideForceN: 0,
  };
  private readonly scratch = new Float64Array(3);
  private readonly velocity = new Float64Array(3);
  private readonly forward = new Float64Array(3);
  private readonly starboard = new Float64Array(3);

  constructor(
    private readonly propeller: PropulsionConfig,
    private readonly rudder: RudderConfig,
    readonly calibration: PropellerCalibration,
    /** Centre of gravity in the hull frame, to place the propeller and rudder on the body. */
    private readonly centreOfGravity: readonly number[],
    private readonly density = SEA_WATER_DENSITY_KG_M3,
  ) {}

  /** Advances shaft speed and steering gear by `dt` and applies thrust and rudder forces. */
  apply(body: RigidBody, orders: HelmOrders, water: WaterHeightProvider, timeS: number, dt: number): void {
    const s = this.state;
    const p = this.propeller;
    const r = this.rudder;

    // Shaft speed: first-order lag towards the throttle setting.
    const throttle = Math.min(p.maxThrottle, Math.max(p.minThrottle, orders.throttle));
    s.rpm += (throttle * p.maxRpm - s.rpm) * (1 - Math.exp(-dt / p.rpmTimeConstantS));

    // Steering gear: rate-limited towards the ordered angle.
    const order = Math.min(r.maxAngleRad, Math.max(-r.maxAngleRad, orders.rudderOrderRad));
    const maxStep = r.rateRadPerS * dt;
    s.rudderAngleRad += Math.min(maxStep, Math.max(-maxStep, order - s.rudderAngleRad));

    body.rotateToWorld([1, 0, 0], this.forward);
    body.rotateToWorld([0, 0, 1], this.starboard);
    const fx = this.forward[0] as number, fy = this.forward[1] as number, fz = this.forward[2] as number;
    const sx = this.starboard[0] as number, sy = this.starboard[1] as number, sz = this.starboard[2] as number;

    // --- Propeller ---
    const prop = this.bodyPoint(body, p.propellerPosition, this.scratch);
    const px = prop[0] as number, py = prop[1] as number, pz = prop[2] as number;
    body.pointVelocity(px, py, pz, this.velocity);
    const surge = (this.velocity[0] as number) * fx + (this.velocity[1] as number) * fy + (this.velocity[2] as number) * fz;
    const advance = (1 - p.wakeFraction) * surge;
    const n = s.rpm / p.maxRpm;
    const efficiency = n >= 0 ? 1 : p.asternEfficiency;
    const radius = p.propellerDiameterM / 2;
    s.propellerImmersion = Math.min(1, Math.max(0, (water.heightAt(px, pz, timeS) - (py - radius)) / p.propellerDiameterM));
    const c = this.calibration;
    s.thrustN =
      c.bollardThrustN * (n * Math.abs(n) * efficiency - (Math.abs(n) * advance) / c.referenceSpeedMs) * s.propellerImmersion;
    body.addForceAtPoint(s.thrustN * fx, s.thrustN * fy, s.thrustN * fz, px, py, pz);

    // --- Rudder ---
    const rudderPoint = this.bodyPoint(body, r.position, this.scratch);
    const rx = rudderPoint[0] as number, ry = rudderPoint[1] as number, rz = rudderPoint[2] as number;
    body.pointVelocity(rx, ry, rz, this.velocity);
    const u = (this.velocity[0] as number) * fx + (this.velocity[1] as number) * fy + (this.velocity[2] as number) * fz;
    const v = (this.velocity[0] as number) * sx + (this.velocity[1] as number) * sy + (this.velocity[2] as number) * sz;
    // Axial inflow including the slipstream of a propeller working ahead.
    const discArea = Math.PI * radius * radius;
    const slipstream = s.thrustN > 0 ? (r.propwashFraction * 2 * s.thrustN) / (this.density * discArea) : 0;
    const axial = u >= 0 || slipstream > 0 ? Math.sqrt(Math.max(u, 0) ** 2 + slipstream) : u;
    // Water velocity relative to the rudder in (forward, starboard) coordinates.
    const wf = -axial;
    const ws = -v;
    const speed = Math.hypot(wf, ws);
    const rudderImmersion = water.heightAt(rx, rz, timeS) > ry ? 1 : 0;
    s.rudderAngleOfAttackRad = s.rudderAngleRad + Math.atan2(v, axial);
    s.rudderSideForceN = 0;
    if (speed > 1e-6 && rudderImmersion > 0) {
      const q = 0.5 * this.density * r.areaM2 * speed * speed;
      const lift = q * rudderLiftCoefficient(s.rudderAngleOfAttackRad, r);
      const drag = q * rudderDragCoefficient(s.rudderAngleOfAttackRad, r);
      // Unit inflow and the lift direction (inflow rotated by +90 degrees: towards port for alpha > 0).
      const uf = wf / speed;
      const us = ws / speed;
      const forceForward = drag * uf + lift * -us;
      const forceStarboard = drag * us + lift * uf;
      s.rudderSideForceN = forceStarboard;
      body.addForceAtPoint(
        forceForward * fx + forceStarboard * sx,
        forceForward * fy + forceStarboard * sy,
        forceForward * fz + forceStarboard * sz,
        rx,
        ry,
        rz,
      );
    }
  }

  private bodyPoint(body: RigidBody, hullPoint: readonly number[], out: Float64Array): Float64Array {
    out[0] = (hullPoint[0] as number) - (this.centreOfGravity[0] as number);
    out[1] = (hullPoint[1] as number) - (this.centreOfGravity[1] as number);
    out[2] = (hullPoint[2] as number) - (this.centreOfGravity[2] as number);
    return body.pointToWorld(out, out);
  }
}
