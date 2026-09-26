// Per-frame resources, bound as @group(0) by every scene pass.
// Field order and sizes must match FRAME_UNIFORM_OFFSETS in render/frameUniforms.ts.
//
// Matrices are camera-relative: world geometry is submitted as
// (worldPosition - cameraPosition), and `view` contains rotation only.

struct FrameUniforms {
  viewProj: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  view: mat4x4<f32>,
  proj: mat4x4<f32>,
  // xyz: camera world position (float32, approximate), w: near plane (m)
  cameraWorld: vec4<f32>,
  // x, z: camera world XZ wrapped to [0, w) in double precision on the CPU; y: altitude; w: period (m)
  cameraWrapped: vec4<f32>,
  // xyz: unit vector towards the sun, w: cos(sun angular radius)
  sunDirection: vec4<f32>,
  // rgb: sun disk radiance at sea level (after clouds)
  sunDiskRadiance: vec4<f32>,
  // rgb: direct-beam irradiance at normal incidence (after clouds)
  sunIrradiance: vec4<f32>,
  // x: cloud cover fraction
  sky: vec4<f32>,
  // width, height, 1/width, 1/height (pixels)
  viewport: vec4<f32>,
  // x: simulation time (s), y: frame time (s), z: frame index
  time: vec4<f32>,
}

struct SkyLight {
  // rgb: sky irradiance on a horizontal surface
  irradiance: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
// Sky radiance by direction (sky/atmosphere.ts), see skyCommon.wgsl.
@group(0) @binding(1) var skyViewLut: texture_2d<f32>;
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var atmosphereSampler: sampler;
@group(0) @binding(4) var<storage, read> skyLight: SkyLight;
