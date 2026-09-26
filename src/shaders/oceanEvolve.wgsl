// Time evolution and field spectra. For every wave vector it builds the spectra
// of eight real fields and packs them pairwise as A + iB (the inverse FFT of a
// Hermitian spectrum is real, so one complex transform yields two fields):
//   layer 2c:     (Dx + i h,     Dz + i dDx/dz)
//   layer 2c + 1: (dh/dx + i dh/dz, dDx/dx + i dDz/dz)
// Horizontal displacement D = i (k / |k|) h gives Gerstner-like sharp crests for
// a positive choppiness (x' = x + lambda D).
// Requires oceanCompute.wgsl.

@group(0) @binding(1) var h0Texture: texture_2d_array<f32>;
@group(0) @binding(2) var fieldsOut: texture_storage_2d_array<rgba32float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = fftSize();
  if (id.x >= n || id.y >= n) {
    return;
  }
  let cascade = id.z;
  let k = waveVector(id.xy, cascade);
  let kLength = length(k);
  let h0 = textureLoad(h0Texture, id.xy, cascade, 0);

  // Deep-water dispersion, quantised to the loop frequency so that the phase
  // can be evaluated from the wrapped time without float32 precision loss.
  let omega = sqrt(ocean.grid.y * kLength);
  let quanta = round(omega / ocean.grid.z);
  let phase = TAU * fract(quanta * ocean.grid.w);
  let rotation = vec2<f32>(cos(phase), sin(phase));
  let h = complexMul(h0.xy, rotation) + complexMul(h0.zw, vec2<f32>(rotation.x, -rotation.y));

  let kUnit = select(vec2<f32>(0.0), k / kLength, kLength > 0.0);
  let ih = complexMulI(h);
  let dx = ih * kUnit.x;
  let dz = ih * kUnit.y;
  let slopeX = ih * k.x;
  let slopeZ = ih * k.y;
  let dxdx = -h * (k.x * kUnit.x);
  let dzdz = -h * (k.y * kUnit.y);
  let dxdz = -h * (k.x * kUnit.y);

  let layer = 2u * cascade;
  textureStore(fieldsOut, id.xy, layer, vec4<f32>(dx + ih, dz + complexMulI(dxdz)));
  textureStore(fieldsOut, id.xy, layer + 1u, vec4<f32>(slopeX + complexMulI(slopeZ), dxdx + complexMulI(dzdz)));
}
