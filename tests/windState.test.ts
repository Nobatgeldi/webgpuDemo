import { describe, expect, it } from 'vitest';
import { WIND_SPEED_RATE_MS_PER_S, WindState, propagationVector } from '../src/ocean/windState';

describe('WindState', () => {
  it('approaches the target speed at 1 (m/s)/s', () => {
    const wind = new WindState(5, 0);
    wind.setTarget(15, 0);
    const dt = 1 / 120;
    let t = 0;
    while (wind.transitioning) {
      wind.step(dt);
      t += dt;
      expect(t).toBeLessThan(20);
    }
    expect(wind.speedMs).toBe(15);
    expect(t).toBeCloseTo(10 / WIND_SPEED_RATE_MS_PER_S, 1);
  });

  it('turns along the shortest arc', () => {
    const wind = new WindState(10, (350 * Math.PI) / 180);
    wind.setTarget(10, (10 * Math.PI) / 180);
    wind.step(0.5);
    const deg = (wind.fromDirectionRad * 180) / Math.PI;
    expect(deg).toBeCloseTo(355, 6);
    for (let i = 0; i < 10; i++) wind.step(0.5);
    expect((wind.fromDirectionRad * 180) / Math.PI).toBeCloseTo(10, 6);
  });

  it('reports no change when settled', () => {
    const wind = new WindState(3, 1);
    expect(wind.step(1)).toBe(false);
  });

  it('propagates waves away from where the wind comes from', () => {
    const [x, z] = propagationVector(0); // northerly wind blows towards the south (+Z)
    expect(x).toBeCloseTo(0, 12);
    expect(z).toBeCloseTo(1, 12);
    const [ex, ez] = propagationVector(Math.PI / 2); // easterly wind blows towards the west (-X)
    expect(ex).toBeCloseTo(-1, 12);
    expect(ez).toBeCloseTo(0, 12);
  });
});
