/**
 * Wake foam field around the ship (see shaders/wake.wgsl): a toroidally
 * addressed foam texture whose window follows the ship in whole cells, updated
 * by a compute pass each frame and sampled by the ocean shader.
 */
import { storageTextureEntry, textureEntry, uniformEntry, samplerEntry } from '../core/bindings';
import { wrapPeriodic } from '../core/cameraRelative';
import { composeWgsl, createShaderModule } from '../core/shader';
import { WGSL } from '../shaders';
import type { WakeEmitter } from './shipEffectSources';

export const WAKE_CONFIG = {
  /** Texels per side and cell size: a 512 m window at 0.5 m resolution. */
  textureSize: 1024,
  cellSizeM: 0.5,
  /** e-folding lifetime of the wake foam (s); the turbulent wake of a ship stays visible for minutes. */
  decayTimeS: 45,
  /** e-folding lifetime of fresh, dense foam before it breaks up into streaks (s). */
  freshDecayTimeS: 6,
  /** Turbulent diffusivity that widens the wake (m^2/s). */
  diffusivityM2PerS: 1.5,
  /** Stability limit of the explicit diffusion step (D dt / dx^2 <= 1/4). */
  maxDiffusionNumber: 0.24,
  /** Upper bound of the foam amount (1 = full cover). */
  maxFoam: 2,
  /** Foam fades out over this distance before the window edge (m). */
  edgeFadeM: 60,
} as const;

/** Must match WAKE_MAX_EMITTERS in shaders/wake.wgsl. */
const WAKE_MAX_EMITTERS = 16;
const UPDATE_UNIFORM_BYTES = 48 + 2 * WAKE_MAX_EMITTERS * 16;
const SAMPLE_UNIFORM_BYTES = 32;
const WORKGROUP_SIZE = 8;
const WAKE_FORMAT: GPUTextureFormat = 'rgba16float';

export class WakeFoam {
  /** Layout of the bind group the ocean shader samples the wake with (@group(2)). */
  readonly sampleLayout: GPUBindGroupLayout;
  private readonly textures: GPUTexture[];
  private readonly updateBindGroups: GPUBindGroup[];
  private readonly sampleBindGroups: GPUBindGroup[];
  private readonly updateData = new ArrayBuffer(UPDATE_UNIFORM_BYTES);
  private readonly updateInts = new Int32Array(this.updateData);
  private readonly updateFloats = new Float32Array(this.updateData);
  private readonly sampleData = new Float32Array(SAMPLE_UNIFORM_BYTES / 4);
  /** Index of the texture holding the latest field. */
  private current = 0;
  private originX = 0;
  private originZ = 0;
  private hasOrigin = false;
  enabled = true;

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPUComputePipeline,
    updateLayout: GPUBindGroupLayout,
    sampleLayout: GPUBindGroupLayout,
    private readonly updateUniforms: GPUBuffer,
    private readonly sampleUniforms: GPUBuffer,
  ) {
    const size = WAKE_CONFIG.textureSize;
    this.sampleLayout = sampleLayout;
    this.textures = [0, 1].map((i) =>
      device.createTexture({
        label: `wake-foam-${i}`,
        size: [size, size],
        format: WAKE_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      }),
    );
    // Update i reads texture i and writes the other one.
    this.updateBindGroups = [0, 1].map((i) =>
      device.createBindGroup({
        label: `wake-update-${i}`,
        layout: updateLayout,
        entries: [
          { binding: 0, resource: { buffer: updateUniforms } },
          { binding: 1, resource: (this.textures[i] as GPUTexture).createView() },
          { binding: 2, resource: (this.textures[1 - i] as GPUTexture).createView() },
        ],
      }),
    );
    const sampler = device.createSampler({
      label: 'wake',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.sampleBindGroups = [0, 1].map((i) =>
      device.createBindGroup({
        label: `wake-sample-${i}`,
        layout: sampleLayout,
        entries: [
          { binding: 0, resource: { buffer: sampleUniforms } },
          { binding: 1, resource: (this.textures[i] as GPUTexture).createView() },
          { binding: 2, resource: sampler },
        ],
      }),
    );
    const f = this.updateFloats;
    f[6] = WAKE_CONFIG.maxFoam;
    f[8] = WAKE_CONFIG.cellSizeM;
    f[9] = WAKE_CONFIG.textureSize;
  }

  static async create(device: GPUDevice): Promise<WakeFoam> {
    const module = await createShaderModule(device, composeWgsl('wake', [WGSL.wake]));
    const C = GPUShaderStage.COMPUTE;
    const updateLayout = device.createBindGroupLayout({
      label: 'wake-update',
      entries: [
        uniformEntry(0, C, UPDATE_UNIFORM_BYTES),
        textureEntry(1, C, 'unfilterable-float', '2d'),
        storageTextureEntry(2, WAKE_FORMAT, '2d'),
      ],
    });
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const sampleLayout = device.createBindGroupLayout({
      label: 'wake-sample',
      entries: [uniformEntry(0, VF, SAMPLE_UNIFORM_BYTES), textureEntry(1, VF, 'float', '2d'), samplerEntry(2, VF)],
    });
    const pipeline = await device.createComputePipelineAsync({
      label: 'wake',
      layout: device.createPipelineLayout({ label: 'wake', bindGroupLayouts: [updateLayout] }),
      compute: { module, entryPoint: 'main' },
    });
    const updateUniforms = device.createBuffer({
      label: 'wake-update-uniforms',
      size: UPDATE_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const sampleUniforms = device.createBuffer({
      label: 'wake-sample-uniforms',
      size: SAMPLE_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    return new WakeFoam(device, pipeline, updateLayout, sampleLayout, updateUniforms, sampleUniforms);
  }

  /** World XZ of the window's lower corner (m). */
  get windowOriginX(): number {
    return this.originX;
  }

  get windowOriginZ(): number {
    return this.originZ;
  }

  /** Bind group for sampling the latest field (ocean @group(2)). */
  get sampleBindGroup(): GPUBindGroup {
    return this.sampleBindGroups[this.current] as GPUBindGroup;
  }

  /**
   * Records one update: centres the window on (centreX, centreZ), advances the
   * field by `dt` and adds the emitters' foam.
   */
  encode(
    encoder: GPUCommandEncoder,
    centreX: number,
    centreZ: number,
    dt: number,
    emitters: readonly WakeEmitter[],
    timestampWrites?: GPUComputePassTimestampWrites,
  ): void {
    const c = WAKE_CONFIG;
    const n = c.textureSize;
    const cellX = Math.floor(centreX / c.cellSizeM) - n / 2;
    const cellZ = Math.floor(centreZ / c.cellSizeM) - n / 2;
    const ints = this.updateInts;
    const f = this.updateFloats;
    const previousX = this.hasOrigin ? Math.round(this.originX / c.cellSizeM) : cellX;
    const previousZ = this.hasOrigin ? Math.round(this.originZ / c.cellSizeM) : cellZ;
    ints[0] = cellX;
    ints[1] = cellZ;
    // Before the first update the previous window is far away, so everything starts empty.
    ints[2] = this.hasOrigin ? previousX : cellX + 2 * n;
    ints[3] = this.hasOrigin ? previousZ : cellZ + 2 * n;
    this.originX = cellX * c.cellSizeM;
    this.originZ = cellZ * c.cellSizeM;
    this.hasOrigin = true;

    f[4] = Math.exp(-dt / c.decayTimeS);
    f[5] = Math.min(c.maxDiffusionNumber, (c.diffusivityM2PerS * dt) / (c.cellSizeM * c.cellSizeM));
    f[10] = Math.exp(-dt / c.freshDecayTimeS);
    const count = this.enabled ? Math.min(emitters.length, WAKE_MAX_EMITTERS) : 0;
    f[7] = count;
    const segments = 12;
    const shapes = segments + 4 * WAKE_MAX_EMITTERS;
    for (let i = 0; i < count; i++) {
      const e = emitters[i] as WakeEmitter;
      f[segments + 4 * i] = e.x0 - this.originX;
      f[segments + 4 * i + 1] = e.z0 - this.originZ;
      f[segments + 4 * i + 2] = e.x1 - this.originX;
      f[segments + 4 * i + 3] = e.z1 - this.originZ;
      f[shapes + 4 * i] = e.radiusM;
      f[shapes + 4 * i + 1] = e.amount;
    }
    this.device.queue.writeBuffer(this.updateUniforms, 0, this.updateData);

    const pass = encoder.beginComputePass({ label: 'wake', timestampWrites });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.updateBindGroups[this.current] as GPUBindGroup);
    const groups = Math.ceil(n / WORKGROUP_SIZE);
    pass.dispatchWorkgroups(groups, groups);
    pass.end();
    this.current = 1 - this.current;
  }

  /** Uniforms for sampling from a camera at (cameraX, cameraZ). */
  prepareDraw(cameraX: number, cameraZ: number): void {
    const c = WAKE_CONFIG;
    const size = c.textureSize * c.cellSizeM;
    const d = this.sampleData;
    d[0] = wrapPeriodic(cameraX, size);
    d[1] = wrapPeriodic(cameraZ, size);
    d[2] = size;
    d[3] = 1;
    d[4] = this.originX - cameraX;
    d[5] = this.originZ - cameraZ;
    d[6] = c.edgeFadeM;
    d[7] = this.enabled && this.hasOrigin ? 1 : 0;
    this.device.queue.writeBuffer(this.sampleUniforms, 0, d);
  }

  dispose(): void {
    for (const texture of this.textures) texture.destroy();
    this.updateUniforms.destroy();
    this.sampleUniforms.destroy();
  }
}
