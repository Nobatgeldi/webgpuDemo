// Per-frame uniform block, bound at @group(0) @binding(0) by every scene pass.
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
  // rgb: sun disk radiance after extinction
  sunDiskRadiance: vec4<f32>,
  // rgb: direct-beam irradiance at normal incidence
  sunIrradiance: vec4<f32>,
  // rgb: halo strength, w: Henyey-Greenstein asymmetry g
  sunHalo: vec4<f32>,
  skyZenith: vec4<f32>,
  skyHorizon: vec4<f32>,
  skyBelowHorizon: vec4<f32>,
  // width, height, 1/width, 1/height (pixels)
  viewport: vec4<f32>,
  // x: simulation time (s), y: frame time (s), z: frame index
  time: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
