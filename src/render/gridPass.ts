import { composeWgsl, createShaderModule } from '../core/shader';
import { WGSL } from '../shaders';
import type { FrameUniforms } from './frameUniforms';
import { DEPTH_COMPARE_CLOSER, DEPTH_FORMAT, HDR_FORMAT } from './renderConfig';

/** Vertices of the two triangles forming the grid quad (generated in the vertex shader). */
const GRID_VERTEX_COUNT = 6;

/**
 * Debug reference grid on the sea-level plane (1 m / 10 m / 100 m lines, red
 * X axis, blue Z axis). Useful to judge scale, camera-relative precision and,
 * later, wave displacement relative to y = 0.
 */
export class GridPass {
  private constructor(private readonly pipeline: GPURenderPipeline) {}

  static async create(device: GPUDevice, frameUniforms: FrameUniforms): Promise<GridPass> {
    const shader = composeWgsl('grid', [WGSL.frame, WGSL.common, WGSL.skyCommon, WGSL.grid]);
    const module = await createShaderModule(device, shader);
    const pipeline = await device.createRenderPipelineAsync({
      label: 'grid',
      layout: device.createPipelineLayout({
        label: 'grid',
        bindGroupLayouts: [frameUniforms.bindGroupLayout],
      }),
      vertex: { module, entryPoint: 'vsMain' },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: DEPTH_COMPARE_CLOSER,
      },
    });
    return new GridPass(pipeline);
  }

  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.draw(GRID_VERTEX_COUNT);
  }
}
