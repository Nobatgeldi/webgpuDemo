/**
 * 6-DOF rigid body in double precision, integrated with semi-implicit
 * (symplectic) Euler: velocities first, then positions with the new velocities.
 * Orientation is a unit quaternion (w, x, y, z) mapping body to world; the
 * inertia tensor is diagonal in the body frame (principal axes).
 */

export class RigidBody {
  /** World position of the centre of gravity (m). */
  readonly position = new Float64Array(3);
  /** Body-to-world rotation (w, x, y, z). */
  readonly orientation = new Float64Array([1, 0, 0, 0]);
  /** World linear velocity of the centre of gravity (m/s). */
  readonly velocity = new Float64Array(3);
  /** World angular velocity (rad/s). */
  readonly angularVelocity = new Float64Array(3);
  /** Accumulated world force (N) and torque about the centre of gravity (N m). */
  readonly force = new Float64Array(3);
  readonly torque = new Float64Array(3);

  private readonly scratch = new Float64Array(3);
  private readonly scratch2 = new Float64Array(3);

  /**
   * @param mass (kg)
   * @param inertia Principal moments of inertia about the body X, Y, Z axes (kg m^2).
   */
  constructor(
    readonly mass: number,
    readonly inertia: readonly [number, number, number],
  ) {
    if (!(mass > 0) || inertia.some((i) => !(i > 0))) {
      throw new RangeError('mass and inertia must be positive');
    }
  }

  clearForces(): void {
    this.force.fill(0);
    this.torque.fill(0);
  }

  /** Adds a world force applied at a world point. */
  addForceAtPoint(fx: number, fy: number, fz: number, px: number, py: number, pz: number): void {
    this.force[0] += fx;
    this.force[1] += fy;
    this.force[2] += fz;
    const rx = px - (this.position[0] as number);
    const ry = py - (this.position[1] as number);
    const rz = pz - (this.position[2] as number);
    this.torque[0] += ry * fz - rz * fy;
    this.torque[1] += rz * fx - rx * fz;
    this.torque[2] += rx * fy - ry * fx;
  }

  addForce(fx: number, fy: number, fz: number): void {
    this.force[0] += fx;
    this.force[1] += fy;
    this.force[2] += fz;
  }

  addTorque(tx: number, ty: number, tz: number): void {
    this.torque[0] += tx;
    this.torque[1] += ty;
    this.torque[2] += tz;
  }

  integrate(dt: number): void {
    const m = this.mass;
    for (let i = 0; i < 3; i++) {
      this.velocity[i] = (this.velocity[i] as number) + ((this.force[i] as number) / m) * dt;
    }

    // Euler's equations in the body frame: I dw/dt = tau - w x (I w).
    const wb = this.scratch;
    this.rotateToBody(this.angularVelocity, wb);
    const tb = this.scratch2;
    this.rotateToBody(this.torque, tb);
    const [ix, iy, iz] = this.inertia;
    const wx = wb[0] as number;
    const wy = wb[1] as number;
    const wz = wb[2] as number;
    const gyroX = wy * (iz * wz) - wz * (iy * wy);
    const gyroY = wz * (ix * wx) - wx * (iz * wz);
    const gyroZ = wx * (iy * wy) - wy * (ix * wx);
    wb[0] = wx + (((tb[0] as number) - gyroX) / ix) * dt;
    wb[1] = wy + (((tb[1] as number) - gyroY) / iy) * dt;
    wb[2] = wz + (((tb[2] as number) - gyroZ) / iz) * dt;
    this.rotateToWorld(wb, this.angularVelocity);

    for (let i = 0; i < 3; i++) {
      this.position[i] = (this.position[i] as number) + (this.velocity[i] as number) * dt;
    }
    // dq/dt = 0.5 (0, w) q
    const q = this.orientation;
    const qw = q[0] as number;
    const qx = q[1] as number;
    const qy = q[2] as number;
    const qz = q[3] as number;
    const ox = this.angularVelocity[0] as number;
    const oy = this.angularVelocity[1] as number;
    const oz = this.angularVelocity[2] as number;
    const h = 0.5 * dt;
    q[0] = qw + h * (-ox * qx - oy * qy - oz * qz);
    q[1] = qx + h * (ox * qw + oy * qz - oz * qy);
    q[2] = qy + h * (oy * qw + oz * qx - ox * qz);
    q[3] = qz + h * (oz * qw + ox * qy - oy * qx);
    const norm = Math.hypot(q[0] as number, q[1] as number, q[2] as number, q[3] as number);
    for (let i = 0; i < 4; i++) q[i] = (q[i] as number) / norm;
  }

  /** Rotates a body-frame vector into the world frame. `out` may alias `v`. */
  rotateToWorld(v: ArrayLike<number>, out: Float64Array): Float64Array {
    return rotate(this.orientation, v, out, false);
  }

  /** Rotates a world-frame vector into the body frame. `out` may alias `v`. */
  rotateToBody(v: ArrayLike<number>, out: Float64Array): Float64Array {
    return rotate(this.orientation, v, out, true);
  }

  /** World position of a body-frame point. */
  pointToWorld(p: ArrayLike<number>, out: Float64Array): Float64Array {
    this.rotateToWorld(p, out);
    out[0] = (out[0] as number) + (this.position[0] as number);
    out[1] = (out[1] as number) + (this.position[1] as number);
    out[2] = (out[2] as number) + (this.position[2] as number);
    return out;
  }

  /** Velocity of a world point rigidly attached to the body: v + w x r. */
  pointVelocity(px: number, py: number, pz: number, out: Float64Array): Float64Array {
    const rx = px - (this.position[0] as number);
    const ry = py - (this.position[1] as number);
    const rz = pz - (this.position[2] as number);
    const wx = this.angularVelocity[0] as number;
    const wy = this.angularVelocity[1] as number;
    const wz = this.angularVelocity[2] as number;
    out[0] = (this.velocity[0] as number) + wy * rz - wz * ry;
    out[1] = (this.velocity[1] as number) + wz * rx - wx * rz;
    out[2] = (this.velocity[2] as number) + wx * ry - wy * rx;
    return out;
  }
}

/** Body axes (hull frame: +X bow, +Y up, +Z starboard), shared to avoid per-step allocations. */
export const BODY_FORWARD: readonly number[] = Object.freeze([1, 0, 0]);
export const BODY_UP: readonly number[] = Object.freeze([0, 1, 0]);
export const BODY_STARBOARD: readonly number[] = Object.freeze([0, 0, 1]);
export const BODY_AFT: readonly number[] = Object.freeze([-1, 0, 0]);

/** Rotates v by unit quaternion q (or its conjugate). */
export function rotate(q: ArrayLike<number>, v: ArrayLike<number>, out: Float64Array, inverse: boolean): Float64Array {
  const w = q[0] as number;
  const s = inverse ? -1 : 1;
  const x = s * (q[1] as number);
  const y = s * (q[2] as number);
  const z = s * (q[3] as number);
  const vx = v[0] as number;
  const vy = v[1] as number;
  const vz = v[2] as number;
  // t = 2 q_vec x v; v' = v + w t + q_vec x t
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
  return out;
}

/** Quaternion for a rotation of `angle` rad about a unit axis. */
export function quaternionFromAxisAngle(ax: number, ay: number, az: number, angle: number): Float64Array {
  const h = angle / 2;
  const s = Math.sin(h);
  return new Float64Array([Math.cos(h), ax * s, ay * s, az * s]);
}

/** Hamilton product a * b. */
export function multiplyQuaternions(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const aw = a[0] as number, ax = a[1] as number, ay = a[2] as number, az = a[3] as number;
  const bw = b[0] as number, bx = b[1] as number, by = b[2] as number, bz = b[3] as number;
  return new Float64Array([
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ]);
}
