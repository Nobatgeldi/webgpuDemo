/**
 * Phase-0 sky: an analytic gradient driven by the sun position.
 *
 * Direct sunlight is attenuated with a real air-mass formula and approximate
 * clear-sky optical depths, so the sun reddens and dims towards the horizon.
 * The sky dome itself is an artistic zenith/horizon gradient; it is replaced
 * by a physically based single-scattering atmosphere in phase 2.
 *
 * All radiance values are in relative HDR units (sky zenith at noon ~ 1).
 */

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Apparent angular radius of the sun (rad). */
export const SUN_ANGULAR_RADIUS_RAD = 0.2666 * DEG_TO_RAD;

/**
 * Clear-sky vertical optical depths at sea level for the R/G/B channels
 * (Rayleigh scattering at ~680/550/440 nm plus a small aerosol contribution).
 */
const RAYLEIGH_OPTICAL_DEPTH_RGB: readonly [number, number, number] = [0.036, 0.097, 0.235];
const AEROSOL_OPTICAL_DEPTH = 0.08;

/**
 * Sun disk radiance relative to the noon zenith sky radiance, above the
 * atmosphere. Real ratio is of order 1e5 (disk ~1.6e9 cd/m2, blue sky ~8e3
 * cd/m2); with the disk's solid angle this yields a direct/diffuse irradiance
 * ratio of ~4:1, typical for a clear day.
 */
const SUN_DISK_RELATIVE_RADIANCE = 2.0e5;
/** Forward-scattering halo around the sun (Henyey-Greenstein asymmetry and strength). */
const SUN_HALO_ASYMMETRY = 0.8;
/** Halo radiance per unit disk radiance and unit phase function value. */
const SUN_HALO_STRENGTH = 4.0e-6;

// Gradient key colours (linear sRGB, relative radiance).
const DAY_ZENITH: readonly [number, number, number] = [0.1, 0.24, 0.62];
const DAY_HORIZON: readonly [number, number, number] = [0.62, 0.72, 0.86];
const SUNSET_HORIZON: readonly [number, number, number] = [1.0, 0.5, 0.22];
const NIGHT_ZENITH: readonly [number, number, number] = [0.0015, 0.0025, 0.006];
const NIGHT_HORIZON: readonly [number, number, number] = [0.004, 0.006, 0.012];
/** Colour below the horizon relative to the horizon colour (dark haze until the ocean exists). */
const BELOW_HORIZON_FACTOR: readonly [number, number, number] = [0.18, 0.24, 0.32];

/** Elevation range (deg) over which the sky transitions from night to full day. */
const TWILIGHT_START_DEG = -8;
const FULL_DAY_DEG = 15;
/** Elevation (deg) below which the horizon turns into sunset colours. */
const SUNSET_END_DEG = 20;
/** Zenith dimming when the sun is low (sunset sky is darker overhead). */
const SUNSET_ZENITH_DIMMING = 0.45;

/** Kasten & Young (1989) air-mass formula coefficients. */
const KASTEN_YOUNG_A = 0.50572;
const KASTEN_YOUNG_B_DEG = 96.07995;
const KASTEN_YOUNG_C = 1.6364;
/** Air mass is evaluated at most at this zenith angle (sun on the horizon). */
const MAX_AIR_MASS_ZENITH_DEG = 90;

export type Rgb = [number, number, number];

export interface SkyState {
  /** Unit vector pointing towards the sun (world space, Y up, -Z north, +X east). */
  readonly sunDirection: [number, number, number];
  readonly sunAngularRadiusRad: number;
  /** Radiance of the sun disk after atmospheric extinction. */
  readonly sunDiskRadiance: Rgb;
  /** Irradiance of the direct beam on a surface facing the sun (disk radiance x solid angle). */
  readonly sunIrradiance: Rgb;
  /** Halo colour/strength and Henyey-Greenstein asymmetry. */
  readonly sunHalo: Rgb;
  readonly sunHaloAsymmetry: number;
  readonly zenith: Rgb;
  readonly horizon: Rgb;
  readonly belowHorizon: Rgb;
}

/**
 * Converts compass angles to a direction.
 * Azimuth is measured clockwise from north (-Z) towards east (+X).
 */
export function directionFromElevationAzimuth(
  elevationRad: number,
  azimuthRad: number,
): [number, number, number] {
  const cosElevation = Math.cos(elevationRad);
  return [
    cosElevation * Math.sin(azimuthRad),
    Math.sin(elevationRad),
    -cosElevation * Math.cos(azimuthRad),
  ];
}

/**
 * Relative optical air mass for a given solar elevation (Kasten & Young 1989).
 * 1 at the zenith, ~38 at the horizon.
 */
export function relativeAirMass(elevationRad: number): number {
  const zenithDeg = Math.min(90 - elevationRad * RAD_TO_DEG, MAX_AIR_MASS_ZENITH_DEG);
  const zenithRad = zenithDeg * DEG_TO_RAD;
  return 1 / (Math.cos(zenithRad) + KASTEN_YOUNG_A * Math.pow(KASTEN_YOUNG_B_DEG - zenithDeg, -KASTEN_YOUNG_C));
}

/** Direct-beam transmittance of the clear atmosphere per colour channel. */
export function sunTransmittance(elevationRad: number): Rgb {
  const airMass = relativeAirMass(elevationRad);
  return RAYLEIGH_OPTICAL_DEPTH_RGB.map((tau) =>
    Math.exp(-(tau + AEROSOL_OPTICAL_DEPTH) * airMass),
  ) as Rgb;
}

export function computeSkyState(sunElevationDeg: number, sunAzimuthDeg: number): SkyState {
  const elevationRad = sunElevationDeg * DEG_TO_RAD;
  const sunDirection = directionFromElevationAzimuth(elevationRad, sunAzimuthDeg * DEG_TO_RAD);

  const transmittance = sunTransmittance(elevationRad);
  // The disk sinks below the horizon over one angular diameter.
  const diskVisibility = smoothstep(
    -SUN_ANGULAR_RADIUS_RAD,
    SUN_ANGULAR_RADIUS_RAD,
    elevationRad,
  );
  const sunDiskRadiance = transmittance.map(
    (t) => t * SUN_DISK_RELATIVE_RADIANCE * diskVisibility,
  ) as Rgb;
  const sunSolidAngle = 2 * Math.PI * (1 - Math.cos(SUN_ANGULAR_RADIUS_RAD));
  const sunIrradiance = sunDiskRadiance.map((l) => l * sunSolidAngle) as Rgb;

  const dayAmount = smoothstep(TWILIGHT_START_DEG, FULL_DAY_DEG, sunElevationDeg);
  const sunsetAmount =
    (1 - smoothstep(0, SUNSET_END_DEG, sunElevationDeg)) *
    smoothstep(TWILIGHT_START_DEG, 0, sunElevationDeg);

  const zenith = mix3(NIGHT_ZENITH, DAY_ZENITH, dayAmount).map(
    (c) => c * (1 - SUNSET_ZENITH_DIMMING * sunsetAmount),
  ) as Rgb;
  const dayHorizon = mix3(DAY_HORIZON, SUNSET_HORIZON, sunsetAmount);
  const horizon = mix3(NIGHT_HORIZON, dayHorizon, Math.max(dayAmount, sunsetAmount));
  const belowHorizon = horizon.map((c, i) => c * (BELOW_HORIZON_FACTOR[i] as number)) as Rgb;

  const sunHalo = transmittance.map(
    (t) => t * SUN_HALO_STRENGTH * SUN_DISK_RELATIVE_RADIANCE * Math.max(dayAmount, sunsetAmount),
  ) as Rgb;

  return {
    sunDirection,
    sunAngularRadiusRad: SUN_ANGULAR_RADIUS_RAD,
    sunDiskRadiance,
    sunIrradiance,
    sunHalo,
    sunHaloAsymmetry: SUN_HALO_ASYMMETRY,
    zenith,
    horizon,
    belowHorizon,
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mix3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
