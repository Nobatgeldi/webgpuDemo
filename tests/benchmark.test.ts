import { describe, expect, it } from 'vitest';
import { Benchmark } from '../src/core/benchmark';
import type { QualityPreset } from '../src/core/urlParams';

describe('benchmark', () => {
  it('switches, warms up and measures every preset in turn', () => {
    const bench = new Benchmark(['low', 'high'], { warmupS: 1, measureS: 2 });
    let active: QualityPreset = 'medium';
    let now = 0;
    const frameMs = { low: 10, high: 20, medium: 15 } as const;
    // Simulated app: switching takes 0.5 s.
    let switchDoneAt = -1;
    for (let i = 0; i < 2000 && !bench.done; i++) {
      now += 10;
      if (bench.requestedPreset !== active) {
        if (switchDoneAt < 0) switchDoneAt = now + 500;
        if (now >= switchDoneAt) {
          active = bench.requestedPreset;
          switchDoneAt = -1;
        }
      }
      bench.update({ nowMs: now, frameMs: frameMs[active], activePreset: active, gpuMs: frameMs[active] / 2, width: 800, height: 600 });
    }
    expect(bench.done).toBe(true);
    expect(bench.results.map((r) => r.preset)).toEqual(['low', 'high']);
    expect(bench.results[0]?.meanMs).toBeCloseTo(10, 9);
    expect(bench.results[1]?.meanMs).toBeCloseTo(20, 9);
    expect(bench.results[1]?.gpuMs).toBeCloseTo(10, 9);
    // About measureS worth of frames at 10 ms per update.
    expect(bench.results[0]?.count).toBeGreaterThan(190);
    expect(bench.results[0]?.count).toBeLessThan(210);
  });
});
