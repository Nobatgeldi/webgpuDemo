/**
 * Physical clear-sky atmosphere (Earth, after Bruneton 2017 / Hillaire 2020):
 * Rayleigh and Mie scattering with exponential density profiles and an ozone
 * absorption layer. This module is the CPU reference (direct sunlight for the
 * frame uniforms, tests) and the source of the constants that are generated
 * into the WGSL atmosphere shaders.
 *
 * Radiometric units are relative: the solar irradiance at the top of the
 * atmosphere is SUN_IRRADIANCE_TOA per colour channel; exposure maps the
 * result to the display.
 */

export type Rgb = [number, number, number];

const DEG_TO_RAD = Math.PI / 180;

export const GROUND_RADIUS_M = 6_360_000;
export const TOP_RADIUS_M = 6_460_000;
/** Altitude of the viewer used for the sky (sea level; camera heights are negligible). */
export const VIEWER_ALTITUDE_M = 1;

/** Rayleigh scattering coefficients at sea level (1/m) for ~680/550/440 nm. */
export const RAYLEIGH_SCATTERING: Rgb = [5.802e-6, 13.558e-6, 33.1e-6];
export const RAYLEIGH_SCALE_HEIGHT_M = 8000;
/** Mie (aerosol) scattering and extinction at sea level (1/m), clear maritime air. */
export const MIE_SCATTERING = 3.996e-6;
export const MIE_EXTINCTION = 4.4e-6;
export const MIE_SCALE_HEIGHT_M = 1200;
export const MIE_ASYMMETRY = 0.8;
/** Ozone absorption at peak density (1/m); tent profile centred at 25 km, 15 km half-width. */
export const OZONE_ABSORPTION: Rgb = [0.65e-6, 1.881e-6, 0.085e-6];
export const OZONE_CENTRE_ALTITUDE_M = 25_000;
export const OZONE_HALF_WIDTH_M = 15_000;

/**
 * Solar irradiance at the top of the atmosphere (relative units, the solar
 * spectrum's R/G/B ratio). Chosen so that the sun disk radiance (~5e4) stays
 * inside the half-float HDR range.
 */
export const SUN_IRRADIANCE_TOA: Rgb = [3.2, 4.0, 4.1];
/** Apparent angular radius of the sun (rad). */
export const SUN_ANGULAR_RADIUS_RAD = 0.2666 * DEG_TO_RAD;

/**
 * Approximation of higher-order scattering: an isotropic source equal to this
 * fraction of the single-scattering source (Hillaire's multiple-scattering LUT
 * adds roughly this much light on a clear day).
 */
export const MULTIPLE_SCATTERING_FACTOR = 0.35;

/**
 * Overcast sky (CIE standard overcast luminance distribution): fraction of the
 * clear-sky global irradiance that the cloud deck transmits as diffuse light.
 */
export const CLOUD_TRANSMITTANCE = 0.35;
/** Wind speeds (m/s) over which the sky turns from clear to overcast (Bf 6 ... Bf 10). */
export const OVERCAST_ONSET_WIND_MS = 12;
export const OVERCAST_FULL_WIND_MS = 26;
/** Largest cloud cover fraction reached in a storm. */
export const MAX_OVERCAST = 0.9;

const TRANSMITTANCE_STEPS = 64;

export interface Densities {
  readonly rayleigh: number;
  readonly mie: number;
  readonly ozone: number;
}

export function densitiesAt(altitudeM: number): Densities {
  const h = Math.max(0, altitudeM);
  return {
    rayleigh: Math.exp(-h / RAYLEIGH_SCALE_HEIGHT_M),
    mie: Math.exp(-h / MIE_SCALE_HEIGHT_M),
    ozone: Math.max(0, 1 - Math.abs(h - OZONE_CENTRE_ALTITUDE_M) / OZONE_HALF_WIDTH_M),
  };
}

/** Extinction coefficient (1/m) per channel at an altitude. */
export function extinctionAt(altitudeM: number): Rgb {
  const d = densitiesAt(altitudeM);
  return [0, 1, 2].map(
    (c) =>
      (RAYLEIGH_SCATTERING[c] as number) * d.rayleigh +
      MIE_EXTINCTION * d.mie +
      (OZONE_ABSORPTION[c] as number) * d.ozone,
  ) as Rgb;
}

/** Distance along a ray from radius r with direction cosine mu to a sphere of radius R (exit point). */
export function distanceToSphere(r: number, mu: number, radius: number): number {
  const discriminant = r * r * (mu * mu - 1) + radius * radius;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(0, discriminant)));
}

/** True if a ray from radius r with direction cosine mu hits the ground. */
export function rayHitsGround(r: number, mu: number): boolean {
  return mu < 0 && r * r * (mu * mu - 1) + GROUND_RADIUS_M * GROUND_RADIUS_M >= 0;
}

/** Transmittance from a point at `altitudeM` to the top of the atmosphere along cos(zenith) = mu. */
export function transmittanceToTop(altitudeM: number, mu: number): Rgb {
  const r = GROUND_RADIUS_M + altitudeM;
  if (rayHitsGround(r, mu)) {
    return [0, 0, 0];
  }
  const length = distanceToSphere(r, mu, TOP_RADIUS_M);
  const dt = length / TRANSMITTANCE_STEPS;
  const depth: Rgb = [0, 0, 0];
  for (let i = 0; i < TRANSMITTANCE_STEPS; i++) {
    const t = (i + 0.5) * dt;
    const radius = Math.sqrt(r * r + t * t + 2 * r * t * mu);
    const extinction = extinctionAt(radius - GROUND_RADIUS_M);
    for (let c = 0; c < 3; c++) depth[c] += (extinction[c] as number) * dt;
  }
  return depth.map((tau) => Math.exp(-tau)) as Rgb;
}

/** Vertical optical depth of the whole atmosphere from sea level (per channel). */
export function verticalOpticalDepth(): Rgb {
  return transmittanceToTop(0, 1).map((t) => -Math.log(t)) as Rgb;
}

/**
 * Cloud cover fraction from the wind: storms bring an overcast, darker sky.
 * Returns 0 when the effect is disabled.
 */
export function overcastFromWind(windSpeedMs: number, enabled: boolean): number {
  if (!enabled) {
    return 0;
  }
  const t = Math.min(1, Math.max(0, (windSpeedMs - OVERCAST_ONSET_WIND_MS) / (OVERCAST_FULL_WIND_MS - OVERCAST_ONSET_WIND_MS)));
  return MAX_OVERCAST * t * t * (3 - 2 * t);
}

/** Converts compass angles to a direction (azimuth clockwise from north = -Z, east = +X). */
export function directionFromElevationAzimuth(elevationRad: number, azimuthRad: number): [number, number, number] {
  const cosElevation = Math.cos(elevationRad);
  return [cosElevation * Math.sin(azimuthRad), Math.sin(elevationRad), -cosElevation * Math.cos(azimuthRad)];
}

export interface SunState {
  /** Unit vector towards the sun. */
  readonly direction: [number, number, number];
  readonly angularRadiusRad: number;
  /** Direct-beam irradiance at sea level on a surface facing the sun (after clouds). */
  readonly irradiance: Rgb;
  /** Radiance of the visible sun disk (after clouds). */
  readonly diskRadiance: Rgb;
  /** Cloud cover fraction used for the sky. */
  readonly overcast: number;
}

export function computeSunState(elevationDeg: number, azimuthDeg: number, overcast: number): SunState {
  const elevation = elevationDeg * DEG_TO_RAD;
  const direction = directionFromElevationAzimuth(elevation, azimuthDeg * DEG_TO_RAD);
  const transmittance = transmittanceToTop(VIEWER_ALTITUDE_M, Math.sin(elevation));
  const directFraction = 1 - overcast;
  const irradiance = transmittance.map(
    (t, c) => t * (SUN_IRRADIANCE_TOA[c] as number) * directFraction,
  ) as Rgb;
  const solidAngle = 2 * Math.PI * (1 - Math.cos(SUN_ANGULAR_RADIUS_RAD));
  const diskRadiance = irradiance.map((e) => e / solidAngle) as Rgb;
  return { direction, angularRadiusRad: SUN_ANGULAR_RADIUS_RAD, irradiance, diskRadiance, overcast };
}

/** WGSL constants generated from this module (prepended to the atmosphere shaders). */
export const ATMOSPHERE_SHADER_CONSTANTS: string = [
  wgslScalar('GROUND_RADIUS_M', GROUND_RADIUS_M),
  wgslScalar('TOP_RADIUS_M', TOP_RADIUS_M),
  wgslScalar('VIEWER_ALTITUDE_M', VIEWER_ALTITUDE_M),
  wgslVector('RAYLEIGH_SCATTERING', RAYLEIGH_SCATTERING),
  wgslScalar('RAYLEIGH_SCALE_HEIGHT_M', RAYLEIGH_SCALE_HEIGHT_M),
  wgslScalar('MIE_SCATTERING', MIE_SCATTERING),
  wgslScalar('MIE_EXTINCTION', MIE_EXTINCTION),
  wgslScalar('MIE_SCALE_HEIGHT_M', MIE_SCALE_HEIGHT_M),
  wgslScalar('MIE_ASYMMETRY', MIE_ASYMMETRY),
  wgslVector('OZONE_ABSORPTION', OZONE_ABSORPTION),
  wgslScalar('OZONE_CENTRE_ALTITUDE_M', OZONE_CENTRE_ALTITUDE_M),
  wgslScalar('OZONE_HALF_WIDTH_M', OZONE_HALF_WIDTH_M),
  wgslVector('SUN_IRRADIANCE_TOA', SUN_IRRADIANCE_TOA),
  wgslScalar('MULTIPLE_SCATTERING_FACTOR', MULTIPLE_SCATTERING_FACTOR),
  wgslScalar('CLOUD_TRANSMITTANCE', CLOUD_TRANSMITTANCE),
].join('\n');

export function formatWgslFloat(value: number): string {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

function wgslScalar(name: string, value: number): string {
  return `const ${name}: f32 = ${formatWgslFloat(value)};`;
}

function wgslVector(name: string, value: Rgb): string {
  return `const ${name}: vec3<f32> = vec3<f32>(${value.map(formatWgslFloat).join(', ')});`;
}
