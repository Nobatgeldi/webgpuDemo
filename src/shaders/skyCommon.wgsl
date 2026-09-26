// Sky lookups for scene shaders: radiance from the sky-view LUT, the sun disk
// and the diffuse sky irradiance.
// Requires frame.wgsl, common.wgsl, the atmosphere constants and atmosphereCommon.wgsl.

// Linear limb-darkening coefficient of the solar disk.
const SUN_LIMB_DARKENING: f32 = 0.6;

// Sky radiance along `dir` without the solar disk (sky, fog and reflections).
fn skyRadiance(dir: vec3<f32>) -> vec3<f32> {
  let sunHorizontal = frame.sunDirection.xz;
  let dirHorizontal = dir.xz;
  let sunLength = length(sunHorizontal);
  let dirLength = length(dirHorizontal);
  var cosAzimuth = 1.0;
  if (sunLength > 1e-5 && dirLength > 1e-5) {
    cosAzimuth = dot(dirHorizontal / dirLength, sunHorizontal / sunLength);
  }
  let azimuth = acos(clamp(cosAzimuth, -1.0, 1.0));
  let elevation = asin(clamp(dir.y, -1.0, 1.0));
  return textureSampleLevel(skyViewLut, atmosphereSampler, skyViewUv(elevation, azimuth), 0.0).rgb;
}

// Diffuse irradiance from the whole sky on a horizontal surface.
fn skyIrradiance() -> vec3<f32> {
  return skyLight.irradiance.rgb;
}

// Radiance of the solar disk along `dir` (zero outside the disk), anti-aliased at the rim.
fn sunDiskRadiance(dir: vec3<f32>) -> vec3<f32> {
  let cosAngle = dot(dir, frame.sunDirection.xyz);
  let cosRadius = frame.sunDirection.w;
  let oneMinusCosRadius = max(1.0 - cosRadius, 1e-9);
  // For small angles 1 - cos(a) ~ a^2 / 2, so this is (angle / radius)^2.
  let r2 = saturate((1.0 - cosAngle) / oneMinusCosRadius);
  let mu = sqrt(1.0 - r2);
  let limb = 1.0 - SUN_LIMB_DARKENING * (1.0 - mu);
  let edgeWidth = max(fwidth(cosAngle), 1e-7);
  let coverage = smoothstep(cosRadius - edgeWidth, cosRadius + edgeWidth, cosAngle);
  // The disk sets below the horizon.
  let aboveHorizon = smoothstep(-edgeWidth, edgeWidth, dir.y);
  return frame.sunDiskRadiance.rgb * limb * coverage * aboveHorizon;
}
