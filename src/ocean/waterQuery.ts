import { samplerEntry, storageBufferEntry, textureEntry, uniformEntry } from '../core/bindings';
import { wrapPeriodic } from '../core/cameraRelative';
import { ReadbackRing } from '../core/readback';
import { composeWgsl, createShaderModule } from '../core/shader';
import { WGSL } from '../shaders';
import type { OceanCascades } from './cascades';
import { MAX_CASCADES } from './oceanConfig';

/** Receives the heights of one request; the array is only valid during the call. */
export type WaterQueryConsumer = (heights: Float32Array) => void;

/** Fixed-point iterations for x + D(x) = p (converges quickly for lambda < 1). */
const FIXED_POINT_ITERATIONS = 4;
const UNIFORM_BYTES = 64;
const WORKGROUP_SIZE = 64;
/** Staging buffers in flight; results arrive 1-3 frames after the request. */
const STAGING_BUFFERS = 3;
/** Requests (consumers) per frame. */
const MAX_REQUESTS = 8;

interface PendingRequests {
  count: number;
  readonly offsets: Int32Array;
  readonly lengths: Int32Array;
  readonly consumers: (WaterQueryConsumer | null)[];
  readonly heights: Float32Array;
}

/**
 * Asynchronous water height queries against the GPU ocean. Each frame, clients
 * add world-space XZ points; the batch is evaluated right after the wave
 * simulation and read back through a staging ring without ever blocking the
 * render loop. When all staging buffers are still in flight the frame's batch
 * is skipped and clients keep their previous results.
 */
export class WaterQuery {
  private readonly points: Float32Array;
  private readonly uniformData = new Float32Array(UNIFORM_BYTES / 4);
  private readonly ring: ReadbackRing;
  private readonly pending = new Map<GPUBuffer, PendingRequests>();
  private readonly current: PendingRequests;
  private originX = 0;
  private originZ = 0;
  private pointCount = 0;
  private submittedStaging: GPUBuffer | null = null;

  private constructor(
    private readonly device: GPUDevice,
    private readonly capacity: number,
    private readonly pipeline: GPUComputePipeline,
    private readonly bindGroup: GPUBindGroup,
    private readonly uniformBuffer: GPUBuffer,
    private readonly pointBuffer: GPUBuffer,
    private readonly heightBuffer: GPUBuffer,
    private readonly patchSizes: readonly number[],
  ) {
    this.points = new Float32Array(capacity * 2);
    this.ring = new ReadbackRing(device, capacity * 4, STAGING_BUFFERS, 'water-query');
    this.current = WaterQuery.createPending(capacity);
    for (let c = 0; c < MAX_CASCADES; c++) {
      this.uniformData[8 + c] = patchSizes[c] ?? 1;
    }
    this.uniformData[11] = patchSizes.length;
    this.uniformData[13] = FIXED_POINT_ITERATIONS;
  }

  static async create(device: GPUDevice, cascades: OceanCascades, capacity: number): Promise<WaterQuery> {
    const module = await createShaderModule(device, composeWgsl('water-query', [WGSL.oceanSampling, WGSL.waterQuery]));
    const C = GPUShaderStage.COMPUTE;
    const layout = device.createBindGroupLayout({
      label: 'water-query',
      entries: [
        uniformEntry(0, C, UNIFORM_BYTES),
        textureEntry(1, C, 'float'),
        samplerEntry(2, C),
        storageBufferEntry(3, C, 'read-only-storage'),
        storageBufferEntry(4, C),
      ],
    });
    const pipeline = await device.createComputePipelineAsync({
      label: 'water-query',
      layout: device.createPipelineLayout({ label: 'water-query', bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: 'main' },
    });
    const uniformBuffer = device.createBuffer({
      label: 'water-query-uniforms',
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const pointBuffer = device.createBuffer({
      label: 'water-query-points',
      size: capacity * 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const heightBuffer = device.createBuffer({
      label: 'water-query-heights',
      size: capacity * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const sampler = device.createSampler({
      label: 'water-query',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    const bindGroup = device.createBindGroup({
      label: 'water-query',
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: cascades.displacement.createView({ dimension: '2d-array' }) },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: pointBuffer } },
        { binding: 4, resource: { buffer: heightBuffer } },
      ],
    });
    return new WaterQuery(
      device,
      capacity,
      pipeline,
      bindGroup,
      uniformBuffer,
      pointBuffer,
      heightBuffer,
      cascades.bands.map((band) => band.patchSizeM),
    );
  }

  private static createPending(capacity: number): PendingRequests {
    return {
      count: 0,
      offsets: new Int32Array(MAX_REQUESTS),
      lengths: new Int32Array(MAX_REQUESTS),
      consumers: new Array<WaterQueryConsumer | null>(MAX_REQUESTS).fill(null),
      heights: new Float32Array(capacity),
    };
  }

  /**
   * Starts a new batch. Points are stored relative to the origin (double
   * precision on the CPU), so it should be near the queried area.
   */
  begin(originX: number, originZ: number): void {
    this.originX = originX;
    this.originZ = originZ;
    this.pointCount = 0;
    this.current.count = 0;
  }

  /**
   * Adds `count` world XZ points (x0, z0, x1, z1, ...). Returns false when the
   * batch is full; the consumer is then not called.
   */
  add(worldXZ: ArrayLike<number>, count: number, consumer: WaterQueryConsumer): boolean {
    if (this.pointCount + count > this.capacity || this.current.count >= MAX_REQUESTS) {
      return false;
    }
    for (let i = 0; i < count; i++) {
      this.points[2 * (this.pointCount + i)] = (worldXZ[2 * i] as number) - this.originX;
      this.points[2 * (this.pointCount + i) + 1] = (worldXZ[2 * i + 1] as number) - this.originZ;
    }
    const r = this.current.count++;
    this.current.offsets[r] = this.pointCount;
    this.current.lengths[r] = count;
    this.current.consumers[r] = consumer;
    this.pointCount += count;
    return true;
  }

  /** Records the query; call after the ocean simulation of this frame was encoded. */
  encode(encoder: GPUCommandEncoder): void {
    this.submittedStaging = null;
    if (this.pointCount === 0) {
      return;
    }
    const staging = this.ring.acquire();
    if (!staging) {
      return;
    }
    const u = this.uniformData;
    for (let c = 0; c < MAX_CASCADES; c++) {
      const size = this.patchSizes[c] ?? 1;
      u[2 * c] = wrapPeriodic(this.originX, size);
      u[2 * c + 1] = wrapPeriodic(this.originZ, size);
    }
    u[12] = this.pointCount;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);
    this.device.queue.writeBuffer(this.pointBuffer, 0, this.points, 0, this.pointCount * 2);

    const pass = encoder.beginComputePass({ label: 'water-query' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.pointCount / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(this.heightBuffer, 0, staging, 0, this.pointCount * 4);

    let record = this.pending.get(staging);
    if (!record) {
      record = WaterQuery.createPending(this.capacity);
      this.pending.set(staging, record);
    }
    record.count = this.current.count;
    for (let r = 0; r < this.current.count; r++) {
      record.offsets[r] = this.current.offsets[r] as number;
      record.lengths[r] = this.current.lengths[r] as number;
      record.consumers[r] = this.current.consumers[r] ?? null;
    }
    this.submittedStaging = staging;
  }

  /** Starts the readback; call right after queue.submit(). */
  afterSubmit(): void {
    const staging = this.submittedStaging;
    this.submittedStaging = null;
    if (!staging) {
      return;
    }
    const record = this.pending.get(staging);
    if (!record) {
      return;
    }
    let total = 0;
    for (let r = 0; r < record.count; r++) total = Math.max(total, (record.offsets[r] as number) + (record.lengths[r] as number));
    this.ring.mapWhenReady(staging, (data) => {
      // Copy out of the mapped range, which is only valid during this callback.
      record.heights.set(new Float32Array(data, 0, total));
      for (let r = 0; r < record.count; r++) {
        const offset = record.offsets[r] as number;
        record.consumers[r]?.(record.heights.subarray(offset, offset + (record.lengths[r] as number)));
      }
    });
  }
}
