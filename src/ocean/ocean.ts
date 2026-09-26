import type { QualityPreset } from '../core/urlParams';
import type { Camera } from '../render/camera';
import type { FrameUniforms } from '../render/frameUniforms';
import { FOAM_CASCADE_COUNT, NO_FOAM_THRESHOLD, OceanCascades, type FoamParameters } from './cascades';
import {
  OCEAN_QUALITY,
  computeCascadeBands,
  type CascadeBand,
  type OceanQualityConfig,
} from './oceanConfig';
import { OceanRenderer, SLOPE_TABLE_SIZE } from './oceanPass';
import {
  bandSignificantWaveHeight,
  inverseNormalCdf,
  jonswapParameters,
  resolvedSlopeVariance,
  significantWaveHeight,
  unresolvedSlopeVariance,
  whitecapCoverage,
  type JonswapParameters,
} from './spectrumModel';

// --- Foam calibration ---------------------------------------------------------
/** e-folding lifetime of whitecap foam (s). */
const FOAM_DECAY_TIME_S = 4;
/**
 * Share of the observed (Monahan) whitecap coverage that is actively breaking
 * crests; the rest is decaying foam left behind, which the simulation adds
 * through the foam lifetime. Calibrated so that the steady-state coverage
 * measured on the GPU (debug overlay) matches Monahan within ~20 % at Bf 6-8.
 */
const FOAM_ACTIVE_SHARE = 0.4;
/** Largest actively breaking fraction per cascade (keeps storms from turning the sea white). */
const MAX_ACTIVE_FOAM_FRACTION = 0.3;
/** Width of the injection ramp in standard deviations of the Jacobian. */
const FOAM_SOFTNESS_SIGMAS = 0.5;
/** Below this Jacobian standard deviation the band is too smooth to break. */
const MIN_JACOBIAN_SIGMA = 1e-4;

// --- Glint roughness table ------------------------------------------------------
/** Cutoff wavenumbers of the unresolved-slope table span 0.01 ... 1000 rad/m. */
const SLOPE_TABLE_K_MIN = 0.01;
const SLOPE_TABLE_K_MAX = 1000;
const SLOPE_TABLE_LOG_K0 = Math.log(SLOPE_TABLE_K_MIN);
const SLOPE_TABLE_LOG_STEP = Math.log(SLOPE_TABLE_K_MAX / SLOPE_TABLE_K_MIN) / (SLOPE_TABLE_SIZE - 1);

/**
 * Foam thresholds calibrated to the observed whitecap coverage (Monahan). For
 * each foam cascade the Jacobian J = 1 + lambda (dDx/dx + dDz/dz) + ... is
 * approximately Gaussian with standard deviation lambda * sqrt(band slope
 * variance) (the spectrum of dDx/dx + dDz/dz is -|k| h). Foam is injected
 * below the quantile of J that yields the target breaking fraction; both
 * cascades together (union of independent patterns) reach the target.
 * Below Bf 3 the target is practically zero, from Bf 7 it is several percent.
 */
export function foamParametersForSeaState(
  jonswap: JonswapParameters,
  bands: readonly CascadeBand[],
  choppiness: number,
): FoamParameters {
  const activeTotal = Math.min(whitecapCoverage(jonswap.windSpeedMs) * FOAM_ACTIVE_SHARE, MAX_ACTIVE_FOAM_FRACTION);
  const foamBands = bands.slice(0, FOAM_CASCADE_COUNT);
  const perCascade = 1 - Math.pow(1 - activeTotal, 1 / foamBands.length);
  const jacobianThresholds: number[] = [];
  const softness: number[] = [];
  for (const band of foamBands) {
    const slopeVariance =
      resolvedSlopeVariance(jonswap, band.kMax) - resolvedSlopeVariance(jonswap, band.kMin);
    const sigma = choppiness * Math.sqrt(Math.max(slopeVariance, 0));
    if (sigma < MIN_JACOBIAN_SIGMA || perCascade <= 0) {
      jacobianThresholds.push(NO_FOAM_THRESHOLD);
      softness.push(1);
      continue;
    }
    const soft = FOAM_SOFTNESS_SIGMAS * sigma;
    // Foam counts as covering where it exceeds 0.5, i.e. half-way down the ramp.
    jacobianThresholds.push(1 + inverseNormalCdf(perCascade) * sigma + 0.5 * soft);
    softness.push(soft);
  }
  return { decayTimeS: FOAM_DECAY_TIME_S, jacobianThresholds, softness };
}
import { propagationVector } from './windState';

export interface SeaStateSettings {
  readonly windSpeedMs: number;
  /** Direction the wind blows FROM, clockwise from north (rad). */
  readonly windFromRad: number;
  readonly fetchM: number;
  readonly choppiness: number;
}

export interface OceanStats {
  readonly jonswap: JonswapParameters;
  /** Hs of the full continuous spectrum (m). */
  readonly significantWaveHeightM: number;
  /** Hs of the part of the spectrum resolved by the cascades (m). */
  readonly resolvedSignificantWaveHeightM: number;
  /** Hs measured from the GPU height fields (m), null until available. */
  readonly measuredSignificantWaveHeightM: number | null;
  /** Whitecap coverage measured on the GPU and predicted by Monahan's relation. */
  readonly measuredWhitecapCoverage: number | null;
  readonly monahanWhitecapCoverage: number;
  readonly bands: readonly CascadeBand[];
  readonly fftSize: number;
}

/** Sea surface: FFT wave simulation plus clipmap rendering. */
export class Ocean {
  private jonswap: JonswapParameters | null = null;
  private hs = 0;
  private resolvedHs = 0;
  private choppiness = Number.NaN;
  private readonly slopeVariance = new Float32Array(SLOPE_TABLE_SIZE);

  private constructor(
    readonly quality: OceanQualityConfig,
    private readonly cascades: OceanCascades,
    private readonly renderer: OceanRenderer,
  ) {}

  static async create(
    device: GPUDevice,
    frameUniforms: FrameUniforms,
    preset: QualityPreset,
    seed: number,
  ): Promise<Ocean> {
    const quality = OCEAN_QUALITY[preset];
    const bands = computeCascadeBands(quality.fftSize, quality.cascadeCount);
    const cascades = await OceanCascades.create(device, quality.fftSize, bands, seed);
    const renderer = await OceanRenderer.create(device, frameUniforms, cascades, quality);
    return new Ocean(quality, cascades, renderer);
  }

  /** Applies the current wind/fetch/choppiness; cheap when nothing changed. */
  setSeaState(sea: SeaStateSettings): void {
    const jonswap = jonswapParameters({ windSpeedMs: sea.windSpeedMs, fetchM: sea.fetchM });
    const previous = this.jonswap;
    if (
      !previous ||
      previous.alpha !== jonswap.alpha ||
      previous.peakOmega !== jonswap.peakOmega ||
      previous.calm !== jonswap.calm ||
      this.choppiness !== sea.choppiness
    ) {
      this.choppiness = sea.choppiness;
      this.hs = significantWaveHeight(jonswap);
      let resolvedVariance = 0;
      for (const band of this.cascades.bands) {
        resolvedVariance += (bandSignificantWaveHeight(jonswap, band.kMin, band.kMax) / 4) ** 2;
      }
      this.resolvedHs = 4 * Math.sqrt(resolvedVariance);
      const bands = this.cascades.bands;
      const kRenderedMax = (bands[bands.length - 1] as CascadeBand).kMax;
      for (let i = 0; i < SLOPE_TABLE_SIZE; i++) {
        const kCut = Math.exp(SLOPE_TABLE_LOG_K0 + i * SLOPE_TABLE_LOG_STEP);
        this.slopeVariance[i] = unresolvedSlopeVariance(jonswap, kCut, kRenderedMax);
      }
      this.cascades.setFoam(foamParametersForSeaState(jonswap, this.cascades.bands, sea.choppiness));
    }
    this.jonswap = jonswap;
    this.cascades.setSeaState({
      jonswap,
      propagation: propagationVector(sea.windFromRad),
      choppiness: sea.choppiness,
    });
  }

  get stats(): OceanStats | null {
    if (!this.jonswap) {
      return null;
    }
    return {
      jonswap: this.jonswap,
      significantWaveHeightM: this.hs,
      resolvedSignificantWaveHeightM: this.resolvedHs,
      measuredSignificantWaveHeightM: this.cascades.measuredSignificantWaveHeight,
      measuredWhitecapCoverage: this.cascades.measuredWhitecapCoverage,
      monahanWhitecapCoverage: whitecapCoverage(this.jonswap.windSpeedMs),
      bands: this.cascades.bands,
      fftSize: this.cascades.size,
    };
  }

  /** Significant wave height of the current sea state (m). */
  get significantWaveHeightM(): number {
    return this.hs;
  }

  /** Records the wave simulation for simulation time `timeSeconds`. */
  encodeSimulation(
    encoder: GPUCommandEncoder,
    timeSeconds: number,
    timestampWrites?: GPUComputePassTimestampWrites,
  ): void {
    this.cascades.encode(encoder, timeSeconds, timestampWrites);
  }

  afterSubmit(): void {
    this.cascades.afterSubmit();
  }

  prepareDraw(camera: Camera, options: { wireframe: boolean }): void {
    this.renderer.update(camera, {
      wireframe: options.wireframe,
      significantWaveHeightM: this.hs,
      slopeTableLogK0: SLOPE_TABLE_LOG_K0,
      slopeTableLogStep: SLOPE_TABLE_LOG_STEP,
      slopeVariance: this.slopeVariance,
    });
  }

  /** GPU textures for the debug texture viewer. */
  get debugTextures(): {
    spectrum: GPUTexture;
    displacement: GPUTexture;
    derivatives: GPUTexture;
    foam: readonly GPUTexture[];
    currentFoamIndex: number;
  } {
    return {
      spectrum: this.cascades.spectrumTexture,
      displacement: this.cascades.displacement,
      derivatives: this.cascades.derivatives,
      foam: this.cascades.foam,
      currentFoamIndex: this.cascades.currentFoamIndex,
    };
  }

  draw(pass: GPURenderPassEncoder): void {
    this.renderer.draw(pass);
  }

  dispose(): void {
    this.renderer.dispose();
    this.cascades.dispose();
  }
}
