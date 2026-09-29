import { describe, expect, it } from 'vitest';
import { MAX_WAKE_EMITTERS, ShipEffectSources, depositRate } from '../src/effects/shipEffectSources';
import { Ship, buildShipModel } from '../src/ship/ship';
import { KNOTS_TO_MS, PATROL_BOAT } from '../src/ship/shipConfig';
import { FlatWater, RegularWave } from '../src/ship/waterHeightProvider';

const model = buildShipModel(PATROL_BOAT);
const DT = 1 / 60;

describe('wake deposit model', () => {
  it('leaves the requested foam behind a passing Gaussian source', () => {
    // Integrate rate * exp(-x^2 / 2r^2) over the passage time.
    const r = 2;
    const u = 5;
    const rate = depositRate(0.8, r, u);
    let deposit = 0;
    const dt = 1e-3;
    for (let t = -10; t < 10; t += dt) deposit += rate * Math.exp(-((u * t) ** 2) / (2 * r * r)) * dt;
    expect(deposit).toBeCloseTo(0.8, 3);
  });
});

describe('ship effect sources', () => {
  it('makes no white water at rest and a full wake at speed', () => {
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0 });
    const sources = new ShipEffectSources(ship);
    sources.update(new FlatWater(0), 0, DT);
    expect(sources.wakeEmitters).toHaveLength(MAX_WAKE_EMITTERS);
    expect(sources.wakeEmitters.every((e) => e.amount === 0)).toBe(true);
    expect(sources.sprayEmitterCount).toBe(0);

    ship.setForwardSpeed(22 * KNOTS_TO_MS);
    sources.update(new FlatWater(0), DT, DT);
    expect(sources.froude).toBeGreaterThan(0.45);
    // Stern wake and hull-side foam; steady bow spray on both sides, no slamming in flat water.
    expect(sources.wakeEmitters[1]!.amount).toBeGreaterThan(0);
    expect(sources.wakeEmitters[2]!.amount).toBeGreaterThan(0);
    expect(sources.sprayEmitterCount).toBe(2);
    expect(Math.abs(sources.bowEntrySpeedMs)).toBeLessThan(1e-9);
  });

  it('detects the bow plunging into a wave crest', () => {
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0 });
    const sources = new ShipEffectSources(ship);
    // A steep regular wave running against the bow, the ship held still: the water rises and falls at the bow.
    const wave = new RegularWave({ amplitudeM: 2.5, wavelengthM: 60, directionX: 0, directionZ: 1 });
    let maxEntry = 0;
    for (let i = 0; i < 600; i++) {
      sources.update(wave, i * DT, DT);
      maxEntry = Math.max(maxEntry, sources.bowEntrySpeedMs);
    }
    // Vertical water speed amplitude a * omega ~ 2.5 m * 1.01 rad/s.
    expect(maxEntry).toBeGreaterThan(1.5);
    expect(maxEntry).toBeLessThan(3.5);
  });
});
