/**
 * Parametric hull form and its meshes.
 *
 * Hull frame: origin at midship on the design waterline, +X towards the bow,
 * +Y up, +Z to starboard (right-handed). A section at longitudinal position
 * xi = x / (L/2) is V/U-shaped below the waterline, half-breadth
 * w = b(xi) * nu^q with nu = (y + t) / t the height fraction above the keel and
 * q the section exponent (small q: full sections, q = 1: straight V), and
 * flares linearly above the waterline up to the deck.
 *
 * The physics mesh is closed and consistently oriented (outward normals), as
 * required by the triangle-clipping buoyancy.
 */
import type { HullFormConfig } from './shipConfig';

export interface HullSection {
  /** Waterline half-breadth (m). */
  readonly halfBreadthM: number;
  /** Keel depth below the design waterline (m). */
  readonly keelDepthM: number;
  /** Deck height above the design waterline (m). */
  readonly deckHeightM: number;
}

/** Section dimensions at xi in [-1 (transom), 1 (stem)]. */
export function hullSection(form: HullFormConfig, xi: number): HullSection {
  const half = form.beamM / 2;
  let halfBreadthM: number;
  if (xi <= 0) {
    halfBreadthM = half * (1 - (1 - form.transomBreadthFraction) * xi * xi);
  } else {
    halfBreadthM = half * Math.pow(Math.max(0, 1 - Math.pow(xi, form.bowEntranceExponent)), form.bowEntranceShape);
  }
  let keelDepthM = form.designDraftM;
  if (xi > form.forefootStartFraction) {
    const t = (xi - form.forefootStartFraction) / (1 - form.forefootStartFraction);
    keelDepthM = form.designDraftM * (1 - (1 - form.stemDraftFraction) * t * t);
  }
  const deckHeightM = form.freeboardM + (xi > 0 ? form.bowSheerM * xi * xi : 0);
  return { halfBreadthM, keelDepthM, deckHeightM };
}

/** Surface groups of the hull (used for rendering normals and materials). */
export const HullGroup = {
  Starboard: 0,
  Port: 1,
  Deck: 2,
  Transom: 3,
  Stem: 4,
} as const;
export type HullGroup = (typeof HullGroup)[keyof typeof HullGroup];

export interface HullMesh {
  /** xyz per vertex, hull frame (m). */
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
  /** Surface group per triangle. */
  readonly groups: Uint8Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
}

/**
 * Builds a closed hull mesh.
 * @param stations Number of cross sections from transom to stem (>= 3).
 * @param pointsPerSide Section points per side above the keel (>= 3).
 * @param sectionExponent q of the section shape.
 */
export function buildHullMesh(
  form: HullFormConfig,
  stations: number,
  pointsPerSide: number,
  sectionExponent: number,
): HullMesh {
  if (stations < 3 || pointsPerSide < 3) {
    throw new RangeError('hull mesh needs at least 3 stations and 3 points per side');
  }
  // Split the side points between the underwater part (ending exactly on the
  // waterline) and the topsides (ending at the deck edge).
  const below = Math.ceil(pointsPerSide * 0.6);
  const above = pointsPerSide - below;
  const ring = 1 + 2 * pointsPerSide; // keel + starboard + port
  const positions = new Float64Array(stations * ring * 3);
  const halfLength = form.lengthM / 2;

  for (let s = 0; s < stations; s++) {
    const xi = -1 + (2 * s) / (stations - 1);
    const x = xi * halfLength;
    const section = hullSection(form, xi);
    const base = s * ring;
    setVertex(positions, base, x, -section.keelDepthM, 0);
    for (let j = 1; j <= pointsPerSide; j++) {
      let y: number;
      let w: number;
      if (j <= below) {
        const nu = j / below;
        y = -section.keelDepthM * (1 - nu);
        w = section.halfBreadthM * Math.pow(nu, sectionExponent);
      } else {
        const nu = (j - below) / above;
        y = nu * section.deckHeightM;
        w = section.halfBreadthM * (1 + form.deckFlareFraction * nu);
      }
      setVertex(positions, base + j, x, y, w);
      setVertex(positions, base + pointsPerSide + j, x, y, -w);
    }
  }

  const indices: number[] = [];
  const groups: number[] = [];
  const keel = (s: number): number => s * ring;
  // j = 0 is the keel for both sides.
  const starboard = (s: number, j: number): number => (j === 0 ? keel(s) : s * ring + j);
  const port = (s: number, j: number): number => (j === 0 ? keel(s) : s * ring + pointsPerSide + j);
  const tri = (a: number, b: number, c: number, group: HullGroup): void => {
    indices.push(a, b, c);
    groups.push(group);
  };

  for (let s = 0; s < stations - 1; s++) {
    for (let j = 0; j < pointsPerSide; j++) {
      // Starboard: outward normal +Z with (A, B, C), (A, C, D) where A=(s,j) B=(s+1,j) C=(s+1,j+1) D=(s,j+1).
      const a = starboard(s, j);
      const b = starboard(s + 1, j);
      const c = starboard(s + 1, j + 1);
      const d = starboard(s, j + 1);
      tri(a, b, c, HullGroup.Starboard);
      tri(a, c, d, HullGroup.Starboard);
      const pa = port(s, j);
      const pb = port(s + 1, j);
      const pc = port(s + 1, j + 1);
      const pd = port(s, j + 1);
      tri(pa, pc, pb, HullGroup.Port);
      tri(pa, pd, pc, HullGroup.Port);
    }
    // Deck between the deck edges, outward +Y.
    const sa = starboard(s, pointsPerSide);
    const sb = starboard(s + 1, pointsPerSide);
    const pb = port(s + 1, pointsPerSide);
    const pa = port(s, pointsPerSide);
    tri(sa, sb, pb, HullGroup.Deck);
    tri(sa, pb, pa, HullGroup.Deck);
  }

  // End caps as fans from the keel vertex: transom faces -X, stem +X.
  const capStation = (s: number, outwardPlusX: boolean, group: HullGroup): void => {
    const k = keel(s);
    const order: number[] = [];
    for (let j = 1; j <= pointsPerSide; j++) order.push(starboard(s, j));
    for (let j = pointsPerSide; j >= 1; j--) order.push(port(s, j));
    for (let i = 0; i < order.length - 1; i++) {
      const a = order[i] as number;
      const b = order[i + 1] as number;
      if (outwardPlusX) tri(k, b, a, group);
      else tri(k, a, b, group);
    }
  };
  capStation(0, false, HullGroup.Transom);
  capStation(stations - 1, true, HullGroup.Stem);

  return {
    positions,
    indices: Uint32Array.from(indices),
    groups: Uint8Array.from(groups),
    vertexCount: stations * ring,
    triangleCount: groups.length,
  };
}

function setVertex(positions: Float64Array, index: number, x: number, y: number, z: number): void {
  positions[3 * index] = x;
  positions[3 * index + 1] = y;
  positions[3 * index + 2] = z;
}

/** Signed volume enclosed by a closed mesh (positive for outward normals), divergence theorem. */
export function meshVolume(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * (indices[t] as number);
    const b = 3 * (indices[t + 1] as number);
    const c = 3 * (indices[t + 2] as number);
    const ax = positions[a] as number;
    const ay = positions[a + 1] as number;
    const az = positions[a + 2] as number;
    const bx = positions[b] as number;
    const by = positions[b + 1] as number;
    const bz = positions[b + 2] as number;
    const cx = positions[c] as number;
    const cy = positions[c + 1] as number;
    const cz = positions[c + 2] as number;
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return volume;
}

/**
 * Waterplane properties at the design waterline from the section function:
 * area A_wp = integral 2 b dx and transverse second moment I_T = integral (2/3) b^3 dx.
 */
export function waterplaneProperties(form: HullFormConfig, samples = 2000): { areaM2: number; transverseInertiaM4: number } {
  const dx = form.lengthM / samples;
  let area = 0;
  let inertia = 0;
  for (let i = 0; i < samples; i++) {
    const xi = -1 + (2 * (i + 0.5)) / samples;
    const b = hullSection(form, xi).halfBreadthM;
    area += 2 * b * dx;
    inertia += ((2 / 3) * b * b * b) * dx;
  }
  return { areaM2: area, transverseInertiaM4: inertia };
}
