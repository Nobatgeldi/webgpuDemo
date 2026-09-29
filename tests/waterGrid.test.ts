import { describe, expect, it } from 'vitest';
import type { WaterQuery } from '../src/ocean/waterQuery';
import { WaterGridProvider } from '../src/ship/waterGrid';

/** Minimal stand-in for the GPU query that evaluates a function immediately. */
function fakeQuery(fn: (x: number, z: number) => number): WaterQuery {
  return {
    add(points: ArrayLike<number>, count: number, consumer: (h: Float32Array) => void) {
      const heights = new Float32Array(count);
      for (let i = 0; i < count; i++) heights[i] = fn(points[2 * i] as number, points[2 * i + 1] as number);
      consumer(heights);
      return true;
    },
  } as unknown as WaterQuery;
}

describe('WaterGridProvider', () => {
  const plane = (x: number, z: number): number => 0.1 * x - 0.05 * z + 2;

  it('reproduces a planar surface exactly for any heading', () => {
    for (const heading of [0, 0.7, 2, 4]) {
      const grid = new WaterGridProvider({ columns: 20, rows: 8, lengthM: 60, widthM: 20 });
      expect(grid.ready).toBe(false);
      expect(grid.heightAt(1, 1)).toBe(0);
      grid.request(fakeQuery(plane), 1000, -500, heading);
      expect(grid.ready).toBe(true);
      // Points inside the grid footprint (within 30 m along and 10 m across for any heading).
      for (const [x, z] of [[1000, -500], [1006, -496], [995, -504]]) {
        expect(grid.heightAt(x as number, z as number)).toBeCloseTo(plane(x as number, z as number), 3);
      }
    }
  });

  it('interpolates smooth waves accurately', () => {
    const wave = (x: number, z: number): number => Math.sin(x / 10) * Math.cos(z / 13);
    const grid = new WaterGridProvider({ columns: 41, rows: 17, lengthM: 66, widthM: 25 });
    grid.request(fakeQuery(wave), 0, 0, 0.3);
    let maxError = 0;
    const alongX = Math.sin(0.3);
    const alongZ = -Math.cos(0.3);
    for (let i = 0; i < 100; i++) {
      // Grid coordinates: u along (+-30 m), v across (+-11 m).
      const u = (i % 10) * 6.6 - 30;
      const v = Math.floor(i / 10) * 2.4 - 11;
      const x = u * alongX - v * alongZ;
      const z = u * alongZ + v * alongX;
      maxError = Math.max(maxError, Math.abs(grid.heightAt(x, z) - wave(x, z)));
    }
    expect(maxError).toBeLessThan(0.03);
  });
});
