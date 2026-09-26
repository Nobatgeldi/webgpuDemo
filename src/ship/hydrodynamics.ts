/**
 * Hydrodynamic forces on the submerged hull panels (after Kerner 2015):
 *
 * - Skin friction (ITTC-1957): each panel is dragged along its tangential
 *   velocity with 1/2 rho (1 + k) C_F(Re) A |v_t| v_t,
 *   C_F = 0.075 / (log10 Re - 2)^2, Re = V L / nu.
 * - Pressure damping: panels moving along their normal feel
 *   -(C_lin v_n + 1/2 rho C_D |v_n| v_n) A n. It stands in for the radiation
 *   damping of heave, pitch, roll, sway and yaw. The ship's forward speed is
 *   excluded once the ship is under way (resistance at speed is friction plus,
 *   from phase 4, wave resistance); at drifting speeds it stays, so that
 *   transient surge impulses die out instead of drifting forever. C_lin is
 *   calibrated so that heave has the configured damping ratio.
 * - Roll damping: an extra moment -(B1 p + B2 p|p|) about the longitudinal
 *   axis (bilge keels, viscous roll damping), with B1 from the configured ratio.
 */
import { SEA_WATER_DENSITY_KG_M3, SEA_WATER_KINEMATIC_VISCOSITY_M2_S } from '../core/constants';
import type { SubmergedTriangles } from './buoyancy';
import type { RigidBody } from './rigidBody';

/**
 * Surge speeds (m/s) between which the forward motion is faded out of the
 * pressure damping (drifting -> under way).
 */
const SURGE_EXCLUSION_START_MS = 0.3;
const SURGE_EXCLUSION_END_MS = 1.5;

/** ITTC-1957 is fitted for Re > ~1e5; below, C_F is held at this Reynolds number. */
const MIN_REYNOLDS_NUMBER = 1e5;

/** ITTC-1957 model-ship correlation line. */
export function ittcFrictionCoefficient(reynolds: number): number {
  const log = Math.log10(Math.max(reynolds, MIN_REYNOLDS_NUMBER)) - 2;
  return 0.075 / (log * log);
}

export interface HydrodynamicCoefficients {
  readonly lengthM: number;
  /** Linear panel pressure damping (N s / m^3). */
  readonly linearPanelDamping: number;
  /** Quadratic panel drag coefficient C_D. */
  readonly panelDragCoefficient: number;
  /** ITTC form factor k. */
  readonly formFactor: number;
  /** Linear and quadratic roll damping (N m s, N m s^2). */
  readonly rollLinearDamping: number;
  readonly rollQuadraticDamping: number;
}

export interface HydrodynamicTotals {
  readonly friction: Float64Array;
  readonly pressure: Float64Array;
  rollMomentNm: number;
}

export class HydrodynamicModel {
  readonly totals: HydrodynamicTotals = {
    friction: new Float64Array(3),
    pressure: new Float64Array(3),
    rollMomentNm: 0,
  };
  /** Per submerged triangle: friction + pressure force (N), for the debug view. */
  readonly panelForces: Float64Array;
  private readonly velocity = new Float64Array(3);
  private readonly axis = new Float64Array(3);
  private readonly forwardBody = new Float64Array([1, 0, 0]);

  constructor(
    private readonly coefficients: HydrodynamicCoefficients,
    capacity: number,
    private readonly density = SEA_WATER_DENSITY_KG_M3,
  ) {
    this.panelForces = new Float64Array(capacity * 3);
  }

  apply(body: RigidBody, submerged: SubmergedTriangles): void {
    const k = this.coefficients;
    const rho = this.density;
    const forward = body.rotateToWorld(this.forwardBody, this.axis);
    const fx = forward[0] as number;
    const fy = forward[1] as number;
    const fz = forward[2] as number;
    const vx = body.velocity[0] as number;
    const vy = body.velocity[1] as number;
    const vz = body.velocity[2] as number;
    const speed = Math.hypot(vx, vy, vz);
    const surge = vx * fx + vy * fy + vz * fz;
    const exclusionT = Math.min(1, Math.max(0, (Math.abs(surge) - SURGE_EXCLUSION_START_MS) / (SURGE_EXCLUSION_END_MS - SURGE_EXCLUSION_START_MS)));
    const excludedSurge = surge * exclusionT * exclusionT * (3 - 2 * exclusionT);
    const reynolds = (speed * k.lengthM) / SEA_WATER_KINEMATIC_VISCOSITY_M2_S;
    const frictionFactor = 0.5 * rho * (1 + k.formFactor) * ittcFrictionCoefficient(reynolds);

    const totals = this.totals;
    totals.friction.fill(0);
    totals.pressure.fill(0);
    const v = this.velocity;
    for (let i = 0; i < submerged.count; i++) {
      const px = submerged.centroids[3 * i] as number;
      const py = submerged.centroids[3 * i + 1] as number;
      const pz = submerged.centroids[3 * i + 2] as number;
      const nx = submerged.normals[3 * i] as number;
      const ny = submerged.normals[3 * i + 1] as number;
      const nz = submerged.normals[3 * i + 2] as number;
      const area = submerged.areas[i] as number;
      body.pointVelocity(px, py, pz, v);
      const ux = v[0] as number;
      const uy = v[1] as number;
      const uz = v[2] as number;

      // Skin friction on the tangential velocity.
      const normalSpeed = ux * nx + uy * ny + uz * nz;
      const tx = ux - normalSpeed * nx;
      const ty = uy - normalSpeed * ny;
      const tz = uz - normalSpeed * nz;
      const tangentialSpeed = Math.hypot(tx, ty, tz);
      const friction = -frictionFactor * area * tangentialSpeed;
      const ffx = friction * tx;
      const ffy = friction * ty;
      const ffz = friction * tz;

      // Pressure damping on the normal velocity, without the forward speed of the ship.
      const dampedNormal = normalSpeed - excludedSurge * (fx * nx + fy * ny + fz * nz);
      const pressure =
        -(k.linearPanelDamping * dampedNormal + 0.5 * rho * k.panelDragCoefficient * Math.abs(dampedNormal) * dampedNormal) * area;
      const pfx = pressure * nx;
      const pfy = pressure * ny;
      const pfz = pressure * nz;

      body.addForceAtPoint(ffx + pfx, ffy + pfy, ffz + pfz, px, py, pz);
      this.panelForces[3 * i] = ffx + pfx;
      this.panelForces[3 * i + 1] = ffy + pfy;
      this.panelForces[3 * i + 2] = ffz + pfz;
      totals.friction[0] = (totals.friction[0] as number) + ffx;
      totals.friction[1] = (totals.friction[1] as number) + ffy;
      totals.friction[2] = (totals.friction[2] as number) + ffz;
      totals.pressure[0] = (totals.pressure[0] as number) + pfx;
      totals.pressure[1] = (totals.pressure[1] as number) + pfy;
      totals.pressure[2] = (totals.pressure[2] as number) + pfz;
    }

    // Roll damping about the longitudinal axis (only while the hull is wet).
    if (submerged.count > 0) {
      const p =
        (body.angularVelocity[0] as number) * fx +
        (body.angularVelocity[1] as number) * fy +
        (body.angularVelocity[2] as number) * fz;
      const moment = -(k.rollLinearDamping * p + k.rollQuadraticDamping * Math.abs(p) * p);
      body.addTorque(moment * fx, moment * fy, moment * fz);
      totals.rollMomentNm = moment;
    } else {
      totals.rollMomentNm = 0;
    }
  }
}
