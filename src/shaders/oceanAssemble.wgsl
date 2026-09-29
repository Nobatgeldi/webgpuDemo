// Unpacks the inverse-FFT results into the filterable textures sampled by the
// renderer (and later by the water query):
//   displacement: (lambda Dx, h, lambda Dz, lambda dDx/dz)
//   derivatives:  (dh/dx, dh/dz, lambda dDx/dx, lambda dDz/dz)
// and updates the persistent foam (x: foam amount, y: Jacobian). Foam is
// injected where the surface compresses (Jacobian of the horizontal
// displacement below a threshold calibrated on the CPU to the observed
// whitecap coverage, i.e. the steepest crests) and decays exponentially. The texture lives in the Lagrangian patch
// coordinates, so foam drifts with the waves it was born on.
// Requires oceanCompute.wgsl.

// Only the long-wave cascades break; ripples do not produce whitecaps.
const FOAM_CASCADE_COUNT: u32 = 2u;

@group(0) @binding(1) var fields: texture_2d_array<f32>;
@group(0) @binding(2) var displacementOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var derivativesOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(4) var foamPrevious: texture_2d_array<f32>;
@group(0) @binding(5) var foamOut: texture_storage_2d_array<rgba16float, write>;

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

  let jacobian = (1.0 + lambda * b.z) * (1.0 + lambda * b.w) - lambda * lambda * a.w * a.w;
  let previous = textureLoad(foamPrevious, id.xy, cascade, 0).x;
  let decayed = previous * exp(-ocean.foam.x / ocean.foam.y);
  var injection = 0.0;
  if (cascade < FOAM_CASCADE_COUNT) {
    let threshold = select(ocean.foamCascades.x, ocean.foamCascades.z, cascade == 1u);
    let softness = select(ocean.foamCascades.y, ocean.foamCascades.w, cascade == 1u);
    injection = saturate((threshold - jacobian) / max(softness, 1e-6));
  }
  textureStore(foamOut, id.xy, cascade, vec4<f32>(max(decayed, injection), jacobian, 0.0, 1.0));
}
