import { composeWgsl, createShaderModule } from '../core/shader';
import { WGSL } from '../shaders';
import type { FrameUniforms } from './frameUniforms';

/** position (3) + colour (4) */
const VERTEX_FLOATS = 7;
const MAX_LINE_VERTICES = 16_384;
const MAX_TRIANGLE_VERTICES = 12_288;
/** Arrow heads: length as a fraction of the arrow and relative width. */
const ARROW_HEAD_FRACTION = 0.18;
const ARROW_HEAD_WIDTH = 0.35;

export type Rgba = readonly [number, number, number, number];

/**
 * Immediate-mode debug geometry in world space (double precision; converted
 * to camera-relative float32 when added). Buffers are preallocated; geometry
 * beyond the capacity is dropped.
 */
export class DebugDraw {
  private readonly lineData = new Float32Array(MAX_LINE_VERTICES * VERTEX_FLOATS);
  private readonly triangleData = new Float32Array(MAX_TRIANGLE_VERTICES * VERTEX_FLOATS);
  private lineCount = 0;
  private triangleCount = 0;
  private cameraX = 0;
  private cameraY = 0;
  private cameraZ = 0;

  private constructor(
    private readonly device: GPUDevice,
    private readonly linePipeline: GPURenderPipeline,
    private readonly trianglePipeline: GPURenderPipeline,
    private readonly lineBuffer: GPUBuffer,
    private readonly triangleBuffer: GPUBuffer,
    private readonly frameBindGroup: GPUBindGroup,
  ) {}

  static async create(device: GPUDevice, frameUniforms: FrameUniforms, outputFormat: GPUTextureFormat): Promise<DebugDraw> {
    const module = await createShaderModule(device, composeWgsl('debug-draw', [WGSL.frame, WGSL.debugDraw]));
    const layout = device.createPipelineLayout({ label: 'debug-draw', bindGroupLayouts: [frameUniforms.bindGroupLayout] });
    const pipeline = (topology: GPUPrimitiveTopology): Promise<GPURenderPipeline> =>
      device.createRenderPipelineAsync({
        label: `debug-draw-${topology}`,
        layout,
        vertex: {
          module,
          entryPoint: 'vsMain',
          buffers: [
            {
              arrayStride: VERTEX_FLOATS * 4,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x4' },
              ],
            },
          ],
        },
        fragment: {
          module,
          entryPoint: 'fsMain',
          targets: [
            {
              format: outputFormat,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            },
          ],
          constants: { MANUAL_SRGB_ENCODE: outputFormat.endsWith('-srgb') ? 0 : 1 },
        },
        primitive: { topology },
      });
    const [linePipeline, trianglePipeline] = await Promise.all([pipeline('line-list'), pipeline('triangle-list')]);
    const buffer = (label: string, vertices: number): GPUBuffer =>
      device.createBuffer({ label, size: vertices * VERTEX_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    return new DebugDraw(
      device,
      linePipeline,
      trianglePipeline,
      buffer('debug-lines', MAX_LINE_VERTICES),
      buffer('debug-triangles', MAX_TRIANGLE_VERTICES),
      frameUniforms.bindGroup,
    );
  }

  /** Starts a new frame of geometry relative to the camera position. */
  begin(cameraPosition: ArrayLike<number>): void {
    this.lineCount = 0;
    this.triangleCount = 0;
    this.cameraX = cameraPosition[0] as number;
    this.cameraY = cameraPosition[1] as number;
    this.cameraZ = cameraPosition[2] as number;
  }

  line(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: Rgba): void {
    if (this.lineCount + 2 > MAX_LINE_VERTICES) return;
    this.push(this.lineData, this.lineCount++, ax, ay, az, color);
    this.push(this.lineData, this.lineCount++, bx, by, bz, color);
  }

  /** Arrow from a world point along a vector (m). */
  arrow(px: number, py: number, pz: number, vx: number, vy: number, vz: number, color: Rgba): void {
    const length = Math.hypot(vx, vy, vz);
    if (!(length > 1e-6)) return;
    const ex = px + vx;
    const ey = py + vy;
    const ez = pz + vz;
    this.line(px, py, pz, ex, ey, ez, color);
    // Head in a plane containing the arrow and (roughly) the vertical.
    let sx = vz;
    let sy = 0;
    let sz = -vx;
    if (Math.hypot(sx, sz) < 1e-6 * length) {
      sx = length;
      sz = 0;
    }
    const s = (ARROW_HEAD_WIDTH * ARROW_HEAD_FRACTION * length) / Math.hypot(sx, sy, sz);
    const bx = ex - vx * ARROW_HEAD_FRACTION;
    const by = ey - vy * ARROW_HEAD_FRACTION;
    const bz = ez - vz * ARROW_HEAD_FRACTION;
    this.line(ex, ey, ez, bx + sx * s, by + sy * s, bz + sz * s, color);
    this.line(ex, ey, ez, bx - sx * s, by - sy * s, bz - sz * s, color);
  }

  triangle(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    color: Rgba,
  ): void {
    if (this.triangleCount + 3 > MAX_TRIANGLE_VERTICES) return;
    this.push(this.triangleData, this.triangleCount++, ax, ay, az, color);
    this.push(this.triangleData, this.triangleCount++, bx, by, bz, color);
    this.push(this.triangleData, this.triangleCount++, cx, cy, cz, color);
  }

  /** Draws the frame's geometry over `outputView`. */
  encode(encoder: GPUCommandEncoder, outputView: GPUTextureView): void {
    if (this.lineCount === 0 && this.triangleCount === 0) return;
    if (this.triangleCount > 0) {
      this.device.queue.writeBuffer(this.triangleBuffer, 0, this.triangleData, 0, this.triangleCount * VERTEX_FLOATS);
    }
    if (this.lineCount > 0) {
      this.device.queue.writeBuffer(this.lineBuffer, 0, this.lineData, 0, this.lineCount * VERTEX_FLOATS);
    }
    const pass = encoder.beginRenderPass({
      label: 'debug-draw',
      colorAttachments: [{ view: outputView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setBindGroup(0, this.frameBindGroup);
    if (this.triangleCount > 0) {
      pass.setPipeline(this.trianglePipeline);
      pass.setVertexBuffer(0, this.triangleBuffer);
      pass.draw(this.triangleCount);
    }
    if (this.lineCount > 0) {
      pass.setPipeline(this.linePipeline);
      pass.setVertexBuffer(0, this.lineBuffer);
      pass.draw(this.lineCount);
    }
    pass.end();
  }

  private push(target: Float32Array, index: number, x: number, y: number, z: number, color: Rgba): void {
    const o = index * VERTEX_FLOATS;
    target[o] = x - this.cameraX;
    target[o + 1] = y - this.cameraY;
    target[o + 2] = z - this.cameraZ;
    target[o + 3] = color[0];
    target[o + 4] = color[1];
    target[o + 5] = color[2];
    target[o + 6] = color[3];
  }
}
