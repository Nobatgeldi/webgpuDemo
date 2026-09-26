// One pass of the 2D inverse FFT: every workgroup transforms one row (or column)
// of one texture layer in workgroup shared memory with a radix-2 Stockham
// autosort algorithm (no bit reversal). Each texel holds two complex numbers
// (xy, zw) that are transformed together. ocean/fftReference.ts mirrors this
// code exactly and is validated against a naive DFT.
//   x[n] = sum_k X[k] exp(+2 pi i k n / N)   (no normalisation)

override FFT_SIZE: u32 = 256u;
override LOG2_FFT_SIZE: u32 = 8u;
override WORKGROUP_SIZE: u32 = 128u;
// false: transform rows (along x), true: columns (along z).
override COLUMN_PASS: bool = false;

const TAU: f32 = 6.283185307179586;

@group(0) @binding(0) var source: texture_2d_array<f32>;
@group(0) @binding(1) var destination: texture_storage_2d_array<rgba32float, write>;

// Ping-pong halves: [0, N) and [N, 2N).
var<workgroup> lines: array<vec4<f32>, 2u * FFT_SIZE>;

fn texelOf(line: u32, i: u32) -> vec2<u32> {
  return select(vec2<u32>(i, line), vec2<u32>(line, i), COLUMN_PASS);
}

// Multiplies both complex numbers packed in `v` by `w`.
fn rotatePair(v: vec4<f32>, w: vec2<f32>) -> vec4<f32> {
  return vec4<f32>(
    v.x * w.x - v.y * w.y, v.x * w.y + v.y * w.x,
    v.z * w.x - v.w * w.y, v.z * w.y + v.w * w.x,
  );
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
  @builtin(workgroup_id) group: vec3<u32>,
  @builtin(local_invocation_index) thread: u32,
) {
  let line = group.x;
  let layer = group.y;
  for (var i = thread; i < FFT_SIZE; i += WORKGROUP_SIZE) {
    lines[i] = textureLoad(source, texelOf(line, i), layer, 0);
  }
  workgroupBarrier();

  let halfSize = FFT_SIZE / 2u;
  var sourceOffset = 0u;
  var destinationOffset = FFT_SIZE;
  for (var stage = 0u; stage < LOG2_FFT_SIZE; stage++) {
    let span = 1u << stage;
    for (var j = thread; j < halfSize; j += WORKGROUP_SIZE) {
      let k = j & (span - 1u);
      let angle = TAU * f32(k) / f32(2u * span);
      let twiddle = vec2<f32>(cos(angle), sin(angle));
      let a = lines[sourceOffset + j];
      let b = rotatePair(lines[sourceOffset + j + halfSize], twiddle);
      let outIndex = (j - k) * 2u + k;
      lines[destinationOffset + outIndex] = a + b;
      lines[destinationOffset + outIndex + span] = a - b;
    }
    workgroupBarrier();
    let swap = sourceOffset;
    sourceOffset = destinationOffset;
    destinationOffset = swap;
  }

  for (var i = thread; i < FFT_SIZE; i += WORKGROUP_SIZE) {
    textureStore(destination, texelOf(line, i), layer, lines[sourceOffset + i]);
  }
}
