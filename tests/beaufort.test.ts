import { describe, expect, it } from 'vitest';
import {
  BEAUFORT_TABLE,
  beaufortMidSpeed,
  beaufortToWindSpeed,
  windSpeedToBeaufort,
} from '../src/ocean/beaufort';

describe('Beaufort scale', () => {
  it('has 13 contiguous classes', () => {
    expect(BEAUFORT_TABLE).toHaveLength(13);
    BEAUFORT_TABLE.forEach((entry, i) => expect(entry.beaufort).toBe(i));
  });

  it('maps every integer Beaufort number into its own speed class', () => {
    for (const entry of BEAUFORT_TABLE) {
      const speed = beaufortToWindSpeed(entry.beaufort);
      expect(speed).toBeGreaterThanOrEqual(entry.minSpeedMs);
      expect(speed).toBeLessThanOrEqual(entry.maxSpeedMs);
      expect(windSpeedToBeaufort(speed)).toBe(entry.beaufort);
    }
  });

  it('classifies the published class bounds', () => {
    for (const entry of BEAUFORT_TABLE) {
      expect(windSpeedToBeaufort(entry.minSpeedMs)).toBe(entry.beaufort);
      if (Number.isFinite(entry.maxSpeedMs)) {
        expect(windSpeedToBeaufort(entry.maxSpeedMs)).toBe(entry.beaufort);
      }
    }
    expect(windSpeedToBeaufort(40)).toBe(12);
  });

  it('round-trips class mid speeds', () => {
    for (const entry of BEAUFORT_TABLE) {
      expect(windSpeedToBeaufort(beaufortMidSpeed(entry.beaufort))).toBe(entry.beaufort);
    }
    expect(beaufortMidSpeed(6)).toBeCloseTo(12.3, 6);
  });

  it('is monotonic and clamps fractional input', () => {
    let previous = -1;
    for (let b = 0; b <= 12; b += 0.25) {
      const speed = beaufortToWindSpeed(b);
      expect(speed).toBeGreaterThan(previous);
      previous = speed;
    }
    expect(beaufortToWindSpeed(-3)).toBe(0);
    expect(beaufortToWindSpeed(20)).toBe(beaufortToWindSpeed(12));
  });
});
