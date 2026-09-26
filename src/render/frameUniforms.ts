import type { Camera } from './camera';
import type { SkyState } from '../sky/skyModel';
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
  sunHalo: 84,
  skyZenith: 88,
  skyHorizon: 92,
  skyBelowHorizon: 96,
  viewport: 100,
  time: 104,
} as const;

export const FRAME_UNIFORM_FLOATS = 108;
export const FRAME_UNIFORM_BYTES = FRAME_UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT;

export interface FrameUniformInputs {
  readonly camera: Camera;
  readonly sky: SkyState;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly simTimeSeconds: number;
  readonly frameSeconds: number;
  readonly frameIndex: number;
}

/** The per-frame uniform block bound at @group(0) @binding(0) by every scene pass. */
export class FrameUniforms {
  readonly buffer: GPUBuffer;
  /** Layout of bind group 0 shared by all scene pipelines. */
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly bindGroup: GPUBindGroup;
  private readonly data = new Float32Array(FRAME_UNIFORM_FLOATS);

  constructor(private readonly device: GPUDevice) {
    this.buffer = device.createBuffer({
      label: 'frame-uniforms',
      size: FRAME_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'frame-uniforms',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform', minBindingSize: FRAME_UNIFORM_BYTES },
        },
      ],
    });
    this.bindGroup = device.createBindGroup({
      label: 'frame-uniforms',
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.buffer } }],
    });
  }

  update(inputs: FrameUniformInputs): void {
    const { camera, sky } = inputs;
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

    set4(d, o.sunDirection, ...sky.sunDirection, Math.cos(sky.sunAngularRadiusRad));
    set4(d, o.sunDiskRadiance, ...sky.sunDiskRadiance, 0);
    set4(d, o.sunIrradiance, ...sky.sunIrradiance, 0);
    set4(d, o.sunHalo, ...sky.sunHalo, sky.sunHaloAsymmetry);
    set4(d, o.skyZenith, ...sky.zenith, 0);
    set4(d, o.skyHorizon, ...sky.horizon, 0);
    set4(d, o.skyBelowHorizon, ...sky.belowHorizon, 0);

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
