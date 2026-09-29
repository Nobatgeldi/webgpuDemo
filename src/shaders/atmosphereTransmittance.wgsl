// Transmittance LUT: transmittance from a point (altitude, direction) to the
// top of the atmosphere, zero when the ray hits the ground. Computed once.
// Requires the generated atmosphere constants and atmosphereCommon.wgsl.

const TRANSMITTANCE_STEPS: i32 = 40;

@group(0) @binding(0) var transmittanceOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(transmittanceOut);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  let uv = (vec2<f32>(id.xy) + 0.5) / vec2<f32>(size);
  let params = transmittanceParams(uv);
  let r = GROUND_RADIUS_M + params.x;
  let mu = params.y;
  var transmittance = vec3<f32>(0.0);
  if (!rayHitsGround(r, mu)) {
    let dt = distanceToTop(r, mu) / f32(TRANSMITTANCE_STEPS);
    var depth = vec3<f32>(0.0);
    for (var i = 0; i < TRANSMITTANCE_STEPS; i++) {
      let t = (f32(i) + 0.5) * dt;
      let radius = sqrt(r * r + t * t + 2.0 * r * t * mu);
      depth += atmosphereExtinction(radius - GROUND_RADIUS_M) * dt;
    }
    transmittance = exp(-depth);
  }
  textureStore(transmittanceOut, id.xy, vec4<f32>(transmittance, 1.0));
}
