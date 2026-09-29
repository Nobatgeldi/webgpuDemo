import { mat4, mat4d, vec3d, type Mat4, type Mat4d, type Vec3d } from 'wgpu-matrix';
import { CAMERA_DEFAULT_FOV_Y_DEG, CAMERA_FAR_M, CAMERA_NEAR_M } from './renderConfig';

const DEG_TO_RAD = Math.PI / 180;
const WORLD_UP: Readonly<Vec3d> = vec3d.create(0, 1, 0);
/** Below this |forward x up| the up vector is replaced to keep lookAt well defined. */
const PARALLEL_UP_EPSILON = 1e-6;

/**
 * Perspective camera with a double-precision world position and camera-relative
 * matrices: the view matrix holds rotation only, and geometry is submitted
 * relative to {@link Camera.position}.
 *
 * Projection uses reversed Z (near -> depth 1, far -> depth 0) for an almost
 * uniform depth precision distribution with a depth32float buffer.
 */
export class Camera {
  /** World position in metres (double precision). */
  readonly position: Vec3d = vec3d.create(0, 10, 0);
  /** Unit view direction in world space. */
  readonly forward: Vec3d = vec3d.create(0, 0, -1);
  /** Approximate up direction (world up by default; tilted for camera roll). */
  readonly up: Vec3d = vec3d.create(0, 1, 0);

  fovYRad = CAMERA_DEFAULT_FOV_Y_DEG * DEG_TO_RAD;
  near = CAMERA_NEAR_M;
  far = CAMERA_FAR_M;
  aspect = 1;

  // Double-precision intermediates.
  private readonly viewD: Mat4d = mat4d.create();
  private readonly projD: Mat4d = mat4d.create();
  private readonly viewProjD: Mat4d = mat4d.create();
  private readonly invViewProjD: Mat4d = mat4d.create();
  private readonly originD: Vec3d = vec3d.create(0, 0, 0);
  private readonly upD: Vec3d = vec3d.create(0, 1, 0);
  private readonly crossD: Vec3d = vec3d.create();

  // Float32 results for GPU upload.
  readonly view: Mat4 = mat4.create();
  readonly projection: Mat4 = mat4.create();
  readonly viewProjection: Mat4 = mat4.create();
  readonly inverseViewProjection: Mat4 = mat4.create();

  /** Points the camera at a world-space target. */
  lookAt(target: ArrayLike<number>): void {
    const dx = (target[0] as number) - (this.position[0] as number);
    const dy = (target[1] as number) - (this.position[1] as number);
    const dz = (target[2] as number) - (this.position[2] as number);
    const length = Math.hypot(dx, dy, dz);
    if (length > 0) {
      vec3d.set(dx / length, dy / length, dz / length, this.forward);
    }
  }

  /** Recomputes all matrices from position/forward/projection parameters. */
  updateMatrices(): void {
    // View matrix with the camera at the origin (camera-relative rendering).
    vec3d.cross(this.forward, this.up, this.crossD);
    if (vec3d.length(this.crossD) < PARALLEL_UP_EPSILON) {
      // Looking along the up vector: use world -Z (or world up) as a stable reference instead.
      if (vec3d.length(vec3d.cross(this.forward, WORLD_UP, this.crossD)) < PARALLEL_UP_EPSILON) {
        vec3d.set(0, 0, -1, this.upD);
      } else {
        vec3d.copy(WORLD_UP, this.upD);
      }
    } else {
      vec3d.copy(this.up, this.upD);
    }
    mat4d.lookAt(this.originD, this.forward, this.upD, this.viewD);
    mat4d.perspectiveReverseZ(this.fovYRad, this.aspect, this.near, this.far, this.projD);
    mat4d.multiply(this.projD, this.viewD, this.viewProjD);
    mat4d.inverse(this.viewProjD, this.invViewProjD);

    copyToFloat32(this.viewD, this.view);
    copyToFloat32(this.projD, this.projection);
    copyToFloat32(this.viewProjD, this.viewProjection);
    copyToFloat32(this.invViewProjD, this.inverseViewProjection);
  }
}

function copyToFloat32(source: Mat4d, target: Mat4): void {
  for (let i = 0; i < 16; i++) {
    target[i] = source[i] as number;
  }
}
