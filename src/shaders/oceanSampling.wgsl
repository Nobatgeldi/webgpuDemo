// Sampling the sum of the FFT cascades at arbitrary world points, shared by
// compute passes that need the water surface (water height queries, spray).
// Positions are offsets from an origin near the queried area; the origin is
// passed wrapped by each cascade's patch size (computed in double precision).

const OCEAN_SAMPLING_MAX_CASCADES: u32 = 3u;

struct OceanSamplingFrame {
  // xy / zw: world XZ of the origin wrapped by the patch size of cascade 0 / 1
  origins01: vec4<f32>,
  // xy: same for cascade 2
  origins2: vec4<f32>,
  // xyz: patch sizes (m), w: cascade count
  patchSizes: vec4<f32>,
}

fn oceanSamplingOrigin(frame: OceanSamplingFrame, cascade: u32) -> vec2<f32> {
  switch cascade {
    case 0u: { return frame.origins01.xy; }
    case 1u: { return frame.origins01.zw; }
    default: { return frame.origins2.xy; }
  }
}

// Displacement (dx, height, dz) of the surface point whose undisplaced position is `offset`.
fn oceanDisplacementAt(
  displacement: texture_2d_array<f32>,
  displacementSampler: sampler,
  frame: OceanSamplingFrame,
  offset: vec2<f32>,
) -> vec3<f32> {
  var sum = vec3<f32>(0.0);
  let count = u32(frame.patchSizes.w);
  for (var c = 0u; c < OCEAN_SAMPLING_MAX_CASCADES; c++) {
    if (c < count) {
      let uv = (oceanSamplingOrigin(frame, c) + offset) / frame.patchSizes[c];
      sum += textureSampleLevel(displacement, displacementSampler, uv, c, 0.0).xyz;
    }
  }
  return sum;
}

// Water height above the point `offset`: choppy waves move surface points
// horizontally, so the undisplaced x with x + D(x) = p is found by fixed-point iteration.
fn oceanHeightAt(
  displacement: texture_2d_array<f32>,
  displacementSampler: sampler,
  frame: OceanSamplingFrame,
  offset: vec2<f32>,
  iterations: u32,
) -> f32 {
  var x = offset;
  for (var i = 0u; i < iterations; i++) {
    x = offset - oceanDisplacementAt(displacement, displacementSampler, frame, x).xz;
  }
  return oceanDisplacementAt(displacement, displacementSampler, frame, x).y;
}
