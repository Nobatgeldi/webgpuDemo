import { describe, expect, it } from 'vitest';
import { createRandom } from '../src/core/random';
import {
  OCEAN_VERTEX_STRIDE_FLOATS,
  buildOceanGeometry,
  computeLevelLayouts,
  holeCellBounds,
  ringRangeIndex,
} from '../src/ocean/oceanMesh';
import { OCEAN_QUALITY, computeCascadeBands } from '../src/ocean/oceanConfig';

describe('ocean clipmap geometry', () => {
  const m = 8;
  const geometry = buildOceanGeometry(m);

  it('builds a full level, nine ring variants and a skirt', () => {
    expect(geometry.fullLevel.indexCount).toBe((2 * m) ** 2 * 6);
    expect(geometry.rings).toHaveLength(9);
    for (const ring of geometry.rings) {
      // A quarter of the cells (the hole) is removed.
      expect(ring.indexCount).toBe(((2 * m) ** 2 - m * m) * 6);
    }
    expect(geometry.skirt.indexCount).toBe(8 * m * 6);
    expect(geometry.vertexCount).toBe((2 * m + 1) ** 2 + 8 * m);
    for (const index of geometry.indices) {
      expect(index).toBeLessThan(geometry.vertexCount);
    }
  });

  it('marks exactly the perimeter copies as skirt vertices', () => {
    let skirt = 0;
    for (let v = 0; v < geometry.vertexCount; v++) {
      const flag = geometry.vertices[v * OCEAN_VERTEX_STRIDE_FLOATS + 2];
      if (flag === 1) {
        skirt++;
        const x = geometry.vertices[v * OCEAN_VERTEX_STRIDE_FLOATS] as number;
        const z = geometry.vertices[v * OCEAN_VERTEX_STRIDE_FLOATS + 1] as number;
        expect(Math.max(Math.abs(x), Math.abs(z))).toBe(m);
      }
    }
    expect(skirt).toBe(8 * m);
  });

  it('rejects odd or tiny sizes', () => {
    expect(() => buildOceanGeometry(7)).toThrow(RangeError);
    expect(() => buildOceanGeometry(2)).toThrow(RangeError);
  });
});

describe('clipmap level layout', () => {
  it('fits every ring hole exactly around the finer level, for any camera position', () => {
    const random = createRandom(3);
    const m = 64;
    const base = 0.5;
    for (let trial = 0; trial < 500; trial++) {
      const camX = (random() - 0.5) * 2e7;
      const camZ = (random() - 0.5) * 2e7;
      const layouts = computeLevelLayouts(camX, camZ, base, 9);
      for (let l = 1; l < layouts.length; l++) {
        const level = layouts[l]!;
        const finer = layouts[l - 1]!;
        expect([-1, 0, 1]).toContain(level.holeOffsetX);
        expect([-1, 0, 1]).toContain(level.holeOffsetZ);
        const hole = holeCellBounds(m, level.holeOffsetX, level.holeOffsetZ);
        const holeMinX = level.centreX + (hole.minX - m) * level.spacingM;
        const holeMaxX = level.centreX + (hole.maxX - m) * level.spacingM;
        const holeMinZ = level.centreZ + (hole.minZ - m) * level.spacingM;
        expect(holeMinX).toBeCloseTo(finer.centreX - m * finer.spacingM, 3);
        expect(holeMaxX).toBeCloseTo(finer.centreX + m * finer.spacingM, 3);
        expect(holeMinZ).toBeCloseTo(finer.centreZ - m * finer.spacingM, 3);
      }
      // Every level stays centred within one cell of the camera.
      for (const level of layouts) {
        expect(Math.abs(level.centreX - camX)).toBeLessThanOrEqual(level.spacingM + 1e-6);
        expect(Math.abs(level.centreZ - camZ)).toBeLessThanOrEqual(level.spacingM + 1e-6);
      }
    }
  });

  it('keeps vertices fixed in the world while the camera moves (no swimming)', () => {
    const a = computeLevelLayouts(100.3, -20.1, 0.5, 4);
    const b = computeLevelLayouts(100.35, -20.12, 0.5, 4);
    a.forEach((level, l) => {
      const other = b[l]!;
      // Centres only ever move by whole multiples of twice the spacing.
      const shift = (other.centreX - level.centreX) / (2 * level.spacingM);
      expect(Number.isInteger(Math.round(shift * 1e9) / 1e9)).toBe(true);
    });
  });

  it('uses a valid ring variant index', () => {
    expect(ringRangeIndex(-1, -1)).toBe(0);
    expect(ringRangeIndex(1, 1)).toBe(8);
  });
});

describe('cascade bands', () => {
  it.each(Object.entries(OCEAN_QUALITY))('are contiguous and representable for %s quality', (_name, config) => {
    const bands = computeCascadeBands(config.fftSize, config.cascadeCount);
    expect(bands).toHaveLength(config.cascadeCount);
    expect(bands[0]!.kMin).toBe(0);
    for (let c = 1; c < bands.length; c++) {
      expect(bands[c]!.kMin).toBe(bands[c - 1]!.kMax);
    }
    for (const band of bands) {
      expect(band.kMax).toBeGreaterThan(band.kMin);
      expect(band.kMax).toBeLessThanOrEqual((Math.PI * config.fftSize) / band.patchSizeM + 1e-9);
    }
  });
});
