import type { Camera } from './camera';
import type { Atmosphere } from '../sky/atmosphere';
import type { SunState } from '../sky/atmosphereModel';
import { SKY_LIGHT_BYTES } from '../sky/atmosphere';
import { wrapPeriodic } from '../core/cameraRelative';
import { CAMERA_WRAP_PERIOD_M } from './renderConfig';

/**
 * Float offsets of the fields of `FrameUniforms` in shaders/frame.wgsl.
 * Every field is a vec4 or mat4x4, so the layout has no implicit padding.
 * tests/frameUniforms.test.ts verifies this table against the WGSL struct.
 */
export const FRAME_UNIFORM_OFFSETS = {
  viewProj: 0,
  invViewProj: 16,
  view: 32,
  proj: 48,
  cameraWorld: 64,
  cameraWrapped: 68,
  sunDirection: 72,
  sunDiskRadiance: 76,
  sunIrradiance: 80,
  sky: 84,
  viewport: 88,
  time: 92,
} as const;

export const FRAME_UNIFORM_FLOATS = 96;
export const FRAME_UNIFORM_BYTES = FRAME_UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT;

export interface FrameUniformInputs {
  readonly camera: Camera;
  readonly sun: SunState;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly simTimeSeconds: number;
  readonly frameSeconds: number;
  readonly frameIndex: number;
}

/**
 * Bind group 0 of every scene pass: the per-frame uniform block plus the sky
 * resources (sky-view and transmittance LUTs, sampler, sky irradiance).
 */
export class FrameUniforms {
  readonly buffer: GPUBuffer;
  /** Layout of bind group 0 shared by all scene pipelines. */
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly bindGroup: GPUBindGroup;
  private readonly data = new Float32Array(FRAME_UNIFORM_FLOATS);

  constructor(
    private readonly device: GPUDevice,
    atmosphere: Atmosphere,
  ) {
    this.buffer = device.createBuffer({
      label: 'frame-uniforms',
      size: FRAME_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const ALL_STAGES = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'frame-uniforms',
      entries: [
        {
          binding: 0,
          visibility: ALL_STAGES,
          buffer: { type: 'uniform', minBindingSize: FRAME_UNIFORM_BYTES },
        },
        { binding: 1, visibility: ALL_STAGES, texture: { sampleType: 'float' } },
        { binding: 2, visibility: ALL_STAGES, texture: { sampleType: 'float' } },
        { binding: 3, visibility: ALL_STAGES, sampler: { type: 'filtering' } },
        {
          binding: 4,
          visibility: ALL_STAGES,
          buffer: { type: 'read-only-storage', minBindingSize: SKY_LIGHT_BYTES },
        },
      ],
    });
    this.bindGroup = device.createBindGroup({
      label: 'frame-uniforms',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.buffer } },
        { binding: 1, resource: atmosphere.skyViewLut.createView() },
        { binding: 2, resource: atmosphere.transmittanceLut.createView() },
        { binding: 3, resource: atmosphere.sampler },
        { binding: 4, resource: { buffer: atmosphere.skyLightBuffer } },
      ],
    });
  }

  update(inputs: FrameUniformInputs): void {
    const { camera, sun } = inputs;
    const d = this.data;
    const o = FRAME_UNIFORM_OFFSETS;

    d.set(camera.viewProjection, o.viewProj);
    d.set(camera.inverseViewProjection, o.invViewProj);
    d.set(camera.view, o.view);
    d.set(camera.projection, o.proj);

    const cx = camera.position[0] as number;
    const cy = camera.position[1] as number;
    const cz = camera.position[2] as number;
    // Approximate absolute position; only for effects that tolerate float32 rounding.
    set4(d, o.cameraWorld, cx, cy, cz, camera.near);
    // Wrapped in double precision so periodic patterns stay exact far from the origin.
    set4(
      d,
      o.cameraWrapped,
      wrapPeriodic(cx, CAMERA_WRAP_PERIOD_M),
      cy,
      wrapPeriodic(cz, CAMERA_WRAP_PERIOD_M),
      CAMERA_WRAP_PERIOD_M,
    );

    set4(d, o.sunDirection, ...sun.direction, Math.cos(sun.angularRadiusRad));
    set4(d, o.sunDiskRadiance, ...sun.diskRadiance, 0);
    set4(d, o.sunIrradiance, ...sun.irradiance, 0);
    set4(d, o.sky, sun.overcast, 0, 0, 0);

    const width = Math.max(1, inputs.viewportWidth);
    const height = Math.max(1, inputs.viewportHeight);
    set4(d, o.viewport, width, height, 1 / width, 1 / height);
    set4(d, o.time, inputs.simTimeSeconds, inputs.frameSeconds, inputs.frameIndex, 0);

    this.device.queue.writeBuffer(this.buffer, 0, d);
  }

  dispose(): void {
    this.buffer.destroy();
  }
}

function set4(target: Float32Array, offset: number, x: number, y: number, z: number, w: number): void {
  target[offset] = x;
  target[offset + 1] = y;
  target[offset + 2] = z;
  target[offset + 3] = w;
}
