// Spray particle record and random helpers, shared by spray.wgsl (simulation)
// and sprayRender.wgsl (sprites).

const TWO_PI_SPRAY: f32 = 6.283185307179586;

struct Particle {
  // xyz: position relative to the particle origin (m), w: age (s)
  position: vec4<f32>,
  // xyz: velocity (m/s), w: lifetime (s); a particle is alive while age < lifetime
  velocity: vec4<f32>,
}

fn pcgHash(value: u32) -> u32 {
  let state = value * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// Uniform random number in [0, 1) from a particle index, a seed and a stream.
fn random01(index: u32, seed: u32, stream: u32) -> f32 {
  return f32(pcgHash(index ^ pcgHash(seed + stream * 0x9e3779b9u))) / 4294967296.0;
}

// Standard normal random vector (Box-Muller).
fn randomNormal3(index: u32, seed: u32, stream: u32) -> vec3<f32> {
  let u1 = max(random01(index, seed, stream), 1e-7);
  let u2 = random01(index, seed, stream + 1u);
  let u3 = max(random01(index, seed, stream + 2u), 1e-7);
  let u4 = random01(index, seed, stream + 3u);
  let r1 = sqrt(-2.0 * log(u1));
  let r2 = sqrt(-2.0 * log(u3));
  return vec3<f32>(r1 * cos(TWO_PI_SPRAY * u2), r1 * sin(TWO_PI_SPRAY * u2), r2 * cos(TWO_PI_SPRAY * u4));
}

// Stable per-particle random in [0, 1) that does not change during its life.
fn particleConstant(index: u32, stream: u32) -> f32 {
  return random01(index, 0x5bd1e995u, stream);
}
