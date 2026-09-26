// Phase-0 analytic sky gradient (replaced by the physical atmosphere in phase 2).
// Requires frame.wgsl and common.wgsl.

// Shapes the zenith/horizon blend: < 1 keeps the horizon band narrow and bright.
const SKY_GRADIENT_EXPONENT: f32 = 0.45;
// Angular width (as sin(elevation)) of the soft transition below the horizon.
const HORIZON_BLEND_WIDTH: f32 = 0.02;
// Linear limb-darkening coefficient of the solar disk.
const SUN_LIMB_DARKENING: f32 = 0.6;

// Sky radiance without the solar disk; used for the sky itself, fog and reflections.
fn skyRadiance(dir: vec3<f32>) -> vec3<f32> {
  let up = dir.y;
  let t = pow(saturate(up), SKY_GRADIENT_EXPONENT);
  var color = mix(frame.skyHorizon.rgb, frame.skyZenith.rgb, t);
  let cosSun = dot(dir, frame.sunDirection.xyz);
  color += frame.sunHalo.rgb * henyeyGreenstein(cosSun, frame.sunHalo.w);
  let below = smoothstep(0.0, -HORIZON_BLEND_WIDTH, up);
  return mix(color, frame.skyBelowHorizon.rgb, below);
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
