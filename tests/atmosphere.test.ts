import { describe, expect, it } from 'vitest';
import atmosphereSkyViewWgsl from '../src/shaders/atmosphereSkyView.wgsl?raw';
import {
  ATMOSPHERE_SHADER_CONSTANTS,
  MAX_OVERCAST,
  SUN_IRRADIANCE_TOA,
  computeSunState,
  directionFromElevationAzimuth,
  overcastFromWind,
  transmittanceToTop,
  verticalOpticalDepth,
} from '../src/sky/atmosphereModel';
import { computeStructLayout } from './helpers/wgslLayout';

describe('atmosphere model', () => {
  it('has the vertical optical depths of a clear Earth atmosphere', () => {
    const [r, g, b] = verticalOpticalDepth();
    // Rayleigh 0.046 / 0.108 / 0.265, plus ~0.005 aerosol and ozone (mostly green).
    expect(r).toBeGreaterThan(0.05);
    expect(r).toBeLessThan(0.07);
    expect(g).toBeGreaterThan(0.12);
    expect(g).toBeLessThan(0.16);
    expect(b).toBeGreaterThan(0.26);
    expect(b).toBeLessThan(0.3);
  });

  it('reddens and dims the sun towards the horizon', () => {
    const high = transmittanceToTop(0, Math.sin((60 * Math.PI) / 180));
    const low = transmittanceToTop(0, Math.sin((2 * Math.PI) / 180));
    expect(low[0]).toBeGreaterThan(low[1]);
    expect(low[1]).toBeGreaterThan(low[2]);
    for (let c = 0; c < 3; c++) expect(low[c]).toBeLessThan(high[c] as number);
  });

  it('is opaque for rays that hit the ground', () => {
    expect(transmittanceToTop(1000, -0.5)).toEqual([0, 0, 0]);
    expect(transmittanceToTop(0, 1).every((t) => t > 0.7 && t < 1)).toBe(true);
  });

  it('computes direct sunlight after clouds', () => {
    const clear = computeSunState(45, 180, 0);
    const storm = computeSunState(45, 180, 0.8);
    for (let c = 0; c < 3; c++) {
      expect(clear.irradiance[c]).toBeLessThan(SUN_IRRADIANCE_TOA[c] as number);
      expect(storm.irradiance[c]).toBeCloseTo((clear.irradiance[c] as number) * 0.2, 9);
    }
    expect(computeSunState(-5, 0, 0).irradiance).toEqual([0, 0, 0]);
    const north = directionFromElevationAzimuth(0, 0);
    expect(north[2]).toBeCloseTo(-1, 12);
  });

  it('brings clouds with strong wind only', () => {
    expect(overcastFromWind(5, true)).toBe(0);
    expect(overcastFromWind(12, true)).toBe(0);
    expect(overcastFromWind(20, true)).toBeGreaterThan(0);
    expect(overcastFromWind(35, true)).toBeCloseTo(MAX_OVERCAST, 9);
    expect(overcastFromWind(35, false)).toBe(0);
  });

  it('generates WGSL constants for the shaders', () => {
    for (const line of ATMOSPHERE_SHADER_CONSTANTS.split('\n')) {
      expect(line).toMatch(/^const [A-Z0-9_]+: (f32|vec3<f32>) = .+;$/);
    }
  });

  it('keeps the sky-view uniform layout', () => {
    expect(computeStructLayout(atmosphereSkyViewWgsl, 'AtmosphereUniforms')).toEqual({ offsets: { sun: 0 }, size: 16 });
  });
});
