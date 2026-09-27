/**
 * Spray particles on the GPU (shaders/spray.wgsl, sprayRender.wgsl): a ring
 * buffer of particles spawned from the ship's spray emitters, advanced by a
 * compute pass (gravity, drag towards the wind, killed on the water surface)
 * and drawn as soft, sunlit sprites after the sky.
 */
import { samplerEntry, storageBufferEntry, textureEntry, uniformEntry } from '../core/bindings';
import { wrapPeriodic } from '../core/cameraRelative';
import { GRAVITY_M_S2 } from '../core/constants';
import { composeWgsl, createShaderModule } from '../core/shader';
import type { FrameUniforms } from '../render/frameUniforms';
import { DEPTH_COMPARE_CLOSER, DEPTH_FORMAT, HDR_FORMAT } from '../render/renderConfig';
import { SCENE_PRELUDE, WGSL } from '../shaders';
import { MAX_SPRAY_EMITTERS, type SprayEmitter } from './shipEffectSources';

export const SPRAY_CONFIG = {
  /** Particles alive at most. */
  capacity: 16384,
  /** Spawned per emitter and frame at most (bursts beyond this are dropped). */
  maxSpawnPerEmitterFrame: 1024,
  /** Lifetime range (s); most particles fall back into the sea earlier. */
  lifetimeMinS: 1.5,
  lifetimeMaxS: 3.5,
  /**
   * Drag relaxation time towards the wind (s): small droplets follow the air
   * almost at once, big ones fly ballistically.
   */
  dragTimeMinS: 0.4,
  dragTimeMaxS: 2.5,
  /** Height at which the wind acting on the spray is evaluated (m). */
  windHeightM: 5,
  /** Sprite radius at birth and at the end of life (m): the cloud disperses. */
  spriteRadiusStartM: 0.12,
  spriteRadiusEndM: 0.7,
  /** Opacity of a fresh sprite at its centre. */
  opacity: 0.45,
  /** Albedo of the droplet cloud and share of sunlight given the forward-scattering phase. */
  albedo: 0.9,
  forwardScattering: 0.5,
  /** The particle origin snaps to this grid; it moves when the ship leaves the cell (m). */
  originGridM: 64,
} as const;

const PARTICLE_BYTES = 32;
const UPDATE_UNIFORM_BYTES = 304;
const RENDER_UNIFORM_BYTES = 32;
const WORKGROUP_SIZE = 64;
const VERTICES_PER_SPRITE = 6;
/** Offsets in floats of SprayUpdateUniforms (shaders/spray.wgsl); verified by tests. */
export const SPRAY_UPDATE_UNIFORM_OFFSETS = {
  ocean: 0,
  shift: 12,
  wind: 16,
  params: 20,
  variation: 24,
  emitterPositions: 28,
  emitterVelocities: 44,
  emitterRanges: 60,
} as const;
export { UPDATE_UNIFORM_BYTES as SPRAY_UPDATE_UNIFORM_BYTES };

export class SprayParticles {
  enabled = true;
  private readonly updateData = new ArrayBuffer(UPDATE_UNIFORM_BYTES);
  private readonly updateFloats = new Float32Array(this.updateData);
  private readonly updateUints = new Uint32Array(this.updateData);
  private readonly renderData = new Float32Array(RENDER_UNIFORM_BYTES / 4);
  private readonly pending = new Float64Array(MAX_SPRAY_EMITTERS);
  private cursor = 0;
  private seed = 1;
  private originX = 0;
  private originZ = 0;
  private hasOrigin = false;
  /** Particles spawned since start (for the debug overlay). */
  spawnedTotal = 0;

  private constructor(
    private readonly device: GPUDevice,
    private readonly updatePipeline: GPUComputePipeline,
    private readonly renderPipeline: GPURenderPipeline,
    private readonly updateBindGroup: GPUBindGroup,
    private readonly renderBindGroup: GPUBindGroup,
    private readonly updateUniforms: GPUBuffer,
    private readonly renderUniforms: GPUBuffer,
    private readonly particleBuffer: GPUBuffer,
    private readonly patchSizes: readonly number[],
  ) {
    const f = this.updateFloats;
    const o = SPRAY_UPDATE_UNIFORM_OFFSETS;
    for (let c = 0; c < 3; c++) f[o.ocean + 8 + c] = patchSizes[c] ?? 1;
    f[o.ocean + 11] = patchSizes.length;
    f[o.wind + 3] = GRAVITY_M_S2;
    f[o.params] = SPRAY_CONFIG.capacity;
    f[o.variation] = SPRAY_CONFIG.lifetimeMinS;
    f[o.variation + 1] = SPRAY_CONFIG.lifetimeMaxS;
    f[o.variation + 2] = SPRAY_CONFIG.dragTimeMinS;
    f[o.variation + 3] = SPRAY_CONFIG.dragTimeMaxS;
    const r = this.renderData;
    r[3] = SPRAY_CONFIG.opacity;
    r[4] = SPRAY_CONFIG.spriteRadiusStartM;
    r[5] = SPRAY_CONFIG.spriteRadiusEndM;
    r[6] = SPRAY_CONFIG.albedo;
    r[7] = SPRAY_CONFIG.forwardScattering;
  }

  static async create(
    device: GPUDevice,
    frameUniforms: FrameUniforms,
    displacement: { readonly texture: GPUTexture; readonly patchSizes: readonly number[] },
  ): Promise<SprayParticles> {
    const C = GPUShaderStage.COMPUTE;
    const updateLayout = device.createBindGroupLayout({
      label: 'spray-update',
      entries: [
        uniformEntry(0, C, UPDATE_UNIFORM_BYTES),
        storageBufferEntry(1, C),
        textureEntry(2, C, 'float'),
        samplerEntry(3, C),
      ],
    });
    const renderLayout = device.createBindGroupLayout({
      label: 'spray-render',
      entries: [
        uniformEntry(0, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, RENDER_UNIFORM_BYTES),
        storageBufferEntry(1, GPUShaderStage.VERTEX, 'read-only-storage'),
      ],
    });
    const [updateModule, renderModule] = await Promise.all([
      createShaderModule(device, composeWgsl('spray-update', [WGSL.oceanSampling, WGSL.sprayCommon, WGSL.spray])),
      createShaderModule(device, composeWgsl('spray-render', [...SCENE_PRELUDE, WGSL.sprayCommon, WGSL.sprayRender])),
    ]);
    const [updatePipeline, renderPipeline] = await Promise.all([
      device.createComputePipelineAsync({
        label: 'spray-update',
        layout: device.createPipelineLayout({ label: 'spray-update', bindGroupLayouts: [updateLayout] }),
        compute: { module: updateModule, entryPoint: 'csUpdate' },
      }),
      device.createRenderPipelineAsync({
        label: 'spray-render',
        layout: device.createPipelineLayout({
          label: 'spray-render',
          bindGroupLayouts: [frameUniforms.bindGroupLayout, renderLayout],
        }),
        vertex: { module: renderModule, entryPoint: 'vsMain' },
        fragment: {
          module: renderModule,
          entryPoint: 'fsMain',
          targets: [
            {
              format: HDR_FORMAT,
              // Premultiplied alpha.
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: DEPTH_COMPARE_CLOSER },
      }),
    ]);
    const updateUniforms = device.createBuffer({
      label: 'spray-update-uniforms',
      size: UPDATE_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const renderUniforms = device.createBuffer({
      label: 'spray-render-uniforms',
      size: RENDER_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Zero-initialised: age 0 >= lifetime 0, so every particle starts dead.
    const particleBuffer = device.createBuffer({
      label: 'spray-particles',
      size: SPRAY_CONFIG.capacity * PARTICLE_BYTES,
      usage: GPUBufferUsage.STORAGE,
    });
    const sampler = device.createSampler({
      label: 'spray-water',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const updateBindGroup = device.createBindGroup({
      label: 'spray-update',
      layout: updateLayout,
      entries: [
        { binding: 0, resource: { buffer: updateUniforms } },
        { binding: 1, resource: { buffer: particleBuffer } },
        { binding: 2, resource: displacement.texture.createView({ dimension: '2d-array' }) },
        { binding: 3, resource: sampler },
      ],
    });
    const renderBindGroup = device.createBindGroup({
      label: 'spray-render',
      layout: renderLayout,
      entries: [
        { binding: 0, resource: { buffer: renderUniforms } },
        { binding: 1, resource: { buffer: particleBuffer } },
      ],
    });
    return new SprayParticles(
      device,
      updatePipeline,
      renderPipeline,
      updateBindGroup,
      renderBindGroup,
      updateUniforms,
      renderUniforms,
      particleBuffer,
      displacement.patchSizes,
    );
  }

  /**
   * Records one simulation step of `dt` seconds: spawns this frame's particles
   * from `emitters`. The particle origin follows (centreX, centreZ). The wind
   * is the true 10 m wind (world x, z) scaled to the spray height.
   */
  encode(
    encoder: GPUCommandEncoder,
    centreX: number,
    centreZ: number,
    dt: number,
    emitters: readonly SprayEmitter[],
    emitterCount: number,
    wind: { readonly x: number; readonly z: number; readonly heightScale: number },
    timestampWrites?: GPUComputePassTimestampWrites,
  ): void {
    const c = SPRAY_CONFIG;
    const o = SPRAY_UPDATE_UNIFORM_OFFSETS;
    const f = this.updateFloats;
    const u = this.updateUints;
    const grid = c.originGridM;
    const originX = Math.round(centreX / grid) * grid;
    const originZ = Math.round(centreZ / grid) * grid;
    f[o.shift] = this.hasOrigin ? originX - this.originX : 0;
    f[o.shift + 1] = 0;
    f[o.shift + 2] = this.hasOrigin ? originZ - this.originZ : 0;
    f[o.shift + 3] = dt;
    this.originX = originX;
    this.originZ = originZ;
    this.hasOrigin = true;
    for (let cascade = 0; cascade < 3; cascade++) {
      const size = this.patchSizes[cascade] ?? 1;
      f[o.ocean + 2 * cascade] = wrapPeriodic(originX, size);
      f[o.ocean + 2 * cascade + 1] = wrapPeriodic(originZ, size);
    }
    f[o.wind] = wind.x * wind.heightScale;
    f[o.wind + 1] = 0;
    f[o.wind + 2] = wind.z * wind.heightScale;

    let count = 0;
    if (this.enabled && dt > 0) {
      for (let i = 0; i < Math.min(emitterCount, MAX_SPRAY_EMITTERS); i++) {
        const e = emitters[i] as SprayEmitter;
        this.pending[i] = (this.pending[i] as number) + e.particles;
        const spawn = Math.min(Math.floor(this.pending[i] as number), c.maxSpawnPerEmitterFrame);
        this.pending[i] = (this.pending[i] as number) - Math.floor(this.pending[i] as number);
        if (spawn <= 0) continue;
        f[o.emitterPositions + 4 * count] = (e.position[0] as number) - originX;
        f[o.emitterPositions + 4 * count + 1] = e.position[1] as number;
        f[o.emitterPositions + 4 * count + 2] = (e.position[2] as number) - originZ;
        f[o.emitterPositions + 4 * count + 3] = e.radiusM;
        f[o.emitterVelocities + 4 * count] = e.velocity[0] as number;
        f[o.emitterVelocities + 4 * count + 1] = e.velocity[1] as number;
        f[o.emitterVelocities + 4 * count + 2] = e.velocity[2] as number;
        f[o.emitterVelocities + 4 * count + 3] = e.speedSpreadMs;
        u[o.emitterRanges + 4 * count] = this.cursor;
        u[o.emitterRanges + 4 * count + 1] = spawn;
        this.cursor = (this.cursor + spawn) % c.capacity;
        this.spawnedTotal += spawn;
        count++;
      }
    }
    f[o.params + 1] = count;
    this.seed = (this.seed + 1) % 0x7fffff;
    f[o.params + 2] = this.seed;
    this.device.queue.writeBuffer(this.updateUniforms, 0, this.updateData);

    const pass = encoder.beginComputePass({ label: 'spray-update', timestampWrites });
    pass.setPipeline(this.updatePipeline);
    pass.setBindGroup(0, this.updateBindGroup);
    pass.dispatchWorkgroups(Math.ceil(c.capacity / WORKGROUP_SIZE));
    pass.end();
  }

  prepareDraw(cameraPosition: ArrayLike<number>): void {
    const r = this.renderData;
    r[0] = this.originX - (cameraPosition[0] as number);
    r[1] = -(cameraPosition[1] as number);
    r[2] = this.originZ - (cameraPosition[2] as number);
    this.device.queue.writeBuffer(this.renderUniforms, 0, r);
  }

  /** Records the sprites; bind group 0 (frame resources) must already be set. */
  draw(pass: GPURenderPassEncoder): void {
    if (!this.enabled) return;
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(1, this.renderBindGroup);
    pass.draw(VERTICES_PER_SPRITE, SPRAY_CONFIG.capacity);
  }

  dispose(): void {
    this.particleBuffer.destroy();
    this.updateUniforms.destroy();
    this.renderUniforms.destroy();
  }
}
