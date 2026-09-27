/**
 * The vessel: static model (hull meshes, hydrostatics, mass properties,
 * calibrated damping) and the simulated rigid body with its force model.
 */
import { GRAVITY_M_S2, SEA_WATER_DENSITY_KG_M3 } from '../core/constants';
import { BuoyancySolver } from './buoyancy';
import { buildHullMesh, type HullMesh } from './hull';
import { HydrodynamicModel, type HydrodynamicCoefficients } from './hydrodynamics';
import { computeHydrostatics, fitSectionExponent, type Hydrostatics } from './hydrostatics';
import { RigidBody, multiplyQuaternions, quaternionFromAxisAngle } from './rigidBody';
import { Helm } from './helm';
import { Propulsion, calibratePropeller, type PropellerCalibration } from './propulsion';
import type { ShipConfig } from './shipConfig';
import type { WaterHeightProvider } from './waterHeightProvider';

export interface ShipModel {
  readonly config: ShipConfig;
  /** Section exponent fitted so that the hull displaces the vessel's mass at the design draft. */
  readonly sectionExponent: number;
  /** Closed low-poly physics hull in the hull frame. */
  readonly physicsMesh: HullMesh;
  /** Physics hull vertices relative to the centre of gravity (body frame). */
  readonly bodyVertices: Float64Array;
  readonly hydrostatics: Hydrostatics;
  /** Centre of gravity in the hull frame. */
  readonly centreOfGravity: [number, number, number];
  /** Principal moments of inertia about body X (roll), Y (yaw), Z (pitch), incl. added roll inertia. */
  readonly inertia: [number, number, number];
  readonly coefficients: HydrodynamicCoefficients;
  /** Undamped natural roll period estimate 2 pi sqrt(I44 / C44) (s). */
  readonly naturalRollPeriodS: number;
  /** Undamped natural heave period estimate 2 pi sqrt(m / (rho g A_wp)) (s). */
  readonly naturalHeavePeriodS: number;
  readonly propeller: PropellerCalibration;
}

export function buildShipModel(config: ShipConfig): ShipModel {
  const { hull: form, mass, hydrodynamics } = config;
  const rho = SEA_WATER_DENSITY_KG_M3;
  const g = GRAVITY_M_S2;
  const sectionExponent = fitSectionExponent(form, mass.massKg, form.physicsStations, form.physicsPointsPerSide);
  const physicsMesh = buildHullMesh(form, form.physicsStations, form.physicsPointsPerSide, sectionExponent);
  const hydrostatics = computeHydrostatics(physicsMesh, form);

  // G lies above B by BM - GM, on the vertical through B (even keel, upright).
  const [bx, by] = hydrostatics.centreOfBuoyancy;
  const centreOfGravity: [number, number, number] = [
    bx,
    by + hydrostatics.metacentricRadiusM - mass.metacentricHeightM,
    0,
  ];
  const bodyVertices = new Float64Array(physicsMesh.positions.length);
  for (let i = 0; i < bodyVertices.length; i++) {
    bodyVertices[i] = (physicsMesh.positions[i] as number) - (centreOfGravity[i % 3] as number);
  }

  const m = mass.massKg;
  const rollGyration = mass.rollGyrationPerBeam * form.beamM;
  const rollInertia = m * rollGyration * rollGyration * (1 + mass.addedRollInertiaFraction);
  const yawInertia = m * (mass.yawGyrationPerLength * form.lengthM) ** 2;
  const pitchInertia = m * (mass.pitchGyrationPerLength * form.lengthM) ** 2;
  const inertia: [number, number, number] = [rollInertia, yawInertia, pitchInertia];

  // Calibrate the linear panel damping so that heave has the configured damping ratio.
  const heaveStiffness = rho * g * hydrostatics.waterplaneAreaM2;
  const heaveDamping = 2 * hydrodynamics.heaveDampingRatio * Math.sqrt(heaveStiffness * m);
  const probe = new BuoyancySolver(physicsMesh.positions, physicsMesh.indices);
  probe.apply(new RigidBody(1, [1, 1, 1]), { heightAt: () => 0 }, 0);
  let verticalProjection = 0;
  let wettedAreaM2 = 0;
  for (let i = 0; i < probe.submerged.count; i++) {
    const ny = probe.submerged.normals[3 * i + 1] as number;
    verticalProjection += (probe.submerged.areas[i] as number) * ny * ny;
    wettedAreaM2 += probe.submerged.areas[i] as number;
  }
  const rollStiffness = rho * g * hydrostatics.volumeM3 * mass.metacentricHeightM;
  const coefficients: HydrodynamicCoefficients = {
    lengthM: form.lengthM,
    wettedAreaM2,
    residuaryCoefficient: hydrodynamics.residuaryResistanceCoefficient,
    residuaryOnsetFroude: hydrodynamics.residuaryOnsetFroude,
    residuaryFullFroude: hydrodynamics.residuaryFullFroude,
    linearPanelDamping: heaveDamping / verticalProjection,
    panelDragCoefficient: hydrodynamics.panelNormalDragCoefficient,
    formFactor: hydrodynamics.formFactor,
    rollLinearDamping: 2 * hydrodynamics.rollDampingRatio * Math.sqrt(rollInertia * rollStiffness),
    rollQuadraticDamping: hydrodynamics.rollQuadraticDampingNms2,
  };

  return {
    config,
    sectionExponent,
    physicsMesh,
    bodyVertices,
    hydrostatics,
    centreOfGravity,
    inertia,
    coefficients,
    naturalRollPeriodS: 2 * Math.PI * Math.sqrt(rollInertia / rollStiffness),
    naturalHeavePeriodS: 2 * Math.PI * Math.sqrt(m / heaveStiffness),
    propeller: calibratePropeller(config.propulsion, config.maxSpeedKnots, coefficients),
  };
}

export interface ShipPlacement {
  /** World XZ of the hull origin (midship, design waterline). */
  readonly x: number;
  readonly z: number;
  /** Heading, clockwise from north (-Z) (rad). */
  readonly headingRad: number;
  /** Initial heel to starboard (rad) and trim bow-up (rad). */
  readonly rollRad?: number;
  readonly pitchRad?: number;
  /** Initial height of the hull origin above sea level (m). */
  readonly heaveM?: number;
}

export class Ship {
  readonly body: RigidBody;
  readonly buoyancy: BuoyancySolver;
  readonly hydrodynamics: HydrodynamicModel;
  readonly propulsion: Propulsion;
  /** Current helm orders (throttle lever and ordered rudder angle). */
  readonly helm: Helm;
  private readonly scratch = new Float64Array(3);
  private readonly axis = new Float64Array(3);

  constructor(
    readonly model: ShipModel,
    placement: ShipPlacement,
  ) {
    this.body = new RigidBody(model.config.mass.massKg, model.inertia);
    this.buoyancy = new BuoyancySolver(model.bodyVertices, model.physicsMesh.indices);
    this.hydrodynamics = new HydrodynamicModel(model.coefficients, this.buoyancy.submerged.capacity);
    this.helm = new Helm(model.config.propulsion, model.config.rudder);
    this.propulsion = new Propulsion(
      model.config.propulsion,
      model.config.rudder,
      model.propeller,
      model.centreOfGravity,
    );
    this.place(placement);
  }

  /** Puts the ship at rest in the given pose. */
  place(placement: ShipPlacement): void {
    const body = this.body;
    // Heading psi (clockwise from north): body +X maps to (sin psi, 0, -cos psi),
    // a rotation about +Y by (pi/2 - psi). Then trim about body Z and heel about body X.
    const yaw = quaternionFromAxisAngle(0, 1, 0, Math.PI / 2 - placement.headingRad);
    const pitch = quaternionFromAxisAngle(0, 0, 1, placement.pitchRad ?? 0);
    const roll = quaternionFromAxisAngle(1, 0, 0, placement.rollRad ?? 0);
    body.orientation.set(multiplyQuaternions(multiplyQuaternions(yaw, pitch), roll));
    const cog = body.rotateToWorld(this.model.centreOfGravity, this.scratch);
    body.position[0] = placement.x + (cog[0] as number);
    body.position[1] = (placement.heaveM ?? 0) + (cog[1] as number);
    body.position[2] = placement.z + (cog[2] as number);
    body.velocity.fill(0);
    body.angularVelocity.fill(0);
  }

  /** Sets the forward speed (m/s) along the current heading, e.g. to start a test under way. */
  setForwardSpeed(speedMs: number): void {
    const forward = this.body.rotateToWorld([1, 0, 0], this.axis);
    for (let i = 0; i < 3; i++) this.body.velocity[i] = speedMs * (forward[i] as number);
  }

  /** Advances the simulation by one fixed step. */
  step(dt: number, water: WaterHeightProvider, timeS: number): void {
    const body = this.body;
    body.clearForces();
    body.addForce(0, -body.mass * GRAVITY_M_S2, 0);
    this.buoyancy.apply(body, water, timeS);
    this.hydrodynamics.apply(body, this.buoyancy.submerged);
    this.propulsion.apply(body, this.helm, water, timeS, dt);
    body.integrate(dt);
  }

  /** Heel angle, positive with the starboard side down (rad). */
  get rollRad(): number {
    const starboard = this.body.rotateToWorld([0, 0, 1], this.axis);
    return Math.asin(Math.max(-1, Math.min(1, -(starboard[1] as number))));
  }

  /** Trim angle, positive bow up (rad). */
  get pitchRad(): number {
    const forward = this.body.rotateToWorld([1, 0, 0], this.axis);
    return Math.asin(Math.max(-1, Math.min(1, forward[1] as number)));
  }

  /** Heading, clockwise from north (rad, [0, 2 pi)). */
  get headingRad(): number {
    const forward = this.body.rotateToWorld([1, 0, 0], this.axis);
    const heading = Math.atan2(forward[0] as number, -(forward[2] as number));
    return heading < 0 ? heading + 2 * Math.PI : heading;
  }

  /** Depth of the midship keel below mean sea level (m). */
  get draftM(): number {
    const keel = this.hullPointToWorld(0, -this.model.config.hull.designDraftM, 0, this.scratch);
    return -(keel[1] as number);
  }

  /** World position of a point given in the hull frame. */
  hullPointToWorld(x: number, y: number, z: number, out: Float64Array): Float64Array {
    const cog = this.model.centreOfGravity;
    out[0] = x - cog[0];
    out[1] = y - cog[1];
    out[2] = z - cog[2];
    return this.body.pointToWorld(out, out);
  }

  /** Speed through the water along the ship's axis (m/s, negative astern). */
  get surgeSpeedMs(): number {
    const forward = this.body.rotateToWorld([1, 0, 0], this.axis);
    const v = this.body.velocity;
    return (v[0] as number) * (forward[0] as number) + (v[1] as number) * (forward[1] as number) + (v[2] as number) * (forward[2] as number);
  }

  /** Speed over ground (m/s). */
  get speedMs(): number {
    const v = this.body.velocity;
    return Math.hypot(v[0] as number, v[2] as number);
  }
}
