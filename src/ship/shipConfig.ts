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
}

export interface ShipConfig {
  readonly name: string;
  readonly hull: HullFormConfig;
  readonly mass: MassConfig;
  readonly hydrodynamics: HydrodynamicsConfig;
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
  },
  maxSpeedKnots: 22,
};

export const KNOTS_TO_MS = 1852 / 3600;
export { DEG_TO_RAD };
