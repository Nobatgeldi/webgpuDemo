import { textureEntry, uniformEntry } from '../core/bindings';
import { composeWgsl, createShaderModule } from '../core/shader';
import { WGSL } from '../shaders';

/** Textures the viewer can show (panel: "Doku görüntüleyici"). */
export type DebugTextureName =
  | 'none'
  | 'spectrum'
  | 'displacement'
  | 'derivatives'
  | 'foam'
  | 'skyView'
  | 'transmittance';

export interface DebugTextureSources {
  readonly spectrum: GPUTexture;
  readonly displacement: GPUTexture;
  readonly derivatives: GPUTexture;
  readonly foam: readonly GPUTexture[];
  readonly skyView: GPUTexture;
  readonly transmittance: GPUTexture;
}

// Must match the VIEW_* constants in shaders/debugTexture.wgsl.
const MODE_IDS: Record<Exclude<DebugTextureName, 'none'>, number> = {
  spectrum: 0,
  displacement: 1,
  derivatives: 2,
  foam: 3,
  skyView: 4,
  transmittance: 4,
};
const UNIFORM_BYTES = 48;
/** Side of the view rectangle as a fraction of the viewport height. */
const VIEW_SIZE_FRACTION = 0.4;
/** Distance of the rectangle from the right and bottom edges (px). */
const VIEW_MARGIN_PX = 12;
/** Value scales: displacement by 1/(2 Hs), slopes x2, LUT radiance x4. */
const SLOPE_SCALE = 2;
const LUT_SCALE = 4;

export interface DebugTextureRequest {
  readonly name: DebugTextureName;
  readonly cascade: number;
  readonly currentFoamIndex: number;
  readonly significantWaveHeightM: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/** Shows a simulation texture (FFT spectrum, displacement, ...) in a screen corner. */
export class DebugTextureView {
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new Float32Array(UNIFORM_BYTES / 4);

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPURenderPipeline,
    private readonly bindGroups: Map<string, GPUBindGroup>,
    uniformBuffer: GPUBuffer,
  ) {
    this.uniformBuffer = uniformBuffer;
  }

  static async create(
    device: GPUDevice,
    outputFormat: GPUTextureFormat,
    sources: DebugTextureSources,
  ): Promise<DebugTextureView> {
    const module = await createShaderModule(device, composeWgsl('debug-texture', [WGSL.common, WGSL.debugTexture]));
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const layout = device.createBindGroupLayout({
      label: 'debug-texture',
      entries: [uniformEntry(0, VF, UNIFORM_BYTES), textureEntry(1, GPUShaderStage.FRAGMENT, 'unfilterable-float')],
    });
    const pipeline = await device.createRenderPipelineAsync({
      label: 'debug-texture',
      layout: device.createPipelineLayout({ label: 'debug-texture', bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vsMain' },
      fragment: {
        module,
        entryPoint: 'fsMain',
        targets: [{ format: outputFormat }],
        constants: { MANUAL_SRGB_ENCODE: outputFormat.endsWith('-srgb') ? 0 : 1 },
      },
      primitive: { topology: 'triangle-list' },
    });
    const uniformBuffer = device.createBuffer({
      label: 'debug-texture',
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroups = new Map<string, GPUBindGroup>();
    const add = (key: string, texture: GPUTexture): void => {
      bindGroups.set(
        key,
        device.createBindGroup({
          label: `debug-texture-${key}`,
          layout,
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: texture.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1 }) },
          ],
        }),
      );
    };
    add('spectrum', sources.spectrum);
    add('displacement', sources.displacement);
    add('derivatives', sources.derivatives);
    sources.foam.forEach((texture, i) => add(`foam${i}`, texture));
    add('skyView', sources.skyView);
    add('transmittance', sources.transmittance);
    return new DebugTextureView(device, pipeline, bindGroups, uniformBuffer);
  }

  /** Draws the requested texture on top of `outputView` (no-op for 'none'). */
  encode(encoder: GPUCommandEncoder, outputView: GPUTextureView, request: DebugTextureRequest): void {
    if (request.name === 'none') {
      return;
    }
    const isCascadeTexture = request.name !== 'skyView' && request.name !== 'transmittance';
    const key = request.name === 'foam' ? `foam${request.currentFoamIndex}` : request.name;
    const bindGroup = this.bindGroups.get(key);
    if (!bindGroup) {
      return;
    }
    const size = Math.round(request.viewportHeight * VIEW_SIZE_FRACTION);
    const width = request.name === 'transmittance' || request.name === 'skyView' ? size * 1.5 : size;
    const d = this.uniformData;
    d[0] = request.viewportWidth - width - VIEW_MARGIN_PX;
    d[1] = request.viewportHeight - size - VIEW_MARGIN_PX;
    d[2] = width;
    d[3] = size;
    d[4] = MODE_IDS[request.name];
    d[5] = isCascadeTexture ? request.cascade : 0;
    d[6] =
      request.name === 'displacement'
        ? 0.5 / Math.max(request.significantWaveHeightM, 0.1)
        : request.name === 'derivatives'
          ? SLOPE_SCALE
          : LUT_SCALE;
    d[8] = request.viewportWidth;
    d[9] = request.viewportHeight;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, d);

    const pass = encoder.beginRenderPass({
      label: 'debug-texture',
      colorAttachments: [{ view: outputView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
  }
}
