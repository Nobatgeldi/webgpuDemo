import { ReadbackRing } from './readback';
import { ExponentialAverage } from './time';

/** Timestamps per pass: one at the beginning, one at the end. */
const QUERIES_PER_PASS = 2;
const BYTES_PER_TIMESTAMP = 8;
/** Staging buffers in flight; timing results typically arrive 1-3 frames late. */
const TIMER_STAGING_BUFFERS = 4;
/** Smoothing of displayed GPU times (in frames). */
const GPU_TIME_SMOOTHING_FRAMES = 30;
const NANOSECONDS_PER_MILLISECOND = 1e6;

interface InFlightFrame {
  passCount: number;
  readonly labels: string[];
}

/**
 * Measures GPU execution time of render/compute passes with timestamp queries.
 * Results are read back asynchronously through a staging ring and smoothed.
 * When the 'timestamp-query' feature is unavailable every method is a no-op
 * and {@link GpuTimer.frameMs} stays null.
 */
export class GpuTimer {
  private readonly querySet: GPUQuerySet | null = null;
  private readonly resolveBuffer: GPUBuffer | null = null;
  private readonly ring: ReadbackRing | null = null;
  private readonly frameLabels: string[] = [];
  private readonly inFlight = new Map<GPUBuffer, InFlightFrame>();
  private readonly frameAverage = new ExponentialAverage(GPU_TIME_SMOOTHING_FRAMES);
  private readonly passAverages = new Map<string, ExponentialAverage>();
  private pendingStaging: GPUBuffer | null = null;

  constructor(
    device: GPUDevice,
    enabled: boolean,
    private readonly maxPassesPerFrame: number,
  ) {
    if (!enabled) {
      return;
    }
    const queryCount = maxPassesPerFrame * QUERIES_PER_PASS;
    const byteSize = queryCount * BYTES_PER_TIMESTAMP;
    this.querySet = device.createQuerySet({ label: 'gpu-timer', type: 'timestamp', count: queryCount });
    this.resolveBuffer = device.createBuffer({
      label: 'gpu-timer-resolve',
      size: byteSize,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.ring = new ReadbackRing(device, byteSize, TIMER_STAGING_BUFFERS, 'gpu-timer');
  }

  get supported(): boolean {
    return this.querySet !== null;
  }

  /** Smoothed GPU time of all timed passes of a frame, in milliseconds. */
  get frameMs(): number | null {
    return this.frameAverage.value;
  }

  /** Smoothed GPU time per pass label, in milliseconds. */
  passMs(label: string): number | null {
    return this.passAverages.get(label)?.value ?? null;
  }

  get passLabels(): IterableIterator<string> {
    return this.passAverages.keys();
  }

  beginFrame(): void {
    this.frameLabels.length = 0;
  }

  /**
   * Returns timestamp writes for the next pass, or undefined when timing is
   * unavailable or the per-frame pass budget is exhausted.
   */
  timestampWrites(label: string): GPURenderPassTimestampWrites | undefined {
    if (!this.querySet || this.frameLabels.length >= this.maxPassesPerFrame) {
      return undefined;
    }
    const index = this.frameLabels.length;
    this.frameLabels.push(label);
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: index * QUERIES_PER_PASS,
      endOfPassWriteIndex: index * QUERIES_PER_PASS + 1,
    };
  }

  /** Records query resolution into `encoder`. Call once after all timed passes. */
  resolve(encoder: GPUCommandEncoder): void {
    this.pendingStaging = null;
    if (!this.querySet || !this.resolveBuffer || !this.ring || this.frameLabels.length === 0) {
      return;
    }
    const staging = this.ring.acquire();
    if (!staging) {
      return; // All staging buffers still in flight; skip timing this frame.
    }
    const queryCount = this.frameLabels.length * QUERIES_PER_PASS;
    const byteCount = queryCount * BYTES_PER_TIMESTAMP;
    encoder.resolveQuerySet(this.querySet, 0, queryCount, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, staging, 0, byteCount);

    let record = this.inFlight.get(staging);
    if (!record) {
      record = { passCount: 0, labels: [] };
      this.inFlight.set(staging, record);
    }
    record.passCount = this.frameLabels.length;
    record.labels.length = 0;
    for (const label of this.frameLabels) {
      record.labels.push(label);
    }
    this.pendingStaging = staging;
  }

  /** Starts the asynchronous readback. Call right after queue.submit(). */
  afterSubmit(): void {
    const staging = this.pendingStaging;
    this.pendingStaging = null;
    if (!staging || !this.ring) {
      return;
    }
    const record = this.inFlight.get(staging);
    if (!record) {
      return;
    }
    this.ring.mapWhenReady(staging, (data) => this.consume(data, record));
  }

  private consume(data: ArrayBuffer, record: InFlightFrame): void {
    const timestamps = new BigUint64Array(data, 0, record.passCount * QUERIES_PER_PASS);
    let frameBegin: bigint | null = null;
    let frameEnd: bigint | null = null;
    for (let pass = 0; pass < record.passCount; pass++) {
      const begin = timestamps[pass * QUERIES_PER_PASS] as bigint;
      const end = timestamps[pass * QUERIES_PER_PASS + 1] as bigint;
      // Some drivers occasionally report zero or reordered timestamps; ignore those samples.
      if (begin === 0n || end < begin) {
        continue;
      }
      const label = record.labels[pass] as string;
      let average = this.passAverages.get(label);
      if (!average) {
        average = new ExponentialAverage(GPU_TIME_SMOOTHING_FRAMES);
        this.passAverages.set(label, average);
      }
      average.push(Number(end - begin) / NANOSECONDS_PER_MILLISECOND);
      if (frameBegin === null || begin < frameBegin) {
        frameBegin = begin;
      }
      if (frameEnd === null || end > frameEnd) {
        frameEnd = end;
      }
    }
    if (frameBegin !== null && frameEnd !== null) {
      this.frameAverage.push(Number(frameEnd - frameBegin) / NANOSECONDS_PER_MILLISECOND);
    }
  }
}
