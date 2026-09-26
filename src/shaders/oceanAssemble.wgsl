// Unpacks the inverse-FFT results into the filterable textures sampled by the
// renderer (and later by the water query):
//   displacement: (lambda Dx, h, lambda Dz, lambda dDx/dz)
//   derivatives:  (dh/dx, dh/dz, lambda dDx/dx, lambda dDz/dz)
// Requires oceanCompute.wgsl.

@group(0) @binding(1) var fields: texture_2d_array<f32>;
@group(0) @binding(2) var displacementOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var derivativesOut: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = fftSize();
  if (id.x >= n || id.y >= n) {
    return;
  }
  let cascade = id.z;
  let lambda = ocean.wind.z;
  let a = textureLoad(fields, id.xy, 2u * cascade, 0);
  let b = textureLoad(fields, id.xy, 2u * cascade + 1u, 0);
  textureStore(displacementOut, id.xy, cascade, vec4<f32>(lambda * a.x, a.y, lambda * a.z, lambda * a.w));
  textureStore(derivativesOut, id.xy, cascade, vec4<f32>(b.x, b.y, lambda * b.z, lambda * b.w));
}
