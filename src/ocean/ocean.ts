import { wrapPeriodic } from '../core/cameraRelative';
import type { QualityPreset } from '../core/urlParams';
import type { Camera } from '../render/camera';
import type { FrameUniforms } from '../render/frameUniforms';
import { OceanCascades } from './cascades';
import {
  OCEAN_QUALITY,
  OCEAN_TIME_LOOP_S,
  computeCascadeBands,
  type CascadeBand,
  type OceanQualityConfig,
} from './oceanConfig';
import { OceanRenderer } from './oceanPass';
import {
  bandSignificantWaveHeight,
  jonswapParameters,
  significantWaveHeight,
  type JonswapParameters,
} from './spectrumModel';
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
  readonly bands: readonly CascadeBand[];
  readonly fftSize: number;
}

/** Sea surface: FFT wave simulation plus clipmap rendering. */
export class Ocean {
  private jonswap: JonswapParameters | null = null;
  private hs = 0;
  private resolvedHs = 0;

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
      previous.calm !== jonswap.calm
    ) {
      this.hs = significantWaveHeight(jonswap);
      let resolvedVariance = 0;
      for (const band of this.cascades.bands) {
        resolvedVariance += (bandSignificantWaveHeight(jonswap, band.kMin, band.kMax) / 4) ** 2;
      }
      this.resolvedHs = 4 * Math.sqrt(resolvedVariance);
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
    const phase = wrapPeriodic(timeSeconds, OCEAN_TIME_LOOP_S) / OCEAN_TIME_LOOP_S;
    this.cascades.encode(encoder, phase, timestampWrites);
  }

  afterSubmit(): void {
    this.cascades.afterSubmit();
  }

  prepareDraw(camera: Camera): void {
    this.renderer.update(camera);
  }

  draw(pass: GPURenderPassEncoder): void {
    this.renderer.draw(pass);
  }

  dispose(): void {
    this.renderer.dispose();
    this.cascades.dispose();
  }
}
