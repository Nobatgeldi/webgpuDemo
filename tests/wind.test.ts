import { describe, expect, it } from 'vitest';
import { Ship, buildShipModel } from '../src/ship/ship';
import { PATROL_BOAT } from '../src/ship/shipConfig';
import { FlatWater } from '../src/ship/waterHeightProvider';
import { WIND_REFERENCE_HEIGHT_M, windSpeedAtHeight, windVelocity } from '../src/ship/wind';
import { beaufortToWindSpeed } from '../src/ocean/beaufort';

const DT = 1 / 120;
const DEG = Math.PI / 180;
const model = buildShipModel(PATROL_BOAT);
const flat = new FlatWater(0);

describe('wind profile and direction', () => {
  it('uses the 10 m wind at the reference height and less below', () => {
    expect(windSpeedAtHeight(12, WIND_REFERENCE_HEIGHT_M)).toBeCloseTo(12, 12);
    expect(windSpeedAtHeight(12, 3)).toBeLessThan(12);
    expect(windSpeedAtHeight(12, 30)).toBeGreaterThan(12);
  });

  it('blows away from the direction it comes from', () => {
    // From the north: the air moves south (+Z).
    const [nx, nz] = windVelocity(10, 0);
    expect(nx).toBeCloseTo(0, 12);
    expect(nz).toBeCloseTo(10, 12);
    // From the east: the air moves west (-X).
    const [ex, ez] = windVelocity(10, 90 * DEG);
    expect(ex).toBeCloseTo(-10, 12);
    expect(ez).toBeCloseTo(0, 12);
  });
});

describe('windage', () => {
  it('has plausible areas and a centre of effort above the waterline', () => {
    const w = model.windage;
    // Hull topsides alone: ~50 m x ~2.7 m; with the superstructure about 200 m^2.
    expect(w.lateralAreaM2).toBeGreaterThan(150);
    expect(w.lateralAreaM2).toBeLessThan(300);
    expect(w.frontalAreaM2).toBeGreaterThan(30);
    expect(w.frontalAreaM2).toBeLessThan(w.lateralAreaM2);
    expect(w.lateralCentre[1]).toBeGreaterThan(PATROL_BOAT.hull.freeboardM / 2);
    expect(Math.abs(w.lateralCentre[0])).toBeLessThan(PATROL_BOAT.hull.lengthM / 4);
  });
});

describe('ship in a beam wind', () => {
  it('heels to leeward and drifts downwind', () => {
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0 });
    // Bf 8 from the east, on the starboard beam of a ship heading north.
    ship.setWind(beaufortToWindSpeed(8), 90 * DEG);
    let rollSum = 0;
    let samples = 0;
    const seconds = 90;
    for (let i = 0; i < seconds / DT; i++) {
      ship.step(DT, flat, i * DT);
      if (i * DT > seconds / 2) {
        rollSum += ship.rollRad;
        samples++;
      }
    }
    const meanRoll = rollSum / samples;
    // Leeward is port: negative heel, a few degrees for GM 1.2 m.
    expect(meanRoll).toBeLessThan(-0.5 * DEG);
    expect(meanRoll).toBeGreaterThan(-10 * DEG);
    // Drifts west (-X).
    expect(ship.body.velocity[0] as number).toBeLessThan(-0.05);
    expect(ship.body.position[0] as number).toBeLessThan(-1);
    expect(Math.abs(ship.windLoad.state.swayForceN)).toBeGreaterThan(0);
  });

  it('feels no wind load in calm air when not moving', () => {
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0 });
    ship.setWind(0, 0);
    ship.step(DT, flat, 0);
    expect(Math.abs(ship.windLoad.state.swayForceN)).toBe(0);
    expect(Math.abs(ship.windLoad.state.surgeForceN)).toBe(0);
  });
});
