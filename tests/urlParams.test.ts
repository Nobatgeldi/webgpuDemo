import { describe, expect, it } from 'vitest';
import { DEFAULT_QUALITY, DEFAULT_SEED, parseLaunchOptions } from '../src/core/urlParams';

describe('parseLaunchOptions', () => {
  it('parses the documented example', () => {
    const { options, warnings } = parseLaunchOptions('?wind=6&dir=45&seed=1&quality=high&paused=1');
    expect(warnings).toEqual([]);
    expect(options).toEqual({
      beaufort: 6,
      windDirectionDeg: 45,
      seed: 1,
      quality: 'high',
      paused: true,
    });
  });

  it('returns defaults for an empty query', () => {
    const { options, warnings } = parseLaunchOptions('');
    expect(warnings).toEqual([]);
    expect(options).toEqual({
      beaufort: null,
      windDirectionDeg: null,
      seed: DEFAULT_SEED,
      quality: DEFAULT_QUALITY,
      paused: false,
    });
  });

  it('clamps Beaufort, wraps direction and accepts fractional wind', () => {
    expect(parseLaunchOptions('?wind=15').options.beaufort).toBe(12);
    expect(parseLaunchOptions('?wind=-1').options.beaufort).toBe(0);
    expect(parseLaunchOptions('?wind=4.5').options.beaufort).toBe(4.5);
    expect(parseLaunchOptions('?dir=370').options.windDirectionDeg).toBe(10);
    expect(parseLaunchOptions('?dir=-90').options.windDirectionDeg).toBe(270);
  });

  it('warns and falls back on invalid values', () => {
    const { options, warnings } = parseLaunchOptions(
      '?wind=abc&dir=&seed=-3&quality=ultra&paused=maybe',
    );
    expect(options.beaufort).toBeNull();
    expect(options.windDirectionDeg).toBeNull();
    expect(options.seed).toBe(DEFAULT_SEED);
    expect(options.quality).toBe(DEFAULT_QUALITY);
    expect(options.paused).toBe(false);
    expect(warnings).toHaveLength(5);
  });

  it('accepts boolean spellings and case-insensitive quality', () => {
    expect(parseLaunchOptions('?paused=true').options.paused).toBe(true);
    expect(parseLaunchOptions('?paused').options.paused).toBe(true);
    expect(parseLaunchOptions('?paused=0').options.paused).toBe(false);
    expect(parseLaunchOptions('?quality=LOW').options.quality).toBe('low');
  });

  it('rejects non-integer and out-of-range seeds', () => {
    expect(parseLaunchOptions('?seed=1.5').warnings).toHaveLength(1);
    expect(parseLaunchOptions('?seed=4294967296').warnings).toHaveLength(1);
    expect(parseLaunchOptions('?seed=4294967295').options.seed).toBe(4294967295);
  });
});
