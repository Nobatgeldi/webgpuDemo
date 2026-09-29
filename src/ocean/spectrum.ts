import { storageTextureEntry, textureEntry, uniformEntry } from '../core/bindings';
import { createRandom, deriveSeed, fillGaussian } from '../core/random';
import { composeWgsl, createShaderModule } from '../core/shader';
import { WGSL } from '../shaders';
import { SPECTRUM_SHADER_CONSTANTS } from './spectrumModel';

export const OCEAN_COMPUTE_UNIFORM_BYTES = 128;
const SPECTRUM_WORKGROUP = 8;
const NOISE_CHANNELS = 2;

/** WGSL chunk with the spectrum coefficients generated from the tested CPU model. */
export const SPECTRUM_CONSTANTS_CHUNK = {
  label: 'spectrumConstants (generated from spectrumModel.ts)',
  code: SPECTRUM_SHADER_CONSTANTS,
};

/**
 * Initial spectrum h0(k) for all cascades. The Gaussian noise is generated once
 * from the seed and never changes, so a new wind only rescales amplitudes and
 * the wave pattern does not jump.
 */
export class SpectrumPass {
  readonly h0: GPUTexture;
  private readonly noise: GPUTexture;
  private readonly pipeline: GPUComputePipeline;
  private readonly bindGroup: GPUBindGroup;

  private constructor(
    device: GPUDevice,
    pipeline: GPUComputePipeline,
    layout: GPUBindGroupLayout,
    uniforms: GPUBuffer,
    private readonly size: number,
    private readonly cascades: number,
    seed: number,
  ) {
    this.pipeline = pipeline;
    this.noise = device.createTexture({
      label: 'ocean-noise',
      size: { width: size, height: size, depthOrArrayLayers: cascades },
      format: 'rg32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.h0 = device.createTexture({
      label: 'ocean-h0',
      size: { width: size, height: size, depthOrArrayLayers: cascades },
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    const layer = new Float32Array(size * size * NOISE_CHANNELS);
    for (let c = 0; c < cascades; c++) {
      fillGaussian(layer, createRandom(deriveSeed(seed, c)));
      device.queue.writeTexture(
        { texture: this.noise, origin: { x: 0, y: 0, z: c } },
        layer,
        { bytesPerRow: size * NOISE_CHANNELS * Float32Array.BYTES_PER_ELEMENT, rowsPerImage: size },
        { width: size, height: size, depthOrArrayLayers: 1 },
      );
    }
    this.bindGroup = device.createBindGroup({
      label: 'ocean-spectrum',
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniforms } },
        { binding: 1, resource: this.noise.createView({ dimension: '2d-array' }) },
        { binding: 2, resource: this.h0.createView({ dimension: '2d-array' }) },
      ],
    });
  }

  static async create(
    device: GPUDevice,
    uniforms: GPUBuffer,
    size: number,
    cascades: number,
    seed: number,
  ): Promise<SpectrumPass> {
    const shader = composeWgsl('ocean-spectrum', [
      SPECTRUM_CONSTANTS_CHUNK,
      WGSL.oceanCompute,
      WGSL.oceanSpectrum,
    ]);
    const module = await createShaderModule(device, shader);
    const layout = device.createBindGroupLayout({
      label: 'ocean-spectrum',
      entries: [
        uniformEntry(0, GPUShaderStage.COMPUTE, OCEAN_COMPUTE_UNIFORM_BYTES),
        textureEntry(1, GPUShaderStage.COMPUTE, 'unfilterable-float'),
        storageTextureEntry(2, 'rgba32float'),
      ],
    });
    const pipeline = await device.createComputePipelineAsync({
      label: 'ocean-spectrum',
      layout: device.createPipelineLayout({ label: 'ocean-spectrum', bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: 'main' },
    });
    return new SpectrumPass(device, pipeline, layout, uniforms, size, cascades, seed);
  }

  encode(pass: GPUComputePassEncoder): void {
    const groups = Math.ceil(this.size / SPECTRUM_WORKGROUP);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(groups, groups, this.cascades);
  }

  dispose(): void {
    this.noise.destroy();
    this.h0.destroy();
  }
}
