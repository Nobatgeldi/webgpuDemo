import { describe, expect, it } from 'vitest';
import { createRandom, deriveSeed, fillGaussian } from '../src/core/random';

describe('random', () => {
  it('is deterministic for a seed', () => {
    const a = createRandom(42);
    const b = createRandom(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
    expect(createRandom(1)()).not.toBe(createRandom(2)());
  });

  it('produces standard normal samples', () => {
    const samples = fillGaussian(new Float32Array(200_000), createRandom(9));
    let mean = 0;
    for (const s of samples) mean += s;
    mean /= samples.length;
    let variance = 0;
    for (const s of samples) variance += (s - mean) ** 2;
    variance /= samples.length;
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(variance).toBeCloseTo(1, 1);
    expect(samples.every(Number.isFinite)).toBe(true);
  });

  it('derives distinct sub-stream seeds', () => {
    const seeds = new Set([0, 1, 2, 3].map((s) => deriveSeed(7, s)));
    expect(seeds.size).toBe(4);
  });
});
