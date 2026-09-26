import { describe, expect, it } from 'vitest';
import { toCameraRelative, wrapPeriodic } from '../src/core/cameraRelative';

describe('wrapPeriodic', () => {
  it('wraps into [0, period) for positive and negative values', () => {
    expect(wrapPeriodic(0, 250)).toBe(0);
    expect(wrapPeriodic(260, 250)).toBeCloseTo(10, 12);
    expect(wrapPeriodic(-10, 250)).toBeCloseTo(240, 12);
    expect(wrapPeriodic(-250, 250)).toBe(0);
    expect(wrapPeriodic(500, 250)).toBe(0);
  });

  it('never returns the period itself for tiny negative inputs', () => {
    const wrapped = wrapPeriodic(-1e-20, 250);
    expect(wrapped).toBeGreaterThanOrEqual(0);
    expect(wrapped).toBeLessThan(250);
  });

  it('keeps sub-millimetre precision thousands of kilometres from the origin', () => {
    const period = 37.3;
    const base = 5_000_000; // 5000 km
    const a = wrapPeriodic(base + 0.0004, period);
    const b = wrapPeriodic(base, period);
    expect(a - b).toBeCloseTo(0.0004, 7);
  });

  it('rejects non-positive periods', () => {
    expect(() => wrapPeriodic(1, 0)).toThrow(RangeError);
  });
});

describe('toCameraRelative', () => {
  it('is exact where naive float32 world positions would lose precision', () => {
    const camera = [10_000_000.25, 12.5, -7_500_000.75];
    const world = [10_000_001.5, 10, -7_500_000.5];
    const out = toCameraRelative(world, camera, new Float32Array(3));
    expect(out[0]).toBeCloseTo(1.25, 6);
    expect(out[1]).toBeCloseTo(-2.5, 6);
    expect(out[2]).toBeCloseTo(0.25, 6);

    // Naive approach: convert to float32 first, subtract on the GPU.
    const naive = Math.fround(world[0] as number) - Math.fround(camera[0] as number);
    expect(Math.abs(naive - 1.25)).toBeGreaterThan(0.1);
  });

  it('writes at the requested offset', () => {
    const out = new Float32Array(6);
    toCameraRelative([4, 5, 6], [1, 1, 1], out, 3);
    expect(Array.from(out)).toEqual([0, 0, 0, 3, 4, 5]);
  });
});
