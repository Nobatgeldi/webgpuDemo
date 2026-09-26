/**
 * Beaufort wind scale (WMO) with the probable open-sea wave heights. This table
 * is the validation reference for the sea-state model (see tests/spectrum.test.ts).
 */

export interface BeaufortClass {
  readonly beaufort: number;
  /** Lower bound of the 10 m wind speed (m/s). */
  readonly minSpeedMs: number;
  /** Upper bound of the 10 m wind speed (m/s); Infinity for force 12. */
  readonly maxSpeedMs: number;
  /** Probable wave height in the open sea (m). */
  readonly probableWaveHeightM: number;
}

export const BEAUFORT_TABLE: readonly BeaufortClass[] = [
  { beaufort: 0, minSpeedMs: 0, maxSpeedMs: 0.2, probableWaveHeightM: 0 },
  { beaufort: 1, minSpeedMs: 0.3, maxSpeedMs: 1.5, probableWaveHeightM: 0.1 },
  { beaufort: 2, minSpeedMs: 1.6, maxSpeedMs: 3.3, probableWaveHeightM: 0.2 },
  { beaufort: 3, minSpeedMs: 3.4, maxSpeedMs: 5.4, probableWaveHeightM: 0.6 },
  { beaufort: 4, minSpeedMs: 5.5, maxSpeedMs: 7.9, probableWaveHeightM: 1.0 },
  { beaufort: 5, minSpeedMs: 8.0, maxSpeedMs: 10.7, probableWaveHeightM: 2.0 },
  { beaufort: 6, minSpeedMs: 10.8, maxSpeedMs: 13.8, probableWaveHeightM: 3.0 },
  { beaufort: 7, minSpeedMs: 13.9, maxSpeedMs: 17.1, probableWaveHeightM: 4.0 },
  { beaufort: 8, minSpeedMs: 17.2, maxSpeedMs: 20.7, probableWaveHeightM: 5.5 },
  { beaufort: 9, minSpeedMs: 20.8, maxSpeedMs: 24.4, probableWaveHeightM: 7.0 },
  { beaufort: 10, minSpeedMs: 24.5, maxSpeedMs: 28.4, probableWaveHeightM: 9.0 },
  { beaufort: 11, minSpeedMs: 28.5, maxSpeedMs: 32.6, probableWaveHeightM: 11.5 },
  { beaufort: 12, minSpeedMs: 32.7, maxSpeedMs: Number.POSITIVE_INFINITY, probableWaveHeightM: 14 },
];

export const MAX_BEAUFORT = 12;

/** WMO empirical relation v = 0.836 B^(3/2) m/s; lands mid-class for every integer B. */
const BEAUFORT_SPEED_COEFFICIENT = 0.836;
const BEAUFORT_SPEED_EXPONENT = 1.5;

/** Representative 10 m wind speed (m/s) for a (possibly fractional) Beaufort number. */
export function beaufortToWindSpeed(beaufort: number): number {
  const b = Math.min(MAX_BEAUFORT, Math.max(0, beaufort));
  return BEAUFORT_SPEED_COEFFICIENT * Math.pow(b, BEAUFORT_SPEED_EXPONENT);
}

/**
 * Beaufort class of a wind speed. The published bounds are rounded to 0.1 m/s,
 * so class boundaries are placed half-way between neighbouring bounds.
 */
export function windSpeedToBeaufort(speedMs: number): number {
  for (let i = 0; i < BEAUFORT_TABLE.length - 1; i++) {
    const current = BEAUFORT_TABLE[i] as BeaufortClass;
    const next = BEAUFORT_TABLE[i + 1] as BeaufortClass;
    if (speedMs < (current.maxSpeedMs + next.minSpeedMs) / 2) {
      return current.beaufort;
    }
  }
  return MAX_BEAUFORT;
}

/** Mid-range wind speed of an integer Beaufort class (force 12 uses the WMO relation). */
export function beaufortMidSpeed(beaufort: number): number {
  const entry = BEAUFORT_TABLE[beaufort];
  if (!entry) {
    throw new RangeError(`Beaufort ${beaufort} out of range`);
  }
  return Number.isFinite(entry.maxSpeedMs)
    ? (entry.minSpeedMs + entry.maxSpeedMs) / 2
    : beaufortToWindSpeed(beaufort);
}
