// Shared declarations of the ocean compute passes: parameters, wave vectors and
// the wind-sea spectrum. The spectrum constants (JONSWAP sigma, Donelan-Banner
// coefficients, ...) are generated from ocean/spectrumModel.ts and prepended,
// so the GPU evaluates exactly the tested CPU model.

const TAU: f32 = 6.283185307179586;
const INV_SQRT2: f32 = 0.7071067811865476;
const PI_F: f32 = 3.141592653589793;

struct OceanComputeUniforms {
  // x: FFT size N, y: gravity (m/s^2), z: frequency quantum 2 pi / T (rad/s), w: t / T in [0, 1)
  grid: vec4<f32>,
  // x: JONSWAP alpha (0 = calm sea), y: peak angular frequency (rad/s), z: peak enhancement gamma
  jonswap: vec4<f32>,
  // xy: unit vector of wave propagation (downwind), z: choppiness lambda, w: cascade count
  wind: vec4<f32>,
  // per cascade: x: patch size L (m), y: k min, z: k max (rad/m)
  cascades: array<vec4<f32>, 3>,
}

@group(0) @binding(0) var<uniform> ocean: OceanComputeUniforms;

fn fftSize() -> u32 {
  return u32(ocean.grid.x);
}

// Wave vector of a texel. Index n maps to wavenumber index n for n < N/2 and
// n - N above, so the inverse FFT yields the field at x = n L / N directly.
fn waveVector(texel: vec2<u32>, cascade: u32) -> vec2<f32> {
  let n = i32(fftSize());
  let index = vec2<i32>(texel);
  let signedIndex = select(index, index - vec2<i32>(n), index >= vec2<i32>(n / 2));
  return TAU * vec2<f32>(signedIndex) / ocean.cascades[cascade].x;
}

// JONSWAP S(omega) (m^2 s / rad).
fn jonswapSpectrum(omega: f32) -> f32 {
  let alpha = ocean.jonswap.x;
  let peak = ocean.jonswap.y;
  if (alpha <= 0.0 || omega <= 0.0) {
    return 0.0;
  }
  let x = omega / peak;
  let x2 = x * x;
  let exponent = PM_SHAPE_COEFFICIENT / (x2 * x2);
  if (exponent > SPECTRUM_EXPONENT_CUTOFF) {
    return 0.0;
  }
  let sigma = select(JONSWAP_SIGMA_ABOVE_PEAK, JONSWAP_SIGMA_BELOW_PEAK, x <= 1.0);
  let d = (x - 1.0) / sigma;
  let enhancement = pow(ocean.jonswap.z, exp(-0.5 * d * d));
  let g = ocean.grid.y;
  // alpha g^2 omega^-5 written as alpha g^2 omega_p^-5 x^-5 to stay in float range.
  let peak5 = peak * peak * peak * peak * peak;
  return alpha * g * g / peak5 / (x2 * x2 * x) * exp(-exponent) * enhancement;
}

fn donelanBannerBeta(frequencyRatio: f32) -> f32 {
  let r = max(frequencyRatio, DB_LOW_RATIO);
  if (r < DB_PEAK_RATIO) {
    return DB_LOW_COEFFICIENT * pow(r, DB_POWER);
  }
  if (r < DB_HIGH_RATIO) {
    return DB_MID_COEFFICIENT * pow(r, -DB_POWER);
  }
  return pow(10.0, DB_BANNER_OFFSET + DB_BANNER_SCALE * exp(DB_BANNER_DECAY * log(r * r)));
}

// Donelan-Banner spreading times the suppression of waves moving against the wind.
fn directionalSpreading(omega: f32, cosTheta: f32) -> f32 {
  let beta = donelanBannerBeta(omega / ocean.jonswap.y);
  let theta = acos(clamp(cosTheta, -1.0, 1.0));
  let sech = 1.0 / cosh(beta * theta);
  let spreading = beta / (2.0 * tanh(beta * PI_F)) * sech * sech;
  let t = saturate((cosTheta + BACKWARD_TAPER_COS) / (2.0 * BACKWARD_TAPER_COS));
  let taper = t * t * (3.0 - 2.0 * t);
  return spreading * (BACKWARD_ENERGY_FRACTION + (1.0 - BACKWARD_ENERGY_FRACTION) * taper);
}

// Wavenumber spectrum S(k) (m^4): height variance per unit wavenumber area.
fn wavenumberSpectrum(k: vec2<f32>) -> f32 {
  let kLength = length(k);
  if (kLength <= 0.0) {
    return 0.0;
  }
  let g = ocean.grid.y;
  let omega = sqrt(g * kLength);
  let cosTheta = dot(k / kLength, ocean.wind.xy);
  return jonswapSpectrum(omega) * directionalSpreading(omega, cosTheta) * g / (2.0 * omega * kLength);
}

fn complexMul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

// i * c
fn complexMulI(c: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(-c.y, c.x);
}
