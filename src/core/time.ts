/**
 * Simulation clock and lightweight frame statistics.
 */

/** Simulation time, advanced only by fixed simulation steps (stops while paused). */
export class SimClock {
  private stepCount = 0;

  constructor(readonly stepSeconds: number) {
    if (!(stepSeconds > 0)) {
      throw new RangeError(`stepSeconds must be positive, got ${stepSeconds}`);
    }
  }

  /**
   * Simulation time in seconds. Derived from the integer step count rather than
   * summed, so no rounding error accumulates over hours of simulation.
   */
  get time(): number {
    return this.stepCount * this.stepSeconds;
  }

  get steps(): number {
    return this.stepCount;
  }

  advance(): void {
    this.stepCount++;
  }
}

/**
 * Counts events per second over a sliding measurement window
 * (used for FPS; robust against single long frames).
 */
export class RateCounter {
  private windowStartMs: number | null = null;
  private eventsInWindow = 0;
  private currentRate = 0;

  constructor(private readonly windowMs: number) {}

  get rate(): number {
    return this.currentRate;
  }

  tick(nowMs: number): void {
    if (this.windowStartMs === null) {
      this.windowStartMs = nowMs;
      return;
    }
    this.eventsInWindow++;
    const elapsed = nowMs - this.windowStartMs;
    if (elapsed >= this.windowMs) {
      this.currentRate = (this.eventsInWindow * 1000) / elapsed;
      this.eventsInWindow = 0;
      this.windowStartMs = nowMs;
    }
  }
}

/**
 * Exponential moving average with a time constant expressed in samples.
 * The first sample initialises the average directly.
 */
export class ExponentialAverage {
  private current: number | null = null;
  private readonly weight: number;

  constructor(timeConstantSamples: number) {
    if (!(timeConstantSamples >= 1)) {
      throw new RangeError(`timeConstantSamples must be >= 1, got ${timeConstantSamples}`);
    }
    this.weight = 1 / timeConstantSamples;
  }

  get value(): number | null {
    return this.current;
  }

  push(sample: number): void {
    if (!Number.isFinite(sample)) {
      return;
    }
    this.current = this.current === null ? sample : this.current + (sample - this.current) * this.weight;
  }
}

export interface FrameTimeSummary {
  /** Frames in the window. */
  readonly count: number;
  readonly meanMs: number;
  /** 95th percentile and worst frame time (ms). */
  readonly p95Ms: number;
  readonly maxMs: number;
  /** Frames per second from the mean frame time. */
  readonly meanFps: number;
}

/**
 * Frame times over the last `capacity` frames (ring buffer, no allocation per
 * frame). The mean hides stutter; the 95th percentile and the maximum show it.
 */
export class FrameTimeStats {
  private readonly samples: Float64Array;
  private readonly sorted: Float64Array;
  private next = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!(capacity >= 1)) {
      throw new RangeError(`capacity must be >= 1, got ${capacity}`);
    }
    this.samples = new Float64Array(capacity);
    this.sorted = new Float64Array(capacity);
  }

  push(frameMs: number): void {
    this.samples[this.next] = frameMs;
    this.next = (this.next + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  reset(): void {
    this.count = 0;
    this.next = 0;
  }

  /** Summary of the window, or null before the first sample. */
  summary(): FrameTimeSummary | null {
    const n = this.count;
    if (n === 0) {
      return null;
    }
    const view = this.sorted.subarray(0, n);
    view.set(this.samples.subarray(0, n));
    view.sort();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += view[i] as number;
    const mean = sum / n;
    // Nearest-rank percentile.
    const p95 = view[Math.min(n - 1, Math.ceil(0.95 * n) - 1)] as number;
    return { count: n, meanMs: mean, p95Ms: p95, maxMs: view[n - 1] as number, meanFps: mean > 0 ? 1000 / mean : 0 };
  }
}
