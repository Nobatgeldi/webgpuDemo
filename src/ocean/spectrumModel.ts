/**
 * Wind-sea spectrum: JONSWAP frequency spectrum with Donelan-Banner directional
 * spreading, deep-water dispersion and a fetch limit tied to Pierson-Moskowitz
 * saturation. This is the CPU reference of the GPU spectrum shader (both use
 * the constants in {@link SPECTRUM_SHADER_CONSTANTS}) and the source of the
 * significant wave height shown in the HUD.
 *
 * Conventions: omega is angular frequency (rad/s), k wavenumber (rad/m), U the
 * 10 m wind speed (m/s), F the fetch (m), chi = gF/U^2 the dimensionless fetch.
 */
import { GRAVITY_M_S2 } from '../core/constants';

// --- JONSWAP (Hasselmann et al. 1973) -------------------------------------
export const JONSWAP_DEFAULT_GAMMA = 3.3;
const JONSWAP_ALPHA_COEFFICIENT = 0.076;
const JONSWAP_ALPHA_EXPONENT = -0.22;
/** omega_p = 22 (g/U) chi^-0.33, i.e. f_p = 3.5 (g/U) chi^-0.33. */
const JONSWAP_PEAK_COEFFICIENT = 22;
const JONSWAP_PEAK_EXPONENT = -0.33;
const JONSWAP_SIGMA_BELOW_PEAK = 0.07;
const JONSWAP_SIGMA_ABOVE_PEAK = 0.09;
/** Shape exponent 5/4 of the Pierson-Moskowitz low-frequency cut-off. */
const PM_SHAPE_COEFFICIENT = 1.25;
/** Beyond exp(-this) the spectral density is treated as zero (also avoids 0 * inf). */
const SPECTRUM_EXPONENT_CUTOFF = 60;

// --- Pierson-Moskowitz saturation -----------------------------------------
/** Fully developed sea: Hs = 0.21 U_19.5^2 / g (Pierson & Moskowitz 1964). */
const PM_HS_COEFFICIENT = 0.21;
/** Ratio of the wind speed at 19.5 m to that at 10 m (neutral log profile). */
const U19_5_OVER_U10 = 1.026;

// --- Donelan, Hamilton & Hui (1985) / Banner (1990) spreading -------------
const DB_LOW_RATIO = 0.56;
const DB_PEAK_RATIO = 0.95;
const DB_HIGH_RATIO = 1.6;
const DB_LOW_COEFFICIENT = 2.61;
const DB_MID_COEFFICIENT = 2.28;
const DB_POWER = 1.3;
const DB_BANNER_OFFSET = -0.4;
const DB_BANNER_SCALE = 0.8393;
const DB_BANNER_DECAY = -0.567;

// --- Suppression of energy travelling against the wind ---------------------
/** Fraction of the spreading function kept for components moving against the wind. */
export const BACKWARD_ENERGY_FRACTION = 0.05;
/** Half-width (in cos(theta)) of the smooth transition around +-90 degrees. */
const BACKWARD_TAPER_COS = 0.1;

/** Below this wind speed the sea is treated as calm (zero spectrum, no division by U). */
export const CALM_WIND_SPEED_MS = 0.05;

export interface SeaStateInput {
  /** Wind speed at 10 m (m/s). */
  readonly windSpeedMs: number;
  /** Fetch (m). */
  readonly fetchM: number;
  readonly gamma?: number;
}

export interface JonswapParameters {
  readonly windSpeedMs: number;
  readonly fetchM: number;
  /** Fetch after limiting to the fully developed sea (m). */
  readonly effectiveFetchM: number;
  /** Dimensionless fetch g F_eff / U^2. */
  readonly dimensionlessFetch: number;
  /** Phillips constant; 0 for a calm sea. */
  readonly alpha: number;
  /** Peak angular frequency (rad/s); 0 for a calm sea. */
  readonly peakOmega: number;
  readonly gamma: number;
  readonly calm: boolean;
}

/** JONSWAP shape integral: m0 = alpha g^2 omega_p^-4 * shapeIntegral(gamma). */
function jonswapShapeIntegral(gamma: number): number {
  // Integrate x^-5 exp(-1.25 x^-4) gamma^r(x) over x = omega/omega_p in log space.
  const xMin = 0.25;
  const xMax = 40;
  const steps = 4000; // even, for Simpson's rule
  const logMin = Math.log(xMin);
  const h = (Math.log(xMax) - logMin) / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const x = Math.exp(logMin + i * h);
    const f = jonswapShape(x, gamma) * x; // dx = x d(ln x)
    const weight = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2;
    sum += weight * f;
  }
  return (sum * h) / 3;
}

/** Dimensionless JONSWAP shape in terms of x = omega / omega_p. */
function jonswapShape(x: number, gamma: number): number {
  const exponent = PM_SHAPE_COEFFICIENT / (x * x * x * x);
  if (exponent > SPECTRUM_EXPONENT_CUTOFF) {
    return 0;
  }
  const sigma = x <= 1 ? JONSWAP_SIGMA_BELOW_PEAK : JONSWAP_SIGMA_ABOVE_PEAK;
  const d = (x - 1) / sigma;
  return Math.pow(x, -5) * Math.exp(-exponent) * Math.pow(gamma, Math.exp(-0.5 * d * d));
}

/**
 * Dimensionless fetch at which the JONSWAP energy reaches the fully developed
 * Pierson-Moskowitz energy. Since m0 is proportional to chi^(-0.22 + 4 * 0.33),
 * the crossover follows in closed form from the shape integral (~1.2e4 for gamma = 3.3).
 */
export function saturationDimensionlessFetch(gamma: number): number {
  // With U = g = 1: m0_PM = (Hs / 4)^2 and m0_J(chi) = 0.076 * 22^-4 * I(gamma) * chi^1.10.
  const hsPm = PM_HS_COEFFICIENT * U19_5_OVER_U10 * U19_5_OVER_U10;
  const m0Pm = (hsPm / 4) ** 2;
  const m0JonswapAtUnitFetch =
    (JONSWAP_ALPHA_COEFFICIENT / Math.pow(JONSWAP_PEAK_COEFFICIENT, 4)) *
    jonswapShapeIntegral(gamma);
  const growthExponent = JONSWAP_ALPHA_EXPONENT - 4 * JONSWAP_PEAK_EXPONENT;
  return Math.pow(m0Pm / m0JonswapAtUnitFetch, 1 / growthExponent);
}

const saturationCache = new Map<number, number>();
const shapeIntegralCache = new Map<number, number>();

function cached(cache: Map<number, number>, key: number, compute: (k: number) => number): number {
  let value = cache.get(key);
  if (value === undefined) {
    value = compute(key);
    cache.set(key, value);
  }
  return value;
}

export function jonswapParameters(input: SeaStateInput): JonswapParameters {
  const gamma = input.gamma ?? JONSWAP_DEFAULT_GAMMA;
  const windSpeedMs = Math.max(0, input.windSpeedMs);
  const fetchM = Math.max(0, input.fetchM);
  if (windSpeedMs < CALM_WIND_SPEED_MS || fetchM <= 0) {
    return {
      windSpeedMs,
      fetchM,
      effectiveFetchM: 0,
      dimensionlessFetch: 0,
      alpha: 0,
      peakOmega: 0,
      gamma,
      calm: true,
    };
  }
  const g = GRAVITY_M_S2;
  const chiSaturated = cached(saturationCache, gamma, saturationDimensionlessFetch);
  const chi = Math.min((g * fetchM) / (windSpeedMs * windSpeedMs), chiSaturated);
  return {
    windSpeedMs,
    fetchM,
    effectiveFetchM: (chi * windSpeedMs * windSpeedMs) / g,
    dimensionlessFetch: chi,
    alpha: JONSWAP_ALPHA_COEFFICIENT * Math.pow(chi, JONSWAP_ALPHA_EXPONENT),
    peakOmega: JONSWAP_PEAK_COEFFICIENT * (g / windSpeedMs) * Math.pow(chi, JONSWAP_PEAK_EXPONENT),
    gamma,
    calm: false,
  };
}

/** One-sided frequency spectrum S(omega) (m^2 s / rad). */
export function jonswapSpectrum(omega: number, p: JonswapParameters): number {
  if (p.calm || omega <= 0) {
    return 0;
  }
  const x = omega / p.peakOmega;
  const g = GRAVITY_M_S2;
  // alpha g^2 omega^-5 ... = alpha g^2 omega_p^-5 * shape(x)
  return (p.alpha * g * g * jonswapShape(x, p.gamma)) / Math.pow(p.peakOmega, 5);
}

/** Donelan-Banner spreading parameter beta as a function of omega / omega_p. */
export function donelanBannerBeta(frequencyRatio: number): number {
  const r = Math.max(frequencyRatio, DB_LOW_RATIO);
  if (r < DB_PEAK_RATIO) {
    return DB_LOW_COEFFICIENT * Math.pow(r, DB_POWER);
  }
  if (r < DB_HIGH_RATIO) {
    return DB_MID_COEFFICIENT * Math.pow(r, -DB_POWER);
  }
  return Math.pow(10, DB_BANNER_OFFSET + DB_BANNER_SCALE * Math.exp(DB_BANNER_DECAY * Math.log(r * r)));
}

/**
 * Directional spreading D(theta) normalised over [-pi, pi], where theta is the
 * angle to the wave propagation (downwind) direction.
 */
export function donelanBannerSpreading(frequencyRatio: number, theta: number): number {
  const beta = donelanBannerBeta(frequencyRatio);
  const sech = 1 / Math.cosh(beta * theta);
  return (beta / (2 * Math.tanh(beta * Math.PI))) * sech * sech;
}

/** Weight suppressing components that travel against the wind (cosTheta < 0). */
export function backwardSuppression(cosTheta: number): number {
  const t = Math.min(1, Math.max(0, (cosTheta + BACKWARD_TAPER_COS) / (2 * BACKWARD_TAPER_COS)));
  const smooth = t * t * (3 - 2 * t);
  return BACKWARD_ENERGY_FRACTION + (1 - BACKWARD_ENERGY_FRACTION) * smooth;
}

/**
 * Wavenumber spectrum S(kx, kz) (m^4) such that the height variance is the
 * integral of S over the wavenumber plane. `windX/windZ` is the unit vector
 * of wave propagation (the direction the wind blows towards).
 */
export function wavenumberSpectrum(
  kx: number,
  kz: number,
  windX: number,
  windZ: number,
  p: JonswapParameters,
): number {
  const k = Math.hypot(kx, kz);
  if (k === 0 || p.calm) {
    return 0;
  }
  const g = GRAVITY_M_S2;
  const omega = Math.sqrt(g * k);
  const cosTheta = Math.min(1, Math.max(-1, (kx * windX + kz * windZ) / k));
  const theta = Math.acos(cosTheta);
  const spreading = donelanBannerSpreading(omega / p.peakOmega, theta) * backwardSuppression(cosTheta);
  // S(k) d^2k = S(omega) D(theta) d(omega) d(theta), with d^2k = k dk dtheta and d(omega)/dk = g / (2 omega).
  return (jonswapSpectrum(omega, p) * spreading * g) / (2 * omega * k);
}

/** Zeroth moment of S(omega) between two angular frequencies (m^2). */
export function spectralMoment0(p: JonswapParameters, omegaMin = 0, omegaMax = Number.POSITIVE_INFINITY): number {
  if (p.calm) {
    return 0;
  }
  const g = GRAVITY_M_S2;
  // Integrate the dimensionless shape over x in log space; the tails beyond are negligible.
  const xMin = Math.max(omegaMin / p.peakOmega, 0.25);
  const xMax = Math.min(omegaMax / p.peakOmega, 200);
  if (!(xMax > xMin)) {
    return 0;
  }
  const steps = 2000;
  const logMin = Math.log(xMin);
  const h = (Math.log(xMax) - logMin) / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const x = Math.exp(logMin + i * h);
    const weight = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2;
    sum += weight * jonswapShape(x, p.gamma) * x;
  }
  const shapeIntegral = (sum * h) / 3;
  return (p.alpha * g * g * shapeIntegral) / Math.pow(p.peakOmega, 4);
}

/** Significant wave height Hs = 4 sqrt(m0) (m). */
export function significantWaveHeight(p: JonswapParameters, omegaMin = 0, omegaMax = Number.POSITIVE_INFINITY): number {
  return 4 * Math.sqrt(spectralMoment0(p, omegaMin, omegaMax));
}

/** Significant wave height of the components with wavenumber in [kMin, kMax). */
export function bandSignificantWaveHeight(p: JonswapParameters, kMin: number, kMax: number): number {
  const g = GRAVITY_M_S2;
  return significantWaveHeight(p, Math.sqrt(g * kMin), Math.sqrt(g * kMax));
}

/** Peak wavelength 2 pi g / omega_p^2 (m); 0 for a calm sea. */
export function peakWavelength(p: JonswapParameters): number {
  return p.calm ? 0 : (2 * Math.PI * GRAVITY_M_S2) / (p.peakOmega * p.peakOmega);
}

// --- Surface slopes --------------------------------------------------------
/** Cox & Munk (1954) clean-surface total slope variance: a + b U (U in m/s). */
const COX_MUNK_OFFSET = 0.003;
const COX_MUNK_PER_WIND = 5.12e-3;

/** Measured total (upwind + crosswind) mean-square slope of the sea surface. */
export function coxMunkSlopeVariance(windSpeedMs: number): number {
  return COX_MUNK_OFFSET + COX_MUNK_PER_WIND * Math.max(0, windSpeedMs);
}

/**
 * Total mean-square slope of the model spectrum for wavenumbers below `kMax`:
 * integral of k^2 S(k) = integral of (omega^4 / g^2) S(omega) d(omega).
 */
export function resolvedSlopeVariance(p: JonswapParameters, kMax: number): number {
  if (p.calm || !(kMax > 0)) {
    return 0;
  }
  // With omega = x omega_p the integrand becomes alpha x^4 shape(x) dx.
  const xMax = Math.sqrt(GRAVITY_M_S2 * kMax) / p.peakOmega;
  const xMin = 0.25;
  if (!(xMax > xMin)) {
    return 0;
  }
  const steps = 1000;
  const logMin = Math.log(xMin);
  const h = (Math.log(xMax) - logMin) / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const x = Math.exp(logMin + i * h);
    const weight = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2;
    sum += weight * x ** 4 * jonswapShape(x, p.gamma) * x;
  }
  return (p.alpha * sum * h) / 3;
}

/**
 * Slope variance that a surface filtered to wavenumbers below `kCut` misses
 * compared with the measured Cox-Munk total. The renderer turns it into extra
 * GGX roughness, so distant (mip-filtered) water keeps the right glint width
 * instead of aliasing. `kRenderedMax` is the highest wavenumber the textures
 * contain at all.
 */
export function unresolvedSlopeVariance(p: JonswapParameters, kCut: number, kRenderedMax: number): number {
  const total = coxMunkSlopeVariance(p.windSpeedMs);
  return Math.max(0, total - resolvedSlopeVariance(p, Math.min(kCut, kRenderedMax)));
}

// --- Whitecaps -----------------------------------------------------------------
const MONAHAN_COEFFICIENT = 3.84e-6;
const MONAHAN_EXPONENT = 3.41;

/** Whitecap coverage fraction (Monahan & O'Muircheartaigh 1980), capped at 1. */
export function whitecapCoverage(windSpeedMs: number): number {
  return Math.min(1, MONAHAN_COEFFICIENT * Math.pow(Math.max(0, windSpeedMs), MONAHAN_EXPONENT));
}

/**
 * Inverse of the standard normal CDF (Acklam's rational approximation,
 * relative error < 1.2e-9). Used to place foam thresholds at a quantile of the
 * approximately Gaussian Jacobian distribution.
 */
export function inverseNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) {
    return p <= 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const poly = (coefficients: number[], x: number): number => coefficients.reduce((sum, k) => sum * x + k, 0);
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return poly(c, q) / (poly(d, q) * q + 1);
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -poly(c, q) / (poly(d, q) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (poly(a, r) * q) / (poly(b, r) * r + 1);
}

/** Exposes the shape integral for diagnostics and tests. */
export function jonswapEnhancement(gamma: number): number {
  // Ratio of the JONSWAP to the Pierson-Moskowitz (gamma = 1) shape integral.
  return cached(shapeIntegralCache, gamma, jonswapShapeIntegral) / cached(shapeIntegralCache, 1, jonswapShapeIntegral);
}

/**
 * WGSL `const` declarations generated from this module, so that the GPU
 * spectrum uses exactly the same coefficients as the tested CPU reference.
 */
export const SPECTRUM_SHADER_CONSTANTS: string = [
  ['PM_SHAPE_COEFFICIENT', PM_SHAPE_COEFFICIENT],
  ['SPECTRUM_EXPONENT_CUTOFF', SPECTRUM_EXPONENT_CUTOFF],
  ['JONSWAP_SIGMA_BELOW_PEAK', JONSWAP_SIGMA_BELOW_PEAK],
  ['JONSWAP_SIGMA_ABOVE_PEAK', JONSWAP_SIGMA_ABOVE_PEAK],
  ['DB_LOW_RATIO', DB_LOW_RATIO],
  ['DB_PEAK_RATIO', DB_PEAK_RATIO],
  ['DB_HIGH_RATIO', DB_HIGH_RATIO],
  ['DB_LOW_COEFFICIENT', DB_LOW_COEFFICIENT],
  ['DB_MID_COEFFICIENT', DB_MID_COEFFICIENT],
  ['DB_POWER', DB_POWER],
  ['DB_BANNER_OFFSET', DB_BANNER_OFFSET],
  ['DB_BANNER_SCALE', DB_BANNER_SCALE],
  ['DB_BANNER_DECAY', DB_BANNER_DECAY],
  ['BACKWARD_ENERGY_FRACTION', BACKWARD_ENERGY_FRACTION],
  ['BACKWARD_TAPER_COS', BACKWARD_TAPER_COS],
]
  .map(([name, value]) => `const ${name as string}: f32 = ${formatWgslFloat(value as number)};`)
  .join('\n');

function formatWgslFloat(value: number): string {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}
