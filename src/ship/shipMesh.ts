/**
 * Visual model of the vessel: a finer version of the parametric hull with
 * smooth normals per surface group, plus a simple superstructure (deckhouse,
 * bridge, mast with radar yard). Positions are in the hull frame.
 */
import { HullGroup, buildHullMesh, hullSection } from './hull';
import type { ShipConfig } from './shipConfig';

/** Material ids (must match shaders/ship.wgsl). */
export const ShipMaterial = {
  Hull: 0,
  Deck: 1,
  Superstructure: 2,
  Dark: 3,
  Glass: 4,
} as const;
export type ShipMaterial = (typeof ShipMaterial)[keyof typeof ShipMaterial];

/** position (3), normal (3), material (1) */
export const SHIP_VERTEX_FLOATS = 7;

export interface ShipVisualMesh {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

interface Box {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly material: ShipMaterial;
}

/** Superstructure layout relative to the hull length/breadth (hull frame, metres for a 50 m hull). */
function superstructure(config: ShipConfig): Box[] {
  const { lengthM: l, beamM: b } = config.hull;
  const deck = hullSection(config.hull, 0).deckHeightM;
  const s = l / 50; // scale for other hull lengths
  const base = deck - 0.2; // sink the boxes slightly into the deck
  return [
    // Main deckhouse and bridge.
    { min: [-6 * s, base, -0.36 * b], max: [7 * s, deck + 2.8, 0.36 * b], material: ShipMaterial.Superstructure },
    { min: [-2 * s, deck + 2.7, -0.28 * b], max: [6 * s, deck + 5.0, 0.28 * b], material: ShipMaterial.Superstructure },
    // Bridge windows (front and sides).
    { min: [6 * s, deck + 3.6, -0.26 * b], max: [6.08 * s, deck + 4.5, 0.26 * b], material: ShipMaterial.Glass },
    { min: [0, deck + 3.6, 0.279 * b], max: [5.5 * s, deck + 4.5, 0.282 * b], material: ShipMaterial.Glass },
    { min: [0, deck + 3.6, -0.282 * b], max: [5.5 * s, deck + 4.5, -0.279 * b], material: ShipMaterial.Glass },
    // Aft deckhouse.
    { min: [-17 * s, base, -0.3 * b], max: [-9 * s, deck + 2.0, 0.3 * b], material: ShipMaterial.Superstructure },
    // Mast and radar yard.
    { min: [1.8 * s, deck + 4.9, -0.3], max: [2.4 * s, deck + 12.5, 0.3], material: ShipMaterial.Dark },
    { min: [1.9 * s, deck + 11.0, -0.22 * b], max: [2.3 * s, deck + 11.2, 0.22 * b], material: ShipMaterial.Dark },
  ];
}

export function buildShipVisualMesh(config: ShipConfig, sectionExponent: number): ShipVisualMesh {
  const vertices: number[] = [];
  const indices: number[] = [];
  const form = config.hull;
  const hull = buildHullMesh(form, form.visualStations, form.visualPointsPerSide, sectionExponent);

  // Smooth normals within each surface group; sharp edges between groups.
  const keyToIndex = new Map<number, number>();
  const normals: number[] = [];
  const vertexOf = (vertex: number, group: number): number => {
    const key = vertex * 8 + group;
    let index = keyToIndex.get(key);
    if (index === undefined) {
      index = vertices.length / SHIP_VERTEX_FLOATS;
      keyToIndex.set(key, index);
      const p = hull.positions;
      const material = group === HullGroup.Deck ? ShipMaterial.Deck : ShipMaterial.Hull;
      vertices.push(p[3 * vertex] as number, p[3 * vertex + 1] as number, p[3 * vertex + 2] as number, 0, 0, 0, material);
      normals.push(0, 0, 0);
    }
    return index;
  };
  for (let t = 0; t < hull.triangleCount; t++) {
    const group = hull.groups[t] as number;
    if (group === HullGroup.Stem) continue; // zero-area cap
    const ids = [0, 1, 2].map((k) => vertexOf(hull.indices[3 * t + k] as number, group));
    const [a, b, c] = ids.map((i) => [vertices[i * 7] as number, vertices[i * 7 + 1] as number, vertices[i * 7 + 2] as number]) as [number[], number[], number[]];
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    // Area-weighted face normal.
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    for (const i of ids) {
      normals[3 * i] = (normals[3 * i] as number) + n[0]!;
      normals[3 * i + 1] = (normals[3 * i + 1] as number) + n[1]!;
      normals[3 * i + 2] = (normals[3 * i + 2] as number) + n[2]!;
    }
    indices.push(...ids);
  }
  for (let i = 0; i < normals.length / 3; i++) {
    const nx = normals[3 * i] as number;
    const ny = normals[3 * i + 1] as number;
    const nz = normals[3 * i + 2] as number;
    const length = Math.hypot(nx, ny, nz) || 1;
    vertices[i * 7 + 3] = nx / length;
    vertices[i * 7 + 4] = ny / length;
    vertices[i * 7 + 5] = nz / length;
  }

  for (const box of superstructure(config)) {
    addBox(vertices, indices, box);
  }
  return { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}

/** Axis-aligned box with flat, outward-facing, counter-clockwise faces. */
function addBox(vertices: number[], indices: number[], box: Box): void {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const faces: [number[], number[][]][] = [
    [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
    [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
    [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
    [[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]]],
    [[0, 0, 1], [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]]],
    [[0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]],
  ];
  for (const [normal, corners] of faces) {
    const base = vertices.length / SHIP_VERTEX_FLOATS;
    for (const corner of corners) {
      vertices.push(corner[0]!, corner[1]!, corner[2]!, normal[0]!, normal[1]!, normal[2]!, box.material);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}
