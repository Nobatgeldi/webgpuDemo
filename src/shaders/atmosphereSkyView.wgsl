// Sky-view LUT: in-scattered radiance towards the viewer for every direction,
// by ray marching single scattering (Rayleigh + Mie, sun transmittance from the
// transmittance LUT) plus an isotropic multiple-scattering approximation. With
// cloud cover the result blends into a CIE standard overcast sky.
// Recomputed only when the sun or the cloud cover changes.
// Requires the generated atmosphere constants and atmosphereCommon.wgsl.

const SKY_VIEW_STEPS: i32 = 32;

struct AtmosphereUniforms {
  // x: sin(sun elevation), y: cos(sun elevation), z: cloud cover fraction
  sun: vec4<f32>,
}

@group(0) @binding(0) var<uniform> atmosphere: AtmosphereUniforms;
@group(0) @binding(1) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var lutSampler: sampler;
@group(0) @binding(3) var skyViewOut: texture_storage_2d<rgba16float, write>;

fn sunTransmittance(altitude: f32, mu: f32) -> vec3<f32> {
  return textureSampleLevel(transmittanceLut, lutSampler, transmittanceUv(altitude, mu), 0.0).rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(skyViewOut);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  let params = skyViewParams((vec2<f32>(id.xy) + 0.5) / vec2<f32>(size));
  let elevation = params.x;
  let azimuth = params.y;
  // Sun frame: the sun lies in the x-y plane.
  let sunDir = vec3<f32>(atmosphere.sun.y, atmosphere.sun.x, 0.0);
  let dir = vec3<f32>(cos(elevation) * cos(azimuth), sin(elevation), cos(elevation) * sin(azimuth));

  let r0 = GROUND_RADIUS_M + VIEWER_ALTITUDE_M;
  let mu = dir.y;
  let rayLength = select(distanceToTop(r0, mu), distanceToGround(r0, mu), rayHitsGround(r0, mu));
  let cosTheta = dot(dir, sunDir);
  let phaseR = rayleighPhase(cosTheta);
  let phaseM = miePhase(cosTheta);

  var radiance = vec3<f32>(0.0);
  var throughput = vec3<f32>(1.0);
  var previousT = 0.0;
  for (var i = 0; i < SKY_VIEW_STEPS; i++) {
    // Quadratic step distribution: dense near the viewer where the air is dense.
    let s = (f32(i) + 1.0) / f32(SKY_VIEW_STEPS);
    let t = rayLength * s * s;
    let dt = t - previousT;
    let tMid = previousT + 0.5 * dt;
    previousT = t;

    let position = vec3<f32>(0.0, r0, 0.0) + dir * tMid;
    let radius = length(position);
    let altitude = radius - GROUND_RADIUS_M;
    let up = position / radius;
    let density = atmosphereDensities(altitude);
    let scatterR = RAYLEIGH_SCATTERING * density.x;
    let scatterM = MIE_SCATTERING * density.y;
    let extinction = atmosphereExtinction(altitude);

    let sunT = sunTransmittance(altitude, dot(up, sunDir));
    let single = scatterR * phaseR + vec3<f32>(scatterM * phaseM);
    let multiple = (scatterR + vec3<f32>(scatterM)) * (MULTIPLE_SCATTERING_FACTOR / (4.0 * ATMOSPHERE_PI));
    let source = SUN_IRRADIANCE_TOA * sunT * (single + multiple);

    // Energy-conserving integration of the source over the step (Hillaire 2015).
    let stepTransmittance = exp(-extinction * dt);
    radiance += throughput * (source - source * stepTransmittance) / max(extinction, vec3<f32>(1e-12));
    throughput *= stepTransmittance;
  }

  // CIE standard overcast sky: L(e) = Lz (1 + 2 sin e) / 3, with the zenith
  // luminance set so that the horizontal irradiance (7 pi / 9) Lz equals the
  // transmitted fraction of the direct sunlight.
  let sunBeam = SUN_IRRADIANCE_TOA * sunTransmittance(VIEWER_ALTITUDE_M, atmosphere.sun.x);
  let horizontalIrradiance = sunBeam * max(atmosphere.sun.x, 0.0);
  let zenith = CLOUD_TRANSMITTANCE * horizontalIrradiance * 9.0 / (7.0 * ATMOSPHERE_PI);
  let overcast = zenith * (1.0 + 2.0 * max(dir.y, 0.0)) / 3.0;
  radiance = mix(radiance, overcast, atmosphere.sun.z);

  textureStore(skyViewOut, id.xy, vec4<f32>(radiance, 1.0));
}
