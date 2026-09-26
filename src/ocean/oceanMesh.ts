/**
 * Camera-centred geometry clipmap for the sea surface.
 *
 * Level l is a square of 2M x 2M cells with spacing s_l = s_0 * 2^l centred on
 * c_l, the camera position snapped to a multiple of 2 s_l (so vertices stay
 * fixed in the world and do not "swim"). Level 0 is a full square; every
 * coarser level is a ring whose hole is exactly the square of the finer level.
 * Because c_{l-1} is a multiple of s_l, the hole is shifted by -1, 0 or +1
 * cells per axis relative to the ring centre; the 9 variants are prebuilt
 * index ranges. A flat skirt connects the outermost ring to the horizon.
 *
 * Cracks between levels are avoided by geomorphing (in the vertex shader):
 * towards its outer edge, a level collapses its odd vertices onto the even
 * ones, which coincide with the vertices of the next coarser level.
 */

export interface IndexRange {
  readonly firstIndex: number;
  readonly indexCount: number;
}

export interface OceanGeometry {
  /** Per vertex: grid x, grid z (cells relative to the level centre), skirt flag (0/1). */
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly fullLevel: IndexRange;
  /** Ring index ranges, see {@link ringRangeIndex}. */
  readonly rings: readonly IndexRange[];
  readonly skirt: IndexRange;
  readonly vertexCount: number;
}

export const OCEAN_VERTEX_STRIDE_FLOATS = 3;

/** Index into {@link OceanGeometry.rings} for a hole offset in {-1, 0, 1}^2. */
export function ringRangeIndex(holeOffsetX: number, holeOffsetZ: number): number {
  return (holeOffsetZ + 1) * 3 + (holeOffsetX + 1);
}

export function buildOceanGeometry(halfCells: number): OceanGeometry {
  const m = halfCells;
  if (!Number.isInteger(m) || m < 4 || m % 2 !== 0) {
    throw new RangeError(`halfCells must be an even integer >= 4, got ${halfCells}`);
  }
  const side = 2 * m + 1;
  const gridVertexCount = side * side;
  const perimeter = 8 * m;
  const vertexCount = gridVertexCount + perimeter;
  const vertices = new Float32Array(vertexCount * OCEAN_VERTEX_STRIDE_FLOATS);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const v = (j * side + i) * OCEAN_VERTEX_STRIDE_FLOATS;
      vertices[v] = i - m;
      vertices[v + 1] = j - m;
      vertices[v + 2] = 0;
    }
  }
  const perimeterVertices = perimeterIndices(m);
  perimeterVertices.forEach((gridIndex, p) => {
    const src = gridIndex * OCEAN_VERTEX_STRIDE_FLOATS;
    const dst = (gridVertexCount + p) * OCEAN_VERTEX_STRIDE_FLOATS;
    vertices[dst] = vertices[src] as number;
    vertices[dst + 1] = vertices[src + 1] as number;
    vertices[dst + 2] = 1;
  });

  const indices: number[] = [];
  const vertexIndex = (i: number, j: number): number => j * side + i;
  const pushCell = (i: number, j: number): void => {
    const v00 = vertexIndex(i, j);
    const v10 = vertexIndex(i + 1, j);
    const v01 = vertexIndex(i, j + 1);
    const v11 = vertexIndex(i + 1, j + 1);
    // Alternate the diagonal so that the triangulation has no directional bias.
    if ((i + j) % 2 === 0) {
      indices.push(v00, v01, v11, v00, v11, v10);
    } else {
      indices.push(v00, v01, v10, v10, v01, v11);
    }
  };
  const addRange = (fill: () => void): IndexRange => {
    const firstIndex = indices.length;
    fill();
    return { firstIndex, indexCount: indices.length - firstIndex };
  };

  const fullLevel = addRange(() => {
    for (let j = 0; j < 2 * m; j++) for (let i = 0; i < 2 * m; i++) pushCell(i, j);
  });

  const rings: IndexRange[] = [];
  for (let oz = -1; oz <= 1; oz++) {
    for (let ox = -1; ox <= 1; ox++) {
      const hole = holeCellBounds(m, ox, oz);
      rings[ringRangeIndex(ox, oz)] = addRange(() => {
        for (let j = 0; j < 2 * m; j++) {
          for (let i = 0; i < 2 * m; i++) {
            const inHole = i >= hole.minX && i < hole.maxX && j >= hole.minZ && j < hole.maxZ;
            if (!inHole) pushCell(i, j);
          }
        }
      });
    }
  }

  const skirt = addRange(() => {
    for (let p = 0; p < perimeter; p++) {
      const next = (p + 1) % perimeter;
      const inner0 = perimeterVertices[p] as number;
      const inner1 = perimeterVertices[next] as number;
      const outer0 = gridVertexCount + p;
      const outer1 = gridVertexCount + next;
      indices.push(inner0, outer0, outer1, inner0, outer1, inner1);
    }
  });

  return {
    vertices,
    indices: Uint32Array.from(indices),
    fullLevel,
    rings,
    skirt,
    vertexCount,
  };
}

/** Cell index bounds [min, max) of the hole of a ring (cells counted from the level corner). */
export function holeCellBounds(
  halfCells: number,
  holeOffsetX: number,
  holeOffsetZ: number,
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const m = halfCells;
  const minX = m - m / 2 + holeOffsetX;
  const minZ = m - m / 2 + holeOffsetZ;
  return { minX, maxX: minX + m, minZ, maxZ: minZ + m };
}

/** Grid vertex indices along the border, counter-clockwise, without repetition. */
function perimeterIndices(m: number): number[] {
  const side = 2 * m + 1;
  const result: number[] = [];
  const index = (i: number, j: number): number => j * side + i;
  for (let i = 0; i < 2 * m; i++) result.push(index(i, 0));
  for (let j = 0; j < 2 * m; j++) result.push(index(2 * m, j));
  for (let i = 2 * m; i > 0; i--) result.push(index(i, 2 * m));
  for (let j = 2 * m; j > 0; j--) result.push(index(0, j));
  return result;
}

export interface LevelLayout {
  /** World XZ of the level centre (m, double precision). */
  readonly centreX: number;
  readonly centreZ: number;
  readonly spacingM: number;
  /** Hole offset in cells (level 0: always 0). */
  readonly holeOffsetX: number;
  readonly holeOffsetZ: number;
}

/**
 * Centres and hole offsets of all levels for a camera position (double
 * precision, world space).
 */
export function computeLevelLayouts(
  cameraX: number,
  cameraZ: number,
  baseSpacingM: number,
  levelCount: number,
): LevelLayout[] {
  const layouts: LevelLayout[] = [];
  for (let l = 0; l < levelCount; l++) {
    const spacingM = baseSpacingM * 2 ** l;
    const snap = 2 * spacingM;
    const centreX = Math.round(cameraX / snap) * snap;
    const centreZ = Math.round(cameraZ / snap) * snap;
    let holeOffsetX = 0;
    let holeOffsetZ = 0;
    const finer = layouts[l - 1];
    if (finer) {
      holeOffsetX = Math.round((finer.centreX - centreX) / spacingM);
      holeOffsetZ = Math.round((finer.centreZ - centreZ) / spacingM);
    }
    layouts.push({ centreX, centreZ, spacingM, holeOffsetX, holeOffsetZ });
  }
  return layouts;
}
