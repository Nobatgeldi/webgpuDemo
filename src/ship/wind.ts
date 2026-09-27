/**
 * Wind load on the vessel's above-water profile.
 *
 * The relative (apparent) wind = true wind at the height of the load - velocity
 * of the ship at that point. Its component along the ship pushes on the frontal
 * area, the athwartships component on the lateral area:
 *   F = 1/2 rho_air C_d A v|v|
 * applied at the centroids of the projected areas, high above the centre of
 * gravity, so a beam wind both drifts the ship and heels it to leeward.
 *
 * The areas and centroids are derived from the hull form and the superstructure
 * by rasterising their silhouettes (the union, so overlapping boxes are not
 * counted twice).
 */
import { AIR_DENSITY_KG_M3 } from '../core/constants';
import { hullSection } from './hull';
import { BODY_FORWARD, BODY_STARBOARD, type RigidBody } from './rigidBody';
import type { ShipConfig } from './shipConfig';
import { ShipMaterial, superstructure } from './shipMesh';

/** Reference height of the 10 m wind (m). */
export const WIND_REFERENCE_HEIGHT_M = 10;
/**
 * Power-law exponent of the wind profile over open sea, U(z) = U10 (z / 10)^a
 * (neutral stability; ISO 19901-1 / DNV-RP-C205 use ~0.11-0.13).
 */
export const WIND_PROFILE_EXPONENT = 0.11;
/** Heights below this use the wind at this height (the power law goes to zero at the surface) (m). */
const WIND_PROFILE_MIN_HEIGHT_M = 1;
/** Resolution of the silhouette raster (m). */
const WINDAGE_RASTER_CELL_M = 0.05;
/** Stations for the hull outline in the silhouette raster. */
const WINDAGE_HULL_STATIONS = 200;

/** Wind speed at a height above sea level for a given 10 m wind speed. */
export function windSpeedAtHeight(windSpeed10M: number, heightM: number): number {
  const z = Math.max(heightM, WIND_PROFILE_MIN_HEIGHT_M);
  return windSpeed10M * Math.pow(z / WIND_REFERENCE_HEIGHT_M, WIND_PROFILE_EXPONENT);
}

/** Horizontal world velocity (x, z) of a wind blowing FROM `fromRad` (clockwise from north). */
export function windVelocity(speedMs: number, fromRad: number): [number, number] {
  // North is -Z, east is +X; the air moves towards the opposite direction.
  return [-speedMs * Math.sin(fromRad), speedMs * Math.cos(fromRad)];
}

export interface Windage {
  /** Projected area seen from abeam and from ahead, above the design waterline (m^2). */
  readonly lateralAreaM2: number;
  readonly frontalAreaM2: number;
  /** Centroid of the lateral area in the hull frame (x, y) (m). */
  readonly lateralCentre: readonly [number, number];
  /** Height of the frontal area centroid above the design waterline (m). */
  readonly frontalCentreHeightM: number;
}

interface Rect {
  readonly u0: number;
  readonly u1: number;
  readonly y0: number;
  readonly y1: number;
}

/** Area and centroid of the union of rectangles above y = 0, by rasterisation. */
function silhouette(rects: readonly Rect[]): { area: number; u: number; y: number } {
  const cell = WINDAGE_RASTER_CELL_M;
  let uMin = Infinity, uMax = -Infinity, yMax = 0;
  for (const r of rects) {
    uMin = Math.min(uMin, r.u0);
    uMax = Math.max(uMax, r.u1);
    yMax = Math.max(yMax, r.y1);
  }
  const columns = Math.ceil((uMax - uMin) / cell);
  const rows = Math.ceil(yMax / cell);
  let count = 0, su = 0, sy = 0;
  for (let i = 0; i < columns; i++) {
    const u = uMin + (i + 0.5) * cell;
    for (let j = 0; j < rows; j++) {
      const y = (j + 0.5) * cell;
      if (rects.some((r) => u >= r.u0 && u < r.u1 && y >= r.y0 && y < r.y1)) {
        count++;
        su += u;
        sy += y;
      }
    }
  }
  const area = count * cell * cell;
  return { area, u: count > 0 ? su / count : 0, y: count > 0 ? sy / count : 0 };
}

export function computeWindage(config: ShipConfig): Windage {
  const form = config.hull;
  const half = form.lengthM / 2;
  const lateral: Rect[] = [];
  const frontal: Rect[] = [];
  const dx = form.lengthM / WINDAGE_HULL_STATIONS;
  for (let i = 0; i < WINDAGE_HULL_STATIONS; i++) {
    const x = -half + (i + 0.5) * dx;
    const section = hullSection(form, x / half);
    lateral.push({ u0: x - dx / 2, u1: x + dx / 2, y0: 0, y1: section.deckHeightM });
    // Topsides flare from the waterline breadth to the deck breadth; the silhouette takes the mean.
    const halfBreadth = section.halfBreadthM * (1 + form.deckFlareFraction / 2);
    frontal.push({ u0: -halfBreadth, u1: halfBreadth, y0: 0, y1: section.deckHeightM });
  }
  for (const box of superstructure(config)) {
    if (box.material === ShipMaterial.Glass) continue; // flush with the box faces
    const y0 = Math.max(0, box.min[1]);
    lateral.push({ u0: box.min[0], u1: box.max[0], y0, y1: box.max[1] });
    frontal.push({ u0: box.min[2], u1: box.max[2], y0, y1: box.max[1] });
  }
  const side = silhouette(lateral);
  const front = silhouette(frontal);
  return {
    lateralAreaM2: side.area,
    frontalAreaM2: front.area,
    lateralCentre: [side.u, side.y],
    frontalCentreHeightM: front.y,
  };
}

export interface WindLoadState {
  /** Apparent wind speed at the lateral centre of effort (m/s). */
  apparentSpeedMs: number;
  /** Apparent wind direction relative to the bow, where it comes FROM, positive to starboard (rad). */
  apparentFromRelativeRad: number;
  /** Force along the ship (positive forward) and athwartships (positive to starboard) (N). */
  surgeForceN: number;
  swayForceN: number;
}

export class WindLoad {
  readonly state: WindLoadState = { apparentSpeedMs: 0, apparentFromRelativeRad: 0, surgeForceN: 0, swayForceN: 0 };
  private readonly point = new Float64Array(3);
  private readonly velocity = new Float64Array(3);
  private readonly forward = new Float64Array(3);
  private readonly starboard = new Float64Array(3);
  private readonly relative = new Float64Array(3);

  constructor(
    readonly windage: Windage,
    private readonly config: ShipConfig['windage'],
    /** Centre of gravity in the hull frame. */
    private readonly centreOfGravity: readonly number[],
  ) {}

  /**
   * Applies the wind load for a true 10 m wind with horizontal world velocity
   * (windX, windZ).
   */
  apply(body: RigidBody, windX: number, windZ: number): void {
    const w = this.windage;
    const s = this.state;
    body.rotateToWorld(BODY_FORWARD, this.forward);
    body.rotateToWorld(BODY_STARBOARD, this.starboard);
    // Lateral load at the lateral centroid.
    const lateral = this.relativeWind(body, w.lateralCentre[0], w.lateralCentre[1], windX, windZ);
    const v = this.dot(lateral, this.starboard);
    const u = this.dot(lateral, this.forward);
    s.apparentSpeedMs = Math.hypot(u, v);
    // The wind comes from where it blows to, reversed.
    s.apparentFromRelativeRad = s.apparentSpeedMs > 0 ? Math.atan2(-v, -u) : 0;
    s.swayForceN = 0.5 * AIR_DENSITY_KG_M3 * this.config.lateralDragCoefficient * w.lateralAreaM2 * v * Math.abs(v);
    this.addForce(body, this.starboard, s.swayForceN);
    // Frontal load at the frontal centroid (on the centreline, amidships).
    const frontal = this.relativeWind(body, 0, w.frontalCentreHeightM, windX, windZ);
    const uf = this.dot(frontal, this.forward);
    s.surgeForceN = 0.5 * AIR_DENSITY_KG_M3 * this.config.frontalDragCoefficient * w.frontalAreaM2 * uf * Math.abs(uf);
    this.addForce(body, this.forward, s.surgeForceN);
  }

  /** Relative wind at a hull-frame point (x, y, 0); leaves the world point in this.point. */
  private relativeWind(body: RigidBody, x: number, y: number, windX: number, windZ: number): Float64Array {
    const cog = this.centreOfGravity;
    this.point[0] = x - (cog[0] as number);
    this.point[1] = y - (cog[1] as number);
    this.point[2] = -(cog[2] as number);
    body.pointToWorld(this.point, this.point);
    body.pointVelocity(this.point[0] as number, this.point[1] as number, this.point[2] as number, this.velocity);
    const scale = windSpeedAtHeight(1, this.point[1] as number);
    this.relative[0] = windX * scale - (this.velocity[0] as number);
    this.relative[1] = -(this.velocity[1] as number);
    this.relative[2] = windZ * scale - (this.velocity[2] as number);
    return this.relative;
  }

  private addForce(body: RigidBody, axis: Float64Array, magnitude: number): void {
    body.addForceAtPoint(
      magnitude * (axis[0] as number),
      magnitude * (axis[1] as number),
      magnitude * (axis[2] as number),
      this.point[0] as number,
      this.point[1] as number,
      this.point[2] as number,
    );
  }

  private dot(a: Float64Array, b: Float64Array): number {
    return (a[0] as number) * (b[0] as number) + (a[1] as number) * (b[1] as number) + (a[2] as number) * (b[2] as number);
  }
}
