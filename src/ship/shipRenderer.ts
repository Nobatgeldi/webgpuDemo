import { uniformEntry } from '../core/bindings';
import { composeWgsl, createShaderModule } from '../core/shader';
import type { FrameUniforms } from '../render/frameUniforms';
import { DEPTH_COMPARE_CLOSER, DEPTH_FORMAT, HDR_FORMAT } from '../render/renderConfig';
import { SCENE_PRELUDE, WGSL } from '../shaders';
import { rotate } from './rigidBody';
import { SHIP_VERTEX_FLOATS, type ShipVisualMesh } from './shipMesh';

const UNIFORM_BYTES = 64;

/** Pose used for drawing (interpolated between physics steps). */
export interface ShipRenderPose {
  /** World position of the centre of gravity. */
  readonly position: ArrayLike<number>;
  /** Body-to-world rotation quaternion (w, x, y, z). */
  readonly orientation: ArrayLike<number>;
}

/** Draws the vessel's visual mesh. */
export class ShipRenderer {
  private readonly model = new Float32Array(16);
  private readonly column = new Float64Array(3);

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPURenderPipeline,
    private readonly bindGroup: GPUBindGroup,
    private readonly uniformBuffer: GPUBuffer,
    private readonly vertexBuffer: GPUBuffer,
    private readonly indexBuffer: GPUBuffer,
    private readonly indexCount: number,
    /** Centre of gravity in the hull frame. */
    private readonly centreOfGravity: readonly number[],
  ) {}

  static async create(
    device: GPUDevice,
    frameUniforms: FrameUniforms,
    mesh: ShipVisualMesh,
    centreOfGravity: readonly number[],
  ): Promise<ShipRenderer> {
    const module = await createShaderModule(device, composeWgsl('ship', [...SCENE_PRELUDE, WGSL.ship]));
    const layout = device.createBindGroupLayout({
      label: 'ship',
      entries: [uniformEntry(0, GPUShaderStage.VERTEX, UNIFORM_BYTES)],
    });
    const pipeline = await device.createRenderPipelineAsync({
      label: 'ship',
      layout: device.createPipelineLayout({ label: 'ship', bindGroupLayouts: [frameUniforms.bindGroupLayout, layout] }),
      vertex: {
        module,
        entryPoint: 'vsMain',
        buffers: [
          {
            arrayStride: SHIP_VERTEX_FLOATS * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: DEPTH_COMPARE_CLOSER },
    });
    const uniformBuffer = device.createBuffer({
      label: 'ship-uniforms',
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const vertexBuffer = device.createBuffer({
      label: 'ship-vertices',
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, mesh.vertices);
    const indexBuffer = device.createBuffer({
      label: 'ship-indices',
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indexBuffer, 0, mesh.indices);
    const bindGroup = device.createBindGroup({
      label: 'ship',
      layout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });
    return new ShipRenderer(device, pipeline, bindGroup, uniformBuffer, vertexBuffer, indexBuffer, mesh.indices.length, centreOfGravity);
  }

  /** Updates the model matrix: hull frame -> camera-relative world, computed in double precision. */
  update(pose: ShipRenderPose, cameraPosition: ArrayLike<number>): void {
    const m = this.model;
    const q = pose.orientation;
    for (let axis = 0; axis < 3; axis++) {
      const basis = [0, 0, 0];
      basis[axis] = 1;
      rotate(q, basis, this.column, false);
      m[axis * 4] = this.column[0] as number;
      m[axis * 4 + 1] = this.column[1] as number;
      m[axis * 4 + 2] = this.column[2] as number;
      m[axis * 4 + 3] = 0;
    }
    // Translation: R (-cog) + (position - camera).
    rotate(q, [-this.centreOfGravity[0]!, -this.centreOfGravity[1]!, -this.centreOfGravity[2]!], this.column, false);
    for (let i = 0; i < 3; i++) {
      m[12 + i] = (this.column[i] as number) + ((pose.position[i] as number) - (cameraPosition[i] as number));
    }
    m[15] = 1;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, m);
  }

  /** Records the draw; bind group 0 (frame resources) must already be set. */
  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(1, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    pass.drawIndexed(this.indexCount);
  }
}
