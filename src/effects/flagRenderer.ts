/**
 * Draws the flag cloth: the node positions are converted to camera-relative
 * float32 vertices with smooth normals each frame and uploaded into a
 * preallocated vertex buffer.
 */
import { composeWgsl, createShaderModule } from '../core/shader';
import type { FrameUniforms } from '../render/frameUniforms';
import { DEPTH_COMPARE_CLOSER, DEPTH_FORMAT, HDR_FORMAT } from '../render/renderConfig';
import { SCENE_PRELUDE, WGSL } from '../shaders';
import { FLAG_CONFIG, type FlagCloth } from './flagCloth';

/** position (3), normal (3), uv (2) */
const FLAG_VERTEX_FLOATS = 8;

export class FlagRenderer {
  private readonly vertices: Float32Array;
  private readonly normals: Float64Array;
  private readonly world = new Float64Array(3);

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPURenderPipeline,
    private readonly vertexBuffer: GPUBuffer,
    private readonly indexBuffer: GPUBuffer,
    private readonly indexCount: number,
    private readonly cloth: FlagCloth,
  ) {
    const nodes = cloth.columns * cloth.rows;
    this.vertices = new Float32Array(nodes * FLAG_VERTEX_FLOATS);
    this.normals = new Float64Array(nodes * 3);
    // Flag coordinates in hoists: u from the hoist, v from the bottom.
    for (let j = 0; j < cloth.rows; j++) {
      for (let i = 0; i < cloth.columns; i++) {
        const o = cloth.index(i, j) * FLAG_VERTEX_FLOATS;
        this.vertices[o + 6] = ((i / (cloth.columns - 1)) * FLAG_CONFIG.flyM) / FLAG_CONFIG.hoistM;
        this.vertices[o + 7] = j / (cloth.rows - 1);
      }
    }
  }

  static async create(device: GPUDevice, frameUniforms: FrameUniforms, cloth: FlagCloth): Promise<FlagRenderer> {
    const module = await createShaderModule(device, composeWgsl('flag', [...SCENE_PRELUDE, WGSL.flag]));
    const pipeline = await device.createRenderPipelineAsync({
      label: 'flag',
      layout: device.createPipelineLayout({ label: 'flag', bindGroupLayouts: [frameUniforms.bindGroupLayout] }),
      vertex: {
        module,
        entryPoint: 'vsMain',
        buffers: [
          {
            arrayStride: FLAG_VERTEX_FLOATS * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32x2' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: DEPTH_COMPARE_CLOSER },
    });
    const indices: number[] = [];
    for (let j = 0; j + 1 < cloth.rows; j++) {
      for (let i = 0; i + 1 < cloth.columns; i++) {
        const a = cloth.index(i, j);
        const b = cloth.index(i + 1, j);
        const c = cloth.index(i + 1, j + 1);
        const d = cloth.index(i, j + 1);
        indices.push(a, b, c, a, c, d);
      }
    }
    // Buffer writes must be a multiple of 4 bytes: pad to an even index count.
    const indexData = new Uint16Array(indices.length + (indices.length % 2));
    indexData.set(indices);
    const indexBuffer = device.createBuffer({
      label: 'flag-indices',
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indexBuffer, 0, indexData);
    const vertexBuffer = device.createBuffer({
      label: 'flag-vertices',
      size: cloth.columns * cloth.rows * FLAG_VERTEX_FLOATS * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    return new FlagRenderer(device, pipeline, vertexBuffer, indexBuffer, indices.length, cloth);
  }

  /**
   * Uploads the cloth for drawing. `toRender` maps a physics-time world position
   * onto the interpolated render pose of the ship (so the flag stays on the mast).
   */
  update(cameraPosition: ArrayLike<number>, toRender: (world: Float64Array, out: Float64Array) => void): void {
    const { cloth, vertices: v, normals: n } = this;
    const p = cloth.positions;
    n.fill(0);
    for (let j = 0; j + 1 < cloth.rows; j++) {
      for (let i = 0; i + 1 < cloth.columns; i++) {
        const quad = [cloth.index(i, j), cloth.index(i + 1, j), cloth.index(i + 1, j + 1), cloth.index(i, j + 1)] as const;
        for (const [a, b, c] of [
          [quad[0], quad[1], quad[2]],
          [quad[0], quad[2], quad[3]],
        ] as const) {
          const e1 = [0, 1, 2].map((k) => (p[3 * b + k] as number) - (p[3 * a + k] as number)) as [number, number, number];
          const e2 = [0, 1, 2].map((k) => (p[3 * c + k] as number) - (p[3 * a + k] as number)) as [number, number, number];
          const nx = e1[1] * e2[2] - e1[2] * e2[1];
          const ny = e1[2] * e2[0] - e1[0] * e2[2];
          const nz = e1[0] * e2[1] - e1[1] * e2[0];
          for (const node of [a, b, c]) {
            n[3 * node] = (n[3 * node] as number) + nx;
            n[3 * node + 1] = (n[3 * node + 1] as number) + ny;
            n[3 * node + 2] = (n[3 * node + 2] as number) + nz;
          }
        }
      }
    }
    const count = cloth.columns * cloth.rows;
    for (let node = 0; node < count; node++) {
      const o = node * FLAG_VERTEX_FLOATS;
      this.world[0] = p[3 * node] as number;
      this.world[1] = p[3 * node + 1] as number;
      this.world[2] = p[3 * node + 2] as number;
      toRender(this.world, this.world);
      for (let k = 0; k < 3; k++) v[o + k] = (this.world[k] as number) - (cameraPosition[k] as number);
      const length = Math.hypot(n[3 * node] as number, n[3 * node + 1] as number, n[3 * node + 2] as number) || 1;
      for (let k = 0; k < 3; k++) v[o + 3 + k] = (n[3 * node + k] as number) / length;
    }
    this.device.queue.writeBuffer(this.vertexBuffer, 0, v);
  }

  /** Records the draw; bind group 0 (frame resources) must already be set. */
  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint16');
    pass.drawIndexed(this.indexCount);
  }

  dispose(): void {
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
  }
}
