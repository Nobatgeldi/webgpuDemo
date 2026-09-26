// Sky irradiance on a horizontal surface, integrated from the sky-view LUT
// (used for diffuse sky lighting and auto exposure).
// Requires the generated atmosphere constants and atmosphereCommon.wgsl.

const IRRADIANCE_THREADS: u32 = 64u;
const AZIMUTH_SAMPLES: u32 = 64u;
const ELEVATION_SAMPLES: u32 = 32u;

struct SkyLight {
  // rgb: sky irradiance on a horizontal surface
  irradiance: vec4<f32>,
}

@group(0) @binding(0) var skyViewLut: texture_2d<f32>;
@group(0) @binding(1) var lutSampler: sampler;
@group(0) @binding(2) var<storage, read_write> skyLightOut: SkyLight;

var<workgroup> partial: array<vec3<f32>, IRRADIANCE_THREADS>;

@compute @workgroup_size(IRRADIANCE_THREADS)
fn main(@builtin(local_invocation_index) thread: u32) {
  let dAzimuth = ATMOSPHERE_PI / f32(AZIMUTH_SAMPLES);
  let dElevation = 0.5 * ATMOSPHERE_PI / f32(ELEVATION_SAMPLES);
  var sum = vec3<f32>(0.0);
  for (var i = thread; i < AZIMUTH_SAMPLES * ELEVATION_SAMPLES; i += IRRADIANCE_THREADS) {
    let azimuth = (f32(i % AZIMUTH_SAMPLES) + 0.5) * dAzimuth;
    let elevation = (f32(i / AZIMUTH_SAMPLES) + 0.5) * dElevation;
    let radiance = textureSampleLevel(skyViewLut, lutSampler, skyViewUv(elevation, azimuth), 0.0).rgb;
    // dE = L cos(zenith) d(omega), d(omega) = cos(elevation) d(elevation) d(azimuth).
    sum += radiance * sin(elevation) * cos(elevation);
  }
  partial[thread] = sum;
  workgroupBarrier();
  for (var stride = IRRADIANCE_THREADS / 2u; stride > 0u; stride /= 2u) {
    if (thread < stride) {
      partial[thread] += partial[thread + stride];
    }
    workgroupBarrier();
  }
  if (thread == 0u) {
    // Azimuths cover [0, pi]; the other half of the sky is the mirror image.
    skyLightOut.irradiance = vec4<f32>(2.0 * partial[0] * dAzimuth * dElevation, 1.0);
  }
}
