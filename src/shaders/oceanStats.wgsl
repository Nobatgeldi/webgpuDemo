// Diagnostics: sum of h^2 over every row of every cascade, read back
// asynchronously to measure the significant wave height actually produced on
// the GPU (compared against the spectrum model in the debug overlay).

override FFT_SIZE: u32 = 256u;
const WORKGROUP_SIZE: u32 = 64u;

@group(0) @binding(0) var fields: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> rowSums: array<f32>;

var<workgroup> partial: array<f32, WORKGROUP_SIZE>;

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
  @builtin(workgroup_id) group: vec3<u32>,
  @builtin(local_invocation_index) thread: u32,
) {
  let row = group.x;
  let cascade = group.y;
  var sum = 0.0;
  for (var i = thread; i < FFT_SIZE; i += WORKGROUP_SIZE) {
    let h = textureLoad(fields, vec2<u32>(i, row), 2u * cascade, 0).y;
    sum += h * h;
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
    rowSums[cascade * FFT_SIZE + row] = partial[0];
  }
}
