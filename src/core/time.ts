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
