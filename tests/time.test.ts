import { describe, expect, it } from 'vitest';
import { ExponentialAverage, RateCounter, SimClock } from '../src/core/time';

describe('SimClock', () => {
  it('derives time from the step count without accumulated rounding', () => {
    const clock = new SimClock(1 / 120);
    const steps = 120 * 3600 * 5; // five hours
    for (let i = 0; i < steps; i++) {
      clock.advance();
    }
    expect(clock.steps).toBe(steps);
    expect(clock.time).toBeCloseTo(5 * 3600, 9);
  });
});

describe('RateCounter', () => {
  it('measures a steady 60 Hz rate', () => {
    const counter = new RateCounter(500);
    for (let i = 0; i <= 120; i++) {
      counter.tick((i * 1000) / 60);
    }
    expect(counter.rate).toBeCloseTo(60, 6);
  });
});

describe('ExponentialAverage', () => {
  it('starts at the first sample and converges to a constant input', () => {
    const average = new ExponentialAverage(10);
    expect(average.value).toBeNull();
    average.push(5);
    expect(average.value).toBe(5);
    for (let i = 0; i < 200; i++) {
      average.push(1);
    }
    expect(average.value).toBeCloseTo(1, 6);
  });

  it('ignores non-finite samples', () => {
    const average = new ExponentialAverage(4);
    average.push(2);
    average.push(Number.NaN);
    average.push(Number.POSITIVE_INFINITY);
    expect(average.value).toBe(2);
  });
});
