import { describe, expect, it } from 'vitest';
import { BEAUFORT_TABLE, beaufortMidSpeed } from '../src/ocean/beaufort';
import {
  CALM_WIND_SPEED_MS,
  backwardSuppression,
  coxMunkSlopeVariance,
  inverseNormalCdf,
  resolvedSlopeVariance,
  unresolvedSlopeVariance,
  whitecapCoverage,
  donelanBannerSpreading,
  jonswapEnhancement,
  jonswapParameters,
  jonswapSpectrum,
  peakWavelength,
  saturationDimensionlessFetch,
  significantWaveHeight,
  spectralMoment0,
  wavenumberSpectrum,
} from '../src/ocean/spectrumModel';

const DEFAULT_FETCH_M = 300_000;
const G = 9.81;

function hsForBeaufort(beaufort: number, fetchM = DEFAULT_FETCH_M): number {
  return significantWaveHeight(jonswapParameters({ windSpeedMs: beaufortMidSpeed(beaufort), fetchM }));
}

describe('JONSWAP sea state', () => {
  it.each([4, 6, 8])('Hs for Bf %i is within 35% of the Beaufort table', (beaufort) => {
    const expected = BEAUFORT_TABLE[beaufort]?.probableWaveHeightM as number;
    const hs = hsForBeaufort(beaufort);
    expect(hs).toBeGreaterThan(expected * 0.65);
    expect(hs).toBeLessThan(expected * 1.35);
  });

  it('saturates at the Pierson-Moskowitz energy for long fetch', () => {
    const chi = saturationDimensionlessFetch(3.3);
    expect(chi).toBeGreaterThan(1e4);
    expect(chi).toBeLessThan(1.4e4);
    for (const u of [5, 10, 15]) {
      const hs = significantWaveHeight(jonswapParameters({ windSpeedMs: u, fetchM: 5e6 }));
      const hsPm = (0.21 * (1.026 * u) ** 2) / G;
      expect(hs).toBeCloseTo(hsPm, 2);
    }
  });

  it('grows with fetch until saturation, then stays constant', () => {
    const hs = (fetchM: number): number => significantWaveHeight(jonswapParameters({ windSpeedMs: 15, fetchM }));
    expect(hs(10_000)).toBeLessThan(hs(100_000));
    expect(hs(100_000)).toBeLessThan(hs(300_000));
    expect(hs(2_000_000)).toBeCloseTo(hs(5_000_000), 9);
  });

  it('increases monotonically with wind speed', () => {
    let previous = 0;
    for (let u = 1; u <= 40; u += 1) {
      const hs = significantWaveHeight(jonswapParameters({ windSpeedMs: u, fetchM: DEFAULT_FETCH_M }));
      expect(hs).toBeGreaterThan(previous);
      previous = hs;
    }
  });

  it('is numerically stable as the wind vanishes', () => {
    for (const u of [0, 1e-9, CALM_WIND_SPEED_MS * 0.99, CALM_WIND_SPEED_MS, 0.1, 0.3]) {
      const p = jonswapParameters({ windSpeedMs: u, fetchM: DEFAULT_FETCH_M });
      const hs = significantWaveHeight(p);
      expect(Number.isFinite(hs)).toBe(true);
      expect(hs).toBeLessThan(0.01);
      for (const k of [1e-4, 0.01, 1, 100]) {
        expect(Number.isFinite(wavenumberSpectrum(k, 0, 1, 0, p))).toBe(true);
      }
    }
    expect(hsForBeaufort(0)).toBeLessThan(0.001);
  });

  it('matches the enhancement factor of gamma = 3.3 (~1.5)', () => {
    expect(jonswapEnhancement(3.3)).toBeGreaterThan(1.4);
    expect(jonswapEnhancement(3.3)).toBeLessThan(1.7);
  });

  it('peaks at omega_p', () => {
    const p = jonswapParameters({ windSpeedMs: 12, fetchM: DEFAULT_FETCH_M });
    const atPeak = jonswapSpectrum(p.peakOmega, p);
    expect(jonswapSpectrum(p.peakOmega * 0.9, p)).toBeLessThan(atPeak);
    expect(jonswapSpectrum(p.peakOmega * 1.1, p)).toBeLessThan(atPeak);
    expect(peakWavelength(p)).toBeCloseTo((2 * Math.PI * G) / p.peakOmega ** 2, 9);
  });
});

describe('Directional spreading', () => {
  it('Donelan-Banner is normalised over [-pi, pi]', () => {
    for (const ratio of [0.5, 0.8, 1, 1.3, 2, 4]) {
      const steps = 4000;
      let sum = 0;
      for (let i = 0; i < steps; i++) {
        const theta = -Math.PI + ((i + 0.5) * 2 * Math.PI) / steps;
        sum += donelanBannerSpreading(ratio, theta);
      }
      expect(sum * ((2 * Math.PI) / steps)).toBeCloseTo(1, 4);
    }
  });

  it('suppresses components travelling against the wind', () => {
    expect(backwardSuppression(1)).toBe(1);
    expect(backwardSuppression(-1)).toBeLessThan(0.1);
    expect(backwardSuppression(0)).toBeGreaterThan(backwardSuppression(-1));
    const p = jonswapParameters({ windSpeedMs: 10, fetchM: DEFAULT_FETCH_M });
    const k = (p.peakOmega * p.peakOmega) / G;
    expect(wavenumberSpectrum(-k, 0, 1, 0, p)).toBeLessThan(0.01 * wavenumberSpectrum(k, 0, 1, 0, p));
  });

  it('integrates over the wavenumber plane to m0 (minus the suppressed share)', () => {
    const p = jonswapParameters({ windSpeedMs: 10, fetchM: DEFAULT_FETCH_M });
    const kp = (p.peakOmega * p.peakOmega) / G;
    const dk = kp / 12;
    const kMax = 40 * kp;
    const windX = Math.SQRT1_2;
    const windZ = Math.SQRT1_2;
    let sum = 0;
    for (let kx = -kMax + dk / 2; kx < kMax; kx += dk) {
      for (let kz = -kMax + dk / 2; kz < kMax; kz += dk) {
        sum += wavenumberSpectrum(kx, kz, windX, windZ, p);
      }
    }
    const ratio = (sum * dk * dk) / spectralMoment0(p);
    expect(ratio).toBeGreaterThan(0.88);
    expect(ratio).toBeLessThan(1.01);
  });
});

describe('surface slopes and whitecaps', () => {
  it('uses the Cox-Munk mean-square slope', () => {
    expect(coxMunkSlopeVariance(0)).toBeCloseTo(0.003, 9);
    expect(coxMunkSlopeVariance(10)).toBeCloseTo(0.0542, 9);
  });

  it('resolves more slope variance with a higher cutoff wavenumber', () => {
    const p = jonswapParameters({ windSpeedMs: 10, fetchM: DEFAULT_FETCH_M });
    let previous = 0;
    for (const k of [0.05, 0.5, 5, 50]) {
      const v = resolvedSlopeVariance(p, k);
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
    // The long waves alone are much smoother than the measured total.
    expect(resolvedSlopeVariance(p, 0.5)).toBeLessThan(coxMunkSlopeVariance(10));
  });

  it('reports the unresolved variance as non-negative and decreasing', () => {
    const p = jonswapParameters({ windSpeedMs: 15, fetchM: DEFAULT_FETCH_M });
    let previous = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 16; i++) {
      const k = 0.01 * 10 ** (i / 3);
      const v = unresolvedSlopeVariance(p, k, 30);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(previous + 1e-12);
      previous = v;
    }
    const calm = jonswapParameters({ windSpeedMs: 0, fetchM: DEFAULT_FETCH_M });
    expect(unresolvedSlopeVariance(calm, 1, 30)).toBeCloseTo(0.003, 9);
  });

  it('follows Monahan whitecap coverage (none below Bf 3, several % at Bf 8)', () => {
    expect(whitecapCoverage(3)).toBeLessThan(0.0003);
    expect(whitecapCoverage(beaufortMidSpeed(8))).toBeGreaterThan(0.05);
    expect(whitecapCoverage(100)).toBe(1);
  });
});

describe('inverseNormalCdf', () => {
  it('inverts known quantiles', () => {
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 9);
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.959964, 5);
    expect(inverseNormalCdf(0.001)).toBeCloseTo(-3.090232, 5);
    expect(inverseNormalCdf(0)).toBe(Number.NEGATIVE_INFINITY);
  });
});
