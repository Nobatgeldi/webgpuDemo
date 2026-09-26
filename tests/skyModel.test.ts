import { describe, expect, it } from 'vitest';
import {
  computeSkyState,
  directionFromElevationAzimuth,
  relativeAirMass,
  sunTransmittance,
} from '../src/sky/skyModel';

const DEG = Math.PI / 180;

describe('relativeAirMass (Kasten & Young)', () => {
  it('is 1 at the zenith and about 38 at the horizon', () => {
    expect(relativeAirMass(90 * DEG)).toBeCloseTo(1, 3);
    expect(relativeAirMass(0)).toBeGreaterThan(37);
    expect(relativeAirMass(0)).toBeLessThan(39);
  });

  it('approximates 1/cos(zenith) at moderate angles', () => {
    expect(relativeAirMass(30 * DEG)).toBeCloseTo(2, 1);
  });
});

describe('sunTransmittance', () => {
  it('reddens the sun near the horizon', () => {
    const [r, g, b] = sunTransmittance(2 * DEG);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    const high = sunTransmittance(60 * DEG);
    expect(high[2]).toBeGreaterThan(b);
  });
});

describe('directionFromElevationAzimuth', () => {
  it('uses -Z as north and +X as east', () => {
    const north = directionFromElevationAzimuth(0, 0);
    expect(north[0]).toBeCloseTo(0, 12);
    expect(north[2]).toBeCloseTo(-1, 12);
    const east = directionFromElevationAzimuth(0, 90 * DEG);
    expect(east[0]).toBeCloseTo(1, 12);
    expect(east[2]).toBeCloseTo(0, 12);
    const zenith = directionFromElevationAzimuth(90 * DEG, 0);
    expect(zenith[1]).toBeCloseTo(1, 12);
  });
});

describe('computeSkyState', () => {
  it('is bright by day and dark at night', () => {
    const day = computeSkyState(45, 180);
    const night = computeSkyState(-10, 180);
    expect(day.zenith[2]).toBeGreaterThan(20 * night.zenith[2]);
    expect(night.sunDiskRadiance.every((c) => c === 0)).toBe(true);
  });

  it('gives a direct-to-diffuse irradiance ratio typical of a clear day', () => {
    const day = computeSkyState(60, 180);
    const direct = day.sunIrradiance[1] * Math.sin(60 * DEG);
    const diffuse = Math.PI * 0.5 * (day.zenith[1] + day.horizon[1]);
    expect(direct / diffuse).toBeGreaterThan(2);
    expect(direct / diffuse).toBeLessThan(10);
  });
});
