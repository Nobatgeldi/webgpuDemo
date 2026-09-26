// Water height at arbitrary points, sampled from the same displacement
// textures the renderer uses (the GPU ocean is the single source of truth).
// Choppy waves move surface points horizontally, so the surface point above
// a query position p is found by fixed-point iteration of x = p - D(x).

const MAX_CASCADES: u32 = 3u;

struct WaterQueryUniforms {
  // xy / zw: world XZ of the query origin wrapped by the patch size of cascade 0 / 1
  origins01: vec4<f32>,
  // xy: same for cascade 2
  origins2: vec4<f32>,
  // xyz: patch sizes (m), w: cascade count
  patchSizes: vec4<f32>,
  // x: number of points, y: fixed-point iterations
  params: vec4<f32>,
}

@group(0) @binding(0) var<uniform> query: WaterQueryUniforms;
@group(0) @binding(1) var displacementTexture: texture_2d_array<f32>;
@group(0) @binding(2) var displacementSampler: sampler;
// Query positions relative to the origin (m).
@group(0) @binding(3) var<storage, read> points: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> heights: array<f32>;

fn cascadeOrigin(cascade: u32) -> vec2<f32> {
  switch cascade {
    case 0u: { return query.origins01.xy; }
    case 1u: { return query.origins01.zw; }
    default: { return query.origins2.xy; }
  }
}

fn displacementAt(offset: vec2<f32>) -> vec3<f32> {
  var sum = vec3<f32>(0.0);
  let count = u32(query.patchSizes.w);
  for (var c = 0u; c < MAX_CASCADES; c++) {
    if (c < count) {
      let uv = (cascadeOrigin(c) + offset) / query.patchSizes[c];
      sum += textureSampleLevel(displacementTexture, displacementSampler, uv, c, 0.0).xyz;
    }
  }
  return sum;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  if (index >= u32(query.params.x)) {
    return;
  }
  let queryPoint = points[index];
  var x = queryPoint;
  let iterations = u32(query.params.y);
  for (var i = 0u; i < iterations; i++) {
    x = queryPoint - displacementAt(x).xz;
  }
  heights[index] = displacementAt(x).y;
}
