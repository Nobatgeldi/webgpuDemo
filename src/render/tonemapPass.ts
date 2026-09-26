import { composeWgsl, createShaderModule } from '../core/shader';
import { WGSL } from '../shaders';

export type ToneMapper = 'aces' | 'agx';

const TONEMAPPER_IDS: Record<ToneMapper, number> = { aces: 0, agx: 1 };
const TONEMAP_UNIFORM_BYTES = 16;

export interface TonemapSettings {
  /** Exposure compensation in stops. */
  readonly exposureEv: number;
  readonly toneMapper: ToneMapper;
  /** Dither amplitude in 8-bit code values; 0 disables dithering. */
  readonly ditherLsb: number;
}

/**
 * Resolves the HDR scene target to the swap chain: exposure, tone mapping,
 * sRGB encoding and dithering.
 */
export class TonemapPass {
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new ArrayBuffer(TONEMAP_UNIFORM_BYTES);
  private readonly uniformFloats = new Float32Array(this.uniformData);
  private readonly uniformUints = new Uint32Array(this.uniformData);
  private bindGroup: GPUBindGroup | null = null;
  private boundHdrView: GPUTextureView | null = null;

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPURenderPipeline,
    private readonly bindGroupLayout: GPUBindGroupLayout,
  ) {
    this.uniformBuffer = device.createBuffer({
      label: 'tonemap-uniforms',
      size: TONEMAP_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  static async create(device: GPUDevice, outputFormat: GPUTextureFormat): Promise<TonemapPass> {
    const shader = composeWgsl('tonemap', [WGSL.common, WGSL.tonemap]);
    const module = await createShaderModule(device, shader);
    const bindGroupLayout = device.createBindGroupLayout({
      label: 'tonemap',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: TONEMAP_UNIFORM_BYTES },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
      ],
    });
    const pipeline = await device.createRenderPipelineAsync({
      label: 'tonemap',
      layout: device.createPipelineLayout({ label: 'tonemap', bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module, entryPoint: 'vsMain' },
      fragment: {
        module,
        entryPoint: 'fsMain',
        targets: [{ format: outputFormat }],
        // Swap chains are normally non-sRGB 8-bit formats; encode in the shader then.
        constants: { MANUAL_SRGB_ENCODE: outputFormat.endsWith('-srgb') ? 0 : 1 },
      },
      primitive: { topology: 'triangle-list' },
    });
    return new TonemapPass(device, pipeline, bindGroupLayout);
  }

  /** Uploads per-frame parameters. */
  update(settings: TonemapSettings, frameIndex: number): void {
    this.uniformFloats[0] = Math.pow(2, settings.exposureEv);
    this.uniformUints[1] = TONEMAPPER_IDS[settings.toneMapper];
    this.uniformFloats[2] = settings.ditherLsb;
    this.uniformUints[3] = frameIndex >>> 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
  }

  /** Records a render pass from `hdrView` into `outputView`. */
  encode(
    encoder: GPUCommandEncoder,
    hdrView: GPUTextureView,
    outputView: GPUTextureView,
    timestampWrites: GPURenderPassTimestampWrites | undefined,
  ): void {
    if (this.boundHdrView !== hdrView || !this.bindGroup) {
      // Only happens after a resize; never per frame.
      this.bindGroup = this.device.createBindGroup({
        label: 'tonemap',
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: hdrView },
        ],
      });
      this.boundHdrView = hdrView;
    }
    const pass = encoder.beginRenderPass({
      label: 'tonemap',
      colorAttachments: [{ view: outputView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      timestampWrites,
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
  }
}
