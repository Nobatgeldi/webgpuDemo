/**
 * Water heights for the ship physics from the GPU ocean.
 *
 * Instead of querying each hull vertex (whose position changes during the
 * 1-3 frames a readback takes), a ship-aligned grid of points around the
 * predicted ship position is queried every frame. The physics then
 * interpolates bilinearly at the actual vertex positions of every fixed step.
 */
import type { WaterQuery } from '../ocean/waterQuery';
import type { WaterHeightProvider } from './waterHeightProvider';

/** Requests in flight at once (each keeps the grid frame it was sampled on). */
const GRID_RECORDS = 4;

interface GridRecord {
  /** World XZ of the grid centre and the unit axes (along, across). */
  centreX: number;
  centreZ: number;
  alongX: number;
  alongZ: number;
  readonly heights: Float32Array;
  readonly consumer: (heights: Float32Array) => void;
}

export interface WaterGridOptions {
  /** Samples along and across the ship. */
  readonly columns: number;
  readonly rows: number;
  /** Covered length and width (m). */
  readonly lengthM: number;
  readonly widthM: number;
}

export class WaterGridProvider implements WaterHeightProvider {
  private readonly points: Float64Array;
  private readonly records: GridRecord[] = [];
  private nextRecord = 0;
  /** Latest grid with valid heights, or null before the first readback. */
  private latest: GridRecord | null = null;
  private readonly spacingAlong: number;
  private readonly spacingAcross: number;

  constructor(private readonly options: WaterGridOptions) {
    this.points = new Float64Array(options.columns * options.rows * 2);
    this.spacingAlong = options.lengthM / (options.columns - 1);
    this.spacingAcross = options.widthM / (options.rows - 1);
    for (let i = 0; i < GRID_RECORDS; i++) {
      const record: GridRecord = {
        centreX: 0,
        centreZ: 0,
        alongX: 1,
        alongZ: 0,
        heights: new Float32Array(options.columns * options.rows),
        consumer: (heights) => {
          record.heights.set(heights);
          this.latest = record;
        },
      };
      this.records.push(record);
    }
  }

  /** True once heights from the GPU are available. */
  get ready(): boolean {
    return this.latest !== null;
  }

  /**
   * Adds the grid points for a ship centred at (x, z) with the given heading
   * (clockwise from north) to this frame's query batch.
   */
  request(query: WaterQuery, centreX: number, centreZ: number, headingRad: number): void {
    const record = this.records[this.nextRecord] as GridRecord;
    if (record === this.latest) {
      // Never overwrite the grid the physics is reading; skip to the next slot.
      this.nextRecord = (this.nextRecord + 1) % GRID_RECORDS;
      return this.request(query, centreX, centreZ, headingRad);
    }
    this.nextRecord = (this.nextRecord + 1) % GRID_RECORDS;
    record.centreX = centreX;
    record.centreZ = centreZ;
    record.alongX = Math.sin(headingRad);
    record.alongZ = -Math.cos(headingRad);
    const { columns, rows, lengthM, widthM } = this.options;
    // Across axis = along rotated clockwise by 90 degrees (starboard).
    const acrossX = -record.alongZ;
    const acrossZ = record.alongX;
    let p = 0;
    for (let r = 0; r < rows; r++) {
      const v = -widthM / 2 + r * this.spacingAcross;
      for (let c = 0; c < columns; c++) {
        const u = -lengthM / 2 + c * this.spacingAlong;
        this.points[p++] = centreX + u * record.alongX + v * acrossX;
        this.points[p++] = centreZ + u * record.alongZ + v * acrossZ;
      }
    }
    query.add(this.points, columns * rows, record.consumer);
  }

  heightAt(x: number, z: number): number {
    const grid = this.latest;
    if (!grid) {
      return 0;
    }
    const { columns, rows, lengthM, widthM } = this.options;
    const dx = x - grid.centreX;
    const dz = z - grid.centreZ;
    const u = dx * grid.alongX + dz * grid.alongZ;
    const v = dx * -grid.alongZ + dz * grid.alongX;
    // Continuous grid coordinates, clamped to the grid (edge values extend outwards).
    const gc = Math.min(columns - 1, Math.max(0, (u + lengthM / 2) / this.spacingAlong));
    const gr = Math.min(rows - 1, Math.max(0, (v + widthM / 2) / this.spacingAcross));
    const c0 = Math.min(columns - 2, Math.floor(gc));
    const r0 = Math.min(rows - 2, Math.floor(gr));
    const fc = gc - c0;
    const fr = gr - r0;
    const h = grid.heights;
    const i = r0 * columns + c0;
    const top = (h[i] as number) * (1 - fc) + (h[i + 1] as number) * fc;
    const bottom = (h[i + columns] as number) * (1 - fc) + (h[i + columns + 1] as number) * fc;
    return top * (1 - fr) + bottom * fr;
  }
}

/** Water height at a single point (e.g. the camera), refreshed every frame. */
export class WaterPointProbe {
  private readonly point = new Float64Array(2);
  private value: number | null = null;
  private readonly consumer = (heights: Float32Array): void => {
    this.value = heights[0] as number;
  };

  /** Latest height (m) or null before the first readback. */
  get height(): number | null {
    return this.value;
  }

  request(query: WaterQuery, x: number, z: number): void {
    this.point[0] = x;
    this.point[1] = z;
    query.add(this.point, 1, this.consumer);
  }
}
