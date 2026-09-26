/**
 * Ring of MAP_READ staging buffers for asynchronous GPU -> CPU readback.
 *
 * Usage per frame:
 *   const staging = ring.acquire();          // null if all buffers are in flight
 *   if (staging) encoder.copyBufferToBuffer(src, 0, staging, 0, size);
 *   device.queue.submit([encoder.finish()]);
 *   if (staging) ring.mapWhenReady(staging, (data) => { ... });
 *
 * The render loop never waits: if every buffer is still mapping, that frame
 * simply skips its readback and results arrive one or more frames late.
 */
export class ReadbackRing {
  private readonly free: GPUBuffer[] = [];
  private readonly all: GPUBuffer[] = [];
  private disposed = false;

  constructor(
    device: GPUDevice,
    readonly byteSize: number,
    count: number,
    label: string,
  ) {
    for (let i = 0; i < count; i++) {
      const buffer = device.createBuffer({
        label: `${label}-staging-${i}`,
        size: byteSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      this.free.push(buffer);
      this.all.push(buffer);
    }
  }

  /** Number of buffers currently available for a copy. */
  get available(): number {
    return this.free.length;
  }

  /** Takes a free staging buffer, or null if all are waiting for their map to resolve. */
  acquire(): GPUBuffer | null {
    return this.free.pop() ?? null;
  }

  /**
   * Must be called after the submit that contains the copy into `buffer`.
   * `onData` receives a view that is only valid during the callback.
   */
  mapWhenReady(buffer: GPUBuffer, onData: (data: ArrayBuffer) => void): void {
    buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        if (this.disposed) {
          return;
        }
        try {
          onData(buffer.getMappedRange());
        } finally {
          buffer.unmap();
          this.free.push(buffer);
        }
      },
      (error: unknown) => {
        // Mapping fails when the device is lost or the buffer destroyed; the device-lost
        // handler reports that case, so only log and recycle here.
        if (!this.disposed) {
          console.warn('[readback] mapAsync failed:', error);
          this.free.push(buffer);
        }
      },
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const buffer of this.all) {
      buffer.destroy();
    }
    this.free.length = 0;
  }
}
