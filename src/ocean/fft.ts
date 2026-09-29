import { storageTextureEntry, textureEntry } from '../core/bindings';
import { composeWgsl, createShaderModule } from '../core/shader';
import { WGSL } from '../shaders';

/** Largest FFT size supported: 2N vec4 values must fit the 16 KiB default workgroup storage. */
export const MAX_FFT_SIZE = 512;
/** Default maxComputeInvocationsPerWorkgroup. */
const MAX_WORKGROUP_SIZE = 256;
const FFT_TEXTURE_FORMAT: GPUTextureFormat = 'rgba32float';

/**
 * 2D inverse FFT over all layers of an rgba32float texture array (two complex
 * values per texel): a row pass into a scratch array, then a column pass back
 * into the source. See shaders/fft.wgsl and ocean/fftReference.ts.
 */
export class FftPass {
  private constructor(
    private readonly rowPipeline: GPUComputePipeline,
    private readonly columnPipeline: GPUComputePipeline,
    private readonly rowBindGroup: GPUBindGroup,
    private readonly columnBindGroup: GPUBindGroup,
    private readonly size: number,
    private readonly layers: number,
  ) {}

  /**
   * @param data Texture array holding the spectra; receives the spatial fields.
   * @param scratch Texture array of the same size used between the passes.
   */
  static async create(
    device: GPUDevice,
    size: number,
    layers: number,
    data: GPUTexture,
    scratch: GPUTexture,
  ): Promise<FftPass> {
    if (size < 2 || size > MAX_FFT_SIZE || (size & (size - 1)) !== 0) {
      throw new RangeError(`FFT size must be a power of two in 2..${MAX_FFT_SIZE}, got ${size}`);
    }
    const module = await createShaderModule(device, composeWgsl('fft', [WGSL.fft]));
    const layout = device.createBindGroupLayout({
      label: 'fft',
      entries: [
        textureEntry(0, GPUShaderStage.COMPUTE, 'unfilterable-float'),
        storageTextureEntry(1, FFT_TEXTURE_FORMAT),
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ label: 'fft', bindGroupLayouts: [layout] });
    const constants = {
      FFT_SIZE: size,
      LOG2_FFT_SIZE: Math.log2(size),
      WORKGROUP_SIZE: Math.min(size / 2, MAX_WORKGROUP_SIZE),
    };
    const [rowPipeline, columnPipeline] = await Promise.all(
      [0, 1].map((columnPass) =>
        device.createComputePipelineAsync({
          label: columnPass ? 'fft-columns' : 'fft-rows',
          layout: pipelineLayout,
          compute: { module, entryPoint: 'main', constants: { ...constants, COLUMN_PASS: columnPass } },
        }),
      ),
    );
    const dataView = data.createView({ dimension: '2d-array' });
    const scratchView = scratch.createView({ dimension: '2d-array' });
    const rowBindGroup = device.createBindGroup({
      label: 'fft-rows',
      layout,
      entries: [
        { binding: 0, resource: dataView },
        { binding: 1, resource: scratchView },
      ],
    });
    const columnBindGroup = device.createBindGroup({
      label: 'fft-columns',
      layout,
      entries: [
        { binding: 0, resource: scratchView },
        { binding: 1, resource: dataView },
      ],
    });
    return new FftPass(
      rowPipeline as GPUComputePipeline,
      columnPipeline as GPUComputePipeline,
      rowBindGroup,
      columnBindGroup,
      size,
      layers,
    );
  }

  encode(pass: GPUComputePassEncoder): void {
    pass.setPipeline(this.rowPipeline);
    pass.setBindGroup(0, this.rowBindGroup);
    pass.dispatchWorkgroups(this.size, this.layers);
    pass.setPipeline(this.columnPipeline);
    pass.setBindGroup(0, this.columnBindGroup);
    pass.dispatchWorkgroups(this.size, this.layers);
  }
}
