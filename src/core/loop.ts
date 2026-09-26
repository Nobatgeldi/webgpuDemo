/**
 * Frame loop with a fixed-step simulation clock.
 *
 * Rendering runs once per requestAnimationFrame; the simulation advances in
 * constant steps (Glenn Fiedler's "fix your timestep" accumulator), so physics
 * behaves identically regardless of display refresh rate.
 */

export class FixedStepper {
  private accumulator = 0;
  private dropped = 0;

  /**
   * @param stepSeconds Length of one simulation step.
   * @param maxStepsPerAdvance Cap on steps per frame. When a frame takes longer
   *   than this many steps (debugger pause, tab switch, very slow frame), the
   *   excess time is discarded instead of trying to catch up, which would make
   *   every following frame even slower ("spiral of death").
   */
  constructor(
    readonly stepSeconds: number,
    readonly maxStepsPerAdvance: number,
  ) {
    if (!(stepSeconds > 0)) {
      throw new RangeError(`stepSeconds must be positive, got ${stepSeconds}`);
    }
    if (!Number.isInteger(maxStepsPerAdvance) || maxStepsPerAdvance < 1) {
      throw new RangeError(`maxStepsPerAdvance must be a positive integer, got ${maxStepsPerAdvance}`);
    }
  }

  /**
   * Adds elapsed wall time and returns how many fixed steps must be simulated.
   */
  advance(elapsedSeconds: number): number {
    if (!(elapsedSeconds > 0)) {
      return 0;
    }
    this.accumulator += elapsedSeconds;
    // Tolerate floating-point residue so that e.g. 2 x (1/120) s yields exactly 2 steps.
    const epsilon = this.stepSeconds * 1e-9;
    let steps = Math.floor((this.accumulator + epsilon) / this.stepSeconds);
    if (steps > this.maxStepsPerAdvance) {
      const excess = (steps - this.maxStepsPerAdvance) * this.stepSeconds;
      this.dropped += excess;
      steps = this.maxStepsPerAdvance;
      this.accumulator -= excess;
    }
    this.accumulator = Math.max(0, this.accumulator - steps * this.stepSeconds);
    return steps;
  }

  /** Fraction of a step accumulated but not yet simulated, in [0, 1). For render interpolation. */
  get alpha(): number {
    return Math.min(this.accumulator / this.stepSeconds, 1 - Number.EPSILON);
  }

  /** Total simulation time discarded because of the per-frame step cap. */
  get droppedSeconds(): number {
    return this.dropped;
  }

  reset(): void {
    this.accumulator = 0;
  }
}

export interface FrameInfo {
  /** Monotonic frame counter, starting at 0. */
  readonly frameIndex: number;
  /** Wall-clock time since the previous frame, clamped (seconds). */
  readonly frameSeconds: number;
  /** Number of fixed simulation steps executed before this render. */
  readonly stepsThisFrame: number;
  /** Interpolation factor between the last two simulation states, in [0, 1). */
  readonly alpha: number;
  /** requestAnimationFrame timestamp (milliseconds). */
  readonly timestampMs: number;
}

export interface FrameLoopOptions {
  readonly stepSeconds: number;
  readonly maxStepsPerFrame: number;
  /** Upper bound for a single frame's wall time (seconds). */
  readonly maxFrameSeconds: number;
  isPaused(): boolean;
  /** Advances the simulation by exactly one fixed step. */
  step(stepSeconds: number): void;
  render(frame: FrameInfo): void;
  /**
   * Called when step() or render() throws. The loop stops first, so a
   * persistent error cannot flood the console at the display refresh rate.
   */
  onError(error: unknown): void;
}

export class FrameLoop {
  private readonly stepper: FixedStepper;
  private handle: number | null = null;
  private lastTimestampMs: number | null = null;
  private frameIndex = 0;

  constructor(private readonly options: FrameLoopOptions) {
    this.stepper = new FixedStepper(options.stepSeconds, options.maxStepsPerFrame);
  }

  get running(): boolean {
    return this.handle !== null;
  }

  get droppedSimulationSeconds(): number {
    return this.stepper.droppedSeconds;
  }

  start(): void {
    if (this.handle !== null) {
      return;
    }
    this.lastTimestampMs = null;
    this.handle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.handle !== null) {
      cancelAnimationFrame(this.handle);
      this.handle = null;
    }
  }

  private readonly tick = (timestampMs: number): void => {
    this.handle = requestAnimationFrame(this.tick);

    const rawSeconds =
      this.lastTimestampMs === null ? 0 : (timestampMs - this.lastTimestampMs) / 1000;
    this.lastTimestampMs = timestampMs;
    const frameSeconds = Math.min(Math.max(rawSeconds, 0), this.options.maxFrameSeconds);

    try {
      let steps = 0;
      if (!this.options.isPaused()) {
        steps = this.stepper.advance(frameSeconds);
        for (let i = 0; i < steps; i++) {
          this.options.step(this.stepper.stepSeconds);
        }
      }

      this.options.render({
        frameIndex: this.frameIndex++,
        frameSeconds,
        stepsThisFrame: steps,
        alpha: this.stepper.alpha,
        timestampMs,
      });
    } catch (error) {
      this.stop();
      this.options.onError(error);
    }
  };
}
