/**
 * Launch options from the URL query string, for reproducible test setups:
 *   ?wind=6&dir=45&seed=1&quality=high&paused=1
 *
 * - wind:    Beaufort number, 0..12 (fractional values allowed)
 * - dir:     wind direction in degrees, meteorological convention (direction the
 *            wind blows FROM, clockwise from north); wrapped to [0, 360)
 * - seed:    unsigned 32-bit integer seeding the ocean's Gaussian noise
 * - quality: low | medium | high
 * - paused:  1/0 or true/false, start with the simulation paused
 *
 * Invalid values fall back to defaults and produce a warning.
 */

export type QualityPreset = 'low' | 'medium' | 'high';

export const QUALITY_PRESETS: readonly QualityPreset[] = ['low', 'medium', 'high'];

export const BEAUFORT_MIN = 0;
export const BEAUFORT_MAX = 12;
export const DEFAULT_SEED = 1;
export const DEFAULT_QUALITY: QualityPreset = 'medium';
const MAX_SEED = 0xffffffff;
const FULL_CIRCLE_DEG = 360;

export interface LaunchOptions {
  /** Beaufort number requested via `wind`, or null to use the application default. */
  readonly beaufort: number | null;
  /** Wind direction in degrees [0, 360), or null to use the application default. */
  readonly windDirectionDeg: number | null;
  readonly seed: number;
  readonly quality: QualityPreset;
  readonly paused: boolean;
}

export interface LaunchOptionsResult {
  readonly options: LaunchOptions;
  readonly warnings: readonly string[];
}

export function parseLaunchOptions(search: string): LaunchOptionsResult {
  const params = new URLSearchParams(search);
  const warnings: string[] = [];

  let beaufort: number | null = null;
  const windRaw = params.get('wind');
  if (windRaw !== null) {
    const value = parseFiniteNumber(windRaw);
    if (value === null) {
      warnings.push(`wind="${windRaw}" is not a number; using the default wind.`);
    } else {
      beaufort = Math.min(BEAUFORT_MAX, Math.max(BEAUFORT_MIN, value));
      if (beaufort !== value) {
        warnings.push(`wind=${value} is outside ${BEAUFORT_MIN}..${BEAUFORT_MAX}; clamped to ${beaufort}.`);
      }
    }
  }

  let windDirectionDeg: number | null = null;
  const dirRaw = params.get('dir');
  if (dirRaw !== null) {
    const value = parseFiniteNumber(dirRaw);
    if (value === null) {
      warnings.push(`dir="${dirRaw}" is not a number; using the default direction.`);
    } else {
      windDirectionDeg = ((value % FULL_CIRCLE_DEG) + FULL_CIRCLE_DEG) % FULL_CIRCLE_DEG;
    }
  }

  let seed = DEFAULT_SEED;
  const seedRaw = params.get('seed');
  if (seedRaw !== null) {
    const value = parseFiniteNumber(seedRaw);
    if (value === null || !Number.isInteger(value) || value < 0 || value > MAX_SEED) {
      warnings.push(`seed="${seedRaw}" must be an integer in 0..${MAX_SEED}; using ${DEFAULT_SEED}.`);
    } else {
      seed = value;
    }
  }

  let quality = DEFAULT_QUALITY;
  const qualityRaw = params.get('quality');
  if (qualityRaw !== null) {
    const normalised = qualityRaw.trim().toLowerCase();
    if (isQualityPreset(normalised)) {
      quality = normalised;
    } else {
      warnings.push(
        `quality="${qualityRaw}" must be one of ${QUALITY_PRESETS.join('/')}; using ${DEFAULT_QUALITY}.`,
      );
    }
  }

  let paused = false;
  const pausedRaw = params.get('paused');
  if (pausedRaw !== null) {
    const flag = parseBooleanFlag(pausedRaw);
    if (flag === null) {
      warnings.push(`paused="${pausedRaw}" must be 1/0 or true/false; ignoring.`);
    } else {
      paused = flag;
    }
  }

  return { options: { beaufort, windDirectionDeg, seed, quality, paused }, warnings };
}

function parseFiniteNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function parseBooleanFlag(raw: string): boolean | null {
  switch (raw.trim().toLowerCase()) {
    case '':
    case '1':
    case 'true':
    case 'yes':
      return true;
    case '0':
    case 'false':
    case 'no':
      return false;
    default:
      return null;
  }
}

function isQualityPreset(value: string): value is QualityPreset {
  return (QUALITY_PRESETS as readonly string[]).includes(value);
}
