// Diagnostics, per row of every cascade: sum of h^2 (significant wave height
// actually produced on the GPU) and the number of foam-covered texels (whitecap
// coverage). Read back asynchronously and compared against the models in the
// debug overlay. Layout: [cascade * N + row] for h^2, then the same for foam.

// Foam amount above which a texel counts as whitecap.
const FOAM_COVERAGE_THRESHOLD: f32 = 0.5;

override FFT_SIZE: u32 = 256u;
const WORKGROUP_SIZE: u32 = 64u;

@group(0) @binding(0) var fields: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> rowSums: array<f32>;
@group(0) @binding(2) var foam: texture_2d_array<f32>;

var<workgroup> partial: array<vec2<f32>, WORKGROUP_SIZE>;

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
  @builtin(workgroup_id) group: vec3<u32>,
  @builtin(local_invocation_index) thread: u32,
) {
  let row = group.x;
  let cascade = group.y;
  var sum = vec2<f32>(0.0);
  for (var i = thread; i < FFT_SIZE; i += WORKGROUP_SIZE) {
    let h = textureLoad(fields, vec2<u32>(i, row), 2u * cascade, 0).y;
    let covered = textureLoad(foam, vec2<u32>(i, row), cascade, 0).x > FOAM_COVERAGE_THRESHOLD;
    sum += vec2<f32>(h * h, select(0.0, 1.0, covered));
  }
  partial[thread] = sum;
  workgroupBarrier();
  for (var stride = WORKGROUP_SIZE / 2u; stride > 0u; stride /= 2u) {
    if (thread < stride) {
      partial[thread] += partial[thread + stride];
    }
    workgroupBarrier();
  }
  if (thread == 0u) {
    let index = cascade * FFT_SIZE + row;
    rowSums[index] = partial[0].x;
    rowSums[arrayLength(&rowSums) / 2u + index] = partial[0].y;
  }
}
