/**
 * Parameters of the simulated vessel: a ~50 m patrol boat. Everything that
 * defines the hull form, mass properties and hydrodynamic calibration lives
 * here; the physics derives the rest (displaced volume, centre of gravity,
 * damping coefficients) from these values.
 */

const DEG_TO_RAD = Math.PI / 180;

export interface HullFormConfig {
  readonly lengthM: number;
  readonly beamM: number;
  /** Design draft at midship (m). */
  readonly designDraftM: number;
  /** Freeboard at midship: deck height above the design waterline (m). */
  readonly freeboardM: number;
  /** Extra deck height at the stem (sheer, m). */
  readonly bowSheerM: number;
  /** Transom half-breadth relative to the maximum. */
  readonly transomBreadthFraction: number;
  /** Waterline half-breadth forward of midship: (1 - xi^E)^S, xi = 0 midship, 1 stem. */
  readonly bowEntranceExponent: number;
  readonly bowEntranceShape: number;
  /** Fraction of the half-length (from midship) where the keel starts rising to the stem. */
  readonly forefootStartFraction: number;
  /** Draft at the stem relative to the design draft. */
  readonly stemDraftFraction: number;
  /** Deck half-breadth relative to the waterline half-breadth (flare). */
  readonly deckFlareFraction: number;
  /** Physics mesh resolution: stations along the hull and points per section side. */
  readonly physicsStations: number;
  readonly physicsPointsPerSide: number;
  /** Visual mesh resolution. */
  readonly visualStations: number;
  readonly visualPointsPerSide: number;
}

export interface MassConfig {
  /** Displacement (kg). */
  readonly massKg: number;
  /** Target metacentric height GM (m); sets the height of the centre of gravity. */
  readonly metacentricHeightM: number;
  /** Radii of gyration as fractions of beam (roll) and length (pitch, yaw). */
  readonly rollGyrationPerBeam: number;
  readonly pitchGyrationPerLength: number;
  readonly yawGyrationPerLength: number;
  /** Hydrodynamic added roll inertia relative to the dry roll inertia. */
  readonly addedRollInertiaFraction: number;
}

export interface HydrodynamicsConfig {
  /**
   * Target damping ratio of heave; the linear pressure damping of the hull
   * panels (radiation damping in reality) is calibrated to it.
   */
  readonly heaveDampingRatio: number;
  /** Additional linear roll damping ratio (bilge keels, hull viscous roll damping). */
  readonly rollDampingRatio: number;
  /** Quadratic roll damping moment coefficient (N m s^2), B2 in B1 p + B2 p|p|. */
  readonly rollQuadraticDampingNms2: number;
  /** Drag coefficient of hull panels moving along their normal (quadratic part). */
  readonly panelNormalDragCoefficient: number;
  /** ITTC form factor k in (1 + k) C_F. */
  readonly formFactor: number;
  /**
   * Residuary (mainly wave-making) resistance coefficient C_R, based on the
   * design wetted surface; it grows from zero at `residuaryOnsetFroude` to its
   * full value at `residuaryFullFroude` (the main hump of a fast displacement hull).
   */
  readonly residuaryResistanceCoefficient: number;
  readonly residuaryOnsetFroude: number;
  readonly residuaryFullFroude: number;
}

export interface PropulsionConfig {
  readonly propellerDiameterM: number;
  /** Propeller centre in the hull frame (m). */
  readonly propellerPosition: readonly [number, number, number];
  readonly maxRpm: number;
  /** First-order time constant of the shaft speed (s). */
  readonly rpmTimeConstantS: number;
  /** Throttle range: astern (negative) to full ahead. */
  readonly minThrottle: number;
  readonly maxThrottle: number;
  /** Taylor wake fraction: advance speed = (1 - w) ship speed. */
  readonly wakeFraction: number;
  /** Bollard-pull thrust relative to the resistance at the design (top) speed. */
  readonly bollardThrustRatio: number;
  /** Thrust going astern relative to ahead at the same |rpm|. */
  readonly asternEfficiency: number;
}

export interface RudderConfig {
  readonly areaM2: number;
  readonly aspectRatio: number;
  /** Rudder stock/centre of pressure in the hull frame (m). */
  readonly position: readonly [number, number, number];
  readonly maxAngleRad: number;
  /** Steering gear rate (rad/s). */
  readonly rateRadPerS: number;
  /** Angle of attack at which the rudder stalls (rad). */
  readonly stallAngleRad: number;
  /** Lift left after the stall, relative to the peak (at 90 degrees). */
  readonly postStallLiftFraction: number;
  /** Profile drag coefficient and Oswald efficiency for induced drag. */
  readonly profileDragCoefficient: number;
  readonly spanEfficiency: number;
  /** Share of the propeller slipstream speed-up that reaches the rudder. */
  readonly propwashFraction: number;
}

export interface ShipConfig {
  readonly name: string;
  readonly hull: HullFormConfig;
  readonly mass: MassConfig;
  readonly hydrodynamics: HydrodynamicsConfig;
  readonly propulsion: PropulsionConfig;
  readonly rudder: RudderConfig;
  /** Nominal top speed (knots); used by propulsion from phase 4. */
  readonly maxSpeedKnots: number;
}

export const PATROL_BOAT: ShipConfig = {
  name: 'Devriye gemisi (50 m)',
  hull: {
    lengthM: 50,
    beamM: 9,
    designDraftM: 2.5,
    freeboardM: 2.6,
    bowSheerM: 1.2,
    transomBreadthFraction: 0.85,
    bowEntranceExponent: 2,
    bowEntranceShape: 0.8,
    forefootStartFraction: 0.45,
    stemDraftFraction: 0.25,
    deckFlareFraction: 0.12,
    physicsStations: 20,
    physicsPointsPerSide: 6,
    visualStations: 60,
    visualPointsPerSide: 12,
  },
  mass: {
    massKg: 500_000,
    metacentricHeightM: 1.2,
    rollGyrationPerBeam: 0.38,
    pitchGyrationPerLength: 0.25,
    yawGyrationPerLength: 0.26,
    addedRollInertiaFraction: 0.2,
  },
  hydrodynamics: {
    heaveDampingRatio: 0.2,
    rollDampingRatio: 0.05,
    rollQuadraticDampingNms2: 2.0e6,
    panelNormalDragCoefficient: 1.0,
    formFactor: 0.1,
    residuaryResistanceCoefficient: 0.0068,
    residuaryOnsetFroude: 0.15,
    residuaryFullFroude: 0.5,
  },
  propulsion: {
    propellerDiameterM: 2.0,
    propellerPosition: [-22.0, -1.6, 0],
    maxRpm: 900,
    rpmTimeConstantS: 4,
    minThrottle: -0.5,
    maxThrottle: 1,
    wakeFraction: 0.1,
    bollardThrustRatio: 1.7,
    asternEfficiency: 0.6,
  },
  rudder: {
    areaM2: 2.8,
    aspectRatio: 1.5,
    position: [-24.2, -1.5, 0],
    maxAngleRad: 35 * DEG_TO_RAD,
    rateRadPerS: 5 * DEG_TO_RAD,
    stallAngleRad: 32 * DEG_TO_RAD,
    postStallLiftFraction: 0.55,
    profileDragCoefficient: 0.02,
    spanEfficiency: 0.9,
    propwashFraction: 0.5,
  },
  maxSpeedKnots: 22,
};

export const KNOTS_TO_MS = 1852 / 3600;
export { DEG_TO_RAD };
