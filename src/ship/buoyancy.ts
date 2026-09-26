/**
 * Hydrostatic buoyancy by clipping hull triangles at the water surface
 * (J. Kerner, "Water interaction model for boats in video games", 2015).
 *
 * Every triangle is classified by the height of its vertices above the local
 * water surface. Fully submerged triangles are kept; partly submerged ones are
 * cut along the waterline into one or two submerged triangles. Each submerged
 * triangle receives the hydrostatic pressure force F = -rho g d A n (d: depth
 * of its centroid, n: outward normal) at its centroid. The submerged
 * triangles are kept for the hydrodynamic forces and the debug view.
 */
import { GRAVITY_M_S2, SEA_WATER_DENSITY_KG_M3 } from '../core/constants';
import type { RigidBody } from './rigidBody';
import type { WaterHeightProvider } from './waterHeightProvider';

/** Triangles below this area (m^2) carry no force (degenerate stem cap). */
const MIN_TRIANGLE_AREA_M2 = 1e-9;

/** Submerged triangles, stored in flat arrays (structure of arrays, no per-step allocation). */
export class SubmergedTriangles {
  count = 0;
  /** 9 values per triangle: world xyz of the three corners. */
  readonly corners: Float64Array;
  /** 3 values per triangle: world centroid. */
  readonly centroids: Float64Array;
  /** 3 values per triangle: unit outward normal (world). */
  readonly normals: Float64Array;
  readonly areas: Float64Array;
  /** Depth of the centroid below the water surface (m, positive). */
  readonly depths: Float64Array;
  /** 3 values per triangle: hydrostatic force (N), for the debug view. */
  readonly forces: Float64Array;

  constructor(readonly capacity: number) {
    this.corners = new Float64Array(capacity * 9);
    this.centroids = new Float64Array(capacity * 3);
    this.normals = new Float64Array(capacity * 3);
    this.areas = new Float64Array(capacity);
    this.depths = new Float64Array(capacity);
    this.forces = new Float64Array(capacity * 3);
  }
}

export interface BuoyancyResult {
  /** Total hydrostatic force (N, world). */
  readonly force: Float64Array;
  /** Submerged volume estimated from the vertical force, F_y / (rho g) (m^3). */
  submergedVolumeM3: number;
  /** World centre of buoyancy (point of application of the total force). */
  readonly centreOfBuoyancy: Float64Array;
}

export class BuoyancySolver {
  readonly submerged: SubmergedTriangles;
  readonly result: BuoyancyResult = {
    force: new Float64Array(3),
    submergedVolumeM3: 0,
    centreOfBuoyancy: new Float64Array(3),
  };
  /** World vertex positions and heights above the water of the latest step. */
  readonly worldVertices: Float64Array;
  readonly heights: Float64Array;
  private readonly local = new Float64Array(3);
  private readonly world = new Float64Array(3);
  /** Scratch corners (xyz + height) of the triangle being clipped. */
  private readonly corner = new Float64Array(12);

  constructor(
    /** Hull vertices in the body frame (relative to the centre of gravity). */
    private readonly bodyVertices: Float64Array,
    private readonly indices: Uint32Array,
    private readonly density = SEA_WATER_DENSITY_KG_M3,
  ) {
    const vertexCount = bodyVertices.length / 3;
    this.worldVertices = new Float64Array(vertexCount * 3);
    this.heights = new Float64Array(vertexCount);
    // A clipped triangle yields at most two submerged triangles.
    this.submerged = new SubmergedTriangles((indices.length / 3) * 2);
  }

  /**
   * Computes the submerged triangles and adds the hydrostatic forces to the body.
   */
  apply(body: RigidBody, water: WaterHeightProvider, timeS: number): BuoyancyResult {
    const vertexCount = this.bodyVertices.length / 3;
    for (let v = 0; v < vertexCount; v++) {
      this.local[0] = this.bodyVertices[3 * v] as number;
      this.local[1] = this.bodyVertices[3 * v + 1] as number;
      this.local[2] = this.bodyVertices[3 * v + 2] as number;
      body.pointToWorld(this.local, this.world);
      const x = this.world[0] as number;
      const y = this.world[1] as number;
      const z = this.world[2] as number;
      this.worldVertices[3 * v] = x;
      this.worldVertices[3 * v + 1] = y;
      this.worldVertices[3 * v + 2] = z;
      this.heights[v] = y - water.heightAt(x, z, timeS);
    }

    const out = this.submerged;
    out.count = 0;
    for (let t = 0; t < this.indices.length; t += 3) {
      this.clipTriangle(this.indices[t] as number, this.indices[t + 1] as number, this.indices[t + 2] as number);
    }

    const result = this.result;
    result.force.fill(0);
    let momentX = 0;
    let momentY = 0;
    let momentZ = 0;
    const rhoG = this.density * GRAVITY_M_S2;
    for (let i = 0; i < out.count; i++) {
      const pressure = rhoG * (out.depths[i] as number) * (out.areas[i] as number);
      const fx = -pressure * (out.normals[3 * i] as number);
      const fy = -pressure * (out.normals[3 * i + 1] as number);
      const fz = -pressure * (out.normals[3 * i + 2] as number);
      out.forces[3 * i] = fx;
      out.forces[3 * i + 1] = fy;
      out.forces[3 * i + 2] = fz;
      const cx = out.centroids[3 * i] as number;
      const cy = out.centroids[3 * i + 1] as number;
      const cz = out.centroids[3 * i + 2] as number;
      body.addForceAtPoint(fx, fy, fz, cx, cy, cz);
      result.force[0] = (result.force[0] as number) + fx;
      result.force[1] = (result.force[1] as number) + fy;
      result.force[2] = (result.force[2] as number) + fz;
      // Moment about the world origin, used to locate the centre of buoyancy.
      momentX += cy * fz - cz * fy;
      momentY += cz * fx - cx * fz;
      momentZ += cx * fy - cy * fx;
    }
    const fy = result.force[1] as number;
    result.submergedVolumeM3 = fy / rhoG;
    if (Math.abs(fy) > 0) {
      // Point on the line of action of a (nearly vertical) force: x = -Mz/Fy, z = Mx/Fy.
      result.centreOfBuoyancy[0] = momentZ / fy;
      result.centreOfBuoyancy[2] = -momentX / fy;
      result.centreOfBuoyancy[1] = this.meanSubmergedHeight();
    }
    void momentY;
    return result;
  }

  /** Area-weighted mean centroid height of the submerged surface (for display only). */
  private meanSubmergedHeight(): number {
    const out = this.submerged;
    let sum = 0;
    let area = 0;
    for (let i = 0; i < out.count; i++) {
      sum += (out.centroids[3 * i + 1] as number) * (out.areas[i] as number);
      area += out.areas[i] as number;
    }
    return area > 0 ? sum / area : 0;
  }

  private clipTriangle(i0: number, i1: number, i2: number): void {
    const h0 = this.heights[i0] as number;
    const h1 = this.heights[i1] as number;
    const h2 = this.heights[i2] as number;
    const below = (h0 < 0 ? 1 : 0) + (h1 < 0 ? 1 : 0) + (h2 < 0 ? 1 : 0);
    if (below === 0) {
      return;
    }
    // Normal and area of the original triangle (sub-triangles are coplanar).
    const w = this.worldVertices;
    const ax = w[3 * i0] as number, ay = w[3 * i0 + 1] as number, az = w[3 * i0 + 2] as number;
    const bx = w[3 * i1] as number, by = w[3 * i1 + 1] as number, bz = w[3 * i1 + 2] as number;
    const cx = w[3 * i2] as number, cy = w[3 * i2 + 1] as number, cz = w[3 * i2 + 2] as number;
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const doubleArea = Math.hypot(nx, ny, nz);
    if (doubleArea * 0.5 < MIN_TRIANGLE_AREA_M2) {
      return;
    }
    nx /= doubleArea;
    ny /= doubleArea;
    nz /= doubleArea;

    if (below === 3) {
      this.emit(i0, -1, 0, i1, -1, 0, i2, -1, 0, nx, ny, nz);
      return;
    }
    // Sort the three corners by height: L (lowest), M, H (highest).
    let l = i0, m = i1, h = i2;
    if ((this.heights[l] as number) > (this.heights[m] as number)) [l, m] = [m, l];
    if ((this.heights[m] as number) > (this.heights[h] as number)) [m, h] = [h, m];
    if ((this.heights[l] as number) > (this.heights[m] as number)) [l, m] = [m, l];
    const hl = this.heights[l] as number;
    const hm = this.heights[m] as number;
    const hh = this.heights[h] as number;

    if (below === 1) {
      // Only L is under water: cut L-M and L-H.
      const tm = -hl / (hm - hl);
      const th = -hl / (hh - hl);
      this.emit(l, -1, 0, l, m, tm, l, h, th, nx, ny, nz);
    } else {
      // L and M under water: cut M-H and L-H, keep the quad (M, I_M, I_L, L).
      const tm = -hm / (hh - hm);
      const tl = -hl / (hh - hl);
      this.emit(m, -1, 0, m, h, tm, l, h, tl, nx, ny, nz);
      this.emit(m, -1, 0, l, h, tl, l, -1, 0, nx, ny, nz);
    }
  }

  /**
   * Emits a submerged triangle. Each corner is either vertex `a` (b = -1) or
   * the point a + t (b - a) on an edge, where the water surface crosses (height 0).
   */
  private emit(
    a0: number, b0: number, t0: number,
    a1: number, b1: number, t1: number,
    a2: number, b2: number, t2: number,
    nx: number, ny: number, nz: number,
  ): void {
    const out = this.submerged;
    const i = out.count;
    const c = this.corner;
    this.cornerPoint(a0, b0, t0, c, 0);
    this.cornerPoint(a1, b1, t1, c, 4);
    this.cornerPoint(a2, b2, t2, c, 8);
    const ex = (c[4] as number) - (c[0] as number), ey = (c[5] as number) - (c[1] as number), ez = (c[6] as number) - (c[2] as number);
    const fx = (c[8] as number) - (c[0] as number), fy = (c[9] as number) - (c[1] as number), fz = (c[10] as number) - (c[2] as number);
    const area = 0.5 * Math.hypot(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx);
    if (area < MIN_TRIANGLE_AREA_M2) {
      return;
    }
    for (let k = 0; k < 3; k++) {
      out.corners[9 * i + 3 * k] = c[4 * k] as number;
      out.corners[9 * i + 3 * k + 1] = c[4 * k + 1] as number;
      out.corners[9 * i + 3 * k + 2] = c[4 * k + 2] as number;
    }
    out.centroids[3 * i] = ((c[0] as number) + (c[4] as number) + (c[8] as number)) / 3;
    out.centroids[3 * i + 1] = ((c[1] as number) + (c[5] as number) + (c[9] as number)) / 3;
    out.centroids[3 * i + 2] = ((c[2] as number) + (c[6] as number) + (c[10] as number)) / 3;
    out.normals[3 * i] = nx;
    out.normals[3 * i + 1] = ny;
    out.normals[3 * i + 2] = nz;
    out.areas[i] = area;
    // Heights vary linearly over the triangle; the waterline corners have height 0.
    out.depths[i] = -((c[3] as number) + (c[7] as number) + (c[11] as number)) / 3;
    out.count = i + 1;
  }

  private cornerPoint(a: number, b: number, t: number, out: Float64Array, offset: number): void {
    const w = this.worldVertices;
    if (b < 0) {
      out[offset] = w[3 * a] as number;
      out[offset + 1] = w[3 * a + 1] as number;
      out[offset + 2] = w[3 * a + 2] as number;
      out[offset + 3] = this.heights[a] as number;
      return;
    }
    for (let k = 0; k < 3; k++) {
      const pa = w[3 * a + k] as number;
      out[offset + k] = pa + t * ((w[3 * b + k] as number) - pa);
    }
    out[offset + 3] = 0;
  }
}
