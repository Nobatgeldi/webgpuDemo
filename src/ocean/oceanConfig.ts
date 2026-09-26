import type { QualityPreset } from '../core/urlParams';

/**
 * Ocean configuration: cascade layout and per-quality resolution.
 *
 * Patch sizes are deliberately not integer multiples of each other so that the
 * repetition periods of the cascades do not line up. The largest patch has to
 * contain the peak wavelength of strong wind seas (~275 m at Bf 12 with 300 km
 * fetch, ~600 m with 1000 km), hence 1000 m rather than a few hundred metres.
 */
export const CASCADE_PATCH_SIZES_M: readonly number[] = [1000, 151.3, 23.7];

/**
 * Cascade c + 1 takes over at k = BAND_SPLIT_FACTOR * 2 pi / L_{c+1}: its
 * longest waves are then 1/6 of its patch, so its own repetition is hidden
 * under the larger waves of cascade c.
 */
export const BAND_SPLIT_FACTOR = 6;

/**
 * Wave frequencies are quantised to multiples of 2 pi / T so that the ocean is
 * exactly periodic in time; the phase can then be evaluated from t mod T in
 * float32 without precision loss after hours of simulation.
 */
export const OCEAN_TIME_LOOP_S = 4096;

/** Distance (m) to which the flat outer skirt extends the sea surface. */
export const OCEAN_SKIRT_DISTANCE_M = 80_000;

/** Maximum number of cascades supported by the shaders. */
export const MAX_CASCADES = 3;

export interface OceanQualityConfig {
  /** FFT resolution per cascade (power of two, <= 512). */
  readonly fftSize: number;
  readonly cascadeCount: number;
  /** Half the number of grid cells along one side of each clipmap level (even). */
  readonly meshHalfCells: number;
  readonly meshLevels: number;
  /** Vertex spacing of the finest level (m). */
  readonly meshBaseSpacingM: number;
}

export const OCEAN_QUALITY: Record<QualityPreset, OceanQualityConfig> = {
  low: { fftSize: 128, cascadeCount: 2, meshHalfCells: 32, meshLevels: 9, meshBaseSpacingM: 1.0 },
  medium: { fftSize: 256, cascadeCount: 3, meshHalfCells: 64, meshLevels: 9, meshBaseSpacingM: 0.5 },
  high: { fftSize: 512, cascadeCount: 3, meshHalfCells: 96, meshLevels: 9, meshBaseSpacingM: 0.4 },
};

export interface CascadeBand {
  readonly patchSizeM: number;
  /** Wavenumber band [kMin, kMax) handled by this cascade (rad/m). */
  readonly kMin: number;
  readonly kMax: number;
}

/** Non-overlapping wavenumber bands of the cascades. */
export function computeCascadeBands(fftSize: number, cascadeCount: number): CascadeBand[] {
  if (cascadeCount < 1 || cascadeCount > MAX_CASCADES) {
    throw new RangeError(`cascadeCount must be 1..${MAX_CASCADES}, got ${cascadeCount}`);
  }
  const bands: CascadeBand[] = [];
  for (let c = 0; c < cascadeCount; c++) {
    const patchSizeM = CASCADE_PATCH_SIZES_M[c] as number;
    const nyquist = (Math.PI * fftSize) / patchSizeM;
    const kMin = c === 0 ? 0 : (bands[c - 1] as CascadeBand).kMax;
    const next = CASCADE_PATCH_SIZES_M[c + 1];
    const kMax =
      c + 1 < cascadeCount && next !== undefined
        ? (BAND_SPLIT_FACTOR * 2 * Math.PI) / next
        : nyquist;
    if (kMax > nyquist + 1e-9) {
      throw new RangeError(
        `cascade ${c} (L=${patchSizeM} m, N=${fftSize}) cannot represent k up to ${kMax.toFixed(3)}`,
      );
    }
    bands.push({ patchSizeM, kMin, kMax });
  }
  return bands;
}
