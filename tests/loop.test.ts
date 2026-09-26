import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedStepper, FrameLoop, type FrameInfo } from '../src/core/loop';

const STEP = 1 / 120;

describe('FixedStepper', () => {
  it('runs one step per 1/120 s regardless of frame rate', () => {
    for (const fps of [30, 60, 75, 144, 240]) {
      const stepper = new FixedStepper(STEP, 100);
      let steps = 0;
      const frames = fps * 10; // 10 s of wall time
      for (let i = 0; i < frames; i++) {
        steps += stepper.advance(1 / fps);
      }
      // Exactly 1200 steps in 10 s, up to one step still in the accumulator.
      expect(steps).toBeGreaterThanOrEqual(1199);
      expect(steps).toBeLessThanOrEqual(1200);
    }
  });

  it('produces exactly two steps for two step lengths despite rounding', () => {
    const stepper = new FixedStepper(STEP, 10);
    expect(stepper.advance(STEP)).toBe(1);
    expect(stepper.advance(STEP)).toBe(1);
    expect(stepper.advance(2 * STEP)).toBe(2);
  });

  it('accumulates partial frames and exposes the interpolation factor', () => {
    const stepper = new FixedStepper(STEP, 10);
    expect(stepper.advance(STEP * 0.25)).toBe(0);
    expect(stepper.alpha).toBeCloseTo(0.25, 9);
    expect(stepper.advance(STEP * 0.5)).toBe(0);
    expect(stepper.alpha).toBeCloseTo(0.75, 9);
    expect(stepper.advance(STEP * 0.5)).toBe(1);
    expect(stepper.alpha).toBeCloseTo(0.25, 9);
  });

  it('caps the steps per frame and records the dropped time', () => {
    const stepper = new FixedStepper(STEP, 12);
    const steps = stepper.advance(1); // one second hitch
    expect(steps).toBe(12);
    expect(stepper.droppedSeconds).toBeCloseTo(1 - 12 * STEP, 9);
    expect(stepper.alpha).toBeLessThan(1);
    // Afterwards it runs normally again.
    expect(stepper.advance(STEP)).toBe(1);
  });

  it('ignores zero, negative and NaN elapsed time', () => {
    const stepper = new FixedStepper(STEP, 10);
    expect(stepper.advance(0)).toBe(0);
    expect(stepper.advance(-1)).toBe(0);
    expect(stepper.advance(Number.NaN)).toBe(0);
    expect(stepper.alpha).toBe(0);
  });

  it('rejects invalid configuration', () => {
    expect(() => new FixedStepper(0, 10)).toThrow(RangeError);
    expect(() => new FixedStepper(STEP, 0)).toThrow(RangeError);
    expect(() => new FixedStepper(STEP, 1.5)).toThrow(RangeError);
  });
});

describe('FrameLoop', () => {
  let pending: FrameRequestCallback | null = null;
  let cancelled = 0;

  beforeEach(() => {
    pending = null;
    cancelled = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      pending = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      cancelled++;
      pending = null;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function runFrame(timestampMs: number): void {
    const callback = pending;
    expect(callback).not.toBeNull();
    callback?.(timestampMs);
  }

  it('steps the simulation at a fixed rate and renders once per frame', () => {
    let steps = 0;
    const frames: FrameInfo[] = [];
    const loop = new FrameLoop({
      stepSeconds: STEP,
      maxStepsPerFrame: 12,
      maxFrameSeconds: 0.25,
      isPaused: () => false,
      step: () => steps++,
      render: (frame) => frames.push(frame),
      onError: (error) => {
        throw error;
      },
    });
    loop.start();
    runFrame(0); // first frame only establishes the time base
    for (let i = 1; i <= 60; i++) {
      runFrame((i * 1000) / 60);
    }
    expect(frames).toHaveLength(61);
    expect(steps).toBeGreaterThanOrEqual(119);
    expect(steps).toBeLessThanOrEqual(120);
    expect(frames[60]?.frameIndex).toBe(60);
  });

  it('does not step while paused but keeps rendering', () => {
    let steps = 0;
    let renders = 0;
    const loop = new FrameLoop({
      stepSeconds: STEP,
      maxStepsPerFrame: 12,
      maxFrameSeconds: 0.25,
      isPaused: () => true,
      step: () => steps++,
      render: () => renders++,
      onError: () => undefined,
    });
    loop.start();
    runFrame(0);
    runFrame(100);
    expect(steps).toBe(0);
    expect(renders).toBe(2);
  });

  it('stops and reports when a frame throws', () => {
    const errors: unknown[] = [];
    const failure = new Error('boom');
    const loop = new FrameLoop({
      stepSeconds: STEP,
      maxStepsPerFrame: 12,
      maxFrameSeconds: 0.25,
      isPaused: () => false,
      step: () => undefined,
      render: () => {
        throw failure;
      },
      onError: (error) => errors.push(error),
    });
    loop.start();
    runFrame(0);
    expect(errors).toEqual([failure]);
    expect(loop.running).toBe(false);
    expect(cancelled).toBe(1);
  });
});
