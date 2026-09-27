/**
 * Flag cloth: position-based dynamics (Verlet integration + distance
 * constraints) on a rectangular grid, hoisted along one edge to a moving
 * halyard. Aerodynamic load per triangle from the relative wind:
 *   F = 1/2 rho_air C_n A (v_rel . n)|v_rel . n| n  +  1/2 rho_air C_t A |v_t| v_t
 * (normal pressure plus a small skin friction), which makes the flag stream
 * downwind and flutter. The wind carries a little turbulence so the flag
 * never freezes in a perfectly steady pose.
 * World coordinates in double precision.
 */
import { AIR_DENSITY_KG_M3, GRAVITY_M_S2 } from '../core/constants';

export const FLAG_CONFIG = {
  /** Flag size: 1.0 m hoist x 1.5 m fly (Turkish flag proportions 2:3). */
  hoistM: 1.0,
  flyM: 1.5,
  /** Grid nodes along the fly and the hoist. */
  columns: 16,
  rows: 11,
  /** Areal density of flag bunting (kg/m^2). */
  arealDensityKgM2: 0.17,
  /** Normal and tangential aerodynamic coefficients of the cloth. */
  normalForceCoefficient: 1.2,
  tangentialForceCoefficient: 0.05,
  /** Constraint iterations per step. */
  iterations: 12,
  /** Woven cloth resists shear and bending only weakly (relative constraint stiffness). */
  shearStiffness: 0.005,
  /** Stiffness of the bending (skip-one) constraints. */
  bendStiffness: 0.3,
  /** Velocity damping per second (numerical, small). */
  dampingPerS: 0.4,
  /** Relative turbulence intensity of the wind at the flag and its dominant frequencies (Hz). */
  turbulenceIntensity: 0.12,
  turbulenceFrequenciesHz: [0.23, 0.61, 1.37] as readonly number[],
  /** Spatial scale of the turbulence along the flag (m). */
  turbulenceLengthM: 2.5,
} as const;

interface Constraint {
  readonly a: number;
  readonly b: number;
  readonly rest: number;
  readonly stiffness: number;
}

export class FlagCloth {
  readonly columns = FLAG_CONFIG.columns;
  readonly rows = FLAG_CONFIG.rows;
  /** Node positions (world, m) and positions of the previous step. */
  readonly positions: Float64Array;
  private readonly previous: Float64Array;
  private readonly forces: Float64Array;
  private readonly constraints: Constraint[] = [];
  private readonly nodeMass: number;
  private readonly hoist = new Float64Array(6);
  private initialised = false;
  /** Largest relative wind speed seen at the flag in the last step (m/s). */
  relativeWindMs = 0;

  constructor() {
    const { columns, rows } = this;
    const count = columns * rows;
    this.positions = new Float64Array(3 * count);
    this.previous = new Float64Array(3 * count);
    this.forces = new Float64Array(3 * count);
    const dx = FLAG_CONFIG.flyM / (columns - 1);
    const dy = FLAG_CONFIG.hoistM / (rows - 1);
    this.nodeMass = (FLAG_CONFIG.arealDensityKgM2 * FLAG_CONFIG.flyM * FLAG_CONFIG.hoistM) / count;
    const add = (a: number, b: number, rest: number, stiffness: number): void => {
      this.constraints.push({ a, b, rest, stiffness });
    };
    const diagonal = Math.hypot(dx, dy);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) {
        const n = this.index(i, j);
        if (i + 1 < columns) add(n, this.index(i + 1, j), dx, 1);
        if (j + 1 < rows) add(n, this.index(i, j + 1), dy, 1);
        if (i + 1 < columns && j + 1 < rows) {
          add(n, this.index(i + 1, j + 1), diagonal, FLAG_CONFIG.shearStiffness);
          add(this.index(i + 1, j), this.index(i, j + 1), diagonal, FLAG_CONFIG.shearStiffness);
        }
        if (i + 2 < columns) add(n, this.index(i + 2, j), 2 * dx, FLAG_CONFIG.bendStiffness);
        if (j + 2 < rows) add(n, this.index(i, j + 2), 2 * dy, FLAG_CONFIG.bendStiffness);
      }
    }
  }

  /** Node index of column i (0 at the hoist) and row j (0 at the bottom). */
  index(i: number, j: number): number {
    return j * this.columns + i;
  }

  /**
   * Advances by `dt`. The hoist runs from `bottom` to `top` (world); `away` is
   * the unit direction the flag hangs out to initially. Wind is the world
   * velocity of the air at the flag (m/s).
   */
  step(
    dt: number,
    timeS: number,
    bottom: ArrayLike<number>,
    top: ArrayLike<number>,
    away: ArrayLike<number>,
    windX: number,
    windY: number,
    windZ: number,
  ): void {
    const { columns, rows, positions: p, previous: q, forces: f } = this;
    if (!this.initialised) {
      this.reset(bottom, top, away);
    }
    // Pin the hoist edge to the halyard.
    for (let j = 0; j < rows; j++) {
      const t = j / (rows - 1);
      const n = 3 * this.index(0, j);
      for (let k = 0; k < 3; k++) {
        this.hoist[k] = (bottom[k] as number) + t * ((top[k] as number) - (bottom[k] as number));
        q[n + k] = p[n + k] as number;
        p[n + k] = this.hoist[k] as number;
      }
    }

    // Aerodynamic and gravity forces.
    f.fill(0);
    let maxWind = 0;
    const c = FLAG_CONFIG;
    for (let j = 0; j + 1 < rows; j++) {
      for (let i = 0; i + 1 < columns; i++) {
        const quad = [this.index(i, j), this.index(i + 1, j), this.index(i + 1, j + 1), this.index(i, j + 1)];
        for (const [a, b, d] of [
          [quad[0], quad[1], quad[2]],
          [quad[0], quad[2], quad[3]],
        ] as [number, number, number][]) {
          const ax = p[3 * a] as number, ay = p[3 * a + 1] as number, az = p[3 * a + 2] as number;
          const e1x = (p[3 * b] as number) - ax, e1y = (p[3 * b + 1] as number) - ay, e1z = (p[3 * b + 2] as number) - az;
          const e2x = (p[3 * d] as number) - ax, e2y = (p[3 * d + 1] as number) - ay, e2z = (p[3 * d + 2] as number) - az;
          let nx = e1y * e2z - e1z * e2y;
          let ny = e1z * e2x - e1x * e2z;
          let nz = e1x * e2y - e1y * e2x;
          const twiceArea = Math.hypot(nx, ny, nz);
          if (twiceArea < 1e-12) continue;
          nx /= twiceArea;
          ny /= twiceArea;
          nz /= twiceArea;
          const area = twiceArea / 2;
          // Triangle velocity from the Verlet history, and the turbulent wind at its centroid.
          let vx = 0, vy = 0, vz = 0;
          for (const n of [a, b, d]) {
            vx += ((p[3 * n] as number) - (q[3 * n] as number)) / dt;
            vy += ((p[3 * n + 1] as number) - (q[3 * n + 1] as number)) / dt;
            vz += ((p[3 * n + 2] as number) - (q[3 * n + 2] as number)) / dt;
          }
          const gust = 1 + this.turbulence(timeS, (i + j * 0.7) * (c.flyM / (columns - 1)));
          const rx = windX * gust - vx / 3;
          const ry = windY * gust - vy / 3;
          const rz = windZ * gust - vz / 3;
          maxWind = Math.max(maxWind, Math.hypot(rx, ry, rz));
          const vn = rx * nx + ry * ny + rz * nz;
          const pressure = 0.5 * AIR_DENSITY_KG_M3 * c.normalForceCoefficient * area * vn * Math.abs(vn);
          const tx = rx - vn * nx, ty = ry - vn * ny, tz = rz - vn * nz;
          const friction = 0.5 * AIR_DENSITY_KG_M3 * c.tangentialForceCoefficient * area * Math.hypot(tx, ty, tz);
          const fx = (pressure * nx + friction * tx) / 3;
          const fy = (pressure * ny + friction * ty) / 3;
          const fz = (pressure * nz + friction * tz) / 3;
          for (const n of [a, b, d]) {
            f[3 * n] = (f[3 * n] as number) + fx;
            f[3 * n + 1] = (f[3 * n + 1] as number) + fy;
            f[3 * n + 2] = (f[3 * n + 2] as number) + fz;
          }
        }
      }
    }
    this.relativeWindMs = maxWind;

    // Verlet integration of the free nodes.
    const keep = Math.exp(-c.dampingPerS * dt);
    const inverseMass = 1 / this.nodeMass;
    for (let j = 0; j < rows; j++) {
      for (let i = 1; i < columns; i++) {
        const n = 3 * this.index(i, j);
        for (let k = 0; k < 3; k++) {
          const x = p[n + k] as number;
          const acceleration = (f[n + k] as number) * inverseMass - (k === 1 ? GRAVITY_M_S2 : 0);
          p[n + k] = x + (x - (q[n + k] as number)) * keep + acceleration * dt * dt;
          q[n + k] = x;
        }
      }
    }

    // Distance constraints; hoist nodes are fixed (infinite mass).
    for (let iteration = 0; iteration < c.iterations; iteration++) {
      for (const constraint of this.constraints) {
        const a = 3 * constraint.a;
        const b = 3 * constraint.b;
        const wa = constraint.a % columns === 0 ? 0 : 1;
        const wb = constraint.b % columns === 0 ? 0 : 1;
        if (wa + wb === 0) continue;
        const dx = (p[b] as number) - (p[a] as number);
        const dy = (p[b + 1] as number) - (p[a + 1] as number);
        const dz = (p[b + 2] as number) - (p[a + 2] as number);
        const length = Math.hypot(dx, dy, dz);
        if (length < 1e-12) continue;
        const correction = (constraint.stiffness * (length - constraint.rest)) / (length * (wa + wb));
        p[a] = (p[a] as number) + wa * correction * dx;
        p[a + 1] = (p[a + 1] as number) + wa * correction * dy;
        p[a + 2] = (p[a + 2] as number) + wa * correction * dz;
        p[b] = (p[b] as number) - wb * correction * dx;
        p[b + 1] = (p[b + 1] as number) - wb * correction * dy;
        p[b + 2] = (p[b + 2] as number) - wb * correction * dz;
      }
    }
  }

  /** Lays the flag out flat from the hoist in direction `away`, at rest. */
  reset(bottom: ArrayLike<number>, top: ArrayLike<number>, away: ArrayLike<number>): void {
    const dx = FLAG_CONFIG.flyM / (this.columns - 1);
    for (let j = 0; j < this.rows; j++) {
      const t = j / (this.rows - 1);
      for (let i = 0; i < this.columns; i++) {
        const n = 3 * this.index(i, j);
        for (let k = 0; k < 3; k++) {
          const hoist = (bottom[k] as number) + t * ((top[k] as number) - (bottom[k] as number));
          this.positions[n + k] = hoist + i * dx * (away[k] as number);
          this.previous[n + k] = this.positions[n + k] as number;
        }
      }
    }
    this.initialised = true;
  }

  /** Relative wind speed fluctuation: a few incommensurate sinusoids travelling along the flag. */
  private turbulence(timeS: number, alongM: number): number {
    const c = FLAG_CONFIG;
    let sum = 0;
    c.turbulenceFrequenciesHz.forEach((frequency, k) => {
      sum += Math.sin(2 * Math.PI * frequency * timeS - (alongM / c.turbulenceLengthM) * (k + 1) + k * 1.7);
    });
    return (c.turbulenceIntensity * sum) / Math.sqrt(c.turbulenceFrequenciesHz.length / 2);
  }
}
