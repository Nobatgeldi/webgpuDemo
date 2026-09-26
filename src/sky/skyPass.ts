import { composeWgsl, createShaderModule } from '../core/shader';
import type { FrameUniforms } from '../render/frameUniforms';
import { DEPTH_COMPARE_FAR_PLANE, DEPTH_FORMAT, HDR_FORMAT } from '../render/renderConfig';
import { WGSL } from '../shaders';

/**
 * Draws the sky as a full-screen triangle at the far plane. Recorded after the
 * opaque geometry so the fragment shader only runs where nothing was drawn.
 */
export class SkyPass {
  private constructor(private readonly pipeline: GPURenderPipeline) {}

  static async create(device: GPUDevice, frameUniforms: FrameUniforms): Promise<SkyPass> {
    const shader = composeWgsl('sky', [WGSL.frame, WGSL.common, WGSL.skyCommon, WGSL.sky]);
    const module = await createShaderModule(device, shader);
    const pipeline = await device.createRenderPipelineAsync({
      label: 'sky',
      layout: device.createPipelineLayout({
        label: 'sky',
        bindGroupLayouts: [frameUniforms.bindGroupLayout],
      }),
      vertex: { module, entryPoint: 'vsMain' },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: DEPTH_COMPARE_FAR_PLANE,
      },
    });
    return new SkyPass(pipeline);
  }

  /** Records the draw into a scene pass whose bind group 0 is already set to the frame uniforms. */
  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.draw(3);
  }
}
