/**
 * Hydrostatics of the hull on flat water (design condition): displaced volume,
 * centre of buoyancy, waterplane properties and the resulting stability, and
 * the automatic fit of the section shape to the vessel's mass.
 */
import { SEA_WATER_DENSITY_KG_M3 } from '../core/constants';
import { BuoyancySolver } from './buoyancy';
import { buildHullMesh, waterplaneProperties, type HullMesh } from './hull';
import { RigidBody } from './rigidBody';
import type { HullFormConfig } from './shipConfig';
import { FlatWater } from './waterHeightProvider';

export interface Hydrostatics {
  /** Displaced volume at the design waterline (m^3). */
  readonly volumeM3: number;
  /** Centre of buoyancy in the hull frame (m). */
  readonly centreOfBuoyancy: [number, number, number];
  readonly waterplaneAreaM2: number;
  /** Transverse metacentric radius BM = I_T / V (m). */
  readonly metacentricRadiusM: number;
}

/**
 * Submerged volume and its centroid for a mesh in the hull frame floating
 * upright with the waterline at y = 0. Uses the divergence theorem over the
 * clipped hull surface; the (open) waterplane lid lies at y = 0 and adds nothing.
 */
export function computeHydrostatics(mesh: HullMesh, form: HullFormConfig): Hydrostatics {
  const solver = new BuoyancySolver(mesh.positions, mesh.indices);
  // A body at the origin with identity orientation maps hull-frame points unchanged.
  const body = new RigidBody(1, [1, 1, 1]);
  solver.apply(body, new FlatWater(0), 0);
  const s = solver.submerged;
  let volume = 0;
  let momentX = 0;
  let momentY = 0;
  let momentZ = 0;
  for (let i = 0; i < s.count; i++) {
    const area = s.areas[i] as number;
    const nx = s.normals[3 * i] as number;
    const ny = s.normals[3 * i + 1] as number;
    const nz = s.normals[3 * i + 2] as number;
    const c = s.corners;
    const x = [c[9 * i] as number, c[9 * i + 3] as number, c[9 * i + 6] as number];
    const y = [c[9 * i + 1] as number, c[9 * i + 4] as number, c[9 * i + 7] as number];
    const z = [c[9 * i + 2] as number, c[9 * i + 5] as number, c[9 * i + 8] as number];
    const mean = (v: number[]): number => ((v[0] as number) + (v[1] as number) + (v[2] as number)) / 3;
    // Exact integral of a quadratic over a triangle: A/6 (sum v_i^2 + sum_{i<j} v_i v_j).
    const square = (v: number[]): number => {
      const [a, b, cc] = v as [number, number, number];
      return (area / 6) * (a * a + b * b + cc * cc + a * b + b * cc + a * cc);
    };
    // V = closed-surface integral of y n_y dA (divergence theorem, outward normals).
    volume += mean(y) * area * ny;
    // Centroid: V x_c = integral of x^2 / 2 n_x dA (and alike for y, z).
    momentX += 0.5 * square(x) * nx;
    momentY += 0.5 * square(y) * ny;
    momentZ += 0.5 * square(z) * nz;
  }
  const waterplane = waterplaneProperties(form);
  return {
    volumeM3: volume,
    centreOfBuoyancy: [momentX / volume, momentY / volume, momentZ / volume],
    waterplaneAreaM2: waterplane.areaM2,
    metacentricRadiusM: waterplane.transverseInertiaM4 / volume,
  };
}

/** Section exponents searched when fitting the hull to the displacement. */
const SECTION_EXPONENT_MIN = 0.05;
const SECTION_EXPONENT_MAX = 2.5;
const FIT_ITERATIONS = 50;

/**
 * Finds the section exponent q for which the displaced volume at the design
 * draft equals mass / rho, so that the vessel floats exactly at its design
 * waterline. Throws if the displacement cannot be reached with this hull form.
 */
export function fitSectionExponent(
  form: HullFormConfig,
  massKg: number,
  stations: number,
  pointsPerSide: number,
  density = SEA_WATER_DENSITY_KG_M3,
): number {
  const target = massKg / density;
  const volume = (q: number): number =>
    computeHydrostatics(buildHullMesh(form, stations, pointsPerSide, q), form).volumeM3;
  let low = SECTION_EXPONENT_MIN; // fullest sections, largest volume
  let high = SECTION_EXPONENT_MAX;
  if (volume(low) < target || volume(high) > target) {
    throw new RangeError(`hull form cannot displace ${massKg} kg at the design draft`);
  }
  for (let i = 0; i < FIT_ITERATIONS; i++) {
    const mid = 0.5 * (low + high);
    if (volume(mid) > target) low = mid;
    else high = mid;
  }
  return 0.5 * (low + high);
}
