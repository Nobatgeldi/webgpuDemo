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
/** GPU statistics (Hs, whitecap coverage) measurement interval (frames). */
const STATS_INTERVAL_FRAMES = 30;
const STATS_STAGING_BUFFERS = 2;
/** Statistics per row: sum of h^2 and number of foam texels. */
const STATS_VALUES_PER_ROW = 2;
/** Cascades that carry foam (must match FOAM_CASCADE_COUNT in oceanAssemble.wgsl). */
export const FOAM_CASCADE_COUNT = 2;
/** Jacobian threshold that is never reached (no foam). */
export const NO_FOAM_THRESHOLD = -10;
/** Longest simulation step used for foam decay (s); protects against hitches. */
const MAX_FOAM_STEP_S = 0.25;

/** Float offsets inside OceanComputeUniforms (shaders/oceanCompute.wgsl); verified by tests. */
export const OCEAN_COMPUTE_UNIFORM_OFFSETS = {
  grid: 0,
  jonswap: 4,
  wind: 8,
  foam: 12,
  foamCascades: 16,
  cascades: 20,
} as const;
const U = OCEAN_COMPUTE_UNIFORM_OFFSETS;

export interface CascadeSeaState {
  readonly jonswap: JonswapParameters;
  /** Unit vector (x, z) of wave propagation. */
  readonly propagation: readonly [number, number];
  /** Horizontal displacement scale lambda. */
  readonly choppiness: number;
}

export interface FoamParameters {
  /** e-folding time of foam decay (s). */
  readonly decayTimeS: number;
  /** Per foam cascade: foam starts where the Jacobian drops below this value ... */
  readonly jacobianThresholds: readonly number[];
  /** ... and is fully injected this much further below. */
  readonly softness: readonly number[];
}

interface ComputeStage {
  readonly pipeline: GPUComputePipeline;
  readonly bindGroups: readonly GPUBindGroup[];
}

/**
 * GPU wave simulation for all cascades: initial spectrum (on sea-state change),
 * time evolution, inverse FFT, unpacking into filterable displacement and
 * derivative textures, persistent foam, and the mip chains of all outputs.
 * Foam alternates between two textures (read previous, write current).
 */
export class OceanCascades {
  /** (lambda Dx, h, lambda Dz, lambda dDx/dz) per cascade layer, with mips. */
  readonly displacement: GPUTexture;
  /** (dh/dx, dh/dz, lambda dDx/dx, lambda dDz/dz) per cascade layer, with mips. */
  readonly derivatives: GPUTexture;
  /** Ping-pong foam textures (x: foam, y: Jacobian), with mips. */
  readonly foam: readonly [GPUTexture, GPUTexture];
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
  /** Index of the foam texture written by the latest encode(). */
  private foamIndex = 0;
  private lastTime: number | null = null;
  private statsPending: GPUBuffer | null = null;
  private measuredHs: number | null = null;
  private measuredFoamCoverage: number | null = null;

  private constructor(
    private readonly device: GPUDevice,
    readonly size: number,
    readonly bands: readonly CascadeBand[],
    private readonly spectrum: SpectrumPass,
    private readonly fft: FftPass,
    private readonly stages: {
      evolve: ComputeStage;
      /** Index = foam texture written. */
      assemble: ComputeStage;
      /** Mip bind groups of displacement and derivatives. */
      mips: ComputeStage;
      /** Mip bind groups per foam texture. */
      foamMips: readonly (readonly GPUBindGroup[])[];
      /** Index = current foam texture. */
      stats: ComputeStage;
    },
    resources: {
      uniformBuffer: GPUBuffer;
      fields: GPUTexture;
      scratch: GPUTexture;
      displacement: GPUTexture;
      derivatives: GPUTexture;
      foam: [GPUTexture, GPUTexture];
      statsBuffer: GPUBuffer;
    },
  ) {
    this.uniformBuffer = resources.uniformBuffer;
    this.fields = resources.fields;
    this.scratch = resources.scratch;
    this.displacement = resources.displacement;
    this.derivatives = resources.derivatives;
    this.foam = resources.foam;
    this.statsBuffer = resources.statsBuffer;
    this.mipLevelCount = resources.displacement.mipLevelCount;
    this.statsRing = new ReadbackRing(device, resources.statsBuffer.size, STATS_STAGING_BUFFERS, 'ocean-stats');

    const d = this.uniformData;
    d[U.grid] = size;
    d[U.grid + 1] = GRAVITY_M_S2;
    d[U.grid + 2] = (2 * Math.PI) / OCEAN_TIME_LOOP_S;
    d[U.wind + 3] = bands.length;
    d[U.foam + 1] = 1; // decay time, set properly by setFoam()
    d[U.foamCascades] = NO_FOAM_THRESHOLD;
    d[U.foamCascades + 2] = NO_FOAM_THRESHOLD;
    bands.forEach((band, c) => {
      d[U.cascades + 4 * c] = band.patchSizeM;
      d[U.cascades + 4 * c + 1] = band.kMin;
      d[U.cascades + 4 * c + 2] = band.kMax;
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
    const foam: [GPUTexture, GPUTexture] = [outputTexture('ocean-foam-0'), outputTexture('ocean-foam-1')];
    const statsBuffer = device.createBuffer({
      label: 'ocean-stats',
      size: STATS_VALUES_PER_ROW * cascades * size * Float32Array.BYTES_PER_ELEMENT,
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
        textureEntry(4, C, 'unfilterable-float'),
        storageTextureEntry(5, OCEAN_OUTPUT_FORMAT),
      ],
    });
    const mipLayout = device.createBindGroupLayout({
      label: 'mip-downsample',
      entries: [textureEntry(0, C, 'unfilterable-float'), storageTextureEntry(1, OCEAN_OUTPUT_FORMAT)],
    });
    const statsLayout = device.createBindGroupLayout({
      label: 'ocean-stats',
      entries: [
        textureEntry(0, C, 'unfilterable-float'),
        storageBufferEntry(1, C),
        textureEntry(2, C, 'unfilterable-float'),
      ],
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
    const mipChain = (texture: GPUTexture): GPUBindGroup[] => {
      const groups: GPUBindGroup[] = [];
      for (let mip = 1; mip < mipLevelCount; mip++) {
        groups.push(
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
      return groups;
    };

    const evolveBindGroup = device.createBindGroup({
      label: 'ocean-evolve',
      layout: evolveLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: arrayView(spectrum.h0) },
        { binding: 2, resource: arrayView(fields) },
      ],
    });
    const assembleBindGroups = [0, 1].map((written) =>
      device.createBindGroup({
        label: `ocean-assemble-${written}`,
        layout: assembleLayout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: arrayView(fields) },
          { binding: 2, resource: arrayView(displacement, 0) },
          { binding: 3, resource: arrayView(derivatives, 0) },
          { binding: 4, resource: arrayView(foam[1 - written] as GPUTexture, 0) },
          { binding: 5, resource: arrayView(foam[written] as GPUTexture, 0) },
        ],
      }),
    );
    const statsBindGroups = [0, 1].map((current) =>
      device.createBindGroup({
        label: `ocean-stats-${current}`,
        layout: statsLayout,
        entries: [
          { binding: 0, resource: arrayView(fields) },
          { binding: 1, resource: { buffer: statsBuffer } },
          { binding: 2, resource: arrayView(foam[current] as GPUTexture, 0) },
        ],
      }),
    );

    return new OceanCascades(
      device,
      size,
      bands,
      spectrum,
      fft,
      {
        evolve: { pipeline: evolvePipeline, bindGroups: [evolveBindGroup] },
        assemble: { pipeline: assemblePipeline, bindGroups: assembleBindGroups },
        mips: { pipeline: mipPipeline, bindGroups: [...mipChain(displacement), ...mipChain(derivatives)] },
        foamMips: foam.map(mipChain),
        stats: { pipeline: statsPipeline, bindGroups: statsBindGroups },
      },
      { uniformBuffer, fields, scratch, displacement, derivatives, foam, statsBuffer },
    );
  }

  get cascadeCount(): number {
    return this.bands.length;
  }

  /** Initial spectrum h0 (xy: h0(k), zw: conj h0(-k)) per cascade layer. */
  get spectrumTexture(): GPUTexture {
    return this.spectrum.h0;
  }

  /** Foam texture written by the latest {@link OceanCascades.encode} (0 or 1). */
  get currentFoamIndex(): number {
    return this.foamIndex;
  }

  /** Significant wave height measured from the GPU height fields (null until the first readback). */
  get measuredSignificantWaveHeight(): number | null {
    return this.measuredHs;
  }

  /** Fraction of the sea surface covered by foam, measured on the GPU (null until available). */
  get measuredWhitecapCoverage(): number | null {
    return this.measuredFoamCoverage;
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
    d[U.jonswap] = p.calm ? 0 : p.alpha;
    d[U.jonswap + 1] = p.calm ? 1 : p.peakOmega;
    d[U.jonswap + 2] = p.gamma;
    d[U.wind] = state.propagation[0];
    d[U.wind + 1] = state.propagation[1];
    d[U.wind + 2] = state.choppiness;
  }

  setFoam(foam: FoamParameters): void {
    const d = this.uniformData;
    d[U.foam + 1] = foam.decayTimeS;
    for (let c = 0; c < FOAM_CASCADE_COUNT; c++) {
      d[U.foamCascades + 2 * c] = foam.jacobianThresholds[c] ?? NO_FOAM_THRESHOLD;
      d[U.foamCascades + 2 * c + 1] = foam.softness[c] ?? 1;
    }
  }

  /**
   * Records the simulation for time `timeSeconds` into a compute pass.
   * Call {@link OceanCascades.afterSubmit} after the command buffer is submitted.
   */
  encode(encoder: GPUCommandEncoder, timeSeconds: number, timestampWrites?: GPUComputePassTimestampWrites): void {
    const d = this.uniformData;
    d[U.grid + 3] = (((timeSeconds % OCEAN_TIME_LOOP_S) + OCEAN_TIME_LOOP_S) % OCEAN_TIME_LOOP_S) / OCEAN_TIME_LOOP_S;
    // Foam ages with simulation time only (frozen while paused).
    const step = this.lastTime === null ? 0 : timeSeconds - this.lastTime;
    d[U.foam] = Math.min(Math.max(step, 0), MAX_FOAM_STEP_S);
    this.lastTime = timeSeconds;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, d);

    const written = 1 - this.foamIndex;
    const groups = Math.ceil(this.size / TEXEL_WORKGROUP);
    const cascades = this.cascadeCount;
    const pass = encoder.beginComputePass(
      timestampWrites ? { label: 'ocean', timestampWrites } : { label: 'ocean' },
    );
    if (this.spectrumDirty) {
      this.spectrum.encode(pass);
      this.spectrumDirty = false;
    }
    pass.setPipeline(this.stages.evolve.pipeline);
    pass.setBindGroup(0, this.stages.evolve.bindGroups[0] as GPUBindGroup);
    pass.dispatchWorkgroups(groups, groups, cascades);

    this.fft.encode(pass);

    pass.setPipeline(this.stages.assemble.pipeline);
    pass.setBindGroup(0, this.stages.assemble.bindGroups[written] as GPUBindGroup);
    pass.dispatchWorkgroups(groups, groups, cascades);

    pass.setPipeline(this.stages.mips.pipeline);
    const chains = [this.stages.mips.bindGroups, this.stages.foamMips[written] as readonly GPUBindGroup[]];
    const mipsPerTexture = this.mipLevelCount - 1;
    for (const chain of chains) {
      chain.forEach((bindGroup, i) => {
        const mip = (i % mipsPerTexture) + 1;
        const mipGroups = Math.ceil((this.size >> mip) / TEXEL_WORKGROUP);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(mipGroups, mipGroups, cascades);
      });
    }

    const measure = this.frameCounter++ % STATS_INTERVAL_FRAMES === 0;
    const staging = measure ? this.statsRing.acquire() : null;
    if (staging) {
      pass.setPipeline(this.stages.stats.pipeline);
      pass.setBindGroup(0, this.stages.stats.bindGroups[written] as GPUBindGroup);
      pass.dispatchWorkgroups(this.size, cascades);
    }
    pass.end();
    if (staging) {
      encoder.copyBufferToBuffer(this.statsBuffer, 0, staging, 0, this.statsBuffer.size);
    }
    this.statsPending = staging;
    this.foamIndex = written;
  }

  afterSubmit(): void {
    const staging = this.statsPending;
    this.statsPending = null;
    if (!staging) {
      return;
    }
    const texels = this.size * this.size;
    const cascades = this.cascadeCount;
    this.statsRing.mapWhenReady(staging, (data) => {
      const values = new Float32Array(data);
      const half = values.length / 2;
      let variance = 0;
      for (let i = 0; i < half; i++) {
        variance += values[i] as number;
      }
      // Bands are disjoint and independent, so their variances add up.
      this.measuredHs = 4 * Math.sqrt(variance / texels);
      // Foam layers are independent patterns: the uncovered fractions multiply.
      let uncovered = 1;
      for (let c = 0; c < Math.min(cascades, FOAM_CASCADE_COUNT); c++) {
        let count = 0;
        for (let row = 0; row < this.size; row++) {
          count += values[half + c * this.size + row] as number;
        }
        uncovered *= 1 - count / texels;
      }
      this.measuredFoamCoverage = 1 - uncovered;
    });
  }

  dispose(): void {
    this.statsRing.dispose();
    this.spectrum.dispose();
    for (const texture of [this.fields, this.scratch, this.displacement, this.derivatives, ...this.foam]) {
      texture.destroy();
    }
    this.uniformBuffer.destroy();
    this.statsBuffer.destroy();
  }
}
