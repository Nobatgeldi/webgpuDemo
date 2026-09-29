// Water height at arbitrary points, sampled from the same displacement
// textures the renderer uses (the GPU ocean is the single source of truth).
// Requires oceanSampling.wgsl.

struct WaterQueryUniforms {
  // Origin of the query points, wrapped per cascade, and the patch sizes.
  ocean: OceanSamplingFrame,
  // x: number of points, y: fixed-point iterations
  params: vec4<f32>,
}

@group(0) @binding(0) var<uniform> query: WaterQueryUniforms;
@group(0) @binding(1) var displacementTexture: texture_2d_array<f32>;
@group(0) @binding(2) var displacementSampler: sampler;
// Query positions relative to the origin (m).
@group(0) @binding(3) var<storage, read> points: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> heights: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  if (index >= u32(query.params.x)) {
    return;
  }
  heights[index] = oceanHeightAt(
    displacementTexture,
    displacementSampler,
    query.ocean,
    points[index],
    u32(query.params.y),
  );
}
