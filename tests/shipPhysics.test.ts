import { describe, expect, it } from 'vitest';
import { SEA_WATER_DENSITY_KG_M3 } from '../src/core/constants';
import { BuoyancySolver } from '../src/ship/buoyancy';
import { buildHullMesh, meshVolume } from '../src/ship/hull';
import { ittcFrictionCoefficient } from '../src/ship/hydrodynamics';
import { RigidBody } from '../src/ship/rigidBody';
import { Ship, buildShipModel } from '../src/ship/ship';
import { PATROL_BOAT } from '../src/ship/shipConfig';
import { FlatWater, RegularWave, type WaterHeightProvider } from '../src/ship/waterHeightProvider';

const DT = 1 / 120;
const DEG = Math.PI / 180;
const model = buildShipModel(PATROL_BOAT);
const flat = new FlatWater(0);

function simulate(ship: Ship, seconds: number, water: WaterHeightProvider = flat, onStep?: (t: number) => void): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    ship.step(DT, water, i * DT);
    onStep?.((i + 1) * DT);
  }
}

describe('hull mesh', () => {
  const mesh = model.physicsMesh;

  it('is a low-poly closed surface of the requested size', () => {
    expect(mesh.triangleCount).toBeGreaterThanOrEqual(300);
    expect(mesh.triangleCount).toBeLessThanOrEqual(800);
    // Every edge is shared by exactly two triangles with opposite directions.
    const edges = new Map<string, number>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = mesh.indices[t + e] as number;
        const b = mesh.indices[t + ((e + 1) % 3)] as number;
        const key = `${a}>${b}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    for (const [key, count] of edges) {
      expect(count).toBe(1);
      const [a, b] = key.split('>');
      expect(edges.get(`${b}>${a}`)).toBe(1);
    }
  });

  it('has outward normals (positive enclosed volume) and the configured dimensions', () => {
    expect(meshVolume(mesh.positions, mesh.indices)).toBeGreaterThan(0);
    let minX = Infinity, maxX = -Infinity, maxZ = 0, minY = Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      minX = Math.min(minX, mesh.positions[i] as number);
      maxX = Math.max(maxX, mesh.positions[i] as number);
      minY = Math.min(minY, mesh.positions[i + 1] as number);
      maxZ = Math.max(maxZ, Math.abs(mesh.positions[i + 2] as number));
    }
    expect(maxX - minX).toBeCloseTo(PATROL_BOAT.hull.lengthM, 6);
    expect(minY).toBeCloseTo(-PATROL_BOAT.hull.designDraftM, 6);
    expect(maxZ).toBeGreaterThanOrEqual(PATROL_BOAT.hull.beamM / 2);
  });

  it('displaces the vessel mass at the design draft', () => {
    expect(model.hydrostatics.volumeM3 * SEA_WATER_DENSITY_KG_M3).toBeCloseTo(PATROL_BOAT.mass.massKg, -2);
  });
});

describe('buoyancy', () => {
  it('equals rho g V for a fully submerged closed box, with no net torque', () => {
    const box = buildHullMesh({ ...PATROL_BOAT.hull, transomBreadthFraction: 1, bowEntranceShape: 0, forefootStartFraction: 1, deckFlareFraction: 0, bowSheerM: 0 }, 5, 4, 0.0001);
    const solver = new BuoyancySolver(box.positions, box.indices);
    const body = new RigidBody(1, [1, 1, 1]);
    const result = solver.apply(body, new FlatWater(100), 0);
    const volume = meshVolume(box.positions, box.indices);
    expect(result.force[1]).toBeCloseTo(SEA_WATER_DENSITY_KG_M3 * 9.81 * volume, -2);
    expect(Math.abs(result.force[0] as number)).toBeLessThan(1e-6 * (result.force[1] as number));
  });

  it('produces no force out of the water', () => {
    const solver = new BuoyancySolver(model.bodyVertices, model.physicsMesh.indices);
    const body = new RigidBody(1, [1, 1, 1]);
    body.position[1] = 100;
    expect(solver.apply(body, flat, 0).force[1]).toBe(0);
  });
});

describe('ship on flat water', () => {
  it('settles at the design draft (within 5 %)', () => {
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0, heaveM: 0.8 });
    simulate(ship, 60);
    expect(ship.draftM).toBeGreaterThan(PATROL_BOAT.hull.designDraftM * 0.95);
    expect(ship.draftM).toBeLessThan(PATROL_BOAT.hull.designDraftM * 1.05);
    expect(Math.abs(ship.body.velocity[1] as number)).toBeLessThan(0.01);
    expect(Math.abs(ship.pitchRad)).toBeLessThan(0.5 * DEG);
  });

  it('does not drift without wind or propulsion', () => {
    // At rest in equilibrium nothing may move at all.
    const still = new Ship(model, { x: 1000, z: -2000, headingRad: 1 });
    simulate(still, 30);
    simulate(still, 120);
    const origin = still.hullPointToWorld(0, 0, 0, new Float64Array(3));
    expect(Math.hypot((origin[0] as number) - 1000, (origin[2] as number) + 2000)).toBeLessThan(0.05);
    expect(still.headingRad).toBeCloseTo(1, 4);

    // After a disturbance (heave and heel) the motion dies out without a residual drift.
    const disturbed = new Ship(model, { x: 0, z: 0, headingRad: 2, heaveM: 0.3, rollRad: 3 * DEG });
    simulate(disturbed, 60);
    const before = Float64Array.from(disturbed.body.position);
    simulate(disturbed, 60);
    const moved = Math.hypot((disturbed.body.position[0] as number) - (before[0] as number), (disturbed.body.position[2] as number) - (before[2] as number));
    expect(moved).toBeLessThan(0.05);
    expect(disturbed.speedMs).toBeLessThan(1e-3);
  });

  it('rolls back upright from 15 degrees with a realistic, decaying roll', () => {
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0, rollRad: 15 * DEG });
    const crossings: number[] = [];
    let previous = ship.rollRad;
    let peakAfter20s = 0;
    simulate(ship, 60, flat, (t) => {
      const roll = ship.rollRad;
      if (previous > 0 && roll <= 0) crossings.push(t);
      previous = roll;
      if (t > 20) peakAfter20s = Math.max(peakAfter20s, Math.abs(roll));
    });
    expect(crossings.length).toBeGreaterThanOrEqual(2);
    const period = (crossings[1] as number) - (crossings[0] as number);
    expect(period).toBeGreaterThan(6);
    expect(period).toBeLessThan(10);
    // Decayed well below the initial heel and upright at the end.
    expect(peakAfter20s).toBeLessThan(5 * DEG);
    expect(Math.abs(ship.rollRad)).toBeLessThan(2 * DEG);
  });

  it('has natural periods typical of a 50 m vessel', () => {
    expect(model.naturalRollPeriodS).toBeGreaterThan(6);
    expect(model.naturalRollPeriodS).toBeLessThan(10);
    expect(model.naturalHeavePeriodS).toBeGreaterThan(2);
    expect(model.naturalHeavePeriodS).toBeLessThan(5);
  });
});

describe('ship in waves', () => {
  it('heaves with a long swell', () => {
    const swell = new RegularWave({ amplitudeM: 1, wavelengthM: 200, directionX: 1, directionZ: 0 });
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0 });
    simulate(ship, 30, swell);
    let minY = Infinity;
    let maxY = -Infinity;
    simulate(ship, swell.periodS * 2, swell, () => {
      const y = ship.body.position[1] as number;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    });
    // A 200 m swell is four ship lengths long: the ship follows it closely.
    expect((maxY - minY) / 2).toBeGreaterThan(0.7);
    expect((maxY - minY) / 2).toBeLessThan(1.3);
  });

  it('rolls in beam seas and stays upright', () => {
    // Heading north (-Z): waves travelling along +X hit the ship from the side.
    const beamSea = new RegularWave({ amplitudeM: 1.5, wavelengthM: 80, directionX: 1, directionZ: 0, choppiness: 0.8 });
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0 });
    let maxRoll = 0;
    simulate(ship, 60, beamSea, () => {
      maxRoll = Math.max(maxRoll, Math.abs(ship.rollRad));
    });
    expect(maxRoll).toBeGreaterThan(1 * DEG);
    expect(maxRoll).toBeLessThan(35 * DEG);
  });
});

describe('ITTC-1957', () => {
  it('matches tabulated friction coefficients', () => {
    expect(ittcFrictionCoefficient(1e7)).toBeCloseTo(0.075 / 25, 6);
    expect(ittcFrictionCoefficient(4e8)).toBeCloseTo(0.075 / (Math.log10(4e8) - 2) ** 2, 9);
  });
});
