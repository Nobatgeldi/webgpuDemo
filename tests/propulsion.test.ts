import { describe, expect, it } from 'vitest';
import { calmWaterResistance } from '../src/ship/hydrodynamics';
import { rudderDragCoefficient, rudderLiftCoefficient } from '../src/ship/propulsion';
import { Ship, buildShipModel } from '../src/ship/ship';
import { KNOTS_TO_MS, PATROL_BOAT } from '../src/ship/shipConfig';
import { FlatWater } from '../src/ship/waterHeightProvider';

const DT = 1 / 120;
const DEG = Math.PI / 180;
const model = buildShipModel(PATROL_BOAT);
const flat = new FlatWater(0);
const rudder = PATROL_BOAT.rudder;

function run(ship: Ship, seconds: number, onStep?: () => void, start = 0): number {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    ship.step(DT, flat, start + i * DT);
    onStep?.();
  }
  return start + steps * DT;
}

describe('resistance and propeller calibration', () => {
  it('has a realistic resistance at the design speed', () => {
    const r = calmWaterResistance(22 * KNOTS_TO_MS, model.coefficients);
    // ~250 kN: about 4-5 MW shaft power at 22 knots for a 50 m patrol boat.
    expect(r).toBeGreaterThan(150e3);
    expect(r).toBeLessThan(400e3);
  });

  it('reaches about 22 knots at full throttle on calm water', () => {
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0 });
    ship.helm.throttle = 1;
    run(ship, 200);
    const knots = ship.surgeSpeedMs / KNOTS_TO_MS;
    expect(knots).toBeGreaterThan(20);
    expect(knots).toBeLessThan(24);
  });

  it('goes astern with negative throttle', () => {
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0 });
    ship.helm.throttle = PATROL_BOAT.propulsion.minThrottle;
    run(ship, 60);
    expect(ship.surgeSpeedMs).toBeLessThan(-1);
  });

  it('spools the shaft up with the configured time constant', () => {
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0 });
    ship.helm.throttle = 1;
    run(ship, PATROL_BOAT.propulsion.rpmTimeConstantS);
    expect(ship.propulsion.state.rpm / PATROL_BOAT.propulsion.maxRpm).toBeCloseTo(1 - Math.exp(-1), 2);
  });

  it('loses thrust when the propeller leaves the water', () => {
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0, heaveM: 6 });
    ship.helm.throttle = 1;
    ship.propulsion.state.rpm = PATROL_BOAT.propulsion.maxRpm;
    ship.step(DT, flat, 0);
    expect(ship.propulsion.state.propellerImmersion).toBe(0);
    expect(ship.propulsion.state.thrustN).toBe(0);
  });
});

describe('rudder', () => {
  it('has a linear lift slope, stalls, and is antisymmetric', () => {
    const slope = (2 * Math.PI * rudder.aspectRatio) / (rudder.aspectRatio + 2);
    expect(rudderLiftCoefficient(5 * DEG, rudder)).toBeCloseTo(slope * 5 * DEG, 9);
    const peak = rudderLiftCoefficient(rudder.stallAngleRad, rudder);
    expect(rudderLiftCoefficient(rudder.stallAngleRad + 10 * DEG, rudder)).toBeLessThan(peak);
    expect(rudderLiftCoefficient(90 * DEG, rudder)).toBeCloseTo(peak * rudder.postStallLiftFraction, 9);
    expect(rudderLiftCoefficient(-12 * DEG, rudder)).toBeCloseTo(-rudderLiftCoefficient(12 * DEG, rudder), 12);
    // Flow from behind (going astern) reverses the rudder action.
    expect(Math.sign(rudderLiftCoefficient(Math.PI - 10 * DEG, rudder))).toBe(-1);
    expect(rudderDragCoefficient(45 * DEG, rudder)).toBeGreaterThan(rudderDragCoefficient(10 * DEG, rudder));
  });

  it('turns at the steering gear rate (~5 deg/s)', () => {
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0 });
    ship.helm.rudderOrderRad = rudder.maxAngleRad;
    run(ship, 2);
    expect(ship.propulsion.state.rudderAngleRad).toBeCloseTo(10 * DEG, 6);
    run(ship, 10);
    expect(ship.propulsion.state.rudderAngleRad).toBeCloseTo(rudder.maxAngleRad, 9);
  });

  it('turns the ship in a circle of 3-5 ship lengths at full speed, heeling moderately outwards', () => {
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0 });
    ship.helm.throttle = 1;
    let t = run(ship, 150);
    ship.helm.rudderOrderRad = rudder.maxAngleRad;
    let turned = 0;
    let previous = ship.headingRad;
    const track: [number, number][] = [];
    let steadyRoll = 0;
    while (turned < 4 * Math.PI && t < 600) {
      t = run(ship, DT, undefined, t);
      let delta = ship.headingRad - previous;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      turned += delta;
      previous = ship.headingRad;
      if (turned > 2 * Math.PI) {
        track.push([ship.body.position[0] as number, ship.body.position[2] as number]);
        steadyRoll = ship.rollRad;
      }
    }
    // Positive rudder turns to starboard (heading increases).
    expect(turned).toBeGreaterThan(0);
    const cx = track.reduce((sum, p) => sum + p[0], 0) / track.length;
    const cz = track.reduce((sum, p) => sum + p[1], 0) / track.length;
    const radius = track.reduce((sum, p) => sum + Math.hypot(p[0] - cx, p[1] - cz), 0) / track.length;
    const lengths = (2 * radius) / PATROL_BOAT.hull.lengthM;
    expect(lengths).toBeGreaterThan(3);
    expect(lengths).toBeLessThan(5);
    // Outward heel (to port in a starboard turn) of a few to ~15 degrees.
    expect(steadyRoll).toBeLessThan(-2 * DEG);
    expect(steadyRoll).toBeGreaterThan(-18 * DEG);
  });
});
