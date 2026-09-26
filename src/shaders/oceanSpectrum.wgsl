// Initial spectrum h0(k) for every cascade (Tessendorf 2001):
//   h0(k) = (xi_r + i xi_i) / sqrt(2) * sqrt(S(k) dk^2 / 2)
// With h(k, t) = h0(k) e^{i w t} + conj(h0(-k)) e^{-i w t} the expected power
// sum_k |h(k)|^2 equals the height variance m0 of the resolved band.
// Output: xy = h0(k), zw = conj(h0(-k)). Runs whenever the sea state changes.
// Requires oceanCompute.wgsl.

@group(0) @binding(1) var gaussianNoise: texture_2d_array<f32>;
@group(0) @binding(2) var h0Out: texture_storage_2d_array<rgba32float, write>;

fn bandAmplitude(k: vec2<f32>, cascade: u32) -> f32 {
  let band = ocean.cascades[cascade];
  let kLength = length(k);
  if (kLength < band.y || kLength >= band.z) {
    return 0.0;
  }
  let dk = TAU / band.x;
  return sqrt(wavenumberSpectrum(k) * dk * dk * 0.5);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = fftSize();
  if (id.x >= n || id.y >= n) {
    return;
  }
  let cascade = id.z;
  let k = waveVector(id.xy, cascade);
  let mirror = (vec2<u32>(n) - id.xy) % vec2<u32>(n);
  let xi = textureLoad(gaussianNoise, id.xy, cascade, 0).xy;
  let xiMirror = textureLoad(gaussianNoise, mirror, cascade, 0).xy;
  let h0 = xi * (INV_SQRT2 * bandAmplitude(k, cascade));
  let h0Mirror = xiMirror * (INV_SQRT2 * bandAmplitude(-k, cascade));
  textureStore(h0Out, id.xy, cascade, vec4<f32>(h0, h0Mirror.x, -h0Mirror.y));
}
