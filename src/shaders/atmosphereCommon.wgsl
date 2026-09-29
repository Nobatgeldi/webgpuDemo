// Atmosphere model shared by the LUT compute passes and the scene shaders.
// The physical constants are generated from sky/atmosphereModel.ts and prepended.

const ATMOSPHERE_PI: f32 = 3.141592653589793;
const ATMOSPHERE_HEIGHT_M: f32 = TOP_RADIUS_M - GROUND_RADIUS_M;

// x: Rayleigh, y: Mie, z: ozone relative density.
fn atmosphereDensities(altitude: f32) -> vec3<f32> {
  let h = max(altitude, 0.0);
  return vec3<f32>(
    exp(-h / RAYLEIGH_SCALE_HEIGHT_M),
    exp(-h / MIE_SCALE_HEIGHT_M),
    max(0.0, 1.0 - abs(h - OZONE_CENTRE_ALTITUDE_M) / OZONE_HALF_WIDTH_M),
  );
}

fn atmosphereExtinction(altitude: f32) -> vec3<f32> {
  let d = atmosphereDensities(altitude);
  return RAYLEIGH_SCATTERING * d.x + vec3<f32>(MIE_EXTINCTION * d.y) + OZONE_ABSORPTION * d.z;
}

fn rayleighPhase(cosTheta: f32) -> f32 {
  return 3.0 / (16.0 * ATMOSPHERE_PI) * (1.0 + cosTheta * cosTheta);
}

// Cornette-Shanks phase function.
fn miePhase(cosTheta: f32) -> f32 {
  let g = MIE_ASYMMETRY;
  let g2 = g * g;
  let denom = max(1.0 + g2 - 2.0 * g * cosTheta, 1e-5);
  return 3.0 * (1.0 - g2) * (1.0 + cosTheta * cosTheta) / (8.0 * ATMOSPHERE_PI * (2.0 + g2) * denom * sqrt(denom));
}

// Discriminant of the ray/sphere intersection, written as (R - r)(R + r) + r^2 mu^2
// to avoid cancellation between two ~4e13 m^2 terms in float32.
fn sphereDiscriminant(r: f32, mu: f32, radius: f32) -> f32 {
  return (radius - r) * (radius + r) + r * r * mu * mu;
}

fn rayHitsGround(r: f32, mu: f32) -> bool {
  return mu < 0.0 && sphereDiscriminant(r, mu, GROUND_RADIUS_M) >= 0.0;
}

fn distanceToTop(r: f32, mu: f32) -> f32 {
  return max(0.0, -r * mu + sqrt(max(sphereDiscriminant(r, mu, TOP_RADIUS_M), 0.0)));
}

fn distanceToGround(r: f32, mu: f32) -> f32 {
  return max(0.0, -r * mu - sqrt(max(sphereDiscriminant(r, mu, GROUND_RADIUS_M), 0.0)));
}

// Transmittance LUT parameterisation: u from cos(zenith) (denser near the
// horizon), v = sqrt(altitude / atmosphere height).
fn transmittanceUv(altitude: f32, mu: f32) -> vec2<f32> {
  let u = 0.5 + 0.5 * sign(mu) * sqrt(abs(mu));
  let v = sqrt(clamp(altitude / ATMOSPHERE_HEIGHT_M, 0.0, 1.0));
  return vec2<f32>(u, v);
}

// Returns (altitude, mu) for a transmittance LUT coordinate.
fn transmittanceParams(uv: vec2<f32>) -> vec2<f32> {
  let x = 2.0 * uv.x - 1.0;
  return vec2<f32>(uv.y * uv.y * ATMOSPHERE_HEIGHT_M, sign(x) * x * x);
}

// Sky-view LUT parameterisation in the sun's frame: u = azimuth from the sun in
// [0, pi] (the sky is symmetric), v = elevation, compressed towards the horizon.
fn skyViewUv(elevation: f32, azimuth: f32) -> vec2<f32> {
  let e = elevation / (0.5 * ATMOSPHERE_PI);
  return vec2<f32>(azimuth / ATMOSPHERE_PI, 0.5 + 0.5 * sign(e) * sqrt(abs(e)));
}

// Returns (elevation, azimuth) for a sky-view LUT coordinate.
fn skyViewParams(uv: vec2<f32>) -> vec2<f32> {
  let x = 2.0 * uv.y - 1.0;
  return vec2<f32>(sign(x) * x * x * 0.5 * ATMOSPHERE_PI, uv.x * ATMOSPHERE_PI);
}
