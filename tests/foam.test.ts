import { describe, expect, it } from 'vitest';
import { beaufortMidSpeed } from '../src/ocean/beaufort';
import { NO_FOAM_THRESHOLD } from '../src/ocean/cascades';
import { foamParametersForSeaState } from '../src/ocean/ocean';
import { OCEAN_QUALITY, computeCascadeBands } from '../src/ocean/oceanConfig';
import { jonswapParameters } from '../src/ocean/spectrumModel';

const bands = computeCascadeBands(OCEAN_QUALITY.medium.fftSize, OCEAN_QUALITY.medium.cascadeCount);
const foamFor = (beaufort: number) =>
  foamParametersForSeaState(
    jonswapParameters({ windSpeedMs: beaufortMidSpeed(beaufort), fetchM: 300_000 }),
    bands,
    0.9,
  );

describe('foam calibration', () => {
  it('produces no foam on a calm sea', () => {
    const calm = foamParametersForSeaState(jonswapParameters({ windSpeedMs: 0, fetchM: 300_000 }), bands, 0.9);
    expect(calm.jacobianThresholds.every((t) => t === NO_FOAM_THRESHOLD)).toBe(true);
  });

  it('raises the Jacobian threshold (more foam) with the wind', () => {
    const light = foamFor(3);
    const strong = foamFor(8);
    for (let c = 0; c < 2; c++) {
      const lightMargin = 1 - (light.jacobianThresholds[c] as number);
      const strongMargin = 1 - (strong.jacobianThresholds[c] as number);
      // Margin below J = 1 in standard deviations shrinks as breaking becomes common.
      expect(strongMargin / (strong.softness[c] as number)).toBeLessThan(lightMargin / (light.softness[c] as number));
    }
  });

  it('only affects the two long-wave cascades', () => {
    expect(foamFor(6).jacobianThresholds).toHaveLength(2);
  });
});
