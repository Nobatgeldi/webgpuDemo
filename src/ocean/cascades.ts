import {
  storageBufferEntry,
  storageTextureEntry,
  textureEntry,
  uniformEntry,
} from '../core/bindings';
import { GRAVITY_M_S2 } from '../core/constants';
import { ReadbackRing } from '../core/readback';
import { composeWgsl, createShaderModule } from '../core/shader';
import { WGSL } from '../shaders';
import { FftPass } from './fft';
import { MAX_CASCADES, OCEAN_TIME_LOOP_S, type CascadeBand } from './oceanConfig';
import { OCEAN_COMPUTE_UNIFORM_BYTES, SPECTRUM_CONSTANTS_CHUNK, SpectrumPass } from './spectrum';
import type { JonswapParameters } from './spectrumModel';

/** Format of the textures sampled by the renderer (filterable on every adapter). */
export const OCEAN_OUTPUT_FORMAT: GPUTextureFormat = 'rgba16float';
const FIELD_FORMAT: GPUTextureFormat = 'rgba32float';
/** Two rgba32float layers (four packed complex FFTs) per cascade. */
const FIELD_LAYERS_PER_CASCADE = 2;
const TEXEL_WORKGROUP = 8;
/** GPU significant-wave-height measurement interval (frames). */
const STATS_INTERVAL_FRAMES = 30;
const STATS_STAGING_BUFFERS = 2;

/** Float offsets inside OceanComputeUniforms (shaders/oceanCompute.wgsl); verified by tests. */
export const OCEAN_COMPUTE_UNIFORM_OFFSETS = { grid: 0, jonswap: 4, wind: 8, cascades: 12 } as const;
const U_GRID = OCEAN_COMPUTE_UNIFORM_OFFSETS.grid;
const U_JONSWAP = OCEAN_COMPUTE_UNIFORM_OFFSETS.jonswap;
const U_WIND = OCEAN_COMPUTE_UNIFORM_OFFSETS.wind;
const U_CASCADES = OCEAN_COMPUTE_UNIFORM_OFFSETS.cascades;

export interface CascadeSeaState {
  readonly jonswap: JonswapParameters;
  /** Unit vector (x, z) of wave propagation. */
  readonly propagation: readonly [number, number];
  /** Horizontal displacement scale lambda. */
  readonly choppiness: number;
}

/**
 * GPU wave simulation for all cascades: initial spectrum (on sea-state change),
 * time evolution, inverse FFT, unpacking into filterable displacement and
 * derivative textures, and their mip chains.
 */
export class OceanCascades {
  /** (lambda Dx, h, lambda Dz, lambda dDx/dz) per cascade layer, with mips. */
  readonly displacement: GPUTexture;
  /** (dh/dx, dh/dz, lambda dDx/dx, lambda dDz/dz) per cascade layer, with mips. */
  readonly derivatives: GPUTexture;
  readonly mipLevelCount: number;

  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new Float32Array(OCEAN_COMPUTE_UNIFORM_BYTES / 4);
  private readonly fields: GPUTexture;
  private readonly scratch: GPUTexture;
  private readonly statsBuffer: GPUBuffer;
  private readonly statsRing: ReadbackRing;
  private spectrumDirty = true;
  private lastSeaStateKey = '';
  private frameCounter = 0;
  private statsPending: GPUBuffer | null = null;
  private measuredHs: number | null = null;

  private constructor(
    private readonly device: GPUDevice,
    readonly size: number,
    readonly bands: readonly CascadeBand[],
    private readonly spectrum: SpectrumPass,
    private readonly fft: FftPass,
    private readonly passes: {
      evolve: { pipeline: GPUComputePipeline; bindGroup: GPUBindGroup };
      assemble: { pipeline: GPUComputePipeline; bindGroup: GPUBindGroup };
      mips: { pipeline: GPUComputePipeline; bindGroups: GPUBindGroup[] };
      stats: { pipeline: GPUComputePipeline; bindGroup: GPUBindGroup };
    },
    resources: {
      uniformBuffer: GPUBuffer;
      fields: GPUTexture;
      scratch: GPUTexture;
      displacement: GPUTexture;
      derivatives: GPUTexture;
      statsBuffer: GPUBuffer;
    },
  ) {
    this.uniformBuffer = resources.uniformBuffer;
    this.fields = resources.fields;
    this.scratch = resources.scratch;
    this.displacement = resources.displacement;
    this.derivatives = resources.derivatives;
    this.statsBuffer = resources.statsBuffer;
    this.mipLevelCount = resources.displacement.mipLevelCount;
    this.statsRing = new ReadbackRing(
      device,
      resources.statsBuffer.size,
      STATS_STAGING_BUFFERS,
      'ocean-stats',
    );

    const d = this.uniformData;
    d[U_GRID] = size;
    d[U_GRID + 1] = GRAVITY_M_S2;
    d[U_GRID + 2] = (2 * Math.PI) / OCEAN_TIME_LOOP_S;
    d[U_WIND + 3] = bands.length;
    bands.forEach((band, c) => {
      d[U_CASCADES + 4 * c] = band.patchSizeM;
      d[U_CASCADES + 4 * c + 1] = band.kMin;
      d[U_CASCADES + 4 * c + 2] = band.kMax;
    });
  }

  static async create(
    device: GPUDevice,
    size: number,
    bands: readonly CascadeBand[],
    seed: number,
  ): Promise<OceanCascades> {
    const cascades = bands.length;
    if (cascades < 1 || cascades > MAX_CASCADES) {
      throw new RangeError(`1..${MAX_CASCADES} cascades supported, got ${cascades}`);
    }
    const fieldLayers = cascades * FIELD_LAYERS_PER_CASCADE;
    const mipLevelCount = Math.log2(size) + 1;

    const uniformBuffer = device.createBuffer({
      label: 'ocean-compute-uniforms',
      size: OCEAN_COMPUTE_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const fieldTexture = (label: string): GPUTexture =>
      device.createTexture({
        label,
        size: { width: size, height: size, depthOrArrayLayers: fieldLayers },
        format: FIELD_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      });
    const outputTexture = (label: string): GPUTexture =>
      device.createTexture({
        label,
        size: { width: size, height: size, depthOrArrayLayers: cascades },
        format: OCEAN_OUTPUT_FORMAT,
        mipLevelCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      });
    const fields = fieldTexture('ocean-fields');
    const scratch = fieldTexture('ocean-fft-scratch');
    const displacement = outputTexture('ocean-displacement');
    const derivatives = outputTexture('ocean-derivatives');
    const statsBuffer = device.createBuffer({
      label: 'ocean-stats',
      size: cascades * size * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const compose = (label: string, main: (typeof WGSL)[keyof typeof WGSL]) =>
      composeWgsl(label, [SPECTRUM_CONSTANTS_CHUNK, WGSL.oceanCompute, main]);
    const [evolveModule, assembleModule, mipModule, statsModule] = await Promise.all([
      createShaderModule(device, compose('ocean-evolve', WGSL.oceanEvolve)),
      createShaderModule(device, compose('ocean-assemble', WGSL.oceanAssemble)),
      createShaderModule(device, composeWgsl('mip-downsample', [WGSL.mipDownsample])),
      createShaderModule(device, composeWgsl('ocean-stats', [WGSL.oceanStats])),
    ]);

    const C = GPUShaderStage.COMPUTE;
    const evolveLayout = device.createBindGroupLayout({
      label: 'ocean-evolve',
      entries: [
        uniformEntry(0, C, OCEAN_COMPUTE_UNIFORM_BYTES),
        textureEntry(1, C, 'unfilterable-float'),
        storageTextureEntry(2, FIELD_FORMAT),
      ],
    });
    const assembleLayout = device.createBindGroupLayout({
      label: 'ocean-assemble',
      entries: [
        uniformEntry(0, C, OCEAN_COMPUTE_UNIFORM_BYTES),
        textureEntry(1, C, 'unfilterable-float'),
        storageTextureEntry(2, OCEAN_OUTPUT_FORMAT),
        storageTextureEntry(3, OCEAN_OUTPUT_FORMAT),
      ],
    });
    const mipLayout = device.createBindGroupLayout({
      label: 'mip-downsample',
      entries: [textureEntry(0, C, 'unfilterable-float'), storageTextureEntry(1, OCEAN_OUTPUT_FORMAT)],
    });
    const statsLayout = device.createBindGroupLayout({
      label: 'ocean-stats',
      entries: [textureEntry(0, C, 'unfilterable-float'), storageBufferEntry(1, C)],
    });
    const pipeline = (
      label: string,
      module: GPUShaderModule,
      layout: GPUBindGroupLayout,
      constants?: Record<string, number>,
    ): Promise<GPUComputePipeline> =>
      device.createComputePipelineAsync({
        label,
        layout: device.createPipelineLayout({ label, bindGroupLayouts: [layout] }),
        compute: constants ? { module, entryPoint: 'main', constants } : { module, entryPoint: 'main' },
      });

    const [spectrum, fft, evolvePipeline, assemblePipeline, mipPipeline, statsPipeline] =
      await Promise.all([
        SpectrumPass.create(device, uniformBuffer, size, cascades, seed),
        FftPass.create(device, size, fieldLayers, fields, scratch),
        pipeline('ocean-evolve', evolveModule, evolveLayout),
        pipeline('ocean-assemble', assembleModule, assembleLayout),
        pipeline('mip-downsample', mipModule, mipLayout),
        pipeline('ocean-stats', statsModule, statsLayout, { FFT_SIZE: size }),
      ]);

    const arrayView = (texture: GPUTexture, mip?: number): GPUTextureView =>
      texture.createView(
        mip === undefined
          ? { dimension: '2d-array' }
          : { dimension: '2d-array', baseMipLevel: mip, mipLevelCount: 1 },
      );

    const evolveBindGroup = device.createBindGroup({
      label: 'ocean-evolve',
      layout: evolveLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: arrayView(spectrum.h0) },
        { binding: 2, resource: arrayView(fields) },
      ],
    });
    const assembleBindGroup = device.createBindGroup({
      label: 'ocean-assemble',
      layout: assembleLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: arrayView(fields) },
        { binding: 2, resource: arrayView(displacement, 0) },
        { binding: 3, resource: arrayView(derivatives, 0) },
      ],
    });
    const mipBindGroups: GPUBindGroup[] = [];
    for (const texture of [displacement, derivatives]) {
      for (let mip = 1; mip < mipLevelCount; mip++) {
        mipBindGroups.push(
          device.createBindGroup({
            label: `${texture.label}-mip${mip}`,
            layout: mipLayout,
            entries: [
              { binding: 0, resource: arrayView(texture, mip - 1) },
              { binding: 1, resource: arrayView(texture, mip) },
            ],
          }),
        );
      }
    }
    const statsBindGroup = device.createBindGroup({
      label: 'ocean-stats',
      layout: statsLayout,
      entries: [
        { binding: 0, resource: arrayView(fields) },
        { binding: 1, resource: { buffer: statsBuffer } },
      ],
    });

    return new OceanCascades(
      device,
      size,
      bands,
      spectrum,
      fft,
      {
        evolve: { pipeline: evolvePipeline, bindGroup: evolveBindGroup },
        assemble: { pipeline: assemblePipeline, bindGroup: assembleBindGroup },
        mips: { pipeline: mipPipeline, bindGroups: mipBindGroups },
        stats: { pipeline: statsPipeline, bindGroup: statsBindGroup },
      },
      { uniformBuffer, fields, scratch, displacement, derivatives, statsBuffer },
    );
  }

  get cascadeCount(): number {
    return this.bands.length;
  }

  /** Significant wave height measured from the GPU height fields (null until the first readback). */
  get measuredSignificantWaveHeight(): number | null {
    return this.measuredHs;
  }

  /** Updates the sea state; the initial spectrum is only regenerated when it changed. */
  setSeaState(state: CascadeSeaState): void {
    const p = state.jonswap;
    const key = `${p.alpha}|${p.peakOmega}|${p.gamma}|${state.propagation[0]}|${state.propagation[1]}`;
    if (key !== this.lastSeaStateKey) {
      this.lastSeaStateKey = key;
      this.spectrumDirty = true;
    }
    const d = this.uniformData;
    d[U_JONSWAP] = p.calm ? 0 : p.alpha;
    d[U_JONSWAP + 1] = p.calm ? 1 : p.peakOmega;
    d[U_JONSWAP + 2] = p.gamma;
    d[U_WIND] = state.propagation[0];
    d[U_WIND + 1] = state.propagation[1];
    d[U_WIND + 2] = state.choppiness;
  }

  /**
   * Records the simulation for `timePhase` = (t mod T) / T into a compute pass.
   * Call {@link OceanCascades.afterSubmit} after the command buffer is submitted.
   */
  encode(encoder: GPUCommandEncoder, timePhase: number, timestampWrites?: GPUComputePassTimestampWrites): void {
    this.uniformData[U_GRID + 3] = timePhase;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

    const groups = Math.ceil(this.size / TEXEL_WORKGROUP);
    const cascades = this.cascadeCount;
    const pass = encoder.beginComputePass(
      timestampWrites ? { label: 'ocean', timestampWrites } : { label: 'ocean' },
    );
    if (this.spectrumDirty) {
      this.spectrum.encode(pass);
      this.spectrumDirty = false;
    }
    pass.setPipeline(this.passes.evolve.pipeline);
    pass.setBindGroup(0, this.passes.evolve.bindGroup);
    pass.dispatchWorkgroups(groups, groups, cascades);

    this.fft.encode(pass);

    pass.setPipeline(this.passes.assemble.pipeline);
    pass.setBindGroup(0, this.passes.assemble.bindGroup);
    pass.dispatchWorkgroups(groups, groups, cascades);

    pass.setPipeline(this.passes.mips.pipeline);
    const mipsPerTexture = this.mipLevelCount - 1;
    this.passes.mips.bindGroups.forEach((bindGroup, i) => {
      const mip = (i % mipsPerTexture) + 1;
      const mipGroups = Math.ceil((this.size >> mip) / TEXEL_WORKGROUP);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(mipGroups, mipGroups, cascades);
    });

    const measure = this.frameCounter++ % STATS_INTERVAL_FRAMES === 0;
    const staging = measure ? this.statsRing.acquire() : null;
    if (staging) {
      pass.setPipeline(this.passes.stats.pipeline);
      pass.setBindGroup(0, this.passes.stats.bindGroup);
      pass.dispatchWorkgroups(this.size, cascades);
    }
    pass.end();
    if (staging) {
      encoder.copyBufferToBuffer(this.statsBuffer, 0, staging, 0, this.statsBuffer.size);
    }
    this.statsPending = staging;
  }

  afterSubmit(): void {
    const staging = this.statsPending;
    this.statsPending = null;
    if (!staging) {
      return;
    }
    const texels = this.size * this.size;
    this.statsRing.mapWhenReady(staging, (data) => {
      const rowSums = new Float32Array(data);
      let variance = 0;
      for (const sum of rowSums) {
        variance += sum;
      }
      // Bands are disjoint and independent, so their variances add up.
      this.measuredHs = 4 * Math.sqrt(variance / texels);
    });
  }

  dispose(): void {
    this.statsRing.dispose();
    this.spectrum.dispose();
    for (const texture of [this.fields, this.scratch, this.displacement, this.derivatives]) {
      texture.destroy();
    }
    this.uniformBuffer.destroy();
    this.statsBuffer.destroy();
  }
}
